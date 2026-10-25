'use strict';

// ---------- helpers ----------
const $ = (id) => document.getElementById(id);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const nowSec = () => Math.floor(Date.now() / 1000);
const fmt = (n) => (n == null || isNaN(n) ? '?' : Math.round(n).toLocaleString('it-IT'));
const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const store = {
  get(k, d) { try { const v = localStorage.getItem(k); return v == null ? d : JSON.parse(v); } catch { return d; } },
  set(k, v) { try { localStorage.setItem(k, JSON.stringify(v)); } catch { /* storage unavailable */ } },
  del(k) { try { localStorage.removeItem(k); } catch { /* storage unavailable */ } },
};

// ---------- fair fight math ----------
// BSS = sum of square roots of the four battle stats.
const bssOf = (s) => ['strength', 'defense', 'speed', 'dexterity'].reduce((a, k) => a + Math.sqrt(Math.max(0, s[k] || 0)), 0);
// FF = 1 + 8/3 * (defender BSS / attacker BSS), clamped to [1, 3].
const fairFight = (targetBss, myBss) => Math.min(3, Math.max(1, 1 + (8 / 3) * (targetBss / myBss)));
// Base respect per level (Torn wiki, Chain page) times FF.
const baseRespect = (level) => Math.round(((level + 197) / 198) * 100) / 100;

// ---------- state ----------
const state = {
  key: '',
  me: null, // { name, level, bss, total }
  ffsReady: false,
  mode: 'ffs',
  searching: false,
  abort: false,
  targets: new Map(),
  sort: { key: 'respect', dir: -1 },
  ignored: new Set(store.get('ttf_ignored', [])),
};

// ---------- transport (direct first, falls back to our proxy on CORS/network failure) ----------
const HOSTS = { torn: 'https://api.torn.com', ffs: 'https://ffscouter.com' };
const canProxy = location.protocol.startsWith('http');
const forceProxy = new URLSearchParams(location.search).has('proxy');
const useProxy = { torn: forceProxy, ffs: forceProxy };

async function httpJson(target, path, init) {
  let res;
  if (!useProxy[target]) {
    try {
      res = await fetch(HOSTS[target] + path, init);
    } catch (e) {
      if (!canProxy) throw new Error('Impossibile contattare ' + HOSTS[target] + ' (CORS?). Avvia il sito con server.js.');
      useProxy[target] = true;
    }
  }
  if (!res) res = await fetch('/proxy/' + target + path, init);
  let data = null;
  try { data = await res.json(); } catch { /* non-JSON body */ }
  return { status: res.status, data };
}

class Limiter {
  constructor(max) { this.max = max; this.stamps = []; this.chain = Promise.resolve(); }
  used() { const t = Date.now(); this.stamps = this.stamps.filter((s) => t - s < 60000); return this.stamps.length; }
  take() {
    const p = this.chain.then(async () => {
      for (;;) {
        if (this.used() < this.max) { this.stamps.push(Date.now()); return; }
        await sleep(60000 - (Date.now() - this.stamps[0]) + 50);
      }
    });
    this.chain = p.catch(() => {});
    return p;
  }
}
const tornLimiter = new Limiter(60);
const ffsLimiters = { targets: new Limiter(20), stats: new Limiter(100), misc: new Limiter(15) };

class ApiError extends Error {
  constructor(src, code, msg) { super(`${src}: ${msg}${code != null ? ` (codice ${code})` : ''}`); this.src = src; this.code = code; }
}
const TORN_FATAL = new Set([1, 2, 8, 9, 10, 13, 14, 18]);

async function torn(path, params = {}) {
  const qs = new URLSearchParams({ ...params, key: state.key, comment: 'Prowler' });
  for (let attempt = 0; ; attempt++) {
    await tornLimiter.take();
    const { status, data } = await httpJson('torn', `${path}?${qs}`);
    const err = data && data.error;
    if (!err && status < 400 && data) return data;
    const code = err ? err.code : null;
    const msg = err ? err.error : `HTTP ${status}`;
    if (code === 5 && attempt < 3) { setMsg('search-msg', 'Torn: troppe richieste, attendo 30s…'); await sleep(30000); continue; }
    if (code === 17 && attempt < 2) { await sleep(2000); continue; }
    const e = new ApiError('Torn', code, msg);
    e.fatal = TORN_FATAL.has(code);
    throw e;
  }
}

