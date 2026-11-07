# Webhook AI

Dashboard webhook untuk WhatsApp dengan balasan otomatis berbasis AI, kini sebagai
**aplikasi SaaS gratis** — pengguna dapat mendaftar dan langsung memakai dashboard tanpa biaya.
Dibangun dengan **Node.js**, **Express**, **Baileys**, **MySQL**, dan **Tailwind CSS v4**.

![status](https://img.shields.io/badge/status-ready-34d399) ![node](https://img.shields.io/badge/node-%3E%3D22-22d3ee) ![mysql](https://img.shields.io/badge/mysql-8%2B-38bdf8) ![tailwind](https://img.shields.io/badge/tailwind-v4-38bdf8)

## Fitur

- 🆓 **SaaS gratis** — registrasi mandiri, tanpa kartu kredit, langsung memakai dashboard.
- 🔐 **Login & registrasi** dengan password hashing scrypt dan session cookie (MySQL).
- 👥 **Manajemen user** — admin dapat CRUD semua akun; user biasa hanya mengubah profilnya sendiri.
- 📱 **WhatsApp via Baileys** — pairing lewat QR, status koneksi real-time, auto reconnect.
- 🔗 **Webhook** — setiap pesan masuk diteruskan sebagai JSON dengan signature `HMAC-SHA256`.
- 🤖 **AI auto-reply** — dua format API: OpenAI-compatible dan **Ollama `/api/chat`**
  (Ollama Cloud atau lokal), dengan input **Model AI** bebas.
- 🗂️ **Riwayat aktivitas** — pesan masuk, balasan AI, pengiriman webhook, dan event sistem.
- 📐 **UI responsif** — Tailwind CSS v4, sidebar drawer di mobile, kartu adaptif di desktop,
  dialog konfirmasi & notifikasi **SweetAlert2** saat mode desktop.
- 🧪 **Uji webhook & uji AI** langsung dari dashboard.

## Setup di komputer lokal (localhost)

Prasyarat: **Node.js 22+**, **npm 10+**, dan **MySQL 8+ / MariaDB 10.6+**.

### 1. Siapkan MySQL / MariaDB

Aplikasi memakai database MySQL/MariaDB (default: `127.0.0.1:3306`, user `root`,
password kosong). Database **`webhook`** dibuat otomatis jika belum ada. Bila ingin
membuatnya manual:

```sql
CREATE DATABASE webhook CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;
```

Sesuaikan kredensial lewat variabel environment bila perlu:

```bash
DB_HOST=127.0.0.1 DB_PORT=3306 DB_USER=root DB_PASSWORD= DB_NAME=webhook npm start
```

Di Windows PowerShell:

```powershell
$env:DB_USER="root"; $env:DB_PASSWORD=""; $env:DB_NAME="webhook"; npm start
```

> Saat pertama dijalankan, aplikasi membuat seluruh tabel (users, sessions, webhooks,
> ai_settings, logs) dan memigrasikan data lama dari `data/app.db` (SQLite) secara
> otomatis **jika tabel `users` MySQL masih kosong**. File SQLite lama tidak diubah.

### 2. Pasang dependensi & jalankan

```bash
git clone https://github.com/USERNAME/REPO.git webhook-ai   # atau ekstrak ZIP
cd webhook-ai
npm install
npm start
```

Buka **http://localhost:3000**.

> `npm start` otomatis membangun ulang `public/css/app.css` dengan Tailwind CLI sebelum
> menjalankan server. Untuk pengembangan: `npm run dev` (watch mode Node).

### Akun demo

| Email            | Password | Role  |
| ---------------- | -------- | ----- |
| admin@webhook.ai | admin123 | admin |

Akun demo otomatis dibuat saat pertama kali server dijalankan (tombol isi-otomatis tidak lagi
ditampilkan di halaman login). Pengguna lain dapat mendaftar gratis lewat tab **Daftar** di
halaman login dan akan mendapat role `user`.

## Peran pengguna

| Aksi                              | Admin | User |
| --------------------------------- | :---: | :--: |
| Melihat daftar seluruh pengguna   |  ✅   |  ❌  |
| Menambah pengguna baru            |  ✅   |  ❌  |
| Mengubah data pengguna lain       |  ✅   |  ❌  |
| Mengubah role pengguna lain       |  ✅   |  ❌  |
| Menghapus pengguna                |  ✅   |  ❌  |
| Mengubah profil sendiri           |  ✅   |  ✅  |

Pengaman tambahan: admin tidak dapat menurunkan role atau menghapus akunnya sendiri,
dan sistem selalu menyisakan minimal satu admin.

## Struktur proyek

```
Webhhok-AI/
├─ app.cjs           # entry untuk Passenger (shared hosting cPanel)
├─ src/
│  ├─ server.js      # Express, routing API, session, role admin/user
│  ├─ db.js          # MySQL (mysql2) + skema, CRUD user, migrasi SQLite
│  ├─ auth.js        # hashing, cookie, signature
│  ├─ whatsapp.js    # Baileys: socket, QR, forward webhook, auto-reply
│  ├─ ai.js          # klien AI (OpenAI-compatible & Ollama /api/chat)
│  ├─ system.js      # update `git pull` GitHub + log terminal
│  └─ input.css      # sumber Tailwind v4
├─ public/
│  ├─ login.html     # halaman login/registrasi responsif
│  ├─ dashboard.html # dashboard + menu User & Pengaturan
│  ├─ css/app.css    # hasil build Tailwind
│  └─ js/            # login.js, dashboard.js
├─ data/             # app.db lama (sumber migrasi SQLite, opsional)
└─ auth_files/       # kredensial sesi Baileys (dibuat otomatis)
```

## Konfigurasi AI

Buka menu **AI Balasan**, isi:

| Field         | Contoh                                             |
| ------------- | -------------------------------------------------- |
| Base URL      | `https://ollama.com` atau `https://api.openai.com/v1` |
| Format API    | `Ollama (/api/chat)` atau `OpenAI-compatible`      |
| Model AI      | `gemma4:31b`, `gpt-4o-mini`, `llama-3.3-70b-versatile` |
| API key       | `sk-...` / `$OLLAMA_API_KEY`                       |
| System prompt | Gaya balasan yang Anda inginkan                    |

API key disimpan di database MySQL. Setelah diuji dengan tombol **Kirim uji**, aktifkan
toggle AI. Auto-reply hanya berlaku untuk **chat pribadi** (bukan grup).

### Ollama Cloud

Pilih **Format API → Ollama (/api/chat)**, Base URL `https://ollama.com`, lalu isi
Model AI (mis. `gemma4:31b`) dan API key Ollama Anda. Request yang dikirim server:

```bash
curl https://ollama.com/api/chat \
  -H "Authorization: Bearer $OLLAMA_API_KEY" \
  -H "Content-Type: application/json" \
  -d '{
    "model": "gemma4:31b",
    "messages": [{ "role": "user", "content": "Say hello in one sentence." }],
    "stream": false
  }'
```

Balasan Ollama (`message.content`) otomatis dibaca dan dikirim ke WhatsApp.

### Ollama lokal

Gunakan Base URL `http://localhost:11434`, format **Ollama**, model sesuai hasil
`ollama list`, dan API key bebas (mis. `ollama`).

## Format payload webhook

```json
{
  "event": "message",
  "from": "6281234567890@s.whatsapp.net",
  "pushName": "Budi",
  "isGroup": false,
  "text": "Halo, produknya masih ada?",
  "timestamp": 1762502400000,
  "webhookId": 1
}
```

Header yang dikirim:

- `Content-Type: application/json`
- `User-Agent: Webhook-AI/1.0`
- `X-Webhook-Event: message`
- `X-Webhook-Signature: sha256=<hmac>`

Secret tersedia di setiap kartu webhook (bagian *Secret & signature*).

### Verifikasi signature (Node.js)

```js
import crypto from 'node:crypto';

const secret = process.env.WEBHOOK_SECRET;
const rawBody = req.rawBody; // string body persis seperti diterima
const expected =
  'sha256=' + crypto.createHmac('sha256', secret).update(rawBody).digest('hex');

if (req.headers['x-webhook-signature'] !== expected) {
  return res.status(401).send('Invalid signature');
}
```

## API ringkas

| Method | Endpoint                 | Keterangan                     |
| ------ | ------------------------ | ------------------------------ |
| POST   | `/api/auth/login`        | Login                          |
| POST   | `/api/auth/register`     | Registrasi akun gratis         |
| GET    | `/api/me`                | Data pengguna aktif            |
| GET    | `/api/users`             | Daftar user (admin) / diri sendiri |
| POST   | `/api/users`             | Tambah user (admin)            |
| PATCH  | `/api/users/:id`         | Ubah user (admin / diri sendiri) |
| DELETE | `/api/users/:id`         | Hapus user (admin)             |
| GET    | `/api/overview`          | Statistik dashboard            |
| POST   | `/api/wa/connect`        | Mulai sesi WhatsApp + QR       |
| GET    | `/api/wa/status`         | Status koneksi                 |
| GET    | `/api/wa/qr`             | QR (data URL)                  |
| POST   | `/api/wa/logout`         | Putuskan WhatsApp              |
| GET    | `/api/webhooks`          | Daftar webhook                 |
| POST   | `/api/webhooks`          | Tambah webhook                 |
| PATCH  | `/api/webhooks/:id`      | Aktif/nonaktifkan              |
| POST   | `/api/webhooks/:id/test` | Kirim payload uji              |
| DELETE | `/api/webhooks/:id`      | Hapus webhook                  |
| GET    | `/api/ai`                | Pengaturan AI                  |
| PUT    | `/api/ai`                | Simpan pengaturan AI           |
| POST   | `/api/ai/test`           | Uji balasan AI                 |
| GET    | `/api/logs`              | Riwayat aktivitas              |
| DELETE | `/api/logs`              | Bersihkan riwayat              |
| GET    | `/api/system`            | Info repo + status token (admin) |
| PUT    | `/api/system/token`      | Simpan/hapus token GitHub (admin) |
| POST   | `/api/system/update`     | `git pull` + install + build CSS (admin) |
| POST   | `/api/system/migrate`    | Jalankan migrasi database (admin) |
| POST   | `/api/system/cache`      | Bersihkan sesi kedaluwarsa + cache QR (admin) |
| GET    | `/api/system/log`        | Isi terminal log (admin)       |
| DELETE | `/api/system/log`        | Kosongkan terminal log (admin) |

## Pembaruan aplikasi lewat dashboard

Menu **Pengaturan** (khusus admin) bisa dipakai untuk memperbarui aplikasi tanpa SSH:

1. Buat **fine-grained personal access token** di GitHub → *Settings → Developer settings →
   Personal access tokens → Fine-grained tokens*, akses hanya ke repo aplikasi ini, izin
   **Contents: Read**.
2. Tempel token di form **Token GitHub** → **Simpan token**. Token disimpan di tabel
   `app_settings` (bukan di `.env`) dan hanya ditampilkan 4 karakter terakhir.
3. Tekan **Update sekarang** → server menjalankan `git pull --ff-only`, lalu `npm install` dan
   `npm run build:css` bila ada commit baru. Semua output muncul di **Terminal log**.
4. **Restart** aplikasi dari panel hosting (Setup Node.js App → Restart) agar kode baru dipakai.
   Tombol **Hapus log** membersihkan isi terminal.

Tombol **Migrasi database** menjalankan ulang `runMigrations()` (tabel `app_settings` + kolom
baru) — aman dijalankan berulang. Tombol **Hapus cache** menghapus sesi login kedaluwarsa dan
gambar QR yang tersimpan di memori.

> Syarat: folder aplikasi harus berupa repo git dengan remote `origin` HTTPS
> (`git remote -v`). Token tidak pernah ditulis ke `.git/config` maupun ke log.

## Setup di VPS (disarankan)

Panduan langkah demi langkah juga tersedia langsung di dashboard, menu **Dokumentasi**.

Contoh Ubuntu + MySQL/MariaDB + PM2 + Nginx + HTTPS Let's Encrypt:

```bash
cd /var/www/webhook-ai
npm ci
npm run build:css

# Buat database + user MySQL (contoh)
sudo mysql -e "CREATE DATABASE webhook CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;"
sudo mysql -e "CREATE USER 'webhook'@'localhost' IDENTIFIED BY 'ganti-password';"
sudo mysql -e "GRANT ALL PRIVILEGES ON webhook.* TO 'webhook'@'localhost'; FLUSH PRIVILEGES;"

sudo npm install -g pm2
COOKIE_SECURE=1 DB_USER=webhook DB_PASSWORD='ganti-password' DB_NAME=webhook \
  pm2 start src/server.js --name webhook-ai
pm2 save && pm2 startup
```

Lalu arahkan Nginx ke `http://127.0.0.1:3000` dengan header
`X-Forwarded-For` dan `X-Forwarded-Proto`, dan pasang SSL:

```bash
sudo certbot --nginx -d domain-anda.com
```

Jangan memakai cluster mode — sesi Baileys hanya boleh dijalankan satu proses.

## Setup di shared hosting (cPanel)

**Syarat:** paket hosting menyediakan **terminal/SSH** dan **Node.js 22** (menu
*Setup Node.js App* / CloudLinux Passenger). Tanpa keduanya aplikasi ini tidak bisa jalan —
hosting PHP murni tidak cukup, karena bot WhatsApp butuh proses Node yang hidup terus.

1. **Upload kode & pasang dependensi** — simpan di luar `public_html`:

   ```bash
   cd ~
   git clone https://github.com/USERNAME/REPO.git webhook-ai   # atau upload ZIP via File Manager
   cd webhook-ai
   npm install
   npm run build:css
   ```

2. **Buat database** di cPanel → *MySQL® Databases* (buat database + user, lalu
   *Add User to Database → All Privileges*). Catat host `localhost`, nama database,
   user, dan password — di cPanel keduanya otomatis berawalan nama akun hosting.

3. **Daftarkan aplikasi** di cPanel → *Setup Node.js App → Create Application*:

   ```
   Node.js version          : 22
   Application root         : webhook-ai
   Application URL          : https://domain-anda.com
   Application startup file : app.cjs
   ```

   Tambahkan environment variable `DB_HOST=localhost`, `DB_PORT=3306`,
   `DB_USER=...`, `DB_PASSWORD=...`, `DB_NAME=...`, dan `COOKIE_SECURE=1`.

   > Startup file wajib `app.cjs`, bukan `src/server.js`. Passenger memuat startup file
   > dengan `require()`, sedangkan `src/server.js` adalah ESM dengan *top-level await*.
   > File `app.cjs` di root proyek hanya meneruskan ke `src/server.js`.

4. **Restart** aplikasi dari panel, lalu cek log: `tail -n 50 ~/logs/webhook-ai.log`.

5. **Jaga proses tetap hidup** — Passenger mematikan proses yang idle, sehingga koneksi
   WhatsApp putus. Tambahkan cron tiap 5 menit lewat *Cron Jobs*:

   ```
   */5 * * * * curl -s -o /dev/null https://domain-anda.com/login
   ```

Folder `auth_files/` (sesi WhatsApp) harus tetap di dalam application root agar tidak
perlu scan QR ulang setiap restart.

> **Satu proses saja.** Jangan biarkan Passenger/PM2 menjalankan lebih dari satu worker
> (`PassengerMaxPoolSize 1`, PM2 tanpa `-i`), dan jangan `npm start` di terminal saat panel
> sudah menjalankan aplikasi. Dua proses memakai `auth_files/` yang sama akan saling tendang
> (kode 440) sehingga status berganti-ganti *menyambung ↔ tersambung* tanpa henti. Aplikasi
> menolak menyambung bila sesi dipegang proses lain (file `auth_files/user-<id>/.owner`) dan
> berhenti mencoba setelah 12 percobaan reconnect.

## Platform cloud (Railway, Render, Fly.io)

- Sediakan **MySQL terkelola** (mis. Railway MySQL, PlanetScale, Aiven) dan set `DB_*`.
- Gunakan **persistent volume** untuk folder `auth_files/` (sesi Baileys).
- Jalankan proses long-running, bukan serverless (hindari Vercel/Netlify Functions).
- Set instance count **1** dan nonaktifkan autoscaling.
- Set environment `COOKIE_SECURE=1`.

## Variabel environment

| Variabel        | Default     | Fungsi                                             |
| --------------- | ----------- | -------------------------------------------------- |
| `PORT`          | `3000`      | Port HTTP server.                                  |
| `DB_HOST`       | `127.0.0.1` | Host MySQL/MariaDB.                                |
| `DB_PORT`       | `3306`      | Port MySQL.                                        |
| `DB_USER`       | `root`      | User database.                                     |
| `DB_PASSWORD`   | _(kosong)_  | Password database.                                 |
| `DB_NAME`       | `webhook`   | Nama database (dibuat otomatis bila belum ada).    |
| `COOKIE_SECURE` | kosong      | Isi `1` saat diakses via HTTPS (cookie `Secure`).  |
| `WA_LOG_LEVEL`  | `warn`      | Level log Baileys (`silent`, `warn`, `info`).      |

## Catatan

- Database MySQL dibuat otomatis beserta seluruh tabelnya saat server pertama kali jalan.
- Migrasi data SQLite lama berjalan sekali dan dilewati jika MySQL sudah berisi user.
- Folder `auth_files/` berisi kredensial sesi WhatsApp dan sudah masuk `.gitignore`.
- Untuk produksi: gunakan HTTPS + `COOKIE_SECURE=1`, backup database MySQL dan
  `auth_files/`, serta pertimbangkan enkripsi API key di database.
- Nomor WhatsApp yang dipakai sebaiknya bukan nomor utama (Baileys adalah implementasi
  tidak resmi).
