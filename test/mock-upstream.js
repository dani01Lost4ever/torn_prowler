// Fake api.torn.com + ffscouter.com for local testing:
//   node test/mock-upstream.js & TORN_BASE=http://localhost:4001 FFS_BASE=http://localhost:4001 node server.js
// then open http://localhost:3000/?proxy with key AAAAAAAAAAAAAAAA.
const http = require('http');

const KEY = 'AAAAAAAAAAAAAAAA';
const now = () => Math.floor(Date.now() / 1000);
const STATES = ['Okay', 'Okay', 'Okay', 'Hospital', 'Traveling', 'Abroad', 'Jail'];
const players = {};
for (let i = 0; i < 120; i++) {
  const id = 100000 + i;
  const state = STATES[i % STATES.length];
  players[id] = {
    player_id: id, name: `Player${i}`, level: 10 + (i % 90),
    status: {
      state,
      description: state === 'Hospital' ? (i % 2 ? 'In hospital for 4 mins' : 'In a Swiss hospital for 4 mins') : state,
      until: state === 'Hospital' ? now() + 240 : 0,
    },
    last_action: { status: 'Offline', relative: `${i} minutes ago`, timestamp: now() - i * 60 },
    faction: { faction_id: 9533, faction_name: 'Mock Faction' },
    bss: 60000 + i * 500,
  };
}
let tornCalls = 0;

function send(res, code, obj) { res.writeHead(code, { 'content-type': 'application/json' }); res.end(JSON.stringify(obj)); }

http.createServer((req, res) => {
  const u = new URL(req.url, 'http://x');
  const q = u.searchParams;
  if (u.pathname.startsWith('/user/') || u.pathname.startsWith('/faction/')) tornCalls++;
  if (u.pathname === '/user/' ) {
    if (q.get('key') !== KEY) return send(res, 200, { error: { code: 2, error: 'Incorrect key' } });
    return send(res, 200, { player_id: 1, name: 'dani01_cs', level: 50, strength: 1e9, defense: 1e9, speed: 9e8, dexterity: 8e8 });
  }
  let m = u.pathname.match(/^\/user\/(\d+)$/);
  if (m) {
    const p = players[m[1]];
    if (!p) return send(res, 200, { error: { code: 6, error: 'Incorrect ID' } });
    const { bss, ...pub } = p;
    return send(res, 200, pub);
  }
  m = u.pathname.match(/^\/faction\/(\d+)$/);
  if (m) {
    const members = {};
    Object.values(players).slice(0, 40).forEach((p) => { members[p.player_id] = { name: p.name, level: p.level, status: p.status, last_action: p.last_action }; });
    return send(res, 200, { ID: Number(m[1]), name: 'Mock Faction', members });
  }
  if (u.pathname === '/api/v1/check-key') return send(res, 200, { is_registered: true });
  if (u.pathname === '/api/v1/get-targets') {
    const targets = Object.values(players).slice(0, 50).map((p) => ({
      player_id: p.player_id, name: p.name, level: p.level, bss_public: p.bss, fair_fight: 2.8,
      bs_estimate_human: '1.2b', hospital_until: p.status.state === 'Hospital' ? p.status.until : 0,
    }));
    return send(res, 200, { parameters: {}, targets });
  }
  if (u.pathname === '/api/v1/get-stats') {
    return send(res, 200, q.get('targets').split(',').map((id) => ({
      player_id: Number(id), bss_public: players[id] ? players[id].bss : null, fair_fight: 2.5, bs_estimate_human: '1b',
    })));
  }
  if (u.pathname === '/calls') return send(res, 200, { tornCalls });
  send(res, 404, { error: 'not found' });
}).listen(4001, () => console.log('mock upstream on :4001'));
