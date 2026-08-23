// Google sign-in (OAuth 2.0 for installed apps: system browser + loopback redirect + PKCE)
// and a thin Calendar API client. Tokens live in userData/google-tokens.json.
const { app, shell } = require('electron');
const http = require('node:http');
const crypto = require('node:crypto');
const path = require('node:path');
const fs = require('node:fs');

const SCOPES = [
  'openid',
  'email',
  'profile',
  'https://www.googleapis.com/auth/calendar.readonly',
].join(' ');

const file = (name) => path.join(app.getPath('userData'), name);
const readJSON = (name) => { try { return JSON.parse(fs.readFileSync(file(name), 'utf8')); } catch { return null; } };
const writeJSON = (name, v) => fs.writeFileSync(file(name), JSON.stringify(v, null, 2));

/** Client credentials: bundled with the app (electron/google.client.json), else env, else pasted in-app. */
function getConfig() {
  try {
    const bundled = JSON.parse(fs.readFileSync(path.join(__dirname, 'google.client.json'), 'utf8'));
    if (bundled.clientId) return { clientId: bundled.clientId, clientSecret: bundled.clientSecret ?? '', bundled: true };
  } catch { /* no bundled file */ }
  const env = process.env.GOOGLE_CLIENT_ID && { clientId: process.env.GOOGLE_CLIENT_ID, clientSecret: process.env.GOOGLE_CLIENT_SECRET ?? '' };
  return readJSON('google-config.json') ?? env ?? null;
}
function setConfig(c) { writeJSON('google-config.json', c); }

function getTokens() { return readJSON('google-tokens.json'); }
function setTokens(t) { if (t) writeJSON('google-tokens.json', t); else fs.rmSync(file('google-tokens.json'), { force: true }); }

function b64url(buf) { return buf.toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, ''); }

async function tokenRequest(params) {
  const res = await fetch('https://oauth2.googleapis.com/token', {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams(params),
  });
  const json = await res.json();
  if (!res.ok) throw new Error(json.error_description || json.error || 'Token request failed');
  return json;
}

async function accessToken() {
  const cfg = getConfig();
  const t = getTokens();
  if (!cfg || !t) throw new Error('Not signed in');
  if (t.expires_at - 60_000 > Date.now()) return t.access_token;
  const fresh = await tokenRequest({
    client_id: cfg.clientId,
    client_secret: cfg.clientSecret,
    refresh_token: t.refresh_token,
    grant_type: 'refresh_token',
  });
  const next = { ...t, access_token: fresh.access_token, scope: fresh.scope ?? t.scope, expires_at: Date.now() + fresh.expires_in * 1000 };
  setTokens(next);
  return next.access_token;
}

async function api(url) {
  const token = await accessToken();
  const res = await fetch(url, { headers: { Authorization: `Bearer ${token}` } });
  if (!res.ok) {
    const body = await res.text();
    throw new Error(`Google API ${res.status}: ${body.slice(0, 200)}`);
  }
  return res.json();
}

async function userInfo() {
  const u = await api('https://www.googleapis.com/oauth2/v3/userinfo');
  return { id: u.sub, email: u.email, name: u.name, givenName: u.given_name, familyName: u.family_name, picture: u.picture };
}

/** A current Google ID token (refreshing if needed) — exchanged for a Supabase session in the renderer. */
async function idToken() {
  const cfg = getConfig();
  const t = getTokens();
  if (!cfg || !t) return null;
  if (t.id_token && t.expires_at - 60_000 > Date.now()) return t.id_token;
  const fresh = await tokenRequest({ client_id: cfg.clientId, client_secret: cfg.clientSecret, refresh_token: t.refresh_token, grant_type: 'refresh_token' });
  const next = { ...t, access_token: fresh.access_token, id_token: fresh.id_token ?? t.id_token, expires_at: Date.now() + fresh.expires_in * 1000 };
  setTokens(next);
  return next.id_token ?? null;
}

async function status() {
  if (!getTokens()) return null;
  try { return await userInfo(); } catch { return null; }
}

const CAL_SCOPE = 'https://www.googleapis.com/auth/calendar.readonly';
function currentEmail() {
  try { return JSON.parse(Buffer.from(getTokens().id_token.split('.')[1], 'base64url').toString()).email; } catch { return null; }
}
function hasCalendarScope() { return (getTokens()?.scope ?? '').split(' ').includes(CAL_SCOPE); }

/** Ask only for calendar access, keeping the existing sign-in (incremental authorization). */
function grantCalendar() {
  return signIn({ scope: CAL_SCOPE, incremental: true }).then(() => hasCalendarScope());
}

