// Prowler's database: the attacks Prowler users made and what they tell us about the targets.
// Uses Node's built-in SQLite (node:sqlite), so there are still no npm dependencies.
// API keys are never written here: the key only lives for the duration of one request.
const fs = require('fs');
const path = require('path');

// node:sqlite is still "experimental" in Node 22 and prints a warning on load: keep the logs clean.
const emit = process.emitWarning;
process.emitWarning = (w, ...a) => (String(w).includes('SQLite') ? undefined : emit.call(process, w, ...a));
const { DatabaseSync } = require('node:sqlite');
process.emitWarning = emit;

const DB_PATH = process.env.DB_PATH || path.join(__dirname, 'data', 'prowler.db');
fs.mkdirSync(path.dirname(DB_PATH), { recursive: true });
const db = new DatabaseSync(DB_PATH);
db.exec(`
  PRAGMA journal_mode = WAL;
  PRAGMA busy_timeout = 5000;
  -- One row per outgoing attack of a Prowler user. Only returned to the attacker himself.
  CREATE TABLE IF NOT EXISTS attacks (
    id INTEGER PRIMARY KEY,
    code TEXT,
    attacker_id INTEGER NOT NULL,
    defender_id INTEGER NOT NULL,
    started INTEGER,
    ended INTEGER NOT NULL,
    result TEXT,
    respect REAL,
    fair_fight REAL,
    modifiers TEXT
  );
  CREATE INDEX IF NOT EXISTS attacks_attacker ON attacks (attacker_id, ended);
  CREATE INDEX IF NOT EXISTS attacks_defender ON attacks (defender_id, ended);
  -- Everyone who has been attacked through Prowler. bss is derived from the real fair fight:
  -- bss_kind 'eq' = exact (1 < FF < 3), 'min' = at least this much (FF capped at 3).
  CREATE TABLE IF NOT EXISTS players (
    id INTEGER PRIMARY KEY,
    name TEXT,
    level INTEGER,
    faction TEXT,
    bss REAL,
    bss_kind TEXT,
    bss_at INTEGER,
    attacked_at INTEGER,
    attacks INTEGER NOT NULL DEFAULT 0
  );
  CREATE INDEX IF NOT EXISTS players_level ON players (level);
  -- Last attack read for each Prowler user, so the next sync only asks Torn for newer ones.
  CREATE TABLE IF NOT EXISTS sync_state (
    player_id INTEGER PRIMARY KEY,
    last_ended INTEGER NOT NULL DEFAULT 0,
    synced_at INTEGER NOT NULL DEFAULT 0
  );
`);

// Results where the fight actually happened, so fair_fight reflects the two stat totals.
const WON = new Set(['Attacked', 'Mugged', 'Hospitalized', 'Arrested', 'Looted', 'Special', 'Bounty']);

// FF = 1 + 8/3 * (target BSS / attacker BSS), capped at 3: invert it.
function bssFromFairFight(ff, attackerBss) {
  if (!(ff > 1) || !(attackerBss > 0)) return null;
  if (ff >= 2.995) return { bss: attackerBss * 0.75, kind: 'min' };
  return { bss: ((ff - 1) * 3 / 8) * attackerBss, kind: 'eq' };
}

