import express from 'express';
import path from 'node:path';
import fs from 'node:fs';
import {
  findUserByEmail,
  findUserById,
  createUser,
  listUsers,
  updateUser,
  deleteUser,
  countUsers,
  createSession,
  findSessionUser,
  deleteSession,
  purgeExpiredSessions,
  listWebhooks,
  getWebhook,
  createWebhook,
  updateWebhook,
  deleteWebhook,
  getAiSettings,
  saveAiSettings,
  addLog,
  listLogs,
  countLogs,
  clearLogs,
  seedDemoUser,
  migrateLegacySqlite,
} from './db.js';
import {
  verifyPassword,
  createSessionToken,
  hashToken,
  parseCookies,
  isValidEmail,
  createSecret,
  signPayload,
} from './auth.js';
import { getWaState, getWaQr, connectWhatsApp, logoutWhatsApp } from './whatsapp.js';
import { generateReply } from './ai.js';

const PORT = Number(process.env.PORT) || 3000;
const SESSION_DAYS = 7;
const PUBLIC_DIR = path.join(process.cwd(), 'public');

/**
 * Set COOKIE_SECURE=1 saat aplikasi diakses lewat HTTPS (mis. di balik Nginx,
 * Railway, Render, Fly.io). Cookie sesi akan memakai flag `Secure`.
 */
const COOKIE_SECURE = /^(1|true|yes|on)$/i.test(process.env.COOKIE_SECURE || '');

const migration = await migrateLegacySqlite();
if (!migration.skipped) {
  console.log(
    `  [db] Migrasi SQLite -> MySQL selesai: ${migration.users} user, ${migration.webhooks} webhook, ${migration.logs} log.`
  );
}
await seedDemoUser();
await purgeExpiredSessions();

const app = express();
app.disable('x-powered-by');

// Percayai reverse proxy (Nginx, Cloudflare, Railway, Render) agar IP klien
// dan protokol HTTPS terbaca dengan benar.
app.set('trust proxy', 1);

app.use(express.json({ limit: '1mb' }));

/* ------------------------------------------------------------------ */
/* Helpers                                                             */
/* ------------------------------------------------------------------ */

const asyncHandler = (fn) => (req, res, next) => Promise.resolve(fn(req, res, next)).catch(next);

async function currentUser(req) {
  const token = parseCookies(req.headers.cookie).sid;
  if (!token) return null;
  return (await findSessionUser(hashToken(token))) ?? null;
}

function sessionCookie(value, maxAge) {
  const secure = COOKIE_SECURE ? '; Secure' : '';
  return `sid=${value}; HttpOnly; Path=/; SameSite=Lax; Max-Age=${maxAge}${secure}`;
}

async function startSession(res, userId) {
  const token = createSessionToken();
  const expiresAt = Date.now() + SESSION_DAYS * 24 * 60 * 60 * 1000;
  await createSession(userId, hashToken(token), expiresAt);
  res.setHeader('Set-Cookie', sessionCookie(token, SESSION_DAYS * 24 * 60 * 60));
}

function clearSessionCookie(res) {
  res.setHeader('Set-Cookie', sessionCookie('', 0));
}

async function requireAuth(req, res, next) {
  const user = await currentUser(req);
  if (!user) return res.status(401).json({ error: 'Silakan login terlebih dahulu.' });
  req.user = user;
  next();
}

function requireAdmin(req, res, next) {
  if (req.user.role !== 'admin') {
    return res.status(403).json({ error: 'Hanya admin yang dapat melakukan aksi ini.' });
  }
  next();
}

/* Login rate limiting (per IP, in-memory) */
const loginAttempts = new Map();
function tooManyAttempts(ip) {
  const now = Date.now();
  const entry = loginAttempts.get(ip);
  if (!entry || entry.reset < now) {
    loginAttempts.set(ip, { count: 1, reset: now + 5 * 60 * 1000 });
    return false;
  }
  entry.count += 1;
  return entry.count > 25;
}

