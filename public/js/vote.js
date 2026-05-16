// vote.js - student voting page. Uses session cookie. Builds candidate
// cards via DOM API (no innerHTML interpolation) to eliminate XSS surface.

const $ = (id) => document.getElementById(id);

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

let allCandidates      = [];
let requiredCategories = [];
let selectedVotes      = {};
let assignedGrade      = null;

function showError(msg) {
  const el = $('error-msg');
  el.textContent = msg;
  el.classList.remove('hidden');
}

function hideError() {
  $('error-msg').classList.add('hidden');
}

function showWindowBanner(msg) {
  const el = $('window-banner');
  el.textContent = msg;
  el.classList.remove('hidden');
}

function getInitials(name) {
  return name.split(' ').map(n => n[0]).filter(Boolean).join('').slice(0, 2).toUpperCase();
}

function detectHouse(category) {
  for (const h of ['Blue', 'Green', 'Red', 'Yellow']) {
    if (category.startsWith(h + ' House')) return h;
  }
  return null;
}

async function init() {
  try {
    const statusRes = await fetch('/election/status');
    const status = await statusRes.json();
    if (status.status === 'closed') {
      showWindowBanner('Voting has ended. Your vote will not be accepted.');
      $('submit-btn').disabled = true;
    } else if (status.status === 'pre_open') {
      showWindowBanner('Voting has not started yet.');
      $('submit-btn').disabled = true;
    }
  } catch (_) {}

  try {
    const res = await fetch('/candidates', { credentials: 'include' });
    if (res.status === 401 || res.status === 403) {
      window.location.href = 'login.html';
      return;
    }
    const data = await res.json();
    assignedGrade = data.grade || null;
    allCandidates = Array.isArray(data) ? data : (data.candidates || []);

    if (!assignedGrade) {
      showError('Your account is missing an assigned grade. Please contact your class teacher.');
      $('submit-btn').disabled = true;
      return;
    }

    // Populate student info chips
    const gradeChip = $('grade-chip');
    const houseChip = $('house-chip');
    if (gradeChip) gradeChip.textContent = assignedGrade;
    if (houseChip) {
      if (data.house) {
        houseChip.textContent = data.house + ' House';
        houseChip.dataset.house = data.house;
      } else {
        houseChip.textContent = 'No House';
      }
    }
    const studentInfo = $('student-info');
    if (studentInfo) studentInfo.classList.remove('hidden');

    // Keep hidden select in sync for any legacy compatibility
    const gradeSelect = $('grade-select');
    if (gradeSelect) {
      gradeSelect.value = assignedGrade;
      gradeSelect.disabled = true;
    }

    buildBallot();
  } catch (err) {
    showError('Failed to load candidates. Please refresh the page.');
  }
}

function buildBallot() {
  const container = $('candidates-container');
  container.replaceChildren();

  const byCategory = new Map();
  for (const c of allCandidates) {
    if (!byCategory.has(c.category)) byCategory.set(c.category, []);
    byCategory.get(c.category).push(c);
  }

  const orderedCategories = POSITION_ORDER.filter(p => byCategory.has(p));
  const extras = [...byCategory.keys()].filter(k => !POSITION_ORDER.includes(k));
  requiredCategories = [...orderedCategories, ...extras];

  if (!requiredCategories.length) {
    container.appendChild(emptyState('No candidates found.'));
    updateProgress();
    return;
  }

  const frag = document.createDocumentFragment();

  requiredCategories.forEach((cat, idx) => {
    const section = document.createElement('div');
    section.className = 'vote-section';

    const house = detectHouse(cat);
    if (house) section.dataset.house = house;

    // Section header
    const header = document.createElement('div');
    header.className = 'section-header';

    const label = document.createElement('p');
    label.className = 'section-label';
    label.textContent = `Position ${idx + 1}`;

    const title = document.createElement('h2');
    title.className = 'section-title';
    title.textContent = cat;

    const desc = document.createElement('p');
    desc.className = 'section-desc';
    desc.textContent = `Select one candidate for ${cat}.`;

    header.appendChild(label);
    header.appendChild(title);
    header.appendChild(desc);

    // Section body
    const body = document.createElement('div');
    body.className = 'section-body';

    const grid = document.createElement('div');
    grid.className = 'candidates-grid';
    grid.id = `grid-${idx}`;

    const candidates = byCategory.get(cat) || [];
    if (!candidates.length) {
      grid.appendChild(emptyState('No candidates for this position.'));
    } else {
      const cf = document.createDocumentFragment();
      for (const c of candidates) {
        cf.appendChild(makeCandidateCard(c, cat));
      }
      grid.appendChild(cf);
    }

    body.appendChild(grid);
    section.appendChild(header);
    section.appendChild(body);
    frag.appendChild(section);
  });

  container.appendChild(frag);
  updateProgress();
}

