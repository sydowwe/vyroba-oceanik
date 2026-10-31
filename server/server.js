'use strict';
/*
 * Oceanik – server pre EasyPanel / Hostinger.
 * Servíruje vyroba_oceanik_7.html a REST API nad PostgreSQL.
 *
 * Dáta sú uložené po kolekciách (zakazky, terasy, opravy, sklad) v tabuľke
 * app_state ako JSONB. Každý zápis dostane nové číslo revízie (rev), podľa
 * ktorého klient zistí, či niekto iný medzitým zmenil dáta.
 *
 * Premenné prostredia:
 *   DATABASE_URL          postgres://user:heslo@host:5432/db   (povinné)
 *   PORT                  default 3000
 *   BASIC_AUTH_USER       ak je nastavené spolu s heslom, appka vyžaduje prihlásenie
 *   BASIC_AUTH_PASSWORD
 *   PGSSL                 "true" ak DB vyžaduje SSL (v rámci EasyPanelu netreba)
 */
const http = require('node:http');
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const { Pool } = require('pg');

const PORT = parseInt(process.env.PORT || '3000', 10);
const ROOT = path.resolve(__dirname, '..');
const INDEX_FILE = path.join(ROOT, 'vyroba_oceanik_7.html');
const KEYS = ['zakazky', 'terasy', 'opravy', 'sklad'];
const MAX_BODY = 10 * 1024 * 1024;
const HISTORY_EVERY_MIN = 15;   // záloha kolekcie do histórie najčastejšie raz za 15 min
const HISTORY_KEEP = 2000;      // max. počet záznamov histórie na kolekciu

const AUTH_USER = process.env.BASIC_AUTH_USER || '';
const AUTH_PASS = process.env.BASIC_AUTH_PASSWORD || '';

if (!process.env.DATABASE_URL) {
  console.error('Chýba DATABASE_URL');
  process.exit(1);
}

const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: process.env.PGSSL === 'true' ? { rejectUnauthorized: false } : undefined,
  max: 5
});

async function migrate() {
  await pool.query(`
    CREATE SEQUENCE IF NOT EXISTS app_rev_seq;
    CREATE TABLE IF NOT EXISTS app_state (
      key        text PRIMARY KEY,
      data       jsonb NOT NULL,
      rev        bigint NOT NULL,
      updated_at timestamptz NOT NULL DEFAULT now()
    );
    CREATE TABLE IF NOT EXISTS app_state_history (
      id       bigserial PRIMARY KEY,
      key      text NOT NULL,
      data     jsonb NOT NULL,
      rev      bigint NOT NULL,
      saved_at timestamptz NOT NULL DEFAULT now()
    );
    CREATE INDEX IF NOT EXISTS app_state_history_key_idx ON app_state_history (key, saved_at DESC);
  `);
}

/* ---------- helpers ---------- */
function send(res, status, body, headers = {}) {
  const isBuf = Buffer.isBuffer(body);
  const payload = isBuf ? body : Buffer.from(typeof body === 'string' ? body : JSON.stringify(body));
  res.writeHead(status, {
    'Content-Type': isBuf || typeof body === 'string' ? 'text/plain; charset=utf-8' : 'application/json; charset=utf-8',
    'Content-Length': payload.length,
    'Cache-Control': 'no-store',
    ...headers
  });
  res.end(payload);
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    let size = 0;
    const chunks = [];
    req.on('data', (c) => {
      size += c.length;
      if (size > MAX_BODY) { reject(Object.assign(new Error('Príliš veľké telo požiadavky'), { status: 413 })); req.destroy(); return; }
      chunks.push(c);
    });
    req.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
    req.on('error', reject);
  });
}

function safeEqual(a, b) {
  const ba = Buffer.from(a), bb = Buffer.from(b);
  return ba.length === bb.length && crypto.timingSafeEqual(ba, bb);
}

function authorized(req) {
  if (!AUTH_USER || !AUTH_PASS) return true;
  const h = req.headers.authorization || '';
  if (!h.startsWith('Basic ')) return false;
  const [u, ...rest] = Buffer.from(h.slice(6), 'base64').toString('utf8').split(':');
  const okUser = safeEqual(u, AUTH_USER);
  const okPass = safeEqual(rest.join(':'), AUTH_PASS);
  return okUser && okPass;
}

/* ---------- API ---------- */
async function getState() {
  const { rows } = await pool.query('SELECT key, data, rev FROM app_state WHERE key = ANY($1)', [KEYS]);
  const out = { revs: {} };
  KEYS.forEach((k) => { out[k] = null; out.revs[k] = 0; });
  rows.forEach((r) => { out[r.key] = r.data; out.revs[r.key] = Number(r.rev); });
  return out;
}

