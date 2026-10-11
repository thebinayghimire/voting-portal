// login.js - student login. Uses session cookie (no localStorage).

const $ = (id) => document.getElementById(id);

function showError(msg) {
  const el = $('error-msg');
  el.textContent = msg;
  el.classList.remove('hidden');
}

function hideError() {
  $('error-msg').classList.add('hidden');
}

function showBanner(msg) {
  const el = $('status-banner');
  el.textContent = msg;
  el.classList.remove('hidden');
}

function setupPasswordToggle() {
  const passwordInput = $('password');
  const toggle = $('password-toggle');
  if (!passwordInput || !toggle) return;

  const eyeIcon = toggle.querySelector('.icon-eye');
  const eyeOffIcon = toggle.querySelector('.icon-eye-off');

  toggle.addEventListener('click', () => {
    const isVisible = passwordInput.type === 'text';
    passwordInput.type = isVisible ? 'password' : 'text';
    toggle.setAttribute('aria-label', isVisible ? 'Show password' : 'Hide password');
    toggle.setAttribute('aria-pressed', String(!isVisible));
    eyeIcon?.classList.toggle('hidden', !isVisible);
    eyeOffIcon?.classList.toggle('hidden', isVisible);
    passwordInput.focus();
  });
}

async function checkElectionStatus() {
  try {
    const res = await fetch('/election/status');
    const data = await res.json();
    const loginBtn = $('login-btn');
    if (data.status === 'pre_open') {
      const opens = new Date(data.opens_at).toLocaleString();
      showBanner(`Voting opens at ${opens}. Please come back then.`);
      loginBtn.disabled = true;
    } else if (data.status === 'closed') {
      const closed = new Date(data.closes_at).toLocaleString();
      showBanner(`Voting ended at ${closed}.`);
      loginBtn.disabled = true;
    }
  } catch (e) {
    // If status check fails, let them try to log in anyway - the server
    // will reject if outside the window.
  }
}

async function handleLogin() {
  hideError();
  const studentId = $('student-id').value.trim();
  const password  = $('password').value;

  if (!studentId || !password) {
    showError('Please enter both your Student ID and password.');
    return;
  }

  $('login-btn').disabled = true;
  try {
    const res = await fetch('/login', {
      method: 'POST',
      credentials: 'include',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ student_id: studentId, password }),
    });
    const data = await res.json().catch(() => ({}));

    if (res.ok) {
      window.location.replace('vote.html');
      return;
    }
    showError(data.message || 'Invalid credentials. Please try again.');
  } catch (err) {
    showError('Could not connect to server. Please try again.');
  } finally {
    $('login-btn').disabled = false;
  }
}

document.addEventListener('DOMContentLoaded', () => {
  setupPasswordToggle();
  checkElectionStatus();
  $('login-btn').addEventListener('click', handleLogin);
  document.addEventListener('keydown', (e) => {
    if (e.target === $('password-toggle')) return;
    if (e.key === 'Enter') handleLogin();
  });
});