/* ------------------------------------------------------------------ */
/* Auth                                                                */
/* ------------------------------------------------------------------ */

app.post(
  '/api/auth/register',
  asyncHandler(async (req, res) => {
    const { name = '', email = '', password = '' } = req.body ?? {};

    if (String(name).trim().length < 2) {
      return res.status(400).json({ error: 'Nama minimal 2 karakter.' });
    }
    if (!isValidEmail(email)) {
      return res.status(400).json({ error: 'Format email tidak valid.' });
    }
    if (String(password).length < 6) {
      return res.status(400).json({ error: 'Password minimal 6 karakter.' });
    }
    if (await findUserByEmail(email)) {
      return res.status(409).json({ error: 'Email sudah terdaftar. Silakan login.' });
    }

    const user = await createUser({ name, email, password, role: 'user' });
    await startSession(res, user.id);
    await addLog(user.id, {
      type: 'system',
      direction: 'out',
      message: 'Akun gratis berhasil dibuat. Selamat datang di Webhook AI.',
    });

    res.status(201).json({
      user: { id: user.id, name: user.name, email: user.email, role: user.role },
    });
  })
);

app.post(
  '/api/auth/login',
  asyncHandler(async (req, res) => {
    const ip = req.ip || 'unknown';
    if (tooManyAttempts(ip)) {
      return res.status(429).json({ error: 'Terlalu banyak percobaan. Coba lagi dalam 5 menit.' });
    }

    const { email = '', password = '' } = req.body ?? {};
    const user = await findUserByEmail(email);

    if (!user || !verifyPassword(password, user.password_hash)) {
      return res.status(401).json({ error: 'Email atau password salah.' });
    }

    await startSession(res, user.id);
    loginAttempts.delete(ip);
    res.json({ user: { id: user.id, name: user.name, email: user.email, role: user.role } });
  })
);

app.post(
  '/api/auth/logout',
  asyncHandler(async (req, res) => {
    const token = parseCookies(req.headers.cookie).sid;
    if (token) await deleteSession(hashToken(token));
    clearSessionCookie(res);
    res.json({ ok: true });
  })
);

app.get(
  '/api/me',
  asyncHandler(async (req, res) => {
    const user = await currentUser(req);
    if (!user) return res.status(401).json({ error: 'Belum login.' });
    res.json({ user });
  })
);

/* ------------------------------------------------------------------ */
/* Users (SaaS)                                                        */
/* ------------------------------------------------------------------ */

const publicUser = (user) =>
  user
    ? {
        id: user.id,
        name: user.name,
        email: user.email,
        role: user.role,
        created_at: user.created_at,
        updated_at: user.updated_at,
        webhooks: user.webhooks,
        logs: user.logs,
      }
    : null;

app.get(
  '/api/users',
  requireAuth,
  asyncHandler(async (req, res) => {
    if (req.user.role === 'admin') {
      return res.json({ users: (await listUsers()).map(publicUser), stats: await countUsers() });
    }

    const self = await findUserById(req.user.id);
    res.json({ users: [publicUser(self)], stats: null });
  })
);

app.post(
  '/api/users',
  requireAuth,
  requireAdmin,
  asyncHandler(async (req, res) => {
    const { name = '', email = '', password = '', role = 'user' } = req.body ?? {};

    if (String(name).trim().length < 2) {
      return res.status(400).json({ error: 'Nama minimal 2 karakter.' });
    }
    if (!isValidEmail(email)) {
      return res.status(400).json({ error: 'Format email tidak valid.' });
    }
    if (String(password).length < 6) {
      return res.status(400).json({ error: 'Password minimal 6 karakter.' });
    }
    if (!['admin', 'user'].includes(role)) {
      return res.status(400).json({ error: 'Role harus "admin" atau "user".' });
    }
    if (await findUserByEmail(email)) {
      return res.status(409).json({ error: 'Email sudah digunakan.' });
    }

    try {
      const user = await createUser({
        name: String(name).trim(),
        email,
        password,
        role,
      });

      await addLog(req.user.id, {
        type: 'system',
        direction: 'out',
        message: `User baru "${user.email}" dibuat dengan role ${user.role}.`,
      });

      res.status(201).json({ user: publicUser(user) });
    } catch (error) {
      if (error.code === 'ER_DUP_ENTRY') {
        return res.status(409).json({ error: 'Email sudah digunakan.' });
      }
      throw error;
    }
  })
);