async function ffs(path, params, limiter, method = 'GET') {
  for (let attempt = 0; ; attempt++) {
    await limiter.take();
    let r;
    if (method === 'POST') {
      r = await httpJson('ffs', path, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(params) });
    } else {
      r = await httpJson('ffs', `${path}?${new URLSearchParams(params)}`);
    }
    const d = r.data;
    if (r.status < 400 && d && !d.error) return d;
    const code = d ? (d.code ?? (d.error && d.error.code)) : null;
    const msg = d ? (typeof d.error === 'string' ? d.error : (d.error && d.error.error) || d.message || `HTTP ${r.status}`) : `HTTP ${r.status}`;
    if ((r.status === 429 || code === 21) && attempt < 3) {
      const wait = Number(d && d.retry_after_seconds) || 30;
      setMsg('search-msg', `FFScouter: limite raggiunto, attendo ${wait}s…`);
      await sleep(wait * 1000);
      continue;
    }
    throw new ApiError('FFScouter', code, msg);
  }
}

// ---------- UI helpers ----------
function setMsg(id, text, kind = '') { const el = $(id); el.textContent = text; el.className = 'msg ' + kind; }
const num = (id) => Number($(id).value);
function filters() {
  return {
    ffMin: num('ff-min') || 1, ffMax: num('ff-max') || 3,
    lvlMin: num('lvl-min') || 1, lvlMax: num('lvl-max') || 100,
    bssMax: num('bss-max') || 0, hospWithin: num('hosp-within') || 0,
  };
}
function progress(done, total) {
  $('progress').classList.toggle('hidden', !total);
  $('progress-bar').style.width = total ? `${Math.round((done / total) * 100)}%` : '0';
}

const SETTINGS = ['ff-min', 'ff-max', 'lvl-min', 'lvl-max', 'bss-max', 'hosp-within', 'ffs-rounds', 'ffs-inactive', 'ffs-factionless', 'faction-ids', 'auto-refresh', 'rate-limit', 'manual-bss'];
function saveSettings() {
  const s = {};
  for (const id of SETTINGS) { const el = $(id); s[id] = el.type === 'checkbox' ? el.checked : el.value; }
  store.set('ttf_settings', s);
}
function loadSettings() {
  const s = store.get('ttf_settings', {});
  for (const id of SETTINGS) {
    if (!(id in s)) continue;
    const el = $(id);
    if (el.type === 'checkbox') el.checked = s[id]; else el.value = s[id];
  }
}

// ---------- status logic ----------
const isAbroadHospital = (st) => /^in an? \S+ hospital/i.test(st.description || '');
function statusPasses(st, hospWithin) {
  if (!st) return false;
  if (st.state === 'Okay') return true;
  if (st.state === 'Hospital' && hospWithin > 0 && !isAbroadHospital(st)) return (st.until || 0) - nowSec() <= hospWithin * 60;
  return false;
}

// Fill FF / respect / bss% on a target from whatever estimate we have.
function score(t) {
  const myBss = state.me && state.me.bss;
  if (t.bssPublic && myBss) {
    t.ff = fairFight(t.bssPublic, myBss);
    t.bssPct = (t.bssPublic / myBss) * 100;
  } else {
    t.ff = t.ffsFF ?? null;
    t.bssPct = null;
  }
  t.respect = t.ff && t.level ? baseRespect(t.level) * t.ff : null;
  return t;
}
function estimatePasses(t, f) {
  if (t.ff == null) return !state.ffsReady; // no estimate available: only keep if we can't estimate at all
  if (t.ff < f.ffMin - 1e-9 || t.ff > f.ffMax + 1e-9) return false;
  if (f.bssMax && t.bssPct != null && t.bssPct > f.bssMax) return false;
  return true;
}
const levelPasses = (t, f) => !t.level || (t.level >= f.lvlMin && t.level <= f.lvlMax);

// Apply a Torn v1 profile / faction member to a target.
function applyProfile(t, p) {
  t.name = p.name || t.name;
  t.level = p.level || t.level;
  t.status = p.status;
  t.lastAction = p.last_action;
  if (p.faction && p.faction.faction_name && p.faction.faction_name !== 'None') t.faction = p.faction.faction_name;
  t.checkedAt = Date.now();
  return t;
}

async function fetchProfile(id) {
  return torn(`/user/${id}`, { selections: 'profile' });
}

function upsert(t) {
  if (state.ignored.has(String(t.id))) return;
  state.targets.set(String(t.id), t);
  scheduleRender();
}

