/**
 * Pemeriksa pengerasan keamanan — jalankan lokal: `node check-security.mjs`
 *
 * Menguji bagian yang tidak butuh database/server hidup:
 *   1. anti-SSRF (src/net.js): alamat internal & metadata cloud ditolak
 *   2. base URL AI: Ollama lokal boleh, metadata cloud tetap ditolak
 *   3. parseCookies (src/auth.js) tidak crash pada cookie rusak
 *   4. hash password tetap cocok setelah di-hash
 */
import assert from 'node:assert';
import { assertAiBaseUrl, assertPublicUrl, isValidHttpUrl } from './src/net.js';
import { hashPassword, parseCookies, verifyPassword } from './src/auth.js';

let pass = 0;
const ok = (label) => {
  pass += 1;
  console.log(`  ok  ${label}`);
};

const rejects = async (label, url, options) => {
  await assert.rejects(() => assertPublicUrl(url, options), /internal|tidak dapat di-resolve/, label);
  ok(label);
};

/* 1. Skema URL */
assert.equal(isValidHttpUrl('https://domain.com/webhook'), true);
assert.equal(isValidHttpUrl('http://domain.com'), true);
assert.equal(isValidHttpUrl('file:///etc/passwd'), false);
assert.equal(isValidHttpUrl('javascript:alert(1)'), false);
assert.equal(isValidHttpUrl('bukan-url'), false);
ok('isValidHttpUrl hanya meloloskan http/https');

/* 2. Anti-SSRF: alamat internal harus ditolak */
await rejects('tolak 127.0.0.1', 'http://127.0.0.1/hook');
await rejects('tolak localhost', 'http://localhost:3000/hook');
await rejects('tolak metadata cloud 169.254.169.254', 'http://169.254.169.254/latest/meta-data/');
await rejects('tolak IP LAN 10.x', 'http://10.0.0.5/hook');
await rejects('tolak IP LAN 192.168.x', 'http://192.168.1.1/hook');
await rejects('tolak IPv6 loopback', 'http://[::1]/hook');
await rejects('tolak 0.0.0.0', 'http://0.0.0.0:8080/hook');

/* 3. URL publik (IP literal, tanpa DNS) harus lolos */
assert.equal(await assertPublicUrl('https://93.184.216.34/hook'), 'https://93.184.216.34/hook');
ok('izinkan alamat publik');

/* 4. Base URL AI: loopback boleh (Ollama lokal), metadata tetap ditolak */
assert.equal(await assertAiBaseUrl('http://127.0.0.1:11434'), 'http://127.0.0.1:11434/');
ok('izinkan Ollama lokal untuk base URL AI');
await assert.rejects(() => assertAiBaseUrl('http://169.254.169.254/latest'), /internal/);
ok('tetap tolak metadata cloud untuk AI');

/* 5. parseCookies tahan cookie rusak */
assert.equal(parseCookies('sid=%').sid, '%');
assert.equal(parseCookies('a=1; sid=abc%20def').sid, 'abc def');
assert.deepEqual(parseCookies(''), {});
ok('parseCookies tidak melempar pada cookie rusak');

/* 6. Password tetap terverifikasi dengan benar */
const stored = hashPassword('rahasia123');
assert.equal(verifyPassword('rahasia123', stored), true);
assert.equal(verifyPassword('salah', stored), false);
ok('hash & verifikasi password');

console.log(`\n${pass} pemeriksaan lulus.`);
