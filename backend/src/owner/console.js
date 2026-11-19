/**
 * The owner console.
 *
 * Why this exists separately from the Telegram mini app: a Web App only receives
 * signed `initData` when Telegram opens it, and when that is missing every value
 * on the page is a dash with no explanation. This page authenticates the same way
 * the owner panel always has — a passphrase, an HttpOnly cookie — so it works in
 * any browser, on any device, with no Telegram involvement.
 *
 * It is deliberately one self-contained file with no build step and no
 * dependencies: the server sends bytes, the browser runs them. Everything it
 * reads goes through /api/owner/*, which is owner-gated server side, so the page
 * itself can be public without leaking anything.
 */

/** Bumped when the page changes, so a screenshot names what is running. */
export const CONSOLE_BUILD = 'console-1';

const STYLE = `
:root{
  --bg:#0b0d10;--bg1:#111419;--card:#151920;--elev:#1b2029;--line:#242a34;--line2:#2f3742;
  --ink:#eef1f4;--ink2:#a8b0bc;--ink3:#737d8c;--gold:#d8ab69;--goldbg:rgba(216,171,105,.12);
  --up:#6ec49b;--down:#e07875;--blue:#7ea9c8;--lime:#c8f76a;
  --mono:ui-monospace,SFMono-Regular,Menlo,Consolas,monospace;
  --sans:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,Inter,sans-serif;
}
*{box-sizing:border-box}
html,body{height:100%}
body{margin:0;background:var(--bg);color:var(--ink);font:14px/1.5 var(--sans);
  -webkit-font-smoothing:antialiased;overflow-x:hidden}
button,input,select{font:inherit;color:inherit}
a{color:var(--gold)}

/* ── login ── */
#login{min-height:100dvh;display:grid;place-items:center;padding:24px}
#login .box{width:100%;max-width:380px;background:var(--card);border:1px solid var(--line);
  border-radius:12px;padding:26px}
#login h1{font-size:20px;margin:0 0 6px;letter-spacing:-.02em}
#login p{color:var(--ink3);font-size:13px;margin:0 0 20px}
label{display:block;font:600 10px/1 var(--mono);letter-spacing:.12em;text-transform:uppercase;
  color:var(--ink3);margin-bottom:6px}
input[type=password],input[type=text],input[type=number],select{
  width:100%;background:var(--bg1);border:1px solid var(--line2);border-radius:7px;
  padding:11px 12px;font-size:16px;outline:none}
input:focus,select:focus{border-color:var(--gold)}
.btn{background:var(--gold);color:#14100a;border:0;border-radius:7px;padding:11px 16px;
  font-weight:700;font-size:13px;cursor:pointer;letter-spacing:.02em}
.btn:disabled{opacity:.55;cursor:default}
.btn.ghost{background:transparent;color:var(--ink);border:1px solid var(--line2)}
.btn.danger{background:var(--down);color:#1a0c0c}
.btn.sm{padding:7px 11px;font-size:12px;border-radius:6px}
.wide{width:100%;margin-top:14px}

/* ── shell ── */
#app{display:none;min-height:100dvh}
header{position:sticky;top:0;z-index:20;background:rgba(11,13,16,.92);
  backdrop-filter:blur(10px);border-bottom:1px solid var(--line);
  display:flex;align-items:center;gap:12px;padding:10px 14px;flex-wrap:wrap}
.mark{width:26px;height:26px;border-radius:7px;background:#241f18;color:var(--gold);
  display:grid;place-items:center;font-weight:800;font-size:12px;flex:none}
.brand{font:700 12px/1 var(--mono);letter-spacing:.16em;color:var(--gold)}
.tag{font:600 9px/1 var(--mono);letter-spacing:.14em;color:var(--ink3);
  border:1px solid var(--line2);border-radius:4px;padding:3px 5px}
.spacer{margin-left:auto}
nav{display:flex;gap:2px;overflow-x:auto;background:var(--bg1);border-bottom:1px solid var(--line);
  padding:0 8px;scrollbar-width:none}
nav::-webkit-scrollbar{display:none}
nav button{flex:none;background:0;border:0;border-bottom:2px solid transparent;color:var(--ink3);
  font:600 10px/1 var(--mono);letter-spacing:.1em;padding:13px 13px;text-transform:uppercase;
  cursor:pointer;white-space:nowrap}
nav button[aria-selected=true]{color:var(--gold);border-bottom-color:var(--gold)}
main{padding:14px;max-width:1400px;margin:0 auto}
section{display:none}
section.on{display:block}

/* ── pieces ── */
.grid{display:grid;gap:10px;margin-bottom:12px;
  grid-template-columns:repeat(auto-fit,minmax(160px,1fr))}
.kpi{background:var(--card);border:1px solid var(--line);border-radius:9px;padding:13px 14px}
.kpi .l{font:600 9px/1 var(--mono);letter-spacing:.11em;color:var(--ink3);text-transform:uppercase}
.kpi .v{font:700 23px/1.1 var(--mono);margin-top:6px;font-variant-numeric:tabular-nums}
.kpi .f{font-size:11px;color:var(--ink3);margin-top:3px}
.card{background:var(--card);border:1px solid var(--line);border-radius:9px;padding:14px;margin-bottom:12px}
.card h2{font:600 10px/1 var(--mono);letter-spacing:.11em;text-transform:uppercase;
  color:var(--ink3);margin:0 0 12px}
.row{display:flex;justify-content:space-between;gap:12px;padding:7px 0;
  border-bottom:1px solid var(--line);font-size:13px}
.row:last-child{border-bottom:0}
.row .k{color:var(--ink3)}
.row .v{font-family:var(--mono);font-size:12.5px;text-align:right;word-break:break-all}
table{width:100%;border-collapse:collapse;font-size:12.5px}
th{font:600 9px/1 var(--mono);letter-spacing:.1em;text-transform:uppercase;color:var(--ink3);
  text-align:left;padding:0 8px 8px 0;white-space:nowrap}
td{padding:8px 8px 8px 0;border-top:1px solid var(--line);vertical-align:middle}
td.mono{font-family:var(--mono);font-size:12px}
.scroll{overflow-x:auto}
.pill{display:inline-block;font:600 9px/1 var(--mono);letter-spacing:.08em;text-transform:uppercase;
  padding:4px 6px;border-radius:4px;white-space:nowrap}
.pill.ok{background:rgba(110,196,155,.14);color:var(--up)}
.pill.off{background:rgba(224,120,117,.14);color:var(--down)}
.pill.wait{background:rgba(216,171,105,.14);color:var(--gold)}
.pill.dim{background:var(--elev);color:var(--ink3)}
.empty{color:var(--ink3);font-size:13px;padding:8px 0}
#toast{position:fixed;left:50%;bottom:18px;transform:translateX(-50%) translateY(20px);
  background:var(--elev);border:1px solid var(--line2);border-radius:8px;padding:10px 14px;
  font-size:13px;opacity:0;pointer-events:none;transition:.2s;z-index:60;max-width:calc(100vw - 24px)}
#toast.on{opacity:1;transform:translateX(-50%) translateY(0)}
#toast.bad{border-color:var(--down);color:#f3c9c8}
#diag{margin:0 14px 14px;padding:10px;border:1px solid #3a2a2a;border-radius:8px;
  background:#1e1416;color:#df7774;font:11px/1.5 var(--mono);white-space:pre-wrap;display:none}
footer{max-width:1400px;margin:0 auto;padding:10px 14px 28px;color:var(--ink3);
  font:10px/1.6 var(--mono)}
@media(max-width:560px){
  .kpi .v{font-size:19px}
  main{padding:12px}
  header{padding:9px 12px}
}
`;

