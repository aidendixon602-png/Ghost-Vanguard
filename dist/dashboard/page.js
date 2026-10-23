/**
 * The dashboard page. One self-contained document: no build step, no external fonts or scripts, so it
 * works on a host with no internet, inside the Discord host's port, and offline in a browser tab.
 * It reads the JSON endpoints next to it and re-renders every 15 seconds.
 */
import { LOGO_DATA_URI } from './logo.js';
export const THEME = {
    /** Ghost violet — the brand colour, used for structure and calm states. */
    violet: '#6d5ae6',
    violetSoft: '#8f7ff0',
    /** Yin: defence. */
    yin: '#2aa5a0',
    /** Yang: counter-attack. */
    yang: '#e0483f',
    ink: '#0d0d15',
    panel: '#14141f',
    line: '#262637',
    text: '#e8e8f2',
    muted: '#9a9ab4',
    amber: '#e8a33d',
};
export function dashboardPage(tokenRequired) {
    return `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>Ghost Vanguard · Control Board</title>
<link rel="icon" type="image/png" href="${LOGO_DATA_URI}">
<style>
:root{--violet:${THEME.violet};--violet-soft:${THEME.violetSoft};--yin:${THEME.yin};--yang:${THEME.yang};--ink:${THEME.ink};--panel:${THEME.panel};--line:${THEME.line};--text:${THEME.text};--muted:${THEME.muted};--amber:${THEME.amber}}
*{box-sizing:border-box}
body{margin:0;background:radial-gradient(1200px 600px at 15% -10%,#1d1a35 0%,var(--ink) 55%);color:var(--text);font:15px/1.5 ui-sans-serif,system-ui,'Segoe UI',Roboto,sans-serif;min-height:100vh}
a{color:var(--violet-soft)}
header{display:flex;flex-wrap:wrap;gap:16px;align-items:center;justify-content:space-between;padding:22px 26px;border-bottom:1px solid var(--line);background:linear-gradient(180deg,rgba(109,90,230,.14),transparent)}
.brand{display:flex;gap:14px;align-items:center}
.mark{width:44px;height:44px;border-radius:50%;display:block;box-shadow:0 0 0 1px var(--line),0 8px 24px rgba(109,90,230,.35)}
h1{font-size:19px;margin:0;letter-spacing:.2px}
.tag{margin:2px 0 0;color:var(--muted);font-size:12.5px}
.controls{display:flex;gap:10px;flex-wrap:wrap;align-items:center}
select,button,input{background:#191926;color:var(--text);border:1px solid var(--line);border-radius:10px;padding:8px 12px;font:inherit}
button{cursor:pointer}
button:hover{border-color:var(--violet)}
main{padding:22px 26px 60px;max-width:1240px;margin:0 auto}
.kpis{display:grid;grid-template-columns:repeat(auto-fit,minmax(170px,1fr));gap:14px;margin-bottom:20px}
.kpi{background:linear-gradient(180deg,rgba(255,255,255,.03),transparent),var(--panel);border:1px solid var(--line);border-radius:14px;padding:14px 16px}
.kpi b{display:block;font-size:26px;line-height:1.15}
.kpi span{color:var(--muted);font-size:12.5px;text-transform:uppercase;letter-spacing:.08em}
.kpi.yang b{color:var(--yang)}.kpi.yin b{color:var(--yin)}.kpi.violet b{color:var(--violet-soft)}.kpi.amber b{color:var(--amber)}
.grid{display:grid;grid-template-columns:1.35fr 1fr;gap:16px}
@media(max-width:940px){.grid{grid-template-columns:1fr}}
section{background:var(--panel);border:1px solid var(--line);border-radius:16px;overflow:hidden;margin-bottom:16px}
section h2{margin:0;padding:14px 16px;font-size:15px;border-bottom:1px solid var(--line);display:flex;justify-content:space-between;align-items:center;gap:10px}
section h2 small{color:var(--muted);font-weight:400}
.pad{padding:12px 16px}
table{width:100%;border-collapse:collapse;font-size:14px}
th,td{text-align:left;padding:9px 16px;border-bottom:1px solid rgba(38,38,55,.7);white-space:nowrap;overflow:hidden;text-overflow:ellipsis;max-width:340px}
th{color:var(--muted);font-weight:600;font-size:11.5px;text-transform:uppercase;letter-spacing:.08em}
tr:hover td{background:rgba(109,90,230,.07)}
.pill{display:inline-block;padding:2px 9px;border-radius:999px;font-size:12px;border:1px solid transparent}
.pill.critical{background:rgba(224,72,63,.16);color:#ff9c95;border-color:rgba(224,72,63,.5)}
.pill.high{background:rgba(232,163,61,.16);color:#ffd39b;border-color:rgba(232,163,61,.45)}
.pill.watch{background:rgba(109,90,230,.16);color:#c3b8ff;border-color:rgba(109,90,230,.5)}
.pill.quiet,.pill.ok{background:rgba(42,165,160,.14);color:#9fe6e2;border-color:rgba(42,165,160,.45)}
.pill.bad{background:rgba(224,72,63,.16);color:#ff9c95;border-color:rgba(224,72,63,.5)}
.empty{color:var(--muted);padding:16px;font-size:14px}
.feed{list-style:none;margin:0;padding:8px 0}
.feed li{padding:8px 16px;border-bottom:1px solid rgba(38,38,55,.6);font-size:13.5px;display:flex;gap:10px}
.feed time{color:var(--muted);font-size:12px;min-width:74px}
footer{color:var(--muted);font-size:12.5px;text-align:center;padding:26px}
.bar{height:6px;border-radius:99px;background:#22222f;overflow:hidden;min-width:70px}
.bar i{display:block;height:100%;background:linear-gradient(90deg,var(--yin),var(--yang))}
.error{color:#ff9c95}
</style></head>
<body>
<header>
  <div class="brand"><img class="mark" src="${LOGO_DATA_URI}" alt="" width="44" height="44"><div>
    <h1>Ghost Vanguard <span style="color:var(--violet-soft)">· Control Board</span></h1>
    <p class="tag" id="tagline">Defence and counter-attack, balanced. Live view of every server.</p>
  </div></div>
  <div class="controls">
    <select id="server" title="Server"></select>
    <select id="view" title="View">
      <option value="board">Threat board</option>
      <option value="tickets">Tickets</option>
      <option value="incidents">Incidents</option>
      <option value="servers">All servers</option>
    </select>
    <button id="refresh">Refresh</button>
    <span class="tag" id="status">loading…</span>
  </div>
</header>
<main>
  <div class="kpis" id="kpis"></div>
  <div class="grid">
    <div>
      <section><h2>🎯 Threat board <small id="board-note"></small></h2><div id="board"></div></section>
      <section><h2>🎫 Tickets <small id="ticket-note"></small></h2><div id="tickets"></div></section>
    </div>
    <div>
      <section><h2>⚔️ Automatic actions <small>newest first</small></h2><div id="actions"></div></section>
      <section><h2>🚨 Recent incidents</h2><div id="incidents"></div></section>
      <section><h2>🛡️ Protection</h2><div id="protection" class="pad"></div></section>
    </div>
  </div>
</main>
<footer>Ghost Vanguard dashboard · reading the bot's own database · every automatic action is reversible with <code>/antinuke threats release</code></footer>
<script>
const TOKEN = ${tokenRequired ? `new URLSearchParams(location.search).get('token') || ''` : `''`};
const q = p => p + (TOKEN ? (p.includes('?') ? '&' : '?') + 'token=' + encodeURIComponent(TOKEN) : '');
const esc = s => String(s ?? '').replace(/[&<>"']/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
const when = ts => ts ? new Date(ts).toLocaleString() : '—';
const ago = ts => { if(!ts) return '—'; const s = Math.floor((Date.now()-ts)/1000);
  if (s < 60) return s + 's ago'; if (s < 3600) return Math.floor(s/60) + 'm ago'; if (s < 86400) return Math.floor(s/3600) + 'h ago'; return Math.floor(s/86400) + 'd ago'; };
const kpi = (label, value, cls='') => '<div class="kpi ' + cls + '"><b>' + esc(value) + '</b><span>' + esc(label) + '</span></div>';
const table = (heads, rows) => rows.length
  ? '<table><thead><tr>' + heads.map(h => '<th>' + esc(h) + '</th>').join('') + '</tr></thead><tbody>' + rows.join('') + '</tbody></table>'
  : '<div class="empty">' + 'Nothing here yet.' + '</div>';
const level = l => '<span class="pill ' + esc(l) + '">' + esc(l) + '</span>';

let servers = [], current = '', view = 'board';

async function get(path) {
  const res = await fetch(q(path), { headers: TOKEN ? { authorization: 'Bearer ' + TOKEN } : {} });
  if (!res.ok) throw new Error(res.status + ' ' + res.statusText);
  return res.json();
}

function renderBoard(data) {
  document.getElementById('board-note').textContent = data.summary.total + ' watched · ' + data.summary.critical + ' critical';
  const rows = data.threats.map(t => '<tr><td><code>' + esc(t.userId) + '</code></td><td>' + level(t.level) + '</td><td>' + esc(t.score) + '</td>'
    + '<td>' + esc(t.lastRuleLabel) + '</td><td title="' + esc(when(t.lastSeen)) + '">' + esc(ago(t.lastSeen)) + '</td>'
    + '<td>' + esc(t.lastAction || '—') + '</td></tr>');
  document.getElementById('board').innerHTML = table(['Member', 'Level', 'Points', 'What they did', 'Last seen', 'Bot action'], rows);
}

function renderActions(data) {
  const items = data.actions.map(a => '<li><time>' + esc(ago(a.at)) + '</time><span><b>' + esc(a.action) + '</b> · <code>' + esc(a.userId) + '</code><br><span style="color:var(--muted)">'
    + esc(a.detail) + '</span></span></li>');
  document.getElementById('actions').innerHTML = items.length ? '<ul class="feed">' + items.join('') + '</ul>' : '<div class="empty">No automatic action has been taken. The board is watching.</div>';
}

function renderIncidents(rows) {
  const body = rows.map(i => '<tr><td>#' + esc(i.id) + '</td><td><code>' + esc(i.actor) + '</code></td><td>' + esc(i.rule) + '</td><td>' + esc(i.mode) + '</td><td title="' + esc(when(i.at)) + '">' + esc(ago(i.at)) + '</td></tr>');
  document.getElementById('incidents').innerHTML = table(['#', 'Actor', 'Rule', 'Mode', 'When'], body);
}

function renderTickets(data) {
  const s = data.stats;
  document.getElementById('ticket-note').textContent = s.open + ' open · ' + s.total + ' total' + (s.average === null ? '' : ' · ' + s.average.toFixed(2) + '★');
  const rows = data.tickets.map(t => '<tr><td>#' + String(t.number).padStart(4, '0') + '</td><td><code>' + esc(t.user) + '</code></td>'
    + '<td>' + esc(t.type) + '</td><td>' + esc(t.status) + '</td><td>' + esc(t.claimedBy ? 'claimed' : 'unclaimed') + '</td><td>' + esc(t.rating ? t.rating + '★' : '—') + '</td></tr>');
  document.getElementById('tickets').innerHTML = table(['#', 'Member', 'Type', 'Status', 'Staff', 'Rating'], rows);
}

function renderProtection(summary) {
  const p = summary.protection;
  document.getElementById('protection').innerHTML = [
    '<div><span class="pill ' + (p.enabled ? 'ok' : 'bad') + '">' + (p.enabled ? 'Anti-nuke on' : 'Anti-nuke off') + '</span> ',
    '<span class="pill watch">' + esc(p.mode) + '</span></div>',
    '<p class="tag">' + esc(p.rules) + ' rules active · ' + esc(p.trusted) + ' trusted · ' + esc(summary.incidents.last24h) + ' incidents in 24h · ' + esc(summary.cases) + ' cases · ' + esc(summary.snapshots) + ' recovery points</p>',
    '<p class="tag">Tickets: ' + esc(summary.tickets.total) + ' total · ' + esc(summary.tickets.open) + ' open · ' + esc(summary.tickets.closed) + ' closed</p>'
  ].join('');
}

function renderAllServers(data) {
  const rows = data.servers.map(s => '<tr><td>' + esc(s.name) + '</td><td>' + (s.authorized ? '<span class="pill ok">authorized</span>' : '<span class="pill bad">not authorized</span>') + '</td>'
    + '<td>' + esc(s.protection.mode) + '</td><td>' + esc(s.threats.critical) + ' / ' + esc(s.threats.high) + ' / ' + esc(s.threats.watch) + '</td>'
    + '<td>' + esc(s.incidents.last24h) + '</td><td>' + esc(s.tickets.open) + ' / ' + esc(s.tickets.total) + '</td></tr>');
  document.getElementById('board').innerHTML = table(['Server', 'Status', 'Mode', 'Crit / High / Watch', 'Incidents 24h', 'Tickets open / total'], rows);
  document.getElementById('kpis').innerHTML = '';
  document.getElementById('board-note').textContent = data.totals.servers + ' servers';
  document.getElementById('tickets').innerHTML = '<div class="empty">Pick a server to see its tickets.</div>';
  document.getElementById('actions').innerHTML = '<div class="empty">Pick a server to see what the bot has done.</div>';
  document.getElementById('incidents').innerHTML = '<div class="empty">Pick a server to see its incidents.</div>';
  document.getElementById('protection').innerHTML = '<p class="tag">' + esc(data.totals.protected) + ' of ' + esc(data.totals.servers) + ' servers protected · ' + esc(data.totals.openTickets) + ' tickets open across the network.</p>';
}

async function tick() {
  try {
    const status = document.getElementById('status');
    if (view === 'servers') {
      const data = await get('/api/overview');
      renderAllServers(data);
      status.textContent = 'updated ' + new Date().toLocaleTimeString();
      return;
    }
    if (!current) { status.textContent = 'no servers yet'; return; }
    const summary = await get('/api/guild?id=' + encodeURIComponent(current));
    document.getElementById('kpis').innerHTML = [
      kpi('Threats watched', summary.threats.total, 'yang'),
      kpi('Critical', summary.threats.critical, 'yang'),
      kpi('Open tickets', summary.tickets.open, 'violet'),
      kpi('Incidents 24h', summary.incidents.last24h, 'amber'),
      kpi('Anti-nuke', summary.protection.enabled ? summary.protection.mode : 'off', 'yin'),
      kpi('Servers', servers.length, 'violet')
    ].join('');
    renderBoard({ ...summary.board, summary: summary.board.summary, threats: summary.board.threats, actions: summary.board.actions });
    renderActions(summary.board);
    renderIncidents(summary.incidents);
    renderTickets(summary.tickets);
    renderProtection(summary);
    status.textContent = 'updated ' + new Date().toLocaleTimeString();
  } catch (error) {
    document.getElementById('status').innerHTML = '<span class="error">' + esc(error.message) + '</span>';
  }
}

async function start() {
  try {
    servers = await get('/api/guilds');
    const select = document.getElementById('server');
    select.innerHTML = servers.map(s => '<option value="' + esc(s.id) + '">' + esc(s.name) + (s.authorized ? '' : ' (not authorized)') + '</option>').join('') || '<option value="">No servers yet</option>';
    current = servers.length ? servers[0].id : '';
    select.onchange = () => { current = select.value; tick(); };
    document.getElementById('view').onchange = event => {
      view = event.target.value;
      select.style.display = view === 'servers' ? 'none' : '';
      tick();
    };
    document.getElementById('refresh').onclick = tick;
    await tick();
    setInterval(tick, 15000);
  } catch (error) {
    document.getElementById('status').innerHTML = '<span class="error">' + esc(error.message) + '</span>';
  }
}
start();
</script>
</body></html>`;
}
