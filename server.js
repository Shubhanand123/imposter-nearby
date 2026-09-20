#!/usr/bin/env node
'use strict';
/*
  Guess the Imposter — nearby-play server
  ---------------------------------------
  One machine runs this. Everyone else joins from their own device:

    • WiFi       open  http://<this-machine>:3000  (same network / hotspot)
    • Bluetooth  Chrome  ->  Nearby Play  ->  Bluetooth  (needs the optional `bleno` package here)

  The server owns the game: it picks the word, deals the cards and counts the
  votes, and sends each player ONLY their own card. No dependencies needed for WiFi.

  Usage:  node server.js [--port 3000] [--https] [--https-port 3443] [--no-ble]
*/

const http = require('http');
const https = require('https');
const fs = require('fs');
const path = require('path');
const os = require('os');
const vm = require('vm');
const crypto = require('crypto');
const { execFileSync } = require('child_process');

const APP = 'imposter-nearby';
const VERSION = 1;
const HTML_FILE = path.join(__dirname, 'imposter.html');

/* Bluetooth GATT layout — must match the constants in imposter.html */
const BLE = {
  SERVICE: '6f1d0001-7a3b-4c2e-9b8a-5d4e3f2a1b0c',
  RX: '6f1d0002-7a3b-4c2e-9b8a-5d4e3f2a1b0c', // phone -> host (write)
  TX: '6f1d0003-7a3b-4c2e-9b8a-5d4e3f2a1b0c', // host -> phone (notify)
  NAME: 'Imposter',
};

const MAX_ROOMS = 200;
const MAX_PLAYERS = 12;
const CODE_CHARS = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
const CID_RE = /^[A-Za-z0-9_-]{8,64}$/;

/* ============================== WORD PACKS ============================== */
/* Read straight from imposter.html so there is one source of truth. */
const FALLBACK_PACKS = {
  objects: { name: 'Everyday Objects', words: ['Umbrella', 'Backpack', 'Toothbrush', 'Candle', 'Mirror', 'Stapler', 'Pillow', 'Wallet'] },
  animals: { name: 'Animals', words: ['Octopus', 'Penguin', 'Cheetah', 'Kangaroo', 'Flamingo', 'Otter', 'Hedgehog', 'Peacock'] },
  food: { name: 'Food & Drink', words: ['Pizza', 'Sushi', 'Mango', 'Tacos', 'Ramen', 'Croissant', 'Popcorn', 'Curry'] },
};
function loadPacks() {
  try {
    const src = fs.readFileSync(HTML_FILE, 'utf8');
    const m = src.match(/const PACKS\s*=\s*(\{[\s\S]*?\n\});/);
    if (m) {
      const packs = vm.runInNewContext('(' + m[1] + ')', {}, { timeout: 1000 });
      if (packs && Object.keys(packs).length) return packs;
    }
  } catch (e) { /* fall through */ }
  console.warn('  ! Could not read word packs from imposter.html — using a tiny fallback set.');
  return FALLBACK_PACKS;
}

/* ============================== HELPERS ============================== */
class GameError extends Error {}
const rnd = (n) => crypto.randomInt(n);
function shuffle(a) { a = a.slice(); for (let i = a.length - 1; i > 0; i--) { const j = rnd(i + 1); [a[i], a[j]] = [a[j], a[i]]; } return a; }
function cleanText(s, max) { return String(s == null ? '' : s).replace(/[\u0000-\u001f\u007f]/g, '').replace(/\s+/g, ' ').trim().slice(0, max); }
const clamp = (n, lo, hi) => Math.max(lo, Math.min(hi, n));
function newCode(exists) {
  let code;
  do { code = Array.from({ length: 4 }, () => CODE_CHARS[rnd(CODE_CHARS.length)]).join(''); } while (exists(code));
  return code;
}

/* ============================== GAME HUB ============================== */
/*
  Transport-agnostic. A transport (SSE, BLE, a test) calls:
      hub.attach(cid, conn)   conn = { send(obj), close(), transport }
      hub.handle(cid, msg)
      hub.detach(cid, conn)
  and the hub pushes  { t:'state', view }  to every player after each change.
*/
class Hub {
  constructor(packs) {
    this.packs = packs;
    this.sessions = new Map(); // cid -> { cid, conn, roomCode, pid, lastSeen }
    this.rooms = new Map();
    this.sweeper = setInterval(() => this.sweep(), 5000);
    this.sweeper.unref();
  }

