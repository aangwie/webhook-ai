import mysql from 'mysql2/promise';
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { hashPassword } from './auth.js';

const DB_HOST = process.env.DB_HOST || '127.0.0.1';
const DB_PORT = Number(process.env.DB_PORT) || 3306;
const DB_USER = process.env.DB_USER || 'root';
const DB_PASSWORD = process.env.DB_PASSWORD ?? '';
const DB_NAME = process.env.DB_NAME || 'webhook';

if (!/^[A-Za-z0-9_]+$/.test(DB_NAME)) {
  throw new Error('Nama database hanya boleh berisi huruf, angka, dan underscore.');
}

const baseConfig = {
  host: DB_HOST,
  port: DB_PORT,
  user: DB_USER,
  password: DB_PASSWORD,
  charset: 'utf8mb4',
};

/* Buat database bila belum ada, lalu buat pool koneksi. */
async function initPool() {
  const bootstrap = await mysql.createConnection(baseConfig);
  try {
    await bootstrap.query(
      `CREATE DATABASE IF NOT EXISTS \`${DB_NAME}\` CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci`
    );
  } finally {
    await bootstrap.end();
  }

  return mysql.createPool({
    ...baseConfig,
    database: DB_NAME,
    waitForConnections: true,
    connectionLimit: 10,
    queueLimit: 0,
    dateStrings: true,
  });
}

export const pool = await initPool();

/* ------------------------------------------------------------------ */
/* Schema                                                              */
/* ------------------------------------------------------------------ */

await pool.query(`
  CREATE TABLE IF NOT EXISTS users (
    id            INT UNSIGNED NOT NULL AUTO_INCREMENT,
    name          VARCHAR(100) NOT NULL,
    email         VARCHAR(190) NOT NULL,
    password_hash VARCHAR(255) NOT NULL,
    role          ENUM('admin','user') NOT NULL DEFAULT 'user',
    created_at    DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    updated_at    DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
    PRIMARY KEY (id),
    UNIQUE KEY uq_users_email (email)
  ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci
`);

await pool.query(`
  CREATE TABLE IF NOT EXISTS sessions (
    id         VARCHAR(64) NOT NULL,
    user_id    INT UNSIGNED NOT NULL,
    expires_at BIGINT NOT NULL,
    created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    PRIMARY KEY (id),
    KEY idx_sessions_user (user_id),
    CONSTRAINT fk_sessions_user FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
  ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci
`);

await pool.query(`
  CREATE TABLE IF NOT EXISTS webhooks (
    id         INT UNSIGNED NOT NULL AUTO_INCREMENT,
    user_id    INT UNSIGNED NOT NULL,
    name       VARCHAR(150) NOT NULL,
    url        VARCHAR(2048) NOT NULL,
    secret     VARCHAR(128) NOT NULL,
    events     VARCHAR(100) NOT NULL DEFAULT 'message',
    active     TINYINT(1) NOT NULL DEFAULT 1,
    created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    PRIMARY KEY (id),
    KEY idx_webhooks_user (user_id),
    CONSTRAINT fk_webhooks_user FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
  ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci
`);

await pool.query(`
  CREATE TABLE IF NOT EXISTS ai_settings (
    user_id       INT UNSIGNED NOT NULL,
    enabled       TINYINT(1) NOT NULL DEFAULT 0,
    api_style     ENUM('openai','ollama') NOT NULL DEFAULT 'openai',
    base_url      VARCHAR(500) NOT NULL DEFAULT 'https://api.openai.com/v1',
    api_key       VARCHAR(500) NOT NULL DEFAULT '',
    model         VARCHAR(120) NOT NULL DEFAULT 'gpt-4o-mini',
    system_prompt TEXT NOT NULL,
    updated_at    DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
    PRIMARY KEY (user_id),
    CONSTRAINT fk_ai_user FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
  ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci
`);

