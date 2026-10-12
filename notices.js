// notices.js — the two confirmation emails, in plain text and in HTML.
//
// Every fact in these messages is read off the record that was just saved or off the
// event tables in server.js. Nothing is restated from memory, so a changed curtain
// time changes the email with it.

const SHOW   = 'A Few Good Men';
const VENUE  = 'Rialto Community Arts Center';
const STREET = '215 E Broadway St, Morrilton, AR';
const ADVISORY =
  SHOW + ' is a military courtroom drama and contains strong language throughout, along with ' +
  'references to hazing, suicide and the death of a service member. Recommended for older teens and adults.';

const esc = (v) => String(v == null ? '' : v)
  .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');

const seatWord = (n) => (n === 1 ? 'Just you — 1 seat' : 'You and one guest — 2 seats');

// ── Shared shell ─────────────────────────────────────────────────────────────
// Email clients ignore most of a stylesheet, so the look lives in inline styles on
// tables: ivory stock, navy rules, a brass hairline. The same light palette as the
// pages themselves.
function page(title, kicker, rowsHtml, closingHtml) {
  return `<!doctype html><html><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1"><title>${esc(title)}</title></head>
<body style="margin:0;padding:0;background:#efebdf;">
<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="background:#efebdf;padding:24px 12px;">
<tr><td align="center">
<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="max-width:600px;background:#f7f4ea;border:1px solid #d6cdb4;border-radius:4px;">
  <tr><td style="background:#152c52;padding:22px 26px;border-bottom:4px solid #b22234;">
    <div style="font:600 12px/1.5 Georgia,'Times New Roman',serif;letter-spacing:.18em;text-transform:uppercase;color:#c8b273;">Bold Theatre</div>
    <div style="font:700 30px/1.15 Georgia,'Times New Roman',serif;color:#e6d8ad;letter-spacing:.02em;margin-top:4px;">${esc(SHOW)}</div>
    <div style="font:400 14px/1.5 Georgia,'Times New Roman',serif;color:#cdd6e6;margin-top:6px;">${esc(kicker)}</div>
  </td></tr>
  <tr><td style="padding:26px;">
    <h1 style="margin:0 0 14px;font:700 22px/1.25 Georgia,'Times New Roman',serif;color:#152c52;">${esc(title)}</h1>
    <table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="font:400 16px/1.6 Georgia,'Times New Roman',serif;color:#2a2a2a;">
      ${rowsHtml}
    </table>
    ${closingHtml}
  </td></tr>
  <tr><td style="padding:0 26px 22px;">
    <div style="border-top:1px solid #d6cdb4;padding-top:16px;font:400 14px/1.6 Georgia,'Times New Roman',serif;color:#4a4740;">
      <b style="color:#152c52;">${esc(VENUE)}</b><br>${esc(STREET)}
    </div>
    <div style="margin-top:14px;padding:12px 14px;background:#f1e6e6;border-left:4px solid #b22234;font:400 13px/1.55 Georgia,'Times New Roman',serif;color:#4a2a2a;">
      <b style="letter-spacing:.06em;text-transform:uppercase;font-size:12px;">Content advisory</b><br>${esc(ADVISORY)}
    </div>
  </td></tr>
</table>
</td></tr></table>
</body></html>`;
}

const row = (label, value) =>
  `<tr><td style="padding:8px 0;border-bottom:1px solid #e3dcc8;width:38%;vertical-align:top;font:600 13px/1.5 Georgia,'Times New Roman',serif;letter-spacing:.06em;text-transform:uppercase;color:#6b6450;">${esc(label)}</td>` +
  `<td style="padding:8px 0;border-bottom:1px solid #e3dcc8;vertical-align:top;color:#1d1d1d;">${value}</td></tr>`;

const note = (text) =>
  `<p style="margin:18px 0 0;font:400 15px/1.6 Georgia,'Times New Roman',serif;color:#4a4740;">${text}</p>`;

// ── RSVP ─────────────────────────────────────────────────────────────────────
// What a person "chose" for a night is read back out of the seat counts, the same way
// the manage page reads them, so the email can never disagree with the list.
function rsvpChoices(rec, ctx) {
  const out = [];
  for (const g of ctx.EVENINGS) {
    const dn = Number(rec.events[g.dinner]) || 0;
    const sh = Number(rec.events[g.show]) || 0;
    if (!dn && !sh) continue;
    const seats = Math.max(dn, sh);
    let what, when;
    if (dn && sh) { what = g.both_label; when = g.both_note; }
    else if (dn)  { what = g.dinner_label; when = g.dinner_note; }
    else          { what = g.show_label; when = g.show_note; }
    out.push({ night: g.name, date: g.when, what, when, seats });
  }
  return out;
}

