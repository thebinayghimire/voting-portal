/**
 * Elite Grand School Voting Portal - hardened server
 *
 * Key properties:
 *   1. Voting is allowed only inside the configured election window.
 *   2. Student grade comes from the server-side student roster, not the browser.
 *   3. Ballot rows do not share a per-voter timestamp with the voter ledger.
 *   4. Admin APIs can be IP allowlisted and results can require a second code.
 *   5. Runtime data can live outside the repository through DATA_DIR.
 */

require('dotenv').config();

const express = require('express');
const session = require('express-session');
const bcrypt = require('bcrypt');
const crypto = require('crypto');
const path = require('path');
const fs = require('fs');
const Database = require('better-sqlite3');
const { rateLimit, ipKeyGenerator } = require('express-rate-limit');
const helmet = require('helmet');

const app = express();

const VALID_GRADES = [
  'Grade 9A',
  'Grade 9B',
  'Grade 10A',
  'Grade 10B',
  'Teacher',
  'All Grades',
];

const VALID_HOUSES = ['Blue', 'Green', 'Red', 'Yellow'];

const HOUSE_CATEGORIES = {
  Blue:   ['Blue House Captain',   'Blue House Vice Captain'],
  Green:  ['Green House Captain',  'Green House Vice Captain'],
  Red:    ['Red House Captain',    'Red House Vice Captain'],
  Yellow: ['Yellow House Captain', 'Yellow House Vice Captain'],
};

const ALL_HOUSE_CATS = new Set(Object.values(HOUSE_CATEGORIES).flat());

function getCandidatesForHouse(candidates, house) {
  if (!house) return candidates.filter((c) => !ALL_HOUSE_CATS.has(c.category));
  const allowed = new Set(HOUSE_CATEGORIES[house] || []);
  return candidates.filter((c) => !ALL_HOUSE_CATS.has(c.category) || allowed.has(c.category));
}

function getRequiredCategoriesForHouse(allCategories, house) {
  const result = new Set();
  for (const cat of allCategories) {
    if (ALL_HOUSE_CATS.has(cat)) {
      if (house && (HOUSE_CATEGORIES[house] || []).includes(cat)) result.add(cat);
    } else {
      result.add(cat);
    }
  }
  return result;
}

/* -------------------------------------------------------------------------- */
/* Configuration                                                              */
/* -------------------------------------------------------------------------- */

const PORT = process.env.PORT || 3000;
const NODE_ENV = process.env.NODE_ENV || 'development';
const IS_PROD = NODE_ENV === 'production';
const SESSION_SECRET = process.env.SESSION_SECRET;
const ADMIN_USERNAME = process.env.ADMIN_USERNAME;
const ADMIN_PWHASH = process.env.ADMIN_PASSWORD_HASH;
const ELECTION_OPEN = process.env.ELECTION_OPEN_AT;
const ELECTION_CLOSE = process.env.ELECTION_CLOSE_AT;
const RESULTS_AFTER = process.env.RESULTS_VISIBLE_AFTER || ELECTION_CLOSE;
const RESULTS_ACCESS_CODE_HASH = process.env.RESULTS_ACCESS_CODE_HASH || '';
const ADMIN_ALLOWED_IPS = parseCsvEnv(process.env.ADMIN_ALLOWED_IPS);
const DATA_DIR = path.resolve(process.env.DATA_DIR || __dirname);
const STUDENTS_FILE = path.resolve(process.env.STUDENTS_FILE || path.join(__dirname, 'students.json'));
const CANDIDATES_FILE = path.resolve(process.env.CANDIDATES_FILE || path.join(__dirname, 'candidates.json'));

const requiredEnv = { SESSION_SECRET, ADMIN_USERNAME, ADMIN_PWHASH, ELECTION_OPEN, ELECTION_CLOSE };
for (const [name, val] of Object.entries(requiredEnv)) {
  if (!val) fatal(`${name} not set in .env`);
}

if (SESSION_SECRET.length < 32 || /replace_me/i.test(SESSION_SECRET)) {
  fatal('SESSION_SECRET must be a long random value, not the example placeholder');
}
if (!isBcryptHash(ADMIN_PWHASH)) {
  fatal('ADMIN_PASSWORD_HASH must be a bcrypt hash');
}
if (RESULTS_ACCESS_CODE_HASH && !isBcryptHash(RESULTS_ACCESS_CODE_HASH)) {
  fatal('RESULTS_ACCESS_CODE_HASH must be a bcrypt hash when set');
}

