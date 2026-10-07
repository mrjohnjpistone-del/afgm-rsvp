// A Few Good Men — RSVP + Test Ride / Test Drive For Tickets.
//
//   RSVP PAGE        GET  /                      open: special-event RSVPs (alias /rsvp)
//   TEST DRIVE PAGE  GET  /testdrive             open: Test Ride / Test Drive claims
//   MANAGE PAGE      GET  /manage                key-gated: counts, lists, CSV, caps (alias /staff, /admin)
//
// Zero npm dependencies, one JSON file with atomic serialized writes — the same build
// as the materials list and the audition sign-in. The public pages can submit and can
// read seat counts; they can never read anyone's name, email or phone.

const http   = require('http');
const fs     = require('fs');
const path   = require('path');
const crypto = require('crypto');

const PORT        = process.env.PORT || 3000;
const DATA_DIR    = process.env.DATA_DIR || path.join(__dirname, 'data');
const DATA_FILE   = path.join(DATA_DIR, 'rsvp.json');
const PUBLIC_DIR  = path.join(__dirname, 'public');
const DEFAULT_KEY = process.env.STAFF_KEY || 'AFGM-rsvp';

// Optional off-box mirror (same contract as the materials list): every change is pushed
// to a key-gated blob endpoint, and a machine that boots with an empty disk restores from it.
const BACKUP_URL = process.env.BACKUP_URL || '';
const BACKUP_KEY = process.env.BACKUP_KEY || '';

// ── The events ───────────────────────────────────────────────────────────────
// `restricted` events are for Veterans, Active Duty Military, First Responders and
// Teachers. Final Dress is the one night Students may also RSVP for.
const EVENTS = [
  { id: 'dd',  name: "Director's Dinner",         when: 'Thursday, Nov. 5, 2026 @ 6:00 PM',   capped: true,  students: false },
  { id: 'fd',  name: 'Final Dress Rehearsal',     when: 'Thursday, Nov. 5, 2026 @ 8:00 PM',   capped: false, students: true  },
  { id: 'vdd', name: "Veteran's Day Dinner",      when: 'Wednesday, Nov. 11, 2026 @ 6:00 PM', capped: true,  students: false },
  { id: 'vdp', name: "Veteran's Day Performance", when: 'Wednesday, Nov. 11, 2026 @ 7:00 PM', capped: false, students: false },
];
const CATEGORIES = ['Veteran', 'Active Duty Military', 'First Responder', 'Teacher', 'Student'];
const DEFAULT_CAP = 80;

// Test Ride / Test Drive For Tickets: every show night except the Veteran's Day performance.
const NIGHTS = [
  { id: '2026-11-06', label: 'Friday, Nov. 6 @ 7:00 PM' },
  { id: '2026-11-07', label: 'Saturday, Nov. 7 @ 7:00 PM' },
  { id: '2026-11-08', label: 'Sunday, Nov. 8 @ 3:00 PM' },
  { id: '2026-11-13', label: 'Friday, Nov. 13 @ 7:00 PM' },
  { id: '2026-11-14', label: 'Saturday, Nov. 14 @ 7:00 PM' },
  { id: '2026-11-15', label: 'Sunday, Nov. 15 @ 3:00 PM' },
  { id: '2026-11-20', label: 'Friday, Nov. 20 @ 7:00 PM' },
  { id: '2026-11-21', label: 'Saturday, Nov. 21 @ 7:00 PM' },
];
const DEALERS = ['Toad Suck Harley-Davidson', 'Jay Hodge Ford'];
const DEALER_BLOCK = 100; // seats set aside per dealership (each ticket covers the holder + 1 guest) — shown to staff, not enforced

function freshStore() {
  return {
    settings: { staff_key: DEFAULT_KEY, caps: { dd: DEFAULT_CAP, vdd: DEFAULT_CAP } },
    // { id, name, email, phone, category, events: { dd: 0|1|2, ... }, guest, notes, created_at }
    rsvps: [],
    // { id, name, email, phone, night, dealer, ticket, seats: 1|2, created_at }
    testdrives: [],
    trash: [], // { kind: 'rsvp'|'testdrive', rec, removed_at } — last 50 removals
  };
}

