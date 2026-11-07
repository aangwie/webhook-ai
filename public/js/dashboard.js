/* ==================================================================
   Webhook AI — dashboard client
   ================================================================== */

const $ = (selector) => document.querySelector(selector);
const $$ = (selector) => document.querySelectorAll(selector);

const state = {
  user: null,
  overview: null,
  wa: { status: 'disconnected', phone: null, hasQr: false },
  webhooks: [],
  logs: [],
  ai: null,
  users: [],
  userStats: null,
  system: null,
  termTimer: null,
  page: 'overview',
  polling: false,
  qrLoading: false,
};

const PAGES = {
  overview: { title: 'Ringkasan', subtitle: 'Pantau status dan aktivitas otomasi Anda.' },
  whatsapp: { title: 'WhatsApp', subtitle: 'Tautkan nomor dan kelola koneksi Baileys.' },
  webhooks: { title: 'Webhook', subtitle: 'Teruskan pesan masuk ke endpoint Anda.' },
  ai: { title: 'AI Balasan', subtitle: 'Konfigurasikan model dan balasan otomatis.' },
  logs: { title: 'Aktivitas', subtitle: 'Riwayat pesan, webhook, dan balasan AI.' },
  users: { title: 'User', subtitle: 'Kelola profil Anda dan akun pengguna aplikasi.' },
  settings: { title: 'Pengaturan', subtitle: 'Preferensi aplikasi, pembaruan, dan pemeliharaan.' },
  docs: { title: 'Dokumentasi', subtitle: 'Cara menjalankan aplikasi di lokal dan hosting.' },
};

const STATUS_META = {
  connected: {
    label: 'Terhubung',
    dot: 'bg-emerald-400',
    pill: 'border-emerald-400/20 bg-emerald-400/10 text-emerald-300',
  },
  qr: {
    label: 'Scan QR',
    dot: 'bg-amber-400',
    pill: 'border-amber-400/20 bg-amber-400/10 text-amber-300',
  },
  connecting: {
    label: 'Menghubungkan',
    dot: 'bg-sky-400',
    pill: 'border-sky-400/20 bg-sky-400/10 text-sky-300',
  },
  disconnected: {
    label: 'Terputus',
    dot: 'bg-slate-500',
    pill: 'border-slate-700/60 bg-slate-800/60 text-slate-400',
  },
};

/* ------------------------------------------------------------------ */
/* Utils                                                               */
/* ------------------------------------------------------------------ */

function escapeHtml(value) {
  return String(value ?? '')
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
    .replaceAll("'", '&#039;');
}

function initials(name) {
  const parts = String(name || 'AI').trim().split(/\s+/);
  return ((parts[0]?.[0] ?? 'A') + (parts[1]?.[0] ?? 'I')).toUpperCase();
}

function phoneLabel(phone) {
  if (!phone) return 'Belum tertaut';
  return `+${String(phone).replace(/^\+/, '')}`;
}

function formatTime(value, withDate = true) {
  if (!value) return '';
  const date = new Date(String(value).replace(' ', 'T') + 'Z');
  if (Number.isNaN(date.getTime())) return String(value);
  return date.toLocaleString('id-ID', {
    ...(withDate ? { day: '2-digit', month: 'short' } : {}),
    hour: '2-digit',
    minute: '2-digit',
  });
}

function formatDate(value) {
  if (!value) return '—';
  const date = new Date(String(value).replace(' ', 'T') + 'Z');
  if (Number.isNaN(date.getTime())) return String(value);
  return date.toLocaleDateString('id-ID', { day: '2-digit', month: 'long', year: 'numeric' });
}

function maskFrom(jid) {
  if (!jid) return '';
  return String(jid).replace('@s.whatsapp.net', '').replace('@g.us', '');
}

async function api(path, options = {}) {
  const res = await fetch(path, {
    headers: { 'Content-Type': 'application/json', ...(options.headers || {}) },
    ...options,
  });

  if (res.status === 401) {
    window.location.href = '/login';
    throw new Error('Sesi berakhir.');
  }

  let data = {};
  try {
    data = await res.json();
  } catch {
    /* ignore */
  }

  if (!res.ok) throw new Error(data.error || `Permintaan gagal (HTTP ${res.status}).`);
  return data;
}

/* ------------------------------------------------------------------ */
/* SweetAlert2 (khusus mode desktop)                                   */
/* ------------------------------------------------------------------ */

const SWAL_THEME = {
  background: '#0f172a',
  color: '#e2e8f0',
  confirmButtonColor: '#10b981',
  cancelButtonColor: '#475569',
};

const swalToast = window.Swal?.mixin({
  ...SWAL_THEME,
  toast: true,
  position: 'top-end',
  showConfirmButton: false,
  timer: 4200,
  timerProgressBar: true,
});

/** SweetAlert2 hanya dipakai di layar desktop; mobile tetap memakai toast/confirm bawaan. */
const useSwal = () => DESKTOP_QUERY.matches && Boolean(swalToast);

async function confirmDialog(message, { title = 'Konfirmasi', confirmText = 'Ya, lanjutkan' } = {}) {
  if (!useSwal()) return window.confirm(message);

  const { isConfirmed } = await window.Swal.fire({
    ...SWAL_THEME,
    title,
    text: message,
    icon: 'warning',
    showCancelButton: true,
    confirmButtonText: confirmText,
    cancelButtonText: 'Batal',
    reverseButtons: true,
    focusCancel: true,
  });

  return isConfirmed;
}

function toast(message, type = 'info') {
  if (useSwal()) {
    swalToast.fire({ icon: type, title: message });
    return;
  }

  const styles = {
    success: 'border-emerald-400/30 bg-emerald-500/15 text-emerald-200',
    error: 'border-rose-400/30 bg-rose-500/15 text-rose-200',
    info: 'border-white/10 bg-slate-800/90 text-slate-200',
  };
  const el = document.createElement('div');
  el.className = `animate-fade-up pointer-events-auto flex items-start gap-2.5 rounded-xl border px-4 py-3 text-sm shadow-xl shadow-black/30 backdrop-blur ${styles[type] ?? styles.info}`;
  el.innerHTML = `<span class="mt-0.5 h-2 w-2 shrink-0 rounded-full ${type === 'error' ? 'bg-rose-400' : type === 'success' ? 'bg-emerald-400' : 'bg-sky-400'}"></span><span class="min-w-0 break-words">${escapeHtml(message)}</span>`;
  $('#toast-container').appendChild(el);
  setTimeout(() => {
    el.style.transition = 'opacity .25s, transform .25s';
    el.style.opacity = '0';
    el.style.transform = 'translateY(8px)';
    setTimeout(() => el.remove(), 260);
  }, 4200);
}