const electionOpenMs = Date.parse(ELECTION_OPEN);
const electionCloseMs = Date.parse(ELECTION_CLOSE);
const resultsAfterMs = Date.parse(RESULTS_AFTER);
if (Number.isNaN(electionOpenMs) || Number.isNaN(electionCloseMs)) {
  fatal('ELECTION_OPEN_AT / ELECTION_CLOSE_AT could not be parsed as dates');
}
if (Number.isNaN(resultsAfterMs)) {
  fatal('RESULTS_VISIBLE_AFTER could not be parsed as a date');
}
if (electionCloseMs <= electionOpenMs) {
  fatal('ELECTION_CLOSE_AT must be after ELECTION_OPEN_AT');
}
if (!Number.isInteger(Number(PORT)) || Number(PORT) <= 0) {
  fatal('PORT must be a positive integer');
}

function fatal(message) {
  console.error(`FATAL: ${message}`);
  process.exit(1);
}

function parseCsvEnv(value) {
  return (value || '')
    .split(',')
    .map((v) => v.trim())
    .filter(Boolean);
}

function isBcryptHash(value) {
  return typeof value === 'string' && /^\$2[aby]\$\d{2}\$[./A-Za-z0-9]{53}$/.test(value);
}

/* -------------------------------------------------------------------------- */
/* Database and sessions                                                       */
/* -------------------------------------------------------------------------- */

const DB_PATH = path.join(DATA_DIR, 'votes.db');
const SESSIONS_DIR = path.join(DATA_DIR, 'sessions');
const BACKUPS_DIR = path.join(DATA_DIR, 'backups');
fs.mkdirSync(DATA_DIR, { recursive: true });
fs.mkdirSync(SESSIONS_DIR, { recursive: true });
fs.mkdirSync(BACKUPS_DIR, { recursive: true });

class BetterSqliteSessionStore extends session.Store {
  constructor(filePath) {
    super();
    this.db = new Database(filePath);
    this.db.pragma('journal_mode = WAL');
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS egs_sessions_v2 (
        sid TEXT PRIMARY KEY,
        expires INTEGER NOT NULL,
        sess TEXT NOT NULL
      );
      CREATE INDEX IF NOT EXISTS idx_egs_sessions_v2_expires ON egs_sessions_v2(expires);
    `);
    this.getStmt = this.db.prepare('SELECT sess, expires FROM egs_sessions_v2 WHERE sid = ?');
    this.setStmt = this.db.prepare(
      'INSERT INTO egs_sessions_v2 (sid, expires, sess) VALUES (?, ?, ?) ' +
      'ON CONFLICT(sid) DO UPDATE SET expires = excluded.expires, sess = excluded.sess'
    );
    this.touchStmt = this.db.prepare('UPDATE egs_sessions_v2 SET expires = ? WHERE sid = ?');
    this.destroyStmt = this.db.prepare('DELETE FROM egs_sessions_v2 WHERE sid = ?');
    this.cleanupStmt = this.db.prepare('DELETE FROM egs_sessions_v2 WHERE expires <= ?');
  }

  get(sid, cb) {
    try {
      const row = this.getStmt.get(sid);
      if (!row) return cb(null, null);
      if (row.expires <= Date.now()) {
        this.destroyStmt.run(sid);
        return cb(null, null);
      }
      cb(null, JSON.parse(row.sess));
    } catch (err) {
      cb(err);
    }
  }

  set(sid, sess, cb = () => {}) {
    try {
      this.setStmt.run(sid, getSessionExpiry(sess), JSON.stringify(sess));
      cb(null);
    } catch (err) {
      cb(err);
    }
  }

  touch(sid, sess, cb = () => {}) {
    try {
      this.touchStmt.run(getSessionExpiry(sess), sid);
      cb(null);
    } catch (err) {
      cb(err);
    }
  }

  destroy(sid, cb = () => {}) {
    try {
      this.destroyStmt.run(sid);
      cb(null);
    } catch (err) {
      cb(err);
    }
  }

  cleanup() {
    this.cleanupStmt.run(Date.now());
  }

  close() {
    this.db.close();
  }
}

function getSessionExpiry(sess) {
  if (sess?.cookie?.expires) return new Date(sess.cookie.expires).getTime();
  if (sess?.cookie?.maxAge) return Date.now() + sess.cookie.maxAge;
  return Date.now() + 30 * 60 * 1000;
}

const sessionStore = new BetterSqliteSessionStore(path.join(SESSIONS_DIR, 'sessions.db'));
setInterval(() => sessionStore.cleanup(), 30 * 60 * 1000);

const db = new Database(DB_PATH);
db.pragma('journal_mode = WAL');
db.pragma('foreign_keys = ON');

db.exec(`
  CREATE TABLE IF NOT EXISTS voters (
    student_id TEXT PRIMARY KEY,
    grade      TEXT NOT NULL,
    timestamp  TEXT NOT NULL
  );

  CREATE TABLE IF NOT EXISTS votes (
    id           INTEGER PRIMARY KEY AUTOINCREMENT,
    candidate_id TEXT NOT NULL,
    category     TEXT NOT NULL,
    grade        TEXT NOT NULL,
    timestamp    TEXT NOT NULL
  );

  CREATE TABLE IF NOT EXISTS audit_log (
    id         INTEGER PRIMARY KEY AUTOINCREMENT,
    timestamp  TEXT NOT NULL,
    event_type TEXT NOT NULL,
    actor      TEXT,
    ip         TEXT,
    details    TEXT
  );

  CREATE INDEX IF NOT EXISTS idx_votes_candidate ON votes(candidate_id);
  CREATE INDEX IF NOT EXISTS idx_votes_grade     ON votes(grade);
  CREATE INDEX IF NOT EXISTS idx_audit_time      ON audit_log(timestamp);
  CREATE INDEX IF NOT EXISTS idx_audit_actor     ON audit_log(actor);
`);

const auditStmt = db.prepare(
  'INSERT INTO audit_log (timestamp, event_type, actor, ip, details) VALUES (?, ?, ?, ?, ?)'
);

function audit(eventType, actor, ip, details) {
  try {
    auditStmt.run(
      new Date().toISOString(),
      actorSafe(eventType),
      actor || null,
      ip || null,
      details ? JSON.stringify(details) : null
    );
  } catch (e) {
    console.error('AUDIT WRITE FAILED:', eventType, e.message);
  }
}

function actorSafe(value) {
  return String(value).slice(0, 80);
}

/* -------------------------------------------------------------------------- */
/* Middleware                                                                  */
/* -------------------------------------------------------------------------- */

app.set('trust proxy', 1);

app.use((req, res, next) => {
  if (!IS_PROD) return next();
  if (req.secure || req.headers['x-forwarded-proto'] === 'https') return next();
  return res.redirect(301, `https://${req.headers.host}${req.url}`);
});

