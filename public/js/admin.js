// admin.js - admin dashboard. Cookie sessions, no localStorage.
// Builds tables/rows via DOM (no innerHTML interpolation of user data).

const $ = (id) => document.getElementById(id);

const GRADES = ['Grade 9 CT', 'Grade 9 CE', 'Grade 10 DT 1', 'Grade 10 DT 2', 'Teacher'];

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
let liveData      = null;
let liveInterval  = null;
let currentFilter = 'all';
let currentTab    = 'live';
let resultsAccessCode = null;

/* Auth UI */

function showDashboard() {
  $('login-screen').classList.add('hidden');
  $('dashboard').classList.remove('hidden');
  $('header-badge').classList.remove('hidden');
  $('logout-btn').classList.remove('hidden');
  // Show Start button immediately as default; checkElectionState() will correct if needed
  applyElectionState({ force_started: false, force_ended: false });
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
      checkElectionState();
      liveInterval = setInterval(loadLive, 10000);
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
  if (liveInterval) { clearInterval(liveInterval); liveInterval = null; }
  currentTab = name;
  document.querySelectorAll('.tab-btn').forEach(b => {
    b.classList.toggle('active', b.dataset.tab === name);
  });
  document.querySelectorAll('.tab-pane').forEach(p => p.classList.add('hidden'));
  $(`tab-${name}`).classList.remove('hidden');
  refreshCurrentTab();
  if (name === 'live') liveInterval = setInterval(loadLive, 10000);
}

function refreshCurrentTab() {
  if (currentTab === 'live')    loadLive();
  if (currentTab === 'results') loadResults();
  if (currentTab === 'turnout') loadTurnout();
  if (currentTab === 'audit')   loadAudit();
}

/* Live tab */

async function loadLive() {
  try {
    const res = await fetch('/admin/live', { credentials: 'include' });
    if (res.status === 401) { showLogin(); return; }
    if (!res.ok) {
      const txt = await res.text().catch(() => '');
      $('live-meta-text').textContent = `Error ${res.status}: ${txt.slice(0, 120)}`;
      return;
    }
    liveData = await res.json();
    renderLive();
    const t = new Date().toLocaleTimeString();
    $('live-meta-text').textContent = 'Updated: ' + t;
    $('last-updated').textContent   = 'Live updated: ' + t;
    if (liveData.election) {
      $('election-status').textContent =
        `Election ${liveData.election.status} · ${liveData.election.opens_at} → ${liveData.election.closes_at}`;
    }
  } catch {
    $('live-meta-text').textContent = 'Refresh failed. Retrying…';
  }
}

function renderLive() {
  if (!liveData) return;
  const { totalVoters, totalStudents, gradeStats, results } = liveData;

  $('lv-voted').textContent     = totalVoters;
  $('lv-total').textContent     = totalStudents;
  $('lv-pct').textContent       = totalStudents ? Math.round((totalVoters / totalStudents) * 100) + '%' : '0%';
  $('lv-remaining').textContent = Math.max(0, totalStudents - totalVoters);

  const gradeMap = {};
  (gradeStats || []).forEach(g => { gradeMap[g.grade] = g.voted; });
  const chips = $('lv-grade-chips');
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

  const grid = $('lv-results-grid');
  grid.replaceChildren();

  const byCategory = new Map();
  for (const r of results) {
    if (!byCategory.has(r.category)) byCategory.set(r.category, []);
    byCategory.get(r.category).push(r);
  }

  const ordered = POSITION_ORDER.filter(p => byCategory.has(p));
  const extras  = [...byCategory.keys()].filter(k => !POSITION_ORDER.includes(k));

  [...ordered, ...extras].forEach((pos, idx) => {
    const panel = document.createElement('div');
    panel.className = 'result-panel';

    const label = document.createElement('div');
    label.className = 'panel-label';
    label.textContent = `Position ${idx + 1}`;

    const title = document.createElement('div');
    title.className = 'panel-title';
    title.textContent = pos;

    const bars = document.createElement('div');
    renderBarsLive(bars, byCategory.get(pos) || [], totalVoters);

    panel.appendChild(label);
    panel.appendChild(title);
    panel.appendChild(bars);
    grid.appendChild(panel);
  });
}