await pool.query(`
  CREATE TABLE IF NOT EXISTS logs (
    id         BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
    user_id    INT UNSIGNED NOT NULL,
    type       VARCHAR(30) NOT NULL,
    direction  VARCHAR(10) NOT NULL DEFAULT 'in',
    message    TEXT NOT NULL,
    meta       TEXT NULL,
    status     VARCHAR(20) NOT NULL DEFAULT 'ok',
    created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    PRIMARY KEY (id),
    KEY idx_logs_user_date (user_id, id DESC),
    CONSTRAINT fk_logs_user FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
  ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci
`);

/* ------------------------------------------------------------------ */
/* Migrasi                                                             */
/* ------------------------------------------------------------------ */

/**
 * Pastikan tabel/kolom tambahan tersedia. Dipanggil saat boot dan bisa
 * diulang kapan saja dari tombol "Migrasi database" di halaman Pengaturan.
 */
export async function runMigrations() {
  await pool.query(`
    CREATE TABLE IF NOT EXISTS app_settings (
      id           TINYINT UNSIGNED NOT NULL DEFAULT 1,
      github_token VARCHAR(255) NOT NULL DEFAULT '',
      updated_at   DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
      PRIMARY KEY (id)
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci
  `);

  /* Migrasi ringan untuk database yang dibuat sebelum kolom ini ada. */
  const [aiColumns] = await pool.query('SHOW COLUMNS FROM ai_settings');
  if (!aiColumns.some((column) => column.Field === 'api_style')) {
    await pool.query(
      "ALTER TABLE ai_settings ADD COLUMN api_style ENUM('openai','ollama') NOT NULL DEFAULT 'openai' AFTER enabled"
    );
  }

  const [userColumns] = await pool.query('SHOW COLUMNS FROM users');
  if (!userColumns.some((column) => column.Field === 'role')) {
    await pool.query("ALTER TABLE users ADD COLUMN role ENUM('admin','user') NOT NULL DEFAULT 'user' AFTER password_hash");
  }
}

await runMigrations();

/* ------------------------------------------------------------------ */
/* Helpers                                                             */
/* ------------------------------------------------------------------ */

async function rows(sql, params = []) {
  const [result] = await pool.query(sql, params);
  return result;
}

async function row(sql, params = []) {
  const result = await rows(sql, params);
  return result[0] ?? null;
}

/* ------------------------------------------------------------------ */
/* Users & sessions                                                    */
/* ------------------------------------------------------------------ */

const DEFAULT_SYSTEM_PROMPT =
  'Kamu adalah asisten WhatsApp yang ramah, singkat, dan membantu. Jawab dalam bahasa yang sama dengan pengguna.';

export async function findUserByEmail(email) {
  return row('SELECT * FROM users WHERE email = ? LIMIT 1', [
    String(email).toLowerCase().trim(),
  ]);
}

export async function findUserById(id) {
  return row('SELECT * FROM users WHERE id = ? LIMIT 1', [id]);
}

export async function listUsers() {
  return rows(`
    SELECT u.id, u.name, u.email, u.role, u.created_at, u.updated_at,
           (SELECT COUNT(*) FROM webhooks w WHERE w.user_id = u.id) AS webhooks,
           (SELECT COUNT(*) FROM logs l WHERE l.user_id = u.id) AS logs
      FROM users u
     ORDER BY u.id ASC
  `);
}

export async function countUsers() {
  const result = await row(
    "SELECT COUNT(*) AS total, SUM(role = 'admin') AS admins FROM users"
  );
  return { total: Number(result.total) || 0, admins: Number(result.admins) || 0 };
}

export async function createUser({ name, email, password, role = 'user' }) {
  const connection = await pool.getConnection();
  try {
    await connection.beginTransaction();

    const [info] = await connection.query(
      'INSERT INTO users (name, email, password_hash, role) VALUES (?, ?, ?, ?)',
      [
        String(name).trim(),
        String(email).toLowerCase().trim(),
        hashPassword(password),
        role === 'admin' ? 'admin' : 'user',
      ]
    );

    const userId = Number(info.insertId);
    await connection.query(
      'INSERT INTO ai_settings (user_id, system_prompt) VALUES (?, ?)',
      [userId, DEFAULT_SYSTEM_PROMPT]
    );

    await connection.commit();
    return findUserById(userId);
  } catch (error) {
    await connection.rollback();
    throw error;
  } finally {
    connection.release();
  }
}