// ── Storage ──────────────────────────────────────────────────────────────────
function normalize(d) {
  const base = freshStore();
  const out = {};
  out.settings = Object.assign(base.settings, d && d.settings || {});
  out.settings.caps = Object.assign({ dd: DEFAULT_CAP, vdd: DEFAULT_CAP }, out.settings.caps || {});
  if (!out.settings.staff_key) out.settings.staff_key = DEFAULT_KEY;
  out.rsvps = d && Array.isArray(d.rsvps) ? d.rsvps : [];
  out.testdrives = d && Array.isArray(d.testdrives) ? d.testdrives : [];
  out.trash = d && Array.isArray(d.trash) ? d.trash : [];
  return out;
}
function load() {
  try { return normalize(JSON.parse(fs.readFileSync(DATA_FILE, 'utf8'))); }
  catch (e) { return freshStore(); }
}
let store = load();
let hadLocalFile = fs.existsSync(DATA_FILE);
let writes = 0;

let writeChain = Promise.resolve();
function save() {
  writes++;
  const snapshot = JSON.stringify(store);
  writeChain = writeChain.then(() => new Promise((res) => {
    try {
      fs.mkdirSync(DATA_DIR, { recursive: true });
      const tmp = DATA_FILE + '.tmp';
      fs.writeFileSync(tmp, snapshot);
      fs.renameSync(tmp, DATA_FILE);
    } catch (e) { console.error('save error:', e.message); }
    res();
  }));
  pushBackup();
  return writeChain;
}

// ── Off-box mirror ───────────────────────────────────────────────────────────
// A boot that can't read the mirror never writes to it: the empty list it holds
// would otherwise replace every RSVP taken so far.
const MIRRORED  = Boolean(BACKUP_URL && BACKUP_KEY);
let restoreDone = !MIRRORED || hadLocalFile;
let pushWaiting = false;
let pushTimer   = null;

function pushBackup(now) {
  if (!MIRRORED) return;
  if (!restoreDone) { pushWaiting = true; return; }
  if (pushTimer) clearTimeout(pushTimer);
  const send = () => {
    pushTimer = null;
    return fetch(BACKUP_URL, {
      method: 'PUT',
      headers: { 'x-staff-key': BACKUP_KEY, 'Content-Type': 'application/json' },
      body: JSON.stringify(store),
    }).catch((e) => console.error('backup push failed:', e.message));
  };
  if (now) return send();
  pushTimer = setTimeout(send, 1500);
}

let restoring = Promise.resolve();
function restoreFromBackup() { return (restoring = doRestore()); }
async function doRestore() {
  if (restoreDone) return;
  try {
    const r = await fetch(BACKUP_URL, { headers: { 'x-staff-key': BACKUP_KEY } });
    if (r.status === 404) {
      console.log('mirror is empty — starting fresh');
    } else if (!r.ok) {
      throw new Error('mirror answered ' + r.status);
    } else {
      const d = await r.json();
      if (!d || !Array.isArray(d.rsvps)) throw new Error('mirror held nothing usable');
      if (writes) {
        // Someone submitted during the few seconds before the mirror answered. Keep
        // both: the stored records plus anything new that isn't already among them.
        const restored = normalize(d);
        const seen = new Set(restored.rsvps.map((r) => r.id).concat(restored.testdrives.map((t) => t.id)));
        for (const r of store.rsvps) if (!seen.has(r.id)) restored.rsvps.push(r);
        for (const t of store.testdrives) if (!seen.has(t.id)) restored.testdrives.push(t);
        store = restored;
        console.log('merged the mirror with submissions taken during boot');
      } else {
        store = normalize(d);
        console.log('restored ' + store.rsvps.length + ' RSVPs and ' + store.testdrives.length + ' test drives');
      }
    }
    restoreDone = true;
    if (!hadLocalFile || writes) save();
    if (pushWaiting) { pushWaiting = false; pushBackup(); }
  } catch (e) {
    // Don't push (it could replace every stored RSVP with this near-empty list) and
    // don't give up either: keep retrying, and merge whatever came in meanwhile.
    console.error('mirror read failed, retrying in 30s — pushes are held until it answers:', e.message);
    setTimeout(restoreFromBackup, 30000).unref();
  }
}