function renderBarsLive(container, candidates, totalVoters) {
  const sorted = [...candidates].sort((a, b) => b.votes - a.votes);
  const maxV   = sorted.length ? sorted[0].votes : 0;

  container.replaceChildren();
  if (!sorted.length || sorted.every(c => c.votes === 0)) {
    const empty = document.createElement('div');
    empty.className  = 'no-votes';
    empty.textContent = 'No votes yet.';
    container.appendChild(empty);
    return;
  }

  sorted.forEach((c, i) => {
    const barPct   = maxV > 0 ? Math.round((c.votes / maxV) * 100) : 0;
    const totalPct = totalVoters > 0 ? Math.round((c.votes / totalVoters) * 100) : 0;
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

    const rowRight = document.createElement('div');
    rowRight.className = 'row-right';

    const pctBadge = document.createElement('span');
    pctBadge.className   = 'vote-pct' + (rankClass ? ' ' + rankClass : '');
    pctBadge.textContent = totalPct + '%';

    const rowVotes = document.createElement('div');
    rowVotes.className   = 'row-votes';
    rowVotes.textContent = `${c.votes} vote${c.votes !== 1 ? 's' : ''}`;

    rowRight.appendChild(pctBadge);
    rowRight.appendChild(rowVotes);

    top.appendChild(rowName);
    top.appendChild(rowRight);

    const track = document.createElement('div');
    track.className = 'bar-track';
    const fill = document.createElement('div');
    fill.className  = 'bar-fill' + (rankClass ? ' ' + rankClass : '');
    fill.style.width = barPct + '%';
    track.appendChild(fill);

    row.appendChild(top);
    row.appendChild(track);
    container.appendChild(row);
  });
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

/* End Election */

async function checkElectionState() {
  try {
    const res = await fetch('/admin/election-state', { credentials: 'include' });
    if (!res.ok) {
      // Server missing endpoint or not admin — show Start as safe default
      applyElectionState({ force_started: false, force_ended: false });
      return;
    }
    const data = await res.json();
    applyElectionState(data);
  } catch (_) {
    applyElectionState({ force_started: false, force_ended: false });
  }
}

function applyElectionState(data) {
  const startBtn = $('start-election-btn');
  const endBtn   = $('end-election-btn');
  const endChip  = $('election-ended-chip');
  const statusEl = $('election-status');

  startBtn.classList.add('hidden');
  endBtn.classList.add('hidden');
  endChip.classList.add('hidden');

  if (data.force_ended) {
    endChip.classList.remove('hidden');
    const d = data.ended_at ? new Date(data.ended_at) : null;
    if (d) endChip.title = 'Ended ' + d.toLocaleString();
    if (statusEl) statusEl.textContent = d
      ? `Election ended ${d.toLocaleDateString()} at ${d.toLocaleTimeString()}`
      : 'Election is closed.';
  } else if (data.force_started) {
    endBtn.classList.remove('hidden');
    const d = data.started_at ? new Date(data.started_at) : null;
    if (statusEl) statusEl.textContent = d
      ? `Election OPEN — started ${d.toLocaleTimeString()}`
      : 'Election is open.';
  } else {
    // No admin action yet — always show Start regardless of .env times
    startBtn.classList.remove('hidden');
    if (statusEl) statusEl.textContent = 'Election not yet started — press Start when ready.';
  }
}

async function startElection() {
  const confirmed = window.confirm(
    'START ELECTION NOW?\n\n' +
    'This will open voting for all registered voters.\n' +
    'Make sure credential slips are ready before proceeding.'
  );
  if (!confirmed) return;

  const btn = $('start-election-btn');
  btn.disabled = true;
  btn.textContent = 'Starting…';

  try {
    const res  = await fetch('/admin/start-election', { method: 'POST', credentials: 'include' });
    const data = await res.json();
    if (res.status === 409) {
      alert(data.message);
      await checkElectionState();
      return;
    }
    if (!res.ok) {
      alert('Failed: ' + (data.message || res.status));
      btn.disabled = false;
      btn.innerHTML = '<span class="start-icon">▶</span> Start Election';
      return;
    }
    applyElectionState({ force_started: true, force_ended: false, started_at: data.started_at });
  } catch (err) {
    alert('Network error: ' + err.message);
    btn.disabled = false;
    btn.innerHTML = '<span class="start-icon">▶</span> Start Election';
  }
}

async function endElection() {
  const confirmed = window.confirm(
    'END ELECTION NOW?\n\n' +
    'This will immediately close voting for all users.\n' +
    'Results will be locked as final.\n\n' +
    'This action CANNOT be undone.'
  );
  if (!confirmed) return;

  const btn = $('end-election-btn');
  btn.disabled = true;
  btn.textContent = 'Ending…';

  try {
    const res = await fetch('/admin/end-election', {
      method: 'POST',
      credentials: 'include',
    });
    const data = await res.json();
    if (res.status === 409) {
      alert('Election was already ended.');
      applyElectionState({ force_ended: true, ended_at: data.ended_at });
      return;
    }
    if (!res.ok) {
      alert('Failed to end election: ' + (data.message || res.status));
      btn.disabled = false;
      btn.innerHTML = '<span class="end-icon">⏹</span> End Election';
      return;
    }
    applyElectionState({ force_ended: true, force_started: true, ended_at: data.ended_at });
    showPrintOverlay(data);
  } catch (err) {
    alert('Network error: ' + err.message);
    btn.disabled = false;
    btn.innerHTML = '<span class="end-icon">⏹</span> End Election';
  }
}

function showPrintOverlay(data) {
  const overlay = $('print-overlay');
  const doc     = $('print-document');
  doc.replaceChildren();
  doc.appendChild(buildPrintDoc(data));
  overlay.classList.remove('hidden');
  document.body.style.overflow = 'hidden';
}

function closePrintOverlay() {
  $('print-overlay').classList.add('hidden');
  document.body.style.overflow = '';
}

function buildPrintDoc(data) {
  const { results, gradeStats, totalVoters, totalStudents, ended_at, election } = data;
  const endTime  = ended_at ? new Date(ended_at) : new Date();
  const turnoutPct = totalStudents ? Math.round((totalVoters / totalStudents) * 100) : 0;

  const frag = document.createDocumentFragment();

  // ── Header ──────────────────────────────────────────────────
  const hdr = el('div', 'pr-header');
  hdr.appendChild(img('photos/elitelogo.jpg', 'pr-school-logo'));
  const hdrText = el('div', 'pr-header-text');
  hdrText.appendChild(txt('h1', 'pr-school-name', 'Elite Grand School'));
  hdrText.appendChild(txt('p',  'pr-school-sub',  'Kathmandu, Nepal'));
  hdr.appendChild(hdrText);
  frag.appendChild(hdr);

  frag.appendChild(txt('h2', 'pr-doc-title', 'FINAL ELECTION RESULTS'));
  frag.appendChild(txt('p',  'pr-doc-subtitle', 'School Prefect Election 2082 — Official Record'));

  // ── Meta strip ──────────────────────────────────────────────
  const meta = el('div', 'pr-meta-strip');
  meta.appendChild(metaItem('Election Closed', endTime.toLocaleString()));
  meta.appendChild(metaItem('Total Voters',    `${totalVoters} of ${totalStudents}`));
  meta.appendChild(metaItem('Overall Turnout', `${turnoutPct}%`));
  frag.appendChild(meta);

  frag.appendChild(el('hr', 'pr-divider'));

  // ── Results by position ──────────────────────────────────────
  const byCategory = new Map();
  for (const r of results) {
    if (!byCategory.has(r.category)) byCategory.set(r.category, []);
    byCategory.get(r.category).push(r);
  }
  const ordered = POSITION_ORDER.filter(p => byCategory.has(p));
  const extras  = [...byCategory.keys()].filter(k => !POSITION_ORDER.includes(k));
  const positions = [...ordered, ...extras];

  const posGrid = el('div', 'pr-positions-grid');
  positions.forEach((pos, idx) => {
    const candidates = [...(byCategory.get(pos) || [])].sort((a, b) => b.votes - a.votes);
    const totalPos   = candidates.reduce((s, c) => s + c.votes, 0);
    const winner     = candidates[0];

    const card = el('div', 'pr-pos-card');

    const cardHdr = el('div', 'pr-pos-hdr');
    cardHdr.appendChild(txt('span', 'pr-pos-num', `#${idx + 1}`));
    cardHdr.appendChild(txt('span', 'pr-pos-name', pos));
    card.appendChild(cardHdr);

    if (winner && winner.votes > 0) {
      const winRow = el('div', 'pr-winner-row');
      winRow.appendChild(txt('span', 'pr-crown', '🏆'));
      const winInfo = el('div', 'pr-winner-info');
      winInfo.appendChild(txt('div', 'pr-winner-name', winner.name));
      const winVotes = el('div', 'pr-winner-votes');
      winVotes.appendChild(document.createTextNode(`${winner.votes} vote${winner.votes !== 1 ? 's' : ''}`));
      const pct = totalPos > 0 ? Math.round((winner.votes / totalPos) * 100) : 0;
      winVotes.appendChild(txt('span', 'pr-winner-pct', ` · ${pct}%`));
      winInfo.appendChild(winVotes);
      winRow.appendChild(winInfo);
      card.appendChild(winRow);

      candidates.slice(1).forEach((c) => {
        const cpct = totalPos > 0 ? Math.round((c.votes / totalPos) * 100) : 0;
        const row  = el('div', 'pr-runner-row');
        row.appendChild(txt('span', 'pr-runner-name', c.name));
        row.appendChild(txt('span', 'pr-runner-votes', `${c.votes} (${cpct}%)`));
        card.appendChild(row);
      });
    } else {
      card.appendChild(txt('p', 'pr-no-votes', 'No votes recorded.'));
    }

    posGrid.appendChild(card);
  });
  frag.appendChild(posGrid);

  frag.appendChild(el('hr', 'pr-divider'));

  // ── Section turnout ──────────────────────────────────────────
  frag.appendChild(txt('h3', 'pr-section-title', 'Participation by Section'));
  const gradeMap = {};
  (gradeStats || []).forEach(g => { gradeMap[g.grade] = g.voted; });

  const turnoutGrid = el('div', 'pr-turnout-grid');
  for (const g of GRADES) {
    const voted = gradeMap[g] || 0;
    const row   = el('div', 'pr-turnout-row');
    row.appendChild(txt('span', 'pr-turnout-grade', g));
    row.appendChild(txt('span', 'pr-turnout-count', `${voted} voted`));
    turnoutGrid.appendChild(row);
  }
  frag.appendChild(turnoutGrid);

  frag.appendChild(el('hr', 'pr-divider'));

  // ── Signature block ──────────────────────────────────────────
  frag.appendChild(txt('h3', 'pr-section-title', 'Official Certification'));
  const sigGrid = el('div', 'pr-sig-grid');
  [
    'MD. Dhurba Prasad Pokhrel',
    'Principal. SK Thapaliya',
    'Election Supervisor',
  ].forEach(role => {
    const sig = el('div', 'pr-sig-block');
    sig.appendChild(el('div', 'pr-sig-line'));
    sig.appendChild(txt('div', 'pr-sig-label', role));
    sigGrid.appendChild(sig);
  });
  frag.appendChild(sigGrid);

  // ── Footer ───────────────────────────────────────────────────
  const foot = el('div', 'pr-footer');
  foot.appendChild(txt('span', '', 'Elite Grand School — Confidential Election Record'));
  foot.appendChild(txt('span', '', `Printed: ${new Date().toLocaleString()}`));
  frag.appendChild(foot);

  const wrapper = el('div', '');
  wrapper.appendChild(frag);
  return wrapper;
}

// DOM helpers
function el(tag, cls) {
  const e = document.createElement(tag);
  if (cls) e.className = cls;
  return e;
}
function txt(tag, cls, content) {
  const e = el(tag, cls);
  e.textContent = content;
  return e;
}
function img(src, cls) {
  const e = document.createElement('img');
  e.src = src;
  e.alt = '';
  if (cls) e.className = cls;
  return e;
}
function metaItem(label, value) {
  const wrap = el('div', 'pr-meta-item');
  wrap.appendChild(txt('div', 'pr-meta-label', label));
  wrap.appendChild(txt('div', 'pr-meta-value', value));
  return wrap;
}

/* Init */

document.addEventListener('DOMContentLoaded', () => {
  // Try to load - if 401, we'll fall back to login screen.
  fetch('/admin/turnout', { credentials: 'include' })
    .then(r => {
      if (r.ok) {
        showDashboard();
        refreshCurrentTab();
        checkElectionState();
        liveInterval = setInterval(loadLive, 10000);
      } else {
        showLogin();
      }
    })
    .catch(() => showLogin());

  $('admin-login-btn').addEventListener('click', adminLogin);
  $('logout-btn').addEventListener('click', adminLogout);
  $('refresh-btn').addEventListener('click', refreshCurrentTab);
  $('start-election-btn').addEventListener('click', startElection);
  $('end-election-btn').addEventListener('click', endElection);
  $('do-print-btn').addEventListener('click', () => window.print());
  $('close-print-btn').addEventListener('click', closePrintOverlay);

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