export async function updateUser(id, fields) {
  const current = await findUserById(id);
  if (!current) return null;

  const next = {
    name: fields.name?.trim() || current.name,
    email: fields.email?.trim() ? String(fields.email).toLowerCase().trim() : current.email,
    role: fields.role === 'admin' || fields.role === 'user' ? fields.role : current.role,
    password: fields.password ? String(fields.password) : '',
  };

  const sets = ['name = ?', 'email = ?', 'role = ?'];
  const params = [next.name, next.email, next.role];

  if (next.password) {
    sets.push('password_hash = ?');
    params.push(hashPassword(next.password));
  }

  params.push(id);
  await pool.query(`UPDATE users SET ${sets.join(', ')} WHERE id = ?`, params);
  return findUserById(id);
}

export async function deleteUser(id) {
  const [result] = await pool.query('DELETE FROM users WHERE id = ?', [id]);
  return result.affectedRows > 0;
}

export async function createSession(userId, tokenHash, expiresAt) {
  await pool.query('INSERT INTO sessions (id, user_id, expires_at) VALUES (?, ?, ?)', [
    tokenHash,
    userId,
    expiresAt,
  ]);
}

export async function findSessionUser(tokenHash) {
  return row(
    `SELECT u.id, u.name, u.email, u.role, u.created_at
       FROM sessions s
       JOIN users u ON u.id = s.user_id
      WHERE s.id = ? AND s.expires_at > ?`,
    [tokenHash, Date.now()]
  );
}

export async function deleteSession(tokenHash) {
  await pool.query('DELETE FROM sessions WHERE id = ?', [tokenHash]);
}

export async function purgeExpiredSessions() {
  const [result] = await pool.query('DELETE FROM sessions WHERE expires_at <= ?', [Date.now()]);
  return result.affectedRows ?? 0;
}

/* ------------------------------------------------------------------ */
/* Pengaturan aplikasi (global)                                        */
/* ------------------------------------------------------------------ */

export async function getGithubToken() {
  const result = await row('SELECT github_token FROM app_settings WHERE id = 1');
  return result?.github_token || '';
}

export async function saveGithubToken(token) {
  await pool.query(
    'INSERT INTO app_settings (id, github_token) VALUES (1, ?) ON DUPLICATE KEY UPDATE github_token = VALUES(github_token)',
    [String(token ?? '')]
  );
}

/* ------------------------------------------------------------------ */
/* Webhooks                                                            */
/* ------------------------------------------------------------------ */

export async function listWebhooks(userId) {
  return rows('SELECT * FROM webhooks WHERE user_id = ? ORDER BY id DESC', [userId]);
}

export async function activeWebhooks(userId) {
  return rows('SELECT * FROM webhooks WHERE user_id = ? AND active = 1 ORDER BY id ASC', [
    userId,
  ]);
}

export async function getWebhook(userId, id) {
  return row('SELECT * FROM webhooks WHERE user_id = ? AND id = ?', [userId, id]);
}

export async function createWebhook(userId, { name, url, events, secret }) {
  const info = await row(
    'INSERT INTO webhooks (user_id, name, url, secret, events) VALUES (?, ?, ?, ?, ?)',
    [userId, name, url, secret, events || 'message']
  );
  return getWebhook(userId, Number(info.insertId));
}