function emptyState(text) {
  const div = document.createElement('div');
  div.className = 'empty-state';
  div.textContent = text;
  return div;
}

function makeCandidateCard(c, category) {
  const card = document.createElement('div');
  card.className = 'candidate-card';
  card.id = `card-${c.candidate_id}`;
  card.dataset.candidateId = c.candidate_id;
  card.dataset.category    = category;

  const radio = document.createElement('input');
  radio.type = 'radio';
  radio.name = category;
  radio.value = c.candidate_id;
  card.appendChild(radio);

  const photoWrap = document.createElement('div');
  photoWrap.className = 'candidate-photo';

  const img = document.createElement('img');
  img.alt = c.name;
  img.src = `photos/${c.candidate_id}.jpg`;

  const initials = document.createElement('div');
  initials.className = 'avatar-initials';
  initials.textContent = getInitials(c.name);
  initials.style.display = 'none';

  img.addEventListener('error', () => {
    img.style.display = 'none';
    initials.style.display = 'flex';
  });

  photoWrap.appendChild(img);
  photoWrap.appendChild(initials);

  const checkBadge = document.createElement('div');
  checkBadge.className = 'check-badge';
  checkBadge.innerHTML = '<svg viewBox="0 0 24 24"><polyline points="20 6 9 17 4 12"/></svg>';
  photoWrap.appendChild(checkBadge);

  card.appendChild(photoWrap);

  const info = document.createElement('div');
  info.className = 'candidate-info';

  const nameEl = document.createElement('div');
  nameEl.className = 'candidate-name';
  nameEl.textContent = c.name;

  const symbolEl = document.createElement('div');
  symbolEl.className = 'candidate-grade';
  symbolEl.textContent = c.symbol ? `Symbol: ${c.symbol}` : '';

  info.appendChild(nameEl);
  info.appendChild(symbolEl);
  card.appendChild(info);

  card.addEventListener('click', () => selectCandidate(c.candidate_id, category));
  return card;
}

function selectCandidate(candidateId, category) {
  document.querySelectorAll(`.candidate-card[data-category="${CSS.escape(category)}"]`).forEach(card => {
    card.classList.remove('selected');
  });
  const card = $(`card-${candidateId}`);
  if (card) card.classList.add('selected');
  const radio = document.querySelector(`input[value="${candidateId}"]`);
  if (radio) radio.checked = true;

  selectedVotes[category] = candidateId;
  updateProgress();
}

function updateProgress() {
  const selected = requiredCategories.filter(cat => selectedVotes[cat]).length;
  const total    = requiredCategories.length;
  const complete = total > 0 && selected === total;
  const pct      = total ? Math.round((selected / total) * 100) : 0;

  const fill = $('progress-fill');
  const text = $('progress-text');

  if (fill) {
    fill.style.width = pct + '%';
    fill.classList.toggle('complete', complete);
  }
  if (text) {
    text.textContent = complete
      ? 'All positions selected. Ready to submit!'
      : total === 0
        ? 'Loading ballot...'
        : `${selected} of ${total} position${total !== 1 ? 's' : ''} selected`;
  }

  $('submit-btn').disabled = !complete;
}

// Legacy alias kept in case anything external calls it
const updateSubmitBtn = updateProgress;

async function submitVote() {
  hideError();
  const btn = $('submit-btn');
  btn.disabled = true;
  btn.textContent = 'Submitting...';

  try {
    const res = await fetch('/vote', {
      method: 'POST',
      credentials: 'include',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ votes: selectedVotes }),
    });
    const data = await res.json().catch(() => ({}));
    if (res.ok) {
      $('vote-main').classList.add('hidden');
      $('ballot-footer').classList.add('hidden');
      $('success-screen').classList.remove('hidden');
      return;
    }
    if (res.status === 401) {
      window.location.href = 'login.html';
      return;
    }
    showError(data.message || 'Something went wrong. Please try again.');
    btn.disabled = false;
    btn.textContent = 'Submit My Vote';
    updateProgress();
  } catch (err) {
    showError('Could not connect to server. Please try again.');
    btn.disabled = false;
    btn.textContent = 'Submit My Vote';
    updateProgress();
  }
}

async function logoutAfterVote() {
  const btn = $('logout-after-vote-btn');
  if (btn) {
    btn.disabled = true;
    btn.textContent = 'Logging out...';
  }

  try {
    await fetch('/logout', {
      method: 'POST',
      credentials: 'include',
    });
  } catch (_) {
    // Redirect anyway so the shared device returns to the login screen.
  }

  window.location.href = 'login.html';
}

document.addEventListener('DOMContentLoaded', () => {
  init();
  $('submit-btn').addEventListener('click', submitVote);
  const logoutBtn = $('logout-after-vote-btn');
  if (logoutBtn) logoutBtn.addEventListener('click', logoutAfterVote);
});