app.use(helmet({
  contentSecurityPolicy: {
    directives: {
      defaultSrc: ["'self'"],
      scriptSrc: ["'self'"],
      styleSrc: ["'self'", 'https://fonts.googleapis.com'],
      fontSrc: ["'self'", 'https://fonts.gstatic.com'],
      imgSrc: ["'self'", 'data:'],
      connectSrc: ["'self'"],
      frameAncestors: ["'none'"],
      objectSrc: ["'none'"],
      baseUri: ["'self'"],
      formAction: ["'self'"],
    },
  },
  crossOriginEmbedderPolicy: false,
  hsts: IS_PROD ? { maxAge: 31536000, includeSubDomains: true } : false,
}));

app.use(express.json({ limit: '10kb' }));

app.use(session({
  store: sessionStore,
  secret: SESSION_SECRET,
  resave: false,
  saveUninitialized: false,
  rolling: true,
  cookie: {
    httpOnly: true,
    secure: IS_PROD,
    sameSite: 'lax',
    maxAge: 30 * 60 * 1000,
  },
  name: 'egs.sid',
}));

/* -------------------------------------------------------------------------- */
/* Rate limiters                                                               */
/* -------------------------------------------------------------------------- */

const studentLoginLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 8,
  standardHeaders: true,
  legacyHeaders: false,
  keyGenerator: (req) => `${ipKeyGenerator(req)}|${(req.body && req.body.student_id) || 'anon'}`,
  message: { message: 'Too many login attempts. Wait 15 minutes.' },
  handler: (req, res, next, options) => {
    audit('rate_limit_hit', req.body?.student_id, req.ip, { endpoint: '/login' });
    res.status(options.statusCode).json(options.message);
  },
});

const adminLoginLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 5,
  standardHeaders: true,
  legacyHeaders: false,
  message: { message: 'Too many admin login attempts. Wait 15 minutes.' },
  handler: (req, res, next, options) => {
    audit('rate_limit_hit', 'admin', req.ip, { endpoint: '/admin/login' });
    res.status(options.statusCode).json(options.message);
  },
});