export async function updateWebhook(userId, id, fields) {
  const current = await getWebhook(userId, id);
  if (!current) return null;

  const next = {
    name: fields.name ?? current.name,
    url: fields.url ?? current.url,
    events: fields.events ?? current.events,
    active: fields.active === undefined ? current.active : fields.active ? 1 : 0,
  };

  await pool.query(
    'UPDATE webhooks SET name = ?, url = ?, events = ?, active = ? WHERE user_id = ? AND id = ?',
    [next.name, next.url, next.events, next.active, userId, id]
  );

  return getWebhook(userId, id);
}

export async function deleteWebhook(userId, id) {
  const [result] = await pool.query('DELETE FROM webhooks WHERE user_id = ? AND id = ?', [
    userId,
    id,
  ]);
  return result.affectedRows > 0;
}

/* ------------------------------------------------------------------ */
/* AI settings                                                         */
/* ------------------------------------------------------------------ */

export async function getAiSettings(userId) {
  return row('SELECT * FROM ai_settings WHERE user_id = ?', [userId]);
}

export async function saveAiSettings(userId, fields) {
  const current = await getAiSettings(userId);
  if (!current) return null;

  const style = fields.api_style;
  const next = {
    enabled: fields.enabled === undefined ? current.enabled : fields.enabled ? 1 : 0,
    api_style: style === 'ollama' || style === 'openai' ? style : current.api_style,
    base_url: fields.base_url?.trim() || current.base_url,
    api_key: fields.api_key?.trim() ? fields.api_key.trim() : current.api_key,
    model: fields.model?.trim() || current.model,
    system_prompt: fields.system_prompt?.trim() || current.system_prompt,
  };

  await pool.query(
    'UPDATE ai_settings SET enabled = ?, api_style = ?, base_url = ?, api_key = ?, model = ?, system_prompt = ? WHERE user_id = ?',
    [
      next.enabled,
      next.api_style,
      next.base_url,
      next.api_key,
      next.model,
      next.system_prompt,
      userId,
    ]
  );

  return getAiSettings(userId);
}

/* ------------------------------------------------------------------ */
/* Logs                                                                */
/* ------------------------------------------------------------------ */

export async function addLog(
  userId,
  { type, direction = 'in', message, meta = null, status = 'ok' }
) {
  await pool.query(
    'INSERT INTO logs (user_id, type, direction, message, meta, status) VALUES (?, ?, ?, ?, ?, ?)',
    [userId, type, direction, message, meta ? JSON.stringify(meta) : null, status]
  );
}

export async function listLogs(userId, limit = 60) {
  const safeLimit = Math.min(Math.max(Number(limit) || 60, 1), 200);
  return rows('SELECT * FROM logs WHERE user_id = ? ORDER BY id DESC LIMIT ?', [
    userId,
    safeLimit,
  ]);
}

export async function countLogs(userId) {
  const result = await row('SELECT COUNT(*) AS total FROM logs WHERE user_id = ?', [userId]);
  return Number(result.total) || 0;
}

export async function clearLogs(userId) {
  const [result] = await pool.query('DELETE FROM logs WHERE user_id = ?', [userId]);
  return result.affectedRows;
}

/* ------------------------------------------------------------------ */
/* Seed demo account                                                   */
/* ------------------------------------------------------------------ */

export async function seedDemoUser() {
  const email = 'admin@webhook.ai';
  const existing = await findUserByEmail(email);
  if (existing) {
    if (existing.role !== 'admin') {
      await pool.query("UPDATE users SET role = 'admin' WHERE id = ?", [existing.id]);
    }
    return existing;
  }

  const user = await createUser({
    name: 'Admin Demo',
    email,
    password: 'admin123',
    role: 'admin',
  });

  await pool.query(
    'INSERT INTO webhooks (user_id, name, url, secret, events, active) VALUES (?, ?, ?, ?, ?, 0)',
    [
      user.id,
      'Contoh Webhook',
      'https://example.com/webhook',
      crypto.randomBytes(24).toString('hex'),
      'message',
    ]
  );

  await addLog(user.id, {
    type: 'system',
    direction: 'out',
    message: 'Akun demo siap digunakan. Hubungkan WhatsApp untuk mulai menerima pesan.',
    status: 'ok',
  });

  return user;
}

