// Nernier — Suivi projet : serveur du site (connexion, page protégée, données partagées, import / export).
// Une seule fonction Netlify sert la page (/) et toutes les routes /api/*. Les données vivent dans Netlify Blobs.
//
// Variable d'environnement obligatoire (Netlify > Project configuration > Environment variables) :
//   NERNIER_ACCES  une personne par bloc, blocs séparés par « ; » (ou par des retours à la ligne) :
//                  identifiant | code d'accès | Nom affiché | rôle
//                  rôles : admin (tout + import/export), edition (commentaires, budget, factures), lecture
// Variable facultative :
//   NERNIER_SECRET clé de signature des sessions. Sans elle, une clé aléatoire est créée et gardée dans Blobs.
//                  La définir ou la changer déconnecte tout le monde.

import { getStore } from '@netlify/blobs';
import crypto from 'node:crypto';
import PAGE from '../page/index-html.mjs';

export const config = { path: ['/', '/index.html', '/api/*'] };

const FORMAT = 'nernier-suivi/1';
const STORE = 'nernier-suivi';
const KEY = 'etat';
const KEY_UNDO = 'sauvegarde/avant-dernier-import';
const KEY_SECRET = 'cle-session';
const COLLS = ['meta', 'actions', 'notes', 'jalons', 'planning', 'budget', 'factures', 'audit', 'programme', 'equipe', 'vigilance', 'journal'];
const EDITION = new Set(['notes', 'budget', 'factures']);
const ID_RE = /^[A-Za-z0-9_\-.~:@+]{1,200}$/;
const validId = id => ID_RE.test(id) && !['__proto__', 'constructor', 'prototype'].includes(id);
const COOKIE = 'nernier_session';
const HINT = 'nernier_connecte';
const SESSION_DAYS = 30;
const MAX_FAILS = 8;
const LOCK_MIN = 15;

const env = k => (globalThis.Netlify && Netlify.env && Netlify.env.get(k)) ?? process.env[k];
const store = () => getStore({ name: STORE, consistency: 'strong' });
const json = (body, status = 200) => new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' } });
const fail = (status, error) => json({ error }, status);
const sleep = ms => new Promise(r => setTimeout(r, ms));
const b64u = buf => Buffer.from(buf).toString('base64url');
const sha = s => crypto.createHash('sha256').update(s).digest('hex');
const plain = s => String(s || '').normalize('NFD').replace(/[̀-ͯ]/g, '').trim().toLowerCase();

/* ------------------------------------------------------------ comptes et sessions */
function users() {
  const out = new Map();
  for (const line of String(env('NERNIER_ACCES') || '').split(/[\n;]+/)) {
    const p = line.split('|').map(s => s.trim());
    if (p.length < 2 || !p[0] || !p[1]) continue;
    const r = plain(p[3]);
    const role = r.startsWith('admin') ? 'admin' : r.startsWith('edit') ? 'edition' : 'lecture';
    out.set(plain(p[0]), { id: plain(p[0]), code: p[1], name: p[2] || p[0], role });
  }
  return out;
}
let secretCache = null;
async function secret() {
  const fixed = env('NERNIER_SECRET'); if (fixed) return fixed;
  if (secretCache) return secretCache;
  const st = store();
  let s = await st.get(KEY_SECRET, { consistency: 'strong' });
  if (!s) {
    const gen = crypto.randomBytes(32).toString('hex');
    const w = await st.set(KEY_SECRET, gen, { onlyIfNew: true });
    s = w && w.modified ? gen : await st.get(KEY_SECRET, { consistency: 'strong' });
  }
  return (secretCache = s);
}
const sign = async (payload, code) => b64u(crypto.createHmac('sha256', await secret()).update(payload + '|' + sha(code)).digest());