async function copyText(text) {
  try {
    await navigator.clipboard.writeText(text);
    toast('Disalin ke clipboard.', 'success');
    return;
  } catch {
    /* lanjut ke fallback */
  }

  try {
    const area = document.createElement('textarea');
    area.value = text;
    area.setAttribute('readonly', '');
    area.style.position = 'fixed';
    area.style.top = '-1000px';
    area.style.opacity = '0';
    document.body.appendChild(area);
    area.select();
    const copied = document.execCommand('copy');
    area.remove();
    if (!copied) throw new Error('copy failed');
    toast('Disalin ke clipboard.', 'success');
  } catch {
    toast('Browser memblokir clipboard. Salin manual dari teks.', 'error');
  }
}

/* ------------------------------------------------------------------ */
/* Navigation                                                          */
/* ------------------------------------------------------------------ */

/* ------------------------------------------------------------------ */
/* Sidebar                                                             */
/* ------------------------------------------------------------------ */

const DESKTOP_QUERY = window.matchMedia('(min-width: 1024px)');
let sidebarOpen = DESKTOP_QUERY.matches;
let wasDesktop = DESKTOP_QUERY.matches;

function applySidebar() {
  const desktop = DESKTOP_QUERY.matches;

  $('#sidebar').style.transform = sidebarOpen ? 'translateX(0)' : 'translateX(-100%)';
  $('#main-content').style.paddingLeft = desktop && sidebarOpen ? '18rem' : '0px';
  $('#sidebar-overlay').classList.toggle('hidden', desktop || !sidebarOpen);
  document.body.classList.toggle('overflow-hidden', !desktop && sidebarOpen);
  $('#sidebar-open').setAttribute('aria-expanded', String(sidebarOpen));
}

function openSidebar() {
  sidebarOpen = true;
  applySidebar();
}

function closeSidebar() {
  sidebarOpen = false;
  applySidebar();
}

function toggleSidebar() {
  sidebarOpen = !sidebarOpen;
  applySidebar();
}

function closeSidebarOnMobile() {
  if (!DESKTOP_QUERY.matches) closeSidebar();
}

function initSidebar() {
  sidebarOpen = DESKTOP_QUERY.matches;
  wasDesktop = DESKTOP_QUERY.matches;
  applySidebar();

  DESKTOP_QUERY.addEventListener('change', (event) => {
    if (event.matches === wasDesktop) return;
    wasDesktop = event.matches;
    sidebarOpen = event.matches;
    applySidebar();
  });
}

function switchPage(page, { updateHash = true } = {}) {
  if (!PAGES[page]) return;
  state.page = page;

  if (updateHash && window.location.hash.slice(1) !== page) {
    window.history.replaceState(null, '', `#${page}`);
  }

  $$('[data-page]').forEach((section) => {
    section.classList.toggle('hidden', section.dataset.page !== page);
  });

  $$('[data-nav]').forEach((button) => {
    button.dataset.active = String(button.dataset.nav === page);
  });

  $('#page-title').textContent = PAGES[page].title;
  $('#page-subtitle').textContent = PAGES[page].subtitle;

  closeSidebarOnMobile();

  if (page === 'logs') loadLogs().catch((err) => toast(err.message, 'error'));
  if (page === 'webhooks') loadWebhooks().catch((err) => toast(err.message, 'error'));
  if (page === 'ai') loadAi().catch((err) => toast(err.message, 'error'));
  if (page === 'users') loadUsers().catch((err) => toast(err.message, 'error'));
  if (page === 'settings') {
    renderSettings();
    if (isAdmin()) {
      loadSystem().catch((err) => toast(err.message, 'error'));
      startTermPoll();
    }
  } else {
    stopTermPoll();
  }
  if (page === 'whatsapp') refreshWa().catch(() => {});
  if (page === 'overview') refreshOverview().catch(() => {});
}

/* ------------------------------------------------------------------ */
/* WhatsApp status + QR                                                */
/* ------------------------------------------------------------------ */

function renderWaStatus() {
  const meta = STATUS_META[state.wa.status] ?? STATUS_META.disconnected;
  const phone = phoneLabel(state.wa.phone);

  $('#top-status').className = `chip border ${meta.pill}`;
  $('#top-status').innerHTML = `<span class="h-1.5 w-1.5 rounded-full ${meta.dot}"></span>${meta.label}`;

  $('#side-wa-dot').className = `h-2 w-2 rounded-full ${meta.dot}`;
  $('#side-wa-label').textContent = meta.label;
  $('#side-wa-phone').textContent = state.wa.phone ? phone : 'Belum tertaut';

  $('#nav-wa-dot').className = `ml-auto h-2 w-2 rounded-full ${meta.dot}`;

  $('#wa-status-pill').className = `chip border ${meta.pill}`;
  $('#wa-status-pill').innerHTML = `<span class="h-1.5 w-1.5 rounded-full ${meta.dot}"></span>${meta.label}`;

  $('#wa-phone').textContent = state.wa.phone ? phone : 'Belum terhubung';

  const texts = {
    connected: 'Terhubung dan siap menerima pesan.',
    qr: 'Menunggu scan QR dari ponsel Anda.',
    connecting: 'Sedang menyambungkan sesi WhatsApp…',
    disconnected: 'Belum terhubung. Tekan tombol di bawah.',
  };
  $('#wa-status-text').textContent = texts[state.wa.status] ?? texts.disconnected;

  const avatarBg = state.wa.status === 'connected' ? 'bg-emerald-400/15 text-emerald-300' : 'bg-white/5 text-slate-400';
  $('#wa-avatar').className = `grid h-11 w-11 place-items-center rounded-full ${avatarBg}`;

  $('#wa-connect').disabled = state.wa.status === 'connecting';
  $('#wa-logout').disabled = state.wa.status === 'disconnected';

  renderQrState();
}

function renderQrState() {
  const img = $('#wa-qr');
  const placeholder = $('#wa-qr-placeholder');
  const badge = $('#qr-badge');

  const showQr = state.wa.status === 'qr' && Boolean(state.qrData);
  img.classList.toggle('hidden', !showQr);

  if (showQr) {
    img.src = state.qrData;
    placeholder.classList.add('hidden');
    badge.className = 'chip border border-amber-400/20 bg-amber-400/10 text-amber-300';
    badge.textContent = 'Scan sekarang';
    return;
  }

  placeholder.classList.remove('hidden');
  const title = placeholder.querySelector('p');
  const desc = placeholder.querySelectorAll('p')[1];
  let headline = 'QR belum tersedia';
  let detail = 'Tekan "Hubungkan / QR" lalu tunggu beberapa detik.';

  if (state.wa.status === 'connected') {
    headline = 'WhatsApp terhubung';
    detail = 'Perangkat Anda sudah tertaut. Tidak perlu scan QR.';
    badge.className = 'chip border border-emerald-400/20 bg-emerald-400/10 text-emerald-300';
    badge.textContent = 'Connected';
  } else if (state.wa.status === 'connecting') {
    headline = 'Menyiapkan sesi…';
    detail = 'Menghubungkan ke server WhatsApp, mohon tunggu.';
    badge.className = 'chip border border-sky-400/20 bg-sky-400/10 text-sky-300';
    badge.textContent = 'Menyambung';
  } else if (state.wa.status === 'qr') {
    headline = 'Memuat QR…';
    detail = 'QR code sedang dibuat, tunggu sebentar.';
    badge.className = 'chip border border-white/10 bg-white/5 text-slate-400';
    badge.textContent = 'Memuat';
  } else {
    badge.className = 'chip border border-white/10 bg-white/5 text-slate-400';
    badge.textContent = 'Menunggu';
  }

  if (title) title.textContent = headline;
  if (desc) desc.textContent = detail;
}

