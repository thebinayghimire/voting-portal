/**
 * Elite Grand School Voting Portal — Tier 1 hardened server
 *
 * Hardening over v1:
 *   1. Election window enforcement (open/close timestamps)
 *   2. Audit log (append-only, anonymity-safe)
 *   3. HTTPS-only redirect
 *   4. trust proxy for Render / Heroku / nginx
 *   5. Split rate limiters: /login (per IP+student_id), /admin/login (per IP)
 *   6. helmet with strict CSP (requires external JS/CSS)
 *   7. Persistent sessions via connect-sqlite3
 *   8. Periodic local backups during voting window
 *   9. Result publication blocked until election close
 */

require('dotenv').config();

const express       = require('express');
const session       = require('express-session');
const SQLiteStore   = require('connect-sqlite3')(session);
const bcrypt        = require('bcrypt');
const crypto        = require('crypto');
const path          = require('path');
const fs            = require('fs');
const Database      = require('better-sqlite3');
const { rateLimit, ipKeyGenerator } = require('express-rate-limit');
const helmet        = require('helmet');

const app = express();

/* ════════════════════════════════════════════════════════════════════
   CONFIGURATION
   ════════════════════════════════════════════════════════════════════ */

const PORT             = process.env.PORT || 3000;
const NODE_ENV         = process.env.NODE_ENV || 'development';
const IS_PROD          = NODE_ENV === 'production';
const SESSION_SECRET   = process.env.SESSION_SECRET;
const ADMIN_USERNAME   = process.env.ADMIN_USERNAME;
const ADMIN_PWHASH     = process.env.ADMIN_PASSWORD_HASH;
const ELECTION_OPEN    = process.env.ELECTION_OPEN_AT;
const ELECTION_CLOSE   = process.env.ELECTION_CLOSE_AT;
const RESULTS_AFTER    = process.env.RESULTS_VISIBLE_AFTER || ELECTION_CLOSE;

const requiredEnv = { SESSION_SECRET, ADMIN_USERNAME, ADMIN_PWHASH, ELECTION_OPEN, ELECTION_CLOSE };
for (const [name, val] of Object.entries(requiredEnv)) {
  if (!val) { console.error(`FATAL: ${name} not set in .env`); process.exit(1); }
}

const electionOpenMs  = Date.parse(ELECTION_OPEN);
const electionCloseMs = Date.parse(ELECTION_CLOSE);
const resultsAfterMs  = Date.parse(RESULTS_AFTER);
if (isNaN(electionOpenMs) || isNaN(electionCloseMs)) {
  console.error('FATAL: ELECTION_OPEN_AT / ELECTION_CLOSE_AT could not be parsed as dates');
  process.exit(1);
}
if (electionCloseMs <= electionOpenMs) {
  console.error('FATAL: ELECTION_CLOSE_AT must be after ELECTION_OPEN_AT');
  process.exit(1);
}

/* ════════════════════════════════════════════════════════════════════
   DATABASE
   ════════════════════════════════════════════════════════════════════ */

const DB_PATH        = path.join(__dirname, 'votes.db');
const SESSIONS_DIR   = path.join(__dirname, 'sessions');
const BACKUPS_DIR    = path.join(__dirname, 'backups');
fs.mkdirSync(SESSIONS_DIR, { recursive: true });
fs.mkdirSync(BACKUPS_DIR,  { recursive: true });

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
      eventType,
      actor || null,
      ip || null,
      details ? JSON.stringify(details) : null
    );
  } catch (e) {
    console.error('AUDIT WRITE FAILED:', eventType, e.message);
  }
}

/* ════════════════════════════════════════════════════════════════════
   MIDDLEWARE
   ════════════════════════════════════════════════════════════════════ */

app.set('trust proxy', 1);

app.use((req, res, next) => {
  if (!IS_PROD) return next();
  if (req.secure || req.headers['x-forwarded-proto'] === 'https') return next();
  return res.redirect(301, 'https://' + req.headers.host + req.url);
});

app.use(helmet({
  contentSecurityPolicy: {
    directives: {
      defaultSrc: ["'self'"],
      scriptSrc:  ["'self'"],
      styleSrc:   ["'self'", 'https://fonts.googleapis.com'],
      fontSrc:    ["'self'", 'https://fonts.gstatic.com'],
      imgSrc:     ["'self'", 'data:'],
      connectSrc: ["'self'"],
      frameAncestors: ["'none'"],
      objectSrc:  ["'none'"],
      baseUri:    ["'self'"],
      formAction: ["'self'"],
    },
  },
  crossOriginEmbedderPolicy: false,
  hsts: IS_PROD ? { maxAge: 31536000, includeSubDomains: true } : false,
}));

app.use(express.json({ limit: '10kb' }));