const q = {
  insertAttack: db.prepare(`INSERT OR IGNORE INTO attacks (id, code, attacker_id, defender_id, started, ended, result, respect, fair_fight, modifiers)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`),
  upsertPlayer: db.prepare(`INSERT INTO players (id, name, level, faction, attacked_at, attacks) VALUES (?, ?, ?, ?, ?, 1)
    ON CONFLICT (id) DO UPDATE SET
      name = excluded.name, level = COALESCE(excluded.level, level), faction = excluded.faction,
      attacked_at = MAX(COALESCE(attacked_at, 0), excluded.attacked_at), attacks = attacks + 1`),
  // A newer reading wins, except that an exact value is not replaced by a lower bound from the same day.
  setBss: db.prepare(`UPDATE players SET bss = ?, bss_kind = ?, bss_at = ?
    WHERE id = ? AND (bss_at IS NULL OR ? > bss_at + CASE WHEN bss_kind = 'eq' AND ? = 'min' THEN 86400 ELSE 0 END)`),
  getSync: db.prepare('SELECT last_ended, synced_at FROM sync_state WHERE player_id = ?'),
  setSync: db.prepare(`INSERT INTO sync_state (player_id, last_ended, synced_at) VALUES (?, ?, ?)
    ON CONFLICT (player_id) DO UPDATE SET last_ended = MAX(last_ended, excluded.last_ended), synced_at = excluded.synced_at`),
  myAttacks: db.prepare(`SELECT a.defender_id, p.name, p.level, a.ended, a.result, a.respect, a.fair_fight
    FROM attacks a LEFT JOIN players p ON p.id = a.defender_id WHERE a.attacker_id = ? ORDER BY a.ended DESC LIMIT ?`),
  myCount: db.prepare('SELECT COUNT(*) n FROM attacks WHERE attacker_id = ?'),
};

// Store the outgoing attacks of `attackerId` (Torn v2 user/attacks format). Returns how many were new.
function saveAttacks(attackerId, attackerBss, attacks) {
  let added = 0, lastEnded = 0;
  db.exec('BEGIN');
  try {
    for (const a of attacks) {
      if (!a || !a.attacker || Number(a.attacker.id) !== Number(attackerId) || !a.defender) continue;
      lastEnded = Math.max(lastEnded, a.ended || 0);
      const ff = a.modifiers && Number(a.modifiers.fair_fight);
      const r = q.insertAttack.run(a.id, a.code || null, attackerId, a.defender.id, a.started || null, a.ended || 0, a.result || null,
        a.respect_gain ?? null, Number.isFinite(ff) ? ff : null, a.modifiers ? JSON.stringify(a.modifiers) : null);
      if (!r.changes) continue;
      added++;
      const d = a.defender;
      q.upsertPlayer.run(d.id, d.name || null, d.level || null, (d.faction && d.faction.name) || null, a.ended || 0);
      const est = WON.has(a.result) ? bssFromFairFight(ff, attackerBss) : null;
      if (est) q.setBss.run(est.bss, est.kind, a.ended, d.id, a.ended, est.kind);
    }
    q.setSync.run(attackerId, lastEnded, Math.floor(Date.now() / 1000));
    db.exec('COMMIT');
  } catch (e) {
    db.exec('ROLLBACK');
    throw e;
  }
  return added;
}

const syncState = (id) => q.getSync.get(id) || { last_ended: 0, synced_at: 0 };
const myAttacks = (id, limit = 500) => ({ total: q.myCount.get(id).n, attacks: q.myAttacks.all(id, limit) });

// What we know about these players (any Prowler user's attacks). Never says who attacked them.
function players(ids) {
  const list = ids.map(Number).filter((x) => Number.isInteger(x) && x > 0).slice(0, 500);
  if (!list.length) return [];
  return db.prepare(`SELECT id, name, level, faction, bss, bss_kind, bss_at, attacked_at FROM players WHERE id IN (${list.map(() => '?').join(',')})`).all(...list);
}

// The ready pool: players with a known BSS, freshest first.
function pool({ lvlMin = 1, lvlMax = 100, maxAgeDays = 60, limit = 300 } = {}) {
  const since = Math.floor(Date.now() / 1000) - maxAgeDays * 86400;
  return db.prepare(`SELECT id, name, level, faction, bss, bss_kind, bss_at, attacked_at FROM players
    WHERE bss IS NOT NULL AND bss_at >= ? AND (level IS NULL OR level BETWEEN ? AND ?)
    ORDER BY bss_at DESC LIMIT ?`).all(since, lvlMin, lvlMax, Math.min(1000, limit));
}

const stats = () => db.prepare('SELECT (SELECT COUNT(*) FROM players) players, (SELECT COUNT(*) FROM players WHERE bss IS NOT NULL) known, (SELECT COUNT(*) FROM attacks) attacks').get();

module.exports = { saveAttacks, syncState, myAttacks, players, pool, stats, bssFromFairFight, DB_PATH };