const voteLimiter = rateLimit({
  windowMs: 5 * 60 * 1000,
  max: 5,
  standardHeaders: true,
  legacyHeaders: false,
  keyGenerator: (req) => req.sessionID || ipKeyGenerator(req),
  message: { message: 'Too many vote attempts. Please refresh and try again.' },
});

/* -------------------------------------------------------------------------- */
/* Election helpers                                                            */
/* -------------------------------------------------------------------------- */

function electionStatus() {
  const now = Date.now();
  if (now < electionOpenMs) return 'pre_open';
  if (now >= electionCloseMs) return 'closed';
  return 'open';
}

function requireElectionOpen(req, res, next) {
  const s = electionStatus();
  if (s === 'pre_open') {
    return res.status(403).json({ message: 'Voting has not started yet.', opens_at: ELECTION_OPEN });
  }
  if (s === 'closed') {
    return res.status(403).json({ message: 'Voting has ended.', closed_at: ELECTION_CLOSE });
  }
  next();
}

function ballotTimestamp() {
  return `anonymous-ballot-pool:${ELECTION_OPEN}`;
}

/* -------------------------------------------------------------------------- */
/* Static files and data                                                       */
/* -------------------------------------------------------------------------- */

app.use(express.static(path.join(__dirname, 'public'), {
  dotfiles: 'deny',
  index: 'index.html',
}));

let _studentsCache = null;
let _candidatesCache = null;
let _categoriesCache = null;

function loadStudents() {
  if (!_studentsCache) {
    const parsed = readJsonFile(STUDENTS_FILE);
    _studentsCache = validateStudents(parsed.students || []);
  }
  return _studentsCache;
}

function loadCandidates() {
  if (!_candidatesCache) {
    const parsed = readJsonFile(CANDIDATES_FILE);
    _candidatesCache = validateCandidates(parsed.candidates || []);
    _categoriesCache = new Set(_candidatesCache.map((c) => c.category));
  }
  return _candidatesCache;
}

function loadCategories() {
  loadCandidates();
  return _categoriesCache;
}

function readJsonFile(filePath) {
  return JSON.parse(fs.readFileSync(filePath, 'utf8').replace(/^\uFEFF/, ''));
}

function validateStudents(students) {
  if (!Array.isArray(students) || !students.length) fatal('students.json must contain a non-empty students array');
  const seen = new Set();
  for (const s of students) {
    if (!s.student_id || typeof s.student_id !== 'string') fatal('Every student must have a student_id');
    if (seen.has(s.student_id)) fatal(`Duplicate student_id: ${s.student_id}`);
    seen.add(s.student_id);
    if (!isBcryptHash(s.password)) fatal(`Student ${s.student_id} has an invalid bcrypt password hash`);
    if (!VALID_GRADES.includes(s.grade)) fatal(`Student ${s.student_id} must have a valid grade`);
    if (s.house != null && !VALID_HOUSES.includes(s.house)) fatal(`Student ${s.student_id} has invalid house: ${s.house}`);
  }
  return students;
}

function validateCandidates(candidates) {
  if (!Array.isArray(candidates) || !candidates.length) fatal('candidates.json must contain a non-empty candidates array');
  const seen = new Set();
  for (const c of candidates) {
    if (!c.candidate_id || typeof c.candidate_id !== 'string') fatal('Every candidate must have a candidate_id');
    if (!/^[A-Za-z0-9_-]+$/.test(c.candidate_id)) fatal(`Unsafe candidate_id: ${c.candidate_id}`);
    if (seen.has(c.candidate_id)) fatal(`Duplicate candidate_id: ${c.candidate_id}`);
    seen.add(c.candidate_id);
    if (!c.name || typeof c.name !== 'string') fatal(`Candidate ${c.candidate_id} must have a name`);
    if (!c.category || typeof c.category !== 'string' || !c.category.trim()) fatal(`Candidate ${c.candidate_id} must have a non-empty category`);
    if (!VALID_GRADES.includes(c.grade)) fatal(`Candidate ${c.candidate_id} has invalid grade`);
  }
  return candidates;
}

/* -------------------------------------------------------------------------- */
/* Auth helpers                                                                */
/* -------------------------------------------------------------------------- */

let DUMMY_HASH;

function requireStudent(req, res, next) {
  if (!req.session?.student_id || req.session.role !== 'student') {
    return res.status(401).json({ message: 'Not logged in.' });
  }
  next();
}

