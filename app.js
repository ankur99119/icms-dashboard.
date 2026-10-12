/* ICMS Delhi Division - punctuality and detention.
 *
 * Reads the divisional Google Sheet with the signed-in officer's own Google
 * identity. The Sheet is shared with named people and is NOT published to
 * the web, so this page can sit in a public repository while the data stays
 * restricted: GitHub Pages sites are publicly reachable whether or not their
 * repository is private.
 *
 * It computes nothing that was not already validated upstream. Every figure
 * in the Sheet was reconciled against ICMS's own printed totals before it
 * was written - Report 19's scheduled/reported/RT identities, Report 16's
 * Total Delayed Trains, one primary row per train, event_key de-duplication
 * across overlapping report windows. This page filters, aggregates and
 * draws; it does not estimate, fill gaps or smooth anything.
 *
 * Two things it will not do silently:
 *   - describe a heuristic coverage check as certified completeness
 *   - sum the train-level Zone / Division / Terminating Delay columns across
 *     a train's event rows, which overstates by 60%+
 */
'use strict';

const CFG = window.ICMS_CONFIG || {};
const SCOPE = 'https://www.googleapis.com/auth/spreadsheets.readonly';
const API = 'https://sheets.googleapis.com/v4/spreadsheets/';
const SERIES = ['--series-1', '--series-2', '--series-3', '--series-4',
                '--series-5', '--series-6', '--series-7', '--series-8'];
const OTHER = '--series-other';
const MAX_SERIES = 7;          /* an eighth category folds into Other */