function readCookies(req) {
  const o = {};
  for (const part of (req.headers.get('cookie') || '').split(';')) { const i = part.indexOf('='); if (i > 0) o[part.slice(0, i).trim()] = part.slice(i + 1).trim(); }
  return o;
}
async function auth(req) {
  const raw = readCookies(req)[COOKIE]; if (!raw) return null;
  const [payload, sig] = raw.split('.'); if (!payload || !sig) return null;
  let p; try { p = JSON.parse(Buffer.from(payload, 'base64url').toString()); } catch (e) { return null; }
  if (!p || !p.u || !p.e || p.e < Date.now()) return null;
  const u = users().get(p.u); if (!u) return null;
  const good = Buffer.from(await sign(payload, u.code)), got = Buffer.from(sig);
  if (good.length !== got.length || !crypto.timingSafeEqual(good, got)) return null;
  return u;
}
async function sessionCookies(u) {
  const age = SESSION_DAYS * 86400;
  const payload = b64u(JSON.stringify({ u: u.id, e: Date.now() + age * 1000 }));
  return [
    `${COOKIE}=${payload}.${await sign(payload, u.code)}; Path=/; HttpOnly; Secure; SameSite=Lax; Max-Age=${age}`,
    `${HINT}=1; Path=/; Secure; SameSite=Lax; Max-Age=${age}`,
  ];
}
const clearCookies = () => [`${COOKIE}=; Path=/; HttpOnly; Secure; SameSite=Lax; Max-Age=0`, `${HINT}=; Path=/; Secure; SameSite=Lax; Max-Age=0`];
function withCookies(res, list) { for (const c of list) res.headers.append('set-cookie', c); return res; }

/* ------------------------------------------------------------ état */
const empty = () => ({ format: FORMAT, rev: 0, updatedAt: null, data: Object.fromEntries(COLLS.map(c => [c, {}])), people: {}, deleted: {}, lastImport: null, undoAvailable: false });
async function load(st) {
  const r = await st.getWithMetadata(KEY, { type: 'json', consistency: 'strong' });
  if (!r || !r.data) return { state: empty(), etag: null };
  const s = r.data; s.data = s.data || {}; for (const c of COLLS) s.data[c] = s.data[c] || {};
  s.people = s.people || {}; s.deleted = s.deleted || {};
  return { state: s, etag: r.etag };
}
// Lecture-modification-écriture avec contrôle de version : plusieurs personnes peuvent écrire en même temps.
async function mutate(fn) {
  const st = store();
  for (let i = 0; i < 8; i++) {
    const { state, etag } = await load(st);
    const prev = state.rev || 0;
    const res = await fn(state);
    if (res && res.abort) return { res };
    state.rev = prev + 1; state.updatedAt = new Date().toISOString();
    const w = await st.setJSON(KEY, state, etag ? { onlyIfMatch: etag } : { onlyIfNew: true });
    if (w && w.modified === false) { await sleep(60 + Math.random() * 160); continue; }
    return { state, prev, v: (w && w.etag) || null, res };
  }
  throw new Error('conflit de version persistant');
}
const strip = d => { const o = {}; for (const k in d) if (k[0] !== '_') o[k] = d[k]; return o; };
const canon = v => Array.isArray(v) ? '[' + v.map(canon).join(',') + ']'
  : (v && typeof v === 'object') ? '{' + Object.keys(v).sort().map(k => JSON.stringify(k) + ':' + canon(v[k])).join(',') + '}'
  : JSON.stringify(v ?? null);
const same = (a, b) => canon(strip(a || {})) === canon(strip(b || {}));
const label = (c, d) => {
  if (!d) return '';
  if (c === 'actions') return `#${d.num ?? ''} ${d.titre || ''}`.trim();
  if (c === 'factures') return [d.fourn, d.num, d.objet].filter(Boolean).join(' · ');
  if (c === 'notes') return String(d.t || '').slice(0, 90);
  return String(d.poste || d.titre || d.t || d.role || d.sujet || d.label || '').slice(0, 90);
};
const people = s => { const p = { ...(s.people || {}) }; for (const u of users().values()) p[u.id] = u.name; return p; };

/* ------------------------------------------------------------ fusion à l'import
   Règle : un document modifié sur le site après le dernier export du site que Claude a intégré
   (champ `base` du fichier) est conservé tel quel ; tout le reste suit le fichier de Claude. */