function signIn(opts = {}) {
  const cfg = getConfig();
  if (!cfg?.clientId) return Promise.reject(new Error('Google client ID is not configured'));
  const scopes = opts.scope ?? SCOPES;

  return new Promise((resolve, reject) => {
    const verifier = b64url(crypto.randomBytes(32));
    const challenge = b64url(crypto.createHash('sha256').update(verifier).digest());
    const state = b64url(crypto.randomBytes(16));

    const server = http.createServer(async (req, res) => {
      const url = new URL(req.url, 'http://127.0.0.1');
      if (url.pathname !== '/callback') { res.writeHead(404).end(); return; }
      const finish = (html) => { res.writeHead(200, { 'Content-Type': 'text/html' }); res.end(html); server.close(); };
      try {
        if (url.searchParams.get('state') !== state) throw new Error('State mismatch');
        const code = url.searchParams.get('code');
        if (!code) throw new Error(url.searchParams.get('error') || 'No code');
        const redirectUri = `http://127.0.0.1:${server.address().port}/callback`;
        const tok = await tokenRequest({
          client_id: cfg.clientId,
          client_secret: cfg.clientSecret,
          code,
          code_verifier: verifier,
          grant_type: 'authorization_code',
          redirect_uri: redirectUri,
        });
        const prev = getTokens();
        // Incremental grants may omit a refresh token / id token; keep the ones we already have.
        setTokens({ ...prev, ...tok, refresh_token: tok.refresh_token ?? prev?.refresh_token, id_token: tok.id_token ?? prev?.id_token, expires_at: Date.now() + tok.expires_in * 1000 });
        finish('<body style="font-family:-apple-system,Segoe UI,sans-serif;text-align:center;padding-top:80px"><h2>Done</h2>You can close this tab and return to Exponential.</body>');
        resolve(await userInfo());
      } catch (err) {
        finish(`<body style="font-family:-apple-system,Segoe UI,sans-serif;text-align:center;padding-top:80px"><h2>Sign-in failed</h2>${String(err.message)}</body>`);
        reject(err);
      }
    });

    server.listen(0, '127.0.0.1', () => {
      const redirectUri = `http://127.0.0.1:${server.address().port}/callback`;
      const authUrl = new URL('https://accounts.google.com/o/oauth2/v2/auth');
      authUrl.search = new URLSearchParams({
        client_id: cfg.clientId,
        redirect_uri: redirectUri,
        response_type: 'code',
        scope: scopes,
        code_challenge: challenge,
        code_challenge_method: 'S256',
        state,
        access_type: 'offline',
        prompt: 'consent',
        include_granted_scopes: 'true',
        ...(opts.incremental && currentEmail() ? { login_hint: currentEmail() } : {}),
      }).toString();
      shell.openExternal(authUrl.toString());
    });

    setTimeout(() => { server.close(); reject(new Error('Sign-in timed out')); }, 5 * 60_000);
  });
}

async function signOut() {
  const t = getTokens();
  if (t?.access_token) {
    fetch(`https://oauth2.googleapis.com/revoke?token=${encodeURIComponent(t.refresh_token || t.access_token)}`, { method: 'POST' }).catch(() => {});
  }
  setTokens(null);
}

/** Events for one calendar between two dates (inclusive), flattened to the renderer's shape. */
async function events(calendarId, from, to) {
  const params = new URLSearchParams({
    timeMin: `${from}T00:00:00Z`,
    timeMax: `${to}T23:59:59Z`,
    singleEvents: 'true',
    orderBy: 'startTime',
    maxResults: '250',
  });
  const json = await api(`https://www.googleapis.com/calendar/v3/calendars/${encodeURIComponent(calendarId)}/events?${params}`);
  return (json.items || [])
    .filter((e) => e.status !== 'cancelled')
    .map((e) => {
      const allDay = !!e.start?.date;
      if (allDay) return { id: e.id, title: e.summary || '(No title)', date: e.start.date, allDay: true };
      const s = new Date(e.start.dateTime);
      const en = new Date(e.end.dateTime);
      const hhmm = (d) => `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`;
      const local = `${s.getFullYear()}-${String(s.getMonth() + 1).padStart(2, '0')}-${String(s.getDate()).padStart(2, '0')}`;
      return { id: e.id, title: e.summary || '(No title)', date: local, start: hhmm(s), end: hhmm(en), allDay: false };
    });
}

module.exports = { getConfig, setConfig, status, signIn, signOut, events, idToken, hasCalendarScope, grantCalendar };
