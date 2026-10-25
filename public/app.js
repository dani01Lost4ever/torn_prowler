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

// ---------- estimate from Torn personal stats (fallback when FFScouter is unavailable) ----------
// Rough "energy put into the gym": xanax 250E, energy refill 150E, energy can ~20E (cans give 5-30E),
// LSD 50E, plus a quarter of the natural regen (480E/day) for every day played. Each stat enhancer
// adds 1%. The weights are guesses: tune them here. Gym, perks, education and bought stats are invisible.
const EST_WEIGHTS = { xanax: 250, refills: 150, cans: 20, lsd: 50, perDay: 120, sePct: 1 };
function trainingOf(ps, ageDays) {
  if (!ps || typeof ps !== 'object') return null;
  const n = (k) => Number(ps[k]) || 0;
  const W = EST_WEIGHTS;
  const t = { xanax: n('xantaken'), refills: n('refills'), cans: n('energydrinkused'), se: n('statenhancersused'), lsd: n('lsdtaken'), age: Number(ageDays) || 0, elo: ps.elo ?? null };
  t.energy = (t.xanax * W.xanax + t.refills * W.refills + t.cans * W.cans + t.lsd * W.lsd + t.age * W.perDay) * (1 + (t.se * W.sePct) / 100);
  return t;
}
const trainingText = (t) => `Xanax ${fmt(t.xanax)} · Refill ${fmt(t.refills)} · Cans ${fmt(t.cans)} · SE ${fmt(t.se)} · ${fmt(t.age)} gg`;
// Same gym efficiency as ours is assumed: stats scale with energy, and BSS with the square root of stats.
function estimateFromTraining(t) {
  const mine = state.me && state.me.training;
  t.bssEst = null; t.estRatio = null;
  if (!t.training || !mine || !mine.energy || !state.me.bss) return;
  t.estRatio = t.training.energy / mine.energy;
  t.bssEst = state.me.bss * Math.sqrt(t.estRatio);
}

// ---------- state ----------
const state = {
  key: '',
  me: null, // { name, level, bss, total, age, training }
  ffsReady: false,
  mode: 'ffs',
  searching: false,
  abort: false,
  targets: new Map(),
  sort: { key: 'respect', dir: -1 },
  ignored: new Set(store.get('ttf_ignored', [])),
};

// ---------- transport (direct first, falls back to our proxy on CORS/network failure) ----------
// FFScouter's Cloudflare 429s carry no CORS headers, so in the browser a rate limit looks exactly
// like a CORS failure. A single failed direct call must therefore not switch a target to the proxy
// for good: we only do that after several consecutive failures (never for FFScouter, whose CORS works).
const HOSTS = { torn: 'https://api.torn.com', ffs: 'https://ffscouter.com' };
const canProxy = location.protocol.startsWith('http');
const forceProxy = new URLSearchParams(location.search).has('proxy');
const useProxy = { torn: forceProxy, ffs: forceProxy };
const directFails = { torn: 0, ffs: 0 };
const STICKY_PROXY_AFTER = { torn: 3, ffs: Infinity };

// A request that never answers would hold a search worker forever: give up after 20s.
const FETCH_TIMEOUT_MS = 20000;
const timedFetch = (url, init) => fetch(url, { ...init, signal: AbortSignal.timeout(FETCH_TIMEOUT_MS) });

async function httpJson(target, path, init, attempt = 0) {
  let res;
  if (!useProxy[target]) {
    try {
      res = await timedFetch(HOSTS[target] + path, init);
      directFails[target] = 0;
    } catch (e) {
      if (!canProxy) {
        if (attempt < 2) return { status: 0, data: null, retryAfter: null };
        throw new Error('Impossibile contattare ' + HOSTS[target] + ' (CORS?). Avvia il sito con server.js.');
      }
      if (++directFails[target] >= STICKY_PROXY_AFTER[target]) useProxy[target] = true;
      // Probably a CORS-less rate limit: let the caller back off and retry direct before using the proxy.
      else if (attempt < 2) return { status: 0, data: null, retryAfter: null };
    }
  }
  if (!res) {
    try { res = await timedFetch('/proxy/' + target + path, init); } catch { return { status: 0, data: null, retryAfter: null }; }
  }
  let data = null;
  try { data = await res.json(); } catch { /* non-JSON body */ }
  return { status: res.status, data, retryAfter: Number(res.headers.get('retry-after')) || null };
}

