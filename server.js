/* My Apps — a control panel for every service running on Render.
 *
 * Deliberately dependency-free: it runs on Node's own http module and global
 * fetch. Nothing to npm-install means nothing to break on deploy, and the whole
 * thing stays one readable file.
 *
 * It holds a Render API key, so it is password-gated and the key is never sent
 * to the browser.
 */

const http = require('http');
const crypto = require('crypto');
const store = require('./store');

const PORT = process.env.PORT || 3000;
const BUILD = '2026-08-31.1';
const PASSWORD = process.env.APP_PASSWORD || '';
const RENDER_KEY = process.env.RENDER_API_KEY || '';
const SECRET = process.env.SESSION_SECRET || crypto.randomBytes(32).toString('hex');
const CACHE_MS = 60_000;

/* ------------------------------------------------------------- pricing --- */
/* Render's API reports a plan name, not a price. These are list prices in USD
   per month as a guide only -- they drift, so the UI says "approx". */
const PRICES = {
  free: 0, starter: 7, standard: 25, pro: 85, pro_plus: 175, pro_max: 225, pro_ultra: 450,
  basic_256mb: 6, basic_1gb: 19, basic_4gb: 45,
  pro_4gb: 95, pro_8gb: 135, pro_16gb: 225, pro_32gb: 425, pro_64gb: 795,
  accelerated_16gb: 450, accelerated_32gb: 850
};
const priceOf = plan => (plan in PRICES ? PRICES[plan] : null);

/* ---------------------------------------------------------- render api --- */

// Overridable so the dashboard can be tested against a stand-in API.
const API_BASE = process.env.RENDER_API_BASE || 'https://api.render.com/v1';

async function render(path) {
  if (!RENDER_KEY) throw new Error('RENDER_API_KEY is not set on this service');
  const res = await fetch(API_BASE + path, {
    headers: { Authorization: 'Bearer ' + RENDER_KEY, Accept: 'application/json' },
    signal: AbortSignal.timeout(20000)
  });
  const text = await res.text();
  if (!res.ok) {
    throw new Error(`Render API ${res.status} on ${path}: ${text.slice(0, 200)}`);
  }
  try { return JSON.parse(text); }
  catch (e) { throw new Error('Render API returned non-JSON on ' + path); }
}

// The list endpoints wrap each row: [{ cursor, service: {...} }]
const unwrap = (rows, key) => (Array.isArray(rows) ? rows : []).map(r => r[key] || r).filter(Boolean);

let cache = { at: 0, data: null };

async function collect() {
  if (cache.data && Date.now() - cache.at < CACHE_MS) return cache.data;

  const owners = unwrap(await render('/owners?limit=50'), 'owner');
  const ownerName = new Map(owners.map(o => [o.id, o.name]));

  const services = unwrap(await render('/services?limit=100'), 'service');
  const databases = unwrap(await render('/postgres?limit=100'), 'postgres');

  // Last deploy per web service, fetched in parallel but tolerant of failures:
  // one bad service must not blank the whole dashboard.
  const deployable = services.filter(s => s.type !== 'static_site' || true);
  const deploys = await Promise.all(deployable.map(async s => {
    try {
      const rows = unwrap(await render(`/services/${s.id}/deploys?limit=1`), 'deploy');
      return [s.id, rows[0] || null];
    } catch (e) { return [s.id, { error: e.message }]; }
  }));
  const deployById = new Map(deploys);

  const now = Date.now();
  const items = [];

  for (const s of services) {
    const d = s.serviceDetails || {};
    const dep = deployById.get(s.id);
    // Static sites are free to host; their buildPlan governs build minutes, so
    // reading it as a monthly charge would inflate the total.
    const isStatic = s.type === 'static_site';
    const planName = isStatic ? 'static (free)' : (d.plan || d.buildPlan || '');
    const planPrice = isStatic ? 0 : priceOf(d.plan || d.buildPlan);
    items.push({
      kind: 'service',
      id: s.id,
      name: s.name,
      type: s.type,
      workspace: ownerName.get(s.ownerId) || s.ownerId,
      url: d.url || '',
      dashboardUrl: s.dashboardUrl,
      repo: s.repo || '',
      branch: s.branch || '',
      region: d.region || '',
      plan: planName,
      price: planPrice,
      suspended: s.suspended !== 'not_suspended',
      autoDeploy: s.autoDeploy,
      deploy: dep && !dep.error ? {
        status: dep.status,
        finishedAt: dep.finishedAt || dep.createdAt,
        commit: dep.commit ? String(dep.commit.message || '').split('\n')[0].slice(0, 60) : ''
      } : null,
      deployError: dep && dep.error ? dep.error : null
    });
  }

  for (const p of databases) {
    const expires = p.expiresAt ? new Date(p.expiresAt).getTime() : null;
    items.push({
      kind: 'database',
      id: p.id,
      name: p.name,
      type: 'postgres',
      workspace: ownerName.get(p.owner ? p.owner.id : p.ownerId) || '',
      dashboardUrl: p.dashboardUrl,
      region: p.region || '',
      plan: p.plan || '',
      price: priceOf(p.plan),
      status: p.status,
      version: p.version,
      suspended: p.suspended && p.suspended !== 'not_suspended',
      expiresAt: p.expiresAt || null,
      expiresInDays: expires ? Math.round((expires - now) / 864e5) : null
    });
  }

  const data = { items, fetchedAt: new Date().toISOString() };
  cache = { at: Date.now(), data };
  return data;
}

