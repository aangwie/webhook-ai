const $ = (selector) => document.querySelector(selector);
const $$ = (selector) => document.querySelectorAll(selector);

const loginForm = $('#login-form');
const registerForm = $('#register-form');
const alertBox = $('#auth-alert');
const alertText = $('#auth-alert-text');
const title = $('#auth-title');
const subtitle = $('#auth-subtitle');

const ALERT_BASE = 'mb-5 flex items-start gap-2.5 rounded-xl border px-3.5 py-3 text-sm';
const ALERT_STYLES = {
  error: 'border-rose-400/25 bg-rose-500/10 text-rose-200',
  success: 'border-emerald-400/25 bg-emerald-500/10 text-emerald-200',
};

let mode = 'login';

function setMode(next) {
  mode = next;
  hideAlert();

  const isLogin = next === 'login';

  loginForm.classList.toggle('hidden', !isLogin);
  registerForm.classList.toggle('hidden', isLogin);

  $('#tab-login').dataset.active = String(isLogin);
  $('#tab-register').dataset.active = String(!isLogin);

  title.textContent = isLogin ? 'Masuk ke akun Anda' : 'Buat akun gratis';
  subtitle.textContent = isLogin
    ? 'Kelola webhook dan balasan AI dari satu dashboard.'
    : 'Gratis selamanya, tanpa kartu kredit. Langsung pakai setelah daftar.';

  const field = isLogin ? $('#login-email') : $('#register-name');
  setTimeout(() => field?.focus(), 80);
}

function showAlert(type, message) {
  alertText.textContent = message;
  alertBox.className = `${ALERT_BASE} ${ALERT_STYLES[type] ?? ALERT_STYLES.error}`;
}

function hideAlert() {
  alertBox.className = `${ALERT_BASE} hidden`;
}

function setLoading(button, loading, text) {
  const label = button.querySelector('[data-label]');
  const spinner = button.querySelector('[data-spinner]');
  button.disabled = loading;
  spinner?.classList.toggle('hidden', !loading);
  if (label) label.textContent = loading ? 'Memproses…' : text;
}

async function postJson(url, payload) {
  const res = await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(payload),
  });

  let data = {};
  try {
    data = await res.json();
  } catch {
    /* ignore */
  }

  if (!res.ok) throw new Error(data.error || `Permintaan gagal (HTTP ${res.status}).`);
  return data;
}

$$('[data-tab]').forEach((button) => {
  button.addEventListener('click', () => setMode(button.dataset.tab));
});

$$('.toggle-password').forEach((button) => {
  button.addEventListener('click', () => {
    const input = document.getElementById(button.dataset.target);
    if (!input) return;
    const show = input.type === 'password';
    input.type = show ? 'text' : 'password';
    button.setAttribute('aria-label', show ? 'Sembunyikan password' : 'Tampilkan password');
    button.classList.toggle('text-emerald-300', show);
  });
});

loginForm.addEventListener('submit', async (event) => {
  event.preventDefault();
  const button = loginForm.querySelector('[data-submit]');
  const email = $('#login-email').value.trim();
  const password = $('#login-password').value;

  if (!email || !password) {
    showAlert('error', 'Email dan password wajib diisi.');
    return;
  }

  hideAlert();
  setLoading(button, true);
  try {
    await postJson('/api/auth/login', { email, password });
    setLoading(button, false, 'Masuk ke dashboard');
    showAlert('success', 'Berhasil masuk. Mengalihkan ke dashboard…');
    window.location.href = '/dashboard';
  } catch (error) {
    setLoading(button, false, 'Masuk ke dashboard');
    showAlert('error', error.message);
  }
});

registerForm.addEventListener('submit', async (event) => {
  event.preventDefault();
  const button = registerForm.querySelector('[data-submit]');
  const name = $('#register-name').value.trim();
  const email = $('#register-email').value.trim();
  const password = $('#register-password').value;
  const confirm = $('#register-confirm').value;

  if (name.length < 2) return showAlert('error', 'Nama minimal 2 karakter.');
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
    return showAlert('error', 'Format email tidak valid.');
  }
  if (password.length < 6) return showAlert('error', 'Password minimal 6 karakter.');
  if (password !== confirm) return showAlert('error', 'Konfirmasi password tidak cocok.');

  hideAlert();
  setLoading(button, true);
  try {
    await postJson('/api/auth/register', { name, email, password });
    setLoading(button, false, 'Buat akun gratis');
    showAlert('success', 'Akun gratis berhasil dibuat. Mengalihkan…');
    window.location.href = '/dashboard';
  } catch (error) {
    setLoading(button, false, 'Buat akun gratis');
    showAlert('error', error.message);
  }
});

$('#year').textContent = new Date().getFullYear();