async function refreshWa({ withQr = true } = {}) {
  const status = await api('/api/wa/status');
  state.wa = status;

  if (withQr && status.status === 'qr' && !state.qrLoading) {
    state.qrLoading = true;
    try {
      const qr = await api('/api/wa/qr');
      state.qrData = qr.qr;
      state.wa = qr;
    } catch {
      state.qrData = null;
    } finally {
      state.qrLoading = false;
    }
  }

  if (status.status !== 'qr') state.qrData = null;
  renderWaStatus();
}

async function pollWa() {
  if (state.polling) return;
  state.polling = true;
  try {
    await refreshWa();
    if (state.wa.status === 'connected' && state.ai?.enabled) {
      /* keep overview fresh while connected */
    }
  } catch {
    /* silent poll */
  } finally {
    state.polling = false;
  }
}

/* ------------------------------------------------------------------ */
/* Overview                                                            */
/* ------------------------------------------------------------------ */

async function refreshOverview() {
  state.overview = await api('/api/overview');
  renderOverview();
}

function renderOverview() {
  const data = state.overview;
  if (!data) return;

  const meta = STATUS_META[data.whatsapp?.status] ?? STATUS_META.disconnected;

  $('#overview-name').textContent = state.user?.name?.split(' ')[0] ?? 'there';

  const hints = {
    connected: 'WhatsApp terhubung. Pesan masuk otomatis diteruskan ke webhook Anda.',
    qr: 'Scan QR yang tampil di menu WhatsApp untuk menautkan perangkat.',
    connecting: 'Sesi WhatsApp sedang disiapkan. Tunggu beberapa saat.',
    disconnected: 'Hubungkan WhatsApp untuk mulai meneruskan pesan ke webhook dan membalas dengan AI.',
  };
  $('#overview-hint').textContent = hints[data.whatsapp?.status] ?? hints.disconnected;

  $('#stat-wa').textContent = meta.label;
  $('#stat-wa-sub').textContent = data.whatsapp?.phone ? phoneLabel(data.whatsapp.phone) : 'Belum tertaut';

  $('#stat-hooks').textContent = String(data.webhooks?.active ?? 0);
  $('#stat-hooks-sub').textContent = `${data.webhooks?.total ?? 0} total · ${data.webhooks?.active ?? 0} aktif`;

  $('#stat-logs').textContent = String(data.messages ?? 0);

  $('#stat-ai').textContent = data.ai?.enabled ? 'Aktif' : 'Nonaktif';
  $('#stat-ai-sub').textContent = data.ai?.enabled ? data.ai?.model || 'Model belum dipilih' : 'Belum diaktifkan';

  const navBadge = $('#nav-ai-badge');
  navBadge.classList.toggle('hidden', !data.ai?.enabled);
}

/* ------------------------------------------------------------------ */
/* Logs                                                                */
/* ------------------------------------------------------------------ */

const LOG_META = {
  message: {
    label: 'Pesan masuk',
    icon: '<path d="M21 15a2 2 0 0 1-2 2H7l-4 4V5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2z" />',
    color: 'bg-emerald-400/10 text-emerald-300',
  },
  ai: {
    label: 'Balasan AI',
    icon: '<path d="m12 3 1.9 5.8a2 2 0 0 0 1.3 1.3L21 12l-5.8 1.9a2 2 0 0 0-1.3 1.3L12 21l-1.9-5.8a2 2 0 0 0-1.3-1.3L3 12l5.8-1.9a2 2 0 0 0 1.3-1.3L12 3Z" />',
    color: 'bg-violet-400/10 text-violet-300',
  },
  webhook: {
    label: 'Webhook',
    icon: '<path d="M18 16.98h-5.99c-1.1 0-1.95.94-2.48 1.9A4 4 0 0 1 2 17c.01-.7.2-1.4.57-2" /><path d="m6 17 3.13-5.78c.53-.97.1-2.18-.5-3.1a4 4 0 1 1 6.89-4.06" /><path d="m12 6 3.13 5.73C15.66 12.7 16.9 13 18 13a4 4 0 0 1 0 8" />',
    color: 'bg-cyan-400/10 text-cyan-300',
  },
  system: {
    label: 'Sistem',
    icon: '<path d="m4 17 6-6-6-6M12 19h8" />',
    color: 'bg-slate-400/10 text-slate-300',
  },
};

function renderLogItem(log) {
  const meta = LOG_META[log.type] ?? LOG_META.system;
  let metaInfo = '';
  try {
    const extra = log.meta ? JSON.parse(log.meta) : null;
    if (extra?.pushName || extra?.from) {
      metaInfo = [extra.pushName, maskFrom(extra.from)].filter(Boolean).join(' · ');
    } else if (extra?.model) {
      metaInfo = extra.model;
    }
  } catch {
    /* ignore */
  }

  const statusChip =
    log.status === 'error'
      ? '<span class="chip bg-rose-500/10 text-rose-300">gagal</span>'
      : log.status === 'warn'
        ? '<span class="chip bg-amber-500/10 text-amber-300">peringatan</span>'
        : '';

  return `
    <div class="flex items-start gap-3 rounded-xl border border-white/5 bg-white/[0.02] p-3.5">
      <span class="mt-0.5 grid h-8 w-8 shrink-0 place-items-center rounded-lg ${meta.color}">
        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round" class="h-4 w-4">${meta.icon}</svg>
      </span>
      <div class="min-w-0 flex-1">
        <div class="flex flex-wrap items-center gap-x-2 gap-y-1">
          <span class="text-[10px] font-semibold uppercase tracking-wider text-slate-400">${meta.label}</span>
          <span class="text-[10px] text-slate-600">•</span>
          <span class="text-[10px] text-slate-500">${escapeHtml(formatTime(log.created_at))}</span>
          ${statusChip}
        </div>
        <p class="mt-1 whitespace-pre-wrap break-words text-xs leading-relaxed text-slate-300">${escapeHtml(log.message)}</p>
        ${metaInfo ? `<p class="mt-1 truncate text-[10px] text-slate-600">${escapeHtml(metaInfo)}</p>` : ''}
      </div>
    </div>
  `;
}