function plan(state, file) {
  const base = file.base ? (Date.parse(file.base) || 0) : 0;
  const next = {}, stats = {}, kept = [], unknown = [];
  for (const c of Object.keys(file.data || {})) if (!COLLS.includes(c)) unknown.push(c);
  for (const c of COLLS) {
    const cur = state.data[c] || {};
    if (!(c in file.data)) { next[c] = cur; continue; }
    const inc = file.data[c] || {}, out = {}, s = { ajoutes: 0, modifies: 0, supprimes: 0, conserves: 0 };
    for (const [id, doc] of Object.entries(inc)) {
      if (!validId(id) || !doc || typeof doc !== 'object' || Array.isArray(doc)) continue;
      const site = cur[id];
      if (site && (site._t || 0) > base) {
        out[id] = site;
        if (!same(site, doc)) { s.conserves++; kept.push({ c, id, label: label(c, site), quand: new Date(site._t).toISOString(), par: site._by || '' }); }
        continue;
      }
      const del = state.deleted[c + '/' + id];
      if (!site && del && del.t > base) { s.conserves++; kept.push({ c, id, label: label(c, doc) + ' — supprimé sur le site', quand: new Date(del.t).toISOString(), par: del.by || '' }); continue; }
      out[id] = strip(doc);
      if (!site) s.ajoutes++; else if (!same(site, doc)) s.modifies++;
    }
    for (const [id, site] of Object.entries(cur)) {
      if (id in out) continue;
      if ((site._t || 0) > base) { out[id] = site; s.conserves++; kept.push({ c, id, label: label(c, site) + ' — ajouté sur le site', quand: new Date(site._t).toISOString(), par: site._by || '' }); }
      else if (!(id in inc)) s.supprimes++;
    }
    next[c] = out; stats[c] = s;
  }
  const deleted = {};
  for (const [k, v] of Object.entries(state.deleted || {})) if (v && v.t > base) deleted[k] = v;
  return { next, stats, kept, unknown, deleted };
}

/* ------------------------------------------------------------ routes */
export default async (req, context) => {
  const url = new URL(req.url);
  const method = req.method;
  try {
    if (!url.pathname.startsWith('/api/')) return await page(req);
    const route = url.pathname.replace(/^\/api\/?/, '').replace(/\/$/, '');
    if (route === 'login' && method === 'POST') return await login(req, context);
    if (route === 'logout') return withCookies(json({ ok: true }), clearCookies());
    const u = await auth(req);
    if (!u) return withCookies(fail(401, 'Session expirée : reconnecte-toi.'), clearCookies());

    if (route === 'state' && method === 'GET') {
      const st = store(), v = url.searchParams.get('v');
      if (v) { const m = await st.getMetadata(KEY, { consistency: 'strong' }).catch(() => null); if (m && m.etag === v) return json({ same: true }); }
      const r = await st.getWithMetadata(KEY, { type: 'json', consistency: 'strong' });
      const state = r && r.data ? r.data : empty();
      return json({ v: (r && r.etag) || '', rev: state.rev, updatedAt: state.updatedAt, lastImport: state.lastImport, undo: !!state.undoAvailable,
        data: state.data, people: people(state), me: { id: u.id, name: u.name, role: u.role } });
    }
    if (route === 'write' && method === 'POST') return await write(req, u);
    if (u.role !== 'admin') return fail(403, "Réservé à l'administrateur du suivi.");
    if (route === 'export' && method === 'GET') {
      const { state } = await load(store());
      const now = new Date();
      // base : instant des dernières données incluses (toute modification absente de cet export est postérieure)
      const body = { format: FORMAT, source: 'site', exportedAt: now.toISOString(), base: state.updatedAt || now.toISOString(), exportedBy: u.name, rev: state.rev,
        lastImport: state.lastImport, people: people(state), deleted: state.deleted, data: state.data };
      const stamp = now.toISOString().slice(0, 16).replace(/[-:]/g, '').replace('T', '-');
      return new Response(JSON.stringify(body, null, 1), { headers: { 'content-type': 'application/json; charset=utf-8', 'content-disposition': `attachment; filename="nernier-export-site-${stamp}.json"`, 'cache-control': 'no-store' } });
    }
    if (route === 'import' && method === 'POST') return await doImport(req, u, url.searchParams.get('mode') === 'apply');
    if (route === 'undo' && method === 'POST') return await undo();
    return fail(404, 'Route inconnue.');
  } catch (e) {
    console.error(e);
    return fail(500, 'Erreur du serveur. Réessaie dans un instant.');
  }
};

