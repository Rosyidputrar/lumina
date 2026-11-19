# Lumina

Terminal trading full-stack: analisis pasar yang bisa dijelaskan, risk gate yang menghitung ukuran setiap order dari jarak stop-loss, eksekusi paper (dan MT5 live bila diaktifkan owner), backtest, analis AI, vault riset, dan berbagi file.

```
lumina/
├── backend/    API + engine Node.js 22 (tanpa framework, SQLite bawaan node:sqlite)
├── frontend/   React 18 + TypeScript + Vite, dibangun ke backend/public
├── Dockerfile  satu image: build frontend, lalu jalankan backend
└── docker-compose.yml
```

Backend melayani aplikasi dan API dari origin yang sama, sehingga tidak ada masalah CORS dan cookie sesi tetap HttpOnly.

## Menjalankan secara lokal

Butuh Node.js 22.5 atau lebih baru.

```sh
npm run install:all            # install dependency backend dan frontend
cp backend/.env.example backend/.env
# isi minimal LUMINA_LICENSE_SECRET dan LUMINA_OWNER_SECRET di backend/.env

set -a; . backend/.env; set +a # muat variabel ke shell
npm run seed                   # mencetak kunci lisensi trial, mis. LV-XXXXX-XXXXX-XXXXX-XXXXX
npm run build                  # build frontend ke backend/public
npm start                      # http://127.0.0.1:8787
```

Buka http://127.0.0.1:8787, masukkan kunci dari `npm run seed`, atau pilih **Owner** dan masukkan `LUMINA_OWNER_SECRET` untuk membuka owner console.

### Mode pengembangan (hot reload)

```sh
npm run dev:api    # backend di :8787 (node --watch)
npm run dev:web    # frontend di http://localhost:5173, /api diproksikan ke :8787
```

### Tes

```sh
npm test           # 36 tes backend (node:test) + tes unit frontend (vitest) + typecheck
```

## Docker

```sh
docker compose up --build -d   # membaca backend/.env, data disimpan di volume lumina-data
```

Dengan `NODE_ENV=production` (default di image), server menolak start bila `LUMINA_LICENSE_SECRET` belum diisi.

## Fitur

| Layar | Fungsi | Endpoint utama |
|---|---|---|
| Aktivasi | Kunci lisensi, access ID + code untuk perangkat kedua, login owner | `/api/licence/activate`, `/api/login`, `/api/owner/login` |
| Overview | Equity, P&L, kurva equity, posisi, sinyal, watchlist, status engine, risk envelope | `/api/terminal`, `/api/stream` (SSE) |
| Markets | Chart candlestick + EMA/VWAP + level plan, rincian faktor skor, briefing, tiket market/pending | `/api/analysis`, `/api/ai/explain`, `/api/positions`, `/api/pending-orders` |
| Positions | Posisi terbuka (ubah SL/TP, tutup), pending order, riwayat | `/api/positions`, `PATCH /api/positions/:id` |
| Signals | Scanner seluruh watchlist dengan alasan penolakan, eksekusi/abaikan sinyal, jalankan siklus | `/api/analysis/sweep`, `/api/signals/:id/*`, `/api/analysis/run` |
| Analyst | Tanya jawab, trade dari teks, cek target profit | `/api/ai/ask`, `/api/ai/trade-intent`, `/api/ai/goal` |
| Journal | Statistik, trade tertutup, per pasar, order, ekspor CSV | `/api/journal` |
| Backtest | Replay playbook + risk gate di candle asli | `/api/backtest` |
| Vault | Catatan ber-wikilink, backlink, pencarian, buat/hapus catatan, konsolidasi memori | `/api/vault*`, `/api/memory*` |
| Files | Upload dengan progres, publish/private, rotasi link, hapus | `/api/files*`, `/f/:token` |
| News | Feed RSS/JSON dari owner | `/api/news` |
| Settings | Preferensi trading, live trading, akun broker terenkripsi, lisensi, tema | `/api/settings/preferences`, `/api/broker/profile`, `/api/account/live` |
| Owner console | Terbitkan/cabut/perpanjang lisensi, engine & gaya trading, batas risiko, watchlist, provider AI, audit | `/api/owner/*` |

## Data pasar

Tanpa gateway MT5, watchlist default memakai data publik OKX dan Kraken (BTC, ETH, SOL, EUR/USD, GBP/USD, emas PAXG). Dengan `MT5_GATEWAY_URL` dan `MT5_GATEWAY_KEY`, watchlist default beralih ke simbol MT5. Owner bisa mengubah watchlist dari owner console.

## Keamanan

- Sesi lisensi dan owner di cookie HttpOnly; tidak ada rahasia di JavaScript atau localStorage.
- Setiap request yang mengubah data dicek origin-nya (CSRF) di server.
- Otorisasi di server: posisi, file, dan catatan vault dibatasi ke pemiliknya.
- Password broker dienkripsi AES-256-GCM; kunci API AI hanya bisa ditulis, tidak pernah dikembalikan.
- `.env` tidak pernah di-commit; semua rahasia dari environment.

## Lisensi pihak ketiga

Chart memakai TradingView Lightweight Charts™ (Apache-2.0), Copyright © 2025 TradingView, Inc., https://www.tradingview.com/. Atribusi juga tampil di Settings › About.

Ini bukan nasihat keuangan. Trading dengan leverage dapat merugikan lebih dari modal. Gunakan paper atau akun demo terlebih dahulu.