function requireAdminIp(req, res, next) {
  if (!ADMIN_ALLOWED_IPS.length) return next();
  const ip = normalizeIp(req.ip);
  const allowed = ADMIN_ALLOWED_IPS.map(normalizeIp);
  if (allowed.includes(ip)) return next();
  audit('admin_ip_blocked', 'admin', req.ip, { path: req.path });
  return res.status(403).json({ message: 'Admin access is not allowed from this IP.' });
}

function requireAdmin(req, res, next) {
  if (req.session?.role !== 'admin') {
    return res.status(401).json({ message: 'Admin access required.' });
  }
  next();
}

function normalizeIp(ip) {
  if (!ip) return '';
  if (ip === '::1') return '127.0.0.1';
  if (ip.startsWith('::ffff:')) return ip.slice(7);
  return ip;
}

async function requireResultsCode(req, res, next) {
  if (!RESULTS_ACCESS_CODE_HASH) return next();
  const code = req.get('x-results-code') || '';
  const ok = code ? await bcrypt.compare(code, RESULTS_ACCESS_CODE_HASH) : false;
  if (ok) return next();
  audit('admin_results_code_fail', 'admin', req.ip, { missing: !code });
  return res.status(403).json({
    message: 'Second-person results code required.',
    requires_results_code: true,
  });
}

/* -------------------------------------------------------------------------- */
/* Public routes                                                               */
/* -------------------------------------------------------------------------- */

app.get('/election/status', (req, res) => {
  res.json({
    status: electionStatus(),
    opens_at: ELECTION_OPEN,
    closes_at: ELECTION_CLOSE,
    results_visible_after: RESULTS_AFTER,
    now: new Date().toISOString(),
  });
});

/* -------------------------------------------------------------------------- */
/* Student routes                                                              */
/* -------------------------------------------------------------------------- */

app.post('/login', studentLoginLimiter, async (req, res) => {
  const { student_id, password } = req.body || {};
  const ip = req.ip;

  if (!student_id || !password) {
    return res.status(400).json({ message: 'Please provide Student ID and password.' });
  }

  const status = electionStatus();
  if (status === 'pre_open') {
    audit('login_outside_window', student_id, ip, { reason: 'pre_open' });
    return res.status(403).json({ message: 'Voting has not started yet.', opens_at: ELECTION_OPEN });
  }
  if (status === 'closed') {
    audit('login_outside_window', student_id, ip, { reason: 'closed' });
    return res.status(403).json({ message: 'Voting has ended.', closed_at: ELECTION_CLOSE });
  }

  const students = loadStudents();
  const user = students.find((s) => s.student_id === student_id);
  const match = user
    ? await bcrypt.compare(password, user.password)
    : await bcrypt.compare(password, DUMMY_HASH);

  if (!user || !match) {
    audit('login_fail', student_id, ip, { reason: user ? 'bad_password' : 'unknown_user' });
    return res.status(401).json({ message: 'Invalid Student ID or password.' });
  }

  const alreadyVoted = db.prepare('SELECT 1 FROM voters WHERE student_id = ?').get(student_id);
  if (alreadyVoted) {
    audit('login_already_voted', student_id, ip);
    return res.status(403).json({ message: 'You have already voted. Votes cannot be changed.' });
  }

  req.session.regenerate((err) => {
    if (err) {
      console.error('session regen failed:', err);
      return res.status(500).json({ message: 'Internal error.' });
    }
    req.session.student_id = student_id;
    req.session.student_grade = user.grade;
    req.session.student_house = user.house || null;
    req.session.role = 'student';
    audit('login_success', student_id, ip, { grade: user.grade, house: user.house || null });
    res.json({ message: 'Login successful.', grade: user.grade, house: user.house || null });
  });
});

app.get('/candidates', requireStudent, (req, res) => {
  const grade = req.session.student_grade;
  const house = req.session.student_house;
  const candidates = loadCandidates();
  res.json({ grade, house, candidates: getCandidatesForHouse(candidates, house) });
});