  /* ---------- connection lifecycle ---------- */
  attach(cid, conn) {
    let s = this.sessions.get(cid);
    if (!s) { s = { cid, conn: null, roomCode: null, pid: null, lastSeen: Date.now() }; this.sessions.set(cid, s); }
    if (s.conn && s.conn !== conn) { try { s.conn.close && s.conn.close(); } catch (e) {} }
    s.conn = conn; s.lastSeen = Date.now();
    const room = this.roomOf(s);
    const p = room && room.players.get(s.pid);
    if (p) { p.connected = true; p.dropAt = 0; this.broadcast(room); }
    return s;
  }
  detach(cid, conn) {
    const s = this.sessions.get(cid);
    if (!s || s.conn !== conn) return;
    s.conn = null;
    const room = this.roomOf(s);
    const p = room && room.players.get(s.pid);
    if (p) { p.connected = false; p.dropAt = Date.now(); this.broadcast(room); }
  }

  /* ---------- message entry point ---------- */
  handle(cid, msg) {
    const s = this.sessions.get(cid);
    if (!s || !s.conn) return;
    s.lastSeen = Date.now();
    try {
      if (!msg || typeof msg.t !== 'string' || !Object.prototype.hasOwnProperty.call(HANDLERS, msg.t)) throw new GameError('Unknown action');
      HANDLERS[msg.t](this, s, msg);
      const room = this.roomOf(s);
      if (room) room.lastActivity = Date.now();
    } catch (e) {
      if (e instanceof GameError) this.reply(s, { t: 'error', msg: e.message });
      else { console.error('handler error:', e); this.reply(s, { t: 'error', msg: 'Server error' }); }
    }
  }

  reply(s, obj) { try { s.conn && s.conn.send(obj); } catch (e) {} }

  /* ---------- lookups ---------- */
  roomOf(s) { return s.roomCode ? this.rooms.get(s.roomCode) : null; }
  needRoom(s) {
    const r = this.roomOf(s);
    if (!r || !r.players.has(s.pid)) throw new GameError('You are not in a room');
    return r;
  }
  needHost(s) {
    const r = this.needRoom(s);
    if (r.hostPid !== s.pid) throw new GameError('Only the host can do that');
    return r;
  }

  /* ---------- views (what each player is allowed to see) ---------- */
  viewFor(room, pid) {
    const me = room.players.get(pid);
    const players = [...room.players.values()];
    const st = room.settings;
    const packNames = st.packKeys.map((k) => ({ key: k, name: (this.packs[k] || st.custom.find((c) => c.id === k) || {}).name || k }));
    const v = {
      room: room.code, phase: room.phase, round: room.round, serverNow: Date.now(),
      me: { pid, name: me.name, isHost: room.hostPid === pid },
      players: players.map((p) => ({ pid: p.pid, name: p.name, connected: p.connected, isHost: p.pid === room.hostPid, seen: p.seen, voted: !!p.vote })),
      settings: { packKeys: st.packKeys, packNames, imposterCount: st.imposterCount, doubleAgent: st.doubleAgent, discussionSeconds: st.discussionSeconds },
      seenCount: players.filter((p) => p.seen).length,
      votedCount: players.filter((p) => p.vote).length,
      card: null, endsAt: 0, turnOrder: null, myVote: me.vote || null, result: null,
    };
    if (room.phase !== 'lobby') {
      const a = room.assign.get(pid);
      v.card = a ? { isImposter: a.isImposter, word: a.word, category: a.category, partnerNames: a.partnerNames } : null;
      v.turnOrder = room.turnOrder.filter((id) => room.players.has(id)).map((id) => ({ pid: id, name: room.players.get(id).name }));
    }
    if (room.phase === 'discuss') v.endsAt = room.endsAt;
    if (room.phase === 'results') v.result = room.result;
    return v;
  }
  broadcast(room) {
    for (const p of room.players.values()) {
      const s = this.sessions.get(p.cid);
      if (s && s.conn) { try { s.conn.send({ t: 'state', view: this.viewFor(room, p.pid) }); } catch (e) {} }
    }
  }
  pushState(cid) {
    const s = this.sessions.get(cid);
    if (!s || !s.conn) return;
    const room = this.roomOf(s);
    const ok = room && room.players.has(s.pid);
    this.reply(s, { t: 'state', view: ok ? this.viewFor(room, s.pid) : null });
  }

