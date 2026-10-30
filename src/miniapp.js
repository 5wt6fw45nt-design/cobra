// The Telegram Mini App: every invoice in one AG Grid. Add ?demo=1 to see it with sample data outside Telegram.

const AG = 'https://cdn.jsdelivr.net/npm/ag-grid-community@32.3.3';

export const MINI_APP = `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1, viewport-fit=cover">
<title>Cobra</title>
<link rel="stylesheet" href="${AG}/styles/ag-grid.min.css">
<link rel="stylesheet" href="${AG}/styles/ag-theme-quartz.min.css">
<script src="https://telegram.org/js/telegram-web-app.js"></script>
<script src="${AG}/dist/ag-grid-community.min.js"></script>
<style>
  :root { --bg:#f3f6fb; --card:#fff; --ink:#0b1f4b; --soft:#5b6b8c; --line:#dfe6f1; --blue:#0070e0; --navy:#003087; --gold:#ffc439; --green:#128a50; --red:#c8352b; }
  :root[data-theme=dark] { --bg:#0b1324; --card:#131e36; --ink:#eaf0fb; --soft:#9fb0cf; --line:#26344f; --blue:#4ea3ff; --navy:#9cc4ff; --green:#4fd08f; --red:#ff7b70; }
  * { box-sizing:border-box; }
  html, body { height:100%; margin:0; }
  body { background:var(--bg); color:var(--ink); font:15px/1.35 -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif; display:flex; flex-direction:column; padding:14px 14px 10px; gap:12px; }
  header { display:flex; align-items:center; justify-content:space-between; gap:10px; }
  h1 { font-size:20px; margin:0; letter-spacing:.2px; }
  .sub { color:var(--soft); font-size:13px; }
  .kpis { display:grid; grid-template-columns:repeat(3, 1fr); gap:8px; }
  .kpi { background:var(--card); border:1px solid var(--line); border-radius:12px; padding:10px 12px; min-width:0; }
  .kpi b { display:block; font-size:16px; font-variant-numeric:tabular-nums; overflow-wrap:anywhere; }
  .kpi span { color:var(--soft); font-size:12px; }
  .kpi.paid b { color:var(--green); } .kpi.late b { color:var(--red); }
  .tools { display:flex; gap:8px; align-items:center; }
  .chips { display:flex; gap:6px; overflow-x:auto; flex:1; scrollbar-width:none; }
  .chips::-webkit-scrollbar { display:none; }
  button { font:inherit; border:1px solid var(--line); background:var(--card); color:var(--ink); border-radius:999px; padding:6px 12px; white-space:nowrap; cursor:pointer; }
  button.on { background:var(--blue); border-color:var(--blue); color:#fff; }
  #export { background:var(--gold); border-color:var(--gold); color:#102a5e; font-weight:600; }
  #search { width:100%; font:inherit; color:var(--ink); background:var(--card); border:1px solid var(--line); border-radius:10px; padding:9px 12px; outline:none; }
  #search:focus { border-color:var(--blue); }
  #grid { flex:1; min-height:240px; width:100%; }
  .ag-theme-quartz, .ag-theme-quartz-dark { --ag-font-family:inherit; --ag-background-color:var(--card); --ag-header-background-color:var(--card); --ag-border-color:var(--line); --ag-foreground-color:var(--ink); --ag-header-foreground-color:var(--soft); --ag-wrapper-border-radius:12px; --ag-row-hover-color:color-mix(in srgb, var(--blue) 8%, transparent); }
  .pill { display:inline-block; line-height:1; padding:5px 9px; border-radius:999px; font-size:12px; font-weight:600; }
  .pill.PAID { color:var(--green); background:color-mix(in srgb, var(--green) 14%, transparent); }
  .pill.SENT { color:var(--blue); background:color-mix(in srgb, var(--blue) 14%, transparent); }
  .pill.OVERDUE { color:var(--red); background:color-mix(in srgb, var(--red) 14%, transparent); }
  .pill.CANCELLED, .pill.REFUNDED { color:var(--soft); background:color-mix(in srgb, var(--soft) 14%, transparent); }
  #note { display:none; color:var(--soft); text-align:center; padding:40px 16px; }
  #toast { position:fixed; left:50%; bottom:18px; transform:translateX(-50%); background:var(--navy); color:#fff; padding:9px 14px; border-radius:10px; font-size:14px; display:none; max-width:90%; }
  :root[data-theme=dark] #toast { color:#0b1324; }
</style>
</head>
<body>
<header>
  <div><h1>Cobra</h1><div class="sub" id="sub"></div></div>
  <button id="export"></button>
</header>
<section class="kpis">
  <div class="kpi paid"><b id="kPaid">–</b><span id="lPaid"></span></div>
  <div class="kpi"><b id="kOpen">–</b><span id="lOpen"></span></div>
  <div class="kpi late"><b id="kLate">–</b><span id="lLate"></span></div>
</section>
<input id="search" type="search" autocomplete="off">
<div class="tools"><div class="chips" id="chips"></div></div>
<div id="grid" class="ag-theme-quartz"></div>
<div id="note"></div>
<div id="toast"></div>
<script>
const TEXT = {
  en: { sub: 'Your invoices, live from PayPal', export: 'Send CSV', paid: 'Collected', open: 'Pending', late: 'Overdue', search: 'Search client or concept', all: 'All', PAID: 'Paid', SENT: 'Pending', OVERDUE: 'Overdue', CANCELLED: 'Cancelled', REFUNDED: 'Refunded', client: 'Client', concept: 'Concept', amount: 'Amount', status: 'Status', due: 'Due', date: 'Date', pay: 'Link', open_: 'Open', empty: 'No invoices yet. Send me a voice note in the chat to create the first one.', noTg: 'Open this from the Cobra bot in Telegram.', sent: 'CSV sent to your chat', fail: 'That did not work. Try again.' },
  es: { sub: 'Tus facturas, al día con PayPal', export: 'Enviar CSV', paid: 'Cobrado', open: 'Pendiente', late: 'Vencido', search: 'Busca cliente o concepto', all: 'Todas', PAID: 'Pagada', SENT: 'Pendiente', OVERDUE: 'Vencida', CANCELLED: 'Cancelada', REFUNDED: 'Devuelta', client: 'Cliente', concept: 'Concepto', amount: 'Importe', status: 'Estado', due: 'Vence', date: 'Fecha', pay: 'Enlace', open_: 'Abrir', empty: 'Aún no hay facturas. Mándame un audio en el chat para crear la primera.', noTg: 'Abre esto desde el bot de Cobra en Telegram.', sent: 'CSV enviado a tu chat', fail: 'No ha funcionado. Inténtalo otra vez.' },
};
const tg = window.Telegram?.WebApp;
const demo = new URLSearchParams(location.search).has('demo');
const initData = tg?.initData || '';
let lang = /^es/.test(tg?.initDataUnsafe?.user?.language_code || navigator.language) ? 'es' : 'en';
const dark = tg?.colorScheme ? tg.colorScheme === 'dark' : matchMedia('(prefers-color-scheme: dark)').matches;
document.documentElement.dataset.theme = dark ? 'dark' : 'light';
tg?.ready(); tg?.expand();

const today = new Date().toISOString().slice(0, 10);
const shown = (r) => (r.status === 'SENT' && r.due && r.due < today ? 'OVERDUE' : r.status);
const money = (n, c) => new Intl.NumberFormat(lang === 'es' ? 'es-ES' : 'en-US', { style: 'currency', currency: c }).format(n);
const whole = (n, c) => new Intl.NumberFormat(lang === 'es' ? 'es-ES' : 'en-US', { style: 'currency', currency: c, maximumFractionDigits: 0 }).format(n);
const $ = (id) => document.getElementById(id);
let gridApi, filter = 'all';

function toast(text) {
  const el = $('toast'); el.textContent = text; el.style.display = 'block';
  clearTimeout(toast.t); toast.t = setTimeout(() => (el.style.display = 'none'), 2600);
}

function summary(rows) {
  const by = (keep) => {
    const sums = {};
    for (const r of rows) if (keep(r)) sums[r.currency] = (sums[r.currency] || 0) + r.amount;
    const parts = Object.entries(sums).map(([c, n]) => whole(n, c));
    return parts.length ? parts.join(' · ') : whole(0, rows[0]?.currency || 'EUR');
  };
  $('kPaid').textContent = by((r) => r.status === 'PAID');
  $('kOpen').textContent = by((r) => r.status === 'SENT');
  $('kLate').textContent = by((r) => shown(r) === 'OVERDUE');
}

function start(rows) {
  const t = TEXT[lang];
  document.documentElement.lang = lang;
  $('sub').textContent = t.sub; $('export').textContent = t.export;
  $('lPaid').textContent = t.paid; $('lOpen').textContent = t.open; $('lLate').textContent = t.late;
  $('search').placeholder = t.search;
  summary(rows);
  if (!rows.length) { $('note').textContent = t.empty; $('note').style.display = 'block'; $('grid').style.display = 'none'; }

  const chips = ['all', 'SENT', 'OVERDUE', 'PAID'];
  $('chips').innerHTML = '';
  for (const c of chips) {
    const b = document.createElement('button');
    b.textContent = c === 'all' ? t.all : t[c];
    b.className = c === filter ? 'on' : '';
    b.onclick = () => { filter = c; [...$('chips').children].forEach((x) => x.classList.toggle('on', x === b)); gridApi.onFilterChanged(); };
    $('chips').append(b);
  }

  const wide = innerWidth >= 620;
  gridApi = agGrid.createGrid($('grid'), {
    rowData: rows,
    rowHeight: 46,
    headerHeight: 40,
    animateRows: true,
    suppressCellFocus: true,
    defaultColDef: { sortable: true, resizable: true, filter: wide },
    columnDefs: [
      { headerName: t.client, field: 'client', minWidth: 116, ...(wide ? { flex: 1 } : { width: 124 }) },
      { headerName: t.amount, field: 'amount', type: 'numericColumn', minWidth: 96, width: 104, filter: wide ? 'agNumberColumnFilter' : false, valueFormatter: (p) => money(p.value, p.data.currency) },
      { headerName: t.status, colId: 'status', minWidth: 104, width: 112, cellStyle: { paddingLeft: '8px', paddingRight: '4px' }, valueGetter: (p) => shown(p.data), cellRenderer: (p) => { const s = document.createElement('span'); s.className = 'pill ' + p.value; s.textContent = t[p.value] || p.value; return s; } },
      { headerName: t.due, field: 'due', minWidth: 108, width: 116, sort: 'desc' },
      { headerName: t.concept, field: 'description', minWidth: 160, ...(wide ? { flex: 1 } : { width: 180 }) },
      { headerName: t.date, field: 'created', minWidth: 108, width: 116 },
      { headerName: t.pay, colId: 'pay', minWidth: 84, width: 90, sortable: false, filter: false, cellRenderer: (p) => {
        if (!p.data.payUrl) return '';
        const a = document.createElement('a'); a.href = p.data.payUrl; a.target = '_blank'; a.rel = 'noopener'; a.textContent = t.open_;
        a.style.color = 'var(--blue)';
        a.onclick = (e) => { if (tg?.openLink) { e.preventDefault(); tg.openLink(p.data.payUrl); } };
        return a;
      } },
    ],
    isExternalFilterPresent: () => filter !== 'all',
    doesExternalFilterPass: (node) => shown(node.data) === filter,
  });
  $('search').oninput = (e) => gridApi.setGridOption('quickFilterText', e.target.value);
  $('export').onclick = async () => {
    if (demo) return toast(t.sent);
    const res = await fetch('/app/export', { method: 'POST', body: JSON.stringify({ initData }) }).catch(() => null);
    toast(res?.ok ? t.sent : t.fail);
  };
}

const SAMPLE = [
  { id: 1, client: 'Marta García', description: 'Logo design', amount: 350, currency: 'EUR', due: '2026-11-14', status: 'SENT', created: '2026-10-30', payUrl: '#' },
  { id: 2, client: 'Studio Norte', description: 'Website, phase 1', amount: 1200, currency: 'EUR', due: '2026-10-20', status: 'SENT', created: '2026-10-05', payUrl: '#' },
  { id: 3, client: 'Pablo Ruiz', description: 'Photo session', amount: 280, currency: 'EUR', due: '2026-10-25', status: 'PAID', created: '2026-10-10', payUrl: '#' },
  { id: 4, client: 'Ana López', description: 'Translation', amount: 95.5, currency: 'EUR', due: '2026-11-02', status: 'PAID', created: '2026-10-18', payUrl: '#' },
];

(async () => {
  if (demo) return start(SAMPLE);
  const t = TEXT[lang];
  const res = initData ? await fetch('/app/data', { method: 'POST', body: JSON.stringify({ initData }) }).catch(() => null) : null;
  if (!res?.ok) {
    $('grid').style.display = 'none'; $('note').style.display = 'block';
    $('note').textContent = initData ? t.fail : t.noTg;
    return;
  }
  const data = await res.json();
  if (data.lang) lang = data.lang === 'es' ? 'es' : 'en';
  start(data.rows);
})();
</script>
</body>
</html>`;
