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

const logger = pino({ level: process.env.WA_LOG_LEVEL || 'warn' });

/** Tulis log tanpa membuat unhandled rejection saat DB sibuk / terputus. */
function log(userId, payload) {
  return addLog(userId, payload).catch(() => {});
}

const AUTH_ROOT = path.join(process.cwd(), 'auth_files');
fs.mkdirSync(AUTH_ROOT, { recursive: true });

/** userId -> session state */
const sessions = new Map();

function authDir(userId) {
  return path.join(AUTH_ROOT, `user-${userId}`);
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

  const state = {
    status: 'connecting',
    rawQr: null,
    qrDataUrl: null,
    phone: null,
    sock: null,
    manualClose: false,
    timer: null,
  };
  sessions.set(userId, state);
  await startSocket(userId, state);
  return publicState(state);
}

async function startSocket(userId, state) {
  const dir = authDir(userId);
  fs.mkdirSync(dir, { recursive: true });

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

      state.status = 'connecting';
      log(userId, {
        type: 'system',
        direction: 'out',
        message: 'Koneksi WhatsApp terputus, mencoba menyambung ulang...',
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
      }, 3000);
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

      const res = await fetch(hook.url, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'User-Agent': 'Webhook-AI/1.0',
          'X-Webhook-Event': payload.event,
          'X-Webhook-Signature': `sha256=${signPayload(hook.secret, body)}`,
        },
        body,
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