function emptyLogs(text = 'Belum ada aktivitas.') {
  return `<div class="rounded-xl border border-dashed border-white/10 bg-white/[0.01] p-6 text-center text-xs text-slate-500">${escapeHtml(text)}</div>`;
}

async function loadLogs() {
  const data = await api('/api/logs?limit=80');
  state.logs = data.logs ?? [];
  $('#log-count').textContent = `${state.logs.length} entri`;
  $('#log-list').innerHTML = state.logs.length
    ? state.logs.map(renderLogItem).join('')
    : emptyLogs('Belum ada aktivitas yang tercatat.');

  const recent = state.logs.slice(0, 5);
  $('#overview-logs').innerHTML = recent.length
    ? recent.map(renderLogItem).join('')
    : emptyLogs('Aktivitas akan muncul di sini setelah WhatsApp terhubung.');
}

/* ------------------------------------------------------------------ */
/* Webhooks                                                            */
/* ------------------------------------------------------------------ */

function renderWebhooks() {
  $('#hook-count').textContent = String(state.webhooks.length);
  const list = $('#hook-list');

  if (!state.webhooks.length) {
    list.innerHTML = `
      <div class="rounded-xl border border-dashed border-white/10 bg-white/[0.01] p-8 text-center">
        <p class="text-sm font-medium text-slate-300">Belum ada webhook</p>
        <p class="mt-1 text-xs text-slate-500">Tambahkan URL endpoint pertama Anda di form atas.</p>
      </div>`;
    return;
  }

  list.innerHTML = state.webhooks
    .map(
      (hook) => `
      <div class="rounded-xl border border-white/10 bg-slate-950/40 p-4">
        <div class="flex flex-wrap items-start justify-between gap-3">
          <div class="min-w-0">
            <div class="flex flex-wrap items-center gap-2">
              <p class="truncate text-sm font-semibold text-white">${escapeHtml(hook.name)}</p>
              <span class="chip ${hook.active ? 'border border-emerald-400/20 bg-emerald-400/10 text-emerald-300' : 'border border-white/10 bg-white/5 text-slate-400'}">
                ${hook.active ? 'Aktif' : 'Nonaktif'}
              </span>
            </div>
            <p class="mt-1 truncate font-mono text-[11px] text-slate-500" title="${escapeHtml(hook.url)}">${escapeHtml(hook.url)}</p>
          </div>
          <div class="flex flex-wrap items-center gap-2">
            <button type="button" data-action="test" data-id="${hook.id}" class="btn-ghost px-3 py-1.5 text-xs">
              <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" class="h-3.5 w-3.5"><path d="M22 2 11 13M22 2l-7 20-4-9-9-4 20-7z" /></svg>
              Tes
            </button>
            <button type="button" data-action="toggle" data-id="${hook.id}" class="btn-ghost px-3 py-1.5 text-xs">
              ${hook.active ? 'Nonaktifkan' : 'Aktifkan'}
            </button>
            <button type="button" data-action="delete" data-id="${hook.id}" class="grid h-8 w-8 place-items-center rounded-lg border border-rose-400/10 bg-rose-500/5 text-rose-300 transition hover:bg-rose-500/15" title="Hapus" aria-label="Hapus webhook">
              <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" class="h-4 w-4"><path d="M3 6h18M8 6V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2M19 6l-1 14a2 2 0 0 1-2 2H8a2 2 0 0 1-2-2L5 6M10 11v6M14 11v6" /></svg>
            </button>
          </div>
        </div>
        <details class="group mt-3">
          <summary class="flex cursor-pointer list-none items-center gap-1.5 text-[11px] text-slate-500 transition hover:text-slate-300">
            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" class="h-3 w-3 transition group-open:rotate-90"><path d="m9 18 6-6-6-6" /></svg>
            Secret & signature
          </summary>
          <div class="mt-2 flex items-center gap-2 rounded-lg border border-white/5 bg-black/30 p-2">
            <code class="min-w-0 flex-1 truncate text-[10px] text-slate-400">${escapeHtml(hook.secret)}</code>
            <button type="button" data-action="copy" data-copy="${escapeHtml(hook.secret)}" class="shrink-0 rounded-md border border-white/10 bg-white/5 px-2 py-1 text-[10px] font-medium text-slate-300 transition hover:bg-white/10">
              Salin
            </button>
          </div>
        </details>
      </div>`
    )
    .join('');
}

async function loadWebhooks() {
  const data = await api('/api/webhooks');
  state.webhooks = data.webhooks ?? [];
  renderWebhooks();
}

/* ------------------------------------------------------------------ */
/* AI                                                                  */
/* ------------------------------------------------------------------ */

function renderAi() {
  const ai = state.ai;
  if (!ai) return;

  $('#ai-enabled').checked = Boolean(ai.enabled);
  $('#ai-style').value = ai.api_style === 'ollama' ? 'ollama' : 'openai';
  $('#ai-base').value = ai.base_url ?? '';
  $('#ai-model').value = ai.model ?? '';
  $('#ai-prompt').value = ai.system_prompt ?? '';
  $('#ai-key').value = '';
  $('#ai-key').placeholder = ai.has_key ? `Tersimpan (${ai.key_hint}) — isi untuk mengganti` : 'sk-...';
  $('#ai-key-hint').textContent = ai.has_key ? `Tersimpan ${ai.key_hint}` : 'Belum disimpan';

  syncAiStyleHints();

  $('#nav-ai-badge').classList.toggle('hidden', !ai.enabled);

  const enabled = Boolean(ai.enabled);
  $('#stat-ai').textContent = enabled ? 'Aktif' : 'Nonaktif';
  $('#stat-ai-sub').textContent = enabled ? ai.model || 'Model belum dipilih' : 'Belum diaktifkan';
}

const AI_STYLE_META = {
  ollama: {
    base: 'https://ollama.com',
    model: 'gemma4:31b',
    hint: 'Contoh Ollama: gemma4:31b',
  },
  openai: {
    base: 'https://api.openai.com/v1',
    model: 'gpt-4o-mini',
    hint: 'Contoh OpenAI: gpt-4o-mini',
  },
};

function currentAiStyle() {
  return $('#ai-style').value === 'ollama' ? 'ollama' : 'openai';
}

function syncAiStyleHints() {
  const meta = AI_STYLE_META[currentAiStyle()];
  $('#ai-model-hint').textContent = meta.hint;
  $('#ai-model').placeholder = meta.model;
}
async function loadAi() {
  state.ai = await api('/api/ai');
  renderAi();
}