async function getRevs() {
  const { rows } = await pool.query('SELECT key, rev FROM app_state WHERE key = ANY($1)', [KEYS]);
  const revs = {};
  KEYS.forEach((k) => { revs[k] = 0; });
  rows.forEach((r) => { revs[r.key] = Number(r.rev); });
  return { revs };
}

async function putKey(key, data) {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const { rows } = await client.query(
      `INSERT INTO app_state (key, data, rev, updated_at)
       VALUES ($1, $2::jsonb, nextval('app_rev_seq'), now())
       ON CONFLICT (key) DO UPDATE SET data = EXCLUDED.data, rev = EXCLUDED.rev, updated_at = now()
       RETURNING rev`,
      [key, JSON.stringify(data)]
    );
    const rev = Number(rows[0].rev);
    // periodická záloha do histórie
    const last = await client.query(
      'SELECT saved_at FROM app_state_history WHERE key = $1 ORDER BY saved_at DESC LIMIT 1', [key]);
    const stale = !last.rows.length ||
      (Date.now() - new Date(last.rows[0].saved_at).getTime()) > HISTORY_EVERY_MIN * 60 * 1000;
    if (stale) {
      await client.query('INSERT INTO app_state_history (key, data, rev) VALUES ($1, $2::jsonb, $3)',
        [key, JSON.stringify(data), rev]);
      await client.query(
        `DELETE FROM app_state_history WHERE key = $1 AND id NOT IN
           (SELECT id FROM app_state_history WHERE key = $1 ORDER BY saved_at DESC LIMIT $2)`,
        [key, HISTORY_KEEP]);
    }
    await client.query('COMMIT');
    return rev;
  } catch (e) {
    await client.query('ROLLBACK').catch(() => {});
    throw e;
  } finally {
    client.release();
  }
}

/* ---------- router ---------- */
let indexCache = null;
function indexHtml() {
  if (!indexCache || process.env.NODE_ENV !== 'production') indexCache = fs.readFileSync(INDEX_FILE);
  return indexCache;
}

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, 'http://localhost');
  const p = url.pathname;
  try {
    if (p === '/healthz') {
      await pool.query('SELECT 1');
      return send(res, 200, { ok: true, version: process.env.GIT_SHA || 'dev' });
    }

    if (!authorized(req)) {
      return send(res, 401, 'Prihlásenie je povinné', { 'WWW-Authenticate': 'Basic realm="Oceanik", charset="UTF-8"' });
    }

    if (req.method === 'GET' && (p === '/' || p === '/index.html' || p === '/vyroba_oceanik_7.html')) {
      const body = indexHtml();
      res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8', 'Content-Length': body.length, 'Cache-Control': 'no-store' });
      return res.end(body);
    }

    if (req.method === 'GET' && p === '/api/state') return send(res, 200, await getState());
    if (req.method === 'GET' && p === '/api/revs') return send(res, 200, await getRevs());

    const m = p.match(/^\/api\/state\/([a-z]+)$/);
    if (m && req.method === 'PUT') {
      const key = m[1];
      if (!KEYS.includes(key)) return send(res, 404, { error: 'Neznáma kolekcia' });
      let data;
      try { data = JSON.parse(await readBody(req)); } catch (e) {
        if (e.status) throw e;
        return send(res, 400, { error: 'Neplatný JSON' });
      }
      if (key === 'sklad' ? (typeof data !== 'object' || data === null || Array.isArray(data)) : !Array.isArray(data)) {
        return send(res, 400, { error: 'Neplatný formát dát pre ' + key });
      }
      const rev = await putKey(key, data);
      return send(res, 200, { key, rev });
    }

    if (req.method === 'GET' && p === '/api/export') {
      const s = await getState();
      delete s.revs;
      return send(res, 200, s, { 'Content-Disposition': 'attachment; filename="oceanik-export.json"' });
    }

    return send(res, 404, 'Not found');
  } catch (e) {
    console.error(e);
    return send(res, e.status || 500, { error: e.status ? e.message : 'Chyba servera' });
  }
});

migrate()
  .then(() => {
    server.listen(PORT, () => console.log(`Oceanik beží na porte ${PORT}${AUTH_USER ? ' (s prihlásením)' : ''}`));
  })
  .catch((e) => { console.error('Migrácia DB zlyhala:', e); process.exit(1); });

function shutdown() {
  server.close(() => pool.end().finally(() => process.exit(0)));
  setTimeout(() => process.exit(0), 5000).unref();
}
process.on('SIGTERM', shutdown);
process.on('SIGINT', shutdown);