const BODY = `
<div id="login">
  <form class="box" id="login-form">
    <h1>Owner console</h1>
    <p>Enter the owner passphrase. This page gives full authority over licences, files and AI.</p>
    <label for="pass">Passphrase</label>
    <input id="pass" type="password" autocomplete="current-password" required />
    <button class="btn wide" type="submit" id="login-btn">Unlock</button>
    <div id="login-err" style="color:#df7774;font-size:12.5px;margin-top:10px"></div>
  </form>
</div>

<div id="app">
  <header>
    <div class="mark">LV</div>
    <div class="brand">LUMINAVANTAGE</div>
    <div class="tag">OWNER</div>
    <div class="spacer"></div>
    <a class="btn sm" id="open-terminal" href="/" style="text-decoration:none;display:inline-flex;align-items:center">Buka terminal</a>
    <button class="btn ghost sm" id="reload">Muat semula</button>
    <button class="btn ghost sm" id="logout">Keluar</button>
  </header>
  <nav id="nav">
    <button data-tab="overview" aria-selected="true">Ringkasan</button>
    <button data-tab="licences">Lesen</button>
    <button data-tab="files">Fail</button>
    <button data-tab="markets">Pasaran</button>
    <button data-tab="risk">Risiko</button>
    <button data-tab="trade">Dagang</button>
    <button data-tab="mt5">MT5</button>
    <button data-tab="ai">AI</button>
    <button data-tab="events">Peristiwa</button>
    <button data-tab="system">Sistem</button>
  </nav>
  <div id="diag"></div>
  <main>
    <section id="sec-overview" class="on">
      <div class="grid">
        <div class="kpi"><div class="l">Lesen aktif</div><div class="v" id="k-active">–</div><div class="f" id="k-total"></div></div>
        <div class="kpi"><div class="l">Jumlah lesen</div><div class="v" id="k-all">–</div><div class="f" id="k-plans"></div></div>
        <div class="kpi"><div class="l">Penggunaan</div><div class="v" id="k-used">–</div><div class="f">unit ditarik</div></div>
        <div class="kpi"><div class="l">Fail dikongsi</div><div class="v" id="k-files">–</div><div class="f" id="k-files-f"></div></div>
      </div>
      <div class="card"><h2>Enjin &amp; pasaran</h2><div id="engine"></div></div>
      <div class="card"><h2>Production readiness</h2><div id="readiness"><div class="empty">Checking gateway, AI, news, risk and account isolation…</div></div></div>
      <div class="card"><h2>Peranti</h2><div id="devices"></div></div>
    </section>

    <section id="sec-licences">
      <div class="card">
        <h2>Terbit lesen</h2>
        <div style="display:grid;gap:8px;grid-template-columns:repeat(auto-fit,minmax(140px,1fr))">
          <div><label for="in-plan">Pelan</label>
            <select id="in-plan"><option value="monthly">monthly</option><option value="yearly">yearly</option><option value="lifetime">lifetime</option></select></div>
          <div><label for="in-label">Label</label><input id="in-label" type="text" placeholder="cth. pelanggan A" /></div>
          <div><label for="in-quota">Kuota (kosong = lalai)</label><input id="in-quota" type="number" min="0" placeholder="5000" /></div>
        </div>
        <button class="btn" id="issue" style="margin-top:12px">Terbitkan</button>
        <div id="issued" style="margin-top:12px"></div>
      </div>
      <div class="card"><h2>Semua lesen</h2><div class="scroll" id="lic-table"></div></div>
    </section>

    <section id="sec-files">
      <div class="card"><h2>Fail</h2><div class="scroll" id="file-table"></div></div>
    </section>

    <section id="sec-markets">
      <div class="card">
        <h2>Instrumen yang dipantau</h2>
        <p class="empty" style="margin:0 0 10px">Cari terus simbol yang broker MT5 kamu sediakan. Jangan teka suffix seperti <code>.s</code>.</p>
        <div style="display:flex;gap:8px;margin:0 0 10px;flex-wrap:wrap"><input id="mkt-search" type="search" placeholder="Cari broker: XAU, AAPL, US100…" style="flex:1;min-width:180px" /><button class="btn ghost sm" id="mkt-search-btn">Cari broker</button></div>
        <div id="mkt-results" class="tiny dim" style="margin-bottom:10px"></div>
        <div id="mkt-list"></div>
        <div style="display:grid;gap:8px;margin-top:12px;grid-template-columns:repeat(auto-fit,minmax(120px,1fr))">
          <div><label for="mkt-symbol">Simbol</label><input id="mkt-symbol" type="text" placeholder="EURUSD.s" /></div>
          <div><label for="mkt-label">Label</label><input id="mkt-label" type="text" placeholder="EUR / USD" /></div>
          <div><label for="mkt-class">Kelas</label>
            <select id="mkt-class"><option value="fx">forex</option><option value="metal">logam</option><option value="index">indeks</option><option value="crypto">crypto</option></select></div>
        </div>
        <div style="display:flex;gap:8px;margin-top:10px;flex-wrap:wrap">
          <button class="btn ghost sm" id="mkt-check">Uji simbol</button>
          <button class="btn sm" id="mkt-add">Tambah</button>
          <button class="btn ghost sm" id="mkt-reset">Muat semula</button>
        </div>
        <div id="mkt-msg" style="margin-top:10px"></div>
      </div>
      <div class="card"><h2>Sebut harga semasa</h2><div id="mkt-quotes"></div></div>
    </section>

    <section id="sec-trade">
      <div class="card">
        <h2>Enjin</h2>
        <div id="eng-status" style="margin-bottom:10px"></div>
        <div style="display:flex;gap:8px;align-items:center;flex-wrap:wrap;margin-bottom:10px"><label class="tiny dim">Skop auto-trade</label><select id="eng-scope"><option value="all">Semua watchlist</option><option value="single">Satu simbol</option><option value="custom">Custom</option></select><select id="eng-scope-symbol"></select><div id="eng-scope-symbols" style="display:flex;gap:6px;flex-wrap:wrap"></div><button class="btn ghost sm" id="eng-scope-save">Simpan skop</button></div>
        <div id="eng-scope-msg" class="tiny dim" style="margin-bottom:10px"></div>
        <div style="display:flex;gap:8px;flex-wrap:wrap">
          <button class="btn sm" id="eng-run">Jalankan kitaran sekarang</button>
          <button class="btn ghost sm" id="eng-start">Mula</button>
          <button class="btn ghost sm" id="eng-stop">Henti</button>
          <label style="display:flex;align-items:center;gap:6px;font-size:12px"><input type="checkbox" id="eng-auto" /> Auto-dagang</label>
        </div>
        <div id="eng-msg" style="margin-top:10px"></div>
      </div>
      <div class="card"><h2>Isyarat terkini</h2><div id="eng-signals"></div></div>
      <div class="card"><h2>Posisi terbuka</h2><div id="eng-positions"></div></div>
    </section>

    <section id="sec-risk">
      <div class="card">
        <h2>Gaya dagangan</h2>
        <div id="style-form" style="display:flex;gap:8px;flex-wrap:wrap;margin:0 0 14px">
          <button class="btn ghost sm" data-style="scalping">Scalping · 5m</button>
          <button class="btn ghost sm" data-style="intraday">Intraday · 15m</button>
          <button class="btn ghost sm" data-style="swing">Swing · 4h</button>
        </div>
        <div id="style-msg" class="tiny dim" style="margin-bottom:14px"></div>
        <h2>Had risiko</h2>
        <p class="empty" style="margin:0 0 10px">Angka ini menentukan sama ada pesanan diterima. Setiap nilai dihadkan kepada julat selamat.</p>
        <div id="risk-form" style="display:grid;gap:10px;grid-template-columns:repeat(auto-fit,minmax(150px,1fr))"></div>
        <div style="display:flex;gap:8px;margin-top:12px;flex-wrap:wrap">
          <button class="btn sm" id="risk-save">Simpan</button>
          <button class="btn ghost sm" id="risk-reload">Muat semula</button>
        </div>
        <div id="risk-msg" style="margin-top:10px"></div>
      </div>
    </section>

    <section id="sec-mt5">
      <div class="card"><h2>Gateway MT5</h2><div id="mt5-gateway"></div></div>
      <div class="card"><h2>Akaun broker</h2><div id="mt5-account"></div></div>
      <div class="card"><h2>Posisi terbuka</h2><div class="scroll" id="mt5-positions"></div></div>
      <div class="card">
        <h2>Simbol tersedia</h2>
        <div style="display:flex;gap:8px;margin-bottom:10px;flex-wrap:wrap">
          <input id="sym-search" type="text" value="*" placeholder="*EUR* atau *XAU*" style="flex:1;min-width:140px" />
          <button class="btn ghost sm" id="sym-go">Cari</button>
        </div>
        <div id="mt5-symbols"></div>
      </div>
      <div class="card">
        <h2>Uji data candle</h2>
        <div style="display:flex;gap:8px;margin-bottom:10px;flex-wrap:wrap">
          <input id="cnd-symbol" type="text" value="EURUSD.s" placeholder="EURUSD.s" style="flex:1;min-width:140px" />
          <select id="cnd-tf" style="width:auto"><option>1m</option><option>5m</option><option>15m</option><option>30m</option><option selected>1h</option><option>4h</option><option>1d</option></select>
          <button class="btn ghost sm" id="cnd-go">Ambil</button>
        </div>
        <div id="cnd-out"></div>
      </div>
      <p class="empty" style="margin:0 14px 20px">Status dikemas kini setiap 5 saat selagi tab ini terbuka.</p>
    </section>

    <section id="sec-ai">
      <div class="card">
        <h2>Pembekal AI</h2>
        <div class="row"><span class="k">Status</span><span class="v" id="ai-state">–</span></div>
        <div class="row"><span class="k">Asas URL</span><span class="v" id="ai-url">–</span></div>
        <div class="row"><span class="k">Model</span><span class="v" id="ai-model">–</span></div>
        <div class="row"><span class="k">Kunci</span><span class="v" id="ai-key">–</span></div>
        <div style="display:grid;gap:8px;margin-top:12px">
          <div><label for="ai-base">Asas URL</label><input id="ai-base" type="text" placeholder="https://api.anthropic.com" /></div>
          <div><label for="ai-model">Model</label><input id="ai-model" type="text" placeholder="claude-sonnet-4-20250514" /></div>
          <div><label for="ai-key">Kunci API (kosongkan untuk kekalkan)</label><input id="ai-key" type="password" autocomplete="off" placeholder="ditulis sekali, tidak dipaparkan semula" /></div>
          <div style="display:flex;gap:8px;flex-wrap:wrap;margin-top:6px">
            <button class="btn" id="ai-save">Simpan</button>
            <button class="btn ghost sm" id="ai-clear">Buang kunci</button>
          </div>
          <p class="empty" style="margin:4px 0 0">Disimpan pada backend ini, jadi ia kekal selepas restart. Kunci tidak pernah dipaparkan semula.</p>
        </div>
      </div>
    </section>

    <section id="sec-events">
      <div class="card"><h2>Peristiwa lesen</h2><div class="scroll" id="event-table"></div></div>
    </section>

    <section id="sec-system">
      <div class="card"><h2>Kesihatan</h2><div id="health"></div></div>
      <div class="card">
        <h2>Bahaya</h2>
        <p class="empty">Batalkan semua lesen. Baris disimpan, jadi boleh dipulihkan.</p>
        <button class="btn danger" id="reset-all" style="margin-top:10px">Batalkan semua lesen</button>
      </div>
    </section>
  </main>
  <footer>build <span id="build">?</span> · data dari /api/owner/*</footer>
</div>
<div id="toast"></div>
`;