/* Anything that needs your attention, worst first. Free databases silently
   delete themselves, which is the failure mode most worth shouting about. */
function alertsFor(items) {
  const out = [];
  for (const it of items) {
    if (it.kind === 'database' && it.expiresInDays !== null) {
      out.push({
        level: it.expiresInDays <= 7 ? 'bad' : 'warn',
        what: it.name,
        msg: it.expiresInDays <= 0
          ? 'Free database has expired and may already be deleted'
          : `Free database expires in ${it.expiresInDays} day${it.expiresInDays === 1 ? '' : 's'} — it gets deleted, data and all`,
        fix: 'Upgrade to a paid plan on its Render page'
      });
    }
    if (it.suspended) {
      out.push({ level: 'bad', what: it.name, msg: 'Suspended — not serving traffic', fix: 'Check billing and the Render dashboard' });
    }
    if (it.deploy && /fail|canceled|error/i.test(it.deploy.status || '')) {
      out.push({ level: 'bad', what: it.name, msg: 'Last deploy ' + it.deploy.status, fix: 'Read the deploy logs on Render' });
    }
    if (it.deployError) {
      out.push({ level: 'warn', what: it.name, msg: 'Could not read deploy status', fix: it.deployError });
    }
    if (it.kind === 'service' && it.plan === 'free' && it.type === 'web_service') {
      out.push({ level: 'info', what: it.name, msg: 'Free plan — sleeps after 15 min idle, ~50s cold start', fix: 'Starter plan removes the delay' });
    }
  }
  const rank = { bad: 0, warn: 1, info: 2 };
  return out.sort((a, b) => rank[a.level] - rank[b.level]);
}

/* --------------------------------------------------------------- auth --- */

const sign = v => v + '.' + crypto.createHmac('sha256', SECRET).update(v).digest('hex').slice(0, 32);
function validToken(tok) {
  if (!tok || !tok.includes('.')) return false;
  const v = tok.slice(0, tok.lastIndexOf('.'));
  const expected = sign(v);
  const a = Buffer.from(tok), b = Buffer.from(expected);
  if (a.length !== b.length) return false;
  if (!crypto.timingSafeEqual(a, b)) return false;
  return Number(v) > Date.now() - 30 * 864e5;
}
const cookieOf = (req, name) => {
  const raw = req.headers.cookie || '';
  for (const part of raw.split(';')) {
    const [k, ...rest] = part.trim().split('=');
    if (k === name) return rest.join('=');
  }
  return '';
};
const passwordOk = given => {
  if (!PASSWORD) return false;
  const a = Buffer.from(String(given || ''));
  const b = Buffer.from(PASSWORD);
  return a.length === b.length && crypto.timingSafeEqual(a, b);
};