class Limiter {
  constructor(max) { this.max = max; this.stamps = []; this.chain = Promise.resolve(); this.pausedUntil = 0; }
  used() { const t = Date.now(); this.stamps = this.stamps.filter((s) => t - s < 60000); return this.stamps.length; }
  // Stop every caller, not just the one that got the error, so they don't all hit the limit again.
  pause(ms) { this.pausedUntil = Math.max(this.pausedUntil, Date.now() + ms); }
  take() {
    const p = this.chain.then(async () => {
      for (;;) {
        if (Date.now() < this.pausedUntil) { await sleep(this.pausedUntil - Date.now()); continue; }
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
const TORN_FATAL = new Set([1, 2, 8, 9, 10, 13, 14, 16, 18]);
const KEY_HELP = 'Usa una key Limited (link qui sopra). La custom key creata per FFScouter mettila nel campo "Key FFScouter".';

async function torn(path, params = {}) {
  const qs = new URLSearchParams({ ...params, key: state.key, comment: 'Prowler' });
  for (let attempt = 0; ; attempt++) {
    await tornLimiter.take();
    const { status, data } = await httpJson('torn', `${path}?${qs}`, undefined, attempt);
    if (status === 0 && attempt < 4) { await sleep(2000 * (attempt + 1)); continue; }
    const err = data && data.error;
    if (!err && status < 400 && data) return data;
    const code = err ? err.code : null;
    const msg = code === 16
      ? `la key non ha il permesso "${params.selections || path}". ${KEY_HELP}`
      : err ? err.error : `HTTP ${status}`;
    // Code 5: over Torn's 100 calls/min, which counts every tool using your key (scripts, other sites, Torn pages).
    if (code === 5 && attempt < 5) {
      tornLimiter.pause(30000);
      setMsg('search-msg', 'Torn: troppe richieste sulla tua key (contano anche script e altri siti), pausa di 30s…');
      continue;
    }
    if (code === 17 && attempt < 2) { await sleep(2000); continue; }
    const e = new ApiError('Torn', code, msg);
    e.fatal = TORN_FATAL.has(code);
    throw e;
  }
}

// FFScouter answers overload with "429, Retry-After: 1" (Cloudflare, no CORS headers) and its own
// per-key limit with code 21 + retry_after_seconds. Back off briefly and grow the wait, rather than
// sleeping a flat 30s. Progress is shown in msgId so the connect step doesn't write in the search box.
const FFS_MAX_ATTEMPTS = 8;
async function ffs(path, params, limiter, method = 'GET', msgId = 'search-msg', maxAttempts = FFS_MAX_ATTEMPTS) {
  for (let attempt = 0; ; attempt++) {
    await limiter.take();
    let r;
    if (method === 'POST') {
      r = await httpJson('ffs', path, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(params) }, attempt);
    } else {
      r = await httpJson('ffs', `${path}?${new URLSearchParams(params)}`, undefined, attempt);
    }
    const d = r.data;
    if (r.status && r.status < 400 && d && !d.error) return d;
    const code = d ? (d.code ?? (d.error && d.error.code)) : null;
    const msg = d ? (typeof d.error === 'string' ? d.error : (d.error && d.error.error) || d.message || `HTTP ${r.status}`) : r.status ? `HTTP ${r.status}` : 'non raggiungibile';
    const limited = r.status === 0 || r.status === 429 || code === 21 || code === 429;
    if (limited && attempt < maxAttempts - 1) {
      const wait = Number(d && d.retry_after_seconds) || Math.min(20, Math.max(r.retryAfter || 1, 2 ** attempt));
      setMsg(msgId, `FFScouter occupato, riprovo tra ${wait}s (tentativo ${attempt + 2}/${maxAttempts})…`);
      await sleep(wait * 1000);
      continue;
    }
    const e = new ApiError('FFScouter', code, msg);
    e.limited = limited;
    throw e;
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

const SETTINGS = ['ff-min', 'ff-max', 'lvl-min', 'lvl-max', 'bss-max', 'hosp-within', 'ffs-rounds', 'ffs-inactive', 'ffs-factionless', 'faction-ids', 'auto-refresh', 'rate-limit', 'manual-bss', 'est-lvl-range', 'est-pages', 'est-days-max', 'est-factionless'];
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
  // FFScouter wins when we have it; otherwise fall back to the personal stats estimate.
  if (!t.bssPublic) estimateFromTraining(t);
  t.estimated = !t.bssPublic && !!t.bssEst;
  const bss = t.bssPublic || t.bssEst;
  if (bss && myBss) {
    t.ff = fairFight(bss, myBss);
    t.bssPct = (bss / myBss) * 100;
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
  if (p.age != null) t.age = p.age;
  if (p.personalstats) t.training = trainingOf(p.personalstats, t.age);
  t.checkedAt = Date.now();
  return t;
}

// personalstats rides along in the same call, so the estimate costs no extra Torn calls.
async function fetchProfile(id, withStats = false) {
  return torn(`/user/${id}`, { selections: withStats ? 'profile,personalstats' : 'profile' });
}
const needsEstimate = (t) => !t.bssPublic && t.ffsFF == null;

function upsert(t) {
  if (state.ignored.has(String(t.id))) return;
  state.targets.set(String(t.id), t);
  scheduleRender();
}

// ---------- connect ----------
// Custom keys (like the one FFScouter asks you to create) allow only some selections. Ask for
// everything in one call; on code 16 read basic alone and probe the others one by one.
async function readMe() {
  try {
    return { d: await torn('/user/', { selections: 'basic,profile,personalstats,battlestats' }), missing: [] };
  } catch (e) {
    if (e.code !== 16) throw e;
  }
  const d = await torn('/user/', { selections: 'basic' });
  const missing = [];
  for (const sel of ['profile', 'battlestats', 'personalstats']) {
    try { Object.assign(d, await torn('/user/', { selections: sel })); } catch (e) { if (e.code !== 16) throw e; missing.push(sel); }
  }
  return { d, missing };
}

async function connect() {
  const key = $('api-key').value.trim();
  if (!/^[A-Za-z0-9]{16}$/.test(key)) return setMsg('key-msg', 'La key deve essere di 16 caratteri alfanumerici.', 'error');
  const ffsKey = $('ffs-key').value.trim();
  if (ffsKey && !/^[A-Za-z0-9]{16}$/.test(ffsKey)) return setMsg('key-msg', 'Anche la key FFScouter deve essere di 16 caratteri alfanumerici.', 'error');
  state.key = key;
  state.ffsKey = ffsKey || key;
  if ($('remember-key').checked) { store.set('ttf_key', key); store.set('ttf_ffs_key', ffsKey); } else { store.del('ttf_key'); store.del('ttf_ffs_key'); }
  setMsg('key-msg', 'Connessione…');
  $('btn-connect').disabled = true;
  try {
    const { d, missing } = await readMe();
    const v = (x) => (x && typeof x === 'object' ? x.value : x) || 0;
    const stats = { strength: v(d.strength), defense: v(d.defense), speed: v(d.speed), dexterity: v(d.dexterity) };
    const hasStats = !missing.includes('battlestats');
    const me = {
      name: d.name, level: d.level, id: d.player_id,
      bss: hasStats ? bssOf(stats) : null, total: hasStats ? stats.strength + stats.defense + stats.speed + stats.dexterity : null,
      age: d.age, training: trainingOf(d.personalstats, d.age),
    };
    const manual = num('manual-bss');
    if (manual > 0) me.bss = manual;
    state.me = me;
    renderMe();
    await checkFfs();
    // Without "profile" we can't read anyone's status, so searching would only produce errors.
    if (missing.includes('profile')) {
      $('btn-search').disabled = true;
      $('btn-recheck').disabled = true;
      return setMsg('key-msg', `Connesso come ${me.name}, ma questa key non ha il permesso "profile", che serve per controllare lo stato dei target. ${KEY_HELP}`, 'error');
    }
    $('btn-search').disabled = false;
    $('btn-recheck').disabled = false;
    if (!me.bss) return setMsg('key-msg', `Connesso come ${me.name}. La key non può leggere le tue battle stats: inserisci il tuo BSS a mano oppure usa una key Limited.`, 'error');
    if (missing.includes('personalstats')) setMsg('key-msg', 'La key non può leggere le tue personal stats: la stima senza FFScouter non sarà disponibile.', 'error');
    if (!state.ffsReady && state.mode === 'ffs' && me.training) selectMode('est');
    const fallback = ' Uso la stima dalle personal stats (scheda "Stima senza FFScouter").';
    if (!missing.length) setMsg('key-msg', `Connesso come ${me.name}.${state.ffsReady ? '' : state.ffsDown ? ' FFScouter non risponde ora.' + fallback : ' Stime FFScouter non disponibili.' + fallback}`, state.ffsReady ? 'ok' : '');
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
  $('est-me').textContent = me.training ? `I tuoi valori: ${trainingText(me.training)}.` : 'Non riesco a leggere le tue personal stats: la stima non è disponibile.';
}

async function checkFfs() {
  try {
    // Few retries here: when FFScouter is down the personal stats estimate is ready to take over.
    const d = await ffs('/api/v1/check-key', { key: state.ffsKey }, ffsLimiters.misc, 'GET', 'key-msg', 3);
    state.ffsReady = !!d.is_registered;
    state.ffsDown = false;
    $('ffs-box').classList.toggle('hidden', state.ffsReady);
  } catch (e) {
    state.ffsReady = false;
    // Overloaded is not the same as "not registered": don't push the user to re-register.
    state.ffsDown = !!e.limited;
    $('ffs-box').classList.toggle('hidden', state.ffsDown);
    console.warn('FFScouter check-key failed', e);
  }
}

async function registerFfs() {
  if (!$('ffs-consent').checked) return setMsg('key-msg', 'Devi accettare la data policy di FFScouter.', 'error');
  try {
    await ffs('/api/v1/register', { key: state.ffsKey, agree_to_data_policy: true, signup_source: 'Prowler' }, ffsLimiters.misc, 'POST', 'key-msg');
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
// extra: an optional check on the fresh profile (e.g. account age), on top of status/level/estimate.
async function verifyAndAdd(cands, f, extra = () => true) {
  let added = 0, failed = 0, checked = 0;
  await runPool(cands, async (t) => {
    try {
      const p = await fetchProfile(t.id, needsEstimate(t));
      applyProfile(t, p);
      score(t);
      if (statusPasses(t.status, f.hospWithin) && levelPasses(t, f) && estimatePasses(t, f) && extra(t)) { upsert(t); added++; }
    } catch (e) {
      if (!e.fatal) failed++;
      throw e;
    } finally {
      const pause = Math.ceil((tornLimiter.pausedUntil - Date.now()) / 1000);
      setMsg('search-msg', `Controllati ${++checked}/${cands.length}, trovati ${added}${failed ? `, ${failed} non letti` : ''}…${pause > 0 ? ` Torn ha detto "troppe richieste": pausa di ${pause}s.` : ''}`);
    }
  });
  return added;
}

async function enrichWithStats(cands) {
  if (!state.ffsReady) return;
  for (let i = 0; i < cands.length && !state.abort; i += 200) {
    const batch = cands.slice(i, i + 200);
    const d = await ffs('/api/v1/get-stats', { key: state.ffsKey, targets: batch.map((t) => t.id).join(',') }, ffsLimiters.stats);
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
  if (!state.ffsReady && state.ffsDown) await checkFfs();
  if (!state.ffsReady) throw new Error(state.ffsDown ? 'FFScouter non risponde in questo momento, riprova tra poco.' : 'Per questa ricerca serve registrare la key su FFScouter (vedi sopra).');
  const rounds = Math.min(20, Math.max(1, num('ffs-rounds') || 1));
  const seen = new Map();
  for (let r = 0; r < rounds && !state.abort; r++) {
    setMsg('search-msg', `FFScouter: pagina ${r + 1}/${rounds}…`);
    let d;
    try {
      d = await ffs('/api/v1/get-targets', {
        key: state.ffsKey, minlevel: f.lvlMin, maxlevel: f.lvlMax,
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
  if (!state.ffsReady) {
    // No FFScouter: one Torn call per member (profile + personal stats) for the estimate.
    setMsg('search-msg', `${cands.length} membri attaccabili, stimo le stat dalle personal stats (1 chiamata ciascuno)…`);
    return verifyAndAdd(cands, f);
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

// Without FFScouter: Torn's own player search (v2 user/search, 25 per call) by level around ours,
// then one profile+personalstats call per candidate, which also checks the live status.
async function searchEst(f) {
  const me = state.me;
  if (!me.bss) throw new Error('Serve il tuo BSS (key Limited o inserito a mano) per confrontarti.');
  if (!me.training || !me.training.energy) throw new Error('Non riesco a leggere le tue personal stats, servono per il confronto.');
  const range = Math.max(0, num('est-lvl-range'));
  const lo = Math.max(f.lvlMin, me.level - range), hi = Math.min(f.lvlMax, me.level + range);
  if (lo > hi) throw new Error(`Nessun livello tra ${lo} e ${hi}: controlla livello min/max.`);
  const flt = [`level:>=:${lo}`, `level:<=:${hi}`, 'notTraveling', 'notInJail', 'notInFederalJail'];
  if (!f.hospWithin) flt.push('notInHospital');
  const maxDays = num('est-days-max');
  if (maxDays > 0) flt.push(`daysOld:<=:${Math.round(maxDays)}`);
  if ($('est-factionless').checked) flt.push('notInFaction');
  const pages = Math.min(20, Math.max(1, num('est-pages') || 1));
  const params = { filters: flt.join(',') };
  const seen = new Set();
  let added = 0;
  for (let r = 0; r < pages && !state.abort; r++) {
    setMsg('search-msg', `Torn: cerco giocatori di livello ${lo}-${hi}, pagina ${r + 1}/${pages}…`);
    const d = await torn('/v2/user/search', params);
    const cands = [];
    for (const x of d.search || []) {
      const id = String(x.id);
      if (id === String(me.id) || seen.has(id) || state.targets.has(id) || state.ignored.has(id)) continue;
      seen.add(id);
      cands.push({ id, name: x.name, level: x.level });
    }
    // Torn's search filters aren't always honoured (seen with daysOld), so check level and age on the profile too.
    added += await verifyAndAdd(cands, f, (t) => t.level >= lo && t.level <= hi && (!(maxDays > 0) || (t.age != null && t.age <= maxDays)));
    const next = d._metadata && d._metadata.links && d._metadata.links.next;
    if (!next || !(d.search || []).length) break;
    const cursor = new URL(next, HOSTS.torn).searchParams.get('cursor');
    if (cursor) params.cursor = cursor; else params.offset = (r + 1) * 25;
  }
  return added;
}

async function search() {
  if (state.searching) return;
  saveSettings();
  state.searching = true; state.abort = false;
  $('btn-search').disabled = true; $('btn-stop').disabled = false;
  const f = filters();
  try {
    const fn = { ffs: searchFfs, faction: searchFaction, ids: searchIds, est: searchEst }[state.mode];
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
    case 'bss': return t.bssPublic || t.bssEst || 0;
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
  const bss = t.bssPublic || t.bssEst;
  const est = t.estimated ? '~' : '';
  const estTitle = t.estimated && state.me.training
    ? ` title="${esc(`Stima dalle personal stats, non affidabile al 100%.\nTarget: ${trainingText(t.training)}\nTu: ${trainingText(state.me.training)}\nEnergia stimata: ${Math.round(t.estRatio * 100)}% della tua`)}"`
    : '';
  return `<tr data-id="${esc(t.id)}">
    <td class="name"><a href="https://www.torn.com/profiles.php?XID=${esc(t.id)}" target="_blank" rel="noopener">${esc(t.name || '?')}</a> <span class="muted">[${esc(t.id)}]</span>${t.faction ? `<span class="sub">${esc(t.faction)}</span>` : ''}</td>
    <td>${esc(t.level ?? '?')}</td>
    <td${estTitle}>${bss ? est + fmt(bss) : '?'}${t.estimated ? ' <span class="est-tag">stima</span>' : ''}<span class="sub">${pct != null ? `<span class="${pct <= 0 ? 'pos' : 'neg'}">${pct > 0 ? '+' : ''}${pct}%</span>` : ''}${t.bsHuman ? ` · ${esc(t.bsHuman)}` : ''}</span>${t.estimated ? `<span class="sub">${esc(trainingText(t.training))}</span>` : ''}</td>
    <td>${t.ff != null ? est + t.ff.toFixed(2) : '?'}</td>
    <td>${t.respect != null ? est + t.respect.toFixed(2) : '?'}</td>
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
function selectMode(mode) {
  state.mode = mode;
  document.querySelectorAll('.tab').forEach((x) => x.classList.toggle('active', x.dataset.mode === mode));
  document.querySelectorAll('.mode-panel').forEach((p) => p.classList.toggle('hidden', p.dataset.mode !== mode));
}

function init() {
  loadSettings();
  const saved = store.get('ttf_key', '');
  if (saved) { $('api-key').value = saved; $('remember-key').checked = true; $('ffs-key').value = store.get('ttf_ffs_key', ''); }

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

  document.querySelectorAll('.tab').forEach((b) => { b.onclick = () => selectMode(b.dataset.mode); });

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
    const pause = Math.ceil((tornLimiter.pausedUntil - Date.now()) / 1000);
    $('rate-used').textContent = tornLimiter.used() + (pause > 0 ? ` (pausa ${pause}s)` : '');
    if ([...state.targets.values()].some((t) => t.status && t.status.state === 'Hospital')) scheduleRender();
  }, 1000);
  // Auto re-check the top 30 targets every minute.
  setInterval(() => {
    if ($('auto-refresh').checked && !state.searching && state.targets.size) recheck(30);
  }, 60000);

  $('auto-refresh').onchange = saveSettings;
}

init();
