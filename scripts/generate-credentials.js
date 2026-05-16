// Rotate student passwords and create printable credential slips.
//
// Usage:
//   node scripts/generate-credentials.js
//   node scripts/generate-credentials.js --input students.json --out-dir credentials-out --apply

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const bcrypt = require('bcrypt');

const args = parseArgs(process.argv.slice(2));
const inputPath = path.resolve(args.input || 'students.json');
const outDir = path.resolve(args['out-dir'] || 'credentials-out');
const apply = Boolean(args.apply);
const rounds = Number(args.rounds || 10);

const ALPHABET = 'ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz23456789';

function parseArgs(argv) {
  const out = {};
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (!arg.startsWith('--')) continue;
    const key = arg.slice(2);
    if (key === 'apply') {
      out.apply = true;
    } else {
      out[key] = argv[i + 1];
      i += 1;
    }
  }
  return out;
}

function randomPassword(length = 10) {
  let password = '';
  for (let i = 0; i < length; i += 1) {
    password += ALPHABET[crypto.randomInt(ALPHABET.length)];
  }
  return password;
}

function htmlEscape(value) {
  return String(value)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

function csvCell(value) {
  return `"${String(value).replace(/"/g, '""')}"`;
}

(async () => {
  const parsed = JSON.parse(fs.readFileSync(inputPath, 'utf8').replace(/^\uFEFF/, ''));
  if (!Array.isArray(parsed.students) || !parsed.students.length) {
    throw new Error('Input must contain a non-empty students array');
  }

  fs.mkdirSync(outDir, { recursive: true });
  const rotated = [];
  const slips = [];

  for (const student of parsed.students) {
    if (!student.student_id) throw new Error('Every student needs student_id');
    if (!student.grade) throw new Error(`Student ${student.student_id} needs grade before rotation`);
    const password = randomPassword();
    const hash = await bcrypt.hash(password, rounds);
    rotated.push({ ...student, password: hash });
    slips.push({ student_id: student.student_id, grade: student.grade, password });
  }

  const studentsOut = { students: rotated };
  const generatedStudentsPath = path.join(outDir, 'students.rotated.json');
  const csvPath = path.join(outDir, 'credential-slips.csv');
  const htmlPath = path.join(outDir, 'credential-slips.html');

  fs.writeFileSync(generatedStudentsPath, `${JSON.stringify(studentsOut, null, 2)}\n`);
  fs.writeFileSync(csvPath, [
    ['student_id', 'grade', 'password'].map(csvCell).join(','),
    ...slips.map((s) => [s.student_id, s.grade, s.password].map(csvCell).join(',')),
  ].join('\n') + '\n');
  fs.writeFileSync(htmlPath, renderSlips(slips));

  if (apply) {
    const backupPath = path.join(outDir, `students.before-rotation-${Date.now()}.json`);
    fs.copyFileSync(inputPath, backupPath);
    fs.writeFileSync(inputPath, `${JSON.stringify(studentsOut, null, 2)}\n`);
    console.log(`Updated ${inputPath}`);
    console.log(`Previous roster copied to ${backupPath}`);
  } else {
    console.log('Dry run complete. Review the generated roster before replacing students.json.');
  }

  console.log(`Generated ${generatedStudentsPath}`);
  console.log(`Generated ${csvPath}`);
  console.log(`Generated ${htmlPath}`);
})();

function renderSlips(slips) {
  const cards = slips.map((s) => `
    <section class="slip">
      <h2>Elite Grand School Voting</h2>
      <p><strong>Student ID</strong><span>${htmlEscape(s.student_id)}</span></p>
      <p><strong>Grade</strong><span>${htmlEscape(s.grade)}</span></p>
      <p><strong>Password</strong><span class="password">${htmlEscape(s.password)}</span></p>
      <small>Use once during the supervised election session.</small>
    </section>
  `).join('\n');

  return `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <title>Credential Slips</title>
  <style>
    * { box-sizing: border-box; }
    body { font-family: Arial, sans-serif; margin: 24px; color: #111; }
    .grid { display: grid; grid-template-columns: repeat(2, 1fr); gap: 12px; }
    .slip { border: 1px dashed #555; padding: 14px; min-height: 150px; page-break-inside: avoid; }
    h2 { font-size: 16px; margin: 0 0 10px; }
    p { display: flex; justify-content: space-between; gap: 12px; margin: 8px 0; }
    strong { color: #555; }
    .password { font-family: Consolas, monospace; font-size: 18px; font-weight: 700; }
    small { display: block; margin-top: 12px; color: #666; }
    @media print { body { margin: 10mm; } }
  </style>
</head>
<body>
  <div class="grid">
${cards}
  </div>
</body>
</html>
`;
}