// ---------- connect ----------
async function connect() {
  const key = $('api-key').value.trim();
  if (!/^[A-Za-z0-9]{16}$/.test(key)) return setMsg('key-msg', 'La key deve essere di 16 caratteri alfanumerici.', 'error');
  state.key = key;
  if ($('remember-key').checked) store.set('ttf_key', key); else store.del('ttf_key');
  setMsg('key-msg', 'Connessione…');
  $('btn-connect').disabled = true;
  try {
    let me;
    try {
      const d = await torn('/user/', { selections: 'basic,battlestats' });
      const v = (x) => (x && typeof x === 'object' ? x.value : x) || 0;
      const stats = { strength: v(d.strength), defense: v(d.defense), speed: v(d.speed), dexterity: v(d.dexterity) };
      me = { name: d.name, level: d.level, id: d.player_id, bss: bssOf(stats), total: stats.strength + stats.defense + stats.speed + stats.dexterity };
    } catch (e) {
      if (e.code !== 16) throw e;
      const d = await torn('/user/', { selections: 'basic' });
      me = { name: d.name, level: d.level, id: d.player_id, bss: null, total: null };
      setMsg('key-msg', 'La key non ha accesso alle battle stats (serve Limited). Inserisci il tuo BSS a mano.', 'error');
    }
    const manual = num('manual-bss');
    if (manual > 0) me.bss = manual;
    state.me = me;
    renderMe();
    await checkFfs();
    $('btn-search').disabled = false;
    $('btn-recheck').disabled = false;
    if (me.bss) setMsg('key-msg', `Connesso come ${me.name}.${state.ffsReady ? '' : ' Stime FFScouter non disponibili.'}`, state.ffsReady ? 'ok' : '');
  } catch (e) {
    setMsg('key-msg', e.message, 'error');
  } finally {
    $('btn-connect').disabled = false;
  }
}

function renderMe() {
  const me = state.me;
  $('me').classList.remove('hidden');
  $('me-name').textContent = me.name;
  $('me-level').textContent = me.level;
  $('me-bss').textContent = fmt(me.bss);
  $('me-total').textContent = fmt(me.total);
}

async function checkFfs() {
  try {
    const d = await ffs('/api/v1/check-key', { key: state.key }, ffsLimiters.misc);
    state.ffsReady = !!d.is_registered;
    $('ffs-box').classList.toggle('hidden', state.ffsReady);
  } catch (e) {
    state.ffsReady = false;
    $('ffs-box').classList.remove('hidden');
    console.warn('FFScouter check-key failed', e);
  }
}

async function registerFfs() {
  if (!$('ffs-consent').checked) return setMsg('key-msg', 'Devi accettare la data policy di FFScouter.', 'error');
  try {
    await ffs('/api/v1/register', { key: state.key, agree_to_data_policy: true, signup_source: 'Prowler' }, ffsLimiters.misc, 'POST');
    await checkFfs();
    setMsg('key-msg', state.ffsReady ? 'Key registrata su FFScouter.' : 'Registrazione inviata, ma la key non risulta ancora registrata.', state.ffsReady ? 'ok' : 'error');
  } catch (e) {
    setMsg('key-msg', e.message + ' Puoi registrarti anche da ffscouter.com.', 'error');
  }
}

// ---------- search ----------
async function runPool(items, worker, concurrency = 4) {
  let i = 0, done = 0;
  progress(0, items.length);
  const next = async () => {
    while (i < items.length && !state.abort) {
      const item = items[i++];
      try { await worker(item); } catch (e) { if (e.fatal) { state.abort = true; throw e; } console.warn(e); }
      progress(++done, items.length);
    }
  };
  await Promise.all(Array.from({ length: concurrency }, next));
}

// Verify candidates with live Torn status, then add the ones that pass.
async function verifyAndAdd(cands, f) {
  let added = 0;
  await runPool(cands, async (t) => {
    const p = await fetchProfile(t.id);
    applyProfile(t, p);
    score(t);
    if (statusPasses(t.status, f.hospWithin) && levelPasses(t, f) && estimatePasses(t, f)) { upsert(t); added++; }
    setMsg('search-msg', `Controllati ${cands.indexOf(t) + 1}/${cands.length}, trovati ${added}…`);
  });
  return added;
}

