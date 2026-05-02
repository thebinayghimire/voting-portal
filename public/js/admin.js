// admin.js — admin dashboard. Cookie sessions, no localStorage.
// Builds tables/rows via DOM (no innerHTML interpolation of user data).

const $ = (id) => document.getElementById(id);

const GRADES = ['Grade 1','Grade 2','Grade 3','Grade 4','Grade 5','Grade 6','Grade 7','Grade 8','Grade 9','Grade 10'];

let allData       = null;
let currentFilter = 'all';
let currentTab    = 'results';

/* ── Auth UI ─────────────────────────────────────────────────────── */

function showDashboard() {
  $('login-screen').classList.add('hidden');
  $('dashboard').classList.remove('hidden');
  $('header-badge').classList.remove('hidden');
  $('logout-btn').classList.remove('hidden');
}

function showLogin() {
  $('login-screen').classList.remove('hidden');
  $('dashboard').classList.add('hidden');
  $('header-badge').classList.add('hidden');
  $('logout-btn').classList.add('hidden');
}

function showLoginError(msg) {
  const el = $('login-error');
  el.textContent = msg;
  el.classList.remove('hidden');
}

async function adminLogin() {
  $('login-error').classList.add('hidden');
  const username = $('admin-user').value.trim();
  const password = $('admin-pass').value;
  if (!username || !password) {
    showLoginError('Please enter username and password.');
    return;
  }

  try {
    const res = await fetch('/admin/login', {
      method: 'POST',
      credentials: 'include',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ username, password }),
    });
    const data = await res.json().catch(() => ({}));
    if (res.ok) {
      showDashboard();
      refreshCurrentTab();
      return;
    }
    showLoginError(data.message || 'Invalid credentials.');
  } catch {
    showLoginError('Could not connect to server.');
  }
}

async function adminLogout() {
  try {
    await fetch('/admin/logout', { method: 'POST', credentials: 'include' });
  } catch (_) {}
  showLogin();
}

/* ── Tabs ────────────────────────────────────────────────────────── */

function switchTab(name) {
  currentTab = name;
  document.querySelectorAll('.tab-btn').forEach(b => {
    b.classList.toggle('active', b.dataset.tab === name);
  });
  document.querySelectorAll('.tab-pane').forEach(p => p.classList.add('hidden'));
  $(`tab-${name}`).classList.remove('hidden');
  refreshCurrentTab();
}

function refreshCurrentTab() {
  if (currentTab === 'results') loadResults();
  if (currentTab === 'turnout') loadTurnout();
  if (currentTab === 'audit')   loadAudit();
}

/* ── Results tab ─────────────────────────────────────────────────── */

async function loadResults() {
  $('last-updated').textContent = 'Loading…';
  $('results-locked').classList.add('hidden');

  try {
    const res = await fetch('/admin/results', { credentials: 'include' });
    if (res.status === 401) { showLogin(); return; }
    if (res.status === 403) {
      const data = await res.json().catch(() => ({}));
      $('results-locked').classList.remove('hidden');
      $('results-locked').textContent = data.message || 'Results locked until voting closes.';
      $('last-updated').textContent = 'Results not yet available.';
      return;
    }
    allData = await res.json();
    renderAll();
    $('last-updated').textContent = 'Last updated: ' + new Date().toLocaleTimeString();
    if (allData.election) {
      $('election-status').textContent =
        `Election ${allData.election.status} (${allData.election.opens_at} → ${allData.election.closes_at})`;
    }
  } catch {
    $('last-updated').textContent = 'Failed to load. Try refreshing.';
  }
}

function renderAll() {
  if (!allData) return;
  const { totalVotes, totalStudents, gradeStats } = allData;

  $('stat-votes').textContent     = totalVotes;
  $('stat-students').textContent  = totalStudents;
  $('stat-turnout').textContent   = totalStudents ? Math.round((totalVotes / totalStudents) * 100) + '%' : '0%';
  $('stat-remaining').textContent = totalStudents - totalVotes;

  const gradeMap = {};
  (gradeStats || []).forEach(g => { gradeMap[g.grade] = g.voted; });

  const chips = $('grade-chips');
  const selected = $('grade-select').value;
  chips.replaceChildren();
  for (const g of GRADES) {
    const chip = document.createElement('div');
    chip.className = 'grade-chip' + (selected === g ? ' active' : '');
    const name = document.createElement('div');
    name.className = 'chip-name';
    name.textContent = g;
    const stat = document.createElement('div');
    stat.className = 'chip-stat';
    stat.textContent = `${gradeMap[g] || 0} voted`;
    chip.appendChild(name);
    chip.appendChild(stat);
    chip.addEventListener('click', () => {
      $('grade-select').value = g;
      onGradeChange();
    });
    chips.appendChild(chip);
  }

  renderGradeView();
  renderStudentsTable();
}