  /* ---------- rooms & players ---------- */
  addPlayer(room, s, name, pid) {
    const p = { pid: pid || s.cid, cid: s.cid, name, connected: true, dropAt: 0, seen: false, vote: null };
    room.players.set(p.pid, p);
    s.roomCode = room.code; s.pid = p.pid;
    return p;
  }
  uniqueName(room, name) {
    const taken = new Set([...room.players.values()].map((p) => p.name.toLowerCase()));
    if (!taken.has(name.toLowerCase())) return name;
    for (let i = 2; i < 30; i++) { const n = `${name.slice(0, 12)} (${i})`; if (!taken.has(n.toLowerCase())) return n; }
    return name;
  }
  leaveRoom(s) {
    const room = this.roomOf(s);
    if (room && room.players.has(s.pid)) this.removePlayer(room, s.pid);
    s.roomCode = null; s.pid = null;
  }
  removePlayer(room, pid) {
    const p = room.players.get(pid);
    if (!p) return;
    room.players.delete(pid);
    const ps = this.sessions.get(p.cid);
    if (ps && ps.pid === pid) { ps.roomCode = null; ps.pid = null; }
    if (ps) this.reply(ps, { t: 'state', view: null });
    if (room.players.size === 0) { this.deleteRoom(room); return; }
    if (room.hostPid === pid) this.promoteHost(room, true);
    if (room.phase === 'vote') this.checkAllVoted(room);
    this.broadcast(room);
  }
  promoteHost(room, force) {
    const next = [...room.players.values()].find((p) => p.connected && p.pid !== room.hostPid) || (force ? [...room.players.values()][0] : null);
    if (next) { room.hostPid = next.pid; this.broadcast(room); }
  }
  deleteRoom(room) {
    this.clearTimer(room);
    this.rooms.delete(room.code);
    for (const p of room.players.values()) { const s = this.sessions.get(p.cid); if (s && s.roomCode === room.code) { s.roomCode = null; s.pid = null; } }
  }
  clearTimer(room) { if (room.timer) { clearTimeout(room.timer); room.timer = null; } }

  /* ---------- round flow ---------- */
  wordPool(st) {
    const pool = [];
    for (const k of st.packKeys) {
      const p = this.packs[k] || st.custom.find((c) => c.id === k);
      if (p) for (const w of p.words) pool.push({ word: w, cat: p.name });
    }
    return pool;
  }
  startRound(room) {
    for (const p of [...room.players.values()]) if (!p.connected) this.removePlayer(room, p.pid);
    if (!this.rooms.has(room.code)) return;
    if (room.players.size < 3) throw new GameError('Need at least 3 connected players');
    const pool = this.wordPool(room.settings);
    if (!pool.length) throw new GameError('Pick at least one word pack');
    const pick = pool[rnd(pool.length)];
    const pids = [...room.players.keys()];
    const impCount = Math.min(room.settings.imposterCount, pids.length - 1);
    const imposters = shuffle(pids).slice(0, impCount);
    room.round += 1; room.phase = 'reveal'; room.word = pick.word; room.category = pick.cat;
    room.imposters = imposters; room.assign = new Map(); room.result = null; room.endsAt = 0;
    room.turnOrder = shuffle(pids);
    this.clearTimer(room);
    for (const pid of pids) {
      const isImp = imposters.includes(pid);
      room.assign.set(pid, {
        isImposter: isImp, word: isImp ? null : pick.word, category: pick.cat,
        partnerNames: isImp && room.settings.doubleAgent ? imposters.filter((x) => x !== pid).map((x) => room.players.get(x).name) : [],
      });
      const p = room.players.get(pid); p.seen = false; p.vote = null;
    }
    this.broadcast(room);
  }
  openDiscussion(room) {
    room.phase = 'discuss';
    const ms = room.settings.discussionSeconds * 1000;
    room.endsAt = Date.now() + ms;
    this.clearTimer(room);
    room.timer = setTimeout(() => { if (room.phase === 'discuss') this.openVote(room); }, ms + 400);
    this.broadcast(room);
  }
  openVote(room) {
    this.clearTimer(room);
    room.phase = 'vote'; room.endsAt = 0;
    for (const p of room.players.values()) p.vote = null;
    this.broadcast(room);
  }
  checkAllVoted(room) {
    const live = [...room.players.values()].filter((p) => p.connected);
    if (live.length && live.every((p) => p.vote)) this.finish(room);
  }
  finish(room) {
    this.clearTimer(room);
    const tally = {};
    for (const p of room.players.values()) if (p.vote && room.players.has(p.vote)) tally[p.vote] = (tally[p.vote] || 0) + 1;
    const max = Math.max(0, ...Object.values(tally));
    const accused = max > 0 ? Object.keys(tally).filter((id) => tally[id] === max) : [];
    const imp = room.imposters;
    const crewWon = imp.length === 1
      ? accused.length === 1 && imp.includes(accused[0])
      : imp.every((id) => accused.includes(id)) && accused.length === imp.length;
    const name = (id) => (room.players.get(id) || {}).name || '(left)';
    room.result = {
      crewWon, word: room.word, category: room.category,
      imposters: imp.map(name), accused: accused.map(name),
      tally: Object.keys(tally).map((id) => ({ name: name(id), votes: tally[id] })).sort((a, b) => b.votes - a.votes),
    };
    room.phase = 'results'; room.endsAt = 0;
    this.broadcast(room);
  }