/* ---------------------------------------------------------------- ui --- */

const esc = s => String(s == null ? '' : s)
  .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
  .replace(/"/g, '&quot;');

const ago = iso => {
  if (!iso) return '';
  const mins = Math.round((Date.now() - new Date(iso).getTime()) / 60000);
  if (mins < 60) return mins + 'm ago';
  const h = Math.round(mins / 60);
  if (h < 48) return h + 'h ago';
  return Math.round(h / 24) + 'd ago';
};

const CSS = `
:root{--bg:#f5f6f8;--card:#fff;--ink:#12161f;--muted:#6b7280;--line:#e4e7ec;
  --brand:#1e3a5f;--ok:#0f7b45;--warn:#b45309;--bad:#b42318;--r:12px}
*{box-sizing:border-box}
body{margin:0;background:var(--bg);color:var(--ink);
  font:15px/1.5 -apple-system,BlinkMacSystemFont,"Segoe UI",Roboto,Helvetica,Arial,sans-serif}
.top{background:var(--brand);color:#fff;padding:14px 16px;display:flex;align-items:center;gap:10px;
  padding-top:calc(14px + env(safe-area-inset-top))}
.top b{font-size:17px}.top .sp{flex:1}
.top a{color:#cfe0f2;font-size:13px;text-decoration:none}
.wrap{max-width:1000px;margin:0 auto;padding:14px 14px 60px}
.card{background:var(--card);border:1px solid var(--line);border-radius:var(--r);padding:14px;margin-bottom:12px}
h1{font-size:20px;margin:6px 0 14px}h2{font-size:15px;margin:0 0 10px}
.sub{color:var(--muted);font-weight:400;font-size:12px}
.grid{display:grid;gap:10px;grid-template-columns:repeat(auto-fill,minmax(240px,1fr))}
.svc{border:1px solid var(--line);border-left:4px solid var(--line);border-radius:10px;padding:11px 12px;background:#fff}
.svc.ok{border-left-color:var(--ok)}.svc.bad{border-left-color:var(--bad)}.svc.warn{border-left-color:var(--warn)}
.svc .n{font-weight:600}
.svc .m{font-size:12.5px;color:var(--muted);margin-top:2px;word-break:break-word}
.pill{display:inline-block;font-size:11px;font-weight:700;padding:2px 7px;border-radius:99px;background:#eef1f5;color:#41506b}
.pill.ok{background:#e3f5ea;color:var(--ok)}.pill.bad{background:#fde8e6;color:var(--bad)}
.pill.warn{background:#fdf0e3;color:var(--warn)}
.al{padding:10px 12px;border-radius:9px;margin-bottom:8px;font-size:13.5px;border:1px solid}
.al.bad{background:#fde8e6;border-color:#f5c6c2;color:#7a1a14}
.al.warn{background:#fdf3e3;border-color:#f0dcc0;color:#7a4c09}
.al.info{background:#eef2f7;border-color:#dde4ee;color:#41506b}
.al b{display:block}
.stats{display:grid;grid-template-columns:repeat(2,1fr);gap:10px;margin-bottom:12px}
@media(min-width:700px){.stats{grid-template-columns:repeat(4,1fr)}}
.stat{background:#fff;border:1px solid var(--line);border-radius:var(--r);padding:12px}
.stat .v{font-size:24px;font-weight:700}.stat .l{font-size:12px;color:var(--muted)}
a.btn,button{font:14px system-ui;padding:9px 15px;border:0;border-radius:9px;background:var(--brand);
  color:#fff;text-decoration:none;display:inline-block;cursor:pointer}
a.link{color:#2b5b8c;font-size:12.5px}
input{width:100%;padding:11px 12px;border:1px solid var(--line);border-radius:9px;font:15px system-ui}
.login{max-width:340px;margin:12vh auto;padding:0 16px}
.err{color:var(--bad);font-size:13px;margin-top:8px}
table{width:100%;border-collapse:collapse;font-size:13.5px}
th{text-align:left;font-size:11px;text-transform:uppercase;letter-spacing:.4px;color:var(--muted);
  padding:6px;border-bottom:1px solid var(--line)}
td{padding:8px 6px;border-bottom:1px solid var(--line)}
td.num,th.num{text-align:right}
`;

const page = (title, body) => `<!doctype html><html lang="en"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1,viewport-fit=cover">
<meta name="theme-color" content="#1e3a5f"><title>${esc(title)}</title><style>${CSS}</style></head>
<body>${body}</body></html>`;

const loginPage = err => page('My Apps', `<div class="login">
  <div class="card">
    <h1 style="margin-top:0">My Apps</h1>
    <form method="POST" action="/login">
      <input name="password" type="password" placeholder="Password" autofocus>
      <button style="margin-top:10px;width:100%">Sign in</button>
      ${err ? `<div class="err">${esc(err)}</div>` : ''}
    </form>
  </div></div>`);

function dashboard(data, error) {
  const items = data ? data.items : [];
  const alerts = alertsFor(items);
  const services = items.filter(i => i.kind === 'service');
  const dbs = items.filter(i => i.kind === 'database');
  const spend = items.reduce((s, i) => s + (i.price || 0), 0);
  const unknownPrice = items.some(i => i.price === null && i.plan);

  const byWorkspace = {};
  for (const i of items) (byWorkspace[i.workspace] = byWorkspace[i.workspace] || []).push(i);

  const card = i => {
    let cls = 'ok', pill = '<span class="pill ok">ok</span>';
    if (i.suspended) { cls = 'bad'; pill = '<span class="pill bad">suspended</span>'; }
    else if (i.deploy && /fail|canceled|error/i.test(i.deploy.status)) {
      cls = 'bad'; pill = `<span class="pill bad">${esc(i.deploy.status)}</span>`;
    } else if (i.expiresInDays !== null && i.expiresInDays !== undefined && i.expiresInDays <= 30) {
      cls = 'warn'; pill = `<span class="pill warn">${i.expiresInDays}d left</span>`;
    } else if (i.deploy) {
      pill = `<span class="pill ok">${esc(i.deploy.status)}</span>`;
    }
    return `<div class="svc ${cls}">
      <div style="display:flex;gap:8px;align-items:flex-start">
        <div style="flex:1"><div class="n">${esc(i.name)}</div>
          <div class="m">${esc(i.type.replace('_', ' '))}${i.plan ? ' · ' + esc(i.plan) : ''}${i.region ? ' · ' + esc(i.region) : ''}${
            i.price !== null && i.price !== undefined ? ' · ~$' + i.price + '/mo' : ''}</div>
          ${i.deploy ? `<div class="m">deployed ${esc(ago(i.deploy.finishedAt))}${i.deploy.commit ? ' · ' + esc(i.deploy.commit) : ''}</div>` : ''}
          ${i.deployError ? `<div class="m" style="color:var(--warn)">${esc(i.deployError)}</div>` : ''}
          <div class="m">${i.url ? `<a class="link" href="${esc(i.url)}" target="_blank">open app</a> · ` : ''}
            <a class="link" href="${esc(i.dashboardUrl)}" target="_blank">render</a></div>
        </div>${pill}
      </div></div>`;
  };

  return page('My Apps', `
  <div class="top"><b>My Apps</b><span class="sub" style="color:#9db8d6">build ${BUILD}</span>
    <span class="sp"></span><a href="/subscriptions">subscriptions</a>
    <a href="/?refresh=1">refresh</a> <a href="/logout">sign out</a></div>
  <div class="wrap">
    ${error ? `<div class="al bad"><b>Couldn't reach Render</b>${esc(error)}</div>` : ''}
    <div class="stats">
      <div class="stat"><div class="v">${services.length}</div><div class="l">Services</div></div>
      <div class="stat"><div class="v">${dbs.length}</div><div class="l">Databases</div></div>
      <div class="stat"><div class="v" style="color:${alerts.some(a => a.level === 'bad') ? 'var(--bad)' : 'var(--ink)'}">${
        alerts.filter(a => a.level !== 'info').length}</div><div class="l">Need attention</div></div>
      <div class="stat"><div class="v">~$${spend}</div><div class="l">Per month${unknownPrice ? ' (some unknown)' : ''}</div></div>
    </div>

    ${alerts.length ? `<div class="card"><h2>Attention <span class="sub">worst first</span></h2>
      ${alerts.map(a => `<div class="al ${a.level}"><b>${esc(a.what)}</b>${esc(a.msg)} — ${esc(a.fix)}</div>`).join('')}
    </div>` : '<div class="card"><h2>Attention</h2><div class="sub">Nothing needs you right now.</div></div>'}

    ${Object.entries(byWorkspace).map(([ws, list]) => `
      <div class="card"><h2>${esc(ws)} <span class="sub">${list.length}</span></h2>
        <div class="grid">${list.map(card).join('')}</div></div>`).join('')}

    <div class="card"><h2>Costs <span class="sub">approximate list prices, not your invoice</span></h2>
      <table><tr><th>Service</th><th>Plan</th><th class="num">~$/mo</th></tr>
        ${items.filter(i => i.plan).map(i => `<tr><td>${esc(i.name)}</td><td>${esc(i.plan)}</td>
          <td class="num">${i.price === null ? '?' : '$' + i.price}</td></tr>`).join('')}
        <tr><td colspan="2"><b>Total</b></td><td class="num"><b>~$${spend}</b></td></tr></table>
      <div class="sub" style="margin-top:8px">Render's API reports plan names, not prices. Check your
        Render billing page for the real figure.</div>
    </div>

    <div class="card sub">Data ${data ? 'from ' + esc(ago(data.fetchedAt)) : 'unavailable'} ·
      cached for 60 seconds · <a class="link" href="/?refresh=1">refresh now</a></div>
  </div>`);
}


/* ------------------------------------------------------ subscriptions --- */

function readBody(req, limit = 20000) {
  return new Promise((resolve, reject) => {
    let body = '';
    req.on('data', c => { body += c; if (body.length > limit) { req.destroy(); reject(new Error('Body too large')); } });
    req.on('end', () => resolve(body));
    req.on('error', reject);
  });
}
const json = (res, code, obj) => {
  res.writeHead(code, { 'Content-Type': 'application/json' });
  res.end(JSON.stringify(obj));
};

async function subsData() {
  const [apps, subs, redemptions, users] = await Promise.all([
    store.listApps(), store.listSubscriptions(), store.listRedemptions(), store.listUsers()
  ]);
  return { apps, subs, redemptions, users, minted: null, dbError: null };
}

function subsPage({ apps, subs, redemptions, users = [], minted, dbError, notice }) {
  const pro = subs.filter(s => s.state === 'Pro').length;
  return page('Subscriptions — My Apps', `
  <div class="top"><b>My Apps</b><span class="sub" style="color:#9db8d6">subscriptions</span>
    <span class="sp"></span><a href="/">status</a> <a href="/logout">sign out</a></div>
  <div class="wrap">
    ${dbError ? `<div class="al bad"><b>Database unavailable</b>${esc(dbError)}</div>` : ''}
    ${notice ? `<div class="al info">${esc(notice)}</div>` : ''}

    <div class="stats">
      <div class="stat"><div class="v">${apps.length}</div><div class="l">Apps</div></div>
      <div class="stat"><div class="v">${pro}</div><div class="l">On Pro now</div></div>
      <div class="stat"><div class="v">${redemptions.length}</div><div class="l">Codes redeemed</div></div>
      <div class="stat"><div class="v">${users.length}</div><div class="l">Accounts</div></div>
    </div>

    ${minted ? `<div class="card"><h2>${minted.codes.length} code${minted.codes.length === 1 ? '' : 's'}
      for ${esc(minted.app.name)} <span class="sub">${minted.days} days each</span></h2>
      <p class="sub">Copy these now — they are signed, not stored, so this page cannot show them again.
        They work until redeemed or revoked.</p>
      <textarea readonly style="width:100%;height:${Math.min(220, 28 + minted.codes.length * 20)}px;
        font:13px/1.6 monospace;padding:10px;border:1px solid var(--line);border-radius:9px"
      >${esc(minted.codes.join('\n'))}</textarea></div>` : ''}

    <div class="card">
      <h2>Issue codes <span class="sub">signed, not stored — mint as many as you like</span></h2>
      <form method="POST" action="/codes/issue">
        <div class="grid">
          <div><label class="sub">App</label>
            <select name="app_id" style="width:100%;padding:10px;border:1px solid var(--line);border-radius:9px">
              ${apps.map(a => `<option value="${a.id}">${esc(a.name)} (${esc(a.prefix)})</option>`).join('')}
            </select></div>
          <div><label class="sub">Days of Pro</label><input name="days" type="number" min="1" max="3650" value="30"></div>
          <div><label class="sub">How many codes</label><input name="count" type="number" min="1" max="100" value="1"></div>
        </div>
        <button style="margin-top:12px">Generate</button>
      </form>
    </div>

    <div class="card">
      <h2>Who is on what</h2>
      ${subs.length ? `<table><tr><th>Account</th><th>App</th><th>Plan</th><th>Until</th><th>Via</th></tr>
        ${subs.map(x => `<tr><td>${esc(x.account)}</td><td>${esc(x.app_name)}</td>
          <td><span class="pill ${x.state === 'Pro' ? 'ok' : (x.state === 'Expired' ? 'warn' : '')}">${x.state}</span></td>
          <td>${x.expires_on ? esc(String(x.expires_on).slice(0, 10)) : (x.plan === 'pro' ? 'no expiry' : '—')}</td>
          <td>${esc(x.source || '—')}</td></tr>`).join('')}</table>`
        : '<div class="sub">Nobody has redeemed a code yet.</div>'}
    </div>

    <div class="card">
      <h2>Redeemed codes <span class="sub">revoke one to cut off access</span></h2>
      ${redemptions.length ? `<table><tr><th>Code</th><th>App</th><th>Account</th><th>Expires</th><th></th></tr>
        ${redemptions.map(r => `<tr>
          <td><code style="font-size:12px">${esc(r.code)}</code></td>
          <td>${esc(r.app_name || '—')}</td><td>${esc(r.account || '—')}</td>
          <td>${r.expires_on ? esc(String(r.expires_on).slice(0, 10)) : '—'}</td>
          <td class="num"><form method="POST" action="/codes/revoke" style="display:inline">
            <input type="hidden" name="code" value="${esc(r.code)}">
            <button style="background:none;color:#2b5b8c;padding:0;font-size:12.5px">revoke</button></form></td>
        </tr>`).join('')}</table>`
        : '<div class="sub">None yet.</div>'}
    </div>

    <div class="card">
      <h2>Accounts <span class="sub">one sign-in, every app</span></h2>
      ${users.length ? `<table><tr><th>Email</th><th>Name</th><th>On</th><th>Joined</th><th>Last seen</th><th></th></tr>
        ${users.map(u => `<tr>
          <td>${esc(u.email)}${u.active ? '' : ' <span class="pill warn">off</span>'}</td>
          <td>${esc(u.name || '—')}</td>
          <td>${(u.plans || []).filter(p => p.plan === 'pro').map(p => `<span class="pill ok">${esc(p.app)}</span>`).join(' ') || '<span class="sub">free</span>'}</td>
          <td>${esc(String(u.created_at).slice(0, 10))}</td>
          <td>${u.last_seen ? esc(String(u.last_seen).slice(0, 10)) : '<span class="sub">never</span>'}</td>
          <td class="num"><form method="POST" action="/users/toggle" style="display:inline">
            <input type="hidden" name="email" value="${esc(u.email)}">
            <button style="background:none;color:#2b5b8c;padding:0;font-size:12.5px">${u.active ? 'suspend' : 'restore'}</button></form></td>
        </tr>`).join('')}</table>`
        : '<div class="sub">No one has signed up yet. Accounts appear here the moment someone registers in any of your apps.</div>'}
      <form method="POST" action="/users/reset" style="margin-top:12px">
        <div class="grid">
          <div><label class="sub">Reset password for</label><input name="email" type="email" placeholder="someone@example.com"></div>
          <div><label class="sub">New password</label><input name="password" type="text" placeholder="at least 8 characters"></div>
        </div>
        <button style="margin-top:10px">Set password</button>
      </form>
    </div>

    <div class="card">
      <h2>App keys <span class="sub">each app needs these to check codes</span></h2>
      <table><tr><th>App</th><th>Slug</th><th>Prefix</th><th>Secret</th></tr>
        ${apps.map(a => `<tr><td>${esc(a.name)}</td><td><code>${esc(a.slug)}</code></td>
          <td><code>${esc(a.prefix)}</code></td>
          <td><code style="font-size:11px;word-break:break-all">${esc(a.secret)}</code></td></tr>`).join('')}
      </table>
      <div class="sub" style="margin-top:8px">An app posts its slug, secret, the code and the account to
        <code>/api/v1/redeem</code>, and asks <code>/api/v1/status</code> what someone is entitled to.
        Secrets belong in each app's environment variables, never in its source.</div>
    </div>
  </div>`);
}

/* -------------------------------------------------------------- server --- */

const send = (res, code, body, headers = {}) => {
  res.writeHead(code, Object.assign({ 'Content-Type': 'text/html; charset=utf-8' }, headers));
  res.end(body);
};

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, 'http://x');

  if (url.pathname === '/healthz') return send(res, 200, 'ok', { 'Content-Type': 'text/plain' });

  // Public API: an app asks whether a code is good, and claims a use if it is.
  if (url.pathname === '/api/v1/status' && req.method === 'POST') {
    try {
      const out = await store.status(JSON.parse(await readBody(req) || '{}'));
      return json(res, out.ok ? 200 : out.status, out.ok ? out : { error: out.error });
    } catch (e) { return json(res, 400, { error: e.message }); }
  }

  if (url.pathname === '/api/v1/redeem' && req.method === 'POST') {
    try {
      const b = JSON.parse(await readBody(req) || '{}');
      const out = await store.redeem(b);
      return json(res, out.ok ? 200 : out.status, out.ok ? out : { error: out.error });
    } catch (e) {
      return json(res, 400, { error: e.message });
    }
  }

  /* Central accounts. Every app posts here instead of holding passwords itself,
     so one sign-in works everywhere and suspending someone cuts off all of it. */
  const AUTH = {
    '/api/v1/auth/register': store.register,
    '/api/v1/auth/login': store.login,
    '/api/v1/auth/change-password': store.changePassword,
    '/api/v1/auth/admin-set-password': store.adminSetPassword
  };
  if (AUTH[url.pathname]) {
    if (req.method !== 'POST') return json(res, 405, { error: 'POST only' });
    try {
      const out = await AUTH[url.pathname](JSON.parse(await readBody(req) || '{}'));
      // On refusal the app still gets `known`/`suspended` — see the note in
      // store.login(). Apps must not relay them to a browser.
      return json(res, out.ok ? 200 : (out.status || 400), out.ok ? out
        : { error: out.error, known: out.known, suspended: out.suspended });
    } catch (e) {
      console.error(url.pathname + ' failed:', e.message);
      return json(res, 400, { error: e.message });
    }
  }

  if (url.pathname === '/login' && req.method === 'POST') {
    let body = '';
    req.on('data', c => { body += c; if (body.length > 4000) req.destroy(); });
    req.on('end', () => {
      const given = decodeURIComponent((body.split('password=')[1] || '').replace(/\+/g, ' ')).split('&')[0];
      if (!PASSWORD) return send(res, 200, loginPage('APP_PASSWORD is not set on this service.'));
      if (!passwordOk(given)) return send(res, 200, loginPage('Wrong password.'));
      send(res, 302, '', {
        Location: '/',
        'Set-Cookie': `ma=${sign(String(Date.now()))}; HttpOnly; Path=/; Max-Age=2592000; SameSite=Lax` +
          (process.env.NODE_ENV === 'production' ? '; Secure' : '')
      });
    });
    return;
  }

  if (url.pathname === '/logout') {
    return send(res, 302, '', { Location: '/', 'Set-Cookie': 'ma=; Path=/; Max-Age=0' });
  }

  /* Anything else under /api/ is not a route. Say so in JSON: an app that gets
     an HTML sign-in page back with a 200 could mistake it for a yes. */
  if (url.pathname.startsWith('/api/')) return json(res, 404, { error: 'No such endpoint: ' + url.pathname });

  if (!validToken(cookieOf(req, 'ma'))) return send(res, 200, loginPage(''));

  // --- subscriptions ---
  if (url.pathname === '/codes/issue' && req.method === 'POST') {
    const body = new URLSearchParams(await readBody(req));
    try {
      const minted = await store.issue(body.get('app_id'), body.get('days'), body.get('count'));
      return send(res, 200, subsPage(Object.assign(await subsData(),
        { minted: { app: minted.app, codes: minted.codes, days: Number(body.get('days')) || 30 } })));
    } catch (e) {
      return send(res, 200, subsPage(Object.assign(await subsData(), { dbError: e.message })));
    }
  }
  if (url.pathname === '/codes/revoke' && req.method === 'POST') {
    const body = new URLSearchParams(await readBody(req));
    try { await store.revokeCode(body.get('code'), 'revoked from My Apps'); }
    catch (e) { console.error('revoke failed:', e.message); }
    return send(res, 302, '', { Location: '/subscriptions' });
  }
  if (url.pathname === '/users/reset' && req.method === 'POST') {
    const body = new URLSearchParams(await readBody(req));
    const email = body.get('email');
    let notice;
    try {
      notice = await store.setUserPassword(email, body.get('password'))
        ? `Password set for ${email}. Tell them to sign in with it and change it.`
        : `No account here uses ${email}.`;
    } catch (e) { notice = e.message; }
    try { return send(res, 200, subsPage(Object.assign(await subsData(), { notice }))); }
    catch (e) { return send(res, 302, '', { Location: '/subscriptions' }); }
  }
  if (url.pathname === '/users/toggle' && req.method === 'POST') {
    const body = new URLSearchParams(await readBody(req));
    let notice;
    try {
      const u = await store.toggleUser(body.get('email'));
      notice = u ? `${u.email} is now ${u.active ? 'active again' : 'suspended from every app'}.`
        : `No account here uses ${body.get('email')}.`;
    } catch (e) { notice = e.message; }
    try { return send(res, 200, subsPage(Object.assign(await subsData(), { notice }))); }
    catch (e) { return send(res, 302, '', { Location: '/subscriptions' }); }
  }
  if (url.pathname === '/subscriptions') {
    try { return send(res, 200, subsPage(await subsData())); }
    catch (e) { return send(res, 200, subsPage({ apps: [], subs: [], redemptions: [], users: [], dbError: e.message })); }
  }

  if (url.searchParams.get('refresh')) cache.at = 0;

  try {
    const data = await collect();
    send(res, 200, dashboard(data, null));
  } catch (e) {
    console.error('collect failed:', e.message);
    send(res, 200, dashboard(cache.data, e.message));
  }
});

store.init().catch(e => console.error('store init failed:', e.message));

server.listen(PORT, () => {
  console.log(`My Apps listening on ${PORT} (build ${BUILD})`);
  if (!PASSWORD) console.log('WARNING: APP_PASSWORD is not set — nobody can sign in.');
  if (!RENDER_KEY) console.log('WARNING: RENDER_API_KEY is not set — no data to show.');
});
