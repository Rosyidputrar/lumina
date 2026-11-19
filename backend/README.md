# LuminaVantage — backend

Backend Node.js untuk terminal trading peribadi: data pasaran, analisis
teknikal, pengurusan risiko, dan penghantaran order ke broker MT5 melalui
gateway HTTP. Dikongsi untuk kegunaan peribadi sahaja.

Frontend React ada dalam `../frontend` dan dibina ke `public/`, jadi satu proses Node melayan aplikasi dan API. Lihat README di akar repositori.

## Apa yang ada

- `src/analysis/` — indikator (EMA, RSI, ATR, dsb.), strategi, dan skor setup.
- `src/execution/` — enjin auto-trade, paper broker, dan `mt5-broker.js`
  (klien HTTP ke gateway MT5).
- `src/market/` — sumber data harga (MT5, Bybit, OKX, Kraken).
- `src/licensing/` — kunci lesen dan pengesahan akses.
- `src/owner/` — konsol pemilik (akaun MT5, kunci, dasar risiko).
- `src/vault/` — nota dan pelajaran dagangan (tanpa identiti pengguna).
- `src/store.js` — penyimpanan SQLite (`node:sqlite`).
- `src/tools/` — skrip seed (cetak kunci lesen), backtest, dan migrasi.
- `test/` — ujian `node:test`: lesen, analisis, risiko, vault, dan integrasi HTTP.

## Keperluan

- Node.js 22 atau lebih baru
- Gateway MT5 HTTP jika mahu data atau order MT5 sebenar (lihat di bawah)

## Pasang dan jalankan

```sh
npm install
cp .env.example .env     # isi nilai sendiri; jangan commit .env
npm run seed             # cetak kunci lesen percubaan untuk mengaktifkan peranti
npm start                # http://127.0.0.1:8787 (baca .env melalui shell anda)
npm test
```

## Konfigurasi

Semua rahsia dibaca dari pembolehubah persekitaran. Tiada rahsia dalam kod.

| Pembolehubah | Fungsi |
|---|---|
| `LUMINA_LICENSE_SECRET` | Kunci tandatangan lesen (32+ aksara, kekal) |
| `LUMINA_OWNER_SECRET` | Frasa laluan pemilik |
| `LUMINA_CREDENTIAL_SECRET` | Kunci penyulitan kredensial akaun MT5 (AES-256-GCM) |
| `MT5_GATEWAY_URL` | URL gateway MT5 utama |
| `MT5_GATEWAY_KEY` | Kunci API gateway |
| `MT5_PROVISIONER_URL` / `MT5_PROVISIONER_KEY` | Pilihan: penyedia gateway per akaun |

Fail `.env.example` menerangkan setiap pembolehubah.

## Gateway MT5

Enjin hanya boleh menghantar order sebenar melalui gateway HTTP yang anda
sediakan sendiri (di Windows/Wine atau VPS). Tanpa gateway, sistem berjalan
dalam mod paper sahaja. Mod live mesti diaktifkan secara eksplisit; jika
ada ralat sambungan, sistem gagal dalam keadaan selamat (fail-closed) dan
tidak menghantar order.

Setiap akaun MT5 disimpan dengan kredensial disulitkan. Akaun yang belum
disahkan sambungannya tidak akan digunakan untuk dagangan.

## Pengurusan risiko

- Saiz kedudukan dikira dari jarak stop-loss dan peratus risiko.
- Had kedudukan setiap simbol dan had keseluruhan boleh ditetapkan.
- Nilai `0` bermaksud tiada had.
- Saiz lot dihadkan oleh spesifikasi simbol broker (min, max, step) dan
  margin yang tersedia.

## Ujian

```sh
npm test
```

Ujian merangkumi analisis, risiko, enjin, lesen, penyimpanan, dan vault.
Ujian tidak menghubungi broker sebenar.

## Had yang diketahui

- Penyimpanan utama masih SQLite. Migrasi ke PostgreSQL (Neon) disediakan
  sebagai skrip, tetapi adapter tak segerak belum disambungkan sepenuhnya.
- Gateway MT5 perlu dijalankan dan dilindungi oleh anda sendiri.
- Partial take-profit belum dilaksanakan.
- Ini bukan nasihat kewangan. Dagangan leveraj boleh menyebabkan kerugian
  melebihi jangkaan. Guna akaun demo dahulu.

## Lesen

Untuk kegunaan peribadi sahaja. Tiada jaminan.
