// admin.js - admin dashboard. Cookie sessions, no localStorage.
// Builds tables/rows via DOM (no innerHTML interpolation of user data).

const $ = (id) => document.getElementById(id);

const GRADES = ['Grade 9A', 'Grade 9B', 'Grade 10A', 'Grade 10B', 'Teacher'];

const POSITION_ORDER = [
  'Head Boy',
  'Head Girl',
  'Deputy Head Boy',
  'Deputy Head Girl',
  'Prefect Boy',
  'Prefect Girl',
  'Sports Captain',
  'Sports Vice Captain',
  'Blue House Captain',
  'Blue House Vice Captain',
  'Green House Captain',
  'Green House Vice Captain',
  'Red House Captain',
  'Red House Vice Captain',
  'Yellow House Captain',
  'Yellow House Vice Captain',
];

let allData       = null;
let currentFilter = 'all';
let currentTab    = 'results';
let resultsAccessCode = null;

/* Auth UI */

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

/* Tabs */

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

/* Results tab */

async function loadResults() {
  $('last-updated').textContent = 'Loading...';
  $('results-locked').classList.add('hidden');

  try {
    const headers = {};
    if (resultsAccessCode) headers['x-results-code'] = resultsAccessCode;
    const res = await fetch('/admin/results', { credentials: 'include', headers });
    if (res.status === 401) { showLogin(); return; }
    if (res.status === 403) {
      const data = await res.json().catch(() => ({}));
      if (data.requires_results_code) {
        const code = window.prompt('Enter the second-person results code.');
        if (code) {
          resultsAccessCode = code;
          return loadResults();
        }
      }
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
        `Election ${allData.election.status} (${allData.election.opens_at} to ${allData.election.closes_at})`;
    }
  } catch {
    $('last-updated').textContent = 'Failed to load. Try refreshing.';
  }
}

function renderAll() {
  if (!allData) return;
  const totalVoters = allData.totalVoters ?? allData.totalVotes ?? 0;
  const { totalStudents, gradeStats } = allData;
  const numPositions = allData.numPositions ?? 2;
  const ballotsCast = allData.ballotsCast ?? totalVoters * numPositions;

  $('stat-votes').textContent     = totalVoters;
  $('stat-students').textContent  = totalStudents;
  $('stat-turnout').textContent   = totalStudents ? Math.round((totalVoters / totalStudents) * 100) + '%' : '0%';
  $('stat-ballots').textContent   = ballotsCast;
  $('stat-ballots-note').textContent = `${numPositions} per voter`;
  $('stat-remaining').textContent = totalStudents - totalVoters;

  const gradeMap = {};
  (gradeStats || []).forEach(g => { gradeMap[g.grade] = g.voted; });

  const chips = $('grade-chips');
  chips.replaceChildren();
  for (const g of GRADES) {
    const chip = document.createElement('div');
    chip.className = 'grade-chip';
    const name = document.createElement('div');
    name.className = 'chip-name';
    name.textContent = g;
    const stat = document.createElement('div');
    stat.className = 'chip-stat';
    stat.textContent = `${gradeMap[g] || 0} voted`;
    chip.appendChild(name);
    chip.appendChild(stat);
    chips.appendChild(chip);
  }

  const turnoutEl = $('turnout-text');
  turnoutEl.replaceChildren();
  const strong = document.createElement('strong');
  strong.textContent = totalVoters;
  turnoutEl.appendChild(strong);
  turnoutEl.appendChild(document.createTextNode(` of ${totalStudents} students voted`));

  renderResultPanels();
  renderStudentsTable();
}

function renderResultPanels() {
  if (!allData) return;
  const { results } = allData;
  const grid = $('results-grid');
  grid.replaceChildren();

  const byCategory = new Map();
  for (const r of results) {
    if (!byCategory.has(r.category)) byCategory.set(r.category, []);
    byCategory.get(r.category).push(r);
  }

  const orderedPositions = POSITION_ORDER.filter(p => byCategory.has(p));
  const extras = [...byCategory.keys()].filter(k => !POSITION_ORDER.includes(k));
  const allPositions = [...orderedPositions, ...extras];

  allPositions.forEach((pos, idx) => {
    const panel = document.createElement('div');
    panel.className = 'result-panel';

    const label = document.createElement('div');
    label.className = 'panel-label';
    label.textContent = `Position ${idx + 1}`;

    const title = document.createElement('div');
    title.className = 'panel-title';
    title.textContent = pos;

    const barsContainer = document.createElement('div');
    renderBars(barsContainer, byCategory.get(pos) || []);

    panel.appendChild(label);
    panel.appendChild(title);
    panel.appendChild(barsContainer);
    grid.appendChild(panel);
  });
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
    td.colSpan = 3;
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
    const tdGrade = document.createElement('td');
    tdGrade.textContent = s.grade || '';
    const tdStatus = document.createElement('td');
    const pill = document.createElement('span');
    pill.className = s.has_voted ? 'pill-yes' : 'pill-no';
    pill.textContent = s.has_voted ? 'Voted' : 'Pending';
    tdStatus.appendChild(pill);
    tr.appendChild(tdId);
    tr.appendChild(tdGrade);
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

/* Turnout tab */

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

/* Audit tab */

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
        e.actor || '-',
        e.ip || '-',
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

/* Init */

document.addEventListener('DOMContentLoaded', () => {
  // Try to load - if 401, we'll fall back to login screen.
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