  /* ---------- housekeeping ---------- */
  sweep() {
    const now = Date.now();
    for (const room of [...this.rooms.values()]) {
      for (const p of [...room.players.values()]) {
        if (p.connected) continue;
        const gone = now - p.dropAt;
        const idlePhase = room.phase === 'lobby' || room.phase === 'results';
        if ((idlePhase && gone > 30000) || gone > 30 * 60000) { this.removePlayer(room, p.pid); if (!this.rooms.has(room.code)) break; }
      }
      if (!this.rooms.has(room.code)) continue;
      const host = room.players.get(room.hostPid);
      if (host && !host.connected && now - host.dropAt > 30000) this.promoteHost(room, false);
      if (now - room.lastActivity > 3 * 3600000) this.deleteRoom(room);
    }
    for (const [cid, s] of this.sessions) if (!s.conn && !s.roomCode && now - s.lastSeen > 600000) this.sessions.delete(cid);
  }
  stats() {
    let players = 0, live = 0;
    for (const r of this.rooms.values()) for (const p of r.players.values()) { players++; if (p.connected) live++; }
    return { rooms: this.rooms.size, players, connected: live };
  }
}

/* ---------- message handlers (one per client action) ---------- */
function defaultSettings(packs) {
  const want = ['objects', 'animals', 'food', 'tropes'].filter((k) => packs[k]);
  return { packKeys: want.length ? want : Object.keys(packs).slice(0, 3), custom: [], imposterCount: 1, doubleAgent: false, discussionSeconds: 90 };
}
function sanitizeSettings(hub, cur, m) {
  const out = Object.assign({}, cur);
  if (Array.isArray(m.custom)) {
    const custom = []; let total = 0;
    for (const c of m.custom.slice(0, 6)) {
      if (!c || !Array.isArray(c.words)) continue;
      let id = String(c.id || '').replace(/[^\w-]/g, '').slice(0, 40); if (!id.startsWith('custom_')) id = 'custom_' + id;
      const words = [...new Set(c.words.map((w) => cleanText(w, 32)).filter(Boolean))].slice(0, 120);
      if (words.length < 4) continue;
      total += words.length; if (total > 300) break;
      custom.push({ id, name: cleanText(c.name, 30) || 'Custom', words });
    }
    out.custom = custom;
  }
  const valid = new Set([...Object.keys(hub.packs), ...out.custom.map((c) => c.id)]);
  const keys = Array.isArray(m.packKeys) ? m.packKeys.map(String) : out.packKeys;
  out.packKeys = [...new Set(keys)].filter((k) => valid.has(k));
  if (Number.isFinite(m.imposterCount)) out.imposterCount = clamp(Math.round(m.imposterCount), 1, 3);
  if (typeof m.doubleAgent === 'boolean') out.doubleAgent = m.doubleAgent;
  if (Number.isFinite(m.discussionSeconds)) out.discussionSeconds = clamp(Math.round(m.discussionSeconds), 15, 600);
  return out;
}

