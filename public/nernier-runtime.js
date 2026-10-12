/* Nernier — Suivi projet : moteur du site.
   Fournit à la page la même interface que l'artifact claude.ai (window.claude.use('db') et use('user')),
   mais branchée sur l'API Netlify du site. La page elle-même est identique à celle de l'artifact.
   Ajoute la barre de session : utilisateur connecté, export pour Claude, import de la mise à jour, déconnexion. */
(() => {
  'use strict';
  const HINT = 'nernier_connecte';
  const POLL_MS = 15000;
  const LABELS = {meta: 'Paramètres du projet', actions: "Plan d'actions", notes: 'Commentaires de séance', jalons: 'Jalons', planning: 'Planning', budget: 'Budget', factures: 'Factures', audit: 'Audit technique', programme: 'Programme', equipe: 'Équipe', vigilance: 'Points de vigilance', journal: 'Journal des mises à jour'};
  const ROLES = {admin: 'Administrateur', edition: 'Édition', lecture: 'Lecture'};

  const goLogin = () => location.replace('/login?r=' + encodeURIComponent(location.pathname + location.hash));
  if (!document.cookie.split(/;\s*/).some(c => c.indexOf(HINT + '=1') === 0)) { goLogin(); return; }

  /* ------------------------------------------------------------ données */
  let S = null;                 // {v, rev, data, people, me, lastImport, undo}
  const subs = new Set();
  let readyRes; const ready = new Promise(r => { readyRes = r; });
  let busy = 0, epoch = 0, needSync = false, inflight = null, offline = false, lastOk = null;

  async function api(path, opt = {}) {
    let r;
    try { r = await fetch('/api/' + path, Object.assign({credentials: 'same-origin', cache: 'no-store'}, opt, {headers: Object.assign({'content-type': 'application/json'}, opt.headers || {})})); }
    catch (e) { throw Object.assign(new Error('Connexion impossible'), {code: 'unavailable'}); }
    if (r.status === 401) { goLogin(); throw Object.assign(new Error('Session expirée'), {code: 'revoked'}); }
    if (opt.raw && r.ok) return r;
    let j = null; try { j = await r.json(); } catch (e) {}
    if (!r.ok) throw Object.assign(new Error((j && j.error) || ('Erreur ' + r.status)), {code: r.status === 403 ? 'invalid_argument' : 'unavailable', status: r.status});
    return j;
  }
  const clean = d => { const o = {}; for (const k in d) if (k[0] !== '_') o[k] = d[k]; return o; };
  function deliver(s) {
    if (!S) return;
    const coll = S.data[s.c] || {};
    try {
      if (s.k === 'coll') { const docs = Object.keys(coll).map(id => ({id, exists: true, data: () => clean(coll[id])})); s.cb({docs, size: docs.length, empty: !docs.length}); }
      else { const d = coll[s.id]; s.cb({id: s.id, exists: !!d, data: () => (d ? clean(d) : undefined)}); }
    } catch (e) { console.error(e); }
  }
  const emit = () => subs.forEach(deliver);

  function refresh(force) {
    if (inflight) return inflight;
    const e0 = epoch;
    inflight = api('state' + (S && !force && S.v ? '?v=' + encodeURIComponent(S.v) : '')).then(j => {
      offline = false; lastOk = new Date();
      if (epoch !== e0 || busy) { if (busy) needSync = true; else setTimeout(() => refresh(true), 30); return false; }
      if (j.same) { bar(); return false; }
      S = j; readyRes(); emit(); bar(); return true;
    }, e => {
      if (e.code !== 'revoked') { offline = true; bar(); if (!S) subs.forEach(s => s.err && s.err(e)); }
      return false;
    }).finally(() => { inflight = null; });
    return inflight;
  }

  function applyLocal(op) {
    const coll = S.data[op.c] || (S.data[op.c] = {});
    if (op.op === 'delete') { delete coll[op.id]; return; }
    const doc = op.op === 'set' ? {} : Object.assign({}, coll[op.id] || {});
    for (const [k, v] of Object.entries(op.data || {})) { if (v && typeof v === 'object' && !Array.isArray(v) && v.__delete__) delete doc[k]; else doc[k] = v; }
    if (op.c === 'notes' && op.op === 'set') { doc.by = S.me.id; doc.byName = S.me.name; }
    doc._t = Date.now(); coll[op.id] = doc;
  }
  let chain = Promise.resolve();
  function write(op) {
    if (!S) return Promise.reject(Object.assign(new Error('Données non chargées'), {code: 'unavailable'}));
    epoch++; busy++;
    applyLocal(op); emit();
    const p = chain.then(() => api('write', {method: 'POST', body: JSON.stringify({ops: [op]})})).then(j => {
      if (S && j.prev === S.rev && j.v) { S.rev = j.rev; S.v = j.v; } else needSync = true;
    });
    chain = p.catch(() => {});
    return p.catch(e => { needSync = true; throw e; }).finally(() => { busy--; if (!busy && needSync) { needSync = false; refresh(true); } });
  }

  const newId = () => 'x' + Date.now().toString(36) + Math.random().toString(36).slice(2, 8);
  const ref = (c, id) => ({
    id,
    onSnapshot(cb, err) { const s = {k: 'doc', c, id, cb, err}; subs.add(s); if (S) deliver(s); return () => subs.delete(s); },
    get: async () => { await ready; const d = (S.data[c] || {})[id]; return {id, exists: !!d, data: () => (d ? clean(d) : undefined)}; },
    set: data => write({op: 'set', c, id, data}),
    update: data => write({op: 'update', c, id, data}),
    delete: () => write({op: 'delete', c, id}),
  });
  const db = {
    collection: c => ({ doc: id => ref(c, id || newId()), onSnapshot(cb, err) { const s = {k: 'coll', c, cb, err}; subs.add(s); if (S) deliver(s); return () => subs.delete(s); } }),
    doc: path => { const i = String(path).indexOf('/'); return ref(String(path).slice(0, i), String(path).slice(i + 1)); },
  };
  const user = {
    id: async () => { await ready; return S.me.id; },
    can: async () => { await ready; return S.me.role !== 'lecture'; },
    profiles: async ids => { await ready; const o = {}; (ids || []).forEach(i => { o[i] = {name: S.people[i] || ''}; }); return o; },
  };
  window.claude = { use: async name => {
    if (name === 'db') return db;
    if (name === 'user') return user;
    throw Object.assign(new Error('Fonction non disponible sur le site'), {code: 'unavailable'});
  } };

  refresh(true);
  setInterval(() => { if (!document.hidden && !busy) refresh(); }, POLL_MS);
  document.addEventListener('visibilitychange', () => { if (!document.hidden && !busy) refresh(); });

  /* ------------------------------------------------------------ barre de session */
  const esc = s => String(s ?? '').replace(/[&<>"']/g, c => ({'&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;'}[c]));
  const pad = n => String(n).padStart(2, '0');
  const fdt = s => { const d = new Date(s); return isNaN(d) ? '' : `${pad(d.getDate())}/${pad(d.getMonth() + 1)}/${d.getFullYear()} à ${pad(d.getHours())}:${pad(d.getMinutes())}`; };
  const isEmpty = () => S && !Object.values(S.data || {}).some(c => c && Object.keys(c).length);
  function toast(m) {
    const t = document.getElementById('toast'); if (!t) return;
    t.textContent = m; t.classList.add('on'); clearTimeout(toast._t); toast._t = setTimeout(() => t.classList.remove('on'), 2600);
  }

  const css = `
#sitebar{background:#161614;color:#F2F1EB;font-family:var(--f-body,system-ui);font-size:13px}
#sitebar .sb-in{display:flex;align-items:center;justify-content:space-between;gap:10px 16px;flex-wrap:wrap;padding-block:6px;min-height:40px}
#sitebar .sb-l{display:flex;align-items:center;gap:8px;flex-wrap:wrap;min-width:0}
#sitebar .sb-dot{width:8px;height:8px;border-radius:50%;background:#52C483;flex:none}
#sitebar .sb-dot.off{background:#F0A04E}
#sitebar .sb-name{font-weight:600}
#sitebar .sb-role{font-family:var(--f-head,system-ui);font-size:11px;font-weight:700;letter-spacing:.08em;text-transform:uppercase;color:#161614;background:#FFC72C;border-radius:3px;padding:1px 6px 0}
#sitebar .sb-maj{color:#B9B7AE}
#sitebar .sb-r{display:flex;gap:6px;flex-wrap:wrap}
#sitebar button{border:1px solid #4A4943;background:transparent;color:#F2F1EB;border-radius:6px;padding:5px 11px;font-size:13px;font-weight:600;line-height:1.2}
#sitebar button:hover{border-color:#FFC72C;color:#FFC72C}
#sitebar button.sb-hot{background:#FFC72C;border-color:#FFC72C;color:#161614}
#sitebar button.sb-hot:hover{background:#FFD761;color:#161614}
#sitebar button:focus-visible{outline:2px solid #FFC72C;outline-offset:2px}
.sb-modal{position:fixed;inset:0;z-index:80;background:rgba(22,22,20,.55);display:flex;align-items:flex-start;justify-content:center;padding:6vh 16px 16px;overflow:auto}
.sb-card{background:var(--surface,#fff);color:var(--ink,#161614);border-radius:10px;box-shadow:0 18px 50px rgba(0,0,0,.3);width:min(680px,100%);overflow:hidden}
.sb-card .sb-h{background:#FFC72C;color:#161614;padding:14px 20px}
.sb-card .sb-h h2{font-family:var(--f-head,system-ui);font-size:22px;font-weight:800;margin:0}
.sb-card .sb-h p{margin:2px 0 0;font-size:13px;font-weight:500}
.sb-card .sb-b{padding:16px 20px 20px;display:flex;flex-direction:column;gap:14px;font-size:14px}
.sb-card table{width:100%;border-collapse:collapse;font-variant-numeric:tabular-nums}
.sb-card th{font-family:var(--f-head,system-ui);font-size:11.5px;font-weight:700;letter-spacing:.07em;text-transform:uppercase;color:var(--muted,#6D6B63);text-align:right;padding:6px 8px;border-bottom:2px solid var(--ink,#161614)}
.sb-card th:first-child,.sb-card td:first-child{text-align:left;padding-left:0}
.sb-card td{padding:6px 8px;border-bottom:1px solid var(--line,#E0DED5);text-align:right}
.sb-card td.z{color:var(--muted,#6D6B63)}
.sb-card td.k{font-weight:700;color:var(--wait,#B9620A)}
.sb-warn{background:var(--wait-soft,#FAEAD8);color:var(--ink,#161614);border-left:4px solid var(--wait,#B9620A);border-radius:6px;padding:10px 12px}
.sb-warn ul{margin:6px 0 0;padding-left:18px}
.sb-err{background:var(--crit-soft,#F8E0DC);color:var(--crit,#BE3329);border-radius:6px;padding:10px 12px;font-weight:600}
.sb-ok{background:var(--ok-soft,#DCF0E3);color:var(--ok,#1D7F45);border-radius:6px;padding:10px 12px;font-weight:600}
.sb-act{display:flex;justify-content:flex-end;gap:8px;flex-wrap:wrap}
.sb-act button{border-radius:7px;padding:8px 14px;font-weight:700;font-size:14px;border:1px solid var(--line,#E0DED5);background:var(--surface,#fff);color:var(--ink,#161614)}
.sb-act button.go{background:#161614;color:#fff;border-color:#161614}
.sb-act button.go:hover{background:#000}
.sb-act button.dz{background:var(--crit,#BE3329);border-color:var(--crit,#BE3329);color:#fff}
.sb-act button:disabled{opacity:.55;cursor:default}
#sitebar .sm{display:none}
@media (max-width:560px){#sitebar .sb-maj{display:none}#sitebar button{padding:5px 9px}#sitebar .lg{display:none}#sitebar .sm{display:inline}#sitebar [data-sb="undo"]{display:none}}
@media (prefers-color-scheme: dark){ .sb-act button.go{background:#FFC72C;color:#161614;border-color:#FFC72C} }`;

  let barEl = null, fileEl = null;
  function bar() {
    if (!barEl) return;
    const me = S && S.me;
    const admin = me && me.role === 'admin';
    const li = S && S.lastImport;
    const maj = li ? `Dernière mise à jour importée le ${fdt(li.at)}` : (S ? 'Aucune mise à jour importée' : 'Chargement…');
    barEl.innerHTML = `<div class="in sb-in">
      <div class="sb-l"><span class="sb-dot ${offline ? 'off' : ''}" title="${offline ? 'Connexion interrompue : nouvel essai automatique' : 'Données à jour' + (lastOk ? ' (' + pad(lastOk.getHours()) + ':' + pad(lastOk.getMinutes()) + ')' : '')}"></span>
        ${me ? `<span class="sb-name">${esc(me.name)}</span><span class="sb-role">${esc(ROLES[me.role] || me.role)}</span>` : ''}
        <span class="sb-maj">${offline ? 'Connexion interrompue, nouvel essai en cours…' : esc(maj)}</span></div>
      <div class="sb-r">
        ${admin ? `<button data-sb="export" title="Télécharge toutes les données du site (commentaires, budget, factures) pour les envoyer à Claude"><span class="lg">Exporter pour Claude</span><span class="sm">Exporter</span></button>
        <button data-sb="import" class="${isEmpty() ? 'sb-hot' : ''}" title="Charge le fichier de mise à jour préparé par Claude"><span class="lg">${isEmpty() ? 'Importer les données' : 'Importer la mise à jour'}</span><span class="sm">Importer</span></button>
        ${S.undo ? `<button data-sb="undo" title="Revenir à l'état d'avant le dernier import"><span class="lg">Annuler le dernier import</span><span class="sm">Annuler l'import</span></button>` : ''}` : ''}
        <button data-sb="logout"><span class="lg">Se déconnecter</span><span class="sm">Sortir</span></button>
      </div></div>`;
  }

  function modal(html) {
    closeModal();
    const m = document.createElement('div'); m.className = 'sb-modal'; m.id = 'sb-modal';
    m.innerHTML = `<div class="sb-card" role="dialog" aria-modal="true" aria-labelledby="sbm-t">${html}</div>`;
    m.addEventListener('click', e => { if (e.target === m) closeModal(); });
    document.body.appendChild(m);
    const f = m.querySelector('button.go, button.dz, button'); if (f) f.focus();
    return m;
  }
  function closeModal() { const m = document.getElementById('sb-modal'); if (m) m.remove(); }
  document.addEventListener('keydown', e => { if (e.key === 'Escape') closeModal(); });

  function statsTable(stats) {
    const rows = Object.keys(LABELS).filter(c => stats[c]).map(c => { const s = stats[c]; const n = v => `<td class="${v ? '' : 'z'}">${v || '—'}</td>`;
      return `<tr><td>${LABELS[c]}</td>${n(s.ajoutes)}${n(s.modifies)}${n(s.supprimes)}<td class="${s.conserves ? 'k' : 'z'}">${s.conserves || '—'}</td></tr>`; }).join('');
    return `<table><thead><tr><th>Partie du suivi</th><th>Ajouts</th><th>Modifs</th><th>Suppr.</th><th>Conservés</th></tr></thead><tbody>${rows}</tbody></table>`;
  }
  function keptBlock(kept) {
    if (!kept || !kept.length) return '';
    const items = kept.slice(0, 12).map(k => `<li>${esc(LABELS[k.c] || k.c)} : ${esc(k.label || k.id)} <span style="color:var(--muted)">(${esc(S.people[k.par] || k.par || '')}${k.quand ? ', ' + fdt(k.quand) : ''})</span></li>`).join('');
    return `<div class="sb-warn"><b>${kept.length} modification${kept.length > 1 ? 's' : ''} faite${kept.length > 1 ? 's' : ''} sur le site ${kept.length > 1 ? 'sont conservées' : 'est conservée'}</b> : Claude ne les avait pas encore reçues. Pense à lui envoyer un export du site avec le prochain compte rendu.<ul>${items}${kept.length > 12 ? `<li>et ${kept.length - 12} autre(s)</li>` : ''}</ul></div>`;
  }

  let pending = null;
  async function onFile(file) {
    if (!file) return;
    let txt, parsed;
    try { txt = await file.text(); parsed = JSON.parse(txt); }
    catch (e) { modal(`<div class="sb-h"><h2 id="sbm-t">Importer la mise à jour</h2></div><div class="sb-b"><div class="sb-err">Ce fichier n'est pas lisible. Choisis le fichier .json envoyé par Claude.</div><div class="sb-act"><button data-sb="close">Fermer</button></div></div>`); return; }
    modal(`<div class="sb-h"><h2 id="sbm-t">Importer la mise à jour</h2><p>${esc(file.name)}</p></div><div class="sb-b"><div>Analyse du fichier…</div></div>`);
    try {
      const p = await api('import?mode=preview', {method: 'POST', body: txt});
      pending = {txt, name: file.name};
      const tot = Object.values(p.stats).reduce((a, s) => a + s.ajoutes + s.modifies + s.supprimes, 0);
      modal(`<div class="sb-h"><h2 id="sbm-t">Importer la mise à jour</h2><p>${esc(file.name)}${parsed.exportedAt ? ' · préparé par Claude le ' + fdt(parsed.exportedAt) : ''}</p></div>
        <div class="sb-b">
          <div>${tot ? `Voici ce qui va changer sur le site (${tot} élément${tot > 1 ? 's' : ''}).` : 'Le fichier ne change rien par rapport au site.'}</div>
          ${statsTable(p.stats)}
          ${keptBlock(p.kept)}
          <div class="sb-act"><button data-sb="close">Annuler</button><button class="go" data-sb="apply">Appliquer la mise à jour</button></div>
        </div>`);
    } catch (e) {
      modal(`<div class="sb-h"><h2 id="sbm-t">Importer la mise à jour</h2><p>${esc(file.name)}</p></div><div class="sb-b"><div class="sb-err">${esc(e.message)}</div><div class="sb-act"><button data-sb="close">Fermer</button></div></div>`);
    }
  }
  async function applyImport(btn) {
    if (!pending) return; btn.disabled = true; btn.textContent = 'Import en cours…';
    try {
      await api('import?mode=apply', {method: 'POST', body: pending.txt});
      pending = null; closeModal(); await refresh(true); toast('Mise à jour importée : le site est à jour');
    } catch (e) { btn.disabled = false; btn.textContent = 'Appliquer la mise à jour'; const b = document.querySelector('#sb-modal .sb-b'); if (b) b.insertAdjacentHTML('afterbegin', `<div class="sb-err">${esc(e.message)}</div>`); }
  }
  async function doExport(btn) {
    btn.disabled = true; const old = btn.textContent; btn.textContent = 'Export…';
    try {
      const r = await api('export', {raw: true});
      const blob = await r.blob();
      const m = /filename="([^"]+)"/.exec(r.headers.get('content-disposition') || ''); const name = m ? m[1] : 'nernier-export-site.json';
      const a = document.createElement('a'); a.href = URL.createObjectURL(blob); a.download = name; document.body.appendChild(a); a.click();
      setTimeout(() => { URL.revokeObjectURL(a.href); a.remove(); }, 1500);
      toast('Export téléchargé : envoie ce fichier à Claude avec le compte rendu');
    } catch (e) { toast(e.message); }
    btn.disabled = false; btn.textContent = old;
  }
  function askUndo() {
    const li = S.lastImport;
    modal(`<div class="sb-h"><h2 id="sbm-t">Annuler le dernier import</h2>${li ? `<p>Import du ${fdt(li.at)} par ${esc(li.by || '')}</p>` : ''}</div><div class="sb-b">
      <div>Le site reviendra exactement à son état d'avant cet import. Les commentaires et modifications faits sur le site depuis l'import seront aussi retirés.</div>
      <div class="sb-act"><button data-sb="close">Garder l'import</button><button class="dz" data-sb="undo-go">Revenir à l'état précédent</button></div></div>`);
  }
  async function doUndo(btn) {
    btn.disabled = true;
    try { await api('undo', {method: 'POST', body: '{}'}); closeModal(); await refresh(true); toast("Import annulé : le site est revenu à l'état précédent"); }
    catch (e) { btn.disabled = false; toast(e.message); }
  }

  document.addEventListener('click', e => {
    const b = e.target.closest('[data-sb]'); if (!b) return;
    switch (b.dataset.sb) {
      case 'export': doExport(b); break;
      case 'import': fileEl.value = ''; fileEl.click(); break;
      case 'apply': applyImport(b); break;
      case 'undo': askUndo(); break;
      case 'undo-go': doUndo(b); break;
      case 'close': pending = null; closeModal(); break;
      case 'logout': fetch('/api/logout', {method: 'POST', credentials: 'same-origin'}).finally(() => location.replace('/login')); break;
    }
  });

  document.addEventListener('DOMContentLoaded', () => {
    const st = document.createElement('style'); st.textContent = css; document.head.appendChild(st);
    barEl = document.createElement('div'); barEl.id = 'sitebar';
    document.body.insertBefore(barEl, document.body.firstChild);
    fileEl = document.createElement('input'); fileEl.type = 'file'; fileEl.accept = '.json,application/json'; fileEl.hidden = true; fileEl.id = 'sb-file';
    fileEl.addEventListener('change', () => onFile(fileEl.files && fileEl.files[0]));
    document.body.appendChild(fileEl);
    bar();
  });
})();
