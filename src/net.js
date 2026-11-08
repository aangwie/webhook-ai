/* ==================================================================
   Webhook AI — validasi URL keluar (anti-SSRF)

   Semua URL diisi user (webhook, base URL AI). Tanpa validasi, siapa pun
   yang mendaftar bisa menyuruh server memanggil 127.0.0.1, IP LAN, atau
   endpoint metadata cloud (169.254.169.254) — "blind SSRF".
   ================================================================== */

import dns from 'node:dns/promises';
import net from 'node:net';

/** Self-host yang memang memakai layanan LAN bisa membuka blokir: ALLOW_PRIVATE_TARGETS=1 */
const ALLOW_PRIVATE = /^(1|true|yes|on)$/i.test(process.env.ALLOW_PRIVATE_TARGETS || '');

const PRIVATE = new net.BlockList();
for (const [addr, prefix] of [
  ['0.0.0.0', 8],
  ['10.0.0.0', 8],
  ['100.64.0.0', 10],
  ['127.0.0.0', 8],
  ['169.254.0.0', 16],
  ['172.16.0.0', 12],
  ['192.0.0.0', 24],
  ['192.168.0.0', 16],
  ['198.18.0.0', 15],
  ['224.0.0.0', 4],
  ['240.0.0.0', 4],
]) {
  PRIVATE.addSubnet(addr, prefix, 'ipv4');
}
for (const [addr, prefix] of [
  ['::', 128],
  ['::1', 128],
  ['fc00::', 7],
  ['fe80::', 10],
  ['ff00::', 8],
]) {
  PRIVATE.addSubnet(addr, prefix, 'ipv6');
}

/** Endpoint metadata cloud — selalu ditolak, termasuk untuk base URL AI. */
const METADATA = new net.BlockList();
METADATA.addSubnet('169.254.0.0', 16, 'ipv4');
METADATA.addSubnet('fe80::', 10, 'ipv6');
METADATA.addAddress('100.100.100.200', 'ipv4'); // Alibaba Cloud

export function isValidHttpUrl(value) {
  try {
    const url = new URL(String(value));
    return url.protocol === 'http:' || url.protocol === 'https:';
  } catch {
    return false;
  }
}

function isBlocked(address, { allowPrivate }) {
  const ip = String(address).replace(/^::ffff:/i, '');
  const family = net.isIP(ip) === 6 ? 'ipv6' : 'ipv4';
  if (net.isIP(ip) === 0) return true;
  if (METADATA.check(ip, family)) return true;
  return !allowPrivate && PRIVATE.check(ip, family);
}

/**
 * Tolak URL yang menunjuk jaringan internal.
 *
 * `allowPrivate` dipakai untuk base URL AI karena Ollama lokal
 * (http://127.0.0.1:11434) memang sah; metadata cloud tetap ditolak.
 *
 * ponytail: DNS diperiksa di sini, `fetch` me-resolve sendiri. Cukup untuk SSRF
 * buta; penyerang yang menguasai DNS (TTL 0) butuh agent dengan IP ter-pin.
 */
export async function assertPublicUrl(value, { allowPrivate = ALLOW_PRIVATE } = {}) {
  if (!isValidHttpUrl(value)) {
    throw new Error('URL harus http atau https yang valid.');
  }

  const url = new URL(String(value));
  const host = url.hostname.replace(/^\[|\]$/g, '');
  const addresses = net.isIP(host)
    ? [{ address: host }]
    : await dns.lookup(host, { all: true }).catch(() => {
        throw new Error(`Hostname ${host} tidak dapat di-resolve.`);
      });

  if (!addresses.length || addresses.some(({ address }) => isBlocked(address, { allowPrivate }))) {
    throw new Error('URL mengarah ke jaringan internal — ditolak.');
  }

  return url.toString();
}

/** Base URL AI: loopback/LAN boleh (Ollama lokal), metadata cloud tetap ditolak. */
export function assertAiBaseUrl(value) {
  return assertPublicUrl(value, { allowPrivate: true });
}