app.patch(
  '/api/users/:id',
  requireAuth,
  asyncHandler(async (req, res) => {
    const id = Number(req.params.id);
    const isAdmin = req.user.role === 'admin';

    if (!Number.isInteger(id) || id < 1) {
      return res.status(400).json({ error: 'ID user tidak valid.' });
    }
    if (!isAdmin && id !== req.user.id) {
      return res.status(403).json({ error: 'Anda hanya dapat mengubah data milik sendiri.' });
    }

    const target = await findUserById(id);
    if (!target) return res.status(404).json({ error: 'User tidak ditemukan.' });

    const { name, email, password, role } = req.body ?? {};

    if (name !== undefined && String(name).trim().length < 2) {
      return res.status(400).json({ error: 'Nama minimal 2 karakter.' });
    }
    if (email !== undefined && !isValidEmail(email)) {
      return res.status(400).json({ error: 'Format email tidak valid.' });
    }
    if (password !== undefined && password !== '' && String(password).length < 6) {
      return res.status(400).json({ error: 'Password baru minimal 6 karakter.' });
    }

    if (role !== undefined && role !== target.role) {
      if (!isAdmin) {
        return res.status(403).json({ error: 'Hanya admin yang dapat mengubah role.' });
      }
      if (!['admin', 'user'].includes(role)) {
        return res.status(400).json({ error: 'Role harus "admin" atau "user".' });
      }
      if (id === req.user.id) {
        return res.status(400).json({ error: 'Tidak dapat mengubah role akun sendiri.' });
      }
      if (target.role === 'admin' && role === 'user') {
        const stats = await countUsers();
        if (stats.admins <= 1) {
          return res.status(400).json({ error: 'Minimal harus ada satu admin.' });
        }
      }
    }

    if (email !== undefined) {
      const duplicate = await findUserByEmail(email);
      if (duplicate && Number(duplicate.id) !== id) {
        return res.status(409).json({ error: 'Email sudah digunakan.' });
      }
    }

    try {
      const user = await updateUser(id, { name, email, password, role });

      if (id !== req.user.id) {
        await addLog(req.user.id, {
          type: 'system',
          direction: 'out',
          message: `Data user "${user.email}" diperbarui.`,
        });
      }

      res.json({ user: publicUser(user) });
    } catch (error) {
      if (error.code === 'ER_DUP_ENTRY') {
        return res.status(409).json({ error: 'Email sudah digunakan.' });
      }
      throw error;
    }
  })
);

app.delete(
  '/api/users/:id',
  requireAuth,
  requireAdmin,
  asyncHandler(async (req, res) => {
    const id = Number(req.params.id);

    if (!Number.isInteger(id) || id < 1) {
      return res.status(400).json({ error: 'ID user tidak valid.' });
    }
    if (id === req.user.id) {
      return res.status(400).json({ error: 'Tidak dapat menghapus akun sendiri.' });
    }

    const target = await findUserById(id);
    if (!target) return res.status(404).json({ error: 'User tidak ditemukan.' });

    if (target.role === 'admin') {
      const stats = await countUsers();
      if (stats.admins <= 1) {
        return res.status(400).json({ error: 'Minimal harus ada satu admin.' });
      }
    }

    await deleteUser(id);
    await addLog(req.user.id, {
      type: 'system',
      direction: 'out',
      message: `User "${target.email}" dihapus.`,
    });

    res.json({ ok: true });
  })
);