app.post('/vote', requireStudent, requireElectionOpen, voteLimiter, (req, res) => {
  const { votes } = req.body || {};
  const studentId = req.session.student_id;
  const grade = req.session.student_grade;
  const house = req.session.student_house;
  const ip = req.ip;

  if (!votes || typeof votes !== 'object' || Array.isArray(votes)) {
    return res.status(400).json({ message: 'Invalid vote format.' });
  }

  const candidates = loadCandidates();
  const requiredCategories = getRequiredCategoriesForHouse(loadCategories(), house);
  const allowedCandidates = getCandidatesForHouse(candidates, house);
  const candidateMap = new Map(allowedCandidates.map((c) => [c.candidate_id, c]));

  for (const cat of requiredCategories) {
    if (!votes[cat]) {
      return res.status(400).json({ message: `Please select a candidate for: ${cat}` });
    }
  }
  for (const cat of Object.keys(votes)) {
    if (!requiredCategories.has(cat)) {
      return res.status(400).json({ message: 'Invalid position in votes.' });
    }
  }
  for (const [cat, candidateId] of Object.entries(votes)) {
    if (typeof candidateId !== 'string') {
      return res.status(400).json({ message: 'Invalid candidate selection.' });
    }
    const candidate = candidateMap.get(candidateId);
    if (!candidate || candidate.category !== cat) {
      audit('vote_invalid_selection', studentId, ip, { category: cat, attempted_id: candidateId, house });
      return res.status(400).json({ message: 'Invalid candidate selection.' });
    }
  }

  const recordVote = db.transaction(() => {
    const voterRecordedAt = new Date().toISOString();
    const anonymousBallotTime = ballotTimestamp();
    db.prepare('INSERT INTO voters (student_id, grade, timestamp) VALUES (?, ?, ?)')
      .run(studentId, grade, voterRecordedAt);
    const insertVote = db.prepare(
      'INSERT INTO votes (candidate_id, category, grade, timestamp) VALUES (?, ?, ?, ?)'
    );
    for (const [cat, candidateId] of Object.entries(votes)) {
      insertVote.run(candidateId, cat, grade, anonymousBallotTime);
    }
  });

  try {
    recordVote();
  } catch (err) {
    if (err.code === 'SQLITE_CONSTRAINT_PRIMARYKEY' || err.code === 'SQLITE_CONSTRAINT_UNIQUE') {
      audit('vote_double_attempt', studentId, ip);
      return res.status(400).json({ message: 'You have already voted.' });
    }
    console.error('Vote insert failed:', err);
    audit('vote_error', studentId, ip, { error: err.message });
    return res.status(500).json({ message: 'Could not record vote. Please try again.' });
  }

  audit('vote_cast', studentId, ip, { grade, house });
  runBackup('vote_cast');

  req.session.destroy((err) => {
    if (err) console.error('session destroy failed:', err);
    res.clearCookie('egs.sid');
    res.json({ message: 'Vote recorded successfully. Thank you!' });
  });
});

app.post('/logout', (req, res) => {
  const sid = req.session?.student_id;
  req.session.destroy(() => {
    res.clearCookie('egs.sid');
    if (sid) audit('logout', sid, req.ip);
    res.json({ message: 'Logged out.' });
  });
});

/* -------------------------------------------------------------------------- */
/* Admin routes                                                                */
/* -------------------------------------------------------------------------- */

app.use('/admin', requireAdminIp);

app.post('/admin/login', adminLoginLimiter, async (req, res) => {
  const { username, password } = req.body || {};
  const ip = req.ip;

  const validUser = username === ADMIN_USERNAME;
  const validPass = validUser
    ? await bcrypt.compare(password || '', ADMIN_PWHASH)
    : await bcrypt.compare(password || '', DUMMY_HASH);

  if (!validUser || !validPass) {
    audit('admin_login_fail', username || null, ip);
    return res.status(401).json({ message: 'Invalid admin credentials.' });
  }

  req.session.regenerate((err) => {
    if (err) return res.status(500).json({ message: 'Internal error.' });
    req.session.role = 'admin';
    audit('admin_login_success', ADMIN_USERNAME, ip);
    res.json({
      message: 'Admin login successful.',
      results_code_required: Boolean(RESULTS_ACCESS_CODE_HASH),
      admin_ip_allowlist_enabled: Boolean(ADMIN_ALLOWED_IPS.length),
    });
  });
});

