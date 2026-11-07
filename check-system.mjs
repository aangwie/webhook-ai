/**
 * Pemeriksa `src/system.js` — jalankan lokal: `node check-system.mjs`
 * (butuh git; tidak untuk dijalankan di server produksi).
 *
 * Menguji: deteksi folder non-repo, guard token, init otomatis, penolakan
 * remote non-HTTP, dan alur bootstrap `git init → fetch → reset --hard →
 * checkout -B` (file .env/data/node_modules harus selamat).
 */
import assert from 'node:assert';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const root = fs.mkdtempSync(path.join(os.tmpdir(), 'webhook-ai-check-'));
const upstream = path.join(root, 'upstream');
const bare = path.join(root, 'upstream.git');
const app = path.join(root, 'app');

const git = (cwd, ...args) =>
  execFileSync('git', args, { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();
const write = (file, text) => {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, text);
};

try {
  /* Repo "GitHub" versi baru. */
  write(path.join(upstream, 'package.json'), '{"name":"webhook-ai","version":"2.0.0"}');
  write(path.join(upstream, 'src/server.js'), '// versi baru dari GitHub');
  write(path.join(upstream, '.gitignore'), 'node_modules/\ndata/\nauth_files/\n.env\n');
  git(upstream, 'init', '-q', '-b', 'main');
  git(upstream, 'add', '-A');
  git(upstream, '-c', 'user.email=t@t', '-c', 'user.name=t', 'commit', '-qm', 'v2');
  execFileSync('git', ['clone', '-q', '--bare', upstream, bare]);

  /* Folder hosting: hasil unzip, tanpa .git, berisi data lokal. */
  write(path.join(app, 'package.json'), '{"name":"webhook-ai","version":"1.0.0"}');
  write(path.join(app, 'src/server.js'), '// versi lama hasil unzip');
  write(path.join(app, '.env'), 'DB_PASSWORD=rahasia');
  write(path.join(app, 'data/app.db'), 'sqlite lama');
  write(path.join(app, 'node_modules/pkg/index.js'), 'x');

  process.env.GIT_REMOTE = bare;
  process.chdir(app);
  const { getRepoInfo, updateFromGithub, readSystemLog } = await import('./src/system.js');

  /* 1) Folder non-repo: UI tetap tahu remote tujuan. */
  const info = await getRepoInfo();
  assert.strictEqual(info.git, false);
  assert.strictEqual(info.remote, bare);
  assert.strictEqual(info.branch, 'main');

  /* 2) Token belum disimpan. */
  await assert.rejects(() => updateFromGithub(''), /token GitHub terlebih dahulu/i);

  /* 3) Repo disiapkan otomatis, lalu remote non-HTTP ditolak; token tak bocor. */
  const token = 'tok_rahasia_abcdefghijklmnop';
  await assert.rejects(() => updateFromGithub(token), /bukan URL HTTP/i);
  assert.ok(fs.existsSync(path.join(app, '.git')), '.git harus dibuat otomatis');
  assert.strictEqual(git(app, 'remote', 'get-url', 'origin'), bare);
  const log = readSystemLog();
  assert.match(log, /menyiapkan otomatis/);
  assert.ok(!log.includes(token), 'token bocor di log');

  /* 4) Bootstrap seperti bootstrapRepo(): kode baru masuk, data lokal selamat. */
  git(app, 'fetch', bare, 'main');
  git(app, 'reset', '--hard', 'FETCH_HEAD');
  git(app, 'checkout', '-B', 'main');
  assert.strictEqual(git(app, 'symbolic-ref', '--short', 'HEAD'), 'main');
  assert.strictEqual(fs.readFileSync(path.join(app, 'src/server.js'), 'utf8').trim(), '// versi baru dari GitHub');
  assert.match(fs.readFileSync(path.join(app, 'package.json'), 'utf8'), /2\.0\.0/);
  assert.strictEqual(fs.readFileSync(path.join(app, '.env'), 'utf8').trim(), 'DB_PASSWORD=rahasia');
  assert.ok(fs.existsSync(path.join(app, 'data/app.db')));
  assert.ok(fs.existsSync(path.join(app, 'node_modules/pkg/index.js')));

  console.log('OK: deteksi non-repo, guard token, init otomatis, bootstrap, data lokal aman');
} finally {
  process.chdir(os.tmpdir()); // Windows tidak bisa hapus folder yang jadi cwd
  fs.rmSync(root, { recursive: true, force: true, maxRetries: 3 });
}