app.use(session({
  store: new SQLiteStore({ db: 'sessions.db', dir: SESSIONS_DIR }),
  secret: SESSION_SECRET,
  resave: false,
  saveUninitialized: false,
  rolling: true,
  cookie: {
    httpOnly: true,
    secure:   IS_PROD,
    sameSite: 'lax',
    maxAge:   30 * 60 * 1000,
  },
  name: 'egs.sid',
}));

/* ════════════════════════════════════════════════════════════════════
   RATE LIMITERS
   ════════════════════════════════════════════════════════════════════ */

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

/* ════════════════════════════════════════════════════════════════════
   ELECTION WINDOW HELPERS
   ════════════════════════════════════════════════════════════════════ */

function electionStatus() {
  const now = Date.now();
  if (now < electionOpenMs)  return 'pre_open';
  if (now > electionCloseMs) return 'closed';
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

/* ════════════════════════════════════════════════════════════════════
   STATIC FILES
   ════════════════════════════════════════════════════════════════════ */

app.use(express.static(path.join(__dirname, 'public'), {
  dotfiles: 'deny',
  index: 'index.html',
}));

/* ════════════════════════════════════════════════════════════════════
   DATA LOADING (cached)
   ════════════════════════════════════════════════════════════════════ */

let _studentsCache = null;
let _candidatesCache = null;
function loadStudents() {
  if (!_studentsCache) {
    _studentsCache = JSON.parse(fs.readFileSync(path.join(__dirname, 'students.json'))).students;
  }
  return _studentsCache;
}
function loadCandidates() {
  if (!_candidatesCache) {
    _candidatesCache = JSON.parse(fs.readFileSync(path.join(__dirname, 'candidates.json'))).candidates;
  }
  return _candidatesCache;
}

/* ════════════════════════════════════════════════════════════════════
   AUTH HELPERS
   ════════════════════════════════════════════════════════════════════ */

let DUMMY_HASH;

function requireStudent(req, res, next) {
  if (!req.session?.student_id || req.session.role !== 'student') {
    return res.status(401).json({ message: 'Not logged in.' });
  }
  next();
}

function requireAdmin(req, res, next) {
  if (req.session?.role !== 'admin') {
    return res.status(401).json({ message: 'Admin access required.' });
  }
  next();
}

/* ════════════════════════════════════════════════════════════════════
   PUBLIC ROUTES
   ════════════════════════════════════════════════════════════════════ */

app.get('/election/status', (req, res) => {
  res.json({
    status:    electionStatus(),
    opens_at:  ELECTION_OPEN,
    closes_at: ELECTION_CLOSE,
    now:       new Date().toISOString(),
  });
});

/* ════════════════════════════════════════════════════════════════════
   STUDENT ROUTES
   ════════════════════════════════════════════════════════════════════ */

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
  const user     = students.find(s => s.student_id === student_id);

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
    req.session.role       = 'student';
    audit('login_success', student_id, ip);
    res.json({ message: 'Login successful.' });
  });
});

app.get('/candidates', requireStudent, (req, res) => {
  res.json({ candidates: loadCandidates() });
});

app.post('/vote', requireStudent, requireElectionOpen, voteLimiter, (req, res) => {
  const { house_candidate_id, school_candidate_id, grade } = req.body || {};
  const studentId = req.session.student_id;
  const ip = req.ip;

  if (!house_candidate_id || !school_candidate_id || !grade) {
    return res.status(400).json({ message: 'Please select a candidate for both positions and confirm your grade.' });
  }

  const candidates = loadCandidates();
  const houseCandidate = candidates.find(c =>
    c.candidate_id === house_candidate_id && c.category === 'House' && c.grade === grade
  );
  const schoolCandidate = candidates.find(c =>
    c.candidate_id === school_candidate_id && c.category === 'School' && c.grade === grade
  );
  if (!houseCandidate || !schoolCandidate) {
    audit('vote_invalid_selection', studentId, ip, {
      attempted_house_id:  house_candidate_id,
      attempted_school_id: school_candidate_id,
      attempted_grade:     grade,
    });
    return res.status(400).json({ message: 'Invalid candidate selection.' });
  }

  const recordVote = db.transaction(() => {
    const now = new Date().toISOString();
    db.prepare('INSERT INTO voters (student_id, grade, timestamp) VALUES (?, ?, ?)')
      .run(studentId, grade, now);
    const insertVote = db.prepare(
      'INSERT INTO votes (candidate_id, category, grade, timestamp) VALUES (?, ?, ?, ?)'
    );
    insertVote.run(house_candidate_id,  'House',  grade, now);
    insertVote.run(school_candidate_id, 'School', grade, now);
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

  audit('vote_cast', studentId, ip, { grade });

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

/* ════════════════════════════════════════════════════════════════════
   ADMIN ROUTES
   ════════════════════════════════════════════════════════════════════ */

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
    res.json({ message: 'Admin login successful.' });
  });
});