/* ------------------------------------------------------------------ */
/* Migrasi data dari SQLite lama (data/app.db)                         */
/* ------------------------------------------------------------------ */

export async function migrateLegacySqlite() {
  const sqliteFile = path.join(process.cwd(), 'data', 'app.db');
  if (!fs.existsSync(sqliteFile)) return { skipped: true, reason: 'file SQLite tidak ditemukan' };

  const count = await row('SELECT COUNT(*) AS total FROM users');
  if (Number(count.total) > 0) {
    return { skipped: true, reason: 'database MySQL sudah berisi data' };
  }

  const { DatabaseSync } = await import('node:sqlite');
  const sqlite = new DatabaseSync(sqliteFile, { readOnly: true });

  const safeAll = (sql) => {
    try {
      return sqlite.prepare(sql).all();
    } catch {
      return [];
    }
  };

  const users = safeAll('SELECT * FROM users ORDER BY id ASC');
  const sessions = safeAll('SELECT * FROM sessions ORDER BY created_at ASC');
  const webhooks = safeAll('SELECT * FROM webhooks ORDER BY id ASC');
  const aiSettings = safeAll('SELECT * FROM ai_settings');
  const logs = safeAll('SELECT * FROM logs ORDER BY id ASC');

  const connection = await pool.getConnection();
  try {
    await connection.beginTransaction();

    for (const user of users) {
      await connection.query(
        'INSERT IGNORE INTO users (id, name, email, password_hash, role, created_at) VALUES (?, ?, ?, ?, ?, ?)',
        [
          user.id,
          user.name,
          String(user.email).toLowerCase().trim(),
          user.password_hash,
          String(user.email).toLowerCase().trim() === 'admin@webhook.ai' ? 'admin' : 'user',
          user.created_at || new Date(),
        ]
      );
    }

    for (const session of sessions) {
      await connection.query(
        'INSERT IGNORE INTO sessions (id, user_id, expires_at, created_at) VALUES (?, ?, ?, ?)',
        [session.id, session.user_id, session.expires_at, session.created_at || new Date()]
      );
    }

    for (const hook of webhooks) {
      await connection.query(
        'INSERT IGNORE INTO webhooks (id, user_id, name, url, secret, events, active, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)',
        [
          hook.id,
          hook.user_id,
          hook.name,
          hook.url,
          hook.secret,
          hook.events || 'message',
          hook.active ? 1 : 0,
          hook.created_at || new Date(),
        ]
      );
    }

    for (const settings of aiSettings) {
      await connection.query(
        'INSERT IGNORE INTO ai_settings (user_id, enabled, api_style, base_url, api_key, model, system_prompt) VALUES (?, ?, ?, ?, ?, ?, ?)',
        [
          settings.user_id,
          settings.enabled ? 1 : 0,
          settings.api_style === 'ollama' ? 'ollama' : 'openai',
          settings.base_url || 'https://api.openai.com/v1',
          settings.api_key || '',
          settings.model || 'gpt-4o-mini',
          settings.system_prompt || DEFAULT_SYSTEM_PROMPT,
        ]
      );
    }

    for (const log of logs) {
      await connection.query(
        'INSERT IGNORE INTO logs (id, user_id, type, direction, message, meta, status, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)',
        [
          log.id,
          log.user_id,
          log.type,
          log.direction || 'in',
          log.message,
          log.meta ?? null,
          log.status || 'ok',
          log.created_at || new Date(),
        ]
      );
    }

    await connection.commit();

    return {
      skipped: false,
      users: users.length,
      sessions: sessions.length,
      webhooks: webhooks.length,
      aiSettings: aiSettings.length,
      logs: logs.length,
    };
  } catch (error) {
    await connection.rollback();
    throw error;
  } finally {
    connection.release();
    sqlite.close();
  }
}

export async function closeDatabase() {
  await pool.end();
}