async function page(req) {
  if (!(await auth(req))) return withCookies(new Response(null, { status: 302, headers: { location: '/login', 'cache-control': 'no-store' } }), clearCookies());
  return new Response(PAGE, { headers: { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store', 'x-robots-tag': 'noindex, nofollow', 'x-frame-options': 'DENY', 'referrer-policy': 'same-origin' } });
}

async function login(req, context) {
  let b; try { b = await req.json(); } catch (e) { return fail(400, 'Requête invalide.'); }
  const id = plain(b && b.id), code = String((b && b.code) || '').trim();
  if (!id || !code) return fail(400, 'Renseigne ton identifiant et ton code d’accès.');
  if (!users().size) return fail(500, "Aucun accès n'est configuré : ajoute la variable NERNIER_ACCES dans Netlify puis redéploie le site.");
  // Chaque essai est compté avant la vérification du code, par identifiant et par adresse IP, avec écriture conditionnelle :
  // des essais envoyés en rafale ne peuvent pas dépasser la limite, et un tiers ne peut pas bloquer un compte depuis une autre adresse.
  const ip = (context && context.ip) || req.headers.get('x-nf-client-connection-ip') || '';
  const st = store(), lk = 'connexion/' + sha(id + '|' + ip).slice(0, 32);
  let counted = false;
  for (let i = 0; i < 6 && !counted; i++) {
    const r = await st.getWithMetadata(lk, { type: 'json', consistency: 'strong' }).catch(() => null);
    const cur = (r && r.data) || { n: 0, until: 0 };
    if (cur.until > Date.now()) return fail(429, `Trop d'essais. Réessaie dans ${Math.ceil((cur.until - Date.now()) / 60000)} min.`);
    const n = (cur.n || 0) + 1;
    const w = await st.setJSON(lk, n >= MAX_FAILS ? { n: 0, until: Date.now() + LOCK_MIN * 60000 } : { n, until: 0 }, r && r.etag ? { onlyIfMatch: r.etag } : { onlyIfNew: true }).catch(() => null);
    counted = !!(w && w.modified);
    if (!counted) await sleep(40 + Math.random() * 80);
  }
  if (!counted) return fail(429, "Trop d'essais simultanés. Réessaie dans un instant.");
  const u = users().get(id);
  const ok = !!u && u.code.length === code.length && crypto.timingSafeEqual(Buffer.from(u.code), Buffer.from(code));
  if (!ok) { await sleep(700); return fail(401, 'Identifiant ou code d’accès incorrect.'); }
  await st.delete(lk).catch(() => {});
  return withCookies(json({ ok: true, me: { id: u.id, name: u.name, role: u.role } }), await sessionCookies(u));
}

async function write(req, u) {
  if (u.role === 'lecture') return fail(403, 'Accès en lecture seule.');
  let b; try { b = await req.json(); } catch (e) { return fail(400, 'Requête invalide.'); }
  const ops = Array.isArray(b && b.ops) ? b.ops : [];
  if (!ops.length || ops.length > 50) return fail(400, 'Requête invalide.');
  for (const o of ops) {
    if (!['set', 'update', 'delete'].includes(o.op) || !COLLS.includes(o.c) || !validId(String(o.id || ''))) return fail(400, 'Requête invalide.');
    if (o.op !== 'delete' && (!o.data || typeof o.data !== 'object' || Array.isArray(o.data))) return fail(400, 'Requête invalide.');
    if (u.role !== 'admin' && !EDITION.has(o.c)) return fail(403, "Cette partie du suivi n'est modifiable que par l'administrateur.");
  }
  const r = await mutate(state => {
    const t = Date.now();
    for (const o of ops) {
      const coll = state.data[o.c], cur = coll[o.id];
      if (o.c === 'notes' && u.role !== 'admin' && cur && cur.by && cur.by !== u.id) return { abort: true, error: 'Tu ne peux modifier que tes propres commentaires.' };
      if (o.op === 'delete') { if (cur) { delete coll[o.id]; state.deleted[o.c + '/' + o.id] = { t, by: u.id }; } continue; }
      const doc = o.op === 'set' ? {} : Object.assign({}, cur || {});
      for (const [k, val] of Object.entries(o.data)) {
        if (k[0] === '_') continue;
        if (val && typeof val === 'object' && !Array.isArray(val) && val.__delete__) delete doc[k]; else doc[k] = val;
      }
      // l'auteur d'un commentaire est toujours fixé par le serveur, jamais par la requête
      if (o.c === 'notes') {
        if (cur && cur.by) { doc.by = cur.by; doc.byName = cur.byName || (cur.by === u.id ? u.name : ''); }
        else { doc.by = u.id; doc.byName = u.name; }
      }
      doc._t = t; doc._by = u.id;
      coll[o.id] = doc;
      delete state.deleted[o.c + '/' + o.id];
    }
  });
  if (r.res && r.res.abort) return fail(403, r.res.error);
  return json({ ok: true, rev: r.state.rev, prev: r.prev, v: r.v });
}

async function doImport(req, u, apply) {
  let file; try { file = await req.json(); } catch (e) { return fail(400, "Le fichier n'est pas un JSON valide."); }
  if (!file || file.format !== FORMAT || !file.data || typeof file.data !== 'object') return fail(400, "Ce fichier n'est pas un fichier de mise à jour du suivi Nernier.");
  if (file.source === 'site') return fail(400, "Ce fichier est un export du site, à envoyer à Claude. Pour mettre le site à jour, importe le fichier que Claude te renvoie.");
  if (!apply) {
    const { state } = await load(store());
    const p = plan(state, file);
    return json({ preview: true, stats: p.stats, kept: p.kept, unknown: p.unknown, exportedAt: file.exportedAt || null, base: file.base || null, empty: !state.rev });
  }
  let snapshot = null, p = null;
  const r = await mutate(state => {
    snapshot = JSON.parse(JSON.stringify(state));
    snapshot.undoAvailable = false; delete snapshot.undoOf;
    p = plan(state, file);
    state.data = p.next; state.deleted = p.deleted;
    state.people = Object.assign({}, state.people || {}, file.people || {});
    state.lastImport = { at: new Date().toISOString(), by: u.name, exportedAt: file.exportedAt || null, base: file.base || null, conserves: p.kept.length };
    state.undoAvailable = true; state.undoOf = snapshot.rev || 0;
  });
  const st = store();
  try { await st.setJSON(KEY_UNDO, snapshot); }
  catch (e) { console.error(e); await mutate(state => { state.undoAvailable = false; delete state.undoOf; }).catch(() => {}); }
  await st.setJSON('historique/' + new Date().toISOString().replace(/[:.]/g, '-'), snapshot).catch(() => {});
  return json({ ok: true, rev: r.state.rev, stats: p.stats, kept: p.kept });
}

async function undo() {
  const st = store();
  const snap = await st.get(KEY_UNDO, { type: 'json', consistency: 'strong' });
  if (!snap) return fail(404, 'Aucune importation à annuler.');
  const r = await mutate(state => {
    if (!state.undoAvailable || (snap.rev || 0) !== state.undoOf) return { abort: true };
    const rev = state.rev;
    for (const k of Object.keys(state)) delete state[k];
    Object.assign(state, snap, { rev, undoAvailable: false });
  });
  if (r.res && r.res.abort) return fail(404, 'Aucune importation à annuler.');
  await st.delete(KEY_UNDO).catch(() => {});
  return json({ ok: true, rev: r.state.rev });
}
