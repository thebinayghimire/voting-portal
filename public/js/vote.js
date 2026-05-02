// vote.js — student voting page. Uses session cookie. Builds candidate
// cards via DOM API (no innerHTML interpolation) to eliminate XSS surface.

const $ = (id) => document.getElementById(id);

let allCandidates  = [];
let selectedHouse  = null;
let selectedSchool = null;

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

async function init() {
  // Election window check first — friendly message instead of cryptic 401.
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
  } catch (_) { /* ignore — server will reject if needed */ }

  // Fetch candidates. If session is invalid, kicks back to login.
  try {
    const res = await fetch('/candidates', { credentials: 'include' });
    if (res.status === 401 || res.status === 403) {
      window.location.href = 'login.html';
      return;
    }
    const data = await res.json();
    allCandidates = Array.isArray(data) ? data : (data.candidates || []);
  } catch (err) {
    showError('Failed to load candidates. Please refresh the page.');
  }
}

function onGradeChange() {
  const grade = $('grade-select').value;
  selectedHouse  = null;
  selectedSchool = null;
  updateSubmitBtn();

  const houseEl  = $('house-candidates');
  const schoolEl = $('school-candidates');

  if (!grade) {
    houseEl.replaceChildren(emptyState('Select your grade above to see candidates.'));
    schoolEl.replaceChildren(emptyState('Select your grade above to see candidates.'));
    return;
  }

  const graded = allCandidates.filter(c => c.grade === grade);
  renderCandidates(houseEl,  graded.filter(c => c.category === 'House'),  'House');
  renderCandidates(schoolEl, graded.filter(c => c.category === 'School'), 'School');
}

function emptyState(text) {
  const div = document.createElement('div');
  div.className = 'empty-state';
  div.textContent = text;
  return div;
}

function renderCandidates(container, candidates, category) {
  if (!candidates.length) {
    container.replaceChildren(emptyState('No candidates found for this grade.'));
    return;
  }

  const frag = document.createDocumentFragment();
  for (const c of candidates) {
    frag.appendChild(makeCandidateCard(c, category));
  }
  container.replaceChildren(frag);
}

function makeCandidateCard(c, category) {
  // Build everything via DOM — no innerHTML, no template literals
  // interpolating untrusted strings.
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
  img.src = `photos/${c.candidate_id}.jpg`; // safe path — id is admin-controlled

  const initials = document.createElement('div');
  initials.className = 'avatar-initials';
  initials.textContent = getInitials(c.name);
  initials.style.display = 'none';

  // CSP-safe error handler — direct property assignment is allowed.
  img.addEventListener('error', () => {
    img.style.display = 'none';
    initials.style.display = 'flex';
  });

  photoWrap.appendChild(img);
  photoWrap.appendChild(initials);

  const checkBadge = document.createElement('div');
  checkBadge.className = 'check-badge';
  checkBadge.innerHTML = '<svg viewBox="0 0 24 24"><polyline points="20 6 9 17 4 12"/></svg>';
  // ^ static SVG, no user input — safe to use innerHTML here.
  photoWrap.appendChild(checkBadge);

  card.appendChild(photoWrap);

  const info = document.createElement('div');
  info.className = 'candidate-info';
  const nameEl = document.createElement('div');
  nameEl.className = 'candidate-name';
  nameEl.textContent = c.name; // textContent — never innerHTML for user data
  const gradeEl = document.createElement('div');
  gradeEl.className = 'candidate-grade';
  gradeEl.textContent = c.grade;
  info.appendChild(nameEl);
  info.appendChild(gradeEl);
  card.appendChild(info);

  card.addEventListener('click', () => selectCandidate(c.candidate_id, category));
  return card;
}

function selectCandidate(candidateId, category) {
  // Clear previous selection in this category
  document.querySelectorAll(`input[name="${category}"]`).forEach(input => {
    const otherCard = $(`card-${input.value}`);
    if (otherCard) otherCard.classList.remove('selected');
  });
  const card = $(`card-${candidateId}`);
  if (card) card.classList.add('selected');
  const radio = document.querySelector(`input[value="${candidateId}"]`);
  if (radio) radio.checked = true;

  if (category === 'House')  selectedHouse  = candidateId;
  if (category === 'School') selectedSchool = candidateId;
  updateSubmitBtn();
}

function updateSubmitBtn() {
  $('submit-btn').disabled = !(selectedHouse && selectedSchool);
}

async function submitVote() {
  hideError();
  const btn = $('submit-btn');
  btn.disabled = true;
  btn.textContent = 'Submitting…';

  const grade = $('grade-select').value;
  if (!grade) {
    showError('Please select your grade.');
    btn.disabled = false;
    btn.textContent = 'Submit My Vote';
    return;
  }

  try {
    const res = await fetch('/vote', {
      method: 'POST',
      credentials: 'include',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        house_candidate_id:  selectedHouse,
        school_candidate_id: selectedSchool,
        grade,
      }),
    });
    const data = await res.json().catch(() => ({}));
    if (res.ok) {
      $('vote-main').classList.add('hidden');
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
  } catch (err) {
    showError('Could not connect to server. Please try again.');
    btn.disabled = false;
    btn.textContent = 'Submit My Vote';
  }
}

document.addEventListener('DOMContentLoaded', () => {
  init();
  $('grade-select').addEventListener('change', onGradeChange);
  $('submit-btn').addEventListener('click', submitVote);
});
