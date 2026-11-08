import makeWASocket, {
  useMultiFileAuthState,
  fetchLatestBaileysVersion,
  DisconnectReason,
  Browsers,
} from 'baileys';
import QRCode from 'qrcode';
import fs from 'node:fs';
import path from 'node:path';
import pino from 'pino';
import { addLog, activeWebhooks, getAiSettings } from './db.js';
import { generateReply } from './ai.js';
import { signPayload } from './auth.js';
import { assertPublicUrl } from './net.js';

const logger = pino({ level: process.env.WA_LOG_LEVEL || 'warn' });

/** Tulis log tanpa membuat unhandled rejection saat DB sibuk / terputus. */
function log(userId, payload) {
  return addLog(userId, payload).catch(() => {});
}

const AUTH_ROOT = path.join(process.cwd(), 'auth_files');
fs.mkdirSync(AUTH_ROOT, { recursive: true });

/** Batas percobaan reconnect sebelum menyerah (biar tidak loop selamanya). */
const RECONNECT_BASE = 3000;
const RECONNECT_MAX = 60000;
const RECONNECT_LIMIT = 12;

/** userId -> session state */
const sessions = new Map();

function authDir(userId) {
  return path.join(AUTH_ROOT, `user-${userId}`);
}

/* ------------------------------------------------------------------ */
/* Kunci satu-proses                                                   */
/* ------------------------------------------------------------------ */

/**
 * Passenger (cPanel "Setup Node.js App") / PM2 bisa menjalankan lebih dari satu
 * worker untuk aplikasi yang sama. Dua socket dengan credentials yang sama akan
 * saling tendang (status 440) sehingga status berganti-ganti
 * "menyambungkan -> tersambung" tanpa henti. Kunci berbasis PID memastikan hanya
 * satu proses yang memegang sesi.
 */
function claimSession(userId) {
  const file = path.join(authDir(userId), '.owner');
  try {
    const owner = Number(fs.readFileSync(file, 'utf8').trim());
    if (owner && owner !== process.pid && isAlive(owner)) return false;
  } catch {
    /* belum ada kunci */
  }
  try {
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, String(process.pid));
    // Baca ulang: bila dua proses start bersamaan, hanya penulis terakhir yang menang.
    return Number(fs.readFileSync(file, 'utf8').trim()) === process.pid;
  } catch {
    /* gagal menulis kunci: anggap boleh jalan (hosting read-only aneh) */
    return true;
  }
}