// Seat caps and duplicate checks are only right once the stored list is loaded, so a
// submission that arrives during boot waits for it (briefly) instead of guessing.
async function ready() {
  if (restoreDone) return true;
  await Promise.race([restoring, new Promise((r) => setTimeout(r, 8000))]);
  return restoreDone;
}
const NOT_READY = { error: 'The RSVP system is just waking up. Please press the button again in a few seconds.' };

// ── Helpers ──────────────────────────────────────────────────────────────────
const uuid = () => crypto.randomUUID();
function s(v, max) { return typeof v === 'string' ? v.trim().replace(/\s+/g, ' ').slice(0, max) : ''; }
const emailOk = (e) => /^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/.test(e);
function clientIp(req) {
  const xf = req.headers['x-forwarded-for'];
  return (xf ? String(xf).split(',')[0].trim() : '') || req.socket.remoteAddress || 'unknown';
}
function sendJson(res, code, obj) {
  res.writeHead(code, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' });
  res.end(JSON.stringify(obj));
}
function readBody(req) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let size = 0;
    req.on('data', (c) => {
      size += c.length;
      if (size > 32768) { reject(new Error('too large')); req.destroy(); return; }
      chunks.push(c);
    });
    req.on('end', () => {
      try {
        const text = Buffer.concat(chunks).toString('utf8');
        resolve(text ? JSON.parse(text) : {});
      } catch (e) { reject(e); }
    });
    req.on('error', reject);
  });
}

// A family on one phone may submit a few; a script may not. 20 submissions / hour / IP.
const hits = new Map();
function allowSubmit(ip) {
  const now = Date.now(), win = 3600000, max = 20;
  const arr = (hits.get(ip) || []).filter((t) => now - t < win);
  if (arr.length >= max) { hits.set(ip, arr); return false; }
  arr.push(now); hits.set(ip, arr);
  if (hits.size > 20000) for (const [k, v] of hits) if (v.every((t) => now - t > win)) hits.delete(k);
  return true;
}