function onGradeChange() {
  const grade = $('grade-select').value;
  document.querySelectorAll('.grade-chip').forEach(chip => {
    const name = chip.querySelector('.chip-name')?.textContent;
    chip.classList.toggle('active', name === grade);
  });
  renderGradeView();
}

function renderGradeView() {
  if (!allData) return;
  const grade = $('grade-select').value;
  const { results, gradeStats, totalVotes, totalStudents } = allData;

  const filtered = grade === 'all' ? results : results.filter(r => r.grade === grade);
  renderBars($('house-results'),  filtered.filter(r => r.category === 'House'));
  renderBars($('school-results'), filtered.filter(r => r.category === 'School'));

  const turnoutEl = $('turnout-text');
  turnoutEl.replaceChildren();
  const strong = document.createElement('strong');
  if (grade === 'all') {
    strong.textContent = totalVotes;
    turnoutEl.appendChild(strong);
    turnoutEl.appendChild(document.createTextNode(` of ${totalStudents} students voted`));
  } else {
    const gs = (gradeStats || []).find(g => g.grade === grade);
    strong.textContent = gs ? gs.voted : 0;
    turnoutEl.appendChild(strong);
    turnoutEl.appendChild(document.createTextNode(` students in ${grade} voted`));
  }
}

function renderBars(container, candidates) {
  const sorted = [...candidates].sort((a, b) => b.votes - a.votes);
  const maxV = sorted.length ? sorted[0].votes : 0;

  container.replaceChildren();
  if (!sorted.length || sorted.every(c => c.votes === 0)) {
    const empty = document.createElement('div');
    empty.className = 'no-votes';
    empty.textContent = 'No votes recorded yet.';
    container.appendChild(empty);
    return;
  }

  sorted.forEach((c, i) => {
    const pct = maxV > 0 ? Math.round((c.votes / maxV) * 100) : 0;
    const rankClass = i === 0 ? '' : (i === 1 ? 'r2' : 'r3');

    const row = document.createElement('div');
    row.className = 'candidate-row';

    const top = document.createElement('div');
    top.className = 'row-top';
    const rowName = document.createElement('div');
    rowName.className = 'row-name';
    const rank = document.createElement('div');
    rank.className = 'rank' + (rankClass ? ' ' + rankClass : '');
    rank.textContent = i + 1;
    rowName.appendChild(rank);
    rowName.appendChild(document.createTextNode(' ' + c.name));

    const rowVotes = document.createElement('div');
    rowVotes.className = 'row-votes';
    rowVotes.textContent = `${c.votes} vote${c.votes !== 1 ? 's' : ''}`;

    top.appendChild(rowName);
    top.appendChild(rowVotes);

    const track = document.createElement('div');
    track.className = 'bar-track';
    const fill = document.createElement('div');
    fill.className = 'bar-fill' + (rankClass ? ' ' + rankClass : '');
    // CSP-safe: setting style property directly is allowed.
    fill.style.width = pct + '%';
    track.appendChild(fill);

    row.appendChild(top);
    row.appendChild(track);
    container.appendChild(row);
  });
}

function renderStudentsTable() {
  if (!allData) return;
  let students = allData.students || [];
  if (currentFilter === 'voted')   students = students.filter(s => s.has_voted);
  if (currentFilter === 'pending') students = students.filter(s => !s.has_voted);

  const tbody = $('students-body');
  tbody.replaceChildren();
  if (!students.length) {
    const tr = document.createElement('tr');
    const td = document.createElement('td');
    td.colSpan = 2;
    td.textContent = 'No students found.';
    td.style.textAlign = 'center';
    td.style.color = '#bbb';
    td.style.padding = '1.5rem 0';
    tr.appendChild(td);
    tbody.appendChild(tr);
    return;
  }
  for (const s of students) {
    const tr = document.createElement('tr');
    const tdId = document.createElement('td');
    tdId.textContent = s.student_id;
    const tdStatus = document.createElement('td');
    const pill = document.createElement('span');
    pill.className = s.has_voted ? 'pill-yes' : 'pill-no';
    pill.textContent = s.has_voted ? 'Voted' : 'Pending';
    tdStatus.appendChild(pill);
    tr.appendChild(tdId);
    tr.appendChild(tdStatus);
    tbody.appendChild(tr);
  }
}

