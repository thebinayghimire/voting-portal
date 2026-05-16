// Small roster editor for students.json.
//
// Examples:
//   node scripts/manage-students.js list
//   node scripts/manage-students.js add STU101 "Grade 10" TempPass123
//   node scripts/manage-students.js update STU101 --grade "Grade 9" --password NewPass123
//   node scripts/manage-students.js remove STU101

const fs = require('fs');
const path = require('path');
const bcrypt = require('bcrypt');

const VALID_GRADES = new Set([
  'Grade 9A',
  'Grade 9B',
  'Grade 10A',
  'Grade 10B',
  'Teacher',
]);

const filePath = path.resolve(process.env.STUDENTS_FILE || 'students.json');
const [command, ...rest] = process.argv.slice(2);

function usage() {
  console.log('Usage: node scripts/manage-students.js <list|add|update|remove> ...');
  process.exit(1);
}

function loadRoster() {
  const parsed = JSON.parse(fs.readFileSync(filePath, 'utf8').replace(/^\uFEFF/, ''));
  if (!Array.isArray(parsed.students)) throw new Error('students.json must contain students array');
  return parsed;
}

function saveRoster(roster) {
  const backup = `${filePath}.${Date.now()}.bak`;
  fs.copyFileSync(filePath, backup);
  fs.writeFileSync(filePath, `${JSON.stringify(roster, null, 2)}\n`);
  console.log(`Updated ${filePath}`);
  console.log(`Backup: ${backup}`);
}

function parseFlags(argv) {
  const flags = {};
  for (let i = 0; i < argv.length; i += 1) {
    if (!argv[i].startsWith('--')) continue;
    flags[argv[i].slice(2)] = argv[i + 1];
    i += 1;
  }
  return flags;
}

function assertGrade(grade) {
  if (!VALID_GRADES.has(grade)) throw new Error(`Invalid grade "${grade}"`);
}

(async () => {
  if (!command) usage();
  const roster = loadRoster();

  if (command === 'list') {
    for (const s of roster.students) {
      console.log(`${s.student_id}\t${s.grade || '(missing grade)'}`);
    }
    return;
  }

  if (command === 'add') {
    const [studentId, grade, password] = rest;
    if (!studentId || !grade || !password) usage();
    assertGrade(grade);
    if (roster.students.some((s) => s.student_id === studentId)) {
      throw new Error(`${studentId} already exists`);
    }
    roster.students.push({
      student_id: studentId,
      password: await bcrypt.hash(password, 10),
      grade,
    });
    saveRoster(roster);
    return;
  }

  if (command === 'update') {
    const [studentId, ...flagArgs] = rest;
    if (!studentId) usage();
    const flags = parseFlags(flagArgs);
    const student = roster.students.find((s) => s.student_id === studentId);
    if (!student) throw new Error(`${studentId} not found`);
    if (flags.grade) {
      assertGrade(flags.grade);
      student.grade = flags.grade;
    }
    if (flags.password) {
      student.password = await bcrypt.hash(flags.password, 10);
    }
    saveRoster(roster);
    return;
  }

  if (command === 'remove') {
    const [studentId] = rest;
    if (!studentId) usage();
    const before = roster.students.length;
    roster.students = roster.students.filter((s) => s.student_id !== studentId);
    if (roster.students.length === before) throw new Error(`${studentId} not found`);
    saveRoster(roster);
    return;
  }

  usage();
})().catch((err) => {
  console.error(err.message);
  process.exit(1);
});