app.get('/admin/results', requireAdmin, requireResultsCode, (req, res) => {
  if (Date.now() < resultsAfterMs) {
    audit('admin_results_blocked', 'admin', req.ip, { now: new Date().toISOString() });
    return res.status(403).json({
      message: 'Results are not yet available. Wait until election close.',
      available_after: RESULTS_AFTER,
    });
  }

  const candidates = loadCandidates();
  const students = loadStudents();

  const countStmt = db.prepare('SELECT COUNT(*) AS cnt FROM votes WHERE candidate_id = ?');
  const results = candidates.map((c) => ({
    candidate_id: c.candidate_id,
    name: c.name,
    category: c.category,
    grade: c.grade,
    votes: countStmt.get(c.candidate_id).cnt,
  }));

  const gradeStats = db.prepare(
    'SELECT grade, COUNT(*) AS voted FROM voters GROUP BY grade'
  ).all();

  const votedRows = db.prepare('SELECT student_id FROM voters').all();
  const votedSet = new Set(votedRows.map((r) => r.student_id));
  const ballotCount = db.prepare('SELECT COUNT(*) AS cnt FROM votes').get().cnt;

  const studentStatus = students.map((s) => ({
    student_id: s.student_id,
    grade: s.grade,
    has_voted: votedSet.has(s.student_id),
  }));

  audit('admin_results_view', 'admin', req.ip);

  res.json({
    totalVoters: votedSet.size,
    totalVotes: votedSet.size,
    ballotsCast: ballotCount,
    expectedBallots: votedSet.size * loadCategories().size,
    numPositions: loadCategories().size,
    totalStudents: students.length,
    results,
    gradeStats,
    students: studentStatus,
    election: { opens_at: ELECTION_OPEN, closes_at: ELECTION_CLOSE, status: electionStatus() },
  });
});

app.get('/admin/turnout', requireAdmin, (req, res) => {
  const total = db.prepare('SELECT COUNT(*) AS cnt FROM voters').get().cnt;
  const byGrade = db.prepare('SELECT grade, COUNT(*) AS voted FROM voters GROUP BY grade').all();
  res.json({
    total_voted: total,
    total_students: loadStudents().length,
    by_grade: byGrade,
    election: { status: electionStatus(), opens_at: ELECTION_OPEN, closes_at: ELECTION_CLOSE },
  });
});

app.get('/admin/audit', requireAdmin, (req, res) => {
  const requested = parseInt(req.query.limit, 10);
  const limit = Math.min(Number.isFinite(requested) ? requested : 200, 1000);
  const events = db.prepare(
    'SELECT id, timestamp, event_type, actor, ip, details FROM audit_log ORDER BY id DESC LIMIT ?'
  ).all(limit);
  res.json({ events });
});

app.post('/admin/logout', (req, res) => {
  req.session.destroy(() => {
    res.clearCookie('egs.sid');
    audit('admin_logout', 'admin', req.ip);
    res.json({ message: 'Logged out.' });
  });
});

/* -------------------------------------------------------------------------- */
/* Backups                                                                     */
/* -------------------------------------------------------------------------- */

const BACKUP_INTERVAL_MS = 5 * 60 * 1000;
const BACKUP_RETAIN = parseInt(process.env.BACKUP_RETAIN, 10) || 100;
const B2_CONFIG = {
  keyId: process.env.B2_KEY_ID || '',
  applicationKey: process.env.B2_APPLICATION_KEY || '',
  bucketId: process.env.B2_BUCKET_ID || '',
  prefix: process.env.B2_PREFIX || 'voting-portal-backups',
};

function cloudBackupEnabled() {
  return Boolean(B2_CONFIG.keyId && B2_CONFIG.applicationKey && B2_CONFIG.bucketId);
}

function runBackup(reason = 'interval') {
  const status = electionStatus();
  if (status === 'pre_open') return;
  if (Date.now() > electionCloseMs + 60 * 60 * 1000) return;

  const ts = new Date().toISOString().replace(/[:.]/g, '-');
  const dest = path.join(BACKUPS_DIR, `votes-${ts}.db`);

  db.backup(dest)
    .then(async () => {
      pruneBackups();
      audit('backup_ok', 'system', null, { file: path.basename(dest), reason });
      if (cloudBackupEnabled()) {
        try {
          await uploadToBackblazeB2(dest);
          audit('cloud_backup_ok', 'system', null, { file: path.basename(dest) });
        } catch (err) {
          console.error('Cloud backup failed:', err);
          audit('cloud_backup_fail', 'system', null, { error: err.message });
        }
      }
    })
    .catch((err) => {
      console.error('Backup failed:', err);
      audit('backup_fail', 'system', null, { error: err.message, reason });
    });
}

function pruneBackups() {
  const files = fs.readdirSync(BACKUPS_DIR)
    .filter((f) => f.startsWith('votes-') && f.endsWith('.db'))
    .map((f) => ({ f, t: fs.statSync(path.join(BACKUPS_DIR, f)).mtimeMs }))
    .sort((a, b) => b.t - a.t);
  for (const old of files.slice(BACKUP_RETAIN)) {
    try {
      fs.unlinkSync(path.join(BACKUPS_DIR, old.f));
    } catch (_) {}
  }
}