const HANDLERS = {
  create(hub, s, m) {
    hub.leaveRoom(s);
    if (hub.rooms.size >= MAX_ROOMS) throw new GameError('Server is full — try again later');
    const code = newCode((c) => hub.rooms.has(c));
    const room = {
      code, hostPid: s.cid, phase: 'lobby', round: 0, createdAt: Date.now(), lastActivity: Date.now(),
      settings: defaultSettings(hub.packs), players: new Map(), assign: new Map(), imposters: [], turnOrder: [],
      word: '', category: '', result: null, endsAt: 0, timer: null,
    };
    hub.rooms.set(code, room);
    hub.addPlayer(room, s, cleanText(m.name, 16) || 'Host');
    hub.broadcast(room);
  },
  join(hub, s, m) {
    const code = String(m.code || '').toUpperCase().trim();
    const room = hub.rooms.get(code);
    if (!room) throw new GameError('Room not found');
    let name = cleanText(m.name, 16) || 'Player';
    const already = s.roomCode === code && room.players.get(s.pid);
    if (already) { already.connected = true; already.dropAt = 0; hub.broadcast(room); return; }
    if (s.roomCode) hub.leaveRoom(s);
    const ghost = [...room.players.values()].find((p) => !p.connected && p.name.toLowerCase() === name.toLowerCase());
    if (ghost) {
      // a dropped player coming back on a new connection: take over their seat
      const old = hub.sessions.get(ghost.cid);
      if (old && old !== s) { old.roomCode = null; old.pid = null; }
      ghost.cid = s.cid; ghost.connected = true; ghost.dropAt = 0;
      s.roomCode = room.code; s.pid = ghost.pid;
    } else {
      if (room.phase !== 'lobby' && room.phase !== 'results') throw new GameError('A round is in progress — wait for the next one, or rejoin with the exact name you had before');
      if (room.players.size >= MAX_PLAYERS) throw new GameError('That room is full');
      hub.addPlayer(room, s, hub.uniqueName(room, name));
    }
    hub.broadcast(room);
  },
  leave(hub, s) { hub.leaveRoom(s); },
  settings(hub, s, m) {
    const room = hub.needHost(s);
    if (room.phase !== 'lobby' && room.phase !== 'results') throw new GameError('Settings are locked during a round');
    room.settings = sanitizeSettings(hub, room.settings, m);
    hub.broadcast(room);
  },
  start(hub, s) {
    const room = hub.needHost(s);
    if (room.phase !== 'lobby' && room.phase !== 'results') throw new GameError('A round is already running');
    hub.startRound(room);
  },
  again(hub, s) { HANDLERS.start(hub, s); },
  seen(hub, s) {
    const room = hub.needRoom(s);
    if (room.phase !== 'reveal') return;
    room.players.get(s.pid).seen = true;
    hub.broadcast(room);
  },
  discuss(hub, s) {
    const room = hub.needHost(s);
    if (room.phase !== 'reveal') throw new GameError('Not the right time for that');
    hub.openDiscussion(room);
  },
  openVote(hub, s) {
    const room = hub.needHost(s);
    if (room.phase !== 'reveal' && room.phase !== 'discuss') throw new GameError('Not the right time for that');
    hub.openVote(room);
  },
  vote(hub, s, m) {
    const room = hub.needRoom(s);
    if (room.phase !== 'vote') throw new GameError('Voting is not open');
    const target = String(m.target || '');
    if (target === s.pid || !room.players.has(target)) throw new GameError('Pick another player');
    room.players.get(s.pid).vote = target;
    hub.broadcast(room);
    hub.checkAllVoted(room);
  },
  finish(hub, s) {
    const room = hub.needHost(s);
    if (room.phase !== 'vote') throw new GameError('Voting is not open');
    hub.finish(room);
  },
  toLobby(hub, s) {
    const room = hub.needHost(s);
    hub.clearTimer(room);
    room.phase = 'lobby'; room.endsAt = 0; room.result = null;
    for (const p of room.players.values()) { p.seen = false; p.vote = null; }
    hub.broadcast(room);
  },
  ping(hub, s) { hub.reply(s, { t: 'pong' }); },
};

/* ============================== BLUETOOTH FRAMING ============================== */
/*
  BLE moves ~20-500 bytes per packet, so JSON messages are split into frames:
      [flags][tag hi][tag lo][payload...]      flags: 0x02 = first frame, 0x01 = last frame
  `tag` is a random per-connection id chosen by the phone (0 = host -> phone).
  Same code exists in imposter.html (bleFrames / BleAssembler).
*/
const F_LAST = 0x01, F_FIRST = 0x02;
function encodeFrames(text, payload, tag) {
  const data = Buffer.from(text, 'utf8');
  const n = Math.max(1, Math.ceil(data.length / payload));
  const out = [];
  for (let i = 0; i < n; i++) {
    const flags = (i === 0 ? F_FIRST : 0) | (i === n - 1 ? F_LAST : 0);
    out.push(Buffer.concat([Buffer.from([flags, (tag >> 8) & 255, tag & 255]), data.subarray(i * payload, (i + 1) * payload)]));
  }
  return out;
}
class Assembler {
  constructor() { this.parts = new Map(); }
  push(buf) {
    if (buf.length < 3) return null;
    const flags = buf[0], tag = (buf[1] << 8) | buf[2];
    let cur = this.parts.get(tag);
    if (flags & F_FIRST) { cur = { chunks: [], size: 0 }; this.parts.set(tag, cur); }
    else if (!cur) return null;
    const body = buf.subarray(3);
    cur.chunks.push(body); cur.size += body.length;
    if (cur.size > 65536) { this.parts.delete(tag); return null; }
    if (flags & F_LAST) { this.parts.delete(tag); return { tag, text: Buffer.concat(cur.chunks).toString('utf8') }; }
    return null;
  }
}