function rsvpNotice(rec, ctx) {
  const picks = rsvpChoices(rec, ctx);
  const subject = 'Your RSVP is confirmed — ' + SHOW + ' at the Rialto';

  const lines = [
    rec.name + ',',
    '',
    "You're on the list. Here is what we have for you:",
    '',
  ];
  for (const p of picks) {
    lines.push(p.night.toUpperCase() + ' — ' + p.date);
    lines.push('  ' + p.what + ' (' + p.when + ')');
    lines.push('  ' + seatWord(p.seats));
    if (p.seats === 2 && rec.guest) lines.push('  Guest: ' + rec.guest);
    lines.push('');
  }
  lines.push('Attending as: ' + rec.category);
  if (rec.notes) lines.push('You told us: ' + rec.notes);
  lines.push('');
  lines.push('Where: ' + VENUE + ', ' + STREET);
  lines.push('');
  lines.push('There is nothing to print and no ticket to collect — your name is at the door.');
  lines.push('Please arrive 20 minutes before the time above so we can seat you.');
  lines.push('');
  lines.push('Need to change or cancel? Reply to this email and we will take care of it.');
  lines.push('');
  lines.push('CONTENT ADVISORY');
  lines.push(ADVISORY);
  lines.push('');
  lines.push(VENUE + ' · ' + STREET);

  const rows = picks.map((p) => row(
    p.night,
    '<b>' + esc(p.date) + '</b><br>' + esc(p.what) +
    '<span style="color:#6b6450;"> — ' + esc(p.when) + '</span><br>' +
    '<span style="color:#b22234;font-weight:600;">' + esc(seatWord(p.seats)) + '</span>' +
    (p.seats === 2 && rec.guest ? '<br><span style="color:#6b6450;">Guest: ' + esc(rec.guest) + '</span>' : '')
  )).join('') + row('Attending as', esc(rec.category)) +
    (rec.notes ? row('You told us', esc(rec.notes)) : '');

  const closing =
    note('There is nothing to print and no ticket to collect — <b>your name is at the door.</b> Please arrive about 20 minutes before the time above so we can seat you.') +
    note('Need to change or cancel? <b>Reply to this email</b> and we will take care of it.');

  return {
    subject,
    text: lines.join('\n'),
    html: page("You're on the list", 'Special Evenings · November 2026', rows, closing),
  };
}

// ── Test ride / test drive ───────────────────────────────────────────────────
function testDriveNotice(rec, ctx) {
  const night = (ctx.NIGHTS.find((n) => n.id === rec.night) || {}).label || rec.night;
  const seats = Number(rec.seats) === 1 ? 1 : 2;
  const subject = 'Your seat is reserved — ' + SHOW + ', ' + night;

  const text = [
    rec.name + ',',
    '',
    'Your Test Ride / Test Drive seat is reserved.',
    '',
    'Night:        ' + night,
    'Dealership:   ' + rec.dealer,
    'Ticket #:     ' + rec.ticket,
    'Seats held:   ' + seatWord(seats),
    '',
    'Where: ' + VENUE + ', ' + STREET,
    '',
    'Bring the ticket the dealership gave you to the box office on that night. Your',
    'seats are held under your name — please arrive 20 minutes before curtain.',
    '',
    'Need a different night? Reply to this email and we will move it.',
    '',
    'CONTENT ADVISORY',
    ADVISORY,
    '',
    VENUE + ' · ' + STREET,
  ].join('\n');

  const rows =
    row('Night', '<b>' + esc(night) + '</b>') +
    row('Dealership', esc(rec.dealer)) +
    row('Ticket number', '<b style="font-family:Consolas,Menlo,monospace;letter-spacing:.08em;">' + esc(rec.ticket) + '</b>') +
    row('Seats held', '<span style="color:#b22234;font-weight:600;">' + esc(seatWord(seats)) + '</span>');

  const closing =
    note('<b>Bring the ticket the dealership gave you</b> to the box office that night. Your seats are held under your name — please arrive about 20 minutes before curtain.') +
    note('Need a different night? <b>Reply to this email</b> and we will move it.');

  return { subject, text, html: page('Your seat is reserved', 'Test Ride / Test Drive For Tickets', rows, closing) };
}

module.exports = { rsvpNotice, testDriveNotice };