// Seats taken at an event = everyone who said they're coming plus their guest.
function seatsTaken(eventId, exceptId) {
  let n = 0;
  for (const r of store.rsvps) if (r.id !== exceptId) n += Number(r.events && r.events[eventId]) || 0;
  return n;
}
function counts() {
  const out = {};
  for (const e of EVENTS) {
    const taken = seatsTaken(e.id);
    const cap = e.capped ? Number(store.settings.caps[e.id]) || DEFAULT_CAP : null;
    out[e.id] = { taken, cap, left: cap == null ? null : Math.max(0, cap - taken), full: cap != null && taken >= cap };
  }
  return out;
}
function publicInfo() {
  return {
    events: EVENTS, categories: CATEGORIES, counts: counts(),
    nights: NIGHTS, dealers: DEALERS,
  };
}
function csvCell(v) {
  const t = v == null ? '' : String(v);
  // A leading = + - @ would run as a formula when the CSV is opened in Excel.
  const safe = /^[=+\-@]/.test(t) ? "'" + t : t;
  return /[",\n]/.test(safe) ? '"' + safe.replace(/"/g, '""') + '"' : safe;
}
function sendCsv(res, name, lines) {
  res.writeHead(200, {
    'Content-Type': 'text/csv; charset=utf-8',
    'Content-Disposition': 'attachment; filename="' + name + '"',
    'Cache-Control': 'no-store',
  });
  res.end('﻿' + lines.join('\r\n'));
}

// ── Validation ───────────────────────────────────────────────────────────────
function readRsvp(b) {
  const r = {
    name: s(b.name, 100), email: s(b.email, 160).toLowerCase(), phone: s(b.phone, 40),
    category: s(b.category, 40), guest: s(b.guest, 100), notes: s(b.notes, 400), events: {},
  };
  if (!r.name) return { error: 'Please enter your name.' };
  if (!emailOk(r.email)) return { error: 'Please enter a valid email address.' };
  if (!CATEGORIES.includes(r.category))
    return { error: 'Please choose Veteran, Active Duty Military, First Responder, Teacher or Student.' };
  const ev = b.events && typeof b.events === 'object' ? b.events : {};
  let any = false, guests = false;
  for (const e of EVENTS) {
    const n = Math.round(Number(ev[e.id]) || 0);
    const party = n >= 2 ? 2 : n === 1 ? 1 : 0; // yourself, plus at most one guest
    if (party && r.category === 'Student' && !e.students)
      return { error: 'Students are welcome at the Final Dress Rehearsal only. ' + e.name + ' is for Veterans, Active Duty Military, First Responders and Teachers.' };
    if (party) r.events[e.id] = party;
    if (party) any = true;
    if (party === 2) guests = true;
  }
  if (!any) return { error: 'Choose at least one event you\'ll attend.' };
  if (!guests) r.guest = '';
  if (b.confirm !== true) return { error: 'Please confirm the eligibility statement.' };
  return { rec: r };
}

function readTestDrive(b) {
  const t = {
    name: s(b.name, 100), email: s(b.email, 160).toLowerCase(), phone: s(b.phone, 40),
    night: s(b.night, 20), dealer: s(b.dealer, 60), ticket: s(b.ticket, 60),
    seats: Number(b.seats) === 1 ? 1 : 2, // a ticket admits the holder + 1 guest unless they say otherwise
  };
  if (!t.name) return { error: 'Please enter your name.' };
  if (!emailOk(t.email)) return { error: 'Please enter a valid email address.' };
  if (!NIGHTS.some((n) => n.id === t.night)) return { error: 'Please choose a show night.' };
  if (!DEALERS.includes(t.dealer)) return { error: 'Please choose where you took your test ride or test drive.' };
  if (b.ack !== true) return { error: 'Please check the box confirming your test ride or test drive.' };
  if (!t.ticket) return { error: 'Please enter your ticket number.' };
  return { rec: t };
}
const ticketKey = (t) => String(t).toUpperCase().replace(/[\s-]+/g, '');

// ── Static pages ─────────────────────────────────────────────────────────────
function sendFile(res, file, type) {
  fs.readFile(path.join(PUBLIC_DIR, file), (err, buf) => {
    if (err) { res.writeHead(404, { 'Content-Type': 'text/plain' }); res.end('Not found'); return; }
    res.writeHead(200, { 'Content-Type': type, 'Cache-Control': 'no-store' });
    res.end(buf);
  });
}

// ── Router ───────────────────────────────────────────────────────────────────
const server = http.createServer(async (req, res) => {
  res.setHeader('Content-Security-Policy',
    "default-src 'self'; script-src 'self' 'unsafe-inline'; style-src 'self' 'unsafe-inline' https://fonts.googleapis.com; font-src 'self' https://fonts.gstatic.com; img-src 'self' data:; connect-src 'self'; base-uri 'self'; form-action 'self'");
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('X-Frame-Options', 'SAMEORIGIN');
  res.setHeader('Referrer-Policy', 'strict-origin-when-cross-origin');

  const url = new URL(req.url, 'http://localhost');
  const p = url.pathname.replace(/\/+$/, '') || '/';
  const method = req.method;
  const html = 'text/html; charset=utf-8';

  try {
    if (method === 'GET' && (p === '/' || p === '/rsvp')) return sendFile(res, 'rsvp.html', html);
    if (method === 'GET' && (p === '/testdrive' || p === '/test-drive' || p === '/td'))
      return sendFile(res, 'testdrive.html', html);
    if (method === 'GET' && /^\/(testdrive|test-drive|td)\/(manage|staff|admin)\/?$/.test(p)) {
      res.writeHead(302, { Location: '/manage#testdrive' }); return res.end();
    }
    if (method === 'GET' && (p === '/manage' || p === '/staff' || p === '/admin')) {
      res.setHeader('X-Robots-Tag', 'noindex, nofollow');
      return sendFile(res, 'manage.html', html);
    }
    if (method === 'GET' && (p === '/poster.css' || p === '/app.css')) return sendFile(res, p.slice(1), 'text/css; charset=utf-8');
    if (method === 'GET' && p === '/health')
      return sendJson(res, 200, { ok: true, rsvps: store.rsvps.length, testdrives: store.testdrives.length });

    // ── PUBLIC API: seat counts in, submissions out. No one's details ever leave. ──
    if (method === 'GET' && p === '/api/info') return sendJson(res, 200, publicInfo());

    if (method === 'POST' && p === '/api/rsvp') {
      if (!allowSubmit(clientIp(req))) return sendJson(res, 429, { error: 'Too many submissions from this connection. Try again in an hour.' });
      if (!(await ready())) return sendJson(res, 503, NOT_READY);
      const b = await readBody(req);
      if (s(b.website, 100)) return sendJson(res, 200, { ok: true }); // honeypot: bots fill every field
      const { rec, error } = readRsvp(b);
      if (error) return sendJson(res, 400, { error });
      if (store.rsvps.some((x) => x.email === rec.email))
        return sendJson(res, 409, { error: 'An RSVP under ' + rec.email + ' is already on the list. To change it, reply to your confirmation or contact the box office.' });
      // Check every capped event before committing any of them. This block has no
      // await in it, so two people can't both take the last seat.
      for (const e of EVENTS) {
        if (!e.capped || !rec.events[e.id]) continue;
        const cap = Number(store.settings.caps[e.id]) || DEFAULT_CAP;
        const left = cap - seatsTaken(e.id);
        if (rec.events[e.id] > left) {
          return sendJson(res, 409, {
            error: left <= 0
              ? e.name + ' is full.'
              : e.name + ' has only ' + left + ' seat left — choose "Just me", or skip this dinner.',
            counts: counts(),
          });
        }
      }
      rec.id = uuid();
      rec.created_at = new Date().toISOString();
      store.rsvps.push(rec);
      save();
      return sendJson(res, 200, { ok: true, rsvp: { id: rec.id, name: rec.name, events: rec.events, guest: rec.guest }, counts: counts() });
    }

    if (method === 'POST' && p === '/api/testdrive') {
      if (!allowSubmit(clientIp(req))) return sendJson(res, 429, { error: 'Too many submissions from this connection. Try again in an hour.' });
      if (!(await ready())) return sendJson(res, 503, NOT_READY);
      const b = await readBody(req);
      if (s(b.website, 100)) return sendJson(res, 200, { ok: true });
      const { rec, error } = readTestDrive(b);
      if (error) return sendJson(res, 400, { error });
      if (store.testdrives.some((x) => ticketKey(x.ticket) === ticketKey(rec.ticket)))
        return sendJson(res, 409, { error: 'Ticket number ' + rec.ticket + ' has already been used to reserve a seat. Check the number on your ticket, or contact the box office.' });
      rec.id = uuid();
      rec.created_at = new Date().toISOString();
      store.testdrives.push(rec);
      save();
      return sendJson(res, 200, { ok: true, testdrive: { id: rec.id, name: rec.name, night: rec.night, dealer: rec.dealer, ticket: rec.ticket, seats: rec.seats } });
    }

    // ── STAFF API (key-gated) ───────────────────────────────────────────────
    if (p.startsWith('/api/staff/')) {
      const provided = String(req.headers['x-staff-key'] || url.searchParams.get('key') || '');
      const want = String(store.settings.staff_key);
      const ok = provided.length === want.length &&
        crypto.timingSafeEqual(Buffer.from(provided), Buffer.from(want));
      if (!ok) return sendJson(res, 401, { error: 'That access key is not right.' });

      if (method === 'GET' && p === '/api/staff/list') {
        return sendJson(res, 200, Object.assign(publicInfo(), {
          rsvps: store.rsvps, testdrives: store.testdrives,
          trash: store.trash.slice(0, 50), caps: store.settings.caps, dealer_block: DEALER_BLOCK,
        }));
      }

      if (method === 'GET' && p === '/api/staff/rsvps.csv') {
        const lines = [['Name', 'Email', 'Phone', 'I am a'].concat(EVENTS.map((e) => e.name + ' (seats)'), ['Guest', 'Notes', 'Submitted']).join(',')];
        for (const r of store.rsvps) {
          lines.push([r.name, r.email, r.phone, r.category].concat(EVENTS.map((e) => r.events[e.id] || ''), [r.guest, r.notes, r.created_at]).map(csvCell).join(','));
        }
        return sendCsv(res, 'afgm-rsvps.csv', lines);
      }
      if (method === 'GET' && p === '/api/staff/testdrives.csv') {
        const lines = [['Name', 'Email', 'Phone', 'Show night', 'Dealership', 'Ticket #', 'Seats', 'Submitted'].join(',')];
        for (const t of store.testdrives) {
          const night = (NIGHTS.find((n) => n.id === t.night) || {}).label || t.night;
          lines.push([t.name, t.email, t.phone, night, t.dealer, t.ticket, t.seats || 2, t.created_at].map(csvCell).join(','));
        }
        return sendCsv(res, 'afgm-test-ride-drive-tickets.csv', lines);
      }

      const del = p.match(/^\/api\/staff\/(rsvps|testdrives)\/([\w-]{1,60})$/);
      if (method === 'DELETE' && del) {
        const list = store[del[1]];
        const i = list.findIndex((x) => x.id === del[2]);
        if (i === -1) return sendJson(res, 404, { error: 'Already removed.' });
        const [rec] = list.splice(i, 1);
        store.trash.unshift({ kind: del[1], rec, removed_at: new Date().toISOString() });
        store.trash = store.trash.slice(0, 50);
        save();
        return sendJson(res, 200, { ok: true });
      }

      if (method === 'POST' && p === '/api/staff/restore') {
        const id = s((await readBody(req)).id, 60);
        const i = store.trash.findIndex((x) => x.rec && x.rec.id === id);
        if (i === -1) return sendJson(res, 404, { error: 'Nothing left to undo for that entry.' });
        const [t] = store.trash.splice(i, 1);
        store[t.kind].push(t.rec);
        save();
        return sendJson(res, 200, { ok: true });
      }

      if (method === 'POST' && p === '/api/staff/caps') {
        const b = await readBody(req);
        for (const id of ['dd', 'vdd']) {
          if (!Object.prototype.hasOwnProperty.call(b, id)) continue;
          const n = Math.round(Number(b[id]));
          if (!Number.isFinite(n) || n < 1 || n > 2000) return sendJson(res, 400, { error: 'Caps must be between 1 and 2000.' });
          store.settings.caps[id] = n;
        }
        save();
        return sendJson(res, 200, { ok: true, caps: store.settings.caps, counts: counts() });
      }

      if (method === 'POST' && p === '/api/staff/key') {
        const k = s((await readBody(req)).key, 80);
        if (k.length < 6) return sendJson(res, 400, { error: 'Use at least 6 characters.' });
        store.settings.staff_key = k;
        save();
        return sendJson(res, 200, { ok: true });
      }

      return sendJson(res, 404, { error: 'Not found' });
    }

    res.writeHead(404, { 'Content-Type': 'text/plain' });
    res.end('Not found');
  } catch (e) {
    console.error(e);
    sendJson(res, 400, { error: 'Bad request.' });
  }
});

process.on('SIGTERM', () => {
  Promise.resolve(pushBackup(true)).finally(() => process.exit(0));
  setTimeout(() => process.exit(0), 4000).unref();
});

server.listen(PORT, () => {
  console.log('AFGM RSVP running on http://localhost:' + PORT + '  (/  /testdrive  /manage)');
  restoreFromBackup();
});