const $ = (id) => document.getElementById(id);
const ink = (name) => getComputedStyle(document.documentElement).getPropertyValue(name).trim();
const esc = (s) => String(s == null ? '' : s).replace(/[&<>"]/g,
  (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
const num = (n, d = 0) => (n == null || n === '' || Number.isNaN(+n))
  ? '—' : (+n).toLocaleString('en-IN', { minimumFractionDigits: d, maximumFractionDigits: d });

const state = {
  token: null, email: null, tabs: {}, present: [], view: 'overview',
  period: '7d', from: null, to: null, completeOnly: false,
  cause: null, hidden: new Set()
};

/* --- dates (IST, because the operating day is IST) ------------------- */
const istToday = () => new Date().toLocaleDateString('en-CA', { timeZone: 'Asia/Kolkata' });
const shift = (iso, days) => {
  const d = new Date(iso + 'T12:00:00Z');
  d.setUTCDate(d.getUTCDate() + days);
  return d.toISOString().slice(0, 10);
};
function windowFor() {
  return window.ICMS_PERIODS.windowFor(istToday(), state.period, state.from, state.to);
}

/* --- sign in --------------------------------------------------------- */
let tokenClient = null;

function initAuth() {
  if (!CFG.CLIENT_ID) {
    $('boot').innerHTML = 'config.js has no CLIENT_ID. Create an OAuth client ID ' +
      '(Web application) in Google Cloud Console, add this site’s origin as an ' +
      'authorised JavaScript origin, and put it in config.js.';
    $('signin').disabled = true;
    return;
  }
  if (!window.google || !google.accounts || !google.accounts.oauth2) {
    setTimeout(initAuth, 250);
    return;
  }
  tokenClient = google.accounts.oauth2.initTokenClient({
    client_id: CFG.CLIENT_ID, scope: SCOPE,
    callback: (response) => {
      if (response.error) { fail('Sign-in failed: ' + response.error); return; }
      state.token = response.access_token;
      $('signin').classList.add('hide');
      $('signout').classList.remove('hide');
      load();
    }
  });
  $('signin').disabled = false;
}

function signOut() {
  if (state.token && google.accounts.oauth2) google.accounts.oauth2.revoke(state.token, () => {});
  state.token = null; state.tabs = {}; state.present = [];
  $('signout').classList.add('hide');
  $('signin').classList.remove('hide');
  $('who').textContent = '';
  ['overview', 'punct', 'detention', 'coverage'].forEach((v) => $('v-' + v).classList.add('hide'));
  $('boot').classList.remove('hide');
  $('boot').textContent = 'Signed out.';
}

/* --- reading the Sheet ---------------------------------------------- */
async function api(path) {
  const response = await fetch(API + encodeURIComponent(CFG.SPREADSHEET_ID) + path, {
    headers: { Authorization: 'Bearer ' + state.token }
  });
  if (response.status === 401) { state.token = null; throw new Error('SIGNED_OUT'); }
  if (!response.ok) {
    const body = await response.json().catch(() => ({}));
    throw new Error((body.error && body.error.message) || ('Sheets API ' + response.status));
  }
  return response.json();
}

/* A tab the writer has not created yet is absent, not empty. Asking
   batchGet for a range that does not exist fails the whole batch, so the
   tab list is read first and only existing tabs are requested. */
let loading = false;
async function publicationState() {
  const response = await api('/values/' + encodeURIComponent('_publication'));
  const row = table(response.values || [])[0];
  if (!row || row.state !== 'committed' || !row.generation) {
    throw new Error('Publishing is unfinished. Showing only the last successfully loaded view, if available.');
  }
  return row.generation;
}
async function load() {
  if (loading || !state.token) return;
  loading = true;
  fail(null);
  $('boot').classList.remove('hide');
  $('boot').textContent = 'Reading the divisional sheet…';
  try {
    const generation = await publicationState();
    const meta = await api('?fields=sheets.properties.title,properties.title');
    state.present = (meta.sheets || []).map((s) => s.properties.title);
    const wanted = ['punctuality_daily_total', 'punctuality_daily', 'detention_daily_cause',
                    'detention_daily_section', 'detention_daily_subcause',
                    'detention_daily_band', 'detention_events', 'coverage', '_meta'].filter((t) => state.present.includes(t));
    if (!wanted.length) {
      $('boot').textContent = 'The sheet has no data tabs yet. Run the export on the collecting machine.';
      return;
    }
    const query = wanted.map((t) => 'ranges=' + encodeURIComponent(t)).join('&');
    const got = await api('/values:batchGet?' + query + '&majorDimension=ROWS');
    const tabs = {};
    (got.valueRanges || []).forEach((range, i) => { tabs[wanted[i]] = table(range.values || []); });
    if (await publicationState() !== generation) throw new Error('Data changed while being read. Reload to obtain one consistent publication.');
    state.tabs = tabs;
    $('boot').classList.add('hide');
    stamp();
    render();
  } catch (error) {
    if (error.message === 'SIGNED_OUT') { signOut(); fail('Session expired. Sign in again.'); return; }
    $('boot').classList.add('hide');
    fail(error.message);
  } finally {
    loading = false;
  }
}

/* Header row names the columns. Numeric-looking cells become numbers so
   arithmetic here never depends on locale string parsing. */
function table(values) {
  if (!values.length) return [];
  const header = values[0].map((h) => String(h).trim());
  return values.slice(1).filter((row) => row.length && String(row[0]).trim() !== '')
    .map((row) => {
      const out = {};
      header.forEach((name, i) => {
        const cell = row[i];
        out[name] = (cell === '' || cell == null) ? null
          : (/^-?\d+(\.\d+)?$/.test(String(cell).trim()) ? +cell : cell);
      });
      return out;
    });
}

function stamp() {
  const meta = state.tabs._meta || [];
  const last = meta.length ? meta[meta.length - 1] : null;
  $('scope').textContent = 'Punctuality & Detention Analysis · ' + (CFG.DIVISION || '');
  $('asOf').textContent = last
    ? 'Sheet last written ' + new Date(last.written_at_utc).toLocaleString('en-IN', { timeZone: 'Asia/Kolkata' })
    : '';
  if (state.email) $('who').textContent = state.email;
}

function fail(message) {
  const box = $('msg');
  if (!message) { box.classList.add('hide'); box.textContent = ''; return; }
  box.classList.remove('hide');
  box.textContent = message;
}

/* --- selection ------------------------------------------------------- */
function rowsIn(tab, bounds) {
  return (state.tabs[tab] || []).filter((r) => r.date >= bounds.start && r.date <= bounds.end);
}

/* Completeness is decided by the writer and carried in the Sheet, so this
   page and the exported CSV agree on which days count. */
function completeDates(bounds) {
  const set = new Set();
  rowsIn('punctuality_daily_total', bounds).forEach((r) => {
    if (r.complete === 'yes') set.add(r.date);
  });
  return set;
}

function punctRows(bounds) {
  const rows = rowsIn('punctuality_daily_total', bounds);
  if (!state.completeOnly) return rows;
  return rows.filter((r) => r.complete === 'yes');
}

/* ====================================================================
   Chart primitives. Hand-drawn SVG rather than a charting library: the
   page has no build step, must keep ICMS's 11px Arial register, and must
   load on a railway desktop that may not reach a CDN.

   Series colours are assigned in fixed order and never cycled; past seven
   categories the rest fold into Other. Every chart ships direct labels and
   a table beside it, because three of the eight slots sit below 3:1
   against white.
   ==================================================================== */

/* An SVG scaled by the browser scales its text too: the same chart reads at
   10px in a half-width panel and 24px in a full-width one. So charts are
   placed as empty boxes first, then drawn at the box's measured pixel width
   once the layout has settled, and redrawn on resize. */
let PLACED = [];
/* Ids must never repeat. The views that are not on screen stay in the DOM
   with their own placeholders, so restarting the count each render let a
   hidden view's stale box win getElementById and the visible chart drew
   into nothing. */
let placeSeq = 0;
function place(draw, minHeight) {
  const id = 'c' + (placeSeq++);
  PLACED.push({ id, draw });
  return `<div class="cw" id="${id}" style="min-height:${minHeight || 180}px"></div>`;
}
function drawPlaced() {
  PLACED.forEach((item) => {
    const box = $(item.id);
    if (!box) return;
    const width = Math.max(320, Math.round(box.clientWidth));
    box.innerHTML = item.draw(width);
    bindMarks(box);
  });
}
let resizeTimer = null;
addEventListener('resize', () => {
  clearTimeout(resizeTimer);
  resizeTimer = setTimeout(drawPlaced, 150);
});

function tip(event, html) {
  const box = $('tip');
  box.innerHTML = html;
  box.classList.remove('hide');
  const pad = 12, w = box.offsetWidth, h = box.offsetHeight;
  let x = event.clientX + pad, y = event.clientY + pad;
  if (x + w > innerWidth - 4) x = event.clientX - w - pad;
  if (y + h > innerHeight - 4) y = event.clientY - h - pad;
  box.style.left = Math.max(4, x) + 'px';
  box.style.top = Math.max(4, y) + 'px';
}
const tipOff = () => $('tip').classList.add('hide');
document.addEventListener('scroll', tipOff, true);

/* 4px rounded data-end, anchored flat to the baseline. */
function barPath(x, y, w, h, r, dir) {
  if (w <= 0 || h <= 0) return '';
  const rad = Math.min(r, dir === 'up' ? w / 2 : h / 2, dir === 'up' ? h : w);
  if (rad <= 0) return `M${x} ${y}h${w}v${h}h${-w}z`;
  if (dir === 'up') {
    return `M${x} ${y + h}v${-(h - rad)}a${rad} ${rad} 0 0 1 ${rad} ${-rad}h${w - 2 * rad}` +
           `a${rad} ${rad} 0 0 1 ${rad} ${rad}v${h - rad}z`;
  }
  return `M${x} ${y}h${w - rad}a${rad} ${rad} 0 0 1 ${rad} ${rad}v${h - 2 * rad}` +
         `a${rad} ${rad} 0 0 1 ${-rad} ${rad}h${-(w - rad)}z`;
}

function axisTicks(max, count) {
  if (!(max > 0)) return [0];
  const raw = max / count;
  const mag = Math.pow(10, Math.floor(Math.log10(raw)));
  const step = [1, 2, 2.5, 5, 10].map((m) => m * mag).find((s) => s >= raw) || mag * 10;
  const out = [];
  for (let v = 0; v <= max + step * 0.001; v += step) out.push(+v.toFixed(6));
  return out;
}

/* Trend of one measure over dates. Incomplete days are drawn hollow with a
   dashed approach, never joined into the solid line as if comparable. */
function lineChart(W, points, opts) {
  const H = opts.height || 190, M = { t: 18, r: 14, b: 26, l: 38 };
  const iw = W - M.l - M.r, ih = H - M.t - M.b;
  const top = opts.max != null ? opts.max : Math.max(1, ...points.map((p) => p.y || 0)) * 1.1;
  const ticks = axisTicks(top, 4);
  const span = ticks[ticks.length - 1] || 1;
  const px = (i) => M.l + (points.length === 1 ? iw / 2 : (i * iw) / (points.length - 1));
  const py = (v) => M.t + ih - (Math.max(0, v) / span) * ih;
  const parts = [];
  ticks.forEach((t) => {
    parts.push(`<line class="grid" x1="${M.l}" y1="${py(t)}" x2="${W - M.r}" y2="${py(t)}"/>`);
    parts.push(`<text x="${M.l - 5}" y="${py(t) + 3}" text-anchor="end">${num(t, opts.dp || 0)}</text>`);
  });
  parts.push(`<line class="axis" x1="${M.l}" y1="${M.t + ih}" x2="${W - M.r}" y2="${M.t + ih}"/>`);

  /* one solid run per unbroken stretch of complete days */
  let run = [];
  const flush = () => {
    if (run.length > 1) {
      parts.push(`<path class="line" stroke="${ink(SERIES[0])}" d="M` +
        run.map((p) => `${px(p.i)} ${py(p.y)}`).join('L') + `"/>`);
    }
    run = [];
  };
  points.forEach((p, i) => {
    if (p.y == null) { flush(); return; }
    if (p.complete) { run.push({ i, y: p.y }); } else { flush(); }
  });
  flush();
  for (let i = 1; i < points.length; i++) {
    const a = points[i - 1], b = points[i];
    if (a.y == null || b.y == null) continue;
    if (a.complete && b.complete) continue;
    parts.push(`<path class="line dash" stroke="${ink('--text-muted')}" d="M${px(i - 1)} ${py(a.y)}L${px(i)} ${py(b.y)}"/>`);
  }
  const step = Math.ceil(points.length / 12);
  points.forEach((p, i) => {
    if (p.y == null) return;
    if (p.complete) {
      parts.push(`<circle class="dot mark" cx="${px(i)}" cy="${py(p.y)}" r="4.5" ` +
        `fill="${ink(SERIES[0])}" stroke="${ink('--surface-1')}" data-tip="${esc(p.tip || '')}"/>`);
    } else {
      /* hollow, heavier ring, and a tick down to the axis: an incomplete day
         is a different kind of thing from a low day and must not be mistaken
         for one */
      parts.push(`<line class="cross" x1="${px(i)}" y1="${py(p.y)}" x2="${px(i)}" y2="${M.t + ih}"/>`);
      parts.push(`<circle class="mark" cx="${px(i)}" cy="${py(p.y)}" r="5" fill="${ink('--surface-1')}" ` +
        `stroke="${ink('--warn')}" stroke-width="2.5" data-tip="${esc(p.tip || '')}"/>`);
    }
    if (i % step === 0 || i === points.length - 1) {
      parts.push(`<text x="${px(i)}" y="${H - 8}" text-anchor="middle">${esc(p.label)}</text>`);
    }
  });
  /* direct label on the last complete point only - never a number on every point */
  const lastGood = [...points].reverse().find((p) => p.complete && p.y != null);
  if (lastGood) {
    const i = points.indexOf(lastGood);
    parts.push(`<text class="val" x="${px(i)}" y="${py(lastGood.y) - 9}" text-anchor="middle" ` +
      `font-weight="bold">${num(lastGood.y, opts.dp || 0)}${opts.suffix || ''}</text>`);
  }
  return chart(W, H, parts.join(''), opts.title);
}

function calendarPoints(points, bounds) {
  if (!points.length) return [];
  const byDate = new Map(points.map((p) => [p.date, p]));
  const out = [];
  for (let day = bounds.start; day <= bounds.end; day = shift(day, 1)) {
    out.push(byDate.get(day) || { date: day, label: day.slice(8) + '/' + day.slice(5, 7),
      y: null, complete: false, tip: 'No capture held for ' + day });
  }
  return out;
}

/* Composition over time. Segments carry a 2px surface gap. */
function stackChart(W, dates, keys, get, opts) {
  const H = opts.height || 210, M = { t: 18, r: 14, b: 26, l: 44 };
  const iw = W - M.l - M.r, ih = H - M.t - M.b;
  const totals = dates.map((d) => keys.reduce((sum, k) => sum + (get(d, k) || 0), 0));
  const ticks = axisTicks(Math.max(1, ...totals), 4);
  const span = ticks[ticks.length - 1] || 1;
  const bw = Math.max(3, Math.min(34, (iw / dates.length) * 0.68));
  const cx = (i) => M.l + (iw / dates.length) * (i + 0.5);
  const py = (v) => M.t + ih - (v / span) * ih;
  const parts = [];
  ticks.forEach((t) => {
    parts.push(`<line class="grid" x1="${M.l}" y1="${py(t)}" x2="${W - M.r}" y2="${py(t)}"/>`);
    parts.push(`<text x="${M.l - 5}" y="${py(t) + 3}" text-anchor="end">${num(t)}</text>`);
  });
  dates.forEach((d, i) => {
    let acc = 0;
    keys.forEach((k, s) => {
      const v = get(d, k) || 0;
      if (!v) return;
      const y = py(acc + v), h = py(acc) - y;
      parts.push(`<path class="mark${h > 4 ? ' seg' : ''}" fill="${ink(s < MAX_SERIES ? SERIES[s] : OTHER)}" ` +
        `d="${barPath(cx(i) - bw / 2, y, bw, h, 4, 'up')}" ` +
        `data-tip="${esc('<b>' + d + '</b><br>' + k + ': ' + num(v) + (opts.unit || ''))}"/>`);
      acc += v;
    });
  });
  parts.push(`<line class="axis" x1="${M.l}" y1="${M.t + ih}" x2="${W - M.r}" y2="${M.t + ih}"/>`);
  const step = Math.ceil(dates.length / 12);
  dates.forEach((d, i) => {
    if (i % step === 0 || i === dates.length - 1) {
      parts.push(`<text x="${cx(i)}" y="${H - 8}" text-anchor="middle">${esc(opts.label ? opts.label(d) : d)}</text>`);
    }
  });
  return chart(W, H, parts.join(''), opts.title) +
    legend(keys.map((k, s) => ({ name: k, colour: ink(s < MAX_SERIES ? SERIES[s] : OTHER) })));
}

/* Ranked magnitude. Horizontal because the labels are cause and section
   codes. Cumulative share rides as text in each row rather than as a
   second y-axis. */
function barsH(W, rows, opts) {
  const rowH = 21;
  const cumulative = opts.cumulative && W >= 520;   /* no room for it on a phone */
  const M = { t: 16, r: cumulative ? 118 : 74, b: 6, l: Math.min(92, Math.round(W * 0.26)) };
  const H = M.t + rows.length * rowH + M.b;
  const iw = W - M.l - M.r;
  const top = Math.max(1, ...rows.map((r) => r.value));
  const total = opts.total || rows.reduce((s, r) => s + r.value, 0);
  const parts = [];
  let acc = 0;
  rows.forEach((r, i) => {
    const y = M.t + i * rowH, w = (r.value / top) * iw;
    acc += r.value;
    const colour = r.colour || ink(i < MAX_SERIES ? SERIES[i] : OTHER);
    parts.push(`<text class="k" x="${M.l - 6}" y="${y + rowH / 2 + 3}" text-anchor="end" ` +
      `fill="${ink('--text-primary')}">${esc(r.label)}</text>`);
    parts.push(`<path class="mark seg" fill="${colour}" d="${barPath(M.l, y + 3, w, rowH - 7, 4, 'right')}" ` +
      `data-key="${esc(r.label)}" data-tip="${esc(r.tip || ('<b>' + r.label + '</b><br>' + num(r.value) + (opts.unit || '')))}"/>`);
    parts.push(`<text class="val" x="${M.l + w + 6}" y="${y + rowH / 2 + 3}" font-weight="bold">` +
      `${num(r.value)}${opts.unit || ''}</text>`);
    if (cumulative && total) {
      parts.push(`<text x="${W - 4}" y="${y + rowH / 2 + 3}" text-anchor="end">` +
        `${num(100 * acc / total, 1)}% cum.</text>`);
    }
  });
  return chart(W, H, parts.join(''), opts.title);
}

function chart(W, H, body, title) {
  const head = title ? `<text class="ttl" x="0" y="10">${esc(title)}</text>` : '';
  return `<svg class="chart" viewBox="0 0 ${W} ${H}" role="img" aria-label="${esc(title || 'chart')}">${head}${body}</svg>`;
}

function legend(items) {
  return '<div class="legend">' + items.map((it) =>
    `<span><i style="background:${it.colour}"></i>${esc(it.name)}</span>`).join('') + '</div>';
}

/* The table beside every chart. It is the relief for the low-contrast
   series slots and the thing an officer copies into a note. */
function grid(header, rows, opts) {
  opts = opts || {};
  const head = header.map((h) => `<th class="${h.k ? 'k' : ''}">${esc(h.t || h)}</th>`).join('');
  const body = rows.map((r) => `<tr${r._sel ? ' class="sel"' : ''}${r._key ? ' data-key="' + esc(r._key) + '"' : ''}>` +
    r.cells.map((c, i) => `<td class="${header[i] && header[i].k ? 'k' : ''}">${c}</td>`).join('') + '</tr>').join('');
  const foot = opts.total ? `<tfoot><tr>` +
    opts.total.map((c, i) => `<td class="${header[i] && header[i].k ? 'k' : ''}">${c}</td>`).join('') + `</tr></tfoot>` : '';
  return `<div class="tw${opts.scroll ? ' scroll' : ''}"><table class="g"><thead><tr>${head}</tr></thead>` +
    `<tbody>${body}</tbody>${foot}</table></div>`;
}

function tile(label, value, sub, flag) {
  return `<div class="tile${flag ? ' flag' : ''}"><div class="lab">${esc(label)}</div>` +
    `<div class="val">${value}</div><div class="sub">${esc(sub || '')}</div></div>`;
}

/* ====================================================================
   Views
   ==================================================================== */

const SLABS = [['late_1_15', '1-15 min'], ['late_16_30', '16-30'], ['late_31_45', '31-45'],
               ['late_46_60', '46-60'], ['late_over_60', 'over 60']];
const PUNCT_FIELDS = ['scheduled', 'exceptions', 'eligible', 'reported', 'not_reported',
                      'right_time', 'late'];

const sum = (rows, field) => rows.reduce((t, r) => t + (+r[field] || 0), 0);
const pct = (a, b) => (b ? (100 * a / b) : null);

function grainOf(days) { return days <= 31 ? 'day' : (days <= 183 ? 'week' : 'month'); }
function bucket(iso, grain) {
  if (grain === 'day') return iso;
  if (grain === 'month') return iso.slice(0, 7);
  const d = new Date(iso + 'T12:00:00Z');
  const jan = new Date(Date.UTC(d.getUTCFullYear(), 0, 1));
  const week = Math.floor(((d - jan) / 86400000 + jan.getUTCDay()) / 7);
  return d.getUTCFullYear() + '-W' + String(week).padStart(2, '0');
}

/* --- overview -------------------------------------------------------- */
function renderOverview(bounds) {
  const el = $('v-overview');
  const all = rowsIn('punctuality_daily_total', bounds);
  const used = punctRows(bounds);
  const det = rowsIn('detention_daily_cause', bounds);
  const detDays = new Set(det.map((r) => r.date));
  const complete = completeDates(bounds);

  const reported = sum(used, 'reported'), right = sum(used, 'right_time');
  const minutes = sum(det, 'minutes'), events = sum(det, 'events');

  const tiles = [
    tile('Originating RT %', reported ? num(pct(right, reported), 1) + '%' : '—',
         num(right) + ' of ' + num(reported) + ' reported'),
    tile('Days counted', num(used.length),
         all.length - used.length ? num(all.length - used.length) + ' coverage-check days excluded' : 'all captured days included; coverage provisional',
         all.length !== used.length),
    tile('Departures eligible', num(sum(used, 'eligible')), num(sum(used, 'not_reported')) + ' not reported'),
    tile('Trains over 60 min late', num(sum(used, 'late_over_60')),
         'of ' + num(sum(used, 'late')) + ' late'),
    tile('Detention minutes', minutes ? num(minutes) : '—',
         events ? num(events) + ' events' : 'no detention captured'),
    tile('Report 16 requested dates held', num(captureCoverage('PAM-16', bounds).dates.size),
         'Requested report windows; not event-date completeness',
         !captureCoverage('PAM-16', bounds).dates.size)
  ].join('');

  const points = calendarPoints(all.map((r) => ({
    date: r.date,
    label: r.date.slice(8) + '/' + r.date.slice(5, 7),
    y: pct(r.right_time, r.reported), complete: r.complete === 'yes',
    tip: '<b>' + r.date + '</b><br>RT ' + num(r.right_time) + ' of ' + num(r.reported) +
         ' reported<br>' + num(pct(r.right_time, r.reported), 1) + '%' +
         (r.complete === 'yes' ? '' : '<br>coverage check flagged (volume ratio ' + num(r.coverage_ratio, 2) + ')')
  })), bounds);

  const causes = rollCauses(det);
  el.innerHTML =
    `<div class="tiles">${tiles}</div>` +
    `<div class="g2a">` +
      `<fieldset><legend>Originating RT % by day — Report 19</legend>` +
        (points.length ? place((W) => lineChart(W, points, { suffix: '%', dp: 1, max: 100 }), 190)
                       : '<div class="boot">No punctuality captured for this window.</div>') +
      `</fieldset>` +
      `<fieldset><legend>Detention minutes by cause — Report 16</legend>` +
        (causes.length ? place((W) => barsH(W, causes.slice(0, 8).map((c, i) => ({
            label: c.key, value: c.minutes, colour: ink(i < MAX_SERIES ? SERIES[i] : OTHER),
            tip: '<b>' + c.key + '</b><br>' + num(c.minutes) + ' min<br>' + num(c.events) +
                 ' events<br>' + num(c.minutes / c.events, 1) + ' min average'
          })), { cumulative: true, unit: ' min',
                 total: causes.reduce((t, c) => t + c.minutes, 0) }), 190)
          : '<div class="boot">No detention events captured for this window.</div>') +
      `</fieldset>` +
    `</div>` +
    `<fieldset><legend>Day by day</legend>` + dayGrid(all, complete) + `</fieldset>`;
  drawPlaced();
  bindMarks(el);
}

function rollCauses(rows) {
  const map = new Map();
  rows.forEach((r) => {
    const slot = map.get(r.cause) || { key: r.cause, minutes: 0, events: 0, trains: 0 };
    slot.minutes += +r.minutes || 0;
    slot.events += +r.events || 0;
    slot.trains += +r.trains || 0;   /* per-day distinct trains, summed over days */
    map.set(r.cause, slot);
  });
  return [...map.values()].sort((a, b) => b.minutes - a.minutes);
}

function dayGrid(rows, complete) {
  const header = [{ t: 'Date', k: 1 }, 'Stations', 'Scheduled', 'Exceptions', 'Eligible', 'Reported',
                  'Not reported', 'Right time', 'Late', '1-15', '16-30', '31-45', '46-60',
                  'over 60', 'RT %', 'Volume ratio', 'Coverage check'];
  const body = rows.map((r) => ({
    cells: [r.date + (complete.has(r.date) ? '' : ' <span class="pill flag">check</span>'),
            num(r.stations), num(r.scheduled), num(r.exceptions), num(r.eligible), num(r.reported),
            num(r.not_reported), num(r.right_time), num(r.late), num(r.late_1_15), num(r.late_16_30),
            num(r.late_31_45), num(r.late_46_60), num(r.late_over_60),
            r.reported ? num(pct(r.right_time, r.reported), 1) : '—',
            num(r.coverage_ratio, 2),
            r.complete === 'yes' ? 'yes' : '<span class="no">no</span>']
  }));
  const used = rows.filter((r) => r.complete === 'yes');
  const total = ['Coverage check passed', num(used.length), num(sum(used, 'scheduled')), num(sum(used, 'exceptions')),
                 num(sum(used, 'eligible')), num(sum(used, 'reported')), num(sum(used, 'not_reported')),
                 num(sum(used, 'right_time')), num(sum(used, 'late')), num(sum(used, 'late_1_15')),
                 num(sum(used, 'late_16_30')), num(sum(used, 'late_31_45')), num(sum(used, 'late_46_60')),
                 num(sum(used, 'late_over_60')),
                 num(pct(sum(used, 'right_time'), sum(used, 'reported')), 1), '', ''];
  return grid(header, body, { total, scroll: rows.length > 16 });
}

/* --- punctuality ----------------------------------------------------- */
function renderPunct(bounds) {
  const el = $('v-punct');
  const all = rowsIn('punctuality_daily_total', bounds);
  const used = punctRows(bounds);
  const complete = completeDates(bounds);
  if (!all.length) { el.innerHTML = '<div class="boot">No punctuality captured for this window.</div>'; return; }

  const reported = sum(used, 'reported'), right = sum(used, 'right_time');
  const tiles = [
    tile('Originating RT %', reported ? num(pct(right, reported), 1) + '%' : '—',
         'ICMS basis: right time / reported'),
    tile('Scheduled', num(sum(used, 'scheduled')), num(sum(used, 'exceptions')) + ' exceptions'),
    tile('Eligible', num(sum(used, 'eligible')), num(sum(used, 'reported')) + ' reported'),
    tile('Late', num(sum(used, 'late')),
         num(pct(sum(used, 'late'), reported), 1) + '% of reported'),
    tile('Not reported', num(sum(used, 'not_reported')), 'not counted as late'),
    tile('Days counted', num(used.length) + ' of ' + num(all.length),
         state.completeOnly ? 'coverage-check failures excluded' : 'all captured days included',
         all.length !== used.length)
  ].join('');

  const points = calendarPoints(all.map((r) => ({
    date: r.date,
    label: r.date.slice(8) + '/' + r.date.slice(5, 7),
    y: pct(r.right_time, r.reported), complete: r.complete === 'yes',
    tip: '<b>' + r.date + '</b><br>' + num(r.right_time) + ' RT of ' + num(r.reported) +
         ' reported<br>eligible ' + num(r.eligible) +
         (r.complete === 'yes' ? '' : '<br>coverage check flagged')
  })), bounds);
  const dates = all.map((r) => r.date);
  const byDate = new Map(all.map((r) => [r.date, r]));

  el.innerHTML =
    `<div class="tiles">${tiles}</div>` +
    `<fieldset><legend>Originating RT % by day</legend>` +
      place((W) => lineChart(W, points, { suffix: '%', dp: 1, max: 100 }), 190) +
      `<div class="legend"><span><i style="background:${ink(SERIES[0])}"></i>coverage check passed (provisional)</span>` +
      `<span><i style="background:#fff;border:1px solid ${ink('--text-muted')}"></i>coverage check flagged, not joined</span></div>` +
    `</fieldset>` +
    `<fieldset><legend>How late, by day — delay slabs of reported trains</legend>` +
      place((W) => stackChart(W, dates, SLABS.map((s) => s[1]), (d, label) => {
        const row = byDate.get(d), field = SLABS.find((s) => s[1] === label)[0];
        return row ? row[field] : 0;
      }, { unit: ' trains', label: (d) => d.slice(8) + '/' + d.slice(5, 7) }), 210) +
    `</fieldset>` +
    `<fieldset><legend>Day by day</legend>` + dayGrid(all, complete) + `</fieldset>` +
    `<fieldset><legend>By station — window total${state.completeOnly ? ', coverage-check days only' : ''}</legend>` +
      stationGrid(bounds) + `</fieldset>`;
  drawPlaced();
  bindMarks(el);
}

function stationGrid(bounds) {
  const complete = completeDates(bounds);
  const rows = (state.tabs.punctuality_daily || []).filter((r) =>
    r.date >= bounds.start && r.date <= bounds.end && (!state.completeOnly || complete.has(r.date)));
  if (!rows.length) return '<div class="boot">No station rows for this window.</div>';
  const map = new Map();
  rows.forEach((r) => {
    const slot = map.get(r.station) || Object.assign({ station: r.station, days: 0 },
      Object.fromEntries(PUNCT_FIELDS.concat(SLABS.map((s) => s[0])).map((f) => [f, 0])));
    slot.days += 1;
    PUNCT_FIELDS.concat(SLABS.map((s) => s[0])).forEach((f) => { slot[f] += +r[f] || 0; });
    map.set(r.station, slot);
  });
  const list = [...map.values()].sort((a, b) => (b.late - a.late) || a.station.localeCompare(b.station));
  const worst = Math.max(...list.map((s) => s.late)) || 1;
  const header = [{ t: 'Station', k: 1 }, 'Days', 'Scheduled', 'Eligible', 'Reported', 'Right time',
                  'Late', '1-15', '16-30', '31-45', '46-60', 'over 60', 'RT %', { t: 'Late', k: 1 }];
  const body = list.map((s) => ({
    cells: [s.station, num(s.days), num(s.scheduled), num(s.eligible), num(s.reported), num(s.right_time),
            num(s.late), num(s.late_1_15), num(s.late_16_30), num(s.late_31_45), num(s.late_46_60),
            num(s.late_over_60), s.reported ? num(pct(s.right_time, s.reported), 1) : '—',
            `<span class="bar-in" style="width:${Math.round(60 * s.late / worst)}px"></span>`]
  }));
  const total = ['Division', '', num(list.reduce((t, s) => t + s.scheduled, 0)),
                 num(list.reduce((t, s) => t + s.eligible, 0)), num(list.reduce((t, s) => t + s.reported, 0)),
                 num(list.reduce((t, s) => t + s.right_time, 0)), num(list.reduce((t, s) => t + s.late, 0)),
                 '', '', '', '', '',
                 num(pct(list.reduce((t, s) => t + s.right_time, 0), list.reduce((t, s) => t + s.reported, 0)), 1), ''];
  return grid(header, body, { total, scroll: true });
}

/* --- detention ------------------------------------------------------- */
function dictionaryDescription(rows, cause, sub) {
  const field = sub === undefined ? 'cause_description' : 'subcode_description';
  const values = new Set(rows.filter((r) => r.cause === cause &&
    (sub === undefined || r.sub_code === sub)).map((r) => r[field]).filter(Boolean));
  return values.size === 1 ? [...values][0] : 'Description unavailable';
}

// Conservative corridor anchors, not a complete division station census.
// Shared anchors and same-station yards must not acquire an invented direction.
const DET_CORRIDORS = [
  {name:'NDLS–UMB', directed:true, stations:'NDLS SZM ANDI BHD NUR SNP GNU SMK DWNA PNP BBDE KUN BZK TRR NLKR AMIN KKDE DHKR DPP DHMZ SHDM MOY UMB'},
  {name:'NDLS–BTI', directed:true, stations:'NDLS DKZ DBSI SSB NNO ROK JIND NRW JHL BRZ BLZ MSZ BTI'},
  {name:'DLI–TPZ', directed:true, stations:'DLI DSA SBB GZB GZN GUH MDNR MUD PRTP MTC PQY MUT KAT MUZ DBD TPZ'},
  {name:'NDLS–RE', directed:true, stations:'NDLS DKZ DEE PTNR DEC GHH JSKA PTRD KIP RE'},
  {name:'NDLS–PWL', directed:true, stations:'NDLS TKJ LPNR NZM OKA TKD TKDC FDB FDN BVH AST PWL'},
  {name:'NRW–KKDE', stations:'NRW TNDE GXG PHWR PBJM TIK KLE QTP SJM KKDE'},
  {name:'DSA–TPZ', stations:'DSA NOLI GTRA FAP SFA KEX AHQ SUJR BADK BTU BAOL BDHP ASAR KQL KAND GLBN SMQL HIND HHP THBN UPRD TBTN NNX RPMN MNZ TPZ'},
  {name:'ABO–RE', stations:'ABO DBHL DGHL JHJ MHRI PLHW RE'},
  {name:'PNP–JCY', stations:'PNP BNJL NLH IRA DHRN MDLA GHNA BASN RKX ISRI BHMW LTKR PPDE JCY'},
  {name:'ROK–PNP', stations:'ROK MKLI JSS RKX GHNA MDLA DHRN IRA NLH BNJL PNP'},
  {name:'SNP–JIND', stations:'SNP BRNI MOHR LATH RBHR GHNA ISRI BHMW LTKR PPDE JIND'},
  {name:'ROK–BNW', stations:'ROK SRBH MKMN KHRK KLNK MHUL BNW'}
];

function broadDetentionSection(row) {
  const from=String(row.from_station || '').trim(), to=String(row.to_station || '').trim();
  if (!from || !to) return 'Section needs review';
  if (from===to) return 'Station / yard detention';
  const matches=DET_CORRIDORS.flatMap(c=>{
    const stations=c.stations.split(' '), a=stations.indexOf(from), b=stations.indexOf(to);
    if(a<0 || b<0)return [];
    if(!c.directed)return [c.name+' line'];
    const [start,end]=c.name.split('–');
    return [a<b ? start+'–'+end+' UP' : end+'–'+start+' DN'];
  });
  return matches.length===1 ? matches[0] : matches.length>1 ? 'Shared corridor — needs review' : 'Section needs review';
}

function detentionCountModel(rows) {
  const groups = (key) => {
    const map = new Map();
    rows.forEach(r => {
      const label = key(r), item = map.get(label) || {key:label, events:0, journeys:new Set()};
      item.events++; item.journeys.add(String(r.train)); map.set(label,item);
    });
    return [...map.values()].map(r => ({key:r.key,events:r.events,trains:r.journeys.size}))
      .sort((a,b) => b.trains-a.trains || b.events-a.events || a.key.localeCompare(b.key));
  };
  return {trains:new Set(rows.map(r => String(r.train))).size, events:rows.length,
    sections:groups(r => broadDetentionSection(r)), causes:groups(r => r.cause || 'Unspecified'),
    subs:groups(r => JSON.stringify([r.cause,r.sub_code || 'Unspecified'])),
    accounts:groups(r => r.type || 'Unspecified'),
    trainTypes:groups(r => r.train_type || 'Unavailable in shared source')};
}

function renderDetention(bounds) {
  const el = $('v-detention');
  const all = (state.tabs.detention_events || []).filter(r => r.detention_date >= bounds.start && r.detention_date <= bounds.end);
  if (!all.length) {
    el.innerHTML = '<div class="boot">Train-level detention records unavailable for this period. The shared event register covers a rolling window; check collection coverage. This is not a zero-detention result.</div>';
    return;
  }
  const query = (state.detSearch || '').toLowerCase();
  const rows = all.filter(r => (!state.cause || r.cause === state.cause) &&
    (!state.detSection || broadDetentionSection(r)===state.detSection) &&
    (!query || [r.train,r.section,broadDetentionSection(r),r.cause,r.sub_code,r.remarks].join(' ').toLowerCase().includes(query)));
  const model = detentionCountModel(rows);
  const groupTable = (list, label) => grid([label,'Trains detained','Detention cases'],list.map(r=>({cells:[esc(r.key),num(r.trains),num(r.events)]})),{scroll:true});
  const page = Math.min(state.detPage || 0, Math.max(0,Math.ceil(rows.length/100)-1));
  const records = rows.slice(page*100,page*100+100);
  el.innerHTML = '<p class="note">Each train start date is counted separately. A train can appear in several sections or reasons; do not add section-wise or reason-wise train counts. P is primary; N/S meanings remain unverified. Train category is unavailable until an ICMS category source is joined.</p>' +
    '<p class="note">Broad sections use draft route anchors, not a complete station master. Shared corridors and unmapped locations need review; yard cases have no inferred UP/DN.</p>'+
    `<div><label>Broad section <select id="detSection"><option value="">All sections</option>${[...new Set(all.map(broadDetentionSection))].sort().map(s=>'<option '+(state.detSection===s?'selected ':'')+'value="'+esc(s)+'">'+esc(s)+'</option>').join('')}</select></label> <label>Search train, location or reason <input id="detSearch" value="${esc(state.detSearch || '')}"></label> <button class="btn" id="applyDetSearch">Apply</button> <button class="btn" id="resetDet">Reset filters</button>${state.cause ? ' Reason: '+esc(state.cause) : ''}</div>` +
    '<div class="tiles">'+tile('Trains detained',num(model.trains),'Each train start date counted separately')+
    tile('Detention cases',num(model.events),'One train can have several cases')+tile('Broad section groups',num(model.sections.length),'Includes yard / review groups')+
    tile('Detention reasons',num(model.causes.length))+tile('Detailed reasons',num(model.subs.length))+'</div>'+
    '<div class="g2"><fieldset><legend>Trains detained by reason — click to filter</legend>'+
    place(W=>barsH(W,model.causes.slice(0,12).map(r=>({label:r.key,value:r.trains,colour:ink('--seq-450'),
      tip:esc(r.key)+'<br>'+esc(dictionaryDescription(rows,r.key))+'<br>'+num(r.trains)+' trains · '+num(r.events)+' detention cases'})),{unit:' trains'}),260)+
    '</fieldset><fieldset><legend>Section-wise detention</legend>'+groupTable(model.sections,'Broad section')+'</fieldset></div>'+
    '<div class="g2"><fieldset><legend>ICMS detention classification</legend>'+groupTable(model.accounts,'ICMS classification')+
    '</fieldset><fieldset><legend>Train category-wise detention</legend>'+groupTable(model.trainTypes,'Train category')+'<p>Department/account attribution requires verified Report 67 integration; P/N/S is not a departmental account.</p></fieldset></div>'+
    '<fieldset><legend>Reason-wise detention details</legend>'+grid(['Reason','Reason description','Sub-reason','Sub-reason description','Trains detained','Cases'],model.subs.map(r=>{
      const [cause,sub]=JSON.parse(r.key);return {cells:[esc(cause),esc(dictionaryDescription(rows,cause)),esc(sub),esc(dictionaryDescription(rows,cause,sub)),num(r.trains),num(r.events)]};
    }),{scroll:true})+'</fieldset>'+
    '<fieldset><legend>Train-wise detention details</legend><p>Date of detention '+esc(bounds.start)+' to '+esc(bounds.end)+
    ' · '+num(rows.length)+' cases · page '+(page+1)+'</p>'+grid(['Train number & start date','Date of detention','Broad section','ICMS original location','From','To','ICMS classification','Reason','Sub-reason','Reported explanation'],records.map(r=>({cells:[r.train,r.detention_date,broadDetentionSection(r),r.section,r.from_station,r.to_station,r.type,r.cause,r.sub_code,r.remarks].map(v=>esc(v || '—'))})),{scroll:true})+
    `<button class="btn" id="detPrev" ${page===0?'disabled':''}>Previous</button> <button class="btn" id="detNext" ${(page+1)*100>=rows.length?'disabled':''}>Next</button></fieldset>`;
  drawPlaced(); bindMarks(el);
  el.querySelectorAll('path.mark[data-key]').forEach(mark=>mark.addEventListener('click',()=>{
    const key=mark.getAttribute('data-key');if(!model.causes.some(r=>r.key===key))return;
    state.cause=state.cause===key?null:key;state.detPage=0;render();
  }));
  $('applyDetSearch').addEventListener('click',()=>{state.detSearch=$('detSearch').value;state.detPage=0;render();});
  $('detSection').addEventListener('change',()=>{state.detSection=$('detSection').value;state.detPage=0;render();});
  $('resetDet').addEventListener('click',()=>{state.detSearch='';state.detSection='';state.cause=null;state.detPage=0;render();});
  $('detPrev').addEventListener('click',()=>{state.detPage=page-1;render();});
  $('detNext').addEventListener('click',()=>{state.detPage=page+1;render();});
}

function renderDetentionDurationLegacy(bounds) {
  const el = $('v-detention');
  const causeRows = rowsIn('detention_daily_cause', bounds);
  if (!causeRows.length) {
    el.innerHTML = '<div class="boot">No detention events captured for this window. ' +
      'Check the capture register: absence of events does not prove absence of collection or zero detention.</div>';
    return;
  }
  const sections = rowsIn('detention_daily_section', bounds);
  const subs = rowsIn('detention_daily_subcause', bounds);
  const bands = rowsIn('detention_daily_band', bounds);
  const days = Math.round((new Date(bounds.end) - new Date(bounds.start)) / 86400000) + 1;
  const grain = grainOf(days);

  const minutes = sum(causeRows, 'minutes'), events = sum(causeRows, 'events');
  const dates = [...new Set(causeRows.map((r) => r.date))].sort();
  const causes = rollCauses(causeRows);
  const trainDays = sum(causeRows, 'trains');
  const masterRuns = [...new Set(causeRows.map((r) => r.master_run_id).filter((v) => v !== null && v !== undefined && v !== ''))];
  const masterTimes = [...new Set(causeRows.map((r) => r.master_captured_at).filter(Boolean))];

  const tiles = [
    tile('Detention minutes', num(minutes), num(events) + ' events'),
    tile('Minutes per event', num(minutes / events, 1), 'per-event Time column'),
    tile('Events per event-bearing day', num(events / dates.length, 1), num(dates.length) + ' dates with events'),
    tile('Causes seen', num(causes.length), causes.length ? 'top: ' + causes[0].key : ''),
    tile('Sections affected', num(new Set(sections.map((r) => r.section)).size), 'ICMS sections'),
    tile('Dates with events', num(dates.length) + ' of ' + num(days),
         'Event dates are not proof of report coverage',
         days !== dates.length)
  ].join('');

  /* cause mix over time, top 7 by minutes with the rest folded into Other */
  const keys = causes.slice(0, MAX_SERIES).map((c) => c.key);
  const hasOther = causes.length > MAX_SERIES;
  const periods = [...new Set(causeRows.map((r) => bucket(r.date, grain)))].sort();
  const cube = new Map();
  causeRows.forEach((r) => {
    const p = bucket(r.date, grain);
    const k = keys.includes(r.cause) ? r.cause : 'Other';
    cube.set(p + '\u0000' + k, (cube.get(p + '\u0000' + k) || 0) + (+r.minutes || 0));
  });
  const stackKeys = hasOther ? keys.concat(['Other']) : keys;

  /* sections, filtered by the selected cause if one is clicked */
  const secSource = state.cause
    ? subs.filter((r) => r.cause === state.cause)
    : sections;
  const secMap = new Map();
  secSource.forEach((r) => {
    const key = state.cause ? (r.sub_code || '(none)') : r.section;
    const slot = secMap.get(key) || { key, minutes: 0, events: 0 };
    slot.minutes += +r.minutes || 0;
    slot.events += +r.events || 0;
    secMap.set(key, slot);
  });
  const secList = [...secMap.values()].sort((a, b) => b.minutes - a.minutes).slice(0, 12);

  el.innerHTML =
    `<p class="note">${masterRuns.length === 1 && masterTimes.length === 1
      ? 'Descriptions: Report 301 master run ' + esc(masterRuns[0]) + ' · captured ' + esc(masterTimes[0]) + '.'
      : 'Consistent Report 301 dictionary provenance unavailable.'} Historical applicability is not verified; dictionary groups do not establish departmental responsibility.</p>` +
    `<div class="tiles">${tiles}</div>` +
    `<div class="g2a">` +
      `<fieldset><legend>Minutes by cause — click a bar to break it down</legend>` +
        place((W) => barsH(W, causes.slice(0, 10).map((c, i) => ({
          label: c.key, value: c.minutes,
          colour: ink(i < MAX_SERIES ? SERIES[i] : OTHER),
          tip: '<b>' + esc(c.key) + '</b><br>' + esc(dictionaryDescription(causeRows, c.key)) + '<br>' + num(c.minutes) + ' min<br>' + num(c.events) +
               ' events<br>' + num(c.minutes / c.events, 1) + ' min average' +
               (state.cause === c.key ? '<br>selected' : '')
        })), { cumulative: true, unit: ' min',
               total: causes.reduce((t, c) => t + c.minutes, 0) }), 230) +
      `</fieldset>` +
      `<fieldset><legend>${state.cause ? 'Sub-codes under ' + esc(state.cause) : 'Minutes by section'}` +
        (state.cause ? ' <button class="btn" id="clearCause">all causes</button>' : '') + `</legend>` +
        (secList.length ? place((W) => barsH(W, secList.map((s) => ({
            label: s.key, value: s.minutes, colour: ink('--seq-450'),
            tip: '<b>' + esc(s.key) + '</b><br>' +
              (state.cause ? esc(dictionaryDescription(subs, state.cause, s.key)) + '<br>' : '') +
              num(s.minutes) + ' min<br>' + num(s.events) + ' events'
          })), { unit: ' min' }), 230)
          : '<div class="boot">Nothing recorded.</div>') +
      `</fieldset>` +
    `</div>` +
    `<fieldset><legend>Cause mix over time — minutes by ${grain}</legend>` +
      place((W) => stackChart(W, periods, stackKeys,
        (p, k) => cube.get(p + '\u0000' + k) || 0, { unit: ' min' }), 230) +
    `</fieldset>` +
    `<div class="g2">` +
      `<fieldset><legend>How long each detention ran</legend>` + bandGrid(bands) + `</fieldset>` +
      `<fieldset><legend>Cause and sub-code</legend>` + subGrid(subs) + `</fieldset>` +
    `</div>` +
    `<fieldset><legend>Day by day</legend>` + detDayGrid(causeRows, sections) + `</fieldset>`;

  drawPlaced();
  bindMarks(el);
  el.querySelectorAll('path.mark[data-key]').forEach((mark) => {
    mark.addEventListener('click', () => {
      const key = mark.getAttribute('data-key');
      if (!causes.some((c) => c.key === key)) return;
      state.cause = state.cause === key ? null : key;
      render();
    });
  });
  const clear = $('clearCause');
  if (clear) clear.addEventListener('click', () => { state.cause = null; render(); });
}

/* Requested report windows are NOT the same thing as detention event dates. */
function captureCoverage(report, bounds) {
  const rows = (state.tabs.coverage || []).filter((r) => r.report === report &&
    window.ICMS_PERIODS.valid(r.report_from) && window.ICMS_PERIODS.valid(r.report_to) &&
    r.report_from <= bounds.end && r.report_to >= bounds.start);
  const dates = new Set();
  rows.forEach((r) => {
    const start = r.report_from < bounds.start ? bounds.start : r.report_from;
    const end = r.report_to > bounds.end ? bounds.end : r.report_to;
    for (let day = start; day <= end; day = shift(day, 1)) dates.add(day);
  });
  return { rows, dates };
}

function renderCoverage(bounds) {
  const expected = Math.round((Date.parse(bounds.end) - Date.parse(bounds.start)) / 86400000) + 1;
  const punctuality = captureCoverage('PAM-19', bounds), detention = captureCoverage('PAM-16', bounds);
  const rows = [...punctuality.rows, ...detention.rows].sort((a, b) =>
    String(b.imported_at).localeCompare(String(a.imported_at)));
  $('v-coverage').innerHTML = `<div class="tiles">` +
    tile('Report 19 requested dates held', num(punctuality.dates.size) + ' / ' + num(expected), 'Latest reconciled single-day captures') +
    tile('Report 16 requested dates held', num(detention.dates.size) + ' / ' + num(expected), 'Union of reconciled request windows; not event-date completeness') +
    tile('Explicit empty Report 16 captures', num(detention.rows.filter((r) => r.capture_state === 'reconciled_empty').length), 'Printed zero delayed trains in the selected source scope') +
    `</div><fieldset><legend>Source capture register</legend>` +
    `<p>Request windows and detention event dates differ. A reconciled capture does not certify a final or complete operating day. Empty means ICMS explicitly printed zero for this report scope.</p>` +
    (rows.length ? grid(['Report', 'Requested from', 'Requested to', 'Run', 'Imported (IST)', 'Printed total', 'Parsed total', 'Unit', 'Check'],
      rows.map((r) => ({ cells: [esc(r.report), esc(r.report_from), esc(r.report_to), num(r.run_id),
        esc(new Date(r.imported_at).toLocaleString('en-IN', { timeZone: 'Asia/Kolkata' })),
        num(r.printed_total), num(r.parsed_total), esc(r.unit), esc(r.capture_state || 'legacy / unspecified')] })),
      { scroll: true }) : '<div class="boot">No reconciled capture windows held for this selection.</div>') + `</fieldset>`;
}

function bandGrid(rows) {
  if (!rows.length) return '<div class="boot">Nothing recorded.</div>';
  const map = new Map();
  rows.forEach((r) => {
    const slot = map.get(r.band) || { band: r.band, from: +r.from_minutes || 0, events: 0, minutes: 0 };
    slot.events += +r.events || 0;
    slot.minutes += +r.minutes || 0;
    map.set(r.band, slot);
  });
  const list = [...map.values()].sort((a, b) => a.from - b.from);
  const events = list.reduce((t, b) => t + b.events, 0);
  const minutes = list.reduce((t, b) => t + b.minutes, 0);
  const header = [{ t: 'Duration', k: 1 }, 'Events', 'Share', 'Minutes', 'Share of minutes', 'Average'];
  const body = list.map((b) => ({
    cells: [b.band + ' min', num(b.events), num(pct(b.events, events), 1) + '%', num(b.minutes),
            num(pct(b.minutes, minutes), 1) + '%', num(b.minutes / b.events, 1)]
  }));
  return grid(header, body, { total: ['Total', num(events), '100.0%', num(minutes), '100.0%',
                                      num(minutes / events, 1)] });
}

function subGrid(rows) {
  if (!rows.length) return '<div class="boot">Nothing recorded.</div>';
  const map = new Map();
  rows.forEach((r) => {
    const key = r.cause + '|' + (r.sub_code || '');
    const slot = map.get(key) || { cause: r.cause, sub: r.sub_code || '(none)', events: 0, minutes: 0 };
    slot.events += +r.events || 0;
    slot.minutes += +r.minutes || 0;
    map.set(key, slot);
  });
  const list = [...map.values()].sort((a, b) => b.minutes - a.minutes).slice(0, 40);
  const header = [{ t: 'Cause', k: 1 }, { t: 'Sub-code', k: 1 }, 'Events', 'Minutes', 'Average'];
  const body = list.map((s) => ({
    cells: [s.cause + ' · ' + dictionaryDescription(rows, s.cause),
            s.sub + ' · ' + dictionaryDescription(rows, s.cause, s.sub),
            num(s.events), num(s.minutes), num(s.minutes / s.events, 1)]
  }));
  return grid(header, body, { scroll: list.length > 14 });
}

function detDayGrid(causeRows, sectionRows) {
  const byDate = new Map();
  causeRows.forEach((r) => {
    const slot = byDate.get(r.date) || { date: r.date, events: 0, minutes: 0, causes: new Set(), top: null };
    slot.events += +r.events || 0;
    slot.minutes += +r.minutes || 0;
    slot.causes.add(r.cause);
    if (!slot.top || (+r.minutes || 0) > slot.top.minutes) slot.top = { cause: r.cause, minutes: +r.minutes || 0 };
    byDate.set(r.date, slot);
  });
  const sectionCount = new Map();
  sectionRows.forEach((r) => {
    const set = sectionCount.get(r.date) || new Set();
    set.add(r.section);
    sectionCount.set(r.date, set);
  });
  const list = [...byDate.values()].sort((a, b) => a.date.localeCompare(b.date));
  const header = [{ t: 'Date', k: 1 }, 'Events', 'Minutes', 'Average', 'Causes', 'Sections',
                  { t: 'Largest cause', k: 1 }, 'its minutes'];
  const body = list.map((d) => ({
    cells: [d.date, num(d.events), num(d.minutes), num(d.minutes / d.events, 1), num(d.causes.size),
            num((sectionCount.get(d.date) || new Set()).size), d.top ? d.top.cause : '—',
            d.top ? num(d.top.minutes) : '—']
  }));
  const events = list.reduce((t, d) => t + d.events, 0);
  const minutes = list.reduce((t, d) => t + d.minutes, 0);
  return grid(header, body, {
    total: ['Window', num(events), num(minutes), num(minutes / events, 1), '', '', '', ''],
    scroll: list.length > 16
  });
}

/* --- wiring ---------------------------------------------------------- */
function bindMarks(root) {
  root.querySelectorAll('[data-tip]').forEach((mark) => {
    mark.addEventListener('mousemove', (e) => tip(e, mark.getAttribute('data-tip')));
    mark.addEventListener('mouseleave', tipOff);
  });
}

function render() {
  const bounds = windowFor();
  if (!bounds) { fail('Choose valid dates, no future dates, and a range of at most 366 days.'); return; }
  fail(null);
  $('window').textContent = bounds.start + ' to ' + bounds.end;
  ['overview', 'punct', 'detention', 'coverage'].forEach((v) => {
    $('v-' + v).classList.toggle('hide', v !== state.view);
  });
  if (!Object.keys(state.tabs).length) return;
  PLACED = [];
  if (state.view === 'overview') renderOverview(bounds);
  if (state.view === 'punct') renderPunct(bounds);
  if (state.view === 'detention') renderDetention(bounds);
  if (state.view === 'coverage') renderCoverage(bounds);
}

$('tabs').addEventListener('click', (e) => {
  const button = e.target.closest('button');
  if (!button) return;
  [...$('tabs').children].forEach((b) => b.setAttribute('aria-selected', String(b === button)));
  state.view = button.dataset.v;
  render();
});
$('period').addEventListener('change', (e) => {
  state.period = e.target.value;
  $('customWrap').classList.toggle('hide', state.period !== 'custom');
  if (state.period === 'custom' && !state.from) {
    state.to = istToday();
    state.from = shift(state.to, -29);
    $('from').value = state.from;
    $('to').value = state.to;
  }
  render();
});
$('from').addEventListener('change', (e) => { state.from = e.target.value; render(); });
$('to').addEventListener('change', (e) => { state.to = e.target.value; render(); });
$('completeOnly').addEventListener('change', (e) => { state.completeOnly = e.target.checked; render(); });
$('reload').addEventListener('click', () => { if (state.token) load(); });
$('signin').addEventListener('click', () => tokenClient && tokenClient.requestAccessToken());
$('signout').addEventListener('click', signOut);

$('window').textContent = '';
initAuth();
// The collector must publish separately; this only reloads committed data.
setInterval(() => { if (state.token && document.visibilityState === 'visible') load(); }, 5 * 60 * 1000);
