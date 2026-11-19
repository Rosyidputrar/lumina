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
npm test           # 46 tes backend (node:test, termasuk gateway MT5 tiruan) + tes unit frontend (vitest) + typecheck
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

## Strategi trading

Engine memakai profil **`trend`** secara default (bisa diganti owner di Owner console › Engine, atau `LUMINA_STRATEGY=classic`):

1. hanya searah tren EMA200 (harga dan EMA50 di sisi yang sama);
2. tanpa playbook kontra-tren (range reversion, liquidity sweep) dan tanpa breakout retest;
3. stop minimal 2× ATR (reward/risk dipertahankan, ukuran posisi mengecil);
4. setup dilewati bila biaya pulang-pergi melebihi 10% dari risiko.

Biaya backtest dan paper trading kini per kelas aset (crypto: fee taker 10 bps/sisi; FX: spread ~1 bps + komisi 0,35 bps; logam; indeks), dan backtester meniru engine live: jendela 400 bar, fee di kedua sisi, stop di bar entri dihitung, break-even dan trailing stop.

Hasil walk-forward pada data nyata OKX dan Kraken (13 pasar, 1h/4h/1d; pasar dan periode holdout tidak dipakai untuk memilih aturan):

| Profil | Set | Trade | Ekspektansi/trade | Seri profit | Drawdown terburuk |
|---|---|---|---|---|---|
| classic | holdout | 4.074 | −0,141R | 4/31 | 38,8% |
| trend | holdout | 718 | −0,008R | 13/31 | 8,3% |

Profil `trend` menghentikan kerugian sistematis (sekitar impas) dan memangkas drawdown hampir 5×, **tetapi belum terbukti profit konsisten**: keunggulan sebelum biaya hanya ~+0,06R per trade. Ulangi pengujian dengan data terbaru: `npm --prefix backend run walkforward -- --refresh`.

## MT5 (MetaTrader 5) lewat mt5-gateway

Lumina memakai [mt5-gateway](https://github.com/Gabriel-Rockson/mt5-gateway) (MT5 di Wine dengan HTTP API) sebagai service terpisah. Kodenya tidak disalin ke repo ini; compose membangunnya langsung dari repo upstream pada commit yang dipin.

```sh
cp mt5-gateway.env.example mt5-gateway.env   # isi PASSWORD, MT5_API_KEY, BROKER_TIMEZONE
# di backend/.env:
#   MT5_GATEWAY_URL=http://mt5:5001
#   MT5_GATEWAY_KEY=<nilai MT5_API_KEY yang sama>
#   MT5_SYMBOL_EURUSD=EURUSD   (nama simbol sesuai broker Anda)
#   LUMINA_BROKER=mt5 dan LUMINA_LIVE=1 hanya bila siap live
docker compose --profile mt5 up -d --build
```

Lalu buka desktop web MT5 di `http://127.0.0.1:10004` (di server, lewat SSH tunnel: `ssh -L 10004:127.0.0.1:10004 server`), login ke akun broker sekali, dan cek Owner console › MT5 gateway console. Butuh ±4 GB RAM; start pertama bisa beberapa menit.

Pengaman yang sudah diimplementasikan untuk live: ukuran lot dari risiko dan spesifikasi simbol broker, SL/TP dibulatkan ke digit simbol, filling mode dari simbol, SL/TP diverifikasi setelah fill (dipasang ulang sekali; bila tetap gagal, posisi langsung ditutup), ubah SL/TP dan trailing stop dikirim ke broker, dan order ditandai magic number Lumina. Selalu uji di akun demo dulu.

## Data pasar

Tanpa gateway MT5, watchlist default memakai data publik OKX dan Kraken (BTC, ETH, SOL, EUR/USD, GBP/USD, emas PAXG). Dengan `MT5_GATEWAY_URL` dan `MT5_GATEWAY_KEY`, watchlist default beralih ke simbol MT5. Owner bisa mengubah watchlist dari owner console. Backtest di OKX kini benar-benar mendapat hingga 1.000 bar (sebelumnya terpotong 300).

## Keamanan

- Sesi lisensi dan owner di cookie HttpOnly; tidak ada rahasia di JavaScript atau localStorage.
- Setiap request yang mengubah data dicek origin-nya (CSRF) di server.
- Otorisasi di server: posisi, file, dan catatan vault dibatasi ke pemiliknya.
- Password broker dienkripsi AES-256-GCM; kunci API AI hanya bisa ditulis, tidak pernah dikembalikan.
- `.env` tidak pernah di-commit; semua rahasia dari environment.

## Lisensi pihak ketiga

Chart memakai TradingView Lightweight Charts™ (Apache-2.0), Copyright © 2025 TradingView, Inc., https://www.tradingview.com/. Atribusi juga tampil di Settings › About.

Ini bukan nasihat keuangan. Trading dengan leverage dapat merugikan lebih dari modal. Gunakan paper atau akun demo terlebih dahulu.