/* ============================== BLUETOOTH BRIDGE ============================== */
/*
  Web Bluetooth can only be a *client*, so this machine plays the Bluetooth
  peripheral (via the optional `bleno` package) and bridges every phone that
  connects into the same rooms as the WiFi players.

  bleno does not tell us WHICH phone wrote or unsubscribed, so we identify
  phones ourselves:  on subscribe we notify a random `sub` id -> the phone answers
  with { t:'hello', sub, cid } inside frames carrying its own tag -> we bind
  tag <-> subscription <-> cid.  Liveness comes from the phone's 8s ping.
*/
function startBle(hub, bleno, status, lan) {
  const { Characteristic, PrimaryService } = bleno;
  const subs = new Map();   // subId -> sub
  const byTag = new Map();  // tag -> sub
  const asm = new Assembler();

  function enqueue(sub, obj) {
    const payload = Math.max(17, Math.min(sub.max, 180) - 3);
    const msg = { type: obj.t, frames: encodeFrames(JSON.stringify(obj), payload, 0) };
    // Bluetooth is slow: if newer state arrives before an older snapshot was sent, the older one is obsolete.
    if (obj.t === 'state') sub.queue = sub.queue.filter((m) => m.type !== 'state');
    sub.queue.push(msg);
    if (sub.pumping) return;
    sub.pumping = true;
    const step = () => {
      const m = sub.queue[0];
      if (!m) { sub.pumping = false; return; }
      const f = m.frames.shift();
      if (f) { try { sub.notify(f); } catch (e) {} }
      if (!m.frames.length) sub.queue.shift();
      setTimeout(step, 12);
    };
    step();
  }
  function drop(sub) {
    if (!subs.delete(sub.id)) return;
    if (sub.tag != null && byTag.get(sub.tag) === sub) byTag.delete(sub.tag);
    if (sub.cid && sub.conn) hub.detach(sub.cid, sub.conn);
  }
  function onMessage(tag, text) {
    let m; try { m = JSON.parse(text); } catch (e) { return; }
    if (!m || typeof m.t !== 'string') return;
    if (m.t === 'hello') {
      const sub = subs.get(m.sub); const cid = String(m.cid || '');
      if (!sub || !CID_RE.test(cid)) return;
      if (sub.tag != null && byTag.get(sub.tag) === sub) byTag.delete(sub.tag);
      sub.tag = tag; sub.cid = cid; sub.lastSeen = Date.now(); byTag.set(tag, sub);
      if (!sub.conn) sub.conn = { transport: 'ble', send: (o) => enqueue(sub, o), close: () => drop(sub) };
      hub.attach(cid, sub.conn);
      sub.conn.send({ t: 'hello', cid, serverNow: Date.now(), transport: 'ble', app: APP, version: VERSION, lan: lan ? lan() : [] });
      hub.pushState(cid);
      return;
    }
    const sub = byTag.get(tag);
    if (!sub || !sub.cid) return;
    sub.lastSeen = Date.now();
    if (m.t === 'ping') { sub.conn.send({ t: 'pong' }); return; }
    hub.handle(sub.cid, m);
  }

  class RxChar extends Characteristic {
    constructor() { super({ uuid: BLE.RX, properties: ['write', 'writeWithoutResponse'], value: null }); }
    onWriteRequest(data, offset, withoutResponse, callback) {
      callback(this.RESULT_SUCCESS);
      const r = asm.push(Buffer.from(data));
      if (r) onMessage(r.tag, r.text);
    }
  }
  class TxChar extends Characteristic {
    constructor() { super({ uuid: BLE.TX, properties: ['notify'], value: null }); }
    onSubscribe(maxValueSize, updateValueCallback) {
      const sub = { id: crypto.randomBytes(6).toString('hex'), notify: updateValueCallback, max: maxValueSize || 20, queue: [], pumping: false, tag: null, cid: null, conn: null, lastSeen: Date.now() };
      subs.set(sub.id, sub);
      status.subscribers = subs.size;
      enqueue(sub, { t: 'sub', sub: sub.id, v: VERSION });
    }
    onUnsubscribe() { /* bleno does not say who; the idle sweep below handles it */ }
  }

  const sweep = setInterval(() => {
    const now = Date.now();
    for (const sub of [...subs.values()]) if (now - sub.lastSeen > 45000) drop(sub);
    status.subscribers = subs.size;
  }, 5000);
  sweep.unref();

  bleno.on('stateChange', (state) => {
    status.state = state;
    if (state === 'poweredOn') bleno.startAdvertising(BLE.NAME, [BLE.SERVICE], (err) => { if (err) status.error = String(err); });
    else { status.advertising = false; bleno.stopAdvertising(); }
  });
  bleno.on('advertisingStart', (err) => {
    if (err) { status.error = String(err); status.advertising = false; console.error('  ! Bluetooth advertising failed:', err); return; }
    status.advertising = true; status.error = '';
    bleno.setServices([new PrimaryService({ uuid: BLE.SERVICE, characteristics: [new RxChar(), new TxChar()] })]);
    console.log(`  ✓ Bluetooth host advertising as "${BLE.NAME}"`);
  });
  bleno.on('advertisingStop', () => { status.advertising = false; });
  return { drop, subs };
}

