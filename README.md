# DLMM Exit Agent

Agent otomatis untuk **exit posisi DLMM Meteora** di Solana. Begitu RSI(2) + Bollinger Band nyentuh threshold, agent langsung cairin semua posisi — claim fee, remove liquidity, close position.

---

## Persyaratan (Buat Pemula)

Yang perlu kamu siapkan:

| Kebutuhan | Keterangan |
|-----------|------------|
| **Node.js 18+** | Install dari [nodejs.org](https://nodejs.org) (ambil LTS) |
| **Git** | Download dari [git-scm.com](https://git-scm.com) |
| **VPS / PC 24 jam** | Biar agent jalan terus (bisa pakai [Contabo](https://contabo.com), [DigitalOcean](https://digitalocean.com), atau bahkan laptop kamu sendiri) |

Cek udah terinstall atau belum:

```bash
node -v   # harus >= 18
npm -v    # harus >= 8
git --version
```

---

## Cara Install (Langkah demi Langkah)

### 1. Clone repo

```bash
git clone https://github.com/Mavour/exitBot.git
cd exitBot
```

### 2. Install dependencies

```bash
npm install
```

### 3. Siapkan file konfigurasi

```bash
cp .env.example .env
```

### 4. Isi file `.env`

Buka file `.env` pake notepad / VS Code, isi bagian yang wajib:

#### `RPC_URL` (WAJIB)
Ini alamat koneksi ke Solana. Daftar gratis di:
- [Helius](https://www.helius.dev) — gratis 25k request/bulan
- [QuickNode](https://www.quicknode.com) — gratis 50k request/bulan
- Atau pake public RPC (kurang stabil): `https://api.mainnet-beta.solana.com`

Contoh hasil:
```
RPC_URL=https://mainnet.helius-rpc.com/?api-key=isi_api_key_kamu
```

#### `WALLET_PRIVATE_KEY` (WAJIB)
Private key dompet Solana yang **punya posisi DLMM**.

**Cara export dari Phantom:**
1. Buka Phantom → Settings → Security & Privacy → Export Private Key
2. Copy key-nya (bentuk base58, misal `5KJ...`)

**Cara export dari Backpack:**
1. Settings → Export Private Key
2. Copy key-nya

Tempel ke file `.env`:
```
WALLET_PRIVATE_KEY=5KJ...isi_private_key_kamu...
```
> ⚠️ **Jangan share private key ini ke siapa pun!** File `.env` jangan di-commit ke GitHub.

#### `GMGN_API_KEY` (WAJIB)
Daftar di [GMGN OpenAPI](https://openapi.gmgn.ai) untuk dapetin API key. Gratis.
```
GMGN_API_KEY=isi_gmgn_api_key_kamu
```

#### Telegram (OPSIONAL)
Biar dapet notifikasi ke Telegram kalau ada exit.

**Cara bikin bot Telegram:**
1. Buka Telegram, cari **@BotFather**
2. Ketik `/newbot`, ikutin instruksi
3. Dapet **bot token** — isiin ke `TELEGRAM_BOT_TOKEN`
4. Cari **@userinfobot**, ketik `/start` — dapet **chat ID** — isiin ke `TELEGRAM_CHAT_ID`

### 5. Test jalan (dry run — default)

```bash
npm run dev
```

Mode `DRY_RUN=true` artinya agent CIMAIN aja — nggak beneran execute exit. Cocok buat tes.

### 6. Live run (kalau udah yakin)

Edit `.env`, ganti:
```
DRY_RUN=false
```

Jalanin ulang:
```bash
npm run dev
```

---

## Deploy ke VPS (Biar Jalan 24 Jam)

### 1. Build dulu

```bash
npm run build
```

### 2. Install PM2 (process manager)

```bash
npm install -g pm2
```

### 3. Jalanin dengan PM2

```bash
pm2 start ecosystem.config.js
```

### 4. Biar otomatis jalan pas VPS restart

```bash
pm2 startup
pm2 save
```

### 5. Cek log

```bash
pm2 logs dlmm-exit-agent
```

---

## Cara Kerja

Agent ngecek tiap 60 detik. Untuk setiap posisi DLMM aktif di dompet kamu:

1. Ambil data 20 candle 15 menit terakhir dari GMGN API
2. Hitung **RSI(2)** + **Bollinger Band(20, 2σ)**
3. Kalau PNL <= -10% -> execute exit langsung sebagai hard stop-loss
4. Kalau RSI >= 90 **DAN** harga > BB Atas -> execute exit

Hard stop-loss ini **hardcoded di -10%**, bukan setting `.env` atau menu Telegram. Trigger ini bypass `EXIT_COOLDOWN_MINUTES` supaya posisi rugi berat langsung ditutup.

**Urutan exit:**
1. Claim semua unclaimed swap fees
2. Cairin semua liquidity dari semua bin
3. Tutup position account (SOL rent balik)

---

## Konfigurasi Lengkap

| Variable | Default | Wajib? | Deskripsi |
|----------|---------|--------|-----------|
| `RPC_URL` | — | ✅ | Solana RPC endpoint |
| `RPC_URL_FALLBACK_1` | `api.mainnet-beta.solana.com` | ❌ | RPC cadangan |
| `RPC_URL_FALLBACK_2` | `solana-mainnet.g.alchemy.com` | ❌ | RPC cadangan |
| `WALLET_PRIVATE_KEY` | — | ✅ | Private key dompet (base58) |
| `GMGN_API_KEY` | — | ✅ | API key dari GMGN OpenAPI |
| `POLL_INTERVAL_MS` | 60000 | ❌ | Interval pengecekan (ms) |
| `EXIT_COOLDOWN_MINUTES` | 3 | ❌ | Waktu tunggu setelah posisi terdeteksi sebelum exit trigger non-SL aktif |
| `DRY_RUN` | true | ❌ | `true` = simulasi aja, `false` = beneran exit |
| `RSI_PERIOD` | 2 | ❌ | Period RSI |
| `RSI_THRESHOLD` | 90 | ❌ | Ambang batas RSI buat exit |
| `TRAILING_ARM_PERCENT` | 5 | ❌ | PNL minimal untuk mengaktifkan trailing profit |
| `TRAILING_DROP_PERCENT` | 1.5 | ❌ | Penurunan PNL dari peak yang memicu trailing exit |
| `BB_PERIOD` | 20 | ❌ | Period Bollinger Band |
| `BB_STD_DEV` | 2 | ❌ | Standar deviasi BB |
| `PRIORITY_FEE_MICROLAMPORTS` | 100000 | ❌ | Priority fee Solana |
| `SLIPPAGE_BPS` | 100 | ❌ | Slippage (100 = 1%) |
| `COMMITMENT` | confirmed | ❌ | Level komitmen transaksi |
| `TELEGRAM_BOT_TOKEN` | — | ❌ | Token bot Telegram |
| `TELEGRAM_CHAT_ID` | — | ❌ | Chat ID Telegram |

---

## Catatan Penting

- Selalu test pake `DRY_RUN=true` dulu sebelum live
- Pastikan dompet punya **≥ 0.01 SOL** buat fee transaksi
- Agent bakal EXIT SEMUA posisi aktif yang memenuhi kondisi — bukan cuma 1
- RSI(2) itu sensitif — bisa trigger lebih sering dari RSI biasa
- Kalau ada error `Insufficient candle data` — artinya token baru banget (perlu 20 candle 15m ≈ 5 jam data). Sabar aja nunggu
- Private key jangan pernah dishare atau di-commit ke GitHub

---

## Troubleshooting

| Masalah | Solusi |
|---------|--------|
| `Missing required environment variable: RPC_URL` | Isi `.env` dengan RPC URL yang valid |
| `Insufficient candle data: got X, need 20` | Token terlalu baru, tunggu beberapa jam |
| `fetch failed` | Cek koneksi internet / ganti RPC |
| Error aneh waktu `npm install` | Pastikan Node.js ≥ 18, jalanin `npm install` ulang |
| Agent nggak jalan di VPS | Cek log pake `pm2 logs`, pastikan `.env` ada |