async function enrichWithStats(cands) {
  if (!state.ffsReady) return;
  for (let i = 0; i < cands.length && !state.abort; i += 200) {
    const batch = cands.slice(i, i + 200);
    const d = await ffs('/api/v1/get-stats', { key: state.key, targets: batch.map((t) => t.id).join(',') }, ffsLimiters.stats);
    const byId = new Map((Array.isArray(d) ? d : d.data || []).map((s) => [String(s.player_id), s]));
    for (const t of batch) {
      const s = byId.get(String(t.id));
      if (!s) continue;
      t.bssPublic = s.bss_public ?? null;
      t.ffsFF = s.fair_fight ?? null;
      t.bsHuman = s.bs_estimate_human ?? null;
    }
  }
}

async function searchFfs(f) {
  if (!state.ffsReady) throw new Error('Per questa ricerca serve registrare la key su FFScouter (vedi sopra).');
  const rounds = Math.min(20, Math.max(1, num('ffs-rounds') || 1));
  const seen = new Map();
  for (let r = 0; r < rounds && !state.abort; r++) {
    setMsg('search-msg', `FFScouter: pagina ${r + 1}/${rounds}…`);
    let d;
    try {
      d = await ffs('/api/v1/get-targets', {
        key: state.key, minlevel: f.lvlMin, maxlevel: f.lvlMax,
        minff: f.ffMin.toFixed(2), maxff: f.ffMax.toFixed(2),
        inactiveonly: $('ffs-inactive').checked ? 1 : 0,
        factionless: $('ffs-factionless').checked ? 1 : 0,
        limit: 50,
      }, ffsLimiters.targets);
    } catch (e) {
      if (e.code === 17) break; // no matches
      throw e;
    }
    let fresh = 0;
    for (const x of d.targets || []) {
      const id = String(x.player_id);
      if (seen.has(id) || state.targets.has(id) || state.ignored.has(id)) continue;
      fresh++;
      seen.set(id, {
        id, name: x.name, level: x.level, bssPublic: x.bss_public ?? null, ffsFF: x.fair_fight ?? null,
        bsHuman: x.bs_estimate_human ?? null, hospitalUntil: x.hospital_until || 0,
      });
    }
    if (!fresh) break; // FFScouter returned the same page again
  }
  // Skip the ones FFScouter already knows are in hospital for too long; saves Torn calls.
  const limit = nowSec() + f.hospWithin * 60;
  const cands = [...seen.values()]
    .filter((t) => { const u = t.hospitalUntil > 1e12 ? t.hospitalUntil / 1000 : t.hospitalUntil; return !u || u <= limit; })
    .map(score)
    .filter((t) => levelPasses(t, f) && estimatePasses(t, f))
    .sort((a, b) => (b.respect || 0) - (a.respect || 0));
  setMsg('search-msg', `${seen.size} candidati da FFScouter, ${cands.length} da controllare su Torn…`);
  return verifyAndAdd(cands, f);
}

async function searchFaction(f) {
  const ids = $('faction-ids').value.split(/[\s,;]+/).filter((x) => /^\d+$/.test(x));
  if (!ids.length) throw new Error('Inserisci almeno un ID faction.');
  const cands = [];
  for (const fid of ids) {
    if (state.abort) break;
    setMsg('search-msg', `Leggo la faction ${fid}…`);
    const d = await torn(`/faction/${fid}`, { selections: 'basic' });
    const members = Array.isArray(d.members) ? d.members.map((m) => [m.id, m]) : Object.entries(d.members || {});
    for (const [id, m] of members) {
      if (String(id) === String(state.me.id) || state.ignored.has(String(id))) continue;
      const t = applyProfile({ id: String(id) }, m);
      t.faction = d.name || d.tag || '';
      if (statusPasses(t.status, f.hospWithin) && levelPasses(t, f)) cands.push(t);
    }
  }
  setMsg('search-msg', `${cands.length} membri attaccabili, stimo le stat…`);
  await enrichWithStats(cands);
  let added = 0;
  for (const t of cands) { score(t); if (estimatePasses(t, f)) { upsert(t); added++; } }
  return added;
}

async function searchIds(f) {
  const ids = [...new Set($('player-ids').value.split(/[\s,;]+/).filter((x) => /^\d+$/.test(x)))];
  if (!ids.length) throw new Error('Inserisci almeno un ID giocatore.');
  const cands = ids.filter((id) => !state.ignored.has(id)).map((id) => ({ id }));
  await enrichWithStats(cands);
  // Level isn't known yet, so only the FF filter can run before the Torn calls.
  const pre = cands.filter((t) => { score(t); return t.ff == null || estimatePasses(t, f); });
  return verifyAndAdd(pre, f);
}