function isAlive(pid) {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

function publicState(state) {
  return {
    status: state?.status ?? 'disconnected',
    phone: state?.phone ?? null,
    hasQr: Boolean(state?.qrDataUrl),
  };
}

export function getWaState(userId) {
  const state = sessions.get(userId);
  return publicState(state);
}

/** Buang gambar QR yang tersimpan di memori agar dibuat ulang saat diminta. */
export function clearQrCache() {
  let cleared = 0;
  for (const state of sessions.values()) {
    if (state.qrDataUrl) {
      state.qrDataUrl = null;
      cleared += 1;
    }
  }
  return cleared;
}

export async function getWaQr(userId) {
  const state = sessions.get(userId);
  if (!state || state.status !== 'qr' || !state.rawQr) {
    return { ...publicState(state), qr: null };
  }

  if (!state.qrDataUrl) {
    state.qrDataUrl = await QRCode.toDataURL(state.rawQr, {
      margin: 1,
      width: 360,
      color: { dark: '#0f172a', light: '#ffffff' },
    });
  }

  return { ...publicState(state), qr: state.qrDataUrl };
}

export async function connectWhatsApp(userId) {
  const existing = sessions.get(userId);
  if (existing && ['connecting', 'qr', 'connected'].includes(existing.status)) {
    return publicState(existing);
  }

  if (!claimSession(userId)) {
    log(userId, {
      type: 'system',
      direction: 'out',
      status: 'warn',
      message:
        'Sesi WhatsApp sedang dipegang proses lain (aplikasi berjalan ganda). Hentikan worker tambahan agar sesi tidak saling tendang.',
    });
    return publicState(existing);
  }

  const state = {
    status: 'connecting',
    rawQr: null,
    qrDataUrl: null,
    phone: null,
    sock: null,
    manualClose: false,
    timer: null,
    attempts: 0,
  };
  sessions.set(userId, state);
  await startSocket(userId, state);
  return publicState(state);
}

async function startSocket(userId, state) {
  const dir = authDir(userId);
  fs.mkdirSync(dir, { recursive: true });

  // Bersihkan percobaan sebelumnya: timer ganda dan socket lama yang listener-nya
  // masih hidup akan memicu reconnect berlapis (satu close -> banyak socket baru).
  if (state.timer) {
    clearTimeout(state.timer);
    state.timer = null;
  }
  if (state.sock) {
    try {
      state.sock.ev.removeAllListeners('connection.update');
      state.sock.end(undefined);
    } catch {
      /* socket sudah mati */
    }
    state.sock = null;
  }

  const { state: authState, saveCreds } = await useMultiFileAuthState(dir);
  const { version } = await fetchLatestBaileysVersion();

  const sock = makeWASocket({
    version,
    auth: authState,
    printQRInTerminal: false,
    browser: Browsers.ubuntu('Webhook AI'),
    syncFullHistory: false,
    markOnlineOnConnect: false,
    logger,
  });

  state.sock = sock;
  sock.ev.on('creds.update', saveCreds);

  sock.ev.on('connection.update', (update) => {
    if (sessions.get(userId) !== state) return;
    const { connection, lastDisconnect, qr } = update;

    if (qr) {
      state.status = 'qr';
      state.rawQr = qr;
      state.qrDataUrl = null;
      QRCode.toDataURL(qr, { margin: 1, width: 360, color: { dark: '#0f172a', light: '#ffffff' } })
        .then((url) => {
          if (sessions.get(userId) === state) state.qrDataUrl = url;
        })
        .catch(() => {});
    }

    if (connection === 'open') {
      state.status = 'connected';
      state.attempts = 0;
      state.rawQr = null;
      state.qrDataUrl = null;
      state.phone = sock.user?.id?.split(':')[0] || null;
      log(userId, {
        type: 'system',
        direction: 'out',
        message: `WhatsApp terhubung${state.phone ? ` sebagai +${state.phone}` : ''}.`,
      });
    }

    if (connection === 'close') {
      const code =
        lastDisconnect?.error?.output?.statusCode ?? lastDisconnect?.error?.statusCode;
      state.rawQr = null;
      state.qrDataUrl = null;
      state.phone = null;

      if (state.manualClose) {
        state.status = 'disconnected';
        return;
      }

      if (code === DisconnectReason.loggedOut) {
        state.status = 'disconnected';
        fs.rmSync(authDir(userId), { recursive: true, force: true });
        log(userId, {
          type: 'system',
          direction: 'out',
          message: 'Sesi WhatsApp berakhir (logged out). Silakan hubungkan ulang.',
          status: 'warn',
        });
        return;
      }

      // 440 = sesi dipakai di tempat lain (proses/worker lain atau WhatsApp di
      // perangkat lain). Reconnect langsung hanya membuat dua koneksi saling
      // tendang -> status berganti-ganti tanpa henti. Berhenti, jangan loop.
      if (code === DisconnectReason.connectionReplaced) {
        state.status = 'disconnected';
        log(userId, {
          type: 'system',
          direction: 'out',
          message:
            'Sesi WhatsApp dipakai proses/perangkat lain, jadi koneksi ini dihentikan. Pastikan aplikasi hanya berjalan satu proses (satu worker), lalu hubungkan ulang.',
          status: 'error',
        });
        return;
      }

      if (state.attempts >= RECONNECT_LIMIT) {
        state.status = 'disconnected';
        log(userId, {
          type: 'system',
          direction: 'out',
          message: `Gagal menyambung ulang setelah ${state.attempts} percobaan (kode ${code ?? 'tidak diketahui'}). Periksa koneksi hosting, lalu hubungkan ulang.`,
          status: 'error',
        });
        return;
      }

      // Backoff eksponensial: 3s, 6s, 12s, ... maksimal 60s agar tidak membanjiri
      // server WhatsApp saat hosting sedang bermasalah.
      state.attempts += 1;
      const delay = Math.min(RECONNECT_BASE * 2 ** (state.attempts - 1), RECONNECT_MAX);
      state.status = 'connecting';
      log(userId, {
        type: 'system',
        direction: 'out',
        message: `Koneksi WhatsApp terputus (kode ${code ?? '-'}), menyambung ulang dalam ${Math.round(delay / 1000)} detik...`,
        status: 'warn',
      });
      state.timer = setTimeout(() => {
        if (sessions.get(userId) !== state) return;
        startSocket(userId, state).catch((err) => {
          state.status = 'disconnected';
          log(userId, {
            type: 'system',
            direction: 'out',
            message: `Gagal menyambung ulang: ${err.message}`,
            status: 'error',
          });
        });
      }, delay);
    }
  });

  sock.ev.on('messages.upsert', ({ messages, type }) => {
    if (type !== 'notify') return;
    for (const msg of messages) {
      handleIncoming(userId, state, msg).catch((err) => {
        log(userId, {
          type: 'system',
          direction: 'out',
          message: `Gagal memproses pesan masuk: ${err.message}`,
          status: 'error',
        });
      });
    }
  });

  return state;
}

export async function logoutWhatsApp(userId) {
  const state = sessions.get(userId);
  if (state) {
    state.manualClose = true;
    if (state.timer) clearTimeout(state.timer);
    try {
      await state.sock?.logout();
    } catch {
      try {
        state.sock?.end(undefined);
      } catch {
        /* ignore */
      }
    }
    sessions.delete(userId);
  }

  fs.rmSync(authDir(userId), { recursive: true, force: true });
  log(userId, {
    type: 'system',
    direction: 'out',
    message: 'WhatsApp diputuskan dan sesi lokal dihapus.',
  });
  return { status: 'disconnected', phone: null, hasQr: false };
}

/* ------------------------------------------------------------------ */
/* Message pipeline: log -> webhook -> AI auto reply                   */
/* ------------------------------------------------------------------ */

function extractText(message) {
  if (!message) return '';
  return (
    message.conversation ||
    message.extendedTextMessage?.text ||
    message.imageMessage?.caption ||
    message.videoMessage?.caption ||
    message.buttonsResponseMessage?.selectedDisplayText ||
    message.listResponseMessage?.title ||
    ''
  ).trim();
}

async function handleIncoming(userId, state, msg) {
  if (!msg?.message || msg.key?.fromMe) return;

  const jid = msg.key?.remoteJid;
  if (!jid || jid === 'status@broadcast' || jid.endsWith('@broadcast')) return;

  const text = extractText(msg.message);
  if (!text) return;

  const isGroup = jid.endsWith('@g.us');
  const pushName = msg.pushName || '';

  log(userId, {
    type: 'message',
    direction: 'in',
    message: text.slice(0, 1000),
    meta: { from: jid, pushName, isGroup },
  });

  forwardToWebhooks(userId, {
    event: 'message',
    from: jid,
    pushName,
    isGroup,
    text,
    timestamp: Number(msg.messageTimestamp) * 1000 || Date.now(),
  }).catch(() => {});

  const ai = await getAiSettings(userId);
  if (!ai?.enabled || !ai.api_key || isGroup) return;

  try {
    if (state.sock?.sendPresenceUpdate) {
      await state.sock.sendPresenceUpdate('composing', jid).catch(() => {});
    }
    const reply = await generateReply(ai, text, { pushName });
    await state.sock.sendMessage(jid, { text: reply });
    log(userId, {
      type: 'ai',
      direction: 'out',
      message: reply.slice(0, 1000),
      meta: { to: jid, model: ai.model },
    });
  } catch (err) {
    log(userId, {
      type: 'ai',
      direction: 'out',
      message: `AI gagal membalas: ${err.message}`,
      status: 'error',
    });
  }
}

export async function forwardToWebhooks(userId, payload) {
  const hooks = await activeWebhooks(userId);
  if (!hooks.length) return [];

  const results = await Promise.allSettled(
    hooks.map(async (hook) => {
      const body = JSON.stringify({
        event: payload.event,
        from: payload.from,
        pushName: payload.pushName,
        isGroup: payload.isGroup,
        text: payload.text,
        timestamp: payload.timestamp,
        webhookId: hook.id,
      });

      const res = await fetch(await assertPublicUrl(hook.url), {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'User-Agent': 'Webhook-AI/1.0',
          'X-Webhook-Event': payload.event,
          'X-Webhook-Signature': `sha256=${signPayload(hook.secret, body)}`,
        },
        body,
        redirect: 'manual',
        signal: AbortSignal.timeout(10_000),
      });

      await log(userId, {
        type: 'webhook',
        direction: 'out',
        message: `"${hook.name}" -> HTTP ${res.status}`,
        meta: { url: hook.url, webhookId: hook.id },
        status: res.ok ? 'ok' : 'error',
      });

      return { webhookId: hook.id, ok: res.ok, status: res.status };
    })
  );

  results.forEach((result, index) => {
    if (result.status === 'rejected') {
      const hook = hooks[index];
      log(userId, {
        type: 'webhook',
        direction: 'out',
        message: `"${hook.name}" gagal: ${result.reason?.message || 'unknown error'}`,
        meta: { url: hook.url, webhookId: hook.id },
        status: 'error',
      });
    }
  });

  return results;
}
