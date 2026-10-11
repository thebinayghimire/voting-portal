// Small roster editor for students.json.
//
// Examples:
//   node scripts/manage-students.js list
//   node scripts/manage-students.js add STU101 "Grade 10 DT 1" TempPass123 --house Blue
//   node scripts/manage-students.js update STU101 --grade "Grade 9 CT" --password NewPass123 --house Red
//   node scripts/manage-students.js remove STU101

const fs = require('fs');
const path = require('path');
const bcrypt = require('bcrypt');

const VALID_GRADES = new Set([
  'Grade 9 CT',
  'Grade 9 CE',
  'Grade 10 DT 1',
  'Grade 10 DT 2',
  'Teacher',
]);

const GRADE_ALIASES = new Map([
  ['CT', 'Grade 9 CT'],
  ['CE', 'Grade 9 CE'],
  ['DT1', 'Grade 10 DT 1'],
  ['DT 1', 'Grade 10 DT 1'],
  ['DT2', 'Grade 10 DT 2'],
  ['DT 2', 'Grade 10 DT 2'],
]);

const VALID_HOUSES = new Set(['Blue', 'Green', 'Red', 'Yellow']);

const filePath = path.resolve(process.env.STUDENTS_FILE || 'students.json');
const [command, ...rest] = process.argv.slice(2);

function usage() {
  console.log('Usage: node scripts/manage-students.js <list|add|update|remove> ...');
  console.log('Grades: "Grade 9 CT", "Grade 9 CE", "Grade 10 DT 1", "Grade 10 DT 2", "Teacher"');
  console.log('Short aliases accepted: CT, CE, DT1, DT2');
  console.log('Student houses: Blue, Green, Red, Yellow');
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

function normalizeGrade(grade) {
  const normalized = GRADE_ALIASES.get(grade) || grade;
  if (!VALID_GRADES.has(normalized)) throw new Error(`Invalid grade "${grade}"`);
  return normalized;
}

function assertHouse(house) {
  if (!VALID_HOUSES.has(house)) throw new Error(`Invalid house "${house}"`);
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
    const [studentId, grade, password, ...flagArgs] = rest;
    if (!studentId || !grade || !password) usage();
    const flags = parseFlags(flagArgs);
    if (roster.students.some((s) => s.student_id === studentId)) {
      throw new Error(`${studentId} already exists`);
    }
    const student = {
      student_id: studentId,
      password: await bcrypt.hash(password, 10),
      grade: normalizeGrade(grade),
    };
    if (flags.house) {
      assertHouse(flags.house);
      student.house = flags.house;
    }
    roster.students.push(student);
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
      student.grade = normalizeGrade(flags.grade);
    }
    if (flags.password) {
      student.password = await bcrypt.hash(flags.password, 10);
    }
    if (flags.house) {
      assertHouse(flags.house);
      student.house = flags.house;
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