function filterStudents(filter, btn) {
  currentFilter = filter;
  document.querySelectorAll('.filter-btn').forEach(b => b.classList.remove('active'));
  btn.classList.add('active');
  renderStudentsTable();
}

/* ── Turnout tab ─────────────────────────────────────────────────── */

async function loadTurnout() {
  try {
    const res = await fetch('/admin/turnout', { credentials: 'include' });
    if (res.status === 401) { showLogin(); return; }
    const data = await res.json();
    $('live-voted').textContent = data.total_voted;
    $('live-total').textContent = data.total_students;

    const chips = $('live-grade-chips');
    chips.replaceChildren();
    const map = {};
    (data.by_grade || []).forEach(g => map[g.grade] = g.voted);
    for (const g of GRADES) {
      const chip = document.createElement('div');
      chip.className = 'grade-chip';
      const name = document.createElement('div');
      name.className = 'chip-name';
      name.textContent = g;
      const stat = document.createElement('div');
      stat.className = 'chip-stat';
      stat.textContent = `${map[g] || 0} voted`;
      chip.appendChild(name);
      chip.appendChild(stat);
      chips.appendChild(chip);
    }
    $('last-updated').textContent = 'Live turnout updated: ' + new Date().toLocaleTimeString();
  } catch {
    $('last-updated').textContent = 'Failed to load turnout.';
  }
}

/* ── Audit tab ───────────────────────────────────────────────────── */

async function loadAudit() {
  try {
    const res = await fetch('/admin/audit?limit=200', { credentials: 'include' });
    if (res.status === 401) { showLogin(); return; }
    const data = await res.json();
    const tbody = $('audit-body');
    tbody.replaceChildren();
    if (!data.events?.length) {
      const tr = document.createElement('tr');
      const td = document.createElement('td');
      td.colSpan = 5;
      td.textContent = 'No audit events yet.';
      td.style.textAlign = 'center';
      td.style.color = '#bbb';
      td.style.padding = '1.5rem 0';
      tr.appendChild(td);
      tbody.appendChild(tr);
      return;
    }
    for (const e of data.events) {
      const tr = document.createElement('tr');
      const cells = [
        new Date(e.timestamp).toLocaleString(),
        e.event_type,
        e.actor || '–',
        e.ip || '–',
        e.details || '',
      ];
      for (const v of cells) {
        const td = document.createElement('td');
        td.textContent = v;
        if (v === e.event_type) {
          td.className = 'audit-event ' + (
            v.includes('fail') || v.includes('error') || v.includes('blocked') || v.includes('rate_limit') ? 'bad' : 'ok'
          );
        }
        tr.appendChild(td);
      }
      tbody.appendChild(tr);
    }
    $('last-updated').textContent = 'Audit log updated: ' + new Date().toLocaleTimeString();
  } catch {
    $('last-updated').textContent = 'Failed to load audit log.';
  }
}

/* ── Init ────────────────────────────────────────────────────────── */

document.addEventListener('DOMContentLoaded', () => {
  // Try to load — if 401, we'll fall back to login screen.
  fetch('/admin/turnout', { credentials: 'include' })
    .then(r => {
      if (r.ok) {
        showDashboard();
        refreshCurrentTab();
      } else {
        showLogin();
      }
    })
    .catch(() => showLogin());

  $('admin-login-btn').addEventListener('click', adminLogin);
  $('logout-btn').addEventListener('click', adminLogout);
  $('refresh-btn').addEventListener('click', refreshCurrentTab);
  $('grade-select').addEventListener('change', onGradeChange);

  document.querySelectorAll('.tab-btn').forEach(b => {
    b.addEventListener('click', () => switchTab(b.dataset.tab));
  });
  document.querySelectorAll('.filter-btn').forEach(b => {
    b.addEventListener('click', () => filterStudents(b.dataset.filter, b));
  });

  document.addEventListener('keydown', e => {
    if (e.key === 'Enter' && !$('login-screen').classList.contains('hidden')) {
      adminLogin();
    }
  });
});