/* ------------------------------------------------------------------ */
/* Users & settings                                                    */
/* ------------------------------------------------------------------ */

const ROLE_META = {
  admin: {
    label: 'Admin',
    chip: 'border border-emerald-400/20 bg-emerald-400/10 text-emerald-300',
  },
  user: {
    label: 'User',
    chip: 'border border-cyan-400/20 bg-cyan-400/10 text-cyan-300',
  },
};

function isAdmin() {
  return state.user?.role === 'admin';
}

function renderSettings() {
  const user = state.user;
  if (!user) return;

  $('#settings-name').textContent = user.name;
  $('#settings-email').textContent = user.email;
  $('#settings-role').textContent = user.role === 'admin' ? 'Admin' : 'User';
  $('#settings-created').textContent = formatDate(user.created_at);
}

/* ------------------------------------------------------------------ */
/* Pengaturan sistem (admin): update GitHub, migrasi, cache, terminal  */
/* ------------------------------------------------------------------ */

async function loadSystem() {
  state.system = await api('/api/system');
  renderSystem();
  await loadTerminal();
}

function renderSystem() {
  const system = state.system;
  if (!system) return;

  $('#gh-token-hint').textContent = system.has_token
    ? `Tersimpan ${system.token_hint}`
    : 'Belum disimpan';

  const repo = system.repo ?? {};
  $('#gh-repo').textContent = repo.git
    ? `${repo.remote} · ${repo.branch}`
    : `Belum terhubung — klik Update sekarang untuk menyiapkan otomatis dari ${repo.remote}`;
}

async function loadTerminal() {
  if (!isAdmin()) return;

  const data = await api('/api/system/log');
  const term = $('#sys-term');
  const text = (data.log || '').trim();

  term.textContent = text || 'Belum ada log.';
  term.scrollTop = term.scrollHeight;
}

function startTermPoll() {
  if (!isAdmin() || state.termTimer) return;
  state.termTimer = setInterval(() => loadTerminal().catch(() => {}), 2500);
}

function stopTermPoll() {
  if (!state.termTimer) return;
  clearInterval(state.termTimer);
  state.termTimer = null;
}

function applyUserIdentity() {
  const user = state.user;
  if (!user) return;

  const admin = user.role === 'admin';
  const roleLabel = admin ? 'Admin' : 'User';
  const avatar = initials(user.name);

  $('#user-name').textContent = user.name;
  $('#user-email').textContent = user.email;
  $('#user-avatar').textContent = avatar;
  $('#top-avatar').textContent = avatar;

  const badge = $('#user-role-badge');
  if (badge) {
    badge.textContent = roleLabel;
    badge.className = `shrink-0 rounded px-1.5 py-0.5 text-[9px] font-bold uppercase tracking-wide ${
      admin ? 'bg-emerald-400/15 text-emerald-300' : 'bg-cyan-400/15 text-cyan-300'
    }`;
  }

  $('#nav-user-badge')?.classList.toggle('hidden', !admin);
  $('#users-admin-card')?.classList.toggle('hidden', !admin);
  $('#settings-system')?.classList.toggle('hidden', !admin);
  $('#settings-terminal')?.classList.toggle('hidden', !admin);

  const profileRole = $('#profile-role');
  if (profileRole) {
    profileRole.textContent = roleLabel;
    profileRole.className = `chip ${ROLE_META[user.role]?.chip ?? ROLE_META.user.chip}`;
  }

  $('#profile-name').value = user.name;
  $('#profile-email').value = user.email;
  $('#profile-created').textContent = formatDate(user.created_at);

  renderSettings();
}

function renderUsers() {
  if (!isAdmin()) return;

  const stats = state.userStats ?? { total: state.users.length, admins: 0 };
  const total = Number(stats.total) || 0;
  const admins = Number(stats.admins) || 0;

  $('#users-total').textContent = String(total);
  $('#users-admins').textContent = String(admins);
  $('#users-regular').textContent = String(Math.max(total - admins, 0));

  const list = $('#user-list');
  if (!state.users.length) {
    list.innerHTML = `
      <div class="rounded-xl border border-dashed border-white/10 bg-white/[0.01] p-8 text-center">
        <p class="text-sm font-medium text-slate-300">Belum ada pengguna</p>
        <p class="mt-1 text-xs text-slate-500">Tambahkan akun pertama dengan tombol “Tambah user”.</p>
      </div>`;
    return;
  }

  list.innerHTML = state.users
    .map((user) => {
      const role = ROLE_META[user.role] ?? ROLE_META.user;
      const self = Number(user.id) === Number(state.user.id);

      return `
      <div class="flex flex-wrap items-center gap-3 rounded-xl border border-white/10 bg-slate-950/40 p-3.5">
        <span class="grid h-10 w-10 shrink-0 place-items-center rounded-full bg-gradient-to-br from-emerald-400/25 to-cyan-400/25 text-xs font-bold text-emerald-200">
          ${escapeHtml(initials(user.name))}
        </span>

        <div class="min-w-0 flex-1">
          <div class="flex flex-wrap items-center gap-2">
            <p class="truncate text-sm font-semibold text-white">${escapeHtml(user.name)}</p>
            <span class="chip ${role.chip}">${role.label}</span>
            ${self ? '<span class="chip border border-white/10 bg-white/5 text-slate-400">Anda</span>' : ''}
          </div>
          <p class="mt-0.5 truncate text-[11px] text-slate-500" title="${escapeHtml(user.email)}">${escapeHtml(user.email)}</p>
          <p class="mt-1 text-[10px] text-slate-600">
            Terdaftar ${escapeHtml(formatDate(user.created_at))} ·
            ${Number(user.webhooks) || 0} webhook · ${Number(user.logs) || 0} aktivitas
          </p>
        </div>

        <div class="flex items-center gap-2">
          <button type="button" data-user-action="edit" data-id="${user.id}" class="btn-ghost px-3 py-1.5 text-xs">
            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" class="h-3.5 w-3.5" aria-hidden="true">
              <path d="M12 20h9" /><path d="M16.5 3.5a2.12 2.12 0 0 1 3 3L7 19l-4 1 1-4Z" />
            </svg>
            Edit
          </button>
          <button
            type="button"
            data-user-action="delete"
            data-id="${user.id}"
            class="grid h-8 w-8 place-items-center rounded-lg border border-rose-400/10 bg-rose-500/5 text-rose-300 transition hover:bg-rose-500/15 disabled:cursor-not-allowed disabled:opacity-30"
            ${self ? 'disabled title="Tidak dapat menghapus akun sendiri"' : 'title="Hapus user" aria-label="Hapus user"'}
          >
            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" class="h-4 w-4" aria-hidden="true">
              <path d="M3 6h18M8 6V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2M19 6l-1 14a2 2 0 0 1-2 2H8a2 2 0 0 1-2-2L5 6M10 11v6M14 11v6" />
            </svg>
          </button>
        </div>
      </div>`;
    })
    .join('');
}