async function search() {
  if (state.searching) return;
  saveSettings();
  state.searching = true; state.abort = false;
  $('btn-search').disabled = true; $('btn-stop').disabled = false;
  const f = filters();
  try {
    const fn = { ffs: searchFfs, faction: searchFaction, ids: searchIds }[state.mode];
    const added = await fn(f);
    setMsg('search-msg', state.abort ? 'Ricerca interrotta.' : `Fatto: ${added} nuovi target.`, 'ok');
  } catch (e) {
    setMsg('search-msg', e.message, 'error');
  } finally {
    state.searching = false;
    $('btn-search').disabled = false; $('btn-stop').disabled = true;
    progress(0, 0);
  }
}

// Re-check live status; drop the ones that are no longer attackable.
let rechecking = false;
async function recheck(limit) {
  if (rechecking || !state.key) return;
  rechecking = true;
  const f = filters();
  const list = sortedTargets().slice(0, limit || Infinity);
  let removed = 0;
  try {
    await runPool(list, async (t) => {
      const p = await fetchProfile(t.id);
      applyProfile(t, p);
      score(t);
      if (!statusPasses(t.status, f.hospWithin)) { state.targets.delete(String(t.id)); removed++; }
      scheduleRender();
    }, 3);
    if (!state.searching) setMsg('search-msg', `Ricontrollati ${list.length} target${removed ? `, rimossi ${removed} non più attaccabili` : ''}.`);
  } catch (e) {
    setMsg('search-msg', e.message, 'error');
  } finally {
    rechecking = false;
    if (!state.searching) progress(0, 0);
  }
}

// ---------- rendering ----------
const STATUS_RANK = { Okay: 0, Hospital: 1 };
function sortValue(t, k) {
  switch (k) {
    case 'name': return (t.name || '').toLowerCase();
    case 'bss': return t.bssPublic || 0;
    case 'status': return (STATUS_RANK[t.status && t.status.state] ?? 2) * 1e10 + ((t.status && t.status.until) || 0);
    case 'lastAction': return (t.lastAction && t.lastAction.timestamp) || 0;
    default: return t[k] ?? -Infinity;
  }
}
function sortedTargets() {
  const { key, dir } = state.sort;
  return [...state.targets.values()].sort((a, b) => {
    const x = sortValue(a, key), y = sortValue(b, key);
    return x < y ? -dir : x > y ? dir : 0;
  });
}

function countdown(until) {
  const s = Math.max(0, until - nowSec());
  const h = Math.floor(s / 3600), m = Math.floor((s % 3600) / 60), sec = s % 60;
  return (h ? `${h}:` : '') + `${String(m).padStart(2, '0')}:${String(sec).padStart(2, '0')}`;
}

function rowHtml(t) {
  const st = t.status || {};
  const cls = st.state === 'Okay' ? 'st-okay' : st.state === 'Hospital' ? 'st-hospital' : 'st-other';
  const stText = st.state === 'Hospital' ? `In ospedale (${countdown(st.until)})` : esc(st.state || '?');
  const pct = t.bssPct != null ? Math.round(t.bssPct - 100) : null;
  const la = t.lastAction || {};
  return `<tr data-id="${esc(t.id)}">
    <td class="name"><a href="https://www.torn.com/profiles.php?XID=${esc(t.id)}" target="_blank" rel="noopener">${esc(t.name || '?')}</a> <span class="muted">[${esc(t.id)}]</span>${t.faction ? `<span class="sub">${esc(t.faction)}</span>` : ''}</td>
    <td>${esc(t.level ?? '?')}</td>
    <td>${t.bssPublic ? fmt(t.bssPublic) : '?'}<span class="sub">${pct != null ? `<span class="${pct <= 0 ? 'pos' : 'neg'}">${pct > 0 ? '+' : ''}${pct}%</span>` : ''}${t.bsHuman ? ` · ${esc(t.bsHuman)}` : ''}</span></td>
    <td>${t.ff != null ? t.ff.toFixed(2) : '?'}</td>
    <td>${t.respect != null ? t.respect.toFixed(2) : '?'}</td>
    <td class="${cls}">${stText}${st.description && st.state !== 'Okay' ? `<span class="sub">${esc(st.description)}</span>` : ''}</td>
    <td>${esc(la.relative || '?')}<span class="sub">${esc(la.status || '')}</span></td>
    <td><div class="actions">
      <a class="attack" href="https://www.torn.com/loader.php?sid=attack&user2ID=${esc(t.id)}" target="_blank" rel="noopener">Attacca</a>
      <button data-act="recheck" title="Ricontrolla stato">↻</button>
      <button data-act="ignore" title="Nascondi questo giocatore">✕</button>
    </div></td>
  </tr>`;
}