/* ------------------------------------------------------------------ */
/* Overview                                                            */
/* ------------------------------------------------------------------ */

app.get(
  '/api/overview',
  requireAuth,
  asyncHandler(async (req, res) => {
    const ai = await getAiSettings(req.user.id);
    const hooks = await listWebhooks(req.user.id);
    res.json({
      user: req.user,
      whatsapp: getWaState(req.user.id),
      webhooks: { total: hooks.length, active: hooks.filter((h) => h.active).length },
      messages: await countLogs(req.user.id),
      ai: { enabled: Boolean(ai?.enabled), model: ai?.model ?? '-', hasKey: Boolean(ai?.api_key) },
    });
  })
);

/* ------------------------------------------------------------------ */
/* WhatsApp                                                            */
/* ------------------------------------------------------------------ */

app.get('/api/wa/status', requireAuth, (req, res) => {
  res.json(getWaState(req.user.id));
});

app.get(
  '/api/wa/qr',
  requireAuth,
  asyncHandler(async (req, res) => {
    res.json(await getWaQr(req.user.id));
  })
);

app.post(
  '/api/wa/connect',
  requireAuth,
  asyncHandler(async (req, res) => {
    const state = await connectWhatsApp(req.user.id);
    await addLog(req.user.id, {
      type: 'system',
      direction: 'out',
      message: 'Permintaan koneksi WhatsApp dibuat. Menunggu QR / koneksi.',
    });
    res.json(state);
  })
);

app.post(
  '/api/wa/logout',
  requireAuth,
  asyncHandler(async (req, res) => {
    res.json(await logoutWhatsApp(req.user.id));
  })
);

/* ------------------------------------------------------------------ */
/* Webhooks                                                            */
/* ------------------------------------------------------------------ */

app.get(
  '/api/webhooks',
  requireAuth,
  asyncHandler(async (req, res) => {
    res.json({ webhooks: await listWebhooks(req.user.id) });
  })
);

app.post(
  '/api/webhooks',
  requireAuth,
  asyncHandler(async (req, res) => {
    const { name = '', url = '', events = 'message' } = req.body ?? {};

    if (String(name).trim().length < 2) {
      return res.status(400).json({ error: 'Nama webhook minimal 2 karakter.' });
    }
    if (!isValidHttpUrl(url)) {
      return res.status(400).json({ error: 'URL webhook harus http/https yang valid.' });
    }

    const hook = await createWebhook(req.user.id, {
      name: String(name).trim(),
      url: String(url).trim(),
      events,
      secret: createSecret(),
    });

    await addLog(req.user.id, {
      type: 'system',
      direction: 'out',
      message: `Webhook "${hook.name}" ditambahkan.`,
    });
    res.status(201).json({ webhook: hook });
  })
);

app.patch(
  '/api/webhooks/:id',
  requireAuth,
  asyncHandler(async (req, res) => {
    const id = Number(req.params.id);
    const { name, url, active } = req.body ?? {};
    if (url !== undefined && !isValidHttpUrl(url)) {
      return res.status(400).json({ error: 'URL webhook harus http/https yang valid.' });
    }

    const hook = await updateWebhook(req.user.id, id, { name, url, active });
    if (!hook) return res.status(404).json({ error: 'Webhook tidak ditemukan.' });
    res.json({ webhook: hook });
  })
);

app.delete(
  '/api/webhooks/:id',
  requireAuth,
  asyncHandler(async (req, res) => {
    const ok = await deleteWebhook(req.user.id, Number(req.params.id));
    if (!ok) return res.status(404).json({ error: 'Webhook tidak ditemukan.' });
    res.json({ ok: true });
  })
);