async function loadUsers() {
  const data = await api('/api/users');
  state.users = data.users ?? [];
  state.userStats = data.stats ?? null;

  if (isAdmin()) renderUsers();
}

function setUserModalError(message) {
  const box = $('#user-modal-error');
  if (!message) {
    box.textContent = '';
    box.classList.add('hidden');
    return;
  }
  box.textContent = message;
  box.classList.remove('hidden');
}

function openUserModal(user = null) {
  const editing = Boolean(user);
  const self = editing && Number(user.id) === Number(state.user.id);

  $('#user-form').reset();
  setUserModalError('');

  $('#user-form-id').value = editing ? user.id : '';
  $('#user-form-name').value = editing ? user.name : '';
  $('#user-form-email').value = editing ? user.email : '';
  $('#user-form-role').value = editing ? user.role : 'user';
  $('#user-form-role').disabled = self;
  $('#user-role-hint').classList.toggle('hidden', !self);

  $('#user-modal-title').textContent = editing ? 'Edit user' : 'Tambah user';
  $('#user-modal-desc').textContent = editing
    ? `Perbarui data akun ${user.email}.`
    : 'Buat akun baru untuk pengguna aplikasi.';

  $('#user-form-password').value = '';
  $('#user-form-password').required = !editing;
  $('#user-form-password').placeholder = editing ? 'Kosongkan jika tidak diubah' : 'Minimal 6 karakter';
  $('#user-password-hint').textContent = editing
    ? 'Biarkan kosong untuk mempertahankan password saat ini.'
    : 'Minimal 6 karakter.';

  $('#user-modal-save').textContent = editing ? 'Simpan perubahan' : 'Tambah user';

  const modal = $('#user-modal');
  modal.classList.remove('hidden');
  modal.classList.add('flex');
  document.body.classList.add('overflow-hidden');

  window.setTimeout(() => $('#user-form-name').focus(), 0);
}

function closeUserModal() {
  const modal = $('#user-modal');
  modal.classList.add('hidden');
  modal.classList.remove('flex');
  document.body.classList.remove('overflow-hidden');
  setUserModalError('');
}

async function submitUserForm(event) {
  event.preventDefault();

  const id = $('#user-form-id').value;
  const payload = {
    name: $('#user-form-name').value.trim(),
    email: $('#user-form-email').value.trim(),
    role: $('#user-form-role').value,
    password: $('#user-form-password').value,
  };

  if (payload.name.length < 2) return setUserModalError('Nama minimal 2 karakter.');
  if (!/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(payload.email)) {
    return setUserModalError('Format email tidak valid.');
  }
  if (!id && payload.password.length < 6) {
    return setUserModalError('Password minimal 6 karakter.');
  }
  if (id && payload.password && payload.password.length < 6) {
    return setUserModalError('Password baru minimal 6 karakter.');
  }

  const button = $('#user-modal-save');
  const original = button.textContent;
  button.disabled = true;
  button.textContent = 'Menyimpan…';

  try {
    if (id) {
      await api(`/api/users/${id}`, { method: 'PATCH', body: JSON.stringify(payload) });
      if (Number(id) === Number(state.user.id)) await loadSession();
      toast('Data user diperbarui.', 'success');
    } else {
      await api('/api/users', { method: 'POST', body: JSON.stringify(payload) });
      toast('User baru berhasil ditambahkan.', 'success');
    }

    closeUserModal();
    await loadUsers();
  } catch (error) {
    setUserModalError(error.message);
  } finally {
    button.disabled = false;
    button.textContent = original;
  }
}

async function handleUserListClick(event) {
  const button = event.target.closest('[data-user-action]');
  if (!button) return;

  const id = Number(button.dataset.id);
  const action = button.dataset.userAction;
  const target = state.users.find((item) => Number(item.id) === id);
  if (!target) return;

  if (action === 'edit') {
    openUserModal(target);
    return;
  }

  if (action !== 'delete') return;

  if (id === Number(state.user.id)) {
    return toast('Tidak dapat menghapus akun sendiri.', 'error');
  }
  if (
    !(await confirmDialog(
      `Hapus akun "${target.name}" (${target.email})? Tindakan ini tidak dapat dibatalkan.`,
      { title: 'Hapus akun', confirmText: 'Hapus akun' }
    ))
  ) {
    return;
  }

  button.disabled = true;
  try {
    await api(`/api/users/${id}`, { method: 'DELETE' });
    await loadUsers();
    toast('User dihapus.', 'success');
  } catch (error) {
    toast(error.message, 'error');
    button.disabled = false;
  }
}

async function saveProfile(event) {
  event.preventDefault();

  const name = $('#profile-name').value.trim();
  const email = $('#profile-email').value.trim();
  const password = $('#profile-password').value;

  if (name.length < 2) return toast('Nama minimal 2 karakter.', 'error');
  if (!/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email)) return toast('Format email tidak valid.', 'error');
  if (password && password.length < 6) return toast('Password baru minimal 6 karakter.', 'error');

  const button = $('#profile-save');
  button.disabled = true;

  try {
    await api(`/api/users/${state.user.id}`, {
      method: 'PATCH',
      body: JSON.stringify({ name, email, password }),
    });
    $('#profile-password').value = '';
    await loadSession();
    if (isAdmin()) await loadUsers();
    toast('Profil berhasil diperbarui.', 'success');
  } catch (error) {
    toast(error.message, 'error');
  } finally {
    button.disabled = false;
  }
}

/* ------------------------------------------------------------------ */
/* Session                                                             */
/* ------------------------------------------------------------------ */

async function loadSession() {
  const me = await api('/api/me');
  state.user = me.user;
  applyUserIdentity();
}

/* ------------------------------------------------------------------ */
/* Events                                                              */
/* ------------------------------------------------------------------ */

