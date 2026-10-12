// mail.js — confirmation email for the RSVP and Test Ride / Test Drive pages.
//
// Two ways out of the building, both written against the standard library so the app
// stays zero-dependency like the rest of this build:
//
//   1. Resend's HTTP API, used whenever RESEND_API_KEY is set. Nothing to authenticate
//      but a bearer token, and every send lands in a dashboard with its delivery and
//      bounce status, which is the part staff can actually read.
//   2. A complete SMTP client in net + tls — STARTTLS on 587, implicit TLS on 465,
//      AUTH LOGIN — for a plain mailbox. This is the fallback when there is no API key.
//
// Everything is queued either way. A form submission never waits on a mail server, and
// a mail server that is down or wrong never fails an RSVP — the record is already saved
// and the manage page shows the send as failed so staff can press Resend.

const net   = require('net');
const tls   = require('tls');
const https = require('https');
const path  = require('path');

const RESEND_KEY = (process.env.RESEND_API_KEY || '').trim();

const HOST      = process.env.MAIL_HOST || 'smtp.ionos.com';
const PORT      = Number(process.env.MAIL_PORT || 587);
const USER      = process.env.MAIL_USER || '';
const PASS      = process.env.MAIL_PASS || '';
const FROM      = (process.env.MAIL_FROM || USER).trim();
const FROM_NAME = process.env.MAIL_FROM_NAME || 'Bold Theatre Box Office';
const REPLY_TO  = (process.env.MAIL_REPLY_TO || FROM).trim();
const BCC       = (process.env.MAIL_BCC || '').trim(); // optional copy to the box office

const configured = () => Boolean(FROM && (RESEND_KEY || (HOST && PORT && USER && PASS)));

// ── Resend ───────────────────────────────────────────────────────────────────
// One POST per message. Resend answers with the id it filed the message under, which
// is what you search for in their dashboard when someone says the email never came.
function post(m, to) {
  return new Promise((resolve, reject) => {
    const payload = JSON.stringify({
      from: addr(FROM_NAME, FROM),
      to,
      reply_to: REPLY_TO,
      subject: FOLD(m.subject),
      text: m.text,
      html: m.html,
    });
    const req = https.request({
      host: 'api.resend.com',
      path: '/emails',
      method: 'POST',
      headers: {
        'Authorization': 'Bearer ' + RESEND_KEY,
        'Content-Type': 'application/json',
        'Content-Length': Buffer.byteLength(payload),
      },
      timeout: 30000,
    }, (res) => {
      let body = '';
      res.setEncoding('utf8');
      res.on('data', (c) => { body += c; });
      res.on('end', () => {
        if (res.statusCode >= 200 && res.statusCode < 300) return resolve(body.slice(0, 200));
        // Resend returns {"message":"..."} on a refusal — surface it, it is the whole
        // diagnosis (unverified domain, bad key, invalid address).
        let why = body.slice(0, 200);
        try { why = JSON.parse(body).message || why; } catch (e) {}
        reject(new Error('Resend ' + res.statusCode + ': ' + why));
      });
    });
    req.on('timeout', () => { req.destroy(new Error('Resend timed out')); });
    req.on('error', reject);
    req.end(payload);
  });
}

// ── SMTP ─────────────────────────────────────────────────────────────────────
// One short-lived connection per message. At this volume (a few hundred over a run)
// connection reuse buys nothing and costs a whole class of stale-socket bugs.
function talk(envelope, body) {
  return new Promise((resolve, reject) => {
    let sock = null;
    let done = false;
    let buf = '';
    let waiting = null; // { want: [codes], resolve, reject }
    const log = [];

    const finish = (err) => {
      if (done) return;
      done = true;
      try { if (sock) sock.destroy(); } catch (e) {}
      if (err) {
        err.smtp = log.slice(-6).join(' | ');
        reject(err);
      } else resolve();
    };

    const timer = setTimeout(() => finish(new Error('SMTP timed out')), 45000);
    timer.unref();

    // A reply may run over several lines: 250-FIRST, then 250 LAST. Only the line
    // with a space after the code ends it.
    function onData(chunk) {
      buf += chunk.toString('utf8');
      let m;
      while ((m = buf.match(/^(?:\d{3}-[^\n]*\n)*(\d{3}) [^\n]*\n/))) {
        const reply = buf.slice(0, m[0].length);
        buf = buf.slice(m[0].length);
        const code = Number(m[1]);
        log.push(reply.trim().replace(/\s+/g, ' ').slice(0, 160));
        const w = waiting;
        waiting = null;
        if (!w) continue;
        if (w.want.includes(code)) w.resolve(reply);
        else w.reject(new Error('SMTP ' + code + ': ' + reply.trim().split('\n').pop()));
      }
    }

    const expect = (...want) => new Promise((res, rej) => { waiting = { want, resolve: res, reject: rej }; });
    const say = (line) => { sock.write(line + '\r\n'); };
    const cmd = (line, ...want) => { say(line); return expect(...want); };

    const b64 = (v) => Buffer.from(String(v), 'utf8').toString('base64');

    (async () => {
      const implicit = PORT === 465;
      sock = implicit
        ? tls.connect({ host: HOST, port: PORT, servername: HOST })
        : net.connect({ host: HOST, port: PORT });
      sock.setEncoding('utf8');
      sock.on('data', onData);
      sock.on('error', (e) => finish(e));
      sock.on('close', () => { if (!done) finish(new Error('SMTP connection closed early')); });

      await new Promise((res, rej) => {
        sock.once(implicit ? 'secureConnect' : 'connect', res);
        sock.once('error', rej);
      });

      await expect(220);
      const me = (FROM.split('@')[1] || 'localhost');
      await cmd('EHLO ' + me, 250);

      if (!implicit) {
        await cmd('STARTTLS', 220);
        sock.removeListener('data', onData);
        const plain = sock;
        sock = tls.connect({ socket: plain, servername: HOST });
        sock.setEncoding('utf8');
        sock.on('data', onData);
        sock.on('error', (e) => finish(e));
        sock.on('close', () => { if (!done) finish(new Error('SMTP connection closed early')); });
        await new Promise((res, rej) => { sock.once('secureConnect', res); sock.once('error', rej); });
        await cmd('EHLO ' + me, 250);
      }

      await cmd('AUTH LOGIN', 334);
      await cmd(b64(USER), 334);
      await cmd(b64(PASS), 235);

      await cmd('MAIL FROM:<' + envelope.from + '>', 250);
      for (const to of envelope.to) await cmd('RCPT TO:<' + to + '>', 250, 251);
      await cmd('DATA', 354);
      // Dot-stuffing: a line that is just "." would end the message early.
      sock.write(body.replace(/\r?\n\./g, '\r\n..') + '\r\n.\r\n');
      await expect(250);
      say('QUIT');
      clearTimeout(timer);
      finish(null);
    })().catch(finish);
  });
}

