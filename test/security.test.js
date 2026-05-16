const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const net = require('node:net');
const { spawn } = require('node:child_process');
const bcrypt = require('bcrypt');
const Database = require('better-sqlite3');

async function freePort() {
  return await new Promise((resolve, reject) => {
    const server = net.createServer();
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => {
      const { port } = server.address();
      server.close(() => resolve(port));
    });
  });
}

function writeJson(filePath, value) {
  fs.writeFileSync(filePath, `${JSON.stringify(value, null, 2)}\n`);
}

async function startServer(extraEnv = {}) {
  const root = path.resolve(__dirname, '..');
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'voting-portal-'));
  const studentsFile = path.join(tmp, 'students.json');
  const candidatesFile = path.join(tmp, 'candidates.json');
  const dataDir = path.join(tmp, 'data');
  fs.mkdirSync(dataDir);

  writeJson(studentsFile, {
    students: [
      { student_id: 'STU001', password: bcrypt.hashSync('pass001', 10), grade: 'Grade 1' },
      { student_id: 'STU002', password: bcrypt.hashSync('pass002', 10), grade: 'Grade 2' },
    ],
  });
  writeJson(candidatesFile, {
    candidates: [
      { candidate_id: 'G1-HC001', name: 'G1 House A', category: 'House', grade: 'Grade 1' },
      { candidate_id: 'G1-HC002', name: 'G1 House B', category: 'House', grade: 'Grade 1' },
      { candidate_id: 'G1-SC001', name: 'G1 School A', category: 'School', grade: 'Grade 1' },
      { candidate_id: 'G1-SC002', name: 'G1 School B', category: 'School', grade: 'Grade 1' },
      { candidate_id: 'G2-HC001', name: 'G2 House A', category: 'House', grade: 'Grade 2' },
      { candidate_id: 'G2-SC001', name: 'G2 School A', category: 'School', grade: 'Grade 2' },
    ],
  });

  const port = await freePort();
  const now = Date.now();
  const env = {
    ...process.env,
    NODE_ENV: 'development',
    PORT: String(port),
    DATA_DIR: dataDir,
    STUDENTS_FILE: studentsFile,
    CANDIDATES_FILE: candidatesFile,
    SESSION_SECRET: 'test-session-secret-with-enough-length-123456',
    ADMIN_USERNAME: 'admin',
    ADMIN_PASSWORD_HASH: bcrypt.hashSync('admin-pass', 10),
    ELECTION_OPEN_AT: new Date(now - 60 * 60 * 1000).toISOString(),
    ELECTION_CLOSE_AT: new Date(now + 60 * 60 * 1000).toISOString(),
    ...extraEnv,
  };

  const child = spawn(process.execPath, ['server.js'], {
    cwd: root,
    env,
    stdio: ['ignore', 'pipe', 'pipe'],
  });

  child.stdout.on('data', () => {});
  child.stderr.on('data', (chunk) => process.stderr.write(chunk));

  const baseUrl = `http://127.0.0.1:${port}`;
  for (let i = 0; i < 80; i += 1) {
    try {
      const res = await fetch(`${baseUrl}/election/status`);
      if (res.ok) return { child, baseUrl, tmp, dataDir };
    } catch (_) {}
    await new Promise((resolve) => setTimeout(resolve, 100));
  }

  child.kill('SIGTERM');
  throw new Error('Server did not start in time');
}

async function stopServer(child) {
  if (child.killed) return;
  child.kill('SIGTERM');
  await new Promise((resolve) => child.once('exit', resolve));
}

function cookieFrom(res) {
  const raw = res.headers.get('set-cookie');
  assert.ok(raw, 'expected set-cookie header');
  return raw.split(';')[0];
}

test('student can only vote for candidates in their server-side assigned grade', async () => {
  const ctx = await startServer();
  try {
    const login = await fetch(`${ctx.baseUrl}/login`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ student_id: 'STU001', password: 'pass001' }),
    });
    assert.equal(login.status, 200);
    const cookie = cookieFrom(login);

    const candidates = await fetch(`${ctx.baseUrl}/candidates`, {
      headers: { Cookie: cookie },
    });
    assert.equal(candidates.status, 200);
    const candidateData = await candidates.json();
    assert.equal(candidateData.grade, 'Grade 1');
    assert.ok(candidateData.candidates.every((c) => c.grade === 'Grade 1'));

    const spoof = await fetch(`${ctx.baseUrl}/vote`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Cookie: cookie },
      body: JSON.stringify({
        house_candidate_id: 'G2-HC001',
        school_candidate_id: 'G2-SC001',
        grade: 'Grade 2',
      }),
    });
    assert.equal(spoof.status, 400);

    const vote = await fetch(`${ctx.baseUrl}/vote`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Cookie: cookie },
      body: JSON.stringify({
        house_candidate_id: 'G1-HC001',
        school_candidate_id: 'G1-SC001',
      }),
    });
    assert.equal(vote.status, 200);

    const db = new Database(path.join(ctx.dataDir, 'votes.db'), { readonly: true });
    const voter = db.prepare('SELECT * FROM voters WHERE student_id = ?').get('STU001');
    const votes = db.prepare('SELECT * FROM votes ORDER BY id').all();
    db.close();

    assert.equal(voter.grade, 'Grade 1');
    assert.equal(votes.length, 2);
    assert.ok(votes.every((v) => v.grade === 'Grade 1'));
    assert.ok(votes.every((v) => v.timestamp.startsWith('anonymous-ballot-pool:')));
    assert.notEqual(voter.timestamp, votes[0].timestamp);
  } finally {
    await stopServer(ctx.child);
  }
});

test('admin results can require a second-person reveal code', async () => {
  const now = Date.now();
  const ctx = await startServer({
    ELECTION_CLOSE_AT: new Date(now - 30 * 60 * 1000).toISOString(),
    RESULTS_VISIBLE_AFTER: new Date(now - 10 * 60 * 1000).toISOString(),
    RESULTS_ACCESS_CODE_HASH: bcrypt.hashSync('open-sesame', 10),
  });

  try {
    const login = await fetch(`${ctx.baseUrl}/admin/login`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ username: 'admin', password: 'admin-pass' }),
    });
    assert.equal(login.status, 200);
    const cookie = cookieFrom(login);

    const missing = await fetch(`${ctx.baseUrl}/admin/results`, {
      headers: { Cookie: cookie },
    });
    assert.equal(missing.status, 403);
    assert.equal((await missing.json()).requires_results_code, true);

    const wrong = await fetch(`${ctx.baseUrl}/admin/results`, {
      headers: { Cookie: cookie, 'x-results-code': 'wrong' },
    });
    assert.equal(wrong.status, 403);

    const ok = await fetch(`${ctx.baseUrl}/admin/results`, {
      headers: { Cookie: cookie, 'x-results-code': 'open-sesame' },
    });
    assert.equal(ok.status, 200);
    const body = await ok.json();
    assert.equal(body.totalStudents, 2);
    assert.equal(body.ballotsCast, 0);
  } finally {
    await stopServer(ctx.child);
  }
});