function bindEvents() {
  $$('[data-nav]').forEach((button) => {
    button.addEventListener('click', () => switchPage(button.dataset.nav));
  });

  $$('[data-goto]').forEach((button) => {
    button.addEventListener('click', () => switchPage(button.dataset.goto));
  });

  /* Dokumentasi */
  $$('[data-scroll]').forEach((button) => {
    button.addEventListener('click', () => {
      const target = document.getElementById(button.dataset.scroll);
      target?.scrollIntoView({ behavior: 'smooth', block: 'start' });
    });
  });

  $$('[data-copy-code]').forEach((button) => {
    button.addEventListener('click', () => {
      const code = button.closest('.doc-code')?.querySelector('pre code');
      copyText(code?.textContent ?? '');
    });
  });

  $('#sidebar-open').addEventListener('click', toggleSidebar);
  $('#sidebar-close').addEventListener('click', closeSidebar);
  $('#sidebar-overlay').addEventListener('click', closeSidebar);

  document.addEventListener('keydown', (event) => {
    if (event.key !== 'Escape') return;
    if (!$('#user-modal').classList.contains('hidden')) {
      closeUserModal();
      return;
    }
    if (sidebarOpen && !DESKTOP_QUERY.matches) closeSidebar();
  });

  $('#app-logout').addEventListener('click', async () => {
    if (!(await confirmDialog('Keluar dari akun ini?', { title: 'Logout', confirmText: 'Keluar' }))) return;
    try {
      await api('/api/auth/logout', { method: 'POST' });
    } finally {
      window.location.href = '/login';
    }
  });

  /* Users */
  $('#profile-form').addEventListener('submit', saveProfile);
  $('#user-add').addEventListener('click', () => openUserModal());
  $('#user-list').addEventListener('click', handleUserListClick);
  $('#user-form').addEventListener('submit', submitUserForm);
  $('#user-modal-close').addEventListener('click', closeUserModal);
  $('#user-modal-cancel').addEventListener('click', closeUserModal);
  $$('[data-modal-close]').forEach((el) => el.addEventListener('click', closeUserModal));

  /* WhatsApp */
  $('#wa-connect').addEventListener('click', async () => {
    const button = $('#wa-connect');
    const original = button.innerHTML;
    button.disabled = true;
    button.innerHTML = `<svg class="h-4 w-4 animate-spin" viewBox="0 0 24 24" fill="none"><circle class="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" stroke-width="4"/><path class="opacity-90" fill="currentColor" d="M4 12a8 8 0 0 1 8-8v4a4 4 0 0 0-4 4H4z"/></svg> Menyiapkan…`;

    try {
      await api('/api/wa/connect', { method: 'POST' });
      toast('Sesi WhatsApp disiapkan. Menunggu QR / koneksi…', 'info');
      await refreshWa();
      await refreshOverview();
      switchPage('whatsapp');
    } catch (error) {
      toast(error.message, 'error');
    } finally {
      button.innerHTML = original;
      button.disabled = false;
      renderWaStatus();
    }
  });

  $('#wa-refresh').addEventListener('click', async () => {
    try {
      await refreshWa();
      toast('Status WhatsApp diperbarui.', 'success');
    } catch (error) {
      toast(error.message, 'error');
    }
  });

  $('#wa-logout').addEventListener('click', async () => {
    if (
      !(await confirmDialog('Putuskan WhatsApp? Anda perlu scan QR lagi untuk menghubungkan ulang.', {
        title: 'Putuskan WhatsApp',
        confirmText: 'Putuskan',
      }))
    )
      return;
    try {
      await api('/api/wa/logout', { method: 'POST' });
      state.qrData = null;
      await refreshWa();
      await refreshOverview();
      toast('WhatsApp telah diputuskan.', 'success');
    } catch (error) {
      toast(error.message, 'error');
    }
  });

  /* Webhooks */
  $('#hook-form').addEventListener('submit', async (event) => {
    event.preventDefault();
    const name = $('#hook-name').value.trim();
    const url = $('#hook-url').value.trim();

    if (name.length < 2) return toast('Nama webhook minimal 2 karakter.', 'error');
    try {
      new URL(url);
    } catch {
      return toast('URL tidak valid. Gunakan format http(s)://…', 'error');
    }

    try {
      await api('/api/webhooks', { method: 'POST', body: JSON.stringify({ name, url }) });
      $('#hook-name').value = '';
      $('#hook-url').value = '';
      await loadWebhooks();
      await refreshOverview();
      toast('Webhook berhasil ditambahkan.', 'success');
    } catch (error) {
      toast(error.message, 'error');
    }
  });

  $('#hook-list').addEventListener('click', async (event) => {
    const button = event.target.closest('[data-action]');
    if (!button) return;
    const id = button.dataset.id;
    const action = button.dataset.action;

    if (action === 'copy') {
      return copyText(button.dataset.copy || '');
    }

    if (action === 'delete') {
      if (!(await confirmDialog('Hapus webhook ini?', { title: 'Hapus webhook', confirmText: 'Hapus' }))) return;
      try {
        await api(`/api/webhooks/${id}`, { method: 'DELETE' });
        await loadWebhooks();
        await refreshOverview();
        toast('Webhook dihapus.', 'success');
      } catch (error) {
        toast(error.message, 'error');
      }
      return;
    }

    if (action === 'toggle') {
      const hook = state.webhooks.find((item) => String(item.id) === String(id));
      if (!hook) return;
      try {
        await api(`/api/webhooks/${id}`, {
          method: 'PATCH',
          body: JSON.stringify({ active: !hook.active }),
        });
        await loadWebhooks();
        await refreshOverview();
        toast(`Webhook ${hook.active ? 'dinonaktifkan' : 'diaktifkan'}.`, 'success');
      } catch (error) {
        toast(error.message, 'error');
      }
      return;
    }

    if (action === 'test') {
      button.disabled = true;
      const original = button.innerHTML;
      button.textContent = 'Mengirim…';
      try {
        const result = await api(`/api/webhooks/${id}/test`, { method: 'POST' });
        toast(
          result.ok
            ? `Webhook menerima payload (HTTP ${result.status}, ${result.ms} ms).`
            : `Endpoint merespons HTTP ${result.status}. Periksa server Anda.`,
          result.ok ? 'success' : 'error'
        );
        await loadLogs();
      } catch (error) {
        toast(error.message, 'error');
      } finally {
        button.innerHTML = original;
        button.disabled = false;
      }
    }
  });

  /* AI */
  $('#ai-style').addEventListener('change', () => {
    const style = currentAiStyle();
    const meta = AI_STYLE_META[style];
    const other = AI_STYLE_META[style === 'ollama' ? 'openai' : 'ollama'];

    const base = $('#ai-base').value.trim();
    if (!base || base === other.base) $('#ai-base').value = meta.base;

    const model = $('#ai-model').value.trim();
    if (!model || model === other.model) $('#ai-model').value = meta.model;

    syncAiStyleHints();
    toast(`Format API: ${style === 'ollama' ? 'Ollama (/api/chat)' : 'OpenAI-compatible'}.`, 'info');
  });

  $('#ai-form').addEventListener('submit', async (event) => {
    event.preventDefault();
    const payload = {
      enabled: $('#ai-enabled').checked,
      api_style: currentAiStyle(),
      base_url: $('#ai-base').value.trim(),
      model: $('#ai-model').value.trim(),
      api_key: $('#ai-key').value.trim(),
      system_prompt: $('#ai-prompt').value.trim(),
    };

    if (payload.enabled && !state.ai?.has_key && !payload.api_key) {
      return toast('Isi API key terlebih dahulu untuk mengaktifkan AI.', 'error');
    }

    try {
      state.ai = await api('/api/ai', { method: 'PUT', body: JSON.stringify(payload) });
      renderAi();
      await refreshOverview();
      toast('Pengaturan AI disimpan.', 'success');
    } catch (error) {
      toast(error.message, 'error');
    }
  });

  $('#ai-test').addEventListener('click', async () => {
    const button = $('#ai-test');
    const resultBox = $('#ai-test-result');
    const message = $('#ai-test-message').value.trim() || 'Halo! Perkenalkan diri Anda singkat.';

    button.disabled = true;
    resultBox.className = 'mt-4 rounded-xl border border-sky-400/20 bg-sky-500/10 p-4 text-sm leading-relaxed text-sky-200';
    resultBox.classList.remove('hidden');
    resultBox.textContent = 'Menghubungi model AI…';

    try {
      const result = await api('/api/ai/test', {
        method: 'POST',
        body: JSON.stringify({ message }),
      });
      resultBox.className = 'mt-4 whitespace-pre-wrap rounded-xl border border-emerald-400/20 bg-emerald-500/10 p-4 text-sm leading-relaxed text-emerald-100';
      resultBox.textContent = result.reply;
      await loadLogs();
    } catch (error) {
      resultBox.className = 'mt-4 rounded-xl border border-rose-400/20 bg-rose-500/10 p-4 text-sm leading-relaxed text-rose-200';
      resultBox.textContent = error.message;
    } finally {
      button.disabled = false;
    }
  });

  /* Logs */
  $('#clear-logs').addEventListener('click', async () => {
    if (!(await confirmDialog('Hapus semua riwayat aktivitas?', { title: 'Bersihkan riwayat', confirmText: 'Hapus' })))
      return;
    try {
      await api('/api/logs', { method: 'DELETE' });
      await loadLogs();
      await refreshOverview();
      toast('Riwayat dibersihkan.', 'success');
    } catch (error) {
      toast(error.message, 'error');
    }
  });

  /* Pengaturan sistem (admin) */
  $('#gh-form').addEventListener('submit', async (event) => {
    event.preventDefault();
    const button = $('#gh-form [type="submit"]');
    const token = $('#gh-token').value.trim();

    button.disabled = true;
    try {
      const data = await api('/api/system/token', {
        method: 'PUT',
        body: JSON.stringify({ token }),
      });
      state.system = { ...(state.system ?? {}), has_token: data.has_token, token_hint: data.token_hint };
      $('#gh-token').value = '';
      renderSystem();
      await loadTerminal();
      toast(token ? 'Token GitHub disimpan.' : 'Token GitHub dihapus.', 'success');
    } catch (error) {
      toast(error.message, 'error');
    } finally {
      button.disabled = false;
    }
  });

  $('#gh-update').addEventListener('click', async () => {
    const fresh = !state.system?.repo?.git;
    const confirmed = await confirmDialog(
      fresh
        ? 'Folder aplikasi belum berupa repo git. Klik lanjut untuk menyiapkan repo dan mengunduh seluruh kode dari GitHub (file dengan nama sama akan ditimpa). Restart aplikasi setelah selesai.'
        : 'Tarik commit terbaru dari GitHub? Restart aplikasi dari panel hosting setelah selesai.',
      { title: 'Update aplikasi', confirmText: 'Update sekarang' }
    );
    if (!confirmed) return;

    const button = $('#gh-update');
    button.disabled = true;
    button.textContent = 'Memperbarui…';
    startTermPoll();

    try {
      const result = await api('/api/system/update', { method: 'POST' });
      toast(
        result.changed ? 'Pembaruan diterapkan. Restart aplikasi.' : 'Kode sudah versi terbaru.',
        'success'
      );
    } catch (error) {
      toast(error.message, 'error');
    } finally {
      await loadSystem().catch(() => {});
      button.disabled = false;
      button.textContent = 'Update sekarang';
    }
  });

  $('#sys-migrate').addEventListener('click', async () => {
    const button = $('#sys-migrate');
    button.disabled = true;
    try {
      await api('/api/system/migrate', { method: 'POST' });
      await loadTerminal();
      toast('Migrasi database selesai.', 'success');
    } catch (error) {
      toast(error.message, 'error');
    } finally {
      button.disabled = false;
    }
  });

  $('#sys-cache').addEventListener('click', async () => {
    const button = $('#sys-cache');
    button.disabled = true;
    try {
      const data = await api('/api/system/cache', { method: 'POST' });
      await loadTerminal();
      toast(`Cache dibersihkan: ${data.sessions} sesi, ${data.qr} QR.`, 'success');
    } catch (error) {
      toast(error.message, 'error');
    } finally {
      button.disabled = false;
    }
  });

  $('#term-refresh').addEventListener('click', () => {
    loadTerminal().catch((error) => toast(error.message, 'error'));
  });

  $('#term-clear').addEventListener('click', async () => {
    if (!(await confirmDialog('Hapus semua isi log terminal?', { title: 'Hapus log', confirmText: 'Hapus' })))
      return;
    try {
      await api('/api/system/log', { method: 'DELETE' });
      await loadTerminal();
      toast('Log terminal dihapus.', 'success');
    } catch (error) {
      toast(error.message, 'error');
    }
  });

  /* Password / key visibility */
  $$('.toggle-password').forEach((button) => {
    button.addEventListener('click', () => {
      const input = document.getElementById(button.dataset.target);
      if (!input) return;
      const show = input.type === 'password';
      input.type = show ? 'text' : 'password';
      button.classList.toggle('text-emerald-300', show);
    });
  });
}

/* ------------------------------------------------------------------ */
/* Boot                                                                */
/* ------------------------------------------------------------------ */

async function boot() {
  try {
    initSidebar();
    await loadSession();
    const [overview] = await Promise.all([
      api('/api/overview'),
      loadWebhooks(),
      loadLogs(),
      loadAi(),
    ]);

    state.overview = overview;
    state.wa = overview.whatsapp ?? state.wa;
    renderOverview();

    if (state.wa.status === 'qr') {
      refreshWa().catch(() => {});
    } else {
      renderWaStatus();
    }

    bindEvents();
    setInterval(pollWa, 3500);

    window.addEventListener('hashchange', () => {
      const page = window.location.hash.slice(1);
      if (PAGES[page] && page !== state.page) switchPage(page, { updateHash: false });
    });

    const hashPage = window.location.hash.slice(1);
    if (PAGES[hashPage]) {
      switchPage(hashPage, { updateHash: false });
    } else if (state.wa.status === 'qr' || state.wa.status === 'connecting') {
      switchPage('whatsapp');
    }
  } catch (error) {
    if (!String(error.message).includes('Sesi berakhir')) {
      toast(error.message, 'error');
    }
  }
}

boot();
