/* Deal Finder — the same pages, now behind one sign-in.
 *
 * This was a static site. A static site has no server, so it cannot hold a
 * secret, cannot check a password, and cannot know who is looking at it. This
 * file is the smallest thing that fixes that: it serves exactly the same files
 * as before, and puts the app pages behind the same account used by ServeTrack
 * and the After School Scheduler.
 *
 * Dependency-free on purpose — Node's own http module and nothing to install,
 * so a deploy has nothing to break.
 */

const http = require('http');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const PORT = process.env.PORT || 3000;
const BUILD = '2026-09-02.5';
const SECRET = process.env.SESSION_SECRET || crypto.randomBytes(32).toString('hex');
const ROOT = __dirname;

/* ------------------------------------------------ central accounts --- */
/* The same module every one of these apps carries. Kept inline so this stays a
   single added file. */
const URL_BASE = (process.env.MY_APPS_URL || '').replace(/\/+$/, '');
const SLUG = process.env.MY_APPS_SLUG || '';
const APP_SECRET = process.env.MY_APPS_SECRET || '';
const centralOn = () => Boolean(URL_BASE && SLUG && APP_SECRET);

async function central(path, body, { timeout = 12000, retry = true } = {}) {
  if (!centralOn()) return { ok: false, unavailable: true, status: 503, error: 'Central accounts are not configured' };
  try {
    const res = await fetch(URL_BASE + path, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(Object.assign({ slug: SLUG, secret: APP_SECRET }, body)),
      signal: AbortSignal.timeout(timeout)
    });
    /* Insist on a JSON answer. An older build of My Apps with no such route may
       answer 200 with an HTML page, and taking that for "signed in" would be
       the worst possible bug. */
    const isJson = (res.headers.get('content-type') || '').includes('application/json');
    const data = isJson ? await res.json().catch(() => null) : null;
    if (!data || typeof data !== 'object') {
      return { ok: false, unavailable: true, status: res.status,
               error: 'Accounts service gave an answer this app did not understand' };
    }
    if (res.ok) return Object.assign({ ok: true }, data);
    if (res.status >= 500) {
      if (retry) return central(path, body, { timeout: 25000, retry: false });
      return { ok: false, unavailable: true, status: res.status, error: 'Accounts service is unavailable' };
    }
    return Object.assign({ ok: false, status: res.status, error: data.error || 'Rejected' }, data);
  } catch (e) {
    if (retry) return central(path, body, { timeout: 40000, retry: false });
    return { ok: false, unavailable: true, status: 503, error: 'Accounts service is unreachable' };
  }
}

/* My Apps sleeps on the free plan. Waking it while somebody is still typing
   their email means the sign-in itself is quick. */
let lastWarm = 0;
function warm() {
  if (!centralOn() || Date.now() - lastWarm < 60000) return;
  lastWarm = Date.now();
  fetch(URL_BASE + '/healthz', { signal: AbortSignal.timeout(45000) }).catch(() => {});
}

/* ------------------------------------------------------------ plans --- */
/* Thirty days, then it needs paying for.
 *
 * There is no database here on purpose — the privacy statement promises that
 * searches never reach this server, and adding one to hold a plan would be a
 * poor trade. So the plan lives in My Apps, keyed by the account, and this
 * process keeps a short-lived copy in memory to avoid asking on every click.
 *
 * The rule when My Apps cannot be reached is: let them in. A person who has
 * paid must never be shut out of the app because an accounts service is
 * asleep, and the cost of occasionally carrying somebody whose trial lapsed
 * during an outage is nothing next to that.                                 */

const PLAN_TTL_MS = Number(process.env.PLAN_TTL_MS || 10 * 60 * 1000);
const planCache = new Map();            // email -> { at, plan }
const trialAsked = new Set();           // accounts whose trial has been settled
const tenantOf = email => 'account:' + String(email || '').toLowerCase();

const OPEN = { plan: 'pro', trial: false, days_left: null, expires_on: null,
               source: '', unknown: true };