app.get('/admin/results', requireAdmin, (req, res) => {
  if (Date.now() < resultsAfterMs) {
    audit('admin_results_blocked', 'admin', req.ip, { now: new Date().toISOString() });
    return res.status(403).json({
      message: 'Results are not yet available. Wait until election close.',
      available_after: RESULTS_AFTER,
    });
  }

  const candidates = loadCandidates();
  const students   = loadStudents();

  const countStmt = db.prepare('SELECT COUNT(*) AS cnt FROM votes WHERE candidate_id = ?');
  const results = candidates.map(c => ({
    candidate_id: c.candidate_id,
    name:         c.name,
    category:     c.category,
    grade:        c.grade,
    votes:        countStmt.get(c.candidate_id).cnt,
  }));

  const gradeStats = db.prepare(
    'SELECT grade, COUNT(*) AS voted FROM voters GROUP BY grade'
  ).all();

  const votedSet = new Set(
    db.prepare('SELECT student_id FROM voters').all().map(r => r.student_id)
  );

  const studentStatus = students.map(s => ({
    student_id: s.student_id,
    has_voted:  votedSet.has(s.student_id),
  }));

  audit('admin_results_view', 'admin', req.ip);

  res.json({
    totalVotes:    votedSet.size,
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
    total_voted:    total,
    total_students: loadStudents().length,
    by_grade:       byGrade,
    election:       { status: electionStatus(), opens_at: ELECTION_OPEN, closes_at: ELECTION_CLOSE },
  });
});

app.get('/admin/audit', requireAdmin, (req, res) => {
  const limit  = Math.min(parseInt(req.query.limit, 10) || 200, 1000);
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

/* ════════════════════════════════════════════════════════════════════
   BACKUPS
   ════════════════════════════════════════════════════════════════════ */

const BACKUP_INTERVAL_MS = 5 * 60 * 1000;
const BACKUP_RETAIN      = 50;

function runBackup() {
  const status = electionStatus();
  if (status === 'pre_open') return;
  if (Date.now() > electionCloseMs + 60 * 60 * 1000) return;

  const ts   = new Date().toISOString().replace(/[:.]/g, '-');
  const dest = path.join(BACKUPS_DIR, `votes-${ts}.db`);

  db.backup(dest)
    .then(() => {
      const files = fs.readdirSync(BACKUPS_DIR)
        .filter(f => f.startsWith('votes-') && f.endsWith('.db'))
        .map(f => ({ f, t: fs.statSync(path.join(BACKUPS_DIR, f)).mtimeMs }))
        .sort((a, b) => b.t - a.t);
      for (const old of files.slice(BACKUP_RETAIN)) {
        try { fs.unlinkSync(path.join(BACKUPS_DIR, old.f)); } catch (_) {}
      }
      audit('backup_ok', 'system', null, { file: path.basename(dest) });
    })
    .catch((err) => {
      console.error('Backup failed:', err);
      audit('backup_fail', 'system', null, { error: err.message });
    });
}

setInterval(runBackup, BACKUP_INTERVAL_MS);

/* ════════════════════════════════════════════════════════════════════
   ERROR HANDLING + STARTUP
   ════════════════════════════════════════════════════════════════════ */

app.use((err, req, res, next) => {
  console.error('Unhandled error:', err);
  audit('server_error', req.session?.student_id || null, req.ip, { error: err.message });
  res.status(500).json({ message: 'Internal server error.' });
});

(async () => {
  DUMMY_HASH = await bcrypt.hash(crypto.randomBytes(32).toString('hex'), 10);
  const host = IS_PROD ? '0.0.0.0' : '127.0.0.1';
  app.listen(PORT, host, () => {
    console.log(`\n  Elite Grand School Voting Portal`);
    console.log(`  Mode:          ${NODE_ENV}`);
    console.log(`  Listening on:  http://${host}:${PORT}`);
    console.log(`  Election:      ${ELECTION_OPEN}  →  ${ELECTION_CLOSE}`);
    console.log(`  Status now:    ${electionStatus()}\n`);
    audit('server_start', 'system', null, {
      election_open: ELECTION_OPEN,
      election_close: ELECTION_CLOSE,
      status: electionStatus(),
    });
  });
})();

function shutdown(sig) {
  audit('server_stop', 'system', null, { signal: sig });
  console.log(`\n  Shutting down (${sig})…`);
  try { db.close(); } catch (_) {}
  process.exit(0);
}
process.on('SIGINT',  () => shutdown('SIGINT'));
process.on('SIGTERM', () => shutdown('SIGTERM'));
