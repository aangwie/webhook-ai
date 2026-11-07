/* ==================================================================
   Webhook AI — utilitas sistem
   Update kode dari GitHub + log yang ditampilkan di terminal dashboard.
   ================================================================== */

import { execFile } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { promisify } from 'node:util';

const run = promisify(execFile);
const DATA_DIR = path.join(process.cwd(), 'data');
const LOG_FILE = path.join(DATA_DIR, 'system.log');
const LOG_MAX_BYTES = 200 * 1024;
const MAX_BUFFER = 8 * 1024 * 1024;
const NPM = process.platform === 'win32' ? 'npm.cmd' : 'npm';

let updating = false;
let secret = '';

function stamp() {
  return new Date().toISOString().replace('T', ' ').slice(0, 19);
}

/** Jangan pernah menulis token GitHub ke log. */
function sanitize(text) {
  const value = String(text ?? '');
  return secret ? value.split(secret).join('***') : value;
}

export function appendSystemLog(line) {
  fs.mkdirSync(DATA_DIR, { recursive: true });
  try {
    if (fs.statSync(LOG_FILE).size > LOG_MAX_BYTES) fs.writeFileSync(LOG_FILE, '');
  } catch {
    /* file belum ada */
  }
  fs.appendFileSync(LOG_FILE, `[${stamp()}] ${sanitize(line)}\n`);
}

export function readSystemLog() {
  try {
    return fs.readFileSync(LOG_FILE, 'utf8');
  } catch {
    return '';
  }
}

export function clearSystemLog() {
  fs.mkdirSync(DATA_DIR, { recursive: true });
  fs.writeFileSync(LOG_FILE, '');
}

function git(args) {
  return run('git', args, { cwd: process.cwd(), maxBuffer: MAX_BUFFER }).then(({ stdout }) => stdout.trim());
}

function npm(args) {
  // npm.cmd di Windows butuh shell; argumen di sini selalu literal jadi aman.
  return run(NPM, args, { cwd: process.cwd(), shell: process.platform === 'win32', maxBuffer: MAX_BUFFER });
}

export async function getRepoInfo() {
  try {
    const [remote, branch] = await Promise.all([
      git(['remote', 'get-url', 'origin']),
      git(['rev-parse', '--abbrev-ref', 'HEAD']),
    ]);
    return { git: true, remote: sanitize(remote), branch: branch || 'main' };
  } catch (error) {
    return { git: false, remote: '', branch: '', error: error.message };
  }
}

/**
 * `git pull` memakai URL bertoken (tidak ditulis ke .git/config), lalu
 * `npm install` + build CSS bila ada commit baru.
 */
export async function updateFromGithub(token) {
  if (updating) throw new Error('Pembaruan lain sedang berjalan. Tunggu sampai selesai.');
  if (!token) throw new Error('Simpan token GitHub terlebih dahulu.');

  updating = true;
  secret = token;

  try {
    appendSystemLog('— Mulai pembaruan dari GitHub —');

    const remote = await git(['remote', 'get-url', 'origin']);
    const branch = (await git(['rev-parse', '--abbrev-ref', 'HEAD'])) || 'main';
    const before = await git(['rev-parse', 'HEAD']);

    const url = new URL(remote);
    if (!/^https?:$/.test(url.protocol)) {
      throw new Error('Remote origin bukan URL HTTP(S), token tidak bisa dipakai.');
    }
    url.username = 'x-access-token';
    url.password = token;

    appendSystemLog(`Remote : ${url.origin}${url.pathname}`);
    appendSystemLog(`Branch : ${branch}`);
    appendSystemLog(`HEAD   : ${before.slice(0, 7)}`);

    const pull = await run('git', ['pull', '--ff-only', url.toString(), branch], {
      cwd: process.cwd(),
      maxBuffer: MAX_BUFFER,
    });
    appendSystemLog(`$ git pull --ff-only ${branch}`);
    appendSystemLog(pull.stdout.trim() || '(tanpa output)');
    if (pull.stderr.trim()) appendSystemLog(pull.stderr.trim());

    const after = await git(['rev-parse', 'HEAD']);
    const changed = before !== after;

    if (changed) {
      appendSystemLog(`Commit baru: ${before.slice(0, 7)} → ${after.slice(0, 7)}`);

      appendSystemLog('$ npm install');
      const install = await npm(['install', '--no-audit', '--no-fund']);
      appendSystemLog(install.stdout.trim() || '(tanpa output)');

      appendSystemLog('$ npm run build:css');
      const build = await npm(['run', 'build:css']);
      appendSystemLog(build.stdout.trim() || '(tanpa output)');

      appendSystemLog('Restart aplikasi dari panel hosting agar perubahan dipakai.');
    } else {
      appendSystemLog('Tidak ada perubahan — kode sudah versi terbaru.');
    }

    appendSystemLog('— Pembaruan selesai —');
    return { ok: true, changed, branch, before, after };
  } catch (error) {
    const message = sanitize(error.stderr?.trim() || error.message || 'Pembaruan gagal.');
    appendSystemLog(`GAGAL: ${message}`);
    throw new Error(message.slice(0, 500));
  } finally {
    updating = false;
    secret = '';
  }
}