async function planFor(email, { force = false } = {}) {
  const hit = planCache.get(email);
  if (!force && hit && Date.now() - hit.at < PLAN_TTL_MS) return hit.plan;

  /* Until an account's trial has actually been settled, keep asking for it
     rather than merely asking what the plan is. A failed call must not be
     mistaken for "this one has had its trial" — that would leave somebody who
     signed up during an outage staring at an upgrade page having never had
     their thirty days. My Apps only ever starts one, so asking twice is free. */
  const settle = !trialAsked.has(email);
  const c = await central(settle ? '/api/v1/trial' : '/api/v1/plan', { tenant: tenantOf(email) });
  if (!c.ok) {
    // Keep whatever was last known; if nothing was, let them in.
    const fallback = hit ? hit.plan : OPEN;
    planCache.set(email, { at: Date.now() - (PLAN_TTL_MS - 60000), plan: fallback });
    return fallback;
  }
  if (settle) trialAsked.add(email);
  if (c.started) console.log(`Trial started for ${email} — ${c.days_left} days`);
  const plan = {
    plan: c.plan === 'pro' ? 'pro' : 'free',
    trial: !!c.trial, trial_over: !!c.trial_over,
    days_left: c.days_left ?? null, expires_on: c.expires_on || null,
    source: c.source || ''
  };
  planCache.set(email, { at: Date.now(), plan });
  return plan;
}

/* -------------------------------------------------------- sessions --- */
/* email|issued|signature. Nothing else is stored: there is no database here,
   and there does not need to be — My Apps is the record. */

function signSession(email) {
  const v = Buffer.from(email).toString('base64url') + '.' + Date.now();
  return v + '.' + crypto.createHmac('sha256', SECRET).update(v).digest('hex').slice(0, 32);
}

function readSession(tok) {
  if (!tok) return null;
  const i = tok.lastIndexOf('.');
  if (i < 0) return null;
  const v = tok.slice(0, i);
  const expected = crypto.createHmac('sha256', SECRET).update(v).digest('hex').slice(0, 32);
  const a = Buffer.from(tok.slice(i + 1)), b = Buffer.from(expected);
  if (a.length !== b.length || !crypto.timingSafeEqual(a, b)) return null;
  const [emailB64, issued] = v.split('.');
  if (!(Number(issued) > Date.now() - 30 * 864e5)) return null;
  try { return Buffer.from(emailB64, 'base64url').toString('utf8'); } catch (e) { return null; }
}

const cookieOf = (req, name) => {
  for (const part of (req.headers.cookie || '').split(';')) {
    const [k, ...rest] = part.trim().split('=');
    if (k === name) return rest.join('=');
  }
  return '';
};

const cookieHeader = value =>
  `de=${value}; HttpOnly; Path=/; Max-Age=2592000; SameSite=Lax` +
  (process.env.NODE_ENV === 'production' ? '; Secure' : '');

/* ----------------------------------------------------------- files --- */

const TYPES = {
  '.html': 'text/html; charset=utf-8', '.js': 'application/javascript; charset=utf-8',
  '.json': 'application/json; charset=utf-8', '.png': 'image/png', '.svg': 'image/svg+xml',
  '.ico': 'image/x-icon', '.css': 'text/css; charset=utf-8', '.webmanifest': 'application/manifest+json'
};

// Everything the browser needs before anyone has signed in, plus the icons and
// the service worker. The service worker must be reachable at the site root or
// it cannot control the pages below it.
const PUBLIC = new Set([
  '/manifest.json', '/sw.js', '/config.js',
  '/icon-192.png', '/icon-512.png', '/icon-maskable-512.png', '/apple-touch-icon.png',
  '/favicon.ico'
]);

// The app itself. These are what sign-in protects.
const PAGES = { '/': 'index.html', '/index.html': 'index.html', '/finder': 'index.html',
                '/calc.html': 'calc.html', '/calculator': 'calc.html',
                '/search.html': 'search.html', '/search': 'search.html' };

function sendFile(res, rel, extraHeaders = {}) {
  const file = path.join(ROOT, rel);
  if (!file.startsWith(ROOT)) return send(res, 403, 'Forbidden', { 'Content-Type': 'text/plain' });
  fs.readFile(file, (err, buf) => {
    if (err) return send(res, 404, 'Not found', { 'Content-Type': 'text/plain' });
    send(res, 200, buf, Object.assign({
      'Content-Type': TYPES[path.extname(file)] || 'application/octet-stream',
      'X-Content-Type-Options': 'nosniff'
    }, extraHeaders));
  });
}

const send = (res, code, body, headers = {}) => {
  res.writeHead(code, Object.assign({ 'Content-Type': 'text/html; charset=utf-8' }, headers));
  res.end(body);
};
const json = (res, code, obj, headers = {}) =>
  send(res, code, JSON.stringify(obj), Object.assign({ 'Content-Type': 'application/json' }, headers));