const SCRIPT = String.raw`
var BUILD = 'console-build';
var diagEl = document.getElementById('diag');
var seen = {};
/**
 * Show a failure once, with a count, and never flood the screen.
 *
 * A cross-origin script reports its errors as the literal string 'Script error.'
 * with no message, file or line, so the same line used to repeat dozens of times
 * and told us nothing. The source and line are printed when the browser gives
 * them, and identical lines are collapsed into a count.
 */
function diag(text) {
  var key = String(text);
  seen[key] = (seen[key] || 0) + 1;
  var line = key + (seen[key] > 1 ? '  (x' + seen[key] + ')' : '');
  var lines = diagEl.textContent ? diagEl.textContent.split('\n') : [];
  var base = key;
  var at = -1;
  for (var i = lines.length - 1; i >= 0; i--) {
    if (lines[i].indexOf(base) === 0) { at = i; break; }
  }
  if (at >= 0) lines[at] = line; else lines.push(line);
  diagEl.style.display = 'block';
  diagEl.textContent = lines.slice(-12).join('\n');
}
function toast(text, bad) {
  var t = document.getElementById('toast');
  t.textContent = text;
  t.className = 'on' + (bad ? ' bad' : '');
  clearTimeout(window.__tt);
  window.__tt = setTimeout(function () { t.className = ''; }, 3200);
}
function esc(s) {
  return String(s == null ? '' : s).replace(/[&<>"']/g, function (c) {
    return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c];
  });
}
function api(path, opts) {
  return fetch(path, Object.assign({ credentials: 'same-origin' }, opts, {
    headers: Object.assign({ 'content-type': 'application/json' }, (opts && opts.headers) || {}),
  })).then(function (r) {
    return r.text().then(function (txt) {
      var j = {};
      try { j = txt ? JSON.parse(txt) : {}; } catch (e) { j = { raw: txt.slice(0, 200) }; }
      if (!r.ok) {
        diag(path + ' -> HTTP ' + r.status + ' ' + (j.error || '') + (j.code ? ' [' + j.code + ']' : ''));
        throw new Error(j.error || ('HTTP ' + r.status));
      }
      return j;
    });
  });
}
function money(n) { return Number(n || 0).toLocaleString('en-US'); }
function when(ms) {
  if (!ms) return '–';
  var d = new Date(Number(ms));
  return d.toISOString().slice(0, 10);
}
function dt(ms) {
  if (!ms) return '–';
  return new Date(Number(ms)).toISOString().slice(0, 16).replace('T', ' ');
}

/* ── tabs ── */
document.getElementById('nav').addEventListener('click', function (e) {
  var b = e.target.closest('button[data-tab]');
  if (!b) return;
  Array.prototype.forEach.call(document.querySelectorAll('#nav button'), function (x) {
    x.setAttribute('aria-selected', String(x === b));
  });
  Array.prototype.forEach.call(document.querySelectorAll('main section'), function (s) {
    s.classList.remove('on');
  });
  document.getElementById('sec-' + b.dataset.tab).classList.add('on');
});

/* ── login ── */
document.getElementById('login-form').addEventListener('submit', function (e) {
  e.preventDefault();
  var btn = document.getElementById('login-btn');
  var err = document.getElementById('login-err');
  err.textContent = '';
  btn.disabled = true;
  api('/api/owner/login', { method: 'POST', body: JSON.stringify({ passphrase: document.getElementById('pass').value }) })
    .then(function () { return open(); })
    .catch(function (e2) { err.textContent = e2.message === 'wrong passphrase' ? 'Passphrase salah.' : e2.message; })
    .then(function () { btn.disabled = false; });
});

document.getElementById('logout').onclick = function () {
  api('/api/owner/logout', { method: 'POST', body: '{}' })
    .then(function () { location.reload(); })
    .catch(function () { location.reload(); });
};
document.getElementById('reload').onclick = function () { loadAll(); };

function open() {
  document.getElementById('login').style.display = 'none';
  document.getElementById('app').style.display = 'block';
  document.getElementById('build').textContent = BUILD;
  loadAll();
}

/* ── loaders ── */
function loadAll() {
  diagEl.textContent = '';
  diagEl.style.display = 'none';
  loadLicences();
  loadFiles();
  loadHealth();
  loadReadiness();
}

function loadLicences() {
  return api('/api/owner/licences').then(function (d) {
    var sm = d.summary || {};
    var list = d.licences || [];
    document.getElementById('k-active').textContent = sm.active || 0;
    document.getElementById('k-total').textContent = (sm.total || 0) + ' jumlah';
    document.getElementById('k-all').textContent = sm.total || 0;
    document.getElementById('k-used').textContent = money(sm.consumed);
    document.getElementById('k-plans').textContent = Object.keys(sm.byPlan || {}).map(function (k) {
      return k + ' ' + sm.byPlan[k];
    }).join(' · ') || '–';

    var rows = list.slice(0, 60).map(function (l) {
      var state = l.revoked ? 'off' : l.expired ? 'wait' : 'ok';
      var label = l.revoked ? 'batal' : l.expired ? 'tamat' : 'aktif';
      return '<tr>' +
        '<td class="mono">' + esc(l.keyId) + '</td>' +
        '<td>' + esc(l.plan) + '</td>' +
        '<td><span class="pill ' + state + '">' + label + '</span></td>' +
        '<td class="mono">' + money(l.used) + '/' + (l.quota === null ? '∞' : money(l.quota)) + '</td>' +
        '<td class="mono">' + when(l.expiresAt) + '</td>' +
        '<td>' + esc(l.label || '') + '</td>' +
        '<td style="white-space:nowrap">' +
          '<button class="btn ghost sm" data-revoke="' + esc(l.keyId) + '" data-to="' + (l.revoked ? '0' : '1') + '">' +
            (l.revoked ? 'Pulih' : 'Batal') + '</button> ' +
          '<button class="btn ghost sm" data-quota="' + esc(l.keyId) + '">Kuota</button>' +
        '</td></tr>';
    }).join('');
    document.getElementById('lic-table').innerHTML = list.length
      ? '<table><thead><tr><th>ID</th><th>Pelan</th><th>Status</th><th>Guna</th><th>Tamat</th><th>Label</th><th></th></tr></thead><tbody>' + rows + '</tbody></table>'
      : '<div class="empty">Tiada lesen.</div>';

    var ev = d.events || [];
    document.getElementById('event-table').innerHTML = ev.length
      ? '<table><thead><tr><th>Masa</th><th>Peristiwa</th><th>Butiran</th></tr></thead><tbody>' +
        ev.slice(0, 40).map(function (e) {
          return '<tr><td class="mono">' + dt(e.ts) + '</td><td>' + esc(e.action) + '</td><td class="mono">' +
            esc(String(e.detail || '').slice(0, 80)) + '</td></tr>';
        }).join('') + '</tbody></table>'
      : '<div class="empty">Tiada peristiwa.</div>';
  }).catch(function (e) { toast(e.message, true); });
}

function loadFiles() {
  return api('/api/owner/files').then(function (d) {
    var list = d.files || [];
    var pub = list.filter(function (f) { return f.visibility === 'public'; }).length;
    document.getElementById('k-files').textContent = pub;
    document.getElementById('k-files-f').textContent = list.length + ' jumlah fail';
    document.getElementById('file-table').innerHTML = list.length
      ? '<table><thead><tr><th>ID</th><th>Nama</th><th>Saiz</th><th>Status</th><th>Muat turun</th><th></th></tr></thead><tbody>' +
        list.map(function (f) {
          var isPub = f.visibility === 'public';
          return '<tr><td class="mono">' + esc(f.id) + '</td>' +
            '<td>' + esc(f.name) + '</td>' +
            '<td class="mono">' + Math.round((f.bytes || 0) / 1024) + ' KB</td>' +
            '<td><span class="pill ' + (isPub ? 'ok' : 'dim') + '">' + (isPub ? 'awam' : 'peribadi') + '</span></td>' +
            '<td class="mono">' + money(f.downloads) + '</td>' +
            '<td style="white-space:nowrap">' +
              '<button class="btn ghost sm" data-share="' + esc(f.id) + '" data-pub="' + (isPub ? '0' : '1') + '">' +
                (isPub ? 'Tutup' : 'Kongsi') + '</button> ' +
              (isPub ? '<a class="btn ghost sm" href="/f/' + esc(f.shareToken) + '" target="_blank" rel="noopener">Buka</a>' : '') +
            '</td></tr>';
        }).join('') + '</tbody></table>'
      : '<div class="empty">Tiada fail.</div>';
  }).catch(function (e) { toast(e.message, true); });
}

function loadReadiness() {
  return api('/api/owner/readiness').then(function (d) {
    var el = document.getElementById('readiness');
    el.innerHTML = '<div class="row" style="margin-bottom:8px"><span class="k">Overall</span><span class="pill ' + (d.ok ? 'ok' : 'wait') + '">' + (d.ok ? 'READY' : d.blockers.length + ' BLOCKER(S)') + '</span></div>' +
      (d.checks || []).map(function (c) { return '<div class="row"><span>' + esc(c.label) + '</span><span class="mono" style="color:' + (c.ok ? 'var(--up)' : 'var(--amber)') + '">' + (c.ok ? 'OK' : 'WAIT') + ' · ' + esc(c.detail || '') + '</span></div>'; }).join('');
  }).catch(function (e) { document.getElementById('readiness').innerHTML = '<div class="empty" style="color:var(--down)">' + esc(e.message) + '</div>'; });
}

function loadHealth() {
  return api('/api/health').then(function (h) {
    var v = (h.market && h.market.venues) || {};
    document.getElementById('engine').innerHTML =
      '<div class="row"><span class="k">Enjin</span><span class="v">' + (h.engine && h.engine.running ? 'hidup' : 'mati') +
        ' · kitaran ' + ((h.engine && h.engine.cycle) || 0) + '</span></div>' +
      '<div class="row"><span class="k">Panggilan pasaran</span><span class="v">' + money(h.market && h.market.calls) +
        ' · ' + money(h.market && h.market.failures) + ' gagal</span></div>' +
      Object.keys(v).map(function (k) {
        return '<div class="row"><span class="k">' + esc(k) + '</span><span class="v">' +
          '<span class="pill ' + (v[k].ok ? 'ok' : 'off') + '">' + (v[k].ok ? 'ok' : 'gagal') + '</span></span></div>';
      }).join('');
    document.getElementById('health').innerHTML =
      '<div class="row"><span class="k">Status HTTP</span><span class="v"><span class="pill ok">200</span></span></div>' +
      '<div class="row"><span class="k">Masa pelayan</span><span class="v">' + dt(h.ts) + '</span></div>';
  }).catch(function (e) {
    document.getElementById('engine').innerHTML = '<div class="empty">Gagal: ' + esc(e.message) + '</div>';
  });
}

/* ── AI read-only ── */
function loadAi() {
  return api('/api/owner/ai/settings').then(function (r) {
    var c = r.config || {};
    document.getElementById('ai-state').textContent = c.enabled ? 'hidup (' + (c.mode || '') + ')' : 'mati';
    document.getElementById('ai-url').textContent = c.baseUrl || '–';
    document.getElementById('ai-model').textContent = c.model || '–';
    document.getElementById('ai-key').textContent = c.keyHint || 'tiada';
    document.getElementById('ai-base').value = c.baseUrl || '';
    document.getElementById('ai-model').value = c.model || '';
    document.getElementById('ai-key').value = '';
  }).catch(function (e) {
    document.getElementById('ai-state').textContent = 'tidak tersedia';
    toast(e.message, true);
  });
}

function saveAi(patch) {
  return api('/api/owner/ai/settings', { method: 'POST', body: JSON.stringify(patch) })
    .then(function (r) {
      toast('Tetapan AI disimpan · ' + (r.config.enabled ? 'hidup' : 'mati'));
      loadAi();
    })
    .catch(function (e) { toast(e.message, true); });
}
document.getElementById('nav').addEventListener('click', function (e) {
  var b = e.target.closest('button[data-tab]');
  if (!b) return;
  if (b.dataset.tab === 'ai') loadAi();
  if (b.dataset.tab === 'markets') mktLoad();
  if (b.dataset.tab === 'risk') { riskLoad(); api('/api/owner/style').then(stylePaint).catch(function () {}); }
  if (b.dataset.tab === 'trade') loadTrade();
  if (b.dataset.tab === 'mt5') mt5Start();
  else mt5Stop();
});

/* ── trading style ── */
function stylePaint(d) {
  var msg = document.getElementById('style-msg');
  var p = (d.presets || {})[d.style];
  msg.innerHTML = p
    ? 'Aktif: <b>' + esc(p.label) + '</b> · R:R minimum ' + esc(p.minRewardRisk) + ' · keyakinan ' + esc(p.minConfidence) + ' · rehat ' + esc(p.cooldownMinutes) + ' min'
    : 'Gaya tersuai · timeframe ' + esc(d.timeframe);
  document.querySelectorAll('[data-style]').forEach(function (b) {
    b.className = b.dataset.style === d.style ? 'btn sm' : 'btn ghost sm';
  });
}
document.querySelectorAll('[data-style]').forEach(function (b) {
  b.onclick = function () {
    api('/api/owner/style', { method: 'POST', body: JSON.stringify({ style: b.dataset.style }) })
      .then(function (d) { stylePaint(d); riskLoad(); toast('Gaya ditukar: ' + b.dataset.style); })
      .catch(function (e) { toast(e.message, true); });
  };
});
/* ── execution scope ── */
function scopeLoad() {
  api('/api/owner/execution').then(function (d) {
    var mode = document.getElementById('eng-scope'); var sym = document.getElementById('eng-scope-symbol');
    mode.value = d.mode || 'all';
    sym.innerHTML = (d.available || []).map(function (x) { return '<option value="' + esc(x) + '">' + esc(x) + '</option>'; }).join('');
    if (d.symbol) sym.value = d.symbol;
    var chosen = new Set(d.symbols || []);
    document.getElementById('eng-scope-symbols').innerHTML = (d.available || []).map(function (x) {
      return '<label class="tiny dim" style="display:flex;gap:4px;align-items:center"><input type="checkbox" value="' + esc(x) + '" ' + (chosen.has(x) ? 'checked' : '') + ' />' + esc(x) + '</label>';
    }).join('');
  }).catch(function (e) { toast(e.message, true); });
}
document.getElementById('eng-scope-save').onclick = function () {
  var mode = document.getElementById('eng-scope').value; var symbol = document.getElementById('eng-scope-symbol').value;
  var symbols = Array.from(document.querySelectorAll('#eng-scope-symbols input:checked')).map(function (x) { return x.value; });
  api('/api/owner/execution', { method: 'POST', body: JSON.stringify({ mode: mode, symbol: symbol, symbols: mode === 'custom' ? symbols : mode === 'single' ? [symbol] : [] }) })
    .then(function () { document.getElementById('eng-scope-msg').textContent = 'Skop disimpan: ' + mode; toast('Skop auto-dagang disimpan'); })
    .catch(function (e) { toast(e.message, true); });
};
scopeLoad();

/* ── engine and the book ── */

function engPaint(d) {
  var st = d.engine || {};
  document.getElementById('eng-status').innerHTML =
    '<div class="row"><span class="k">Status</span><span class="v">' + (st.running ? 'hidup' : 'mati') +
    ' · kitaran ' + esc(st.cycle ?? 0) + '</span></div>' +
    '<div class="row"><span class="k">Broker</span><span class="v">' + esc(st.broker || '-') + ' · ' + (d.live ? 'LIVE' : 'PAPER') + '</span></div>' +
    '<div class="row"><span class="k">Mata wang</span><span class="v">' + esc(d.currency || '-') + ' · baki ' + esc(d.balance ?? '-') + ' · leverage ' + esc(d.leverage ?? '-') + '</span></div>' +
    '<div class="row"><span class="k">Instrumen</span><span class="v">' +
      (d.instruments || []).map(function (i) { return esc(i.symbol) + ' ' + (i.price === null ? '—' : esc(i.price)); }).join(' · ') +
    '</span></div>';
  var auto = document.getElementById('eng-auto');
  auto.checked = d.autoTrade !== false;

  var sig = d.signals || [];
  document.getElementById('eng-signals').innerHTML = sig.length
    ? '<div class="scroll"><table><thead><tr><th>Simbol</th><th>Arah</th><th>Keyakinan</th><th>Status</th></tr></thead><tbody>' +
      sig.map(function (s) {
        return '<tr><td class="mono">' + esc(s.symbol) + '</td><td>' + esc(s.direction) + '</td><td>' + esc(s.confidence) + '</td><td>' + esc(s.status) + '</td></tr>';
      }).join('') + '</tbody></table></div>'
    : '<div class="empty">Tiada isyarat. Enjin hanya masuk bila harga berada di tepi julat atau ada momentum — harga di tengah julat bermakna tiada persediaan, dan itu bukan kerosakan.</div>';
}

function engPositions(rows) {
  var host = document.getElementById('eng-positions');
  host.innerHTML = rows.length
    ? '<div class="scroll"><table><thead><tr><th>Simbol</th><th>Arah</th><th>Volum</th><th>Masuk</th><th>Kini</th><th>Untung</th><th></th></tr></thead><tbody>' +
      rows.map(function (p) {
        return '<tr><td class="mono">' + esc(p.symbol) + '</td><td>' + esc(p.side) + '</td><td>' + esc(p.qty) +
          '</td><td class="mono">' + esc(p.entry) + '</td><td class="mono">' + esc(p.mark) +
          '</td><td style="color:' + (p.unrealised >= 0 ? 'var(--up)' : 'var(--down)') + '">' + esc(p.unrealised) + '</td>' +
          '<td><button class="btn ghost sm" data-close="' + esc(p.id) + '">Tutup</button></td></tr>';
      }).join('') + '</tbody></table></div>'
    : '<div class="empty">Tiada posisi terbuka.</div>';
  document.querySelectorAll('[data-close]').forEach(function (b) {
    b.onclick = function () {
      b.disabled = true;
      if (!confirm('Tutup posisi ini pada harga pasaran?')) { b.disabled = false; return; }
      api('/api/owner/positions/' + encodeURIComponent(b.dataset.close) + '/close', { method: 'POST', body: '{}' })
        .then(function (r) { toast('Ditutup · P/L ' + r.pnl); loadTrade(); })
        .catch(function (e) { toast(e.message, true); b.disabled = false; });
    };
  });
}

function loadTrade() {
  api('/api/owner/engine').then(engPaint).catch(function (e) { toast(e.message, true); });
  return api('/api/owner/positions')
    .then(function (d) { engPositions(d.positions || []); })
    .catch(function (e) { toast(e.message, true); });
}

document.getElementById('eng-run').onclick = function (e) {
  e.currentTarget.disabled = true;
  document.getElementById('eng-msg').innerHTML = '<div class="empty">Menjalankan kitaran…</div>';
  api('/api/owner/engine/run', { method: 'POST', body: '{}' })
    .then(function (r) {
      var s = (r.signals || []).length;
      document.getElementById('eng-msg').innerHTML = '<div class="empty" style="color:var(--up)">✓ Kitaran selesai · ' + s + ' isyarat</div>';
      loadTrade();
    })
    .catch(function (err) {
      document.getElementById('eng-msg').innerHTML = '<div class="empty" style="color:var(--down)">' + esc(err.message) + '</div>';
    })
    .finally(function () { e.currentTarget.disabled = false; });
};

document.getElementById('eng-start').onclick = function () {
  api('/api/owner/engine', { method: 'POST', body: JSON.stringify({ action: 'start' }) }).then(loadTrade).catch(function (e) { toast(e.message, true); });
};
document.getElementById('eng-stop').onclick = function () {
  api('/api/owner/engine', { method: 'POST', body: JSON.stringify({ action: 'stop' }) }).then(loadTrade).catch(function (e) { toast(e.message, true); });
};
document.getElementById('eng-auto').onchange = function (e) {
  api('/api/owner/engine', { method: 'POST', body: JSON.stringify({ autoTrade: e.target.checked }) })
    .then(function () { toast('Auto-dagang ' + (e.target.checked ? 'hidup' : 'mati')); })
    .catch(function (err) { toast(err.message, true); });
};

/* ── risk limits ── */
var RISK_LABELS = {
  maxRiskPerTradePct: 'Risiko setiap dagangan (%)',
  maxDailyLossPct: 'Had rugi harian (%) · 0 = tiada',
  maxPortfolioHeatPct: 'Kepanasan portfolio (%)',
  maxOpenPositions: 'Maksimum posisi terbuka',
  maxEntriesPerSymbol: 'Entry maksimum per simbol',
  maxLeverage: 'Maksimum leverage (×)',
  dailyTradeCap: 'Had dagangan sehari',
  cooldownMinutes: 'Rehat antara dagangan (min)',
  minConfidence: 'Keyakinan minimum',
  minRewardRisk: 'Reward/risk minimum',
};

function riskRender(limits, bounds) {
  var host = document.getElementById('risk-form');
  host.innerHTML = Object.keys(RISK_LABELS)
    .filter(function (k) { return limits[k] !== undefined; })
    .map(function (k) {
      var b = bounds[k] || {};
      return (
        '<div><label for="risk-' + k + '">' + esc(RISK_LABELS[k]) + '</label>' +
        '<input id="risk-' + k + '" type="number" step="any" min="' + esc(b.min) + '" max="' + esc(b.max) + '" value="' + esc(limits[k]) + '" />' +
        '<div class="tiny dim mono">' + esc(b.min) + ' – ' + esc(b.max) + '</div></div>'
      );
    })
    .join('');
}

function riskLoad() {
  return api('/api/owner/risk')
    .then(function (d) {
      riskRender(d.limits || {}, d.bounds || {});
      document.getElementById('risk-msg').innerHTML = '';
    })
    .catch(function (e) { toast(e.message, true); });
}

document.getElementById('risk-save').onclick = function () {
  var body = {};
  Object.keys(RISK_LABELS).forEach(function (k) {
    var el = document.getElementById('risk-' + k);
    if (el && el.value !== '') body[k] = Number(el.value);
  });
  api('/api/owner/risk', { method: 'POST', body: JSON.stringify(body) })
    .then(function (d) {
      riskRender(d.limits || {}, {});
      document.getElementById('risk-msg').innerHTML = '<div class="empty" style="color:var(--up)">✓ Had risiko disimpan.</div>';
      toast('Had risiko disimpan');
      riskLoad();
    })
    .catch(function (e) { toast(e.message, true); });
};

document.getElementById('risk-reload').onclick = function () { riskLoad(); };

/* ── broker symbol picker ── */
function mktBrokerRender(d) {
  var host = document.getElementById('mkt-results');
  if (!d.ok) { host.innerHTML = '<span style="color:var(--down)">' + esc(d.error || 'Broker symbols unavailable') + '</span>'; return; }
  var cats = d.categories || {};
  var out = [];
  Object.keys(cats).forEach(function (k) {
    if (!cats[k].length) return;
    out.push('<div style="margin:6px 0"><b>' + esc(k.replace(/_/g, ' ')) + '</b>: ' +
      cats[k].slice(0, 24).map(function (x) {
        return '<button class="btn ghost sm broker-symbol" data-symbol="' + esc(x.symbol) + '" style="margin:3px 3px 0 0">' + esc(x.symbol) + '</button>';
      }).join('') + '</div>');
  });
  host.innerHTML = out.join('') || '<span>Tiada simbol untuk carian ini.</span>';
  host.querySelectorAll('.broker-symbol').forEach(function (b) { b.onclick = function () { document.getElementById('mkt-symbol').value = b.dataset.symbol; }; });
}
function mktBrokerSearch() {
  var q = document.getElementById('mkt-search').value.trim() || '*';
  document.getElementById('mkt-results').textContent = 'Mencari broker…';
  api('/api/owner/mt5/symbols?search=' + encodeURIComponent(q)).then(mktBrokerRender).catch(function (e) { toast(e.message, true); });
}
document.getElementById('mkt-search-btn').onclick = mktBrokerSearch;
document.getElementById('mkt-search').onkeydown = function (e) { if (e.key === 'Enter') { e.preventDefault(); mktBrokerSearch(); } };

/* ── markets ── */
var mktList = [];

function mktRender() {
  var box = document.getElementById('mkt-list');
  box.innerHTML = mktList.length
    ? '<div class="scroll"><table><thead><tr><th>Simbol</th><th>Label</th><th>Kelas</th><th>Venue</th><th></th></tr></thead><tbody>' +
      mktList.map(function (m, i) {
        return '<tr><td class="mono">' + esc(m.symbol) + '</td><td>' + esc(m.label) + '</td><td>' + esc(m.assetClass) +
          '</td><td class="mono">' + esc(m.venue) + '</td>' +
          '<td><button class="btn ghost sm" data-del="' + i + '">Buang</button></td></tr>';
      }).join('') + '</tbody></table></div>'
    : '<div class="empty">Belum ada instrumen.</div>';
  document.querySelectorAll('[data-del]').forEach(function (b) {
    b.onclick = function () {
      mktList.splice(Number(b.dataset.del), 1);
      mktRender();
    };
  });
}

function mktLoad() {
  return api('/api/owner/markets').then(function (d) {
    mktList = (d.markets || []).slice();
    mktRender();
    var q = d.quotes || [];
    document.getElementById('mkt-quotes').innerHTML = q.length
      ? q.map(function (x) {
          return '<div class="row"><span class="k">' + esc(x.symbol) + '</span><span class="v">' + esc(x.price) + '</span></div>';
        }).join('')
      : '<div class="empty">Belum ada sebut harga. Ia muncul selepas kitaran enjin berikutnya.</div>';
  }).catch(function (e) { toast(e.message, true); });
}

document.getElementById('mkt-check').onclick = function () {
  var sym = document.getElementById('mkt-symbol').value.trim();
  var msg = document.getElementById('mkt-msg');
  if (!sym) { msg.innerHTML = '<div class="empty" style="color:var(--down)">Isi simbol dahulu.</div>'; return; }
  msg.innerHTML = '<div class="empty">Menguji ' + esc(sym) + '…</div>';
  api('/api/owner/markets/check', { method: 'POST', body: JSON.stringify({ symbol: sym }) })
    .then(function (r) {
      msg.innerHTML = r.ok
        ? '<div class="empty" style="color:var(--up)">✓ ' + esc(sym) + ' sah · tutup terakhir ' + esc(r.lastClose) + '</div>'
        : '<div class="empty" style="color:var(--down)">✗ ' + esc(r.error || 'tidak sah') + '</div>';
    })
    .catch(function (e) { msg.innerHTML = '<div class="empty" style="color:var(--down)">' + esc(e.message) + '</div>'; });
};

document.getElementById('mkt-add').onclick = function () {
  var sym = document.getElementById('mkt-symbol').value.trim();
  if (!sym) return;
  if (mktList.some(function (m) { return m.symbol === sym; })) {
    toast('Simbol itu sudah ada', true);
    return;
  }
  mktList.push({
    symbol: sym,
    venue: 'mt5',
    label: document.getElementById('mkt-label').value.trim() || sym,
    assetClass: document.getElementById('mkt-class').value,
  });
  document.getElementById('mkt-symbol').value = '';
  document.getElementById('mkt-label').value = '';
  mktRender();
  mktSave();
};

function mktSave() {
  return api('/api/owner/markets', { method: 'POST', body: JSON.stringify({ markets: mktList }) })
    .then(function (d) {
      mktList = d.markets || mktList;
      mktRender();
      toast('Pasaran disimpan (' + mktList.length + ')');
      setTimeout(function () { window.location.href = '/#/terminal'; }, 250);
    })
    .catch(function (e) { toast(e.message, true); });
}

document.getElementById('mkt-reset').onclick = function () { mktLoad(); };

/* ── MT5, live ── */
var mt5Timer = null;

function mt5Row(k, v, cls) {
  return '<div class="row"><span class="k">' + esc(k) + '</span><span class="v' + (cls ? ' ' + cls : '') + '">' + esc(v) + '</span></div>';
}

var mt5Search = '*';

function loadMt5() {
  return api('/api/owner/mt5?search=' + encodeURIComponent(mt5Search)).then(function (d) {
    var g = d.gateway;
    if (!d.configured) {
      document.getElementById('mt5-gateway').innerHTML =
        '<div class="empty">Belum diset. Isi MT5_GATEWAY_URL dan MT5_GATEWAY_KEY pada app ini di Coolify.</div>';
      document.getElementById('mt5-account').innerHTML = '';
      document.getElementById('mt5-positions').innerHTML = '';
      document.getElementById('mt5-symbols').innerHTML = '';
      return;
    }
    var acc = d.account || {};
    var m = d.mt5Account;
    if (!g) {
      document.getElementById('mt5-gateway').innerHTML =
        '<div class="empty" style="color:var(--down)">Gateway tidak menjawab: ' + esc(d.error || 'tiada butiran') + '</div>';
    } else {
      var pill = g.mt5 === 'connected' ? 'ok' : 'wait';
      document.getElementById('mt5-gateway').innerHTML =
        '<div class="row"><span class="k">Status</span><span class="v"><span class="pill ' + pill + '">' + esc(g.mt5 || g.status || '?') + '</span></span></div>' +
        mt5Row('Versi', g.version || '–') +
        mt5Row('Kill switch', g.killSwitch ? 'AKTIF' : 'tidak') +
        (g.lastError ? '<div class="row"><span class="k">Ralat akhir</span><span class="v" style="color:var(--down)">' + esc(g.lastError) + '</span></div>' : '') +
        mt5Row('Masa pelayan', g.serverTime || '–');
    }
    document.getElementById('mt5-account').innerHTML = m
      ? mt5Row('Login', m.login || acc.login || '–') +
        mt5Row('Server', m.server || acc.server || '–') +
        mt5Row('Nama', m.name || acc.label || '–') +
        mt5Row('Mata wang', m.currency || '–') +
        mt5Row('Baki', m.balance === null || m.balance === undefined ? '–' : m.balance) +
        mt5Row('Ekuiti', m.equity === null || m.equity === undefined ? '–' : m.equity) +
        mt5Row('Margin bebas', m.freeMargin === null || m.freeMargin === undefined ? '–' : m.freeMargin) +
        mt5Row('Leverage', m.leverage || '–')
      : '<div class="empty">' + (d.error ? esc(d.error) : 'Belum ada akaun dilaporkan.') + '</div>';

    var pos = d.positions || [];
    document.getElementById('mt5-positions').innerHTML = pos.length
      ? '<table><thead><tr><th>Tiket</th><th>Simbol</th><th>Arah</th><th>Lot</th><th>Masuk</th><th>SL</th><th>TP</th><th>P/L</th></tr></thead><tbody>' +
        pos.map(function (p) {
          var pnl = Number(p.pnl || 0);
          return '<tr><td class="mono">' + esc(p.ticket) + '</td><td>' + esc(p.symbol) + '</td>' +
            '<td><span class="pill ' + (p.side === 'long' ? 'ok' : 'off') + '">' + esc(p.side) + '</span></td>' +
            '<td class="mono">' + esc(p.qty) + '</td><td class="mono">' + esc(p.entry) + '</td>' +
            '<td class="mono">' + esc(p.stop || '–') + '</td><td class="mono">' + esc(p.target || '–') + '</td>' +
            '<td class="mono" style="color:' + (pnl >= 0 ? 'var(--up)' : 'var(--down)') + '">' + pnl.toFixed(2) + '</td></tr>';
        }).join('') + '</tbody></table>'
      : '<div class="empty">Tiada posisi terbuka.</div>';

    var syms = d.symbols || [];
    var box = document.getElementById('mt5-symbols');
    if (syms.length) {
      box.innerHTML = '<div class="empty" style="padding-bottom:6px">' + (d.symbolCount || syms.length) +
        ' simbol untuk carian <code>' + esc(d.symbolSearch || '*') + '</code></div>' +
        syms.map(function (x) { return '<span class="pill dim" style="margin:0 6px 6px 0">' + esc(x) + '</span>'; }).join('');
    } else {
      // An empty list is ambiguous: the terminal may still be downloading the
      // symbol tree, or the pattern may not match this broker's naming.
      box.innerHTML = '<div class="empty">Tiada simbol untuk carian <code>' + esc(d.symbolSearch || '*') + '</code>.' +
        ' Terminal mungkin masih memuat turun senarai simbol — cuba lagi sebentar, atau cari dengan corak lain seperti <code>*EUR*</code>.' +
        (d.symbolError ? '<br>Ralat: ' + esc(d.symbolError) : '') +
        (d.symbolRaw ? '<br><code style="font-size:10px">' + esc(d.symbolRaw) + '</code>' : '') + '</div>';
    }
  }).catch(function (e) {
    document.getElementById('mt5-gateway').innerHTML = '<div class="empty" style="color:var(--down)">' + esc(e.message) + '</div>';
  });
}

document.getElementById('ai-save').onclick = function () {
  var patch = {
    baseUrl: document.getElementById('ai-base').value.trim(),
    model: document.getElementById('ai-model').value.trim(),
  };
  var k = document.getElementById('ai-key').value.trim();
  if (k) patch.apiKey = k;
  saveAi(patch);
};
document.getElementById('ai-clear').onclick = function () {
  if (!confirm('Buang kunci API? AI akan kembali ke mod setempat.')) return;
  saveAi({ clearKey: true });
};

document.getElementById('cnd-go').onclick = function () {
  var sym = document.getElementById('cnd-symbol').value.trim();
  var tf = document.getElementById('cnd-tf').value;
  var out = document.getElementById('cnd-out');
  out.innerHTML = '<div class="empty">Mengambil…</div>';
  api('/api/owner/mt5/candles?symbol=' + encodeURIComponent(sym) + '&timeframe=' + encodeURIComponent(tf) + '&limit=60')
    .then(function (d) {
      if (!d.ok) {
        out.innerHTML = '<div class="empty" style="color:var(--down)">' + esc(d.error || 'gagal') +
          (d.code ? ' [' + esc(d.code) + ']' : '') + '</div>';
        return;
      }
      out.innerHTML =
        '<div class="row"><span class="k">Simbol</span><span class="v">' + esc(d.symbol) + ' · ' + esc(d.timeframe) + '</span></div>' +
        '<div class="row"><span class="k">Bilangan candle</span><span class="v">' + esc(d.count) + '</span></div>' +
        '<div class="row"><span class="k">Candle terakhir</span><span class="v">' + esc(dt(d.last)) + '</span></div>' +
        '<div class="row"><span class="k">Harga tutup</span><span class="v">' + esc(d.lastClose) + '</span></div>' +
        '<div class="scroll" style="margin-top:10px"><table><thead><tr><th>Masa</th><th>Buka</th><th>Tinggi</th><th>Rendah</th><th>Tutup</th><th>Vol</th></tr></thead><tbody>' +
        (d.candles || []).map(function (c) {
          return '<tr><td class="mono">' + dt(c.ts) + '</td><td class="mono">' + c.open + '</td><td class="mono">' + c.high +
            '</td><td class="mono">' + c.low + '</td><td class="mono">' + c.close + '</td><td class="mono">' + c.volume + '</td></tr>';
        }).join('') + '</tbody></table></div>';
    })
    .catch(function (e) { out.innerHTML = '<div class="empty" style="color:var(--down)">' + esc(e.message) + '</div>'; });
};

document.getElementById('sym-go').onclick = function () {
  mt5Search = document.getElementById('sym-search').value.trim() || '*';
  loadMt5();
};
document.getElementById('sym-search').addEventListener('keydown', function (e) {
  if (e.key === 'Enter') { e.preventDefault(); document.getElementById('sym-go').click(); }
});

function mt5Start() {
  mt5Stop();
  loadMt5();
  mt5Timer = setInterval(loadMt5, 5000);
}
function mt5Stop() {
  if (mt5Timer) { clearInterval(mt5Timer); mt5Timer = null; }
}

/* ── actions ── */
document.getElementById('issue').onclick = function () {
  var plan = document.getElementById('in-plan').value;
  var label = document.getElementById('in-label').value.trim();
  var quota = document.getElementById('in-quota').value;
  api('/api/owner/licences', { method: 'POST', body: JSON.stringify({ plan: plan, label: label, quota: quota === '' ? null : Number(quota) }) })
    .then(function (d) {
      var k = d.licence || {};
      document.getElementById('issued').innerHTML =
        '<div class="card" style="margin:0"><h2>Lesen baharu</h2>' +
        '<div class="row"><span class="k">Kunci</span><span class="v" style="color:var(--lime);font-weight:700">' + esc(k.readableKey || '') + '</span></div>' +
        '<div class="row"><span class="k">Pelan</span><span class="v">' + esc(k.plan || plan) + '</span></div>' +
        '<div class="row"><span class="k">Kuota</span><span class="v">' + (k.quota === null ? '∞' : money(k.quota)) + '</span></div>' +
        '<div class="row"><span class="k">Tamat</span><span class="v">' + when(k.expiresAt) + '</span></div>' +
        '<p class="empty" style="margin-top:10px">Hantar kunci ini kepada pemiliknya sendiri sahaja.</p></div>';
      toast('Lesen diterbitkan');
      loadLicences();
    })
    .catch(function (e) { toast(e.message, true); });
};

document.addEventListener('click', function (e) {
  var rev = e.target.closest('[data-revoke]');
  if (rev) {
    var id = rev.dataset.revoke;
    var to = rev.dataset.to === '1';
    api('/api/owner/licences/' + encodeURIComponent(id) + '/revoke', { method: 'POST', body: JSON.stringify({ revoked: to }) })
      .then(function () { toast(to ? 'Lesen dibatalkan' : 'Lesen dipulihkan'); loadLicences(); })
      .catch(function (er) { toast(er.message, true); });
    return;
  }
  var q = e.target.closest('[data-quota]');
  if (q) {
    var ans = prompt('Kuota baharu (kosongkan untuk tanpa had):');
    if (ans === null) return;
    api('/api/owner/licences/' + encodeURIComponent(q.dataset.quota) + '/quota', {
      method: 'POST',
      body: JSON.stringify({ quota: ans === '' ? null : Number(ans) }),
    }).then(function () { toast('Kuota dikemas kini'); loadLicences(); })
      .catch(function (er) { toast(er.message, true); });
    return;
  }
  var sh = e.target.closest('[data-share]');
  if (sh) {
    var pub = sh.dataset.pub === '1';
    api('/api/owner/files/' + encodeURIComponent(sh.dataset.share) + '/share', {
      method: 'POST', body: JSON.stringify({ public: pub }),
    }).then(function (d) {
      toast(pub ? 'Dikongsi: /f/' + (d.file && d.file.shareToken) : 'Pautan ditutup');
      loadFiles();
    }).catch(function (er) { toast(er.message, true); });
  }
});

document.getElementById('reset-all').onclick = function () {
  if (!confirm('Batalkan SEMUA lesen? Baris disimpan, jadi boleh dipulihkan.')) return;
  api('/api/owner/licences/reset', { method: 'POST', body: '{}' })
    .then(function (d) { toast('Dibatalkan ' + (d.revoked || 0) + ' / ' + (d.total || 0)); loadLicences(); })
    .catch(function (er) { toast(er.message, true); });
};

window.addEventListener('error', function (e) {
  var where = e.filename ? ' @ ' + String(e.filename).replace(/^https?:\/\/[^/]+/, '') + ':' + (e.lineno || 0) : '';
  var detail = e.message && e.message !== 'Script error.' ? e.message : 'ralat luar halaman (pelayar menyembunyikan butiran)';
  diag('ralat skrip: ' + detail + where);
});
window.addEventListener('unhandledrejection', function (e) {
  var r = e.reason;
  diag('janji gagal: ' + ((r && (r.message || r)) || 'tanpa butiran'));
});

/* ── boot: reuse an existing owner session if there is one ── */
api('/api/owner/session').then(function (s) {
  if (s.authenticated) open();
}).catch(function () {});
`;

/** The whole page. No build step, no dependencies. */
export function ownerConsoleHtml() {
  return `<!doctype html>
<html lang="ms">
<head>
<meta charset="utf-8" />
<meta name="viewport" content="width=device-width, initial-scale=1, viewport-fit=cover" />
<meta name="robots" content="noindex, nofollow" />
<meta name="color-scheme" content="dark" />
<title>LuminaVantage · Owner console</title>
<style>${STYLE}</style>
</head>
<body>
${BODY}
<script>${SCRIPT.replace('console-build', CONSOLE_BUILD)}</script>
</body>
</html>`;
}