function tryLoadBleno() {
  for (const name of ['@abandonware/bleno', 'bleno']) {
    try { return require(name); } catch (e) { /* try next */ }
  }
  return null;
}

/* ============================== HTTP (WiFi) ============================== */
function lanUrls(port, scheme) {
  const out = [];
  const nets = os.networkInterfaces();
  for (const name of Object.keys(nets)) {
    for (const n of nets[name] || []) {
      if (n.family === 'IPv4' && !n.internal) out.push({ ip: n.address, score: /^(192\.168|10\.|172\.(1[6-9]|2\d|3[01]))/.test(n.address) ? 0 : 1 });
    }
  }
  return out.sort((a, b) => a.score - b.score).map((o) => `${scheme}://${o.ip}:${port}`);
}

function makeHandler(hub, ctx) {
  const json = (res, code, obj) => { res.writeHead(code, { 'Content-Type': 'application/json' }); res.end(JSON.stringify(obj)); };
  return (req, res) => {
    let url;
    try { url = new URL(req.url, 'http://localhost'); } catch (e) { res.writeHead(400); return res.end(); }
    // Allow the page to live elsewhere (file://, another host) and still reach this server.
    res.setHeader('Access-Control-Allow-Origin', '*');
    res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
    res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
    res.setHeader('Access-Control-Allow-Private-Network', 'true');
    if (req.method === 'OPTIONS') { res.writeHead(204); return res.end(); }

    if (req.method === 'GET' && url.pathname === '/events') {
      const cid = url.searchParams.get('cid') || '';
      if (!CID_RE.test(cid)) return json(res, 400, { ok: false, error: 'bad cid' });
      res.writeHead(200, { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache, no-transform', Connection: 'keep-alive', 'X-Accel-Buffering': 'no' });
      req.socket.setNoDelay(true); req.socket.setKeepAlive(true, 15000);
      const conn = {
        transport: 'wifi',
        send: (obj) => { try { res.write('data: ' + JSON.stringify(obj) + '\n\n'); } catch (e) {} },
        close: () => { try { res.end(); } catch (e) {} },
      };
      res.write('retry: 2000\n\n');
      hub.attach(cid, conn);
      conn.send({ t: 'hello', cid, serverNow: Date.now(), transport: 'wifi', app: APP, version: VERSION, lan: ctx.lan(), ble: ctx.bleStatus });
      hub.pushState(cid);
      const hb = setInterval(() => { try { res.write(': hb\n\n'); } catch (e) {} }, 15000);
      req.on('close', () => { clearInterval(hb); hub.detach(cid, conn); });
      return;
    }

    if (req.method === 'POST' && url.pathname === '/send') {
      const cid = url.searchParams.get('cid') || '';
      if (!CID_RE.test(cid)) return json(res, 400, { ok: false, error: 'bad cid' });
      let body = '', tooBig = false;
      req.on('data', (c) => { body += c; if (body.length > 20000) { tooBig = true; req.destroy(); } });
      req.on('end', () => {
        if (tooBig) return;
        let msg; try { msg = JSON.parse(body); } catch (e) { return json(res, 400, { ok: false, error: 'bad json' }); }
        const s = hub.sessions.get(cid);
        if (!s || !s.conn) return json(res, 409, { ok: false, error: 'not connected' });
        hub.handle(cid, msg);
        json(res, 200, { ok: true });
      });
      return;
    }

    if (req.method === 'GET' && url.pathname === '/info') {
      return json(res, 200, { app: APP, version: VERSION, lan: ctx.lan(), ble: ctx.bleStatus, ...hub.stats() });
    }

    if (req.method === 'GET' && ['/', '/index.html', '/imposter.html'].includes(url.pathname)) {
      fs.readFile(HTML_FILE, (err, data) => {
        if (err) { res.writeHead(500, { 'Content-Type': 'text/plain' }); return res.end('imposter.html not found next to server.js'); }
        res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store' });
        res.end(data);
      });
      return;
    }
    res.writeHead(404, { 'Content-Type': 'text/plain' }); res.end('Not found');
  };
}

/* ---------- optional self-signed HTTPS (Web Bluetooth needs a secure page) ---------- */
function ensureCert(ips) {
  const dir = path.join(__dirname, '.cert');
  const key = path.join(dir, 'key.pem'), crt = path.join(dir, 'cert.pem');
  if (fs.existsSync(key) && fs.existsSync(crt)) return { key: fs.readFileSync(key), cert: fs.readFileSync(crt) };
  fs.mkdirSync(dir, { recursive: true });
  const san = ['DNS:localhost', 'IP:127.0.0.1', ...ips.map((i) => 'IP:' + i)].join(',');
  execFileSync('openssl', ['req', '-x509', '-newkey', 'rsa:2048', '-nodes', '-keyout', key, '-out', crt, '-days', '825', '-subj', '/CN=imposter.local', '-addext', 'subjectAltName=' + san], { stdio: 'ignore' });
  return { key: fs.readFileSync(key), cert: fs.readFileSync(crt) };
}

/* ============================== MAIN ============================== */
function main() {
  const argv = process.argv.slice(2);
  const flag = (n) => argv.includes('--' + n);
  const opt = (n, d) => { const i = argv.indexOf('--' + n); return i > -1 && argv[i + 1] ? argv[i + 1] : d; };
  const PORT = parseInt(opt('port', process.env.PORT || '3000'), 10);
  const HTTPS_PORT = parseInt(opt('https-port', process.env.HTTPS_PORT || '3443'), 10);

  const packs = loadPacks();
  const hub = new Hub(packs);
  const bleStatus = { enabled: false, advertising: false, state: 'off', subscribers: 0, error: '' };
  let httpsOn = false;
  const ctx = {
    bleStatus,
    lan: () => [...lanUrls(PORT, 'http'), ...(httpsOn ? lanUrls(HTTPS_PORT, 'https') : [])],
  };
  const handler = makeHandler(hub, ctx);

  const row = (label, text) => console.log('  ' + label.padEnd(18) + ': ' + text);
  const server = http.createServer(handler);
  server.on('error', (e) => { console.error(e.code === 'EADDRINUSE' ? `\n  Port ${PORT} is busy. Try:  node server.js --port ${PORT + 1}\n` : e); process.exit(1); });
  server.listen(PORT, '0.0.0.0', () => {
    console.log('\n  Guess the Imposter — nearby server');
    console.log('  ───────────────────────────────────');
    row('Word packs', Object.keys(packs).length + ' loaded');
    row('This machine', `http://localhost:${PORT}`);
    const lan = lanUrls(PORT, 'http');
    if (lan.length) lan.forEach((u, i) => row(i === 0 ? 'Share on WiFi' : '', u));
    else row('WiFi', '(no network address found — connect to WiFi or start a hotspot)');

    if (flag('https')) {
      try {
        const creds = ensureCert(lan.map((u) => new URL(u).hostname));
        const hs = https.createServer(creds, handler);
        hs.on('error', (e) => console.warn('  ! HTTPS failed:', e.message));
        hs.listen(HTTPS_PORT, '0.0.0.0');
        httpsOn = true;
        const secure = lanUrls(HTTPS_PORT, 'https');
        row('Secure page', (secure[0] || `https://localhost:${HTTPS_PORT}`) + '   (accept the certificate warning)');
      } catch (e) {
        console.warn('  ! Could not start HTTPS (needs the `openssl` command):', e.message);
      }
    }

    if (!flag('no-ble')) {
      const bleno = tryLoadBleno();
      if (bleno) {
        bleStatus.enabled = true;
        row('Bluetooth host', 'starting…');
        try { startBle(hub, bleno, bleStatus, ctx.lan); }
        catch (e) { bleStatus.enabled = false; console.warn('  ! Bluetooth host failed to start:', e.message); }
      } else {
        row('Bluetooth host', 'off — WiFi works; for Bluetooth run "npm install" (see README)');
      }
    }
    console.log('');
  });

  const bye = () => { console.log('\n  Bye.'); process.exit(0); };
  process.on('SIGINT', bye); process.on('SIGTERM', bye);
}

module.exports = { Hub, GameError, encodeFrames, Assembler, startBle, makeHandler, BLE, loadPacks };
if (require.main === module) main();