function readBody(req, limit = 20000) {
  return new Promise((resolve, reject) => {
    let body = '';
    req.on('data', c => { body += c; if (body.length > limit) { req.destroy(); reject(new Error('Too large')); } });
    req.on('end', () => resolve(body));
    req.on('error', reject);
  });
}

/* ------------------------------------------------------ sign-in page --- */

const esc = s => String(s == null ? '' : s).replace(/[&<>"']/g, c =>
  ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

const signInPage = (msg, mode = 'in', values = {}) => `<!doctype html>
<html lang="en"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1,viewport-fit=cover">
<title>Deal Finder — sign in</title>
<link rel="apple-touch-icon" href="/apple-touch-icon.png">
<style>
  :root{--ink:#101822;--sub:#5A6A80;--line:#DBE4F2;--brand:#0B4FD3;--accent:#F2660D;--bad:#B42318}
  *{box-sizing:border-box}
  body{margin:0;min-height:100vh;display:flex;align-items:center;justify-content:center;
    padding:24px;background:#EDF2FB;color:var(--ink);
    font:15px/1.5 -apple-system,BlinkMacSystemFont,"Segoe UI",Roboto,Arial,sans-serif}
  .box{width:100%;max-width:380px;background:#fff;border:1px solid var(--line);
    border-radius:16px;padding:26px 22px;box-shadow:0 8px 30px rgba(11,40,90,.09)}
  h1{margin:0 0 4px;font-size:24px;letter-spacing:-.03em;color:var(--brand)}
  .sub{color:var(--sub);font-size:13.5px;margin-bottom:18px}
  label{display:block;font-size:12.5px;color:var(--sub);margin:12px 0 5px}
  input{width:100%;padding:12px;font-size:16px;border:1px solid var(--line);
    border-radius:10px;background:#fbfcfe;color:var(--ink)}
  input:focus{outline:2px solid var(--brand);outline-offset:-1px;background:#fff}
  button{width:100%;margin-top:18px;padding:13px;font-size:15.5px;font-weight:700;
    border:0;border-radius:999px;background:var(--accent);color:#fff}
  button:active{background:#D9550A}
  .msg{margin-top:14px;padding:10px 12px;border-radius:9px;font-size:13.5px;
    background:#fde8e6;border:1px solid #f5c6c2;color:var(--bad)}
  .alt{margin-top:18px;padding-top:16px;border-top:1px solid var(--line);
    font-size:13.5px;color:var(--sub);text-align:center}
  a{color:var(--brand);text-decoration:none}
  .foot{margin-top:16px;font-size:12px;color:var(--sub);text-align:center}
</style></head>
<body><form class="box" method="POST" action="${mode === 'up' ? '/signup' : '/signin'}">
  <h1>Deal Finder</h1>
  <div class="sub">${mode === 'up' ? 'Free for 30 days — no card. One account works in every one of your apps.'
    : 'Sign in with your account — the same one your other apps use.'}</div>
  ${mode === 'up' ? `<label for="name">Your name</label>
  <input id="name" name="name" autocomplete="name" value="${esc(values.name)}">` : ''}
  <label for="email">Email</label>
  <input id="email" name="email" type="email" autocomplete="email" required value="${esc(values.email)}">
  <label for="password">Password</label>
  <input id="password" name="password" type="password" required
    autocomplete="${mode === 'up' ? 'new-password' : 'current-password'}">
  ${mode === 'up' ? `<label for="code">Access code <span style="opacity:.7">— optional</span></label>
  <input id="code" name="code" autocapitalize="characters" placeholder="DEA-30D-XXXX-XXXXXX" value="${esc(values.code)}">` : ''}
  <button>${mode === 'up' ? 'Create my account' : 'Sign in'}</button>
  ${msg ? `<div class="msg">${esc(msg)}</div>` : ''}
  ${mode === 'up' ? '' : '<div class="alt" style="border:0;padding-top:12px;margin-top:12px"><a href="/forgot">Forgot your password?</a></div>'}
  <div class="alt">${mode === 'up'
    ? 'Already have an account? <a href="/signin">Sign in</a>'
    : 'No account yet? <a href="/signup">Create one</a>'}</div>
  <div class="foot">build ${BUILD} · <a href="/privacy" target="_blank">privacy</a></div>
</form></body></html>`;

/* ------------------------------------------------------------ upgrade --- */
/* What somebody sees the day after their trial runs out. Deliberately not a
   dead end: their account still works, the page says exactly what happened,
   and a code entered here puts them straight back in. */
const upgradePage = (email, msg) => `<!doctype html>
<html lang="en"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1,viewport-fit=cover">
<title>Deal Finder — your trial has ended</title>
<link rel="apple-touch-icon" href="/apple-touch-icon.png">
<style>
  :root{--ink:#101822;--sub:#5A6A80;--line:#DBE4F2;--brand:#0B4FD3;--accent:#F2660D;--bad:#B42318}
  *{box-sizing:border-box}
  body{margin:0;min-height:100vh;display:flex;align-items:center;justify-content:center;
    padding:24px;background:#EDF2FB;color:var(--ink);
    font:15px/1.55 -apple-system,BlinkMacSystemFont,"Segoe UI",Roboto,Arial,sans-serif}
  .box{width:100%;max-width:420px;background:#fff;border:1px solid var(--line);
    border-radius:16px;padding:26px 22px;box-shadow:0 8px 30px rgba(11,40,90,.09)}
  h1{margin:0 0 6px;font-size:23px;letter-spacing:-.02em;color:var(--brand)}
  p{color:var(--sub);font-size:14px}
  label{display:block;font-size:12.5px;color:var(--sub);margin:16px 0 5px}
  input{width:100%;padding:12px;font-size:16px;border:1px solid var(--line);
    border-radius:10px;background:#fbfcfe;color:var(--ink);text-transform:uppercase}
  button{width:100%;margin-top:14px;padding:13px;font-size:15.5px;font-weight:700;
    border:0;border-radius:999px;background:var(--accent);color:#fff}
  .msg{margin-top:12px;padding:10px 12px;border-radius:9px;font-size:13.5px;
    background:#fde8e6;border:1px solid #f5c6c2;color:var(--bad)}
  .foot{margin-top:18px;padding-top:14px;border-top:1px solid var(--line);
    font-size:12.5px;color:var(--sub);text-align:center}
  a{color:var(--brand);text-decoration:none}
</style></head><body>
<form class="box" method="POST" action="/upgrade">
  <h1>Your free trial has ended</h1>
  <p>Thirty days are up. Nothing has been deleted — your account and your county
     setup are exactly as you left them, and a code below puts you straight back in.</p>
  <label for="code">Upgrade code</label>
  <input id="code" name="code" autocapitalize="characters" placeholder="DEA-30D-XXXX-XXXXXX" autofocus>
  <button>Unlock Deal Finder</button>
  ${msg ? `<div class="msg">${esc(msg)}</div>` : ''}
  <div class="foot">Signed in as ${esc(email)} ·
    <a href="/signout">sign out</a><br>
    Need a code? <a href="mailto:steve.smith@buddyrents.com">steve.smith@buddyrents.com</a></div>
</form></body></html>`;

/* ------------------------------------------------------------ privacy --- */
const PRIVACY_PAGE = `<!doctype html><html><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>Deal Finder — Privacy</title>
<style>body{font:16px/1.65 -apple-system,"Segoe UI",Roboto,Arial,sans-serif;color:#101822;
background:#EDF2FB;margin:0;padding:28px 18px}main{max-width:660px;margin:0 auto;
background:#fff;border:1px solid #DBE4F2;border-radius:14px;padding:24px 22px}
h1{font-size:26px;margin:0 0 4px;color:#0B4FD3}
h2{font-size:18px;margin:26px 0 6px;color:#101822}
p,li{margin:8px 0}a{color:#0A3FA8}.d{color:#5A6A80;font-size:14px}</style></head><body><main>
<h1>Deal Finder Privacy Statement</h1>
<p class="d">Last updated 31 August 2026</p>

<h2>Your searches stay on your device</h2>
<p>Deal Finder's searching, ranking and deal math run in your browser. The
properties you look at, the filters you set and the numbers you type are not
sent to or stored on our servers. Property data itself comes from public county
appraisal records, fetched by your browser directly from the county.</p>

<h2>What we store</h2>
<p>One thing: your account — name, email, a scrambled (hashed) form of your
password that cannot be read back, and whether you are on the free or paid
plan. The same account signs you into our other apps, so it is kept once, in
one place, not copied around.</p>

<h2>Street View photos</h2>
<p>When a property photo is shown, your browser asks Google's Street View
service for the image of that address. That request goes to Google and is
covered by Google's own privacy policy. If no photo loads, nothing was sent.</p>

<h2>What the platform owner can see</h2>
<p>Because your searches never reach our servers, there is nothing of your
deal-hunting for anyone to look at — the operator can see that your account
exists and its plan, nothing more.</p>

<h2>Cookies and tracking</h2>
<p>One cookie, used to keep you signed in. No advertising, no trackers, no
analytics, and your data is never sold or shared for marketing.</p>

<h2>Your choices</h2>
<p>You can change your password at any time (it changes across all connected
apps at once). To ask about your account or request deletion, contact
<a href="mailto:steve.smith@buddyrents.com">steve.smith@buddyrents.com</a>.</p>

<p class="d">If this statement changes, the date above changes with it.</p>
</main></body></html>`;

/* ---------------------------------------------------------- server --- */

/* The pages themselves know nothing about accounts — they were written for a
   site that had none. Rather than edit three large HTML files, the one thing
   they now need is added on the way out: who you are, and a way to sign out. */
function sendPage(res, rel, email, plan) {
  fs.readFile(path.join(ROOT, rel), 'utf8', (err, html) => {
    if (err) return send(res, 404, 'Not found', { 'Content-Type': 'text/plain' });
    /* The countdown only appears in the last week. Told every day from day one
       it is nagging; told in the last few days it is useful. */
    const d = plan && plan.trial ? plan.days_left : null;
    const trial = d !== null && d <= 7
      ? ` · <span style="color:#B45309;font-weight:600">${
          d === 0 ? 'trial ends today' : d === 1 ? '1 day left' : d + ' days left'}</span>`
      : '';
    const badge = `<div id="de-account" style="position:fixed;left:8px;bottom:8px;z-index:2147483000;
      font:11.5px/1.4 -apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,Arial,sans-serif;
      background:rgba(255,255,255,.92);border:1px solid #DBE4F2;border-radius:999px;
      padding:5px 11px;color:#5A6A80;box-shadow:0 2px 8px rgba(11,40,90,.14)">
      ${esc(email)}${trial} · <a href="/signout" style="color:#0A3FA8;text-decoration:none">sign out</a></div>`;
    const out = html.includes('</body>') ? html.replace('</body>', badge + '\n</body>') : html + badge;
    send(res, 200, out, {
      'Content-Type': 'text/html; charset=utf-8',
      'X-Content-Type-Options': 'nosniff',
      'Cache-Control': 'no-store'      // never let a shared cache hold a signed-in page
    });
  });
}

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, 'http://x');
  const p = url.pathname;

  if (p === '/healthz') return send(res, 200, 'ok', { 'Content-Type': 'text/plain' });

  if (p === '/privacy') return send(res, 200, PRIVACY_PAGE);

  // The sign-in and sign-up pages are the moment to wake My Apps.
  if ((p === '/signin' || p === '/signup') && req.method === 'GET') {
    warm();
    if (!centralOn()) {
      return send(res, 200, signInPage('This site is not connected to My Apps yet — set MY_APPS_URL, MY_APPS_SLUG and MY_APPS_SECRET.'));
    }
    return send(res, 200, signInPage('', p === '/signup' ? 'up' : 'in', {}));
  }

  if (p === '/signin' && req.method === 'POST') {
    const f = new URLSearchParams(await readBody(req));
    const email = (f.get('email') || '').trim().toLowerCase();
    const c = await central('/api/v1/auth/login', { email, password: f.get('password') || '' });
    if (c.ok && !c.user) {
      return send(res, 200, signInPage("Couldn't reach the accounts service — try again in a moment.", 'in', { email }));
    }
    if (!c.ok) {
      const why = c.unavailable
        ? "Couldn't reach the accounts service — try again in a moment."
        : (c.suspended ? 'That account has been suspended.' : 'Wrong email or password.');
      return send(res, 200, signInPage(why, 'in', { email }));
    }
    /* Signing in is the moment to look at the plan afresh. Somebody who has
       just paid signs out and back in to see it, and being told to wait ten
       minutes for a cache would be a poor answer. */
    planCache.delete(email);
    return send(res, 302, '', { Location: '/', 'Set-Cookie': cookieHeader(signSession(email)) });
  }

  if (p === '/signup' && req.method === 'POST') {
    const f = new URLSearchParams(await readBody(req));
    const email = (f.get('email') || '').trim().toLowerCase();
    const name = (f.get('name') || '').trim();
    const code = (f.get('code') || '').trim();
    const c = await central('/api/v1/auth/register',
      { email, password: f.get('password') || '', name, code: code || undefined });
    if (!c.ok) {
      const why = c.unavailable ? "Couldn't reach the accounts service — try again in a moment." : c.error;
      return send(res, 200, signInPage(why, 'up', { email, name, code }));
    }
    if (c.codeError) {
      // The account was made; only the code was no good. Say so, and let them in.
      return send(res, 302, '', { Location: '/?code_error=' + encodeURIComponent(c.codeError),
        'Set-Cookie': cookieHeader(signSession(email)) });
    }
    return send(res, 302, '', { Location: '/', 'Set-Cookie': cookieHeader(signSession(email)) });
  }

  if (p === '/signout') {
    return send(res, 302, '', { Location: '/signin', 'Set-Cookie': 'de=; Path=/; Max-Age=0' });
  }

  /* Forgotten passwords live in My Apps, because that is where passwords are.
     Every app carries this same plain link. */
  if (p === '/forgot') {
    if (!URL_BASE) {
      return send(res, 200, signInPage(
        'Password resets are not set up yet — contact steve.smith@buddyrents.com.'));
    }
    return send(res, 302, '', { Location: URL_BASE + '/forgot?app=' + encodeURIComponent('Deal Finder') });
  }

  /* Redeeming an upgrade code. My Apps verifies it — this app never holds the
     signing secret, so a copy of this file is no help in making one. */
  if (p === '/upgrade' && req.method === 'POST') {
    const who = readSession(cookieOf(req, 'de'));
    if (!who) return send(res, 302, '', { Location: '/signin' });
    const f = new URLSearchParams(await readBody(req));
    const code = (f.get('code') || '').trim().toUpperCase();
    if (!code) return send(res, 200, upgradePage(who, 'Enter the code you were given.'));

    const c = await central('/api/v1/redeem-tenant', { tenant: tenantOf(who), tenantName: who, code });
    if (!c.ok) {
      return send(res, 200, upgradePage(who, c.unavailable
        ? "Couldn't reach the accounts service — try again in a moment."
        : (c.error || 'That code is not valid.')));
    }
    planCache.delete(who);
    await planFor(who, { force: true });
    console.log(`${who} upgraded with a code until ${c.expires_on}`);
    return send(res, 302, '', { Location: '/' });
  }

  // Assets everyone may have, signed in or not.
  if (PUBLIC.has(p)) return sendFile(res, p.slice(1));

  const email = readSession(cookieOf(req, 'de'));

  /* Who am I, and what am I entitled to. The pages can call this to decide
     whether to show paid features. */
  if (p === '/api/me') {
    if (!email) return json(res, 401, { error: 'Not signed in' });
    const plan = await planFor(email);
    return json(res, 200, {
      email,
      plan: plan.plan,
      trial: plan.trial,
      days_left: plan.days_left,
      expires_on: plan.expires_on,
      accounts_reachable: !plan.unknown
    });
  }

  const page = PAGES[p];
  if (page) {
    if (!email) return send(res, 302, '', { Location: '/signin' });
    const plan = await planFor(email);
    // A lapsed trial gets the upgrade page instead of the app. Anything the
    // plan lookup could not establish counts as allowed — see planFor.
    if (plan.plan !== 'pro') return send(res, 200, upgradePage(email, ''));
    return sendPage(res, page, email, plan);
  }

  // Anything else that exists in the repo, for signed-in people only.
  if (/^\/[A-Za-z0-9._-]+$/.test(p)) {
    if (!email) return send(res, 302, '', { Location: '/signin' });
    return sendFile(res, p.slice(1));
  }

  send(res, 404, 'Not found', { 'Content-Type': 'text/plain' });
});

server.listen(PORT, () => {
  console.log(`Deal Finder listening on ${PORT} (build ${BUILD})`);
  if (!centralOn()) console.log('WARNING: MY_APPS_URL / MY_APPS_SLUG / MY_APPS_SECRET are not all set — nobody can sign in.');
  if (!process.env.SESSION_SECRET) console.log('WARNING: SESSION_SECRET is not set — everyone is signed out on each deploy.');
});