async function uploadToBackblazeB2(filePath) {
  if (typeof fetch !== 'function') throw new Error('Global fetch is not available in this Node runtime');

  const authHeader = Buffer.from(`${B2_CONFIG.keyId}:${B2_CONFIG.applicationKey}`).toString('base64');
  const authRes = await fetch('https://api.backblazeb2.com/b2api/v2/b2_authorize_account', {
    headers: { Authorization: `Basic ${authHeader}` },
  });
  if (!authRes.ok) throw new Error(`B2 authorize failed: ${authRes.status}`);
  const auth = await authRes.json();

  const uploadUrlRes = await fetch(`${auth.apiUrl}/b2api/v2/b2_get_upload_url`, {
    method: 'POST',
    headers: { Authorization: auth.authorizationToken, 'Content-Type': 'application/json' },
    body: JSON.stringify({ bucketId: B2_CONFIG.bucketId }),
  });
  if (!uploadUrlRes.ok) throw new Error(`B2 upload URL failed: ${uploadUrlRes.status}`);
  const upload = await uploadUrlRes.json();

  const body = fs.readFileSync(filePath);
  const sha1 = crypto.createHash('sha1').update(body).digest('hex');
  const remoteName = `${B2_CONFIG.prefix.replace(/\/+$/, '')}/${path.basename(filePath)}`;
  const encodedName = encodeURIComponent(remoteName).replace(/%2F/g, '/');

  const putRes = await fetch(upload.uploadUrl, {
    method: 'POST',
    headers: {
      Authorization: upload.authorizationToken,
      'X-Bz-File-Name': encodedName,
      'Content-Type': 'application/octet-stream',
      'Content-Length': String(body.length),
      'X-Bz-Content-Sha1': sha1,
    },
    body,
  });
  if (!putRes.ok) throw new Error(`B2 upload failed: ${putRes.status}`);
}

setInterval(() => runBackup('interval'), BACKUP_INTERVAL_MS);

/* -------------------------------------------------------------------------- */
/* Error handling and startup                                                  */
/* -------------------------------------------------------------------------- */

app.use((err, req, res, next) => {
  console.error('Unhandled error:', err);
  audit('server_error', req.session?.student_id || null, req.ip, { error: err.message });
  res.status(500).json({ message: 'Internal server error.' });
});

(async () => {
  loadStudents();
  loadCandidates();
  DUMMY_HASH = await bcrypt.hash(crypto.randomBytes(32).toString('hex'), 10);
  const host = IS_PROD ? '0.0.0.0' : '127.0.0.1';
  app.listen(PORT, host, () => {
    console.log('\n  Elite Grand School Voting Portal');
    console.log(`  Mode:          ${NODE_ENV}`);
    console.log(`  Listening on:  http://${host}:${PORT}`);
    console.log(`  Data dir:      ${DATA_DIR}`);
    console.log(`  Election:      ${ELECTION_OPEN} -> ${ELECTION_CLOSE}`);
    console.log(`  Status now:    ${electionStatus()}`);
    console.log(`  Admin IP gate: ${ADMIN_ALLOWED_IPS.length ? 'enabled' : 'disabled'}`);
    console.log(`  Results code:  ${RESULTS_ACCESS_CODE_HASH ? 'required' : 'not required'}`);
    console.log(`  Cloud backup:  ${cloudBackupEnabled() ? 'Backblaze B2 enabled' : 'disabled'}\n`);
    audit('server_start', 'system', null, {
      data_dir: DATA_DIR,
      election_open: ELECTION_OPEN,
      election_close: ELECTION_CLOSE,
      status: electionStatus(),
      admin_ip_allowlist_enabled: Boolean(ADMIN_ALLOWED_IPS.length),
      results_code_required: Boolean(RESULTS_ACCESS_CODE_HASH),
      cloud_backup_enabled: cloudBackupEnabled(),
    });
  });
})();

function shutdown(sig) {
  audit('server_stop', 'system', null, { signal: sig });
  console.log(`\n  Shutting down (${sig})...`);
  try { db.close(); } catch (_) {}
  try { sessionStore.close(); } catch (_) {}
  process.exit(0);
}

process.on('SIGINT', () => shutdown('SIGINT'));
process.on('SIGTERM', () => shutdown('SIGTERM'));