let renderQueued = false;
function scheduleRender() {
  if (renderQueued) return;
  renderQueued = true;
  requestAnimationFrame(() => { renderQueued = false; render(); });
}
function render() {
  const list = sortedTargets();
  document.querySelector('#results tbody').innerHTML = list.map(rowHtml).join('');
  $('empty').classList.toggle('hidden', list.length > 0);
  $('count').textContent = list.length ? `(${list.length})` : '';
  document.querySelectorAll('#results th[data-sort]').forEach((th) => {
    th.classList.toggle('sorted', th.dataset.sort === state.sort.key);
    th.classList.toggle('asc', th.dataset.sort === state.sort.key && state.sort.dir === 1);
  });
}

// ---------- wiring ----------
function init() {
  loadSettings();
  const saved = store.get('ttf_key', '');
  if (saved) { $('api-key').value = saved; $('remember-key').checked = true; }

  $('btn-connect').onclick = connect;
  $('api-key').onkeydown = (e) => { if (e.key === 'Enter') connect(); };
  $('btn-ffs-register').onclick = registerFfs;
  $('btn-search').onclick = search;
  $('btn-stop').onclick = () => { state.abort = true; };
  $('btn-recheck').onclick = () => recheck();
  $('btn-clear-ignored').onclick = () => { state.ignored.clear(); store.set('ttf_ignored', []); setMsg('search-msg', 'Lista ignorati svuotata.'); };
  $('manual-bss').onchange = () => {
    if (!state.me) return;
    const v = num('manual-bss');
    if (v > 0) state.me.bss = v;
    renderMe();
    state.targets.forEach(score);
    scheduleRender();
  };
  $('rate-limit').onchange = () => {
    tornLimiter.max = Math.min(60, Math.max(10, num('rate-limit') || 60));
    $('rate-limit').value = tornLimiter.max;
    $('rate-max').textContent = tornLimiter.max;
    saveSettings();
  };
  $('rate-limit').onchange();

  document.querySelectorAll('.tab').forEach((b) => {
    b.onclick = () => {
      state.mode = b.dataset.mode;
      document.querySelectorAll('.tab').forEach((x) => x.classList.toggle('active', x === b));
      document.querySelectorAll('.mode-panel').forEach((p) => p.classList.toggle('hidden', p.dataset.mode !== state.mode));
    };
  });

  document.querySelectorAll('#results th[data-sort]').forEach((th) => {
    th.onclick = () => {
      const k = th.dataset.sort;
      state.sort = { key: k, dir: state.sort.key === k ? -state.sort.dir : (k === 'name' || k === 'status' ? 1 : -1) };
      render();
    };
  });

  document.querySelector('#results tbody').onclick = async (e) => {
    const btn = e.target.closest('button[data-act]');
    if (!btn) return;
    const id = btn.closest('tr').dataset.id;
    const t = state.targets.get(id);
    if (!t) return;
    if (btn.dataset.act === 'ignore') {
      state.ignored.add(id);
      store.set('ttf_ignored', [...state.ignored]);
      state.targets.delete(id);
      render();
    } else {
      btn.disabled = true;
      try {
        applyProfile(t, await fetchProfile(id));
        score(t);
        if (!statusPasses(t.status, filters().hospWithin)) state.targets.delete(id);
      } catch (err) { setMsg('search-msg', err.message, 'error'); }
      render();
    }
  };

  // Rate counter + hospital countdowns, once a second.
  setInterval(() => {
    $('rate-used').textContent = tornLimiter.used();
    if ([...state.targets.values()].some((t) => t.status && t.status.state === 'Hospital')) scheduleRender();
  }, 1000);
  // Auto re-check the top 30 targets every minute.
  setInterval(() => {
    if ($('auto-refresh').checked && !state.searching && state.targets.size) recheck(30);
  }, 60000);

  $('auto-refresh').onchange = saveSettings;
}

init();