app.post(
  '/api/webhooks/:id/test',
  requireAuth,
  asyncHandler(async (req, res) => {
    const hook = await getWebhook(req.user.id, Number(req.params.id));
    if (!hook) return res.status(404).json({ error: 'Webhook tidak ditemukan.' });

    const body = JSON.stringify({
      event: 'test',
      from: 'test@s.whatsapp.net',
      pushName: req.user.name,
      isGroup: false,
      text: 'Halo! Ini pesan uji dari Webhook AI.',
      timestamp: Date.now(),
      webhookId: hook.id,
    });

    const started = Date.now();
    try {
      const response = await fetch(hook.url, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'User-Agent': 'Webhook-AI/1.0',
          'X-Webhook-Event': 'test',
          'X-Webhook-Signature': `sha256=${signPayload(hook.secret, body)}`,
        },
        body,
        signal: AbortSignal.timeout(10_000),
      });

      await addLog(req.user.id, {
        type: 'webhook',
        direction: 'out',
        message: `Test "${hook.name}" -> HTTP ${response.status}`,
        meta: { url: hook.url, webhookId: hook.id },
        status: response.ok ? 'ok' : 'error',
      });

      res.json({
        ok: response.ok,
        status: response.status,
        ms: Date.now() - started,
      });
    } catch (err) {
      await addLog(req.user.id, {
        type: 'webhook',
        direction: 'out',
        message: `Test "${hook.name}" gagal: ${err.message}`,
        meta: { url: hook.url, webhookId: hook.id },
        status: 'error',
      });
      res.status(502).json({ ok: false, error: err.message, ms: Date.now() - started });
    }
  })
);

/* ------------------------------------------------------------------ */
/* AI settings                                                         */
/* ------------------------------------------------------------------ */

app.get(
  '/api/ai',
  requireAuth,
  asyncHandler(async (req, res) => {
    const settings = await getAiSettings(req.user.id);
    res.json({
      enabled: Boolean(settings?.enabled),
      api_style: settings?.api_style === 'ollama' ? 'ollama' : 'openai',
      base_url: settings?.base_url ?? '',
      model: settings?.model ?? '',
      system_prompt: settings?.system_prompt ?? '',
      has_key: Boolean(settings?.api_key),
      key_hint: settings?.api_key ? `••••${settings.api_key.slice(-4)}` : '',
    });
  })
);

app.put(
  '/api/ai',
  requireAuth,
  asyncHandler(async (req, res) => {
    const {
      enabled,
      api_style = 'openai',
      base_url = '',
      api_key = '',
      model = '',
      system_prompt = '',
    } = req.body ?? {};

    if (base_url && !isValidHttpUrl(base_url)) {
      return res.status(400).json({ error: 'Base URL harus http/https yang valid.' });
    }
    if (!['openai', 'ollama'].includes(api_style)) {
      return res.status(400).json({ error: 'Format API harus "openai" atau "ollama".' });
    }

    const settings = await saveAiSettings(req.user.id, {
      enabled,
      api_style,
      base_url,
      api_key,
      model,
      system_prompt,
    });

    res.json({
      enabled: Boolean(settings.enabled),
      api_style: settings.api_style,
      base_url: settings.base_url,
      model: settings.model,
      system_prompt: settings.system_prompt,
      has_key: Boolean(settings.api_key),
      key_hint: settings.api_key ? `••••${settings.api_key.slice(-4)}` : '',
    });
  })
);

app.post(
  '/api/ai/test',
  requireAuth,
  asyncHandler(async (req, res) => {
    const settings = await getAiSettings(req.user.id);
    if (!settings?.api_key) {
      return res.status(400).json({ error: 'Atur dan simpan API key terlebih dahulu.' });
    }
    const message = String(req.body?.message || 'Balas dengan sapaan singkat dan ramah.').slice(0, 1000);
    try {
      const reply = await generateReply(settings, message, { pushName: req.user.name });
      res.json({ ok: true, reply });
    } catch (err) {
      res.status(502).json({ ok: false, error: err.message });
    }
  })
);

/* ------------------------------------------------------------------ */
/* Logs                                                                */
/* ------------------------------------------------------------------ */