// ── Message assembly ─────────────────────────────────────────────────────────
const FOLD = (v) => String(v).replace(/[\r\n]+/g, ' ').trim();

// A name with an accent or an em dash has to be encoded or it arrives as mojibake.
function header(v) {
  const t = FOLD(v);
  if (/^[\x20-\x7e]*$/.test(t)) return t;
  return '=?UTF-8?B?' + Buffer.from(t, 'utf8').toString('base64') + '?=';
}
function addr(name, email) {
  const n = header(name);
  return n ? '"' + n.replace(/"/g, '') + '" <' + email + '>' : email;
}
function b64body(text) {
  return Buffer.from(text.replace(/\r?\n/g, '\r\n'), 'utf8')
    .toString('base64').replace(/(.{76})/g, '$1\r\n');
}

let seq = 0;
function build(m) {
  const domain = FROM.split('@')[1] || 'localhost';
  const boundary = 'afgm' + Date.now().toString(36) + (seq++).toString(36);
  const h = [
    'From: ' + addr(FROM_NAME, FROM),
    'To: ' + addr(m.toName || '', m.to),
    'Reply-To: ' + REPLY_TO,
    'Subject: ' + header(m.subject),
    'Date: ' + new Date().toUTCString(),
    'Message-ID: <' + Date.now().toString(36) + '.' + Math.random().toString(36).slice(2) + '@' + domain + '>',
    'MIME-Version: 1.0',
    'Auto-Submitted: auto-generated',
    'X-Entity-Ref-ID: ' + (m.ref || ''),
    'Content-Type: multipart/alternative; boundary="' + boundary + '"',
  ].join('\r\n');

  const parts = [
    '--' + boundary,
    'Content-Type: text/plain; charset=UTF-8',
    'Content-Transfer-Encoding: base64',
    '',
    b64body(m.text),
    '--' + boundary,
    'Content-Type: text/html; charset=UTF-8',
    'Content-Transfer-Encoding: base64',
    '',
    b64body(m.html),
    '--' + boundary + '--',
    '',
  ].join('\r\n');

  return h + '\r\n\r\n' + parts;
}

// ── Queue ────────────────────────────────────────────────────────────────────
// One at a time, three tries, widening gaps. The caller gets a callback either way
// so the record can carry its own send status.
const queue = [];
let running = false;

function send(m) {
  return new Promise((resolve, reject) => {
    queue.push({ m, tries: 0, resolve, reject });
    pump();
  });
}

async function pump() {
  if (running) return;
  running = true;
  while (queue.length) {
    const job = queue.shift();
    try {
      if (!configured()) throw new Error('mail is not configured (RESEND_API_KEY or MAIL_USER / MAIL_PASS, plus MAIL_FROM)');
      const to = [job.m.to].concat(BCC ? [BCC] : []);
      if (RESEND_KEY) await post(job.m, to);
      else await talk({ from: FROM, to }, build(job.m));
      job.resolve({ ok: true, at: new Date().toISOString() });
    } catch (e) {
      job.tries++;
      if (job.tries < 3 && configured()) {
        const wait = job.tries * 20000;
        console.error('mail attempt ' + job.tries + ' to ' + job.m.to + ' failed (' + e.message + '); retrying in ' + (wait / 1000) + 's');
        setTimeout(() => { queue.push(job); pump(); }, wait).unref();
      } else {
        console.error('mail to ' + job.m.to + ' gave up: ' + e.message + (e.smtp ? ' [' + e.smtp + ']' : ''));
        job.resolve({ ok: false, at: new Date().toISOString(), error: e.message });
      }
    }
  }
  running = false;
}

module.exports = { send, configured, pending: () => queue.length };