app.get(
  '/api/logs',
  requireAuth,
  asyncHandler(async (req, res) => {
    res.json({ logs: await listLogs(req.user.id, req.query.limit) });
  })
);

app.delete(
  '/api/logs',
  requireAuth,
  asyncHandler(async (req, res) => {
    const removed = await clearLogs(req.user.id);
    res.json({ ok: true, removed });
  })
);

/* ------------------------------------------------------------------ */
/* Pages                                                               */
/* ------------------------------------------------------------------ */

app.get(
  '/',
  asyncHandler(async (req, res) => {
    res.redirect((await currentUser(req)) ? '/dashboard' : '/login');
  })
);

app.get(
  '/login',
  asyncHandler(async (req, res) => {
    if (await currentUser(req)) return res.redirect('/dashboard');
    res.sendFile(path.join(PUBLIC_DIR, 'login.html'));
  })
);

app.get(
  '/dashboard',
  asyncHandler(async (req, res) => {
    if (!(await currentUser(req))) return res.redirect('/login');
    res.sendFile(path.join(PUBLIC_DIR, 'dashboard.html'));
  })
);

// SweetAlert2 (dialog & toast di mode desktop) dilayani langsung dari node_modules
// agar tidak perlu menyalin file build ke folder public/.
app.use(
  '/vendor/sweetalert2',
  express.static(path.join(process.cwd(), 'node_modules', 'sweetalert2', 'dist'), {
    maxAge: '7d',
  })
);

app.use(
  '/vendor/sweetalert2',
  express.static(path.join(process.cwd(), 'node_modules', 'sweetalert2', 'dist'), {
    maxAge: '7d',
    immutable: true,
  })
);

app.use(
  express.static(PUBLIC_DIR, {
    extensions: ['html'],
    maxAge: 0,
    etag: true,
  })
);

app.use((req, res) => {
  if (req.path.startsWith('/api/')) return res.status(404).json({ error: 'Endpoint tidak ditemukan.' });
  res.status(404).sendFile(path.join(PUBLIC_DIR, '404.html'));
});

app.use((err, req, res, _next) => {
  console.error('[error]', err);
  if (res.headersSent) return;
  res.status(500).json({ error: err.message || 'Terjadi kesalahan pada server.' });
});

/* ------------------------------------------------------------------ */
/* Utils                                                               */
/* ------------------------------------------------------------------ */

function isValidHttpUrl(value) {
  try {
    const url = new URL(String(value));
    return url.protocol === 'http:' || url.protocol === 'https:';
  } catch {
    return false;
  }
}

/* ------------------------------------------------------------------ */
/* Boot                                                                */
/* ------------------------------------------------------------------ */

app.listen(PORT, () => {
  console.log('');
  console.log('  ╭──────────────────────────────────────────────╮');
  console.log('  │   Webhook AI · WhatsApp + AI + Webhook        │');
  console.log('  ╰──────────────────────────────────────────────╯');
  console.log(`  URL    : http://localhost:${PORT}`);
  console.log('  Demo   : admin@webhook.ai / admin123');
  console.log('');

  resumeWhatsAppSessions();
});

/**
 * Saat server restart, sambungkan kembali sesi WhatsApp yang credentials-nya
 * masih tersimpan di auth_files/user-<id>/creds.json.
 */
function resumeWhatsAppSessions() {
  const root = path.join(process.cwd(), 'auth_files');
  if (!fs.existsSync(root)) return;

  for (const entry of fs.readdirSync(root)) {
    const match = /^user-(\d+)$/.exec(entry);
    if (!match) continue;

    const credsFile = path.join(root, entry, 'creds.json');
    if (!fs.existsSync(credsFile)) continue;

    const userId = Number(match[1]);
    connectWhatsApp(userId)
      .then(() => console.log(`  [wa] Sesi user ${userId} dipulihkan.`))
      .catch((err) => console.error(`  [wa] Gagal memulihkan sesi user ${userId}:`, err.message));
  }
}
