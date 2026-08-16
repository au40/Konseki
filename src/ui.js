// ── Dev log capture ────────────────────────────────────────────────────────
// Must run before anything else and must never throw — a top-level failure
// here blanks every page. Console output and uncaught errors land in
// window.__jsLogBuf for the Dev tab's merged [py]/[js] console view.
(function () {
  try {
    window.__jsLogBuf = [];
    const push = (level, text) => {
      try {
        window.__jsLogBuf.push({ ts: Date.now() / 1000, level, text: String(text) });
        if (window.__jsLogBuf.length > 1000) window.__jsLogBuf.shift();
      } catch (e) { /* capture must never break the app */ }
    };
    const fmt = (args) => args.map(a => {
      if (a instanceof Error) return a.stack || a.message;
      if (typeof a === 'object' && a !== null) {
        try { return JSON.stringify(a); } catch (e) { return String(a); }
      }
      return String(a);
    }).join(' ');
    ['log', 'info', 'warn', 'error'].forEach(name => {
      const orig = console[name].bind(console);
      const level = name === 'log' ? 'info' : name;
      console[name] = function (...args) {
        try { push(level, fmt(args)); } catch (e) {}
        orig(...args);
      };
    });
    window.addEventListener('error', e => {
      push('error', e.message + (e.filename ? ` (${String(e.filename).split('/').pop()}:${e.lineno})` : ''));
    });
    window.addEventListener('unhandledrejection', e => {
      const r = e.reason;
      push('error', 'Unhandled rejection: ' + ((r && (r.stack || r.message)) || String(r)));
    });
  } catch (e) { /* degrade to no capture, never a blank app */ }
})();

// ── Globals ────────────────────────────────────────────────────────────────
let currentPage        = 'dashboard';
let currentRange       = '30d';
let customBase         = '30d';   // preset range whose daily series the brush slices in Custom mode
let selStartDay        = 0;        // selection start, inclusive day index into the loaded daily series
let selEndDay          = Infinity; // selection end, inclusive day index (clamped to last day on use)
let excludedTypes      = new Set(); // activity types hidden from the Stats view (only Reading has chars)
let currentGranularity = 'day';
let splitByActivity    = false;
let statsMetric        = 'time';       // 'time' | 'chars' | 'speed' — Stats page chart
let statsCumulative    = false;        // Stats chart shape: per-bucket bars vs running total
let statsCache    = {};
let charts        = {};
let selectedAtype = 'Listening';
let selectedCatColor = '#5B8CFF';
let tlogMode      = 'global';   // 'global' | 'per_media' — Total time log baseline scope
let tlogBaseSecs  = 0;          // currently-loaded baseline for the active key
let tlogBaseChars = 0;
let tlogHasBaseline = false;
let mediaAllData  = [];
let seriesData    = [];
let mediaOrderMap = {}; // key -> position; key is "t:<title>" or "s:<id>"
let currentSeriesId = null;
let draggedItem   = null; // {type:'title'|'series', id:string|number}
let heatmapYear     = new Date().getFullYear();
let dashHeatmapYear = new Date().getFullYear();
let appSettings   = { rollover_hour: 0, gsm_url: 'http://localhost:7275/api/stats', theme: 'dark' };
let currentDetailTitle = null;
let currentMilestoneId  = null;        // when a milestone detail view is open
let currentMilestones   = [];          // milestones for the current media detail
let currentDetailData   = null;        // full payload for the open media detail
// Both detail views split by default. If a title has milestones, or a series has
// more than one book with data, the broken-down view is the more useful default.
// Each toggle only appears when there's something to split against, so this is a
// no-op for a title without milestones or a single-book series.
let splitByMilestone    = true;        // split media detail by milestone
let splitBySeriesBook   = true;        // split series detail by book
let currentSeriesChart  = null;        // {daily, byBook, books} for the open series detail
let _milestoneEditingId = null;        // null = adding, number = editing
let _milestoneDragId    = null;        // dragged milestone id for reorder

// ── Media stat portal state ────────────────────────────────────────────────
let portalSelected  = new Set();       // raw title strings currently selected
let portalDataCache = {};              // title -> compare payload entry
let portalColorMap  = {};              // title -> hex, stable while the app is open
const PORTAL_MAX = 8;

const BUILTIN_TYPES = ['Listening','Reading','Speaking','Vocabulary','Other'];
// Identity palettes — deliberately literal, not theme-bound. These say "this is
// Reading" or "this is the third title", so they must stay the same color in
// every theme. Only chart *chrome* (grid/ticks) and chart *data* colors follow
// the theme, via CT below.
const ACOLORS = {
  Reading:'#5B8CFF', Listening:'#4ECBA0',
  Speaking:'#C78BFF', Vocabulary:'#FF7BAC', Other:'#6B6B8A'
};
const CAT_PALETTE = [
  '#5B8CFF','#4ECBA0','#FF9F5B','#C78BFF','#FF7BAC',
  '#5BE8C4','#FFD15B','#FF6B6B','#6B6B8A','#38BDF8'
];
const PALETTE = ['#5B8CFF','#4ECBA0','#FF9F5B','#C78BFF','#FF7BAC','#5BE8C4','#FFD15B','#6B6B8A'];
const PORTAL_PALETTE = CAT_PALETTE;    // stat-portal per-title colors; 8-cap keeps them distinct
// Band colors for the lifetime stacked area. Same hues as the portal so a title
// keeps its identity across views, minus the grey — the residual "Other" band is
// grey, and a real title landing on that shade would read as the leftovers.
const STREAM_PALETTE = CAT_PALETTE.filter(c => c !== '#6B6B8A');
let HEATMAP_COLORS = ['#1E1E30','#1a3b4a','#1e6b52','#26a06e','#4ECBA0'];

// Chart colors, read from the theme's CSS custom properties instead of being
// hardcoded per chart. The dark values in :root are byte-identical to the hex
// literals these replaced, so dark renders exactly as before; mint now follows
// the theme too (its charts used to keep dark grid/tick colors on a light bg).
// Repopulated by applyTheme() after the data-theme attribute flips.
let CT = {};
function refreshChartTheme() {
  const cs = getComputedStyle(document.documentElement);
  const v  = n => cs.getPropertyValue(n).trim();
  CT = {
    grid:    v('--grid'),    dim:   v('--dim'),   accent: v('--accent'),
    success: v('--success'), card:  v('--card'),  warn:   v('--warn'),
    purple:  v('--purple'),  pink:  v('--pink'),  inset:  v('--inset'),
    text:    v('--text'),    muted: v('--muted'),
  };
  Chart.defaults.color       = CT.dim;
  Chart.defaults.borderColor = CT.grid;
}
refreshChartTheme();

// Translucent fill from a theme color — replaces the hardcoded rgba() fills so
// the cumulative/speed area fills follow the theme with the line they belong to.
function ctAlpha(hex, a) {
  const h = (hex || '').replace('#', '');
  if (h.length !== 6) return `rgba(78,203,160,${a})`;
  const n = parseInt(h, 16);
  return `rgba(${(n >> 16) & 255},${(n >> 8) & 255},${n & 255},${a})`;
}

Chart.defaults.font.family = "'Segoe UI', system-ui, sans-serif";
Chart.defaults.font.size   = 11;

// ── Helpers ────────────────────────────────────────────────────────────────
function fmtTime(s) {
  if (!s || s <= 0) return '0 min';
  if (s < 3600) return `${(s / 60).toFixed(1)} min`;
  const h = Math.floor(s / 3600), m = Math.floor((s % 3600) / 60);
  return m > 0 ? `${h}h ${m}m` : `${h}h`;
}
// Axis-tick formatter for the cumulative-hours axis: whole hours read as
// "60h"; sub-hour ticks (only reachable on tiny ranges) as "30m" / "1h 30m".
function fmtHourTick(h) {
  const m = Math.round(h * 60);
  if (m % 60 === 0) return `${m / 60}h`;
  return m < 60 ? `${m}m` : `${Math.floor(m / 60)}h ${m % 60}m`;
}
function fmtChars(n) {
  if (n >= 1_000_000) return `${(n/1_000_000).toFixed(2)} mil`;
  if (n >= 1000)      return `${(n/1000).toFixed(1)}k`;
  return String(n);
}
// ── Decimal places ─────────────────────────────────────────────────────────
// A metric that shows a decimal shows it *always*: 24 renders as "24.0", never
// collapsing to a whole number just because the fraction happens to be zero.
// Never strip a trailing ".0" from these — a column of "31.2 / 24 / 18.7" reads
// as three different precisions.
function fmtFixed(n, dp = 1) { return Number(n || 0).toFixed(dp); }
// Every percentage shown as text is 1-decimal.
function fmtPct(n) { return fmtFixed(n, 1); }
// Chart.js hands a tick callback (value, index, ticks). Its "nice" steps include
// 2.5, which makes some ticks fractional and others whole on the same axis
// ("0 / 2.5 / 5"). Format every tick to the most precise one so the axis reads
// "0.0 / 2.5 / 5.0". Values are pre-rounded to kill float noise (7.500000000001).
function tickDp(ticks) {
  let dp = 0;
  (ticks || []).forEach(t => {
    const s = String(Math.round((t?.value ?? t) * 1e6) / 1e6);
    const i = s.indexOf('.');
    if (i >= 0) dp = Math.max(dp, s.length - i - 1);
  });
  return Math.min(dp, 2);
}
function fmtTick(v, ticks, suffix = '') { return fmtFixed(v, tickDp(ticks)) + suffix; }
function twRolling(charArr, secsArr, window) {
  return charArr.map((_, i) => {
    const start = Math.max(0, i - window + 1);
    let c = 0, s = 0;
    for (let j = start; j <= i; j++) { c += charArr[j]; s += secsArr[j]; }
    return s > 0 && c > 0 ? c / (s / 3600) : null;
  });
}

// Trailing chars/hour over the last `days` entries of a title's daily series.
// `daily` holds only days actually read, so this is the last N *reading* days —
// the same window the detail page's 7d-rolling speed chart plots. Summed
// chars ÷ summed time, never the stored reading_speed column.
function recentSpeed(daily, days) {
  let c = 0, s = 0;
  (daily || []).slice(-days).forEach(d => { c += d.chars; s += d.seconds; });
  return (s > 0 && c > 0) ? c / (s / 3600) : 0;
}

function escHtml(s) {
  return String(s ?? '').replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;');
}
function srcLabel(s) {
  return {gsm:'Game',anki:'Anki',ttu:'Book',ttsureader:'Book',manual:'Manual',manual_media:'Manual',csv:'Import'}[s?.toLowerCase()] || (s||'').toUpperCase();
}
function acolor(t) { return ACOLORS[t] || '#6B6B8A'; }
function mediaNoun(d) {
  // What kind of media a detail entry is, for the completion controls
  // ("Complete game" vs "Complete book" ...).
  if (d.source === 'gsm') return 'game';
  if (d.source === 'ttu' || d.source === 'ttsureader' || d.activity_type === 'Reading') return 'book';
  return 'media';
}
function setStatus(msg) { document.getElementById('status').textContent = msg; }

function today() {
  const now      = new Date();
  const rollover = appSettings.rollover_hour || 0;
  const d        = (rollover > 0 && now.getHours() < rollover)
                   ? new Date(now.getFullYear(), now.getMonth(), now.getDate() - 1)
                   : now;
  return `${d.getFullYear()}-${String(d.getMonth()+1).padStart(2,'0')}-${String(d.getDate()).padStart(2,'0')}`;
}

function isoDateFromObj(d) {
  return `${d.getFullYear()}-${String(d.getMonth()+1).padStart(2,'0')}-${String(d.getDate()).padStart(2,'0')}`;
}

// Inverse of isoDateFromObj. `new Date('2026-03-02')` parses as UTC midnight,
// which reads back a day early west of UTC — always build from parts.
function dateFromISO(s) {
  const [y, m, d] = String(s || '').split('-').map(Number);
  return new Date(y, m - 1, d);
}

function mediaIcon(source, atype) {
  if (source === 'gsm') return '🎮';
  if (atype === 'Listening') return '🎵';
  if (atype === 'Speaking') return '🎙';
  if (atype === 'Vocabulary') return '📝';
  return '📖';
}

// ── Navigation ─────────────────────────────────────────────────────────────
function navigate(page) {
  if (currentPage === 'log' && page !== 'log') {
    // Keep the base 'feedback' class (just clear the message); dropping the class
    // used to collapse the reserved line and shift the Add-entry button on return.
    const fb = document.getElementById('log-feedback');
    if (fb) { fb.className = 'feedback'; fb.textContent = ''; }
    const tfb = document.getElementById('tlog-feedback');
    if (tfb) { tfb.className = 'feedback'; tfb.textContent = ''; }
  }
  if (currentPage === 'settings' && page !== 'settings') {
    const setup = document.getElementById('settings-setup-view');
    const main  = document.getElementById('settings-main-view');
    if (setup) setup.style.display = 'none';
    if (main)  main.style.display  = '';
    clearSetupFeedback();
  }
  if (currentPage === 'dev' && page !== 'dev') stopDevLogPoll();
  document.querySelectorAll('.nav-item').forEach(el =>
    el.classList.toggle('active', el.dataset.page === page));
  document.querySelectorAll('.page').forEach(el =>
    el.classList.toggle('active', el.id === `page-${page}`));
  currentPage = page;
  loadPage(page);
}

async function loadPage(page) {
  if      (page === 'dashboard') await loadDashboard();
  else if (page === 'log')       await buildLogPage();
  else if (page === 'history')   await loadHistory();
  else if (page === 'stats')     await loadStats(currentRange);
  else if (page === 'goals')     await loadGoals();
  else if (page === 'media')     await loadMedia();
  else if (page === 'catalog')   await loadCatalog();
  else if (page === 'settings')  await loadSettings();
  else if (page === 'dev')       await loadDevPage();
}

// ── Dashboard ──────────────────────────────────────────────────────────────
async function loadDashboard() {
  const d = await window.pywebview.api.get_dashboard();
  document.getElementById('today-date').textContent = today();

  const todaySec = d.today.reduce((a,r) => a + r.seconds, 0);
  const todayChars = d.today.reduce((a,r) => a+r.chars, 0);
  // Only reading with a tracked char count feeds the day's speed: a chars-less
  // Reading session (e.g. time-only manual entry) would add time to the
  // denominator with no chars, dragging cph down. Exclude it from both sides.
  const readingRows = d.today.filter(r => r.activity_type === 'Reading' && r.chars > 0);
  const readingSec = readingRows.reduce((a,r) => a + r.seconds, 0);
  const readingChars = readingRows.reduce((a,r) => a + r.chars, 0);
  const cph = (readingSec > 0 && readingChars > 0) ? Math.round(readingChars / (readingSec / 3600)) : 0;
  document.getElementById('d-time').textContent  = fmtTime(todaySec);
  document.getElementById('d-chars').textContent = fmtChars(todayChars);
  document.getElementById('d-lines').textContent = cph > 0 ? fmtChars(cph) + '/h' : '—';
  document.getElementById('d-days').textContent  = `${d.cur_streak ?? 0}d`;

  const list = document.getElementById('today-sessions');
  list.innerHTML = '';
  if (!d.today.length) {
    list.innerHTML = '<p class="empty-msg">No sessions yet today. Use Log entry, pull from GSM, or drop a session file.</p>';
  } else {
    const grouped = [];
    const seen = {};
    d.today.forEach(s => {
      const key = (s.title || '') + '\x00' + (s.activity_type || '') + '\x00' + (s.source || '');
      if (seen[key] !== undefined) {
        grouped[seen[key]].push(s);
      } else {
        seen[key] = grouped.length;
        grouped.push([s]);
      }
    });
    grouped.forEach(group => list.appendChild(
      group.length === 1 ? makeSessionRow(group[0]) : makeGroupedSessionRow(group)
    ));
  }

  const bars = document.getElementById('weekly-bars');
  bars.innerHTML = '';
  const maxSec = Math.max(...d.weekly.map(r => r.seconds), 1);
  d.weekly.forEach(r => {
    const pct = Math.min(r.seconds / maxSec * 100, 100);
    bars.innerHTML += `
      <div class="mini-bar">
        <span class="mini-bar-label">${r.date.slice(5)}</span>
        <div class="mini-bar-track"><div class="mini-bar-fill" style="width:${pct}%"></div></div>
        <span class="mini-bar-time">${fmtTime(r.seconds)}</span>
      </div>`;
  });
  const totalSec = d.weekly.reduce((acc, r) => acc + r.seconds, 0);
  bars.innerHTML += `
    <div class="weekly-total">
      <span class="weekly-total-label">Total</span>
      <span class="weekly-total-time">${fmtTime(totalSec)}</span>
    </div>`;

  await refreshDashHeatmap();
}

async function refreshDashHeatmap() {
  const curYear = new Date().getFullYear();
  const label   = document.getElementById('dash-heatmap-year');
  const nextBtn = document.getElementById('dash-heatmap-next');
  if (label)   label.textContent = dashHeatmapYear;
  if (nextBtn) nextBtn.disabled  = dashHeatmapYear >= curYear;
  const hmData = await window.pywebview.api.get_heatmap(dashHeatmapYear, null);
  renderHeatmap('heatmap-dash', hmData, null, true, dashHeatmapYear);
}

async function changeDashHeatmapYear(delta) {
  dashHeatmapYear = Math.min(new Date().getFullYear(), Math.max(2000, dashHeatmapYear + delta));
  await refreshDashHeatmap();
}

// Edit chip on GSM rows → opens the combined adjust modal: subtract dead/AFK time
// (per display date) and/or roll part of the entry to the previous logical day
// (per real source date). Wired via a closure so titles with quotes can't break an
// inline onclick. allowRollover is false for grouped rows, whose merged sessions
// have no single source date for a rollover.
function editTimeBtnHtml(s) {
  return (s.source === 'gsm' && s.game_id)
    ? `<button class="btn edit-time-btn" title="Adjust this entry (subtract time / rollover)">✎</button>`
    : '';
}
function wireEditTimeBtn(el, s, allowRollover = true) {
  if (s.source === 'gsm' && s.game_id) {
    el.querySelector('.edit-time-btn').addEventListener('click', () =>
      openGsmEdit(s, allowRollover));
  }
}

// Edit pencil shown only on manual rows with a real id (phantom rollover rows have
// id=null). Reuses the games' edit-pencil chip styling; a row is either GSM or
// manual, never both, so the two pencils never collide.
function editLogBtnHtml(s) {
  return ((s.source === 'manual' || s.source === 'manual_media') && s.id)
    ? `<button class="btn edit-time-btn edit-log-btn" title="Edit this log entry">✎</button>`
    : '';
}
function wireEditLogBtn(el, s) {
  if ((s.source === 'manual' || s.source === 'manual_media') && s.id) {
    el.querySelector('.edit-log-btn').addEventListener('click', () => openLogEdit(s));
  }
}

function makeSessionRow(s) {
  const color  = acolor(s.activity_type);
  // Signed: a negative overlay reads "−Nm dead time", a positive one "+Nm added".
  const adjM = s.adjust_secs ? Math.round(s.adjust_secs / 60) : 0;
  const el     = document.createElement('div');
  el.className = 'session-row';
  el.innerHTML = `
    <div class="session-badge" style="background:${color}"></div>
    <div class="session-body">
      <div class="session-title">${s.title || s.activity_type || '—'}</div>
      <div class="session-meta">${srcLabel(s.source)} · ${s.activity_type || ''} · ${s.date || today()}</div>
    </div>
    <div class="session-right">
      ${s.seconds > 0 ? `<span class="session-time" style="color:${color}">${fmtTime(s.seconds)}</span>` : ''}
      ${s.chars   > 0 ? `<span class="session-chars">${fmtChars(s.chars)} chars</span>` : ''}
      ${adjM ? `<span class="session-chars" style="color:var(--warn)">${adjM < 0 ? `−${-adjM}m dead time` : `+${adjM}m added`}</span>` : ''}
      <button class="btn btn-xs btn-danger" onclick="doDeleteSession(${s.id}, this)">✕</button>
      ${editTimeBtnHtml(s)}
      ${editLogBtnHtml(s)}
    </div>`;
  wireEditTimeBtn(el, s);
  wireEditLogBtn(el, s);
  return el;
}

function makeGroupedSessionRow(sessions) {
  const s = sessions[0];
  const totalSeconds = sessions.reduce((a, r) => a + r.seconds, 0);
  const totalChars   = sessions.reduce((a, r) => a + r.chars, 0);
  // adjust_secs is per game_id and identical across a game's rows — sum once per
  // distinct game so the indicator isn't multiplied by the session count.
  const seenG = {};
  let shaved = 0;
  sessions.forEach(r => {
    if (r.game_id && !(r.game_id in seenG)) { seenG[r.game_id] = 1; shaved += (r.adjust_secs || 0); }
  });
  const shavedM = shaved ? Math.round(shaved / 60) : 0;   // signed, as above
  const color = acolor(s.activity_type);
  const ids   = sessions.map(r => r.id);
  const el    = document.createElement('div');
  el.className = 'session-row';
  el.innerHTML = `
    <div class="session-badge" style="background:${color}"></div>
    <div class="session-body">
      <div class="session-title">${s.title || s.activity_type || '—'}</div>
      <div class="session-meta">${srcLabel(s.source)} · ${s.activity_type || ''} · ${s.date || today()}</div>
      <div class="session-group-count">${sessions.length} sessions</div>
    </div>
    <div class="session-right">
      ${totalSeconds > 0 ? `<span class="session-time" style="color:${color}">${fmtTime(totalSeconds)}</span>` : ''}
      ${totalChars   > 0 ? `<span class="session-chars">${fmtChars(totalChars)} chars</span>` : ''}
      ${shavedM ? `<span class="session-chars" style="color:var(--warn)">${shavedM < 0 ? `−${-shavedM}m dead time` : `+${shavedM}m added`}</span>` : ''}
      <button class="btn btn-xs btn-danger" onclick="doDeleteSessionGroup([${ids.join(',')}], this)">✕</button>
      ${editTimeBtnHtml(s)}
    </div>`;
  wireEditTimeBtn(el, s, false);   // grouped: no single source date → subtract-only
  return el;
}

function isoPrevDay(dateStr) {
  const dt = new Date(dateStr + 'T00:00:00');
  dt.setDate(dt.getDate() - 1);
  return isoDateFromObj(dt);
}

// ── GSM entry adjust modal (subtract time + rollover) ─────────────────────────
// One modal, two tabs. "Subtract minutes" shaves dead/AFK time off this game for
// its DISPLAY date (manual_time_adjust, keyed by display date + game_id). "Rollover"
// moves part of the entry to the previous logical day for its real SOURCE date
// (gsm_rollover_attributions). Both overlays survive GSM re-ingests (see CLAUDE.md).
// Save applies both panes; each is an idempotent set pre-filled from current state,
// so an untouched pane just re-commits its own value. Rollover is hidden when there
// is no single source date (grouped rows, or phantom rollover rows with id=null).
let gsmEditCtx = null;

async function openGsmEdit(s, allowRollover = true) {
  const gameId      = s.game_id;
  const displayDate = s.date || today();
  const sourceDate  = s.session_date;
  const showRollover = allowRollover && s.id != null && !!sourceDate;
  gsmEditCtx = { gameId, displayDate, sourceDate, title: s.title, showRollover,
                 prevDay: sourceDate ? isoPrevDay(sourceDate) : null };

  document.getElementById('gsm-edit-title').textContent = `Adjust “${s.title || 'entry'}”`;

  const sub = await window.pywebview.api.get_game_time_adjust(gameId, displayDate);
  document.getElementById('gsm-edit-sub-minutes').value = sub.adjust_minutes || 0;
  document.getElementById('gsm-edit-sub-hint').textContent =
    `Correct this game's time on ${displayDate}. Negative removes dead/AFK time; ` +
    `positive adds time GSM under-counted. 0 clears.`;

  const rollTab = document.getElementById('gsm-edit-rollover-tab');
  if (showRollover) {
    const roll = await window.pywebview.api.get_rollover_attribution(gameId, sourceDate);
    document.getElementById('gsm-edit-roll-chars').value   = roll.chars   || 0;
    document.getElementById('gsm-edit-roll-minutes').value = roll.minutes || 0;
    document.getElementById('gsm-edit-roll-hint').textContent =
      `How much of ${sourceDate} belongs to ${gsmEditCtx.prevDay}. 0/0 clears; capped to the entry's totals.`;
    rollTab.style.display = '';
  } else {
    rollTab.style.display = 'none';
  }

  document.getElementById('gsm-edit-feedback').textContent = '';
  switchGsmEditTab('subtract');
  document.getElementById('gsm-edit-overlay').style.display = 'flex';
}

function switchGsmEditTab(name) {
  document.querySelectorAll('#gsm-edit-seg .seg-btn').forEach(b =>
    b.classList.toggle('active', b.dataset.tab === name));
  document.getElementById('gsm-edit-pane-subtract').style.display = name === 'subtract' ? '' : 'none';
  document.getElementById('gsm-edit-pane-rollover').style.display = name === 'rollover' ? '' : 'none';
}

function closeGsmEdit() {
  document.getElementById('gsm-edit-overlay').style.display = 'none';
  gsmEditCtx = null;
}

async function submitGsmEdit() {
  if (!gsmEditCtx) { closeGsmEdit(); return; }
  const fb  = document.getElementById('gsm-edit-feedback');
  const num = v => (v.trim() === '' ? 0 : Number(v.trim()));

  // The time correction is SIGNED (negative removes, positive adds). The
  // rollover fields stay non-negative — a displacement is an amount moved, and
  // is separately capped to the row's own totals server-side.
  const subMins = num(document.getElementById('gsm-edit-sub-minutes').value);
  const chars   = num(document.getElementById('gsm-edit-roll-chars').value);
  const rollMin = num(document.getElementById('gsm-edit-roll-minutes').value);
  if (isNaN(subMins)) {
    fb.className = 'feedback err'; fb.textContent = 'Enter a number of minutes.'; return;
  }
  if (isNaN(chars) || chars < 0 || isNaN(rollMin) || rollMin < 0) {
    fb.className = 'feedback err'; fb.textContent = 'Rollover amounts must be non-negative.'; return;
  }

  const { gameId, displayDate, sourceDate, showRollover } = gsmEditCtx;
  const r1 = await window.pywebview.api.set_game_time_adjust(gameId, subMins, displayDate);
  if (!r1.ok) { fb.className = 'feedback err'; fb.textContent = r1.error || 'Failed to save.'; return; }
  if (showRollover) {
    const r2 = await window.pywebview.api.set_rollover_attribution(gameId, sourceDate, chars, rollMin);
    if (!r2.ok) { fb.className = 'feedback err'; fb.textContent = r2.error || 'Failed to save.'; return; }
  }

  closeGsmEdit();
  statsCache = {};
  setStatus('Adjustments saved');
  if (currentPage === 'dashboard') loadDashboard();
  else if (currentPage === 'history') loadHistory();
}

// ── Delete session ─────────────────────────────────────────────────────────
async function doDeleteSession(id, btn) {
  if (!await showConfirm('Delete this session? This cannot be undone.')) return;
  btn.disabled = true;
  const r = await window.pywebview.api.delete_session(id);
  if (r.ok) {
    btn.closest('.session-row').remove();
    statsCache = {};
    setStatus('Session deleted');
    if (currentPage === 'dashboard') loadDashboard();
  } else {
    btn.disabled = false;
  }
}

async function doDeleteSessionGroup(ids, btn) {
  if (!await showConfirm(ids.length > 1 ? `Delete ${ids.length} sessions? This cannot be undone.` : 'Delete this session? This cannot be undone.')) return;
  btn.disabled = true;
  for (const id of ids) {
    const r = await window.pywebview.api.delete_session(id);
    if (!r.ok) { btn.disabled = false; return; }
  }
  btn.closest('.session-row').remove();
  statsCache = {};
  setStatus(ids.length > 1 ? `${ids.length} sessions deleted` : 'Session deleted');
  if (currentPage === 'dashboard') loadDashboard();
}

// ── Heatmap color ramp ──────────────────────────────────────────────────────
// HEATMAP_COLORS[0] is the categorical "no reading" shade; stops 1..4 are
// gradient anchors spread evenly over 0 → HEATMAP_CAP_HOURS, interpolated so
// brightness climbs with every extra minute instead of snapping at a bucket
// edge. The anchors are absolute, not window-relative, so the same day reads
// the same color across years and between the dashboard and Stats.
const HEATMAP_CAP_HOURS = 3;

function mixHex(a, b, f) {
  const na = parseInt((a || '').replace('#', ''), 16);
  const nb = parseInt((b || '').replace('#', ''), 16);
  if (isNaN(na) || isNaN(nb)) return a;
  const ch = sh => {
    const x = (na >> sh) & 255, y = (nb >> sh) & 255;
    return Math.round(x + (y - x) * f);
  };
  return `rgb(${ch(16)},${ch(8)},${ch(0)})`;
}

function heatmapColor(secs) {
  if (!secs || secs <= 0) return HEATMAP_COLORS[0];
  const stops = HEATMAP_COLORS.slice(1);
  // Any reading at all floors at stops[0], so a 2-minute day still reads as
  // distinct from an empty one.
  const t   = Math.min(secs / 3600 / HEATMAP_CAP_HOURS, 1);
  const pos = t * (stops.length - 1);
  const i   = Math.min(Math.floor(pos), stops.length - 2);
  return mixHex(stops[i], stops[i + 1], pos - i);
}

// ── Heatmap renderer ────────────────────────────────────────────────────────
function renderHeatmap(containerId, data, maxDays, showLabels, yearMode) {
  const container = document.getElementById(containerId);
  if (!container) return;

  const todayObj = new Date();
  const allDates = [];

  if (yearMode) {
    const yr    = yearMode;
    const start = new Date(yr, 0, 1);
    const end   = yr === todayObj.getFullYear()
                  ? new Date(todayObj.getFullYear(), todayObj.getMonth(), todayObj.getDate())
                  : new Date(yr, 11, 31);
    for (let d = new Date(start); d <= end; d.setDate(d.getDate() + 1)) {
      const copy = new Date(d);
      const key  = isoDateFromObj(copy);
      allDates.push({ date: key, secs: data[key] || 0, d: copy });
    }
  } else {
    const days = maxDays || 84;
    for (let i = days - 1; i >= 0; i--) {
      const d = new Date(todayObj.getFullYear(), todayObj.getMonth(), todayObj.getDate() - i);
      const key = isoDateFromObj(d);
      allDates.push({ date: key, secs: data[key] || 0, d });
    }
  }

  const startDow = allDates[0].d.getDay();
  const padded   = [...Array(startDow).fill(null), ...allDates];
  while (padded.length % 7 !== 0) padded.push(null);

  const weeks = [];
  for (let i = 0; i < padded.length; i += 7) weeks.push(padded.slice(i, i + 7));

  const MONTHS = ['Jan','Feb','Mar','Apr','May','Jun','Jul','Aug','Sep','Oct','Nov','Dec'];
  let html = '<div class="heatmap-inner">';

  if (showLabels) {
    html += '<div class="heatmap-months" style="padding-left:24px">';
    let lastM = -1;
    weeks.forEach(week => {
      const first = week.find(d => d !== null);
      let label = '';
      if (first) {
        const m = first.d.getMonth();
        if (m !== lastM) { label = MONTHS[m]; lastM = m; }
      }
      html += `<span class="heatmap-month-label">${label}</span>`;
    });
    html += '</div>';
  }

  html += '<div class="heatmap-grid">';

  if (showLabels) {
    html += '<div class="heatmap-days">';
    ['','M','','W','','F',''].forEach(l => {
      html += `<div class="heatmap-day-label">${l}</div>`;
    });
    html += '</div>';
  }

  weeks.forEach(week => {
    html += '<div class="heatmap-week">';
    week.forEach(day => {
      if (!day) {
        html += '<div class="heatmap-cell" style="background:transparent"></div>';
      } else {
        const color = heatmapColor(day.secs);
        const tip   = `${day.date}  ${fmtTime(day.secs)}`;
        html += `<div class="heatmap-cell" style="background:${color}" title="${tip}"></div>`;
      }
    });
    html += '</div>';
  });

  html += '</div>';
  const legendStops = HEATMAP_COLORS.slice(1);
  const legendGrad  = legendStops
    .map((c, i) => `${c} ${Math.round(i / (legendStops.length - 1) * 100)}%`)
    .join(', ');
  html += '<div class="heatmap-legend"><span>Less</span>';
  html += `<div class="heatmap-legend-cell" style="background:${HEATMAP_COLORS[0]}" title="No reading"></div>`;
  html += `<div class="heatmap-legend-bar" style="background:linear-gradient(to right, ${legendGrad})"`
       +  ` title="0 → ${HEATMAP_CAP_HOURS}h+"></div>`;
  html += '<span>More</span></div>';
  html += '</div>';

  container.innerHTML = html;
}

// ── GSM pull ────────────────────────────────────────────────────────────────
async function doPullGSM() {
  const btn = document.getElementById('pull-btn');
  btn.disabled = true; btn.textContent = 'Pulling…';
  const url = document.getElementById('gsm-url')?.value || null;
  const r   = await window.pywebview.api.pull_gsm(url);
  btn.disabled = false; btn.textContent = '↻ Pull GSM now';
  if (r.ok) {
    const parts = [`${fmtChars(r.chars)} chars`];
    if (r.speed > 0 && r.chars > 0)  parts.push(`${fmtChars(Math.round(r.speed))}/hr`);
    setStatus(`GSM: ${parts.join(' · ')}`);
    if (currentPage === 'dashboard') await loadDashboard();
  } else {
    setStatus('GSM not reachable — is it running?');
  }
}

// ── Log entry ──────────────────────────────────────────────────────────────
async function buildLogPage() {
  const customCats = await window.pywebview.api.get_categories();
  const allTypes   = [...BUILTIN_TYPES, ...customCats.map(c => c.name)];
  const allColors  = Object.fromEntries([
    ...BUILTIN_TYPES.map(t => [t, ACOLORS[t]]),
    ...customCats.map(c => [c.name, c.color])
  ]);

  const pills = document.getElementById('atype-pills');
  pills.innerHTML = '';
  allTypes.forEach(t => {
    const b = document.createElement('button');
    b.className = 'pill' + (t === selectedAtype ? ' active' : '');
    b.textContent = t;
    if (t === selectedAtype) {
      const col = allColors[t] || 'var(--accent)';
      b.style.background = col; b.style.borderColor = col; b.style.color = '#fff';
    }
    b.onclick = () => {
      selectedAtype = t;
      pills.querySelectorAll('.pill').forEach(p => {
        p.classList.remove('active');
        p.style.background = ''; p.style.borderColor = ''; p.style.color = '';
      });
      b.classList.add('active');
      const col = allColors[t] || 'var(--accent)';
      b.style.background = col; b.style.borderColor = col; b.style.color = '#fff';
      toggleReadingFields(t === 'Reading');
    };
    pills.appendChild(b);
  });

  toggleReadingFields(selectedAtype === 'Reading');
  await populateMediaTitles();
  await initTotalLog();
  renderCustomCatList(customCats);
  buildColorSwatches();
}

// Reading-only fields (chars, chars/hour, extrapolation hint) toggle together.
function toggleReadingFields(isReading) {
  const cg = document.getElementById('log-chars-group');
  const pg = document.getElementById('log-cph-group');
  if (cg) cg.style.display = isReading ? '' : 'none';
  if (pg) pg.style.display = isReading ? '' : 'none';
  updateCharsHint();
}

// Live preview of how the chars/time/cph fields resolve. Direct chars always wins;
// chars/hour is only used to extrapolate when the Characters field is left blank.
function updateCharsHint() {
  const hint = document.getElementById('log-chars-hint');
  if (!hint) return;
  if (selectedAtype !== 'Reading') { hint.style.display = 'none'; return; }
  const mins  = Number(document.getElementById('log-minutes').value);
  const chars = Number(document.getElementById('log-chars').value);
  const cph   = Number(document.getElementById('log-cph').value);
  if (chars > 0) {
    hint.style.display = '';
    hint.textContent = mins > 0
      ? `≈ ${fmtChars(Math.round(chars / (mins / 60)))}/hr at this pace`
      : `${fmtChars(chars)} chars will be logged`;
  } else if (cph > 0 && mins > 0) {
    hint.style.display = '';
    hint.textContent = `≈ ${fmtChars(Math.round(cph * mins / 60))} chars will be logged`;
  } else {
    hint.style.display = 'none';
  }
}

// Fill a media <select> from the title list. Option value is the original title so
// a manual entry merges into the existing media card (GSM titles included — purely
// additive, never touches the GSM rollover-attribution path, which only reconciles
// source='gsm' rows). Keeps the current selection if it still exists, else falls
// back to the leading "— none —" option; `preferred` overrides the retained value.
function fillMediaSelect(sel, titles, preferred) {
  if (!sel) return;
  const want = preferred !== undefined ? preferred : sel.value;
  sel.innerHTML = '<option value="">— none —</option>';
  (titles || []).forEach(m => {
    if (!m.title) return;
    const o = document.createElement('option');
    o.value = m.title;
    o.textContent = m.display_title || m.title;
    sel.appendChild(o);
  });
  sel.value = want;
}

// Refresh the media pickers/lists. The manual-log picker is now a <select> (same
// model as the total-time-log box); the #media-titles datalist is kept only for the
// free-text title field in the edit-log modal. Also repaints the manual recent chips.
async function populateMediaTitles() {
  let titles = [];
  try { titles = await window.pywebview.api.get_media_titles(); }
  catch (e) { /* pickers are optional */ }
  const dl = document.getElementById('media-titles');
  if (dl) {
    dl.innerHTML = '';
    titles.forEach(m => {
      if (!m.title) return;
      const o = document.createElement('option');
      o.value = m.title;
      if (m.display_title && m.display_title !== m.title) o.label = m.display_title;
      dl.appendChild(o);
    });
  }
  fillMediaSelect(document.getElementById('log-title'), titles);
  await renderRecentLogChips('manual');
}

// Quick re-log chips: titles logged via `method` ('manual' | 'total') in the last
// 7 days. Clicking one selects it in that card's media <select> so the user can log
// to it again without opening the dropdown. The two hand-log methods write
// indistinguishable source='manual' rows, so the recent lists are tracked per method
// in settings (see db.record_recent_log_title), not derived from the sessions table.
async function renderRecentLogChips(method) {
  const cfg = method === 'total'
    ? { box: 'tlog-recent', sel: 'tlog-media', onPick: onTotalLogMediaChange }
    : { box: 'log-recent',  sel: 'log-title',  onPick: null };
  const box = document.getElementById(cfg.box);
  if (!box) return;
  let items = [];
  try { items = await window.pywebview.api.get_recent_log_media(method); }
  catch (e) { /* chips are optional */ }
  box.innerHTML = '';
  if (!items || !items.length) { box.style.display = 'none'; return; }
  const lbl = document.createElement('span');
  lbl.className = 'rc-label';
  lbl.textContent = 'Recent:';
  box.appendChild(lbl);
  const sel = document.getElementById(cfg.sel);
  items.forEach(m => {
    const b = document.createElement('button');
    b.type = 'button';
    b.className = 'pill';
    b.textContent = m.display_title || m.title;
    b.title = 'Log to ' + (m.display_title || m.title);
    b.onclick = () => {
      if (!sel) return;
      sel.value = m.title;
      if (sel.value === m.title && cfg.onPick) cfg.onPick();
    };
    box.appendChild(b);
  });
  box.style.display = '';
}

function buildColorSwatches() {
  const grid = document.getElementById('cat-color-swatches');
  if (!grid) return;
  grid.innerHTML = '';
  CAT_PALETTE.forEach(c => {
    const el = document.createElement('div');
    el.className = 'swatch' + (c === selectedCatColor ? ' selected' : '');
    el.style.background = c;
    el.onclick = () => {
      selectedCatColor = c;
      grid.querySelectorAll('.swatch').forEach(s => s.classList.remove('selected'));
      el.classList.add('selected');
    };
    grid.appendChild(el);
  });
}

function renderCustomCatList(cats) {
  const el = document.getElementById('custom-cat-list');
  if (!el) return;
  el.innerHTML = '';
  if (!cats.length) {
    el.innerHTML = '<span class="muted" style="font-size:12px">No custom categories yet.</span>';
    return;
  }
  cats.forEach(c => {
    const pill = document.createElement('span');
    pill.className = 'pill-del';
    pill.style.borderColor = c.color;
    pill.style.color = c.color;
    pill.innerHTML = `${c.name} <span class="x" onclick="doDeleteCategory('${c.name.replace(/'/g,"\\'")}')">✕</span>`;
    el.appendChild(pill);
  });
}

async function doAddCategory() {
  const name = document.getElementById('new-cat-name').value.trim();
  const fb   = document.getElementById('cat-feedback');
  if (!name) { fb.className='feedback err'; fb.textContent='Enter a category name.'; return; }
  if (BUILTIN_TYPES.includes(name)) {
    fb.className='feedback err'; fb.textContent='That name is already a built-in category.'; return;
  }
  const r = await window.pywebview.api.add_category(name, selectedCatColor);
  if (r.ok) {
    fb.className='feedback ok'; fb.textContent=`✓ Added "${name}"`;
    document.getElementById('new-cat-name').value = '';
    await buildLogPage();
  } else {
    fb.className='feedback err'; fb.textContent = r.error || 'Error';
  }
}

async function doDeleteCategory(name) {
  const r = await window.pywebview.api.delete_category(name);
  if (r.ok) await buildLogPage();
}

async function doLogSession() {
  const minutes   = document.getElementById('log-minutes').value.trim();
  const title     = document.getElementById('log-title').value.trim();
  const dt        = document.getElementById('log-date').value.trim();
  const charsRaw  = document.getElementById('log-chars').value.trim();
  const cphRaw    = document.getElementById('log-cph').value.trim();
  const fb        = document.getElementById('log-feedback');

  if (!minutes || isNaN(minutes) || Number(minutes) <= 0) {
    fb.className = 'feedback err'; fb.textContent = 'Enter a positive number of minutes.'; return;
  }
  if (!/^\d{4}-\d{2}-\d{2}$/.test(dt)) {
    fb.className = 'feedback err'; fb.textContent = 'Date must be YYYY-MM-DD.'; return;
  }

  // Reading only: prefer an explicit char count; otherwise extrapolate from chars/hour × time.
  let chars = 0;
  if (selectedAtype === 'Reading') {
    if (charsRaw)      chars = Number(charsRaw);
    else if (cphRaw)   chars = Math.round(Number(cphRaw) * Number(minutes) / 60);
  }

  const r = await window.pywebview.api.log_session(selectedAtype, Number(minutes), title, dt, chars);
  if (r.ok) {
    const charsPart = chars > 0 ? ` · ${fmtChars(chars)} chars` : '';
    fb.className = 'feedback ok'; fb.textContent = `✓ Logged ${fmtTime(Number(minutes) * 60)} of ${selectedAtype}${charsPart}`;
    document.getElementById('log-minutes').value = '';
    document.getElementById('log-chars').value   = '';
    document.getElementById('log-cph').value     = '';
    document.getElementById('log-title').value   = '';
    document.getElementById('log-date')._flatpickr?.setDate(today(), false);
    updateCharsHint();
    populateMediaTitles();
    statsCache = {};
    setStatus('Session logged');
  } else {
    fb.className = 'feedback err'; fb.textContent = r.error || 'Something went wrong.';
  }
}

// ── Edit manual log (modal) ──────────────────────────────────────────────────
// Pops the manual-log form pre-filled with an existing entry and updates it in
// place. Only manual rows expose the pencil (see editLogBtnHtml); GSM/ttsu/anki
// rows are re-ingested, so the backend also guards UPDATE to source='manual'.
let editingSessionId  = null;
let selectedEditAtype = 'Reading';

// Build activity-type pills into `container`; onSelect(type) fires on click.
function renderAtypePills(container, allTypes, allColors, getSelected, onSelect) {
  container.innerHTML = '';
  allTypes.forEach(t => {
    const b = document.createElement('button');
    b.className = 'pill' + (t === getSelected() ? ' active' : '');
    b.textContent = t;
    const paint = el => {
      const col = allColors[t] || 'var(--accent)';
      el.style.background = col; el.style.borderColor = col; el.style.color = '#fff';
    };
    if (t === getSelected()) paint(b);
    b.onclick = () => {
      container.querySelectorAll('.pill').forEach(p => {
        p.classList.remove('active'); p.style.background = ''; p.style.borderColor = ''; p.style.color = '';
      });
      b.classList.add('active'); paint(b);
      onSelect(t);
    };
    container.appendChild(b);
  });
}

function toggleEditReadingFields(isReading) {
  const cg = document.getElementById('edit-log-chars-group');
  const pg = document.getElementById('edit-log-cph-group');
  if (cg) cg.style.display = isReading ? '' : 'none';
  if (pg) pg.style.display = isReading ? '' : 'none';
  updateEditCharsHint();
}

function updateEditCharsHint() {
  const hint = document.getElementById('edit-log-chars-hint');
  if (!hint) return;
  if (selectedEditAtype !== 'Reading') { hint.style.display = 'none'; return; }
  const mins  = Number(document.getElementById('edit-log-minutes').value);
  const chars = Number(document.getElementById('edit-log-chars').value);
  const cph   = Number(document.getElementById('edit-log-cph').value);
  if (chars > 0) {
    hint.style.display = '';
    hint.textContent = mins > 0
      ? `≈ ${fmtChars(Math.round(chars / (mins / 60)))}/hr at this pace`
      : `${fmtChars(chars)} chars will be logged`;
  } else if (cph > 0 && mins > 0) {
    hint.style.display = '';
    hint.textContent = `≈ ${fmtChars(Math.round(cph * mins / 60))} chars will be logged`;
  } else {
    hint.style.display = 'none';
  }
}

async function openLogEdit(s) {
  editingSessionId  = s.id;
  selectedEditAtype = s.activity_type || 'Reading';
  const customCats = await window.pywebview.api.get_categories();
  const allTypes   = [...BUILTIN_TYPES, ...customCats.map(c => c.name)];
  const allColors  = Object.fromEntries([
    ...BUILTIN_TYPES.map(t => [t, ACOLORS[t]]),
    ...customCats.map(c => [c.name, c.color])
  ]);
  renderAtypePills(
    document.getElementById('edit-log-atype-pills'), allTypes, allColors,
    () => selectedEditAtype,
    t => { selectedEditAtype = t; toggleEditReadingFields(t === 'Reading'); });

  document.getElementById('edit-log-minutes').value = +(s.seconds / 60).toFixed(2);
  document.getElementById('edit-log-chars').value   = s.chars > 0 ? s.chars : '';
  document.getElementById('edit-log-cph').value     = '';
  document.getElementById('edit-log-title').value   = s.raw_title || '';
  document.getElementById('edit-log-feedback').textContent = '';
  toggleEditReadingFields(selectedEditAtype === 'Reading');

  const dp = document.getElementById('edit-log-date')._flatpickr;
  if (dp) dp.setDate(s.date || today(), false);
  else    document.getElementById('edit-log-date').value = s.date || today();

  document.getElementById('edit-log-overlay').style.display = 'flex';
}

function closeLogEdit() {
  document.getElementById('edit-log-overlay').style.display = 'none';
  editingSessionId = null;
}

async function submitLogEdit() {
  const fb       = document.getElementById('edit-log-feedback');
  const minutes  = document.getElementById('edit-log-minutes').value.trim();
  const title    = document.getElementById('edit-log-title').value.trim();
  const dt       = document.getElementById('edit-log-date').value.trim();
  const charsRaw = document.getElementById('edit-log-chars').value.trim();
  const cphRaw   = document.getElementById('edit-log-cph').value.trim();

  if (editingSessionId == null) { closeLogEdit(); return; }
  if (!minutes || isNaN(minutes) || Number(minutes) <= 0) {
    fb.className = 'feedback err'; fb.textContent = 'Enter a positive number of minutes.'; return;
  }
  if (!/^\d{4}-\d{2}-\d{2}$/.test(dt)) {
    fb.className = 'feedback err'; fb.textContent = 'Date must be YYYY-MM-DD.'; return;
  }
  // Same chars resolution as the new-entry form: explicit count wins, else extrapolate.
  let chars = 0;
  if (selectedEditAtype === 'Reading') {
    if (charsRaw)    chars = Number(charsRaw);
    else if (cphRaw) chars = Math.round(Number(cphRaw) * Number(minutes) / 60);
  }
  const r = await window.pywebview.api.update_manual_session(
    editingSessionId, selectedEditAtype, Number(minutes), title, dt, chars);
  if (r.ok) {
    closeLogEdit();
    statsCache = {};
    setStatus('Session updated');
    if      (currentPage === 'history')   loadHistory();
    else if (currentPage === 'dashboard') loadDashboard();
  } else {
    fb.className = 'feedback err'; fb.textContent = r.error || 'Something went wrong.';
  }
}

// ── Add media (modal) ────────────────────────────────────────────────────────
// Manually create a media card for titles tracked by hand. Inserts one seed
// session with source='manual_media' (which surfaces on the grid, unlike
// quick-log source='manual'); subsequent time is logged from the Log page,
// whose dropdown picks up the new title automatically.
let selectedAddMediaAtype = 'Reading';
let addMediaCoverFile     = null;
let selectedAddEpubAtype  = 'Reading';
let addEpubMeta           = null;   // extract_epub_meta result for the pending import

function switchAddMediaTab(name) {
  document.querySelectorAll('#add-media-seg .seg-btn').forEach(b =>
    b.classList.toggle('active', b.dataset.tab === name));
  document.getElementById('add-media-pane-manual').style.display = name === 'manual' ? '' : 'none';
  document.getElementById('add-media-pane-epub').style.display   = name === 'epub'   ? '' : 'none';
}

// "Characters read" only makes sense for a Reading initial session (mirrors the
// Manual tab). Hidden for other activity types.
function toggleAddEpubReadingFields(isReading) {
  document.getElementById('add-epub-chars-read-group').style.display = isReading ? '' : 'none';
}

function toggleAddMediaReadingFields(isReading) {
  document.getElementById('add-media-chars-group').style.display = isReading ? '' : 'none';
  document.getElementById('add-media-cph-group').style.display   = isReading ? '' : 'none';
  updateAddMediaCharsHint();
}

function updateAddMediaCharsHint() {
  const hint = document.getElementById('add-media-chars-hint');
  if (selectedAddMediaAtype !== 'Reading') { hint.style.display = 'none'; return; }
  const mins  = Number(document.getElementById('add-media-minutes').value);
  const chars = Number(document.getElementById('add-media-chars').value);
  const cph   = Number(document.getElementById('add-media-cph').value);
  if (chars > 0) {
    hint.style.display = '';
    hint.textContent = mins > 0
      ? `≈ ${fmtChars(Math.round(chars / (mins / 60)))}/hr at this pace`
      : `${fmtChars(chars)} chars will be logged`;
  } else if (cph > 0 && mins > 0) {
    hint.style.display = '';
    hint.textContent = `≈ ${fmtChars(Math.round(cph * mins / 60))} chars will be logged`;
  } else {
    hint.style.display = 'none';
  }
}

function pickAddMediaCover() {
  const input = document.createElement('input');
  input.type = 'file';
  input.accept = 'image/*';
  input.onchange = () => {
    addMediaCoverFile = input.files[0] || null;
    document.getElementById('add-media-cover-name').textContent = addMediaCoverFile ? addMediaCoverFile.name : '';
  };
  input.click();
}

async function openAddMediaModal() {
  selectedAddMediaAtype = 'Reading';
  addMediaCoverFile     = null;
  const customCats = await window.pywebview.api.get_categories();
  const allTypes   = [...BUILTIN_TYPES, ...customCats.map(c => c.name)];
  const allColors  = Object.fromEntries([
    ...BUILTIN_TYPES.map(t => [t, ACOLORS[t]]),
    ...customCats.map(c => [c.name, c.color])
  ]);
  renderAtypePills(
    document.getElementById('add-media-atype-pills'), allTypes, allColors,
    () => selectedAddMediaAtype,
    t => { selectedAddMediaAtype = t; toggleAddMediaReadingFields(t === 'Reading'); });
  selectedAddEpubAtype = 'Reading';
  renderAtypePills(
    document.getElementById('add-epub-atype-pills'), allTypes, allColors,
    () => selectedAddEpubAtype,
    t => { selectedAddEpubAtype = t; toggleAddEpubReadingFields(t === 'Reading'); });

  document.getElementById('add-media-title').value   = '';
  document.getElementById('add-media-minutes').value = '';
  document.getElementById('add-media-chars').value   = '';
  document.getElementById('add-media-cph').value     = '';
  document.getElementById('add-media-cover-name').textContent = '';
  document.getElementById('add-media-feedback').textContent   = '';
  document.getElementById('add-media-feedback').className      = 'feedback';
  toggleAddMediaReadingFields(true);

  // Reset the Epub-import tab to its pre-selection state.
  addEpubMeta = null;
  document.getElementById('add-epub-file-name').textContent = '';
  document.getElementById('add-epub-details').style.display  = 'none';
  document.getElementById('add-epub-submit').disabled        = true;
  document.getElementById('add-epub-title').value      = '';
  document.getElementById('add-epub-chars').value      = '';
  document.getElementById('add-epub-minutes').value    = '';
  document.getElementById('add-epub-chars-read').value = '';
  document.getElementById('add-epub-feedback').textContent = '';
  document.getElementById('add-epub-feedback').className   = 'feedback';
  toggleAddEpubReadingFields(true);

  for (const id of ['add-media-date', 'add-epub-date']) {
    const dp = document.getElementById(id)._flatpickr;
    if (dp) dp.setDate(today(), false);
    else    document.getElementById(id).value = today();
  }

  switchAddMediaTab('manual');
  document.getElementById('add-media-overlay').style.display = 'flex';
}

function closeAddMediaModal() {
  document.getElementById('add-media-overlay').style.display = 'none';
}

async function submitAddMedia() {
  const fb       = document.getElementById('add-media-feedback');
  const title    = document.getElementById('add-media-title').value.trim();
  const minutes  = document.getElementById('add-media-minutes').value.trim();
  const dt       = document.getElementById('add-media-date').value.trim();
  const charsRaw = document.getElementById('add-media-chars').value.trim();
  const cphRaw   = document.getElementById('add-media-cph').value.trim();

  if (!title) {
    fb.className = 'feedback err'; fb.textContent = 'Enter a title.'; return;
  }
  if (!minutes || isNaN(minutes) || Number(minutes) <= 0) {
    fb.className = 'feedback err'; fb.textContent = 'Enter a positive number of minutes.'; return;
  }
  if (!/^\d{4}-\d{2}-\d{2}$/.test(dt)) {
    fb.className = 'feedback err'; fb.textContent = 'Date must be YYYY-MM-DD.'; return;
  }
  // Same chars resolution as the manual-log form: explicit count wins, else extrapolate.
  let chars = 0;
  if (selectedAddMediaAtype === 'Reading') {
    if (charsRaw)    chars = Number(charsRaw);
    else if (cphRaw) chars = Math.round(Number(cphRaw) * Number(minutes) / 60);
  }

  const r = await window.pywebview.api.add_media(title, selectedAddMediaAtype, Number(minutes), dt, chars);
  if (!r.ok) {
    fb.className = 'feedback err'; fb.textContent = r.error || 'Something went wrong.'; return;
  }
  // Title row now exists, so the cover (keyed by title) can attach.
  if (addMediaCoverFile) await uploadCoverFile(addMediaCoverFile, title);

  closeAddMediaModal();
  statsCache = {};
  setStatus('Media added');
  loadMedia();
}

// ── Add media via EPUB ───────────────────────────────────────────────────────
// The "Epub import" tab of the Add-media modal. Reuses the same EPUB extraction
// that the cover-box drop uses (imports.extract_epub), but here it creates a
// *new* media entry: it prefills the title, cover and length for the user to
// adjust, then on confirm writes a seed session + the progress-bar length + the
// cover. See add_media_epub in tracker.py.
function pickEpubImportFile() {
  const input = document.createElement('input');
  input.type = 'file';
  input.accept = '.epub,application/epub+zip';
  input.onchange = () => { if (input.files[0]) loadEpubForImport(input.files[0]); };
  input.click();
}

async function loadEpubForImport(file) {
  const fb   = document.getElementById('add-epub-feedback');
  document.getElementById('add-epub-file-name').textContent = file.name;
  fb.className = 'feedback'; fb.textContent = 'Reading EPUB…';
  let b64;
  try { b64 = await fileToBase64(file); }
  catch (err) { fb.className = 'feedback err'; fb.textContent = 'Could not read EPUB file.'; return; }

  const r = await window.pywebview.api.extract_epub_meta(b64);
  if (!r || !r.ok) {
    addEpubMeta = null;
    document.getElementById('add-epub-details').style.display = 'none';
    document.getElementById('add-epub-submit').disabled = true;
    fb.className = 'feedback err'; fb.textContent = (r && r.error) || 'Could not read EPUB.';
    return;
  }
  addEpubMeta = r;

  // Prefill everything (all fields stay editable). Fall back to the filename if
  // the EPUB carries no title in its metadata.
  document.getElementById('add-epub-title').value = r.title || file.name.replace(/\.epub$/i, '');
  document.getElementById('add-epub-chars').value = r.char_count > 0 ? r.char_count : '';

  const img  = document.getElementById('add-epub-cover-img');
  const none = document.getElementById('add-epub-cover-none');
  if (r.cover_found && r.cover_b64) {
    img.src = `data:${r.cover_mime || 'image/jpeg'};base64,${r.cover_b64}`;
    img.style.display = ''; none.style.display = 'none';
  } else {
    img.removeAttribute('src'); img.style.display = 'none'; none.style.display = '';
  }

  document.getElementById('add-epub-details').style.display = '';
  document.getElementById('add-epub-submit').disabled = false;
  fb.className = 'feedback'; fb.textContent = '';
}

async function submitAddMediaEpub() {
  const fb = document.getElementById('add-epub-feedback');
  if (!addEpubMeta) {
    fb.className = 'feedback err'; fb.textContent = 'Choose an .epub file first.'; return;
  }
  const title     = document.getElementById('add-epub-title').value.trim();
  const chars     = document.getElementById('add-epub-chars').value.trim();       // book length
  const mins      = document.getElementById('add-epub-minutes').value.trim();
  const charsRead = document.getElementById('add-epub-chars-read').value.trim();  // initial session
  const dt        = document.getElementById('add-epub-date').value.trim();

  if (!title) {
    fb.className = 'feedback err'; fb.textContent = 'Enter a title.'; return;
  }
  if (mins && (isNaN(mins) || Number(mins) < 0)) {
    fb.className = 'feedback err'; fb.textContent = 'Minutes must be 0 or more.'; return;
  }
  if (!/^\d{4}-\d{2}-\d{2}$/.test(dt)) {
    fb.className = 'feedback err'; fb.textContent = 'Date must be YYYY-MM-DD.'; return;
  }
  // Chars read only belong to a real initial session (time > 0); the backend
  // ignores them otherwise, but flag it here so the user isn't silently dropped.
  if (charsRead && Number(charsRead) > 0 && !(mins && Number(mins) > 0)) {
    fb.className = 'feedback err';
    fb.textContent = 'Enter the time read to log those characters, or clear the characters-read field.';
    return;
  }

  const r = await window.pywebview.api.add_media_epub(
    title, selectedAddEpubAtype, Number(mins || 0), dt,
    Number(chars || 0), addEpubMeta.cover_b64 || null,
    selectedAddEpubAtype === 'Reading' ? Number(charsRead || 0) : 0);
  if (!r || !r.ok) {
    fb.className = 'feedback err'; fb.textContent = (r && r.error) || 'Something went wrong.'; return;
  }

  // Brand-new entry, so no existing milestones to replace (pass 0). Only let
  // the chapter import rewrite the length if the user left the extractor's
  // number alone — a hand-typed length is theirs to keep.
  const extra = await maybeImportEpubChapters(
    title, addEpubMeta.chapter_candidates, addEpubMeta.char_count, 0,
    Number(chars || 0) === Number(addEpubMeta.char_count || 0));

  closeAddMediaModal();
  statsCache = {};
  setStatus(extra ? `Media added from EPUB — ${extra}` : 'Media added from EPUB');
  loadMedia();
}

// ── Total time log ───────────────────────────────────────────────────────────
// The user pastes their reading app's running cumulative total; we log the
// *difference* since the last entry as a normal manual session. The totals
// themselves persist in a private baseline (db: total_log_baselines) keyed by
// '' (global) or the selected media title (per-media) — never counted as stats.

// Parse "H:MM:SS" / "H:MM" (or a bare hours number) into seconds; null if bad.
function parseHMS(str) {
  const s = (str || '').trim();
  if (!s) return null;
  let m = s.match(/^(\d+):([0-5]?\d):([0-5]?\d)$/);    // H:MM:SS
  if (m) return Number(m[1]) * 3600 + Number(m[2]) * 60 + Number(m[3]);
  m = s.match(/^(\d+):([0-5]?\d)$/);                    // H:MM
  if (m) return (Number(m[1]) * 60 + Number(m[2])) * 60;
  m = s.match(/^\d+(\.\d+)?$/);                          // bare hours, e.g. "52" or "52.5"
  if (m) return Math.round(Number(s) * 3600);
  return null;
}
function secsToHMS(secs) {
  const t = Math.max(0, Math.round(secs));
  const h = Math.floor(t / 3600), m = Math.floor((t % 3600) / 60), sec = t % 60;
  return `${h}:${String(m).padStart(2, '0')}:${String(sec).padStart(2, '0')}`;
}

// Active baseline key: '' for global, the selected media title for per-media.
function tlogKey() {
  return tlogMode === 'per_media' ? (document.getElementById('tlog-media').value || '') : '';
}

// Populate the media <select> from the same source as the manual-log dropdown.
// Restores `preferred` (the remembered selection on init) if given, else keeps
// the current selection across a repopulation. An absent/stale value falls back
// to "— none —".
async function populateTotalLogMedia(preferred) {
  const sel = document.getElementById('tlog-media');
  if (!sel) return;
  const want = preferred !== undefined ? preferred : sel.value;
  try {
    const titles = await window.pywebview.api.get_media_titles();
    fillMediaSelect(sel, titles, want);
  } catch (e) { /* leave the "none" option only */ }
}

async function initTotalLog() {
  const st = await window.pywebview.api.get_total_log_state('');
  tlogMode = st.mode === 'per_media' ? 'per_media' : 'global';
  document.getElementById('tlog-mode-global').classList.toggle('active', tlogMode === 'global');
  document.getElementById('tlog-mode-permedia').classList.toggle('active', tlogMode === 'per_media');
  await populateTotalLogMedia(st.last_media || '');
  await refreshTotalLogBaseline();
  await renderRecentLogChips('total');
}

async function toggleTotalLogMode(mode) {
  if (mode !== 'per_media') mode = 'global';
  tlogMode = mode;
  document.getElementById('tlog-mode-global').classList.toggle('active', mode === 'global');
  document.getElementById('tlog-mode-permedia').classList.toggle('active', mode === 'per_media');
  await window.pywebview.api.set_total_log_mode(mode);
  await refreshTotalLogBaseline();
}

async function onTotalLogMediaChange() {
  // Remember the pick so it's restored on the next reload (both modes).
  await window.pywebview.api.set_total_log_last_media(document.getElementById('tlog-media').value || '');
  // In per-media mode a different media has a different baseline; reload it.
  if (tlogMode === 'per_media') await refreshTotalLogBaseline();
  else updateTotalLogPreview();
}

// Load the baseline for the active key, paint the read-only line, and gate the
// "Log difference" button (disabled until a baseline exists for this key).
async function refreshTotalLogBaseline() {
  const st = await window.pywebview.api.get_total_log_state(tlogKey());
  tlogHasBaseline = !!st.has_baseline;
  tlogBaseSecs    = st.base_secs  || 0;
  tlogBaseChars   = st.base_chars || 0;

  const line = document.getElementById('tlog-baseline');
  const scope = tlogMode === 'per_media'
    ? (tlogKey() ? `for “${tlogKey()}”` : '(pick a media)')
    : '';
  if (tlogHasBaseline) {
    const charsPart = tlogBaseChars > 0 ? ` · ${fmtChars(tlogBaseChars)} chars` : '';
    line.textContent = `Last recorded total ${scope}: ${secsToHMS(tlogBaseSecs)}${charsPart}`;
  } else {
    line.textContent = `No baseline yet ${scope} — starting from 0:00:00, so your first entry logs its full total. `
                     + `Press “Set as baseline” instead if you already have hours you don't want logged.`;
  }

  // Only per-media mode with no media picked still gates the button — a missing
  // baseline just means "start from zero", not "you can't log".
  const btn = document.getElementById('tlog-submit');
  const needMedia = tlogMode === 'per_media' && !tlogKey();
  btn.disabled = needMedia;
  btn.style.opacity = needMedia ? '0.5' : '';
  updateTotalLogPreview();
}

// Live preview of the difference that will be logged.
function updateTotalLogPreview() {
  const prev = document.getElementById('tlog-preview');
  if (!prev) return;
  const newSecs  = parseHMS(document.getElementById('tlog-time').value);
  const charsRaw = document.getElementById('tlog-chars').value.trim();
  const cphRaw   = document.getElementById('tlog-cph').value.trim();
  if (newSecs === null) { prev.style.display = 'none'; return; }

  // No baseline yet = starting from zero, so the whole total is the first entry.
  const baseSecs  = tlogHasBaseline ? tlogBaseSecs  : 0;
  const baseChars = tlogHasBaseline ? tlogBaseChars : 0;

  const deltaSecs = newSecs - baseSecs;
  if (deltaSecs <= 0) {
    prev.style.display = '';
    prev.textContent = tlogHasBaseline
      ? `New total must exceed the last recorded total (${secsToHMS(baseSecs)}).`
      : 'Enter a total greater than 0:00:00.';
    return;
  }
  const deltaHours = deltaSecs / 3600;
  let deltaChars = 0;
  if (charsRaw)    deltaChars = Math.max(0, Number(charsRaw) - baseChars);
  else if (cphRaw) deltaChars = Math.round(Number(cphRaw) * deltaHours);

  const parts = [`Will log: ${fmtTime(deltaSecs)}`];
  if (deltaChars > 0) {
    parts.push(`${fmtChars(deltaChars)} chars`);
    parts.push(`~${fmtChars(Math.round(deltaChars / deltaHours))}/hr`);
  }
  if (!tlogHasBaseline) parts.push('first entry — full total');
  prev.style.display = '';
  prev.textContent = parts.join(' · ');
}

// Seed/re-sync the baseline for the active key WITHOUT logging anything.
async function doSetTotalBaseline() {
  const fb       = document.getElementById('tlog-feedback');
  const newSecs  = parseHMS(document.getElementById('tlog-time').value);
  const charsRaw = document.getElementById('tlog-chars').value.trim();
  if (newSecs === null) {
    fb.className = 'feedback err'; fb.textContent = 'Enter a total time as H:MM:SS.'; return;
  }
  if (tlogMode === 'per_media' && !tlogKey()) {
    fb.className = 'feedback err'; fb.textContent = 'Pick a media to set its baseline.'; return;
  }
  const r = await window.pywebview.api.save_total_log_baseline(tlogKey(), newSecs, charsRaw ? Number(charsRaw) : 0);
  if (r.ok) {
    fb.className = 'feedback ok'; fb.textContent = '✓ Baseline set. Your next entry will log the difference.';
    await refreshTotalLogBaseline();
  } else {
    fb.className = 'feedback err'; fb.textContent = r.error || 'Something went wrong.';
  }
}

// Log the difference since the last entry, then advance the baseline.
async function doTotalLog() {
  const fb       = document.getElementById('tlog-feedback');
  const dt       = document.getElementById('tlog-date').value.trim();
  const newSecs  = parseHMS(document.getElementById('tlog-time').value);
  const charsRaw = document.getElementById('tlog-chars').value.trim();
  const cphRaw   = document.getElementById('tlog-cph').value.trim();
  const title    = tlogMode === 'per_media' ? tlogKey() : (document.getElementById('tlog-media').value || '');

  if (newSecs === null) {
    fb.className = 'feedback err'; fb.textContent = 'Enter a total time as H:MM:SS.'; return;
  }
  if (!/^\d{4}-\d{2}-\d{2}$/.test(dt)) {
    fb.className = 'feedback err'; fb.textContent = 'Date must be YYYY-MM-DD.'; return;
  }
  if (tlogMode === 'per_media' && !tlogKey()) {
    fb.className = 'feedback err'; fb.textContent = 'Pick a media to log against.'; return;
  }

  const r = await window.pywebview.api.submit_total_log(
    tlogKey(), title, newSecs, charsRaw ? Number(charsRaw) : null, cphRaw ? Number(cphRaw) : null, dt);
  if (r.ok) {
    const charsPart = r.logged_chars > 0 ? ` · ${fmtChars(r.logged_chars)} chars` : '';
    fb.className = 'feedback ok'; fb.textContent = `✓ Logged ${fmtTime(r.logged_secs)}${charsPart}`;
    document.getElementById('tlog-time').value  = '';
    document.getElementById('tlog-chars').value = '';
    document.getElementById('tlog-cph').value   = '';
    document.getElementById('tlog-date')._flatpickr?.setDate(today(), false);
    await refreshTotalLogBaseline();
    await populateMediaTitles();
    await renderRecentLogChips('total');
    statsCache = {};
    setStatus('Session logged');
    if (currentPage === 'dashboard') await loadDashboard();
  } else {
    fb.className = 'feedback err'; fb.textContent = r.error || 'Something went wrong.';
  }
}

async function doImportCSV() {
  const path = await window.pywebview.api.open_csv_dialog();
  const fbs  = ['csv-feedback', 'setup-csv-feedback']
                  .map(id => document.getElementById(id)).filter(Boolean);
  if (!path) { fbs.forEach(fb => { fb.className=''; fb.textContent=''; }); return; }
  const r = await window.pywebview.api.do_import_csv(path);
  const cls  = r.imported ? 'feedback ok' : 'feedback';
  const text = `✓ Imported ${r.imported} row(s)` + (r.skipped ? `  (${r.skipped} skipped)` : '');
  fbs.forEach(fb => { fb.className = cls; fb.textContent = text; });
  if (r.imported) { statsCache = {}; setStatus(`Imported ${r.imported} sessions`); }
}

// ── Cover image ────────────────────────────────────────────────────────────
async function dropCoverImage(e, title) {
  const file = e.dataTransfer.files[0];
  if (!file) return;
  // An EPUB dropped here auto-fills the cover + progress-bar length; an image
  // is just the cover, as before.
  if (/\.epub$/i.test(file.name) || file.type === 'application/epub+zip') {
    await importEpubFile(file, title);
    return;
  }
  if (!file.type.startsWith('image/')) return;
  await uploadCoverFile(file, title);
}

// Read a File as base64 (chunked so multi-MB EPUBs don't blow the arg limit).
async function fileToBase64(file) {
  const bytes = new Uint8Array(await file.arrayBuffer());
  let binary = '';
  const CHUNK = 0x8000;
  for (let i = 0; i < bytes.length; i += CHUNK) {
    binary += String.fromCharCode.apply(null, bytes.subarray(i, i + CHUNK));
  }
  return btoa(binary);
}

// ── EPUB chapters → milestones checklist ─────────────────────────────────────
// Size alone can't tell a short prologue from a same-size character-list, so the
// import shows every candidate section (with its char count) pre-set by the
// heuristic and lets the user adjust before creating. See _epub_candidates /
// _epub_finalize in imports.py.
//
// Each row is TRI-state, because "don't make this a milestone" turned out to
// mean two incompatible things:
//   chapter — becomes a milestone
//   merge   — read, but folded into the previous chapter (splitting a book into
//             Parts = mark the part openers 'chapter' and everything else 'merge')
//   skip    — not read at all: chars leave the axis AND the book length
// Only 'skip' moves boundaries. Getting these two confused is what put every
// chapter boundary a constant ~520 chars late: front matter was correctly
// unchecked, then folded straight back into chapter 1.
// Key order is the click-cycle order.
const EPUB_STATE_UI = {
  chapter: { mark: '✓', label: 'Chapter' },
  merge:   { mark: '↰', label: 'Merged into previous' },
  skip:    { mark: '✕', label: 'Skipped — not part of the book' },
};
const EPUB_STATES = Object.keys(EPUB_STATE_UI);

let epubChaptersResolve    = null;
let epubChaptersCandidates = [];
let epubChaptersStates     = [];
let epubChaptersTotal      = 0;
let epubChaptersReplace    = false;

// Show the checklist. Resolves to {sections, replace} on Create, or null on
// cancel. `existing` = milestones the title already has (>0 ⇒ create replaces).
function chooseEpubChapters(title, candidates, total, existing) {
  return new Promise(resolve => {
    epubChaptersResolve    = resolve;
    epubChaptersCandidates = candidates;
    epubChaptersTotal      = total;
    epubChaptersReplace    = existing > 0;

    document.getElementById('epub-chapters-sub').textContent = existing > 0
      ? `“${title}” already has ${existing} milestone${existing === 1 ? '' : 's'} — creating these replaces them.`
      : `Pick which sections of “${title}” become milestones.`;

    const list = document.getElementById('epub-chapters-list');
    list.innerHTML = '';
    candidates.forEach((c, i) => {
      const row = document.createElement('div');
      row.dataset.idx = i;
      row.onclick = () => cycleEpubChapterState(i);
      const st = document.createElement('span');
      st.className = 'epub-ch-state';
      const nm = document.createElement('span');
      nm.className = 'epub-ch-name'; nm.textContent = c.name;
      const ch = document.createElement('span');
      ch.className = 'epub-ch-chars'; ch.textContent = Math.round(c.span).toLocaleString();
      row.append(st, nm, ch);
      list.appendChild(row);
    });
    resetEpubChapterStates();
    document.getElementById('epub-chapters-overlay').style.display = 'flex';
  });
}

function paintEpubChapterRow(i) {
  const row = document.querySelector(`#epub-chapters-list > div[data-idx="${i}"]`);
  if (!row) return;
  const state = epubChaptersStates[i];
  row.className = `epub-ch-row epub-ch-${state}`;
  row.title = `${EPUB_STATE_UI[state].label} — click to change`;
  row.querySelector('.epub-ch-state').textContent = EPUB_STATE_UI[state].mark;
}

function cycleEpubChapterState(i) {
  const next = (EPUB_STATES.indexOf(epubChaptersStates[i]) + 1) % EPUB_STATES.length;
  epubChaptersStates[i] = EPUB_STATES[next];
  paintEpubChapterRow(i);
  updateEpubChaptersCount();
}

function applyEpubChapterStates(states) {
  epubChaptersStates = states;
  states.forEach((_, i) => paintEpubChapterRow(i));
  updateEpubChaptersCount();
}

function setAllEpubChapterStates(state) {
  applyEpubChapterStates(epubChaptersCandidates.map(() => state));
}

function resetEpubChapterStates() {
  applyEpubChapterStates(epubChaptersCandidates.map(c => c.default_state));
}

// Mirror of the compaction in _epub_finalize: skipped spans, plus the head gap
// before the first TOC-named section, leave the book. Kept in sync so the dialog
// can show the length it's about to write.
function epubAdjustedTotal() {
  const cand = epubChaptersCandidates;
  if (!cand.length) return epubChaptersTotal;
  let removed = Number(cand[0].start_chars) || 0;
  cand.forEach((c, i) => {
    if (epubChaptersStates[i] === 'skip') removed += Number(c.span) || 0;
  });
  return Math.max(0, epubChaptersTotal - removed);
}

function updateEpubChaptersCount() {
  const n = { chapter: 0, merge: 0, skip: 0 };
  epubChaptersStates.forEach(s => { n[s]++; });
  const adj     = epubAdjustedTotal();
  const removed = Math.round(epubChaptersTotal - adj);

  const bits = [`${n.chapter} chapter${n.chapter === 1 ? '' : 's'}`];
  if (n.merge) bits.push(`${n.merge} merged`);
  if (n.skip)  bits.push(`${n.skip} skipped`);
  document.getElementById('epub-chapters-count').textContent = bits.join(' · ');

  // The length change isn't a side effect the user should discover later.
  const lenEl = document.getElementById('epub-chapters-length');
  lenEl.textContent = removed > 0
    ? `Book length: ${Math.round(adj).toLocaleString()} chars (−${removed.toLocaleString()} not read)`
    : `Book length: ${Math.round(adj).toLocaleString()} chars`;

  document.getElementById('epub-chapters-ok').disabled = n.chapter === 0;
}

function resolveEpubChapters(value) {
  document.getElementById('epub-chapters-overlay').style.display = 'none';
  const fn = epubChaptersResolve;
  epubChaptersResolve = null;
  if (fn) fn(value);
}

function submitEpubChapters() {
  if (!epubChaptersStates.some(s => s === 'chapter')) return;
  const sections = epubChaptersCandidates.map((c, i) => ({
    name: c.name, start_chars: c.start_chars, state: epubChaptersStates[i],
  }));
  resolveEpubChapters({ sections, replace: epubChaptersReplace });
}

// After an EPUB import, offer the chapter checklist. `candidates` is the
// extractor's chapter_candidates; `total` the book's char count; `existing` the
// title's current milestone count. `setLength` is false when the user typed
// their own book length and we mustn't overwrite it. Returns a short status
// suffix, or '' if declined / nothing created.
async function maybeImportEpubChapters(title, candidates, total, existing, setLength = true) {
  if (!candidates || !candidates.length) return '';
  const choice = await chooseEpubChapters(title, candidates, total, existing);
  if (!choice) return '';
  const r = await window.pywebview.api.apply_epub_chapters(
    title, choice.sections, total, choice.replace, setLength);
  if (!r || !r.ok) { setStatus('Chapter import failed: ' + ((r && r.error) || 'unknown error')); return ''; }
  let msg = `${r.count} chapter${r.count === 1 ? '' : 's'} → milestones`;
  if (r.length_set) msg += `, length → ${r.length_set.toLocaleString()} chars`;
  return msg;
}

// Drag an .epub onto the cover box to auto-fill its cover (first page's image)
// and progress-bar length (its Japanese character count). Writes only those two
// display fields — reading history is untouched. Replacing an existing cover or
// length asks first: the initial call reports the conflict with old/new numbers,
// and the confirmed call re-runs with overwrite=true to commit.
async function importEpubFile(file, title, overwrite = false) {
  setStatus('Reading EPUB…');
  let b64;
  try { b64 = await fileToBase64(file); }
  catch (err) { setStatus('Could not read EPUB file.'); return; }
  const r = await window.pywebview.api.import_epub(title, b64, overwrite);

  if (r && r.needs_confirm) {
    const disp = (currentDetailData && currentDetailData.display_title) || title;
    const acts = [];
    if (r.would_replace_count)
      acts.push(`change its length from ${r.old_count.toLocaleString()} to ${r.new_count.toLocaleString()} chars`);
    if (r.would_replace_cover) acts.push('replace its cover');
    const has = (r.would_replace_count && r.would_replace_cover) ? 'a progress-bar length and a cover'
              : r.would_replace_count ? 'a progress-bar length' : 'a cover';
    const ok = await showConfirm(
      `“${disp}” already has ${has}. This EPUB will ${acts.join(' and ')}. Continue?`,
      'Replace', CT.accent);
    if (!ok) { setStatus(''); return; }
    return importEpubFile(file, title, true);
  }

  if (!r || !r.ok) {
    setStatus('EPUB import failed: ' + ((r && r.error) || 'unknown error'));
    return;
  }

  const bits = [];
  if (r.count_set) bits.push(`${r.char_count.toLocaleString()} chars`);
  bits.push(r.cover_found ? 'cover set' : 'no cover found');

  // Offer chapters → milestones (existing media may already have some).
  let existing = 0;
  try { existing = (await window.pywebview.api.list_milestones(title) || []).length; }
  catch (e) { /* leave existing at 0 */ }
  // Adjust the length only if this import is what set it in the first place.
  const extra = await maybeImportEpubChapters(
    title, r.chapter_candidates, r.char_count, existing, !!r.count_set);
  if (extra) bits.push(extra);

  [mediaAllData, seriesData] = await Promise.all([
    window.pywebview.api.get_media(),
    window.pywebview.api.get_series(),
  ]);
  const media = await window.pywebview.api.get_title_detail(title);
  if (media) renderMediaDetail(media);

  setStatus('✓ EPUB imported — ' + bits.join(', '));
}

async function pickCoverImage(title) {
  const input = document.createElement('input');
  input.type = 'file';
  input.accept = 'image/*';
  input.onchange = async () => {
    if (input.files[0]) await uploadCoverFile(input.files[0], title);
  };
  input.click();
}

async function uploadCoverFile(file, title) {
  const ab = await file.arrayBuffer();
  const bytes = new Uint8Array(ab);
  let binary = '';
  for (let i = 0; i < bytes.length; i++) binary += String.fromCharCode(bytes[i]);
  const r = await window.pywebview.api.set_book_cover(title, btoa(binary));
  if (r.ok) {
    [mediaAllData, seriesData] = await Promise.all([
      window.pywebview.api.get_media(),
      window.pywebview.api.get_series(),
    ]);
    const media = await window.pywebview.api.get_title_detail(title);
    if (media) renderMediaDetail(media);
  }
}


// ── ッツ Reader zip import ──────────────────────────────────────────────────
async function doDropTtsuZip(e) {
  e.preventDefault();
  e.currentTarget.classList.remove('drag-over');
  const file = e.dataTransfer.files[0];
  const fb = document.getElementById('ttsu-feedback');
  if (!file || !file.name.endsWith('.zip')) {
    fb.className = 'feedback err'; fb.textContent = 'Please drop a .zip file.'; return;
  }
  await processTtsuZipFile(file);
}

async function doOpenTtsuZip() {
  const path = await window.pywebview.api.open_ttsu_zip_dialog();
  if (!path) return;
  const fb = document.getElementById('ttsu-feedback');
  fb.className = 'feedback'; fb.textContent = 'Importing…';
  const r = await window.pywebview.api.do_import_ttsu_zip(path);
  showTtsuResult(r);
}

async function processTtsuZipFile(file) {
  const fb = document.getElementById('ttsu-feedback');
  fb.className = 'feedback'; fb.textContent = 'Reading…';
  const ab = await file.arrayBuffer();
  const bytes = new Uint8Array(ab);
  let binary = '';
  for (let i = 0; i < bytes.length; i++) binary += String.fromCharCode(bytes[i]);
  fb.textContent = 'Importing…';
  const r = await window.pywebview.api.do_import_ttsu_zip_b64(btoa(binary));
  showTtsuResult(r);
}

function showTtsuResult(r) {
  const fb = document.getElementById('ttsu-feedback');
  if (r.ok) {
    const t = r.titles.length;
    fb.className = 'feedback ok';
    fb.textContent = `✓ Imported ${r.imported} session${r.imported !== 1 ? 's' : ''} across ${t} title${t !== 1 ? 's' : ''}` +
      (r.skipped ? `  (${r.skipped} skipped)` : '');
    if (r.imported) { statsCache = {}; setStatus(`Imported ${r.imported} ッツ sessions`); }
  } else {
    fb.className = 'feedback err'; fb.textContent = `Error: ${r.error}`;
  }
}

// ── History ────────────────────────────────────────────────────────────────
async function loadHistory() {
  const sessions = await window.pywebview.api.get_history();
  const list     = document.getElementById('history-list');
  list.innerHTML = '';
  if (!sessions.length) {
    list.innerHTML = '<p class="empty-msg">No sessions yet.</p>'; return;
  }
  sessions.forEach(s => list.appendChild(makeSessionRow(s)));
}

// ── Stats helpers ──────────────────────────────────────────────────────────
function updateGranularityUI() {
  document.querySelectorAll('#gran-seg .seg-btn').forEach(b =>
    b.classList.toggle('active', b.dataset.gran === currentGranularity));
}

// Bucket key for a day row at the given granularity. Factored out so the range
// brush can derive identical bucket boundaries (snap-to-bar) with no drift.
function makeBucketKey(daily, gran) {
  // Parse as LOCAL, like bucketByDayOfWeek does. `new Date('2026-03-02')` parses
  // as UTC midnight, but getDay() reads local — so west of UTC every date came
  // back as the previous weekday. Weeks ran Tue→Mon and every Monday landed in
  // the previous week's bar. Formatting back through toISOString() reintroduced
  // the same shift, so the label was wrong too.
  const parse = s => {
    const [y, m, d] = s.split('-').map(Number);
    return new Date(y, m - 1, d);
  };
  // Math.round absorbs the ±1h wobble when a span crosses a DST boundary.
  const dayDiff = (a, b) => Math.round((a - b) / 86400000);

  const weekStart = dateStr => {
    const d = parse(dateStr);
    d.setDate(d.getDate() - ((d.getDay() + 6) % 7));   // Mon=0 … Sun=6, snap to Monday
    return isoDateFromObj(d);
  };
  const origin = daily.length ? parse(daily[0].date) : null;
  return r => {
    if (gran === 'week') return weekStart(r.date);
    if (gran === '2wk') {
      const idx = Math.floor(dayDiff(parse(r.date), origin) / 14);
      const d   = new Date(origin);
      d.setDate(d.getDate() + idx * 14);               // setDate, not +ms, for DST
      return isoDateFromObj(d);
    }
    if (gran === 'month') return r.date.slice(0, 7);
    if (gran === 'year')  return r.date.slice(0, 4);
    return r.date; // 'day'
  };
}

// Day-index boundaries delimiting each display bucket: [0, b1, b2, …, N].
// Bucket k spans daily[bounds[k] .. bounds[k+1]-1]; there are bounds.length-1
// buckets. Keys are monotonic in date order, so one pass finds the edges.
function bucketDayBounds(daily, gran) {
  const n = daily.length;
  if (!n) return [0];
  if (gran === 'day') return Array.from({ length: n + 1 }, (_, i) => i);
  const keyOf = makeBucketKey(daily, gran);
  const bounds = [0];
  let cur = keyOf(daily[0]);
  for (let i = 1; i < n; i++) {
    const k = keyOf(daily[i]);
    if (k !== cur) { bounds.push(i); cur = k; }
  }
  bounds.push(n);
  return bounds;
}

// Index of the bucket containing a given day index.
function bucketIndexOfDay(bounds, day) {
  for (let k = 0; k < bounds.length - 1; k++) if (day < bounds[k + 1]) return k;
  return Math.max(0, bounds.length - 2);
}

function bucketDaily(daily, gran) {
  const MONTH_NAMES = ['Jan','Feb','Mar','Apr','May','Jun','Jul','Aug','Sep','Oct','Nov','Dec'];
  if (!daily.length) return { labels: [], secs: [], chars: [] };

  // spdChars/spdSecs are the backend's per-day reading-speed BASIS (chars-bearing
  // reading only, manual overlay folded in). They're carried through bucketing so
  // a bucket's speed is sum(spdChars)/sum(spdSecs) — totals first, then divide.
  // Deriving speed from the displayed secs instead would fold in chars-less
  // listening time and understate it.
  if (gran === 'day') {
    return {
      labels: daily.map(r => r.date.slice(5)),
      secs:   daily.map(r => r.seconds),
      chars:  daily.map(r => r.chars),
      byType: daily.map(r => r.by_type || {}),
      spdChars: daily.map(r => r.spd_chars || 0),
      spdSecs:  daily.map(r => r.spd_secs  || 0),
    };
  }

  const buckets = {}, order = [];
  const getKey = makeBucketKey(daily, gran);

  daily.forEach(r => {
    const k = getKey(r);
    if (!buckets[k]) { buckets[k] = { secs: 0, chars: 0, byType: {}, spdChars: 0, spdSecs: 0 }; order.push(k); }
    buckets[k].secs  += r.seconds;
    buckets[k].chars += r.chars;
    buckets[k].spdChars += (r.spd_chars || 0);
    buckets[k].spdSecs  += (r.spd_secs  || 0);
    const bt = r.by_type || {};
    for (const t in bt) buckets[k].byType[t] = (buckets[k].byType[t] || 0) + bt[t];
  });

  const multiYear = order[0].slice(0, 4) !== order[order.length - 1].slice(0, 4);
  let labels;
  if (gran === 'year') {
    labels = order;                                   // key is the 4-digit year
  } else if (gran === 'week' || gran === '2wk') {
    labels = order.map(k => multiYear ? k.slice(2, 10).replace(/-/g, '/') : k.slice(5));
  } else {
    labels = order.map(k => {
      const mon = MONTH_NAMES[parseInt(k.slice(5), 10) - 1];
      return multiYear ? `${mon} '${k.slice(2, 4)}` : mon;
    });
  }

  return {
    labels,
    secs:   order.map(k => buckets[k].secs),
    chars:  order.map(k => buckets[k].chars),
    byType: order.map(k => buckets[k].byType),
    spdChars: order.map(k => buckets[k].spdChars),
    spdSecs:  order.map(k => buckets[k].spdSecs),
  };
}

function bucketByDayOfWeek(daily) {
  const labels = ['Mon','Tue','Wed','Thu','Fri','Sat','Sun'];
  const secs   = [0,0,0,0,0,0,0];
  const byType = [{},{},{},{},{},{},{}];
  daily.forEach(r => {
    const [y, m, d] = r.date.split('-').map(Number);
    const wd = (new Date(y, m - 1, d).getDay() + 6) % 7; // Mon=0 .. Sun=6
    secs[wd] += r.seconds;
    const bt = r.by_type || {};
    for (const t in bt) byType[wd][t] = (byType[wd][t] || 0) + bt[t];
  });
  return { labels, secs, byType };
}

// ── Stats ──────────────────────────────────────────────────────────────────
async function loadStats(range_val) {
  await refreshStatsHeatmap();

  // 'Custom' isn't a backend range — re-render the live brush over its base
  // preset, fetching that base first if the cache was cleared (e.g. new ingest).
  if (range_val === 'Custom') {
    if (!statsCache[customBase]) {
      statsCache[customBase] = await window.pywebview.api.get_stats(customBase);
    }
    renderClientStats();
    return;
  }

  if (!statsCache[range_val]) {
    statsCache[range_val] = await window.pywebview.api.get_stats(range_val);
    const others = ['30d','90d','6m','1y','All'].filter(r => r !== range_val);
    setTimeout(() => prefetchStats(others, 0), 500);
  }
  rerenderActiveStats();   // backend-exact cards unless an activity filter is on
}

function prefetchStats(ranges, idx) {
  if (idx >= ranges.length) return;
  const rv = ranges[idx];
  if (!statsCache[rv]) {
    window.pywebview.api.get_stats(rv).then(d => {
      statsCache[rv] = d;
      setTimeout(() => prefetchStats(ranges, idx+1), 300);
    });
  } else {
    prefetchStats(ranges, idx+1);
  }
}

function setSegActive(rv) {
  document.querySelectorAll('#range-seg .seg-btn').forEach(b =>
    b.classList.toggle('active', b.dataset.range === rv));
}

async function setRange(rv) {
  if (rv === 'Custom') { enterCustomMode(); return; }
  currentRange = rv;
  customBase   = rv;
  selStartDay = 0; selEndDay = Infinity; // a preset selection clears any custom brush
  setSegActive(rv);
  await loadStats(rv);
}

async function setGranularity(g) {
  currentGranularity = g;
  updateGranularityUI();
  rerenderActiveStats();
}

// Cumulative is a *shape*, not an overlay: it swaps the bars for a running-total
// line on the same left axis rather than adding a second y-scale. See the note
// on renderDailyCumChart for why.
function setStatsView(v) {
  statsCumulative = (v === 'cum');
  if (statsNeedsClient()) { renderClientStats(); return; }
  if (statsCache[currentRange]) renderDailyChart(statsCache[currentRange].daily);
}

function onSplitToggle() {
  splitByActivity = document.getElementById('split-toggle').checked;
  if (statsNeedsClient()) { renderClientStats(); return; }
  if (statsCache[currentRange]) {
    renderDailyChart(statsCache[currentRange].daily);
    renderDowChart(statsCache[currentRange].daily);
  }
}

// Order activity types: built-ins first (in their canonical order), then any
// custom categories alphabetically. Colors via acolor() — matching the donut,
// which means custom categories render grey (a shared, intentional limitation).
function orderedTypes(typeSet) {
  const builtins = BUILTIN_TYPES.filter(t => typeSet.has(t));
  const customs  = [...typeSet].filter(t => !BUILTIN_TYPES.includes(t)).sort();
  return [...builtins, ...customs];
}

// Build one stacked bar dataset per activity type from a per-bucket byType array.
// `scale` converts secs → display units (e.g. /3600 for hours, /60 for minutes).
// borderRadius/borderSkipped left default so Chart.js rounds only the top segment.
function activityDatasets(byType, scale) {
  const typeSet = new Set();
  byType.forEach(m => Object.keys(m).forEach(t => typeSet.add(t)));
  return orderedTypes(typeSet).map(t => ({
    label: t,
    data: byType.map(m => (m[t] || 0) * scale),
    backgroundColor: acolor(t),
    stack: 'activity',
    borderRadius: 3,
    borderSkipped: false,
  }));
}

async function refreshStatsHeatmap() {
  const curYear = new Date().getFullYear();
  const label   = document.getElementById('heatmap-year-label');
  const nextBtn = document.getElementById('heatmap-next-btn');
  if (label)   label.textContent = heatmapYear;
  if (nextBtn) nextBtn.disabled  = heatmapYear >= curYear;
  const hmData = await window.pywebview.api.get_heatmap(heatmapYear);
  renderHeatmap('heatmap-stats', hmData, null, true, heatmapYear);
}

async function changeHeatmapYear(delta) {
  const curYear = new Date().getFullYear();
  heatmapYear   = Math.min(curYear, Math.max(2000, heatmapYear + delta));
  await refreshStatsHeatmap();
}

function renderStats(d) {
  const rl = d.range_val === 'All' ? 'all time' : d.range_val;
  document.getElementById('sc-time-lbl').textContent   = `Time (${rl})`;
  document.getElementById('sc-chars-lbl').textContent  = `Characters (${rl})`;
  document.getElementById('sc-cph-lbl').textContent    = `Chars / hour (${rl})`;
  document.getElementById('sc-avg-lbl').textContent    = `Avg / day (${rl})`;
  document.getElementById('sc-time').textContent       = fmtTime(d.r_secs);
  document.getElementById('sc-chars').textContent      = fmtChars(d.r_chars);
  document.getElementById('sc-cph').textContent        = d.chars_per_hour ? fmtChars(d.chars_per_hour) : '—';

  // #8 — how this window compares to the one immediately before it, so the big
  // numbers read as movement rather than as bare absolutes. The backend supplies
  // the previous period through the same helper chain, so the two can't drift.
  const prevCph = (d.prev_spd_secs > 0 && d.prev_spd_chars > 0)
    ? d.prev_spd_chars / (d.prev_spd_secs / 3600) : 0;
  setDeltaChip('sc-time-delta',  d.r_secs,          d.prev_secs,  rl);
  setDeltaChip('sc-chars-delta', d.r_chars,         d.prev_chars, rl);
  setDeltaChip('sc-cph-delta',   d.chars_per_hour,  prevCph,      rl);
  document.getElementById('sc-streak').textContent     = `${d.cur_streak}d`;
  document.getElementById('es-best-day').textContent   = fmtTime(d.best_day_secs);
  document.getElementById('es-best-day-date').textContent  = d.best_day_date || '—';
  document.getElementById('es-best-week').textContent  = fmtTime(d.best_week_secs);
  document.getElementById('es-best-week-date').textContent = d.best_week_start ? `w/o ${d.best_week_start}` : '—';
  document.getElementById('sc-avg').textContent        = fmtTime(d.avg_secs);
  document.getElementById('es-consistency').textContent    = `${fmtPct(d.consistency_pct)}%`;
  document.getElementById('es-consistency-sub').textContent = d.active_days ? `${d.active_days}/${d.window_days}d active` : '';
  // Preset range: park the brush handles at the edges (full span, no dimming)
  // and restore the streak card to its live "Current Streak" meaning.
  selStartDay = 0; selEndDay = Infinity;
  document.getElementById('daily-brush')?.classList.remove('active');
  setStreakLabel('Current Streak');
  renderDailyChart(d.daily);
  renderDowChart(d.daily);
  renderDonutChart(d.activity);
  // All-time views; independent of the range selector, so fetched once and
  // cached rather than refetched on every range change.
  renderShowcase();
}

// ── Charts ─────────────────────────────────────────────────────────────────
function destroyChart(id) {
  if (charts[id]) { charts[id].destroy(); delete charts[id]; }
}

// ── Chart empty state ──────────────────────────────────────────────────────
// A chart with nothing to plot used to just be destroyed, leaving a blank card
// that reads as broken rather than as "no data here". Overlay a message on the
// wrapper instead. Passing a falsy msg clears it; upsertChart() does that
// automatically whenever a chart actually renders, so callers only ever have to
// set it, never unset it.
function setChartEmpty(canvasId, msg) {
  const canvas = document.getElementById(canvasId);
  if (!canvas) return;
  const wrap = canvas.closest('.chart-wrap') || canvas.parentElement;
  if (!wrap) return;
  let el = wrap.querySelector('.chart-empty');
  if (!msg) {
    canvas.style.visibility = '';
    if (el) el.remove();
    return;
  }
  canvas.style.visibility = 'hidden';
  if (!el) {
    el = document.createElement('div');
    el.className = 'chart-empty';
    wrap.appendChild(el);
  }
  el.textContent = msg;
}

// ── Legend room ────────────────────────────────────────────────────────────
// Chart.js renders the legend/key INSIDE the canvas, so flipping a "split" or
// "cumulative" toggle steals vertical space from the plot and squashes the bars
// (the "checkbox shrinks the graph" reports). To keep the plot area constant we
// grow the canvas — and with it its card ("blue box") — by one legend row's
// worth (LEGEND_ROOM) whenever a legend is shown, so the key lands in an added
// bottom strip instead of eating the chart. The canvas `height` attribute drives
// render height here (the card parents are unconstrained + maintainAspectRatio:
// false, which is why each canvas carries an explicit height=…), so we just
// retag it. Measuring the laid-out legend and resize()-ing to fit was tried and
// misbehaved in the webview (canvas collapsed), so we stick to retag + rebuild:
// if a chart already owns the canvas we drop it first, because Chart.js caches
// its render height from construction — the re-render then rebuilds at the new
// size. Call this BEFORE (re)building the chart.
//
// The "did it change" test reads OUR OWN tag, never the height attribute back.
// Chart.js owns that attribute once a chart is live: retinaScale() overwrites it
// with the DEVICE-pixel height (base × devicePixelRatio — 225 for a 180 base at
// 125% display scaling), so on any scaled display the attribute never equals
// `want` and this destroyed + rebuilt the chart on EVERY render. That starved
// morphBars(), whose slide needs a live chart in upsertChart() to morph FROM —
// the Stats bars' sliding transition silently disappeared, but only for users
// whose devicePixelRatio ≠ 1.
const LEGEND_ROOM = 31;
function reserveLegendRoom(canvasId, chartKey, base, legendOn) {
  const cv = document.getElementById(canvasId);
  if (!cv) return;
  const want = String(legendOn ? base + LEGEND_ROOM : base);
  if (cv.dataset.reservedHeight === want) return;
  if (charts[chartKey]) { charts[chartKey].destroy(); delete charts[chartKey]; }
  cv.dataset.reservedHeight = want;
  cv.setAttribute('height', want);
}

const CHART_ANIM = { duration: 400, easing: 'easeOutQuart' };
const MORPH_MS   = 500;
const morphState = {};

function easeOutCubic(t) { return 1 - Math.pow(1 - t, 3); }

function roundedTopRect(ctx, x, y, w, h, r) {
  if (h <= 0 || w <= 0) return;
  r = Math.min(r, w / 2, h);
  ctx.beginPath();
  ctx.moveTo(x, y + h);
  ctx.lineTo(x, y + r);
  ctx.quadraticCurveTo(x, y, x + r, y);
  ctx.lineTo(x + w - r, y);
  ctx.quadraticCurveTo(x + w, y, x + w, y + r);
  ctx.lineTo(x + w, y + h);
  ctx.closePath();
  ctx.fill();
}

function morphBars(id, chart, canvas, newConfig) {
  if (morphState[id]) morphState[id].finish();

  // Capture bar-segment geometry for EVERY bar dataset (keyed by label), so a
  // stacked split chart animates all its colored segments — not just dataset 0.
  // Non-bar datasets are excluded here; they're hidden during the morph and
  // restored on finish. Matching by label (not index) keeps the slide correct
  // when the activity set differs across the change.
  const grab = datasets => {
    const segs = [];
    datasets.forEach((d, k) => {
      if (d.type === 'line') return;
      segs.push({
        label: d.label,
        color: typeof d.backgroundColor === 'string' ? d.backgroundColor : CT.accent,
        bars:  chart.getDatasetMeta(k).data.map(b => ({ x:b.x, y:b.y, base:b.base, width:b.width })),
      });
    });
    return segs;
  };

  const oldSegs = grab(chart.data.datasets);

  const morphData = {
    labels: newConfig.data.labels,
    datasets: newConfig.data.datasets.map(d => ({
      ...d,
      backgroundColor: 'rgba(0,0,0,0)',
      ...(d.type === 'line' ? { borderColor: 'rgba(0,0,0,0)' } : {})
    }))
  };
  chart.data    = morphData;
  chart.options = { ...newConfig.options, animation: false };
  chart.update();

  const newSegs = grab(newConfig.data.datasets);

  const wrap = canvas.parentElement;
  wrap.querySelectorAll('.chart-morph-overlay').forEach(o => o.remove());

  const W = canvas.offsetWidth;
  const H = canvas.offsetHeight;
  const dpr = window.devicePixelRatio || 1;
  const overlay = document.createElement('canvas');
  overlay.className = 'chart-morph-overlay';
  overlay.style.cssText =
    `position:absolute;left:${canvas.offsetLeft}px;top:${canvas.offsetTop}px;` +
    `width:${W}px;height:${H}px;pointer-events:none;`;
  overlay.width  = W * dpr;
  overlay.height = H * dpr;
  const octx = overlay.getContext('2d');
  octx.scale(dpr, dpr);
  wrap.appendChild(overlay);

  const offRight   = W + 60;
  const items      = [];
  const oldByLabel = {}; oldSegs.forEach(s => { oldByLabel[s.label] = s; });
  const newByLabel = {}; newSegs.forEach(s => { newByLabel[s.label] = s; });
  const allLabels  = [...new Set([...oldSegs.map(s => s.label), ...newSegs.map(s => s.label)])];

  allLabels.forEach(lab => {
    const o = oldByLabel[lab], nw = newByLabel[lab];
    const color  = (nw || o).color;
    const oBars  = o ? o.bars : [];
    const nBars  = nw ? nw.bars : [];
    const morphN = Math.min(oBars.length, nBars.length);
    for (let i = 0; i < morphN; i++) {            // shared columns → slide in place
      items.push({
        sx:oBars[i].x, sy:oBars[i].y, sb:oBars[i].base, sw:oBars[i].width,
        ex:nBars[i].x, ey:nBars[i].y, eb:nBars[i].base, ew:nBars[i].width,
        color, fade: false
      });
    }
    for (let i = nBars.length; i < oBars.length; i++) {   // removed → slide off + fade
      items.push({
        sx:oBars[i].x, sy:oBars[i].y, sb:oBars[i].base, sw:oBars[i].width,
        ex:offRight,   ey:oBars[i].y, eb:oBars[i].base, ew:oBars[i].width,
        color, fade: true
      });
    }
    for (let i = oBars.length; i < nBars.length; i++) {   // added → slide in from right
      items.push({
        sx:offRight,   sy:nBars[i].y, sb:nBars[i].base, sw:nBars[i].width,
        ex:nBars[i].x, ey:nBars[i].y, eb:nBars[i].base, ew:nBars[i].width,
        color, fade: false
      });
    }
  });

  const state = { done: false };
  morphState[id] = state;
  state.finish = () => {
    if (state.done) return;
    state.done = true;
    chart.data    = newConfig.data;
    chart.options = newConfig.options;
    chart.update('none');
    overlay.remove();
    if (morphState[id] === state) delete morphState[id];
  };

  const t0 = performance.now();
  function frame(t) {
    if (state.done) return;
    const p = Math.min(1, (t - t0) / MORPH_MS);
    const e = easeOutCubic(p);
    octx.clearRect(0, 0, W, H);
    let lastColor = null;
    for (let i = 0; i < items.length; i++) {
      const it = items[i];
      const x      = it.sx + (it.ex - it.sx) * e;
      const y      = it.sy + (it.ey - it.sy) * e;
      const base   = it.sb + (it.eb - it.sb) * e;
      const width  = it.sw + (it.ew - it.sw) * e;
      const height = base - y;
      if (height <= 0 || width <= 0) continue;
      octx.globalAlpha = it.fade ? 1 - e : 1;
      if (it.color !== lastColor) { octx.fillStyle = it.color; lastColor = it.color; }
      roundedTopRect(octx, x - width / 2, y, width, height, 3);
    }
    if (p < 1) requestAnimationFrame(frame);
    else state.finish();
  }
  requestAnimationFrame(frame);
}

function upsertChart(id, ctxId, config) {
  const existing = charts[id];
  const canvas   = document.getElementById(ctxId);
  setChartEmpty(ctxId, null);   // this chart has data — drop any empty overlay
  if (existing && existing.config.type === config.type) {
    const oldLen = existing.data.labels?.length ?? 0;
    const newLen = config.data.labels?.length ?? 0;
    // morphBars handles both the single flat bar and the stacked split bars
    // (it captures every bar dataset's segments and slides them by label).
    if (config.type === 'bar' && oldLen > 0 && newLen > 0 && oldLen !== newLen) {
      morphBars(id, existing, canvas, config);
      return existing;
    }
    existing.data = config.data;
    existing.options = config.options;
    existing.update();
    return existing;
  }
  if (existing) { existing.destroy(); delete charts[id]; }
  charts[id] = new Chart(canvas.getContext('2d'), config);
  return charts[id];
}

// The Stats page's one chart, driven by the same Time / Chars / Speed control as
// the detail views. It does NOT reuse renderDetailMetricChart: this chart also
// carries granularity bucketing, the drag brush, the cumulative overlay and
// split-by-activity, and bending one function around both would be worse than
// two that share a control and a stylesheet.
//
// Availability differs per metric and is data-driven, not taste:
//   • Split by activity — Time only. `by_type` holds SECONDS per type; there is
//     no per-type chars breakdown, and stacking a rate is meaningless.
//   • Cumulative — Time and Chars only. A running total of a rate is nonsense.
//   • Split by activity — additionally off in Cumulative, which draws no bars
//     for the per-type stack to live in.
function statsMetricAvail(b) {
  return {
    time:  b.secs.some(v => v > 0),
    chars: b.chars.some(v => v > 0),
    speed: b.spdSecs.some(v => v > 0) && b.spdChars.some(v => v > 0),
  };
}

function syncStatsMetricSeg(avail) {
  const seg = document.getElementById('stats-metric-seg');
  if (seg) {
    seg.querySelectorAll('.seg-btn').forEach(b => {
      const ok = avail[b.dataset.metric];
      b.disabled = !ok;
      b.classList.toggle('active', ok && b.dataset.metric === statsMetric);
    });
  }
  // Controls that don't apply to the active metric are faded and made inert
  // rather than hidden, so the header doesn't reflow as you switch.
  const setOff = (id, off) => {
    const lbl = document.getElementById(id);
    if (!lbl) return;
    lbl.style.opacity       = off ? '0.4' : '';
    lbl.style.pointerEvents = off ? 'none' : '';
    const box = lbl.querySelector('input');
    if (box) box.disabled = off;
  };
  setOff('split-toggle-label', statsMetric !== 'time' || statsCumulative);
  // The view seg is a seg, not a checkbox — it fades via :disabled, and stays on
  // whatever it was so switching away to Speed and back doesn't lose the choice.
  document.querySelectorAll('#stats-view-seg .seg-btn').forEach(b => {
    b.disabled = statsMetric === 'speed';
    b.classList.toggle('active', (b.dataset.view === 'cum') === statsCumulative);
  });
}

function setStatsMetric(m) {
  statsMetric = m;
  if (statsNeedsClient()) { renderClientStats(); return; }
  if (statsCache[currentRange]) renderDailyChart(statsCache[currentRange].daily);
}

function renderDailyChart(daily) {
  const bucket  = bucketDaily(daily, currentGranularity);
  const { labels, secs, chars, byType, spdChars, spdSecs } = bucket;

  const avail = statsMetricAvail(bucket);
  if (!avail[statsMetric]) statsMetric = avail.time ? 'time' : (avail.chars ? 'chars' : 'time');
  syncStatsMetricSeg(avail);

  if (statsMetric === 'speed') return renderDailySpeedChart(bucket);

  const isChars = statsMetric === 'chars';
  if (statsCumulative) return renderDailyCumChart(bucket, isChars);

  const isHours = currentGranularity !== 'day';
  const scale   = isChars ? 1 : (isHours ? 1 / 3600 : 1 / 60);
  const values  = isChars ? chars : secs.map(s => s * scale);
  const fmt     = isChars
    ? v => `${fmtChars(Math.round(v))} chars`
    : v => isHours ? `${v.toFixed(1)}h` : fmtTime(v * 60);

  // Split is Time-only (see above), so chars never stacks.
  const doSplit = splitByActivity && !isChars;

  // Labels are passed whole and thinned by Chart.js autoSkip (see x.ticks).
  // Blanking every Nth label by hand made the visible set jump around as the
  // range changed, and reliably dropped the last date — the one you most want.

  const datasets = doSplit
    ? activityDatasets(byType, scale)
    : [{ label: isChars ? 'Characters' : 'Time', data: values,
         backgroundColor: isChars ? CT.success : CT.accent,
         borderRadius: 3, borderSkipped: false }];

  reserveLegendRoom('chart-daily', 'daily', 180, doSplit);
  upsertChart('daily', 'chart-daily', {
    type: 'bar',
    data: { labels, datasets },
    options: {
      responsive: true, maintainAspectRatio: false, animation: CHART_ANIM,
      onResize: () => positionDailyBrush(),
      interaction: doSplit ? { mode: 'index', intersect: false } : undefined,
      plugins: {
        legend: { display: doSplit, position: 'bottom',
                  labels: { color:CT.dim, boxWidth:12, boxHeight:12, usePointStyle:true } },
        tooltip: {
          callbacks: {
            title: c => labels[c[0].dataIndex],
            label: c => `${c.dataset.label}: ${fmt(c.raw)}`,
            footer: doSplit
              ? c => `Total: ${fmt(c.reduce((a, x) => a + x.raw, 0))}`
              : undefined,
          }
        }
      },
      scales: {
        x: { stacked: doSplit, grid:{color:CT.grid}, ticks:{color:CT.dim,maxRotation:0,autoSkip:true,maxTicksLimit:14} },
        y: { stacked: doSplit, grid:{color:CT.grid}, ticks:{color:CT.dim, callback: v => fmt(v)}, afterFit: s => { s.width = 62; } },
      }
    }
  });

  // Keep the range-selector handles aligned with the (re)laid-out plot area.
  requestAnimationFrame(positionDailyBrush);
}

// Running total of a bucketed series in DISPLAY units. Chars pass through; time
// is HOURS at every granularity — deliberately not the bar view's granularity-
// dependent scale, which would plot a range total in minutes at day granularity.
function statsCumSeries(bucket, isChars) {
  let run = 0;
  const vals = isChars ? (bucket.chars || []) : (bucket.secs || []).map(s => s / 3600);
  return vals.map(v => (run += v, run));
}

// Cumulative view — the same Time/Chars data as a running total. It REPLACES the
// bars rather than riding above them on a second y-axis, which is what the old
// "Show cumulative" checkbox did. That overlay had three problems, all of them
// the second scale's fault: its forced stepSize rounded the axis max up to a
// step boundary (a 106h total picked step 50, so the axis ran to 150 and the
// curve used two thirds of the plot), its ticks never landed on the left axis's
// gridlines, and — unlike the left axis, pinned at 62px — its width followed its
// tick text, so flipping the toggle or changing range shifted the plot edge and
// dragged the brush along with it. One axis, one series, none of that.
//
// Always hours, regardless of granularity. A running total is a range-sized
// number, so the day-granularity "minutes" unit the bar view uses would read
// 6,360 min for a total the goal burn-up already calls 106h. Same treatment as
// that chart (renderGoalChart), deliberately — including tension 0, because a
// cumulative series is monotonic and Chart.js's cubic interpolation dips on a
// flat stretch, drawing reading that went backwards.
function renderDailyCumChart(bucket, isChars) {
  const { labels } = bucket;
  const cumVals = statsCumSeries(bucket, isChars);
  const fmt   = isChars ? v => `${fmtChars(Math.round(v))} chars` : v => fmtTime(v * 3600);
  // Identity follows the metric, not the shape — same colors the bars use, so
  // switching view doesn't repaint the series.
  const color = isChars ? CT.success : CT.accent;

  // Single series: no legend, so the canvas keeps its base height and the card
  // no longer jumps 31px when you switch view.
  reserveLegendRoom('chart-daily', 'daily', 180, false);
  upsertChart('daily', 'chart-daily', {
    type: 'line',
    data: { labels, datasets: [{
      label: isChars ? 'Characters' : 'Time', data: cumVals,
      borderColor: color, backgroundColor: ctAlpha(color, 0.12),
      borderWidth: 2.5, pointRadius: 0, pointHoverRadius: 5,
      pointBackgroundColor: color, pointBorderColor: CT.card, pointBorderWidth: 2,
      fill: 'origin', tension: 0,
    }] },
    options: {
      responsive: true, maintainAspectRatio: false, animation: CHART_ANIM,
      onResize: () => positionDailyBrush(),
      interaction: { mode: 'index', intersect: false },
      plugins: {
        legend: { display: false },
        tooltip: { callbacks: {
          title: c => labels[c[0].dataIndex],
          label: c => `Total: ${fmt(c.raw)}`,
        } },
      },
      scales: {
        x: { grid:{color:CT.grid}, ticks:{color:CT.dim,maxRotation:0,autoSkip:true,maxTicksLimit:14} },
        y: { grid:{color:CT.grid}, beginAtZero: true,
             ticks:{color:CT.dim, callback: v => isChars ? fmtChars(v) : fmtHourTick(v)},
             afterFit: s => { s.width = 62; } },
      },
    }
  });

  requestAnimationFrame(positionDailyBrush);
}

// #7 — reading speed over time. The one thing Stats couldn't answer before: you
// could see speed per title, per series, per milestone and across titles in the
// portal, but never "am I getting faster overall".
//
// Every point is sum(spdChars) / sum(spdSecs) for its bucket — totals first,
// then divide. Never a mean of per-day speeds, never sessions.reading_speed.
function renderDailySpeedChart(bucket) {
  const { labels, spdChars, spdSecs } = bucket;
  const speed = spdChars.map((c, i) => (spdSecs[i] > 0 && c > 0) ? c / (spdSecs[i] / 3600) : null);

  // A rolling overlay only earns its place at day granularity; week/month/year
  // buckets are already smoothed, and a 7-BUCKET average of months is nonsense.
  const showRolling = currentGranularity === 'day';
  const rolling = showRolling ? twRolling(spdChars, spdSecs, 7) : null;

  const datasets = [];
  if (showRolling) {
    // Same treatment as the detail views: raw dotted and dimmed, trend solid on
    // top. Array order is draw + legend order — see renderDetailMetricChart.
    datasets.push({
      label: 'Per day', data: speed,
      borderColor: ctAlpha(CT.purple, 0.45), backgroundColor: 'transparent',
      borderWidth: 1.5, borderDash: [3, 3], pointRadius: 0, pointHoverRadius: 5,
      fill: false, tension: 0.35, spanGaps: false,
    });
    datasets.push({
      label: '7d rolling', data: rolling,
      borderColor: CT.purple, backgroundColor: 'transparent',
      borderWidth: 2.5, pointRadius: 0, pointHoverRadius: 6,
      pointBackgroundColor: CT.purple, pointBorderColor: CT.card, pointBorderWidth: 2,
      fill: false, tension: 0.35, spanGaps: true,
    });
  } else {
    datasets.push({
      label: 'Chars / hour', data: speed,
      borderColor: CT.purple, backgroundColor: 'transparent',
      borderWidth: 2.5, pointRadius: 3, pointHoverRadius: 6,
      pointBackgroundColor: CT.purple, pointBorderColor: CT.card, pointBorderWidth: 2,
      fill: false, tension: 0.35, spanGaps: true,
    });
  }

  reserveLegendRoom('chart-daily', 'daily', 180, showRolling);
  upsertChart('daily', 'chart-daily', {
    type: 'line',
    data: { labels, datasets },
    options: {
      responsive: true, maintainAspectRatio: false, animation: CHART_ANIM,
      onResize: () => positionDailyBrush(),
      interaction: { mode: 'index', intersect: false },
      plugins: {
        legend: { display: showRolling, position: 'bottom',
                  labels: { color:CT.dim, boxWidth:12, boxHeight:12, usePointStyle:true } },
        tooltip: { callbacks: {
          title: c => labels[c[0].dataIndex],
          label: c => c.raw != null ? `${c.dataset.label}: ${fmtChars(Math.round(c.raw))}/h` : '',
        } },
      },
      scales: {
        x: { grid:{color:CT.grid}, ticks:{color:CT.dim,maxRotation:0,autoSkip:true,maxTicksLimit:14} },
        y: { grid:{color:CT.grid}, ticks:{color:CT.dim, callback: v => fmtChars(v)},
             beginAtZero: false, afterFit: s => { s.width = 62; } },
      },
    }
  });

  requestAnimationFrame(positionDailyBrush);
}

function renderDowChart(daily) {
  const { labels, secs, byType } = bucketByDayOfWeek(daily);
  if (!secs.some(s => s > 0)) {
    destroyChart('dow');
    setChartEmpty('chart-dow', 'No activity in this range');
    return;
  }
  const values = secs.map(s => s / 3600);

  const datasets = splitByActivity
    ? activityDatasets(byType, 1 / 3600)
    : [{ label: 'Time', data: values, backgroundColor: CT.accent,
         borderRadius: 3, borderSkipped: false }];

  reserveLegendRoom('chart-dow', 'dow', 180, splitByActivity);
  upsertChart('dow', 'chart-dow', {
    type: 'bar',
    data: { labels, datasets },
    options: {
      responsive: true, maintainAspectRatio: false, animation: CHART_ANIM,
      interaction: splitByActivity ? { mode: 'index', intersect: false } : undefined,
      plugins: {
        legend: { display: splitByActivity, position: 'bottom',
                  labels: { color:CT.dim, boxWidth:12, boxHeight:12, usePointStyle:true } },
        tooltip: { callbacks: {
          title: c => labels[c[0].dataIndex],
          label: splitByActivity
            ? c => `${c.dataset.label}: ${fmtTime(c.raw * 3600)}`
            : c => fmtTime(secs[c.dataIndex]),
          footer: splitByActivity
            ? c => `Total: ${fmtTime(c.reduce((a, x) => a + x.raw, 0) * 3600)}`
            : undefined,
        } }
      },
      scales: {
        x: { stacked: splitByActivity, grid:{color:CT.grid}, ticks:{color:CT.dim,maxRotation:0,autoSkip:true,maxTicksLimit:14} },
        y: { stacked: splitByActivity, grid:{color:CT.grid}, ticks:{color:CT.dim, callback: v => `${v.toFixed(1)}h`}, afterFit: s => { s.width = 62; } },
      }
    }
  });
}

function renderDonutChart(activity) {
  if (!activity.length) {
    destroyChart('donut');
    setChartEmpty('chart-donut', 'No activity in this range');
    return;
  }
  const labels = activity.map(a=>a.type);
  const values = activity.map(a=>a.seconds);
  const colors = labels.map(acolor);
  upsertChart('donut', 'chart-donut', {
    type: 'doughnut',
    data: {
      labels,
      datasets: [{ data: values, backgroundColor: colors,
                   borderColor:CT.card, borderWidth:2, hoverOffset:4 }]
    },
    options: {
      responsive: true, maintainAspectRatio: false, animation: CHART_ANIM, cutout: '60%',
      plugins: {
        legend: { position:'bottom', labels:{color:CT.dim,padding:10,boxWidth:12,boxHeight:12,usePointStyle:true} },
        tooltip: { callbacks: { label: c => `${c.label}: ${fmtTime(c.raw)}` } }
      }
    }
  });
}

// ── Lifetime showcase charts ───────────────────────────────────────────────
// Three all-time views that deliberately ignore the range selector. Fetched
// once per Stats load in a single round trip (Api.get_showcase).
let showcaseCache = null;

async function renderShowcase() {
  if (!showcaseCache) showcaseCache = await window.pywebview.api.get_showcase();
  const d = showcaseCache || {};
  renderStreamsChart(d.streams || { dates: [], series: [] });
  renderSpeedDistChart(d.speeds || []);
  renderActivityTrendChart(d.activity || []);
}

// #10 — stacked area of characters per title per week. Chart.js has no true
// streamgraph (wiggle baseline) and vendoring a plugin for one chart isn't worth
// it; a stacked area answers the same question and reads more cleanly anyway.
// Titles use the same stable hash colors as the stat portal, so a title is the
// same color here as it is there.
function renderStreamsChart(s) {
  if (!s.dates.length) { destroyChart('streams'); setChartEmpty('chart-streams', 'No reading yet'); return; }
  const labels = s.dates.map(d => d.slice(2).replace(/-/g, '/'));
  // Bands are stacked adjacently, so two neighbours sharing a color is worse
  // than a title changing color between views. Start from the stable portal hash
  // and walk forward only when it would collide with the band below.
  let prev = null;
  const datasets = s.series.map(x => {
    // "Other" is a residual bucket, not a title — keep it neutral so it never
    // looks like one of the named bands. STREAM_PALETTE therefore drops the grey
    // that CAT_PALETTE carries, or a real title could hash onto a shade that
    // reads as the residual.
    let color;
    if (x.title === 'Other') {
      color = CT.dim;
    } else {
      const start = paletteIndex(x.title, STREAM_PALETTE.length);
      color = STREAM_PALETTE[start];
      for (let i = 0; i < STREAM_PALETTE.length && color === prev; i++) {
        color = STREAM_PALETTE[(start + i + 1) % STREAM_PALETTE.length];
      }
    }
    prev = color;
    return {
      label: x.display_title,
      data: x.values,
      borderColor: color,
      // Solid, not translucent. Stacked bands don't overlap, so transparency
      // bought nothing — and it made the legend lie: the swatch carries a
      // full-opacity 1px border ring that dominates a 12px box, so the key read
      // vivid while the band read dusty. Solid makes swatch and band identical.
      backgroundColor: color,
      borderWidth: 1,
      pointRadius: 0,
      pointHoverRadius: 4,
      fill: true,
      tension: 0.3,
    };
  });
  reserveLegendRoom('chart-streams', 'streams', 220, true);
  upsertChart('streams', 'chart-streams', {
    type: 'line',
    data: { labels, datasets },
    options: {
      responsive: true, maintainAspectRatio: false, animation: CHART_ANIM,
      interaction: { mode: 'index', intersect: false },
      plugins: {
        legend: { position: 'bottom',
                  labels: { color: CT.dim, boxWidth: 12, boxHeight: 12, usePointStyle: true } },
        tooltip: { callbacks: {
          title: c => `Week of ${s.dates[c[0].dataIndex]}`,
          label: c => c.raw > 0 ? `${c.dataset.label}: ${fmtChars(Math.round(c.raw))}` : null,
          footer: c => `Total: ${fmtChars(Math.round(c.reduce((a, x) => a + x.raw, 0)))}`,
        } },
      },
      scales: {
        x: { grid: { color: CT.grid }, ticks: { color: CT.dim, maxRotation: 0, autoSkip: true, maxTicksLimit: 14 } },
        y: { stacked: true, grid: { color: CT.grid },
             ticks: { color: CT.dim, callback: v => fmtChars(v) },
             afterFit: sc => { sc.width = 62; } },
      },
    }
  });
}

// #11 — box plots, hand-rolled. Chart.js core has no boxplot and this is an
// offline app, so rather than vendor a plugin the box is drawn from three
// floating-bar datasets stacked on the same category:
//   whisker  thin bar spanning [min, max]
//   box      full-width bar spanning [q1, q3]
//   median   hairline bar at the median
// Horizontal, because title labels need the room.
function renderSpeedDistChart(rows) {
  if (!rows.length) {
    destroyChart('speed-dist');
    setChartEmpty('chart-speed-dist', 'Needs a few titles with 5+ reading days');
    return;
  }
  const labels = rows.map(r => r.display_title);
  const colorOf = r => PORTAL_PALETTE[paletteIndex(r.title, PORTAL_PALETTE.length)];
  // Every qualifying title is shown, so the canvas grows with the list rather
  // than cramming rows into a fixed height.
  const cv = document.getElementById('chart-speed-dist');
  if (cv) {
    const want = String(Math.max(160, rows.length * 26 + 40));
    // Same rule as reserveLegendRoom: compare our own tag, not the height
    // attribute — Chart.js rewrites that one in device pixels.
    if (cv.dataset.reservedHeight !== want) {
      destroyChart('speed-dist');       // Chart.js caches render height at construction
      cv.dataset.reservedHeight = want;
      cv.setAttribute('height', want);
    }
  }
  // A median hairline needs non-zero width on a linear axis; scale it to the
  // spread so it stays visible whatever the units.
  const span = Math.max(...rows.map(r => r.max)) - Math.min(...rows.map(r => r.min)) || 1;
  const tick = span * 0.004;

  upsertChart('speed-dist', 'chart-speed-dist', {
    type: 'bar',
    data: {
      labels,
      datasets: [
        { label: 'Range', data: rows.map(r => [r.min, r.max]),
          backgroundColor: rows.map(r => ctAlpha(colorOf(r), 0.22)),
          barPercentage: 0.22, categoryPercentage: 0.8, borderSkipped: false },
        { label: 'Middle half', data: rows.map(r => [r.q1, r.q3]),
          backgroundColor: rows.map(r => ctAlpha(colorOf(r), 0.65)),
          borderColor: rows.map(colorOf), borderWidth: 1, borderRadius: 2,
          barPercentage: 0.72, categoryPercentage: 0.8, borderSkipped: false },
        { label: 'Median', data: rows.map(r => [r.median - tick, r.median + tick]),
          backgroundColor: rows.map(() => CT.text),
          barPercentage: 0.72, categoryPercentage: 0.8, borderSkipped: false },
      ],
    },
    options: {
      indexAxis: 'y',
      responsive: true, maintainAspectRatio: false, animation: CHART_ANIM,
      interaction: { mode: 'index', intersect: false },
      plugins: {
        legend: { display: false },
        tooltip: { callbacks: {
          title: c => rows[c[0].dataIndex].display_title,
          label: () => null,
          afterBody: c => {
            const r = rows[c[0].dataIndex];
            const n = v => fmtChars(Math.round(v)) + '/h';
            return [
              `median ${n(r.median)}`,
              `middle half ${n(r.q1)} – ${n(r.q3)}`,
              `range ${n(r.min)} – ${n(r.max)}`,
              `overall ${n(r.mean)} over ${r.days} days`,
            ];
          },
        } },
      },
      scales: {
        x: { grid: { color: CT.grid }, ticks: { color: CT.dim, callback: v => fmtChars(v) },
             beginAtZero: false },
        y: { stacked: true, grid: { display: false },
             ticks: { color: CT.dim, autoSkip: false },
             afterFit: sc => { sc.width = 130; } },
      },
    }
  });
}

// #12 — activity mix as a share, per month. The donut says what the mix IS right
// now; this says how it has moved, which is the more interesting question.
function renderActivityTrendChart(rows) {
  if (!rows.length) {
    destroyChart('activity-trend');
    setChartEmpty('chart-activity-trend', 'Not enough history yet');
    return;
  }
  const typeSet = new Set();
  rows.forEach(r => Object.keys(r.types).forEach(t => typeSet.add(t)));
  const types = orderedTypes(typeSet);
  const labels = rows.map(r => r.month);
  // Normalised to 100% per month: the question is share, not volume — volume
  // already has the daily chart.
  const totals = rows.map(r => Object.values(r.types).reduce((a, b) => a + b, 0) || 1);
  const datasets = types.map(t => ({
    label: t,
    data: rows.map((r, i) => (r.types[t] || 0) / totals[i] * 100),
    // Solid for the same reason as the stream bands: the legend swatch carries a
    // full-opacity border ring, so a translucent fill made the key and the band
    // look like different colors.
    backgroundColor: acolor(t),
    borderColor: acolor(t),
    borderWidth: 1,
    pointRadius: 0,
    fill: true,
    tension: 0.25,
  }));
  reserveLegendRoom('chart-activity-trend', 'activity-trend', 200, true);
  upsertChart('activity-trend', 'chart-activity-trend', {
    type: 'line',
    data: { labels, datasets },
    options: {
      responsive: true, maintainAspectRatio: false, animation: CHART_ANIM,
      interaction: { mode: 'index', intersect: false },
      plugins: {
        legend: { position: 'bottom',
                  labels: { color: CT.dim, boxWidth: 12, boxHeight: 12, usePointStyle: true } },
        tooltip: { callbacks: {
          label: c => c.raw > 0.05 ? `${c.dataset.label}: ${c.raw.toFixed(0)}%` : null,
          footer: c => `Total: ${fmtTime(rows[c[0].dataIndex]
            ? Object.values(rows[c[0].dataIndex].types).reduce((a, b) => a + b, 0) : 0)}`,
        } },
      },
      scales: {
        x: { grid: { color: CT.grid }, ticks: { color: CT.dim, maxRotation: 0, autoSkip: true, maxTicksLimit: 12 } },
        y: { stacked: true, max: 100, grid: { color: CT.grid },
             ticks: { color: CT.dim, callback: v => `${v}%` },
             afterFit: sc => { sc.width = 62; } },
      },
    }
  });
}

// ── Daily-chart range brush (custom range selector) ─────────────────────────
// Draggable handles on the daily-time chart let the user narrow the Stats page
// to an exact date window. The whole feature is client-side: the loaded `daily`
// series already has every load-bearing per-day overlay (GSM rollover
// attribution + manual shave) folded into each day's final number, so summing a
// contiguous sub-slice is correct by construction — no backend round-trip and
// no re-touching the attribution machinery. The brush slices statsCache[customBase].

// Percentage change vs the previous equivalent period, shown under a stat card.
// Hidden entirely when there's no basis to compare against (the 'All' range has
// no earlier period, and a first-ever period would read as a meaningless +∞).
function setDeltaChip(id, cur, prev, rangeLabel) {
  const el = document.getElementById(id);
  if (!el) return;
  if (!prev || prev <= 0 || cur == null) { el.style.display = 'none'; return; }
  const pct = (cur - prev) / prev * 100;
  const up  = pct >= 0;
  // Under half a percent either way reads as flat rather than as a fake trend.
  const flat = Math.abs(pct) < 0.5;
  el.style.display = '';
  el.className = 'delta-chip ' + (flat ? 'flat' : (up ? 'up' : 'down'));
  el.textContent = `${flat ? '±' : (up ? '↑' : '↓')}${Math.abs(pct).toFixed(0)}% vs prior ${rangeLabel}`;
}

function setStreakLabel(text) {
  const el = document.getElementById('sc-streak-lbl');
  if (el) el.textContent = text;
}

function fmtShortDate(iso) {
  const M = ['Jan','Feb','Mar','Apr','May','Jun','Jul','Aug','Sep','Oct','Nov','Dec'];
  const p = iso.split('-');
  return `${M[+p[1] - 1]} ${+p[2]}`;
}

// The daily series everything downstream operates on: the loaded preset behind
// Custom mode, with the activity filter applied. Filtering only zeroes per-type
// time (via by_type) and — since Reading is the only char source — drops chars
// wholesale when Reading is excluded. Rows are kept (dense series) so day
// indices stay aligned; the array is rebuilt only when a filter is active.
function activeDaily() {
  const baseKey = currentRange === 'Custom' ? customBase : currentRange;
  const base = statsCache[baseKey];
  if (!base) return [];
  if (!excludedTypes.size) return base.daily;
  const readingOut = excludedTypes.has('Reading');
  return base.daily.map(r => {
    const bt = r.by_type || {};
    let secs = 0;
    const fbt = {};
    for (const t in bt) if (!excludedTypes.has(t)) { secs += bt[t]; fbt[t] = bt[t]; }
    return { date: r.date, seconds: secs, chars: readingOut ? 0 : r.chars, by_type: fbt,
             spd_chars: readingOut ? 0 : (r.spd_chars || 0),
             spd_secs:  readingOut ? 0 : (r.spd_secs  || 0) };
  });
}

function statsBaseDaily() { return activeDaily(); }

// Whether the view must be recomputed client-side (a brush sub-range and/or an
// activity filter is active) rather than rendered from the exact backend preset.
function statsNeedsClient() {
  return currentRange === 'Custom' || excludedTypes.size > 0;
}

// The full set of categories that exist in the tracker for the filter checkbox
// list — the built-in types plus the user's custom categories — unioned with
// anything present in the loaded data (so a legacy/unknown type still appears).
// Built-ins first (canonical order), then custom categories alphabetically.
function activityFilterTypes(cats) {
  const present = new Set();
  const baseKey = currentRange === 'Custom' ? customBase : currentRange;
  const base = statsCache[baseKey];
  (base ? base.daily : []).forEach(r => { for (const t in (r.by_type || {})) present.add(t); });
  return orderedTypes(new Set([...BUILTIN_TYPES, ...cats.map(c => c.name), ...present]));
}

// Resolve the stored day-index selection to whole buckets of the CURRENT
// granularity, so the handles snap to bar edges and the recomputed stats cover
// exactly the bars the user sees. Returns the inclusive day span plus the
// bucket-space edges (kL, kR over B buckets) used to place the handles/masks.
function effectiveDayRange() {
  const daily  = statsBaseDaily();
  const n      = daily.length;
  const bounds = bucketDayBounds(daily, currentGranularity);
  const B      = bounds.length - 1;
  if (n === 0 || B < 1) return { startDay: 0, endDay: -1, kL: 0, kR: 0, B: 1, bounds };
  const start = Math.max(0, Math.min(selStartDay, n - 1));
  const end   = Math.max(start, Math.min(selEndDay, n - 1));
  const kL = bucketIndexOfDay(bounds, start);
  const kR = bucketIndexOfDay(bounds, end);
  return { startDay: bounds[kL], endDay: bounds[kR + 1] - 1, kL, kR, B, bounds };
}

// Recompute every Stats card + chart input from the brushed sub-slice. Mirrors
// the backend helpers (get_range_totals / get_range_extra_stats) but over the
// selected window: totals are plain sums of already-adjusted per-day values;
// cph divides chars by the slice's Reading time (never sessions.reading_speed).
function computeBrushView() {
  const daily = statsBaseDaily();
  const { startDay, endDay } = effectiveDayRange();
  const sub = daily.slice(startDay, endDay + 1);

  let secs = 0, chars = 0, spdChars = 0, spdSecs = 0, active = 0, bestDay = null;
  const byTypeTotals = {};
  sub.forEach(r => {
    secs += r.seconds; chars += r.chars;
    const bt = r.by_type || {};
    // cph comes from the backend's own per-day speed basis (chars-bearing reading
    // + manual overlay, from get_daily_reading_speed_basis), not reconstructed
    // from the activity slice — so a full-span brush equals the 'All' preset and
    // chars-less / time_excluded rows can't skew it.
    spdChars += (r.spd_chars || 0);
    spdSecs  += (r.spd_secs  || 0);
    for (const t in bt) byTypeTotals[t] = (byTypeTotals[t] || 0) + bt[t];
    if (r.seconds > 0) active++;
    if (!bestDay || r.seconds > bestDay.secs) bestDay = { secs: r.seconds, date: r.date };
  });

  // Best Mon-anchored week within the window (matches _best_week server-side).
  const weeks = {};
  sub.forEach(r => {
    const [y, m, d] = r.date.split('-').map(Number);
    const dt = new Date(y, m - 1, d);
    dt.setDate(dt.getDate() - ((dt.getDay() + 6) % 7));   // back up to Monday
    const key = `${dt.getFullYear()}-${String(dt.getMonth() + 1).padStart(2, '0')}-${String(dt.getDate()).padStart(2, '0')}`;
    weeks[key] = (weeks[key] || 0) + r.seconds;
  });
  let bestWeek = null;
  for (const k in weeks) if (!bestWeek || weeks[k] > bestWeek.secs) bestWeek = { secs: weeks[k], start: k };

  // Streak: if the window reaches the latest day (today) it's a live "current
  // streak" (trailing active run); otherwise a past slice, so report the longest
  // run within it. Label swaps to match (set in applyBrushCards).
  const includesLatest = endDay === daily.length - 1;
  // Grace for an unlogged "today": when the window reaches today and today has no
  // activity yet, it's in-progress — don't break the streak or count it against
  // consistency until it's logged. (Backend get_streak/get_range_extra_stats do
  // the same for the non-brushed presets.)
  const pendingToday = includesLatest && sub.length > 0 && sub[sub.length - 1].seconds <= 0;
  let streak = 0;
  if (includesLatest) {
    let i = sub.length - 1;
    if (pendingToday) i--;                                 // skip today; start at yesterday
    for (; i >= 0 && sub[i].seconds > 0; i--) streak++;
  } else {
    let run = 0;
    sub.forEach(r => { if (r.seconds > 0) { run++; if (run > streak) streak = run; } else run = 0; });
  }

  const windowDays = sub.length;
  const consistencyDays = Math.max(1, windowDays - (pendingToday ? 1 : 0));
  const denomSecs  = Math.max(0, spdSecs);                 // clamp like the backend (raw + manual)
  // floor, not round — matches the backend's int() truncation so a full-span
  // brush shows the identical number as the 'All' preset (no off-by-one).
  const cph = (spdChars > 0 && denomSecs > 0) ? Math.floor(spdChars / (denomSecs / 3600)) : 0;
  const activity = Object.keys(byTypeTotals)
    .map(t => ({ type: t, seconds: byTypeTotals[t] }))
    .filter(a => a.seconds > 0)
    .sort((a, b) => b.seconds - a.seconds);

  return {
    sub, secs, chars, cph,
    avg_secs:        windowDays ? secs / windowDays : 0,
    window_days:     consistencyDays,
    active_days:     active,
    consistency_pct: Math.round(active / consistencyDays * 1000) / 10,
    best_day:        bestDay,
    best_week:       bestWeek,
    streak,
    streak_is_current: includesLatest,
    activity,
    start_date:      sub.length ? sub[0].date : null,
    end_date:        sub.length ? sub[sub.length - 1].date : null,
  };
}

function applyBrushCards(v) {
  // Full preset span (filter-only, no brush) keeps the range name; a brushed
  // sub-window shows its date span so the cards say what they're counting.
  const sel  = effectiveDayRange();
  const full = currentRange !== 'Custom'
            && sel.startDay === 0 && sel.endDay === statsBaseDaily().length - 1;
  const lbl = full
    ? (currentRange === 'All' ? 'all time' : currentRange)
    : (v.start_date && v.end_date
        ? `${fmtShortDate(v.start_date)} – ${fmtShortDate(v.end_date)}`
        : 'custom');
  document.getElementById('sc-time-lbl').textContent  = `Time (${lbl})`;
  document.getElementById('sc-chars-lbl').textContent = `Characters (${lbl})`;
  document.getElementById('sc-cph-lbl').textContent   = `Chars / hour (${lbl})`;
  document.getElementById('sc-avg-lbl').textContent   = `Avg / day (${lbl})`;
  document.getElementById('sc-time').textContent   = fmtTime(v.secs);
  document.getElementById('sc-chars').textContent  = fmtChars(v.chars);
  document.getElementById('sc-cph').textContent    = v.cph ? fmtChars(v.cph) : '—';
  // No delta chips in the brushed/filtered view: an arbitrary dragged window has
  // no well-defined "previous equivalent period", and the backend basis was
  // computed for the preset range, not this slice. Showing it would be a number
  // that looks meaningful and isn't.
  ['sc-time-delta', 'sc-chars-delta', 'sc-cph-delta'].forEach(id => {
    const el = document.getElementById(id);
    if (el) el.style.display = 'none';
  });
  setStreakLabel(v.streak_is_current ? 'Current Streak' : 'Longest streak');
  document.getElementById('sc-streak').textContent = `${v.streak}d`;
  document.getElementById('sc-avg').textContent    = fmtTime(v.avg_secs);
  document.getElementById('es-best-day').textContent       = fmtTime(v.best_day ? v.best_day.secs : 0);
  document.getElementById('es-best-day-date').textContent  = v.best_day ? v.best_day.date : '—';
  document.getElementById('es-best-week').textContent      = fmtTime(v.best_week ? v.best_week.secs : 0);
  document.getElementById('es-best-week-date').textContent = v.best_week ? `w/o ${v.best_week.start}` : '—';
  document.getElementById('es-consistency').textContent     = `${fmtPct(v.consistency_pct)}%`;
  document.getElementById('es-consistency-sub').textContent =
    v.active_days ? `${v.active_days}/${v.window_days}d active` : '';
}

// Client-recompute render path, used whenever a brush sub-range and/or an
// activity filter is active (a plain unfiltered preset uses renderStats with
// the backend-exact cards instead). Everything flows from the filtered+sliced
// daily series via computeBrushView.
function renderClientStats() {
  const baseKey = currentRange === 'Custom' ? customBase : currentRange;
  if (!statsCache[baseKey]) return;
  const daily = activeDaily();
  const sel   = effectiveDayRange();
  const isFullSpan = sel.startDay === 0 && sel.endDay === daily.length - 1;
  const brush = document.getElementById('daily-brush');
  // Dimming + the floating date label appear only for a real sub-range.
  if (brush) brush.classList.toggle('active', currentRange === 'Custom' && !isFullSpan);
  const v = computeBrushView();
  applyBrushCards(v);
  renderDailyChart(daily);               // filtered full series; masks dim the unselected part
  renderDowChart(v.sub);                 // downstream views follow the selection
  renderDonutChart(v.activity);
  requestAnimationFrame(positionDailyBrush);
}

// Pick the right render path for the current filter/brush state.
function rerenderActiveStats() {
  if (statsNeedsClient()) renderClientStats();
  else if (statsCache[currentRange]) renderStats(statsCache[currentRange]);
}

function enterCustomMode() {
  if (currentRange !== 'Custom') {
    if (!statsCache[currentRange]) return;
    customBase   = currentRange;
    currentRange = 'Custom';
  }
  setSegActive('Custom');
  renderClientStats();
}

function clearBrush() {
  selStartDay = 0; selEndDay = Infinity;
  currentRange = customBase;
  setSegActive(customBase);
  document.getElementById('daily-brush')?.classList.remove('active');
  rerenderActiveStats();                 // keeps any active activity filter applied
}

// ── Brush geometry + drag ───────────────────────────────────────────────────
function positionDailyBrush() {
  const chart  = charts['daily'];
  const brush  = document.getElementById('daily-brush');
  const canvas = document.getElementById('chart-daily');
  if (!brush) return;
  if (!chart || !canvas || !chart.chartArea || !(chart.chartArea.right > chart.chartArea.left)) {
    brush.hidden = true;
    return;
  }
  const ca = chart.chartArea;
  brush.hidden = false;
  brush.style.left   = (canvas.offsetLeft + ca.left) + 'px';
  brush.style.top    = (canvas.offsetTop  + ca.top)  + 'px';
  brush.style.width  = (ca.right - ca.left) + 'px';
  brush.style.height = (ca.bottom - ca.top) + 'px';
  updateBrushVisual();
}

function updateBrushVisual() {
  const brush = document.getElementById('daily-brush');
  if (!brush || brush.hidden) return;
  const daily = statsBaseDaily();
  const { startDay, endDay, kL, kR, B } = effectiveDayRange();
  const lPct = kL / B * 100;              // left edge of the first selected bucket
  const rPct = (kR + 1) / B * 100;        // right edge of the last selected bucket
  brush.querySelector('.brush-mask-l').style.width    = lPct.toFixed(3) + '%';
  brush.querySelector('.brush-mask-r').style.width    = (100 - rPct).toFixed(3) + '%';
  brush.querySelector('.brush-handle-l').style.left   = lPct.toFixed(3) + '%';
  brush.querySelector('.brush-handle-r').style.left   = rPct.toFixed(3) + '%';
  const label = brush.querySelector('.brush-label');
  if (label) {
    label.style.left = ((lPct + rPct) / 2).toFixed(3) + '%';
    if (daily.length && endDay >= startDay) {
      brush.querySelector('.brush-range').textContent =
        `${fmtShortDate(daily[startDay].date)} – ${fmtShortDate(daily[endDay].date)} · ${endDay - startDay + 1}d`;
    }
  }
}

let _brushDrag = null;
function startBrushDrag(e, side) {
  e.preventDefault();
  const daily = statsBaseDaily();
  if (!daily.length) return;
  const brush = document.getElementById('daily-brush');
  brush.classList.add('dragging');
  if (currentRange !== 'Custom') {        // first touch of a handle flips the filter to Custom
    customBase   = currentRange;
    currentRange = 'Custom';
    setSegActive('Custom');
    brush.classList.add('active');
  }
  _brushDrag = { side };
  const move = ev => onBrushDrag(ev);
  const up = () => {
    window.removeEventListener('pointermove', move);
    window.removeEventListener('pointerup', up);
    brush.classList.remove('dragging');
    _brushDrag = null;
    renderClientStats();                  // settle: redraw downstream charts at the final selection
  };
  window.addEventListener('pointermove', move);
  window.addEventListener('pointerup', up);
}

function onBrushDrag(ev) {
  if (!_brushDrag) return;
  const brush = document.getElementById('daily-brush');
  const rect  = brush.getBoundingClientRect();
  let f = (ev.clientX - rect.left) / Math.max(1, rect.width);
  f = Math.max(0, Math.min(1, f));
  // Snap the dragged edge to the nearest bucket boundary; the opposite edge
  // stays pinned to its current bucket. Selection never shrinks below one bucket.
  const { kL, kR, B, bounds } = effectiveDayRange();
  if (_brushDrag.side === 'l') {
    const k = Math.max(0, Math.min(Math.round(f * B), kR));        // start bucket, ≤ right bucket
    selStartDay = bounds[k];
    selEndDay   = bounds[kR + 1] - 1;
  } else {
    const kb = Math.max(kL + 1, Math.min(Math.round(f * B), B));   // end boundary, > left bucket
    selStartDay = bounds[kL];
    selEndDay   = bounds[kb] - 1;
  }
  updateBrushVisual();
  applyBrushCards(computeBrushView());    // live, lightweight: cards only while dragging
}

function initDailyBrush() {
  const brush = document.getElementById('daily-brush');
  if (!brush || brush.dataset.init) return;
  brush.dataset.init = '1';
  brush.querySelectorAll('.brush-handle').forEach(h =>
    h.addEventListener('pointerdown', e => startBrushDrag(e, h.dataset.side)));
  const reset = brush.querySelector('.brush-reset');
  if (reset) reset.addEventListener('click', clearBrush);
  window.addEventListener('resize', () => requestAnimationFrame(positionDailyBrush));
}

// ── Stats activity filter ───────────────────────────────────────────────────
// Check off activity types to drop them from the whole Stats view. Only time is
// per-type; chars come solely from Reading, so excluding Reading zeroes chars
// while excluding anything else leaves chars intact (see activeDaily()).
async function toggleActivityFilterPop(ev) {
  ev.stopPropagation();
  const pop = document.getElementById('activity-filter-pop');
  if (!pop) return;
  if (pop.hidden) {
    await buildActivityFilterPop();
    pop.hidden = false;
    document.addEventListener('click', closeActivityFilterOnOutside);
  } else {
    closeActivityFilterPop();
  }
}

function closeActivityFilterPop() {
  const pop = document.getElementById('activity-filter-pop');
  if (pop) pop.hidden = true;
  document.removeEventListener('click', closeActivityFilterOnOutside);
}

function closeActivityFilterOnOutside(e) {
  const wrap = document.querySelector('.filter-wrap');
  if (wrap && !wrap.contains(e.target)) closeActivityFilterPop();
}

async function buildActivityFilterPop() {
  const pop = document.getElementById('activity-filter-pop');
  let cats = [];
  try { cats = await window.pywebview.api.get_categories(); } catch (e) { cats = []; }
  // Real category colors (built-in palette + each custom category's own color),
  // so the swatches read clearly even though the donut greys customs out.
  const colorMap = Object.fromEntries([
    ...BUILTIN_TYPES.map(t => [t, ACOLORS[t]]),
    ...cats.map(c => [c.name, c.color]),
  ]);
  const types = activityFilterTypes(cats);
  if (!types.length) { pop.innerHTML = '<div class="filter-empty">No categories</div>'; return; }
  pop.innerHTML =
    `<div class="filter-head"><span>Show activities</span>` +
    `<button class="filter-reset-link" data-reset>All</button></div>` +
    types.map(() =>
      `<label class="filter-row"><input type="checkbox">` +
      `<span class="filter-swatch"></span><span class="filter-name"></span></label>`
    ).join('');
  const rows = pop.querySelectorAll('.filter-row');
  types.forEach((t, i) => {
    const row = rows[i];
    row.querySelector('.filter-swatch').style.background = colorMap[t] || acolor(t);
    row.querySelector('.filter-name').textContent = t;
    const cb = row.querySelector('input');
    cb.checked = !excludedTypes.has(t);
    cb.addEventListener('change', () => toggleActivityType(t, cb.checked));
  });
  pop.querySelector('[data-reset]').addEventListener('click', resetActivityFilter);
}

function toggleActivityType(t, checked) {
  if (checked) excludedTypes.delete(t);
  else         excludedTypes.add(t);
  updateActivityFilterBtn();
  rerenderActiveStats();
}

function resetActivityFilter() {
  excludedTypes.clear();
  updateActivityFilterBtn();
  buildActivityFilterPop();   // re-check every box
  rerenderActiveStats();
}

function updateActivityFilterBtn() {
  const btn = document.getElementById('activity-filter-btn');
  const lbl = document.getElementById('activity-filter-label');
  if (!btn || !lbl) return;
  const n = excludedTypes.size;
  btn.classList.toggle('has-filter', n > 0);
  lbl.textContent = n > 0 ? `Filter (${n})` : 'Filter';
}

// ── Goals ──────────────────────────────────────────────────────────────────
let goalPaceView = 'daily';

function setGoalPaceView(pace) {
  goalPaceView = pace;
  document.querySelectorAll('#goal-pace-seg .seg-btn').forEach(btn => {
    btn.classList.toggle('active', btn.dataset.pace === pace);
  });
  loadGoals();
}

function updateGoalUnit() {
  const metric = document.getElementById('goal-metric').value;
  const chunk  = document.getElementById('goal-chunk').value;
  const isEdit = editingGoalId !== null;
  const suffix = isEdit ? '' : (chunk === 'daily' ? '/day' : chunk === 'weekly' ? '/week' : chunk === 'monthly' ? '/month' : '');
  const isTimeMetric = metric === 'time_seconds' || metric === 'time_chars';
  document.getElementById('goal-target-label').textContent =
    isTimeMetric ? `Target (hours${suffix})` : `Target (characters${suffix})`;
}

async function populateGoalActivitySelect() {
  const cats     = await window.pywebview.api.get_categories();
  const allTypes = [...BUILTIN_TYPES, ...cats.map(c => c.name)];
  const sel      = document.getElementById('goal-activity');
  sel.innerHTML  = '<option value="">All activities</option>';
  allTypes.forEach(t => {
    const o = document.createElement('option');
    o.value = t; o.textContent = t;
    sel.appendChild(o);
  });
}

const goalDataCache = {};

async function loadGoals() {
  setGoalPanelMode('default');
  document.getElementById('goal-label').value    = '';
  document.getElementById('goal-target').value   = '';
  document.getElementById('goal-deadline').value = '';
  document.getElementById('goal-start').value    = '';
  await populateGoalActivitySelect();
  const goals = await window.pywebview.api.get_goals();
  goals.forEach(g => { goalDataCache[g.id] = g; });
  const list  = document.getElementById('goal-list');
  dropBurnupCharts();
  list.innerHTML = '';
  const active = goals.filter(g => !g.user_finished);
  if (!active.length) {
    list.innerHTML = '<p class="empty-msg">No goals yet. Add one above.</p>'; return;
  }
  const inProgress = active.filter(g => !g.is_overdue);
  const overdue    = active.filter(g => g.is_overdue);
  [...inProgress, ...overdue].forEach(g => list.appendChild(makeGoalCard(g)));
  restoreOpenBurnups(active);
}

let goalPanelMode = 'default';

function setGoalPanelBtn(active) {
  document.getElementById('completed-btn').classList.toggle('active', active === 'completed');
  document.getElementById('new-goal-btn').classList.toggle('active', active === 'new');
}

function setGoalPanelMode(mode) {
  goalPanelMode = mode;
  document.getElementById('goal-active-view').style.display    = mode === 'default' ? 'block' : 'none';
  document.getElementById('goal-completed-view').style.display = mode === 'completed' ? 'block' : 'none';
  document.getElementById('goal-form-card').style.display      = mode === 'new' ? 'block' : 'none';
  setGoalPanelBtn(mode === 'default' ? null : mode);
  if (mode !== 'new') _resetGoalFormMode();
}

async function showCompletedGoals() {
  if (goalPanelMode === 'completed') { hideCompletedGoals(); return; }
  setGoalPanelMode('completed');
  const goals = await window.pywebview.api.get_goals();
  goals.forEach(g => { goalDataCache[g.id] = g; });
  const list  = document.getElementById('goal-completed-list');
  dropBurnupCharts();
  list.innerHTML = '';
  const finished = goals.filter(g => g.user_finished);
  if (!finished.length) {
    list.innerHTML = '<p class="empty-msg">No completed goals yet.</p>'; return;
  }
  finished.forEach(g => list.appendChild(makeGoalCard(g)));
  restoreOpenBurnups(finished);
}

function hideCompletedGoals() {
  setGoalPanelMode('default');
  // The completed list's render dropped the active list's burn-up charts (their
  // canvases survive the view switch, the Chart instances don't), so rebuild.
  loadGoals();
}

function makeGoalCard(g) {
  const el = document.createElement('div');
  el.className = 'goal-card';

  const isTime  = g.metric === 'time_seconds';
  const isChars = g.metric === 'chars_read';
  const perUnit = g.chunk_period === 'daily' ? '/day' : g.chunk_period === 'weekly' ? '/week' : g.chunk_period === 'monthly' ? '/month' : '';

  function fmtMetric(v) {
    if (!v && v !== 0) return '—';
    if (isTime)  return fmtTime(v);
    if (isChars) return fmtChars(Math.round(v));
    return String(Math.round(v));
  }

  const pct = g.pct;
  const fillColor = g.is_complete ? CT.success : '#FF6B6B';

  let statusBadge;
  if (g.is_complete) {
    statusBadge = `<span class="badge" style="color:#4ECBA0;background:#0d2b1e">✓ Complete</span>`;
  } else if (g.is_overdue) {
    statusBadge = `<span class="badge" style="color:#FF6B6B;background:#2b0d0d">Overdue</span>`;
  } else {
    const urgency = g.days_left <= 3 ? '#FF6B6B' : g.days_left <= 7 ? '#FF9F5B' : 'var(--dim)';
    statusBadge = `<span class="badge" style="color:${urgency}">${g.days_left}d left</span>`;
  }

  let chunkHtml = '';
  if (!g.is_complete && !g.is_overdue && g.days_left > 0 && g.remaining > 0) {
    let chunkNeeded, originalChunk, periodDone, periodLabel, periodUnit;
    let barTarget, tickCount, expectedTickIdx, periodChars = 0;
    const [_y, _m, _d] = today().split('-').map(Number);
    const now      = new Date(_y, _m - 1, _d);
    const shortFmt = d => d.toLocaleDateString(undefined, { month: 'short', day: 'numeric' });
    let periodRange;
    // The period target is frozen at the start of the period and re-baselines
    // only at the next period boundary. We reconstruct the period-start state
    // from current values: remaining_at_start = remaining + done-this-period,
    // and days_left_at_start = days_left + days-elapsed-this-period. Both are
    // invariant across the period (reading cancels within a day; the day-to-day
    // index growth cancels the days_left decrease), so the bar target holds
    // steady while only the fill moves.
    if (goalPaceView === 'daily') {
      const remPs   = g.remaining + (g.today_completed || 0);
      // days_left (db.py) is exclusive of today; today is still a reading day,
      // so the pacing denominator must add it back (days remaining incl. today).
      const daysLeftPs = g.days_left + 1;
      chunkNeeded   = daysLeftPs > 0 ? remPs / daysLeftPs : 0;
      originalChunk = g.target / Math.max(1, g.total_days);
      periodDone    = g.today_completed || 0;
      periodChars   = g.chars_today || 0;
      periodLabel   = 'Today';
      periodUnit    = '/day';
      periodRange   = shortFmt(now);
      barTarget     = chunkNeeded;
      tickCount     = 0;
      expectedTickIdx = 0;
    } else if (goalPaceView === 'weekly') {
      // +1: days_left excludes today; the inclusive period length (week_period_days
      // / the *7 multiplier) counts it, so the denominator must too (else target > remPs).
      const daysLeftPs = (g.days_left + 1) + ((g.week_day_index || 1) - 1);
      const remPs      = g.remaining + (g.week_completed || 0);
      const flatDaily  = daysLeftPs > 0 ? remPs / daysLeftPs : 0;
      chunkNeeded   = flatDaily * 7;
      originalChunk = g.target / Math.max(1, g.total_days / 7);
      periodDone    = g.week_completed || 0;
      periodChars   = g.chars_week || 0;
      periodLabel   = 'This week';
      periodUnit    = '/week';
      const monOffset = (now.getDay() + 6) % 7;
      const mon = new Date(now); mon.setDate(now.getDate() - monOffset);
      const sun = new Date(mon); sun.setDate(mon.getDate() + 6);
      periodRange   = `${shortFmt(mon)} – ${shortFmt(sun)}`;
      tickCount     = g.week_period_days || 7;
      expectedTickIdx = g.week_day_index || 0;
      barTarget     = flatDaily * tickCount;
    } else {
      // +1: see weekly branch — days_left excludes today, the inclusive
      // month_period_days / *30.44 multiplier counts it.
      const daysLeftPs = (g.days_left + 1) + ((g.month_day_index || 1) - 1);
      const remPs      = g.remaining + (g.month_completed || 0);
      const flatDaily  = daysLeftPs > 0 ? remPs / daysLeftPs : 0;
      chunkNeeded   = flatDaily * 30.44;
      originalChunk = g.target / Math.max(1, g.total_days / 30.44);
      periodDone    = g.month_completed || 0;
      periodChars   = g.chars_month || 0;
      periodLabel   = 'This month';
      periodUnit    = '/month';
      periodRange   = now.toLocaleDateString(undefined, { month: 'long', year: 'numeric' });
      tickCount     = g.month_period_days || 30;
      expectedTickIdx = g.month_day_index || 0;
      barTarget     = flatDaily * tickCount;
    }
    const behind   = chunkNeeded > originalChunk * 1.05;
    const ahead    = chunkNeeded < originalChunk * 0.95;
    const icon     = behind ? '⚠' : ahead ? '↑' : '→';
    const color    = behind ? '#FF9F5B' : ahead ? CT.success : 'var(--dim)';
    const periodPct = barTarget > 0 ? Math.min(100, periodDone / barTarget * 100) : 0;
    const barColor  = periodPct >= 100 ? CT.success : CT.accent;
    const tickStyle = tickCount > 1 ? `--tick-step:${(100/tickCount).toFixed(4)}%` : '';
    const ticksHtml = tickCount > 1 ? `<div class="daily-bar-ticks" style="${tickStyle}"></div>` : '';
    const expectedTickHtml = (tickCount > 1 && expectedTickIdx > 0 && expectedTickIdx < tickCount)
      ? `<div class="daily-bar-expected-tick" style="left:${(expectedTickIdx * 100 / tickCount).toFixed(4)}%" title="Expected by end of today"></div>`
      : '';
    chunkHtml = `
      <div class="goal-chunk" style="color:${color}">
        <span>${icon} ${fmtMetric(chunkNeeded)}${periodUnit} to finish on time</span>
      </div>
      <div class="daily-bar-row">
        <span class="daily-bar-label">${periodLabel} ${fmtMetric(periodDone)} / ${fmtMetric(barTarget)}</span>
        <div class="daily-bar-track">
          <div class="daily-bar-fill" style="width:${periodPct}%;background:${barColor}"></div>
          ${ticksHtml}
          ${expectedTickHtml}
        </div>
      </div>
      <div style="font-size:10px;color:var(--muted);margin-top:2px">${periodRange}${g.track_chars ? ` · <span class="goal-chars-companion">${fmtChars(Math.round(periodChars))} chars ${periodLabel === 'Today' ? 'today' : 'this ' + (periodUnit === '/week' ? 'week' : 'month')}</span>` : ''}</div>`;
  } else if (g.is_overdue) {
    chunkHtml = `<div class="goal-chunk" style="color:#FF6B6B">Missed deadline — ${fmtMetric(g.remaining)} still remaining</div>`;
  }

  // The projected finish used to be a chip on the card, next to a button that
  // opened a chart of the same projection. It lives in the panel head now — one
  // place, and the chart is right underneath it showing how it was arrived at.
  const projHead = g.projected_end
    ? `projected finish: ${g.projected_end}`
    : 'cumulative progress vs required pace';

  const actLabel = g.activity_type ? ` · ${g.activity_type}` : '';
  const charsLabel = g.track_chars
    ? ` · <span class="goal-chars-companion">${fmtChars(Math.round(g.chars_completed || 0))} chars</span>`
    : '';

  const finishBtn = g.is_complete && !g.user_finished
    ? `<button class="btn btn-xs btn-outline" style="border-color:#4ECBA0;color:#4ECBA0" onclick="doFinishGoal(${g.id})">Mark finished</button>`
    : '';

  const burnupOpen = goalBurnupOpen.has(g.id);

  el.innerHTML = `
    <div class="goal-card-header">
      <span class="goal-label">${g.label}</span>
      <div class="goal-badges">
        ${statusBadge}
        ${finishBtn}
        <button class="btn btn-xs btn-danger" onclick="doDeleteGoal(${g.id})">✕</button>
      </div>
    </div>
    <div class="progress-wrap">
      <div class="progress-track">
        <div class="progress-fill" style="width:${Math.min(100, pct)}%;background:${fillColor}"></div>
      </div>
      ${(() => {
        // Pace-aligned with the period bar's red tick and every other pacing
        // calc in the system (chunk_needed, original_chunk, barTarget), which
        // all use target/total_days as the daily pace. elapsed includes today
        // (+1) so the marker means "by end of today", and we clamp to total
        // so the deadline day sits exactly at 100%.
        const total = Math.max(1, g.total_days);
        const elapsed = Math.max(0, Math.min(total, (g.total_days - g.days_left) + 1));
        const expPct = (elapsed / total) * 100;
        // Match the right-side progress %: 1-decimal precision, always shown.
        const expDisp = fmtPct(expPct);
        const expVal = fmtMetric((expPct / 100) * g.target);
        return `<div class="progress-expected" style="left:${expPct}%" title="Expected by end of today: ${expDisp}% (${expVal})"></div>`;
      })()}
    </div>
    <div class="goal-meta">
      <span class="goal-numbers">${fmtMetric(g.completed)} / ${fmtMetric(g.target)}${actLabel}${charsLabel}</span>
      <span class="goal-pct" style="color:${fillColor}">${fmtPct(pct)}%</span>
    </div>
    ${chunkHtml}
    <div style="display:flex;justify-content:space-between;align-items:center;margin-top:2px">
      <div style="font-size:10px;color:var(--muted)">deadline: ${g.deadline} · started: ${g.start_date}</div>
      <div style="display:flex;align-items:center;gap:8px">
        <button class="btn btn-xs goal-burnup-btn${burnupOpen ? ' active' : ''}" id="goal-burnup-btn-${g.id}"
                title="Where your current pace lands, against the pace this goal needs"
                onclick="toggleGoalBurnup(${g.id})">Projection ${burnupOpen ? '▴' : '▾'}</button>
        <button class="btn btn-xs" style="background:none;border:none;color:var(--dim);font-size:11px;padding:0 2px;cursor:pointer;opacity:0.55" title="Edit goal" onclick="openGoalEdit(${g.id})">✎</button>
      </div>
    </div>
    <div class="goal-burnup" id="goal-burnup-${g.id}" style="display:${burnupOpen ? '' : 'none'}">
      <div class="goal-burnup-head">
        <span title="Finish date extrapolated from your average pace since the goal started">${projHead}</span>
        <span class="goal-slack" id="goal-slack-${g.id}"></span>
      </div>
      <div class="goal-burnup-chart"><canvas id="goal-burnup-canvas-${g.id}" height="190"></canvas></div>
    </div>`;
  return el;
}

// ── Burn-up chart ──────────────────────────────────────────────────────────
// Cumulative progress against the straight line the goal needs, plus where the
// current pace actually lands. Collapsed by default and fetched on expand: a
// year-long goal is a 365-point series and loadGoals() re-runs on every
// pace-view switch.
//
// "Burn-up" is the chart type's name, kept in the code because it's precise:
// a burn-DOWN plots work remaining falling to zero, a burn-UP plots work done
// rising to meet a flat scope line — which is this shape exactly. It's Scrum
// jargon though, so the button says "Projection", which is what the user
// actually opens it for.
const goalBurnupOpen = new Set();

// Build the four series on a dense daily axis running start_date → whichever of
// the deadline and the projected finish is later. Pure, so verify_ui.js can
// check the geometry without a DOM.
//
// `dates`/`actual` come from db_get_goal_burnup and stop at logical today; the
// axis carries on to the deadline, so actual is null-padded past its end rather
// than stretched — a line drawn to the deadline would claim progress that
// hasn't happened. Every derived number comes off the goal payload the card
// already rendered (target, deadline, projected_end), so the chart and the card
// can't project differently.
function goalBurnupSeries(g, dates, actual) {
  const axisEnd = (g.projected_end && g.projected_end > g.deadline) ? g.projected_end : g.deadline;
  const labels  = [];
  const cur = dateFromISO(g.start_date), stop = dateFromISO(axisEnd);
  while (cur <= stop) { labels.push(isoDateFromObj(cur)); cur.setDate(cur.getDate() + 1); }
  if (!labels.length) return null;

  // Time goals plot in hours; the raw series is seconds.
  const scale  = g.metric === 'time_seconds' ? 1 / 3600 : 1;
  const target = (g.target || 0) * scale;

  const byDate = {};
  (dates || []).forEach((d, i) => { byDate[d] = (actual || [])[i]; });
  const lastDay = (dates && dates.length) ? dates[dates.length - 1] : null;
  const act = labels.map(l => {
    if (!lastDay || l > lastDay) return null;
    const v = byDate[l];
    return v == null ? null : v * scale;
  });

  // Straight line from 0 at the start to the target on the deadline — the same
  // target/total_days daily pace the card's expected-progress marker uses.
  const dlIdx = Math.max(0, labels.indexOf(g.deadline));
  const pace  = labels.map((_, i) =>
    i > dlIdx ? null : (dlIdx === 0 ? target : target * i / dlIdx));

  // Projection: a straight run from today's actual to the target on
  // projected_end. db.py derived that date from the observed average pace, so
  // joining the two points reproduces exactly that pace — no second formula.
  const todayIdx = act.reduce((last, v, i) => (v == null ? last : i), -1);
  let projected = null;
  if (g.projected_end && todayIdx >= 0) {
    const pIdx = labels.indexOf(g.projected_end);
    if (pIdx > todayIdx) {
      const v0 = act[todayIdx];
      projected = labels.map((_, i) => (i < todayIdx || i > pIdx)
        ? null
        : v0 + (target - v0) * (i - todayIdx) / (pIdx - todayIdx));
    }
  }

  // Days you could skip and still land on the deadline at the current pace —
  // the deadline-relative flip of the card's "3d early / 3d late" chip, so the
  // two can never disagree.
  const slack = (g.projected_days_delta == null) ? null : -g.projected_days_delta;

  // `short` is what the axis plots; `labels` stays ISO for the tooltip title.
  // Pre-formatted rather than done in a tick callback, matching every other
  // chart here — under autoSkip a callback's index is the surviving-tick index,
  // not the label index, so looking labels up by it would misalign them.
  return { labels, short: labels.map(l => l.slice(5)),
           actual: act, pace, projected, scope: labels.map(() => target), slack };
}

function dropBurnupCharts() {
  Object.keys(charts).filter(k => k.startsWith('goal-burnup-')).forEach(destroyChart);
}

function restoreOpenBurnups(goals) {
  goals.filter(g => goalBurnupOpen.has(g.id)).forEach(g => renderGoalBurnup(g.id));
}

async function toggleGoalBurnup(id) {
  const box = document.getElementById(`goal-burnup-${id}`);
  const btn = document.getElementById(`goal-burnup-btn-${id}`);
  if (!box) return;
  const open = !goalBurnupOpen.has(id);
  if (open) goalBurnupOpen.add(id); else goalBurnupOpen.delete(id);
  box.style.display = open ? '' : 'none';
  if (btn) {
    btn.classList.toggle('active', open);
    btn.textContent = `Projection ${open ? '▴' : '▾'}`;
  }
  if (open) await renderGoalBurnup(id);
  else destroyChart(`goal-burnup-${id}`);
}

async function renderGoalBurnup(id) {
  const g        = goalDataCache[id];
  const key      = `goal-burnup-${id}`;
  const canvasId = `goal-burnup-canvas-${id}`;
  if (!g || !document.getElementById(canvasId)) return;

  const data = await window.pywebview.api.get_goal_burnup(id);
  const s    = data ? goalBurnupSeries(g, data.dates, data.actual) : null;
  const slackEl = document.getElementById(`goal-slack-${id}`);

  // A goal with no reading yet still draws — a flat zero against the pace line
  // is the answer to "how far behind am I". This only fires when the backend
  // returned no days at all, i.e. a start date in the future.
  if (!s || !s.actual.some(v => v != null)) {
    destroyChart(key);
    setChartEmpty(canvasId, "This goal hasn't started yet");
    if (slackEl) slackEl.textContent = '';
    return;
  }

  if (slackEl) {
    const n = s.slack;
    slackEl.title = 'Days you could take off and still finish by the deadline at your current pace';
    if (n == null)      { slackEl.textContent = ''; }
    else if (n >= 0)    { slackEl.textContent = `${n} day${n === 1 ? '' : 's'} of slack`;
                          slackEl.style.color = CT.success; }
    else                { slackEl.textContent = `${-n} day${n === -1 ? '' : 's'} behind`;
                          slackEl.style.color = '#FF9F5B'; }
  }

  const isTime  = g.metric === 'time_seconds';
  const fmtVal  = v => isTime ? fmtTime(v * 3600) : `${fmtChars(Math.round(v))} chars`;
  const late    = (s.slack ?? 0) < 0;

  // Array order is draw order AND legend order (see the note in
  // renderDetailMetricChart — `order:` reverses both, so don't reach for it).
  // Actual leads the key and the thin reference lines draw over its fill.
  upsertChart(key, canvasId, {
    type: 'line',
    data: { labels: s.short, datasets: [
      // tension 0 on every line here: a cumulative series is monotonic, and
      // Chart.js's default cubic interpolation overshoots, which would draw a
      // dip on a flat stretch — reading that never went backwards.
      { label: 'Actual', data: s.actual, borderColor: CT.accent,
        backgroundColor: ctAlpha(CT.accent, 0.12), borderWidth: 2.5,
        pointRadius: 0, pointHoverRadius: 5, pointBackgroundColor: CT.accent,
        fill: 'origin', tension: 0, spanGaps: false },
      { label: 'Required pace', data: s.pace, borderColor: CT.dim,
        borderWidth: 1.5, borderDash: [5, 4], pointRadius: 0, pointHoverRadius: 4,
        fill: false, tension: 0, spanGaps: false },
      ...(s.projected ? [{ label: 'At current pace', data: s.projected,
        borderColor: late ? '#FF9F5B' : CT.success,
        borderWidth: 2, borderDash: [3, 3], pointRadius: 0, pointHoverRadius: 4,
        fill: false, tension: 0, spanGaps: false }] : []),
      { label: 'Target', data: s.scope, borderColor: ctAlpha(CT.dim, 0.5),
        borderWidth: 1, borderDash: [2, 4], pointRadius: 0, pointHoverRadius: 0,
        fill: false, tension: 0 },
    ] },
    options: {
      responsive: true, maintainAspectRatio: false, animation: false,
      interaction: { mode: 'index', intersect: false },
      plugins: {
        legend: { display: true, position: 'bottom',
                  labels: { color: CT.dim, boxWidth: 12, boxHeight: 12, usePointStyle: true } },
        tooltip: { callbacks: {
          title: c => s.labels[c[0].dataIndex],
          label: c => c.raw == null ? '' : `${c.dataset.label}: ${fmtVal(c.raw)}`,
        } },
      },
      scales: {
        x: { grid: { color: CT.grid },
             ticks: { color: CT.dim, maxRotation: 0, autoSkip: true, maxTicksLimit: 12 } },
        y: { grid: { color: CT.grid }, beginAtZero: true,
             ticks: { color: CT.dim, callback: v => isTime ? fmtHourTick(v) : fmtChars(v) },
             afterFit: sc => { sc.width = 62; } },
      },
    },
  });
}

let editingGoalId = null;

function toggleGoalForm() {
  if (goalPanelMode === 'new') { setGoalPanelMode('default'); return; }
  editingGoalId = null;
  _resetGoalFormMode();
  setGoalPanelMode('new');
}

function _resetGoalFormMode() {
  editingGoalId = null;
  document.getElementById('goal-metric').disabled  = false;
  document.getElementById('goal-chunk').disabled   = false;
  document.getElementById('goal-add-btn').textContent = 'Add goal';
  document.getElementById('goal-feedback').textContent = '';
  // Re-derive the target label: it's otherwise only updated onchange, so a
  // freshly opened form kept the static HTML label (or a stale edit-mode one).
  updateGoalUnit();
}

async function openGoalEdit(id) {
  const g = goalDataCache[id];
  if (!g) return;
  editingGoalId = g.id;

  document.getElementById('goal-label').value    = g.label;
  document.getElementById('goal-metric').value   = (g.metric === 'time_seconds' && g.track_chars) ? 'time_chars' : g.metric;
  document.getElementById('goal-metric').disabled = true;
  const rawTarget = g.metric === 'time_seconds' ? +(g.target / 3600).toFixed(2) : g.target;
  document.getElementById('goal-target').value   = rawTarget;
  document.getElementById('goal-deadline').value = g.deadline;
  document.getElementById('goal-chunk').value    = g.chunk_period || 'none';
  document.getElementById('goal-chunk').disabled  = true;
  document.getElementById('goal-activity').value  = g.activity_type || '';
  document.getElementById('goal-start').value     = g.start_date || '';
  document.getElementById('goal-feedback').textContent = '';
  document.getElementById('goal-add-btn').textContent  = 'Save changes';
  updateGoalUnit();

  setGoalPanelMode('new');
  document.getElementById('goal-form-card').scrollIntoView({ behavior: 'smooth', block: 'nearest' });
}

async function doAddGoal() {
  const label       = document.getElementById('goal-label').value.trim();
  const metricSel   = document.getElementById('goal-metric').value;
  // "time_chars" is a UI-only classification: graded on time, chars tracked passively.
  const metric      = metricSel === 'time_chars' ? 'time_seconds' : metricSel;
  const trackChars  = metricSel === 'time_chars';
  const rawTarget   = parseFloat(document.getElementById('goal-target').value);
  const deadline    = document.getElementById('goal-deadline').value.trim();
  const chunkPeriod = document.getElementById('goal-chunk').value;
  const atype       = document.getElementById('goal-activity').value || null;
  const startVal    = document.getElementById('goal-start').value.trim();
  const fb          = document.getElementById('goal-feedback');

  if (!label) {
    fb.className = 'feedback err'; fb.textContent = 'Enter a label.'; return;
  }
  if (isNaN(rawTarget) || rawTarget <= 0) {
    fb.className = 'feedback err'; fb.textContent = 'Enter a positive target.'; return;
  }
  if (!/^\d{4}-\d{2}-\d{2}$/.test(deadline)) {
    fb.className = 'feedback err'; fb.textContent = 'Deadline must be YYYY-MM-DD.'; return;
  }
  if (editingGoalId === null && deadline <= today()) {
    fb.className = 'feedback err'; fb.textContent = 'Deadline must be a future date.'; return;
  }
  if (startVal && !/^\d{4}-\d{2}-\d{2}$/.test(startVal)) {
    fb.className = 'feedback err'; fb.textContent = 'Start date must be YYYY-MM-DD.'; return;
  }
  if (startVal && startVal > today()) {
    fb.className = 'feedback err'; fb.textContent = 'Start date cannot be in the future.'; return;
  }
  if (startVal && startVal >= deadline) {
    fb.className = 'feedback err'; fb.textContent = 'Start date must be before the deadline.'; return;
  }

  let target = metric === 'time_seconds' ? rawTarget * 3600 : rawTarget;

  let r;
  if (editingGoalId !== null) {
    r = await window.pywebview.api.update_goal(editingGoalId, label, target, deadline, atype, trackChars, startVal || null);
  } else {
    if (chunkPeriod !== 'none') {
      // Pace targets cover the whole goal window, so a backdated start
      // multiplies the per-period amount over the extra elapsed days too
      // (matches total_days = deadline − start in db_get_goal_progress).
      const daysUntil = Math.round((new Date(deadline) - new Date(startVal || today())) / 86400000);
      const periods   = chunkPeriod === 'weekly' ? Math.ceil(daysUntil / 7) : chunkPeriod === 'monthly' ? Math.ceil(daysUntil / 30.44) : daysUntil;
      if (periods < 1) {
        fb.className = 'feedback err'; fb.textContent = 'Deadline is too soon for that pace.'; return;
      }
      target *= periods;
    }
    r = await window.pywebview.api.add_goal(label, metric, target, deadline, chunkPeriod, atype, trackChars, startVal || null);
  }

  if (r.ok) {
    document.getElementById('goal-label').value    = '';
    document.getElementById('goal-target').value   = '';
    document.getElementById('goal-deadline').value = '';
    document.getElementById('goal-start').value    = '';
    setGoalPanelMode('default');
    statsCache = {};
    await loadGoals();
  } else {
    fb.className = 'feedback err'; fb.textContent = r.error || 'Error';
  }
}

let confirmResolve = null;

function showConfirm(message, okLabel = 'Delete', okColor = '#FF6B6B') {
  return new Promise(resolve => {
    document.getElementById('confirm-message').textContent = message;
    const btn = document.getElementById('confirm-ok-btn');
    btn.textContent = okLabel;
    btn.style.background = okColor;
    btn.style.color = '#fff';
    btn.style.border = 'none';
    document.getElementById('confirm-overlay').style.display = 'flex';
    confirmResolve = result => {
      document.getElementById('confirm-overlay').style.display = 'none';
      resolve(result);
    };
  });
}

async function doDeleteGoal(id) {
  if (!await showConfirm('Delete this goal? This cannot be undone.')) return;
  const r = await window.pywebview.api.delete_goal(id);
  if (r.ok) await loadGoals();
}

async function doFinishGoal(id) {
  const r = await window.pywebview.api.finish_goal(id);
  if (r.ok) await loadGoals();
}

// ── Media (grid) ────────────────────────────────────────────────────────────
// The Media page has six mutually-exclusive sub-views. Switching must hide ALL
// the others — milestone-view was added late and several callers forgot it,
// leaving its stat/graph page stacked under the next view.
function showMediaView(name) {
  const views = {
    grid:      'media-grid-view',
    detail:    'media-detail-view',
    series:    'media-series-view',
    milestone: 'media-milestone-view',
    portal:    'media-portal-view',
    toread:    'media-toread-view',
    shelf:     'media-shelf-view',
  };
  for (const [key, id] of Object.entries(views)) {
    document.getElementById(id).style.display = key === name ? 'block' : 'none';
  }
}

// Sources that never get a media card. get_media_stats groups by title across
// EVERY source (no source filter in SQL), so anything with a title lands on the
// grid unless it's excluded here.
//   'manual'  — quick-log stopwatch rows, untitled by design
//   'youtube' — the passive tracker pools all its time under one 'YouTube'
//               title so the data stays queryable later; it is deliberately not
//               a media entry (see plans/YOUTUBE-PLAN.md)
const GRID_HIDDEN_SOURCES = new Set(['manual', 'youtube']);
const isGridHidden = (m) => GRID_HIDDEN_SOURCES.has(m.source);

async function loadMedia() {
  destroyChart('detail');
  destroyPortalCharts();
  currentDetailTitle = null;
  currentSeriesId    = null;
  showMediaView('grid');

  [mediaAllData, seriesData, mediaOrderMap] = await Promise.all([
    window.pywebview.api.get_media(),
    window.pywebview.api.get_series(),
    window.pywebview.api.get_media_order(),
  ]);
  mediaOrderMap = mediaOrderMap || {};
  const visibleCount = mediaAllData.filter(m => !isGridHidden(m)).length;
  document.getElementById('media-count').textContent = `${visibleCount} titles`;
  renderMediaGrid();
}

function renderMediaGrid() {
  const grid = document.getElementById('media-grid');

  // Titles that belong to a series — hidden as standalone cards
  const inSeries = new Set(seriesData.flatMap(s => s.members.map(m => m.title)));
  const filtered = mediaAllData.filter(m => !isGridHidden(m));
  const ungrouped = filtered.filter(m => !inSeries.has(m.title));

  grid.innerHTML = '';
  if (!ungrouped.length && !seriesData.length) {
    grid.innerHTML = '<p class="empty-msg">No media found.</p>'; return;
  }

  // Natural order: series first, then ungrouped titles by total_secs DESC.
  const natural = [
    ...seriesData.map(s => ({ key: `s:${s.id}`, kind: 'series', data: s })),
    ...ungrouped.map(m => ({ key: `t:${m.title}`, kind: 'title',  data: m })),
  ];

  // Manual order overrides natural for items present in mediaOrderMap.
  const ordered = [...natural].sort((a, b) => {
    const pa = mediaOrderMap[a.key];
    const pb = mediaOrderMap[b.key];
    if (pa != null && pb != null) return pa - pb;
    if (pa != null) return -1;
    if (pb != null) return 1;
    return 0;
  });

  ordered.forEach((item, idx) => {
    const canLeft  = idx > 0;
    const canRight = idx < ordered.length - 1;
    const el = item.kind === 'series'
      ? makeSeriesCard(item.data)
      : makeMediaCard(item.data);
    el.appendChild(makeReorderControls(item.key, canLeft, canRight));
    grid.appendChild(el);
  });
}

function makeReorderControls(key, canLeft, canRight) {
  const wrap = document.createElement('div');
  wrap.className = 'media-card-reorder';
  wrap.innerHTML = `
    <button type="button" class="media-card-reorder-btn" data-dir="left"  draggable="false" ${canLeft  ? '' : 'disabled'} title="Move left">◀</button>
    <button type="button" class="media-card-reorder-btn" data-dir="right" draggable="false" ${canRight ? '' : 'disabled'} title="Move right">▶</button>`;
  wrap.addEventListener('click',     e => e.stopPropagation());
  wrap.addEventListener('mousedown', e => e.stopPropagation());
  wrap.addEventListener('dragstart', e => e.preventDefault());
  wrap.querySelectorAll('button').forEach(btn => {
    btn.addEventListener('click', ev => {
      ev.stopPropagation();
      if (btn.disabled) return;
      shiftMediaCard(key, btn.dataset.dir === 'left' ? -1 : 1);
    });
  });
  return wrap;
}

async function shiftMediaCard(key, delta) {
  // Rebuild the current visible order, swap, persist, re-render.
  const inSeries = new Set(seriesData.flatMap(s => s.members.map(m => m.title)));
  const ungrouped = mediaAllData.filter(m => !isGridHidden(m) && !inSeries.has(m.title));
  const natural = [
    ...seriesData.map(s => `s:${s.id}`),
    ...ungrouped.map(m => `t:${m.title}`),
  ];
  const ordered = [...natural].sort((a, b) => {
    const pa = mediaOrderMap[a];
    const pb = mediaOrderMap[b];
    if (pa != null && pb != null) return pa - pb;
    if (pa != null) return -1;
    if (pb != null) return 1;
    return 0;
  });
  const i = ordered.indexOf(key);
  const j = i + delta;
  if (i < 0 || j < 0 || j >= ordered.length) return;
  [ordered[i], ordered[j]] = [ordered[j], ordered[i]];

  // Refresh in-memory map immediately so re-render reflects the change
  // before the API round-trip completes.
  mediaOrderMap = Object.fromEntries(ordered.map((k, idx) => [k, idx]));
  renderMediaGrid();
  await window.pywebview.api.set_media_order(ordered);
}

// 30-day activity strip, used by the shelf rows. Plain divs rather than a
// canvas — a Chart.js instance per row would be absurd for 30 bars.
//
// Bars are scaled to the title's OWN busiest day, not a global max, so a title
// you read lightly still shows shape. That does mean heights aren't comparable
// BETWEEN rows; the strip answers "when did I read this", not "how much".
// Days with no reading keep a 1px floor so it reads as a timeline, not as gaps.
function sparkHTML(spark, color) {
  if (!Array.isArray(spark) || !spark.some(v => v > 0)) {
    return '<div class="spark spark-empty"></div>';
  }
  const max = Math.max(...spark);
  const total = spark.reduce((a, b) => a + b, 0);
  const bars = spark.map(v => {
    const h = v > 0 ? Math.max(12, Math.round(v / max * 100)) : 0;
    return `<i style="height:${h}%;${v > 0 ? `background:${color}` : ''}"></i>`;
  }).join('');
  return `<div class="spark" title="Last 30 days — ${fmtTime(total)}">${bars}</div>`;
}

function makeMediaCard(m) {
  const color   = acolor(m.activity_type);
  const icon    = mediaIcon(m.source, m.activity_type);
  const initial = (m.title || '?')[0].toUpperCase();
  const isBook  = m.activity_type === 'Reading' || m.source === 'ttsureader';
  const hasImg  = !!m.image;

  const el = document.createElement('div');
  el.className = 'media-card';
  el.draggable = true;
  el.dataset.title = m.title;
  el.onclick = () => openMediaDetail(m.title);

  el.addEventListener('dragstart', e => {
    e.dataTransfer.setData('application/x-media-drag', JSON.stringify({type: 'title', id: m.title}));
    e.dataTransfer.effectAllowed = 'move';
    setTimeout(() => el.classList.add('dragging'), 0);
  });
  el.addEventListener('dragend', () => {
    el.classList.remove('dragging');
    document.querySelectorAll('.series-target').forEach(x => x.classList.remove('series-target'));
  });
  el.addEventListener('dragover', e => {
    if (!e.dataTransfer.types.includes('application/x-media-drag')) return;
    e.preventDefault(); e.stopPropagation();
    // Don't highlight self
    if (el.classList.contains('dragging')) return;
    el.classList.add('series-target');
  });
  el.addEventListener('dragleave', e => {
    if (!el.contains(e.relatedTarget)) el.classList.remove('series-target');
  });
  el.addEventListener('drop', async e => {
    e.preventDefault(); e.stopPropagation();
    el.classList.remove('series-target');
    const raw = e.dataTransfer.getData('application/x-media-drag');
    if (!raw) return;
    const dragged = JSON.parse(raw);
    if (dragged.type === 'title' && dragged.id === m.title) return;
    if (dragged.type === 'title') {
      await window.pywebview.api.create_series(m.title, dragged.id);
    } else {
      await window.pywebview.api.add_to_series(dragged.id, m.title);
    }
    seriesData = await window.pywebview.api.get_series();
    renderMediaGrid();
  });

  let innerHTML = '';
  if (hasImg) {
    innerHTML += `<img class="media-card-img" src="${m.image}" alt="${m.title}" loading="lazy" draggable="false">`;
  } else {
    const spineHTML = isBook ? `<div class="media-placeholder-spine"></div>` : '';
    innerHTML += `
      <div class="media-card-placeholder" style="background:${color}1a;border:1px solid ${color}2a">
        ${spineHTML}
        <div class="media-placeholder-icon">${icon}</div>
        <div class="media-placeholder-initial">${initial}</div>
      </div>`;
  }
  if (m.completed) {
    innerHTML += `<div class="media-card-complete" title="Completed">✓</div>`;
  }
  innerHTML += `
    <div class="media-card-footer">
      <div class="media-card-title">${escHtml(m.display_title || m.title || m.activity_type || 'Untitled')}</div>
      <div class="media-card-meta">
        <span class="media-card-time">${fmtTime(m.total_secs)}</span>
        <span class="media-card-source">${srcLabel(m.source)}</span>
      </div>
    </div>`;

  el.innerHTML = innerHTML;
  return el;
}

function cardLayerHTML(member) {
  if (member.image) {
    return `<img src="${member.image}" alt="${escHtml(member.display_title)}" draggable="false" style="width:100%;height:100%;object-fit:cover;display:block">`;
  }
  const initial = (member.display_title || '?')[0].toUpperCase();
  return `
    <div style="width:100%;height:100%;display:flex;align-items:center;justify-content:center;
                background:rgba(91,140,255,0.12);border:1px solid rgba(91,140,255,0.2)">
      <span style="font-size:36px;font-weight:900;color:rgba(255,255,255,0.2);font-family:serif">${initial}</span>
    </div>`;
}

function makeSeriesCard(s) {
  const el = document.createElement('div');
  el.className = 'series-stack';
  el.dataset.seriesId = s.id;

  const members = s.members;
  const front  = members[0];
  const mid    = members[1];

  // Grid icon stacks at most two covers (front + one peek), even for longer
  // series; the badge still shows the true member count.
  let html = '';
  if (mid)   html += `<div class="series-layer series-layer-mid">${cardLayerHTML(mid)}</div>`;
  html += `<div class="series-layer series-layer-front">${cardLayerHTML(front)}</div>`;

  if (members.length > 1) {
    html += `<div class="series-badge">${members.length}</div>`;
  }
  html += `
    <div class="media-card-footer">
      <div class="media-card-title">${escHtml(s.name)}</div>
      <div class="media-card-meta">
        <span class="media-card-time">${fmtTime(s.total_secs)}</span>
        <span class="media-card-source">Series</span>
      </div>
    </div>`;

  el.innerHTML = html;
  el.onclick = () => openSeriesDetail(s.id);

  el.addEventListener('dragover', e => {
    const raw = e.dataTransfer.types.includes('application/x-media-drag');
    if (!raw) return;
    e.preventDefault(); e.stopPropagation();
    el.classList.add('series-target');
  });
  el.addEventListener('dragleave', e => {
    if (!el.contains(e.relatedTarget)) el.classList.remove('series-target');
  });
  el.addEventListener('drop', async e => {
    e.preventDefault(); e.stopPropagation();
    el.classList.remove('series-target');
    const raw = e.dataTransfer.getData('application/x-media-drag');
    if (!raw) return;
    const dragged = JSON.parse(raw);
    if (dragged.type !== 'title') return;
    if (s.members.some(m => m.title === dragged.id)) return;
    await window.pywebview.api.add_to_series(s.id, dragged.id);
    seriesData = await window.pywebview.api.get_series();
    renderMediaGrid();
  });

  return el;
}

// ── Series detail ──────────────────────────────────────────────────────────
async function openSeriesDetail(seriesId) {
  currentSeriesId = seriesId;
  const s = seriesData.find(x => x.id === seriesId);
  if (!s) return;
  showMediaView('series');
  const memberDetails = await Promise.all(
    s.members.map(m => window.pywebview.api.get_title_detail(m.title))
  );
  renderSeriesDetail(s, memberDetails.filter(Boolean));
}

// Series completion bar. Uses the SAME component as the media completion bar
// (.detail-progress head + .progress-track + .progress-seg tints + .progress-tick
// dividers + the shared progress-tip hover). Each book is one colored segment
// sized by the chars READ of it, packed in series order (no reserved-empty gaps),
// against the summed LENGTH of all length-known books — so the fill = series
// completion, the empty track = what's left. Books without a length sit out and
// are listed beneath. Reads member details already loaded for the page.
function renderSeriesProgress(s, detailByTitle, daily = []) {
  const section = document.getElementById('series-progress');
  const track   = document.getElementById('series-progress-track');
  const pctEl   = document.getElementById('series-progress-pct');
  const cntEl   = document.getElementById('series-progress-counts');
  const etaEl   = document.getElementById('series-progress-eta');
  const nolen   = document.getElementById('series-progress-nolen');
  track.innerHTML = ''; nolen.innerHTML = '';
  hideProgressTip();   // a segment could be removed mid-hover

  const books = [], missing = [];
  let haveDetail = false;
  s.members.forEach((m, i) => {
    const md = detailByTitle[m.title];
    if (md) haveDetail = true;
    const color  = MILESTONE_PALETTE[i % MILESTONE_PALETTE.length];
    const length = md ? (md.user_char_count > 0 ? md.user_char_count
                        : (md.game_char_count > 0 ? md.game_char_count : 0)) : 0;
    const display = m.display_title || m.title;
    if (length > 0) {
      const completed = !!(md && md.completed);
      const read = completed ? length : Math.min(md ? (md.total_chars || 0) : 0, length);
      books.push({ title: m.title, display, color, length, read, completed,
                   pct: read / length * 100 });
    } else if (md) {
      missing.push({ title: m.title, display });
    }
  });

  if (!haveDetail || !books.length) { section.style.display = 'none'; return; }

  const L = books.reduce((a, b) => a + b.length, 0);
  const R = books.reduce((a, b) => a + b.read, 0);
  const pct = L > 0 ? R / L * 100 : 0;
  pctEl.textContent = `${fmtPct(pct)}%`;
  cntEl.textContent = `${fmtChars(R)} / ${fmtChars(L)} chars`;

  // ETA bottom-right, same as the media completion bar: remaining chars over the
  // series ÷ trailing 7-reading-day speed of the combined daily.
  const remaining = L - R;
  const spd = recentSpeed(daily, 7);
  etaEl.classList.toggle('completed', remaining <= 0);
  if (remaining <= 0) {
    etaEl.textContent = 'Completed ✓'; etaEl.title = '';
  } else if (spd > 0) {
    etaEl.textContent = `Est. hours to complete: ${(remaining / spd).toFixed(1)}h`;
    etaEl.title = `${fmtChars(remaining)} chars left at ${fmtChars(Math.round(spd))} chars/h (7-day avg)`;
  } else {
    etaEl.textContent = ''; etaEl.title = '';
  }

  // Packed colored segments (width = each book's read share of the total length),
  // with a boundary tick between consecutive books — same as milestone sections.
  let acc = 0, drawn = 0;
  books.forEach(b => {
    const w = L > 0 ? b.read / L * 100 : 0;
    if (w <= 0) return;
    if (drawn > 0 && acc > 0.05 && acc < 99.95) {
      const tick = document.createElement('div');
      tick.className = 'progress-tick';
      tick.style.left = `${acc}%`;
      track.appendChild(tick);
    }
    const seg = document.createElement('div');
    seg.className = 'progress-seg';
    seg.style.left = `${acc}%`;
    seg.style.width = `${w}%`;
    seg.style.background = b.color;
    const meta = b.completed
      ? `Complete · ${fmtChars(b.length)} chars`
      : `${fmtPct(b.pct)}% · ${fmtChars(b.read)} / ${fmtChars(b.length)} chars`;
    seg.addEventListener('mouseenter', () => showProgressTip(seg, b.display, meta));
    seg.addEventListener('mouseleave', hideProgressTip);
    seg.addEventListener('click', () => { hideProgressTip(); openMediaDetail(b.title); });
    track.appendChild(seg);
    acc += w; drawn++;
  });

  if (missing.length) {
    const links = missing.map(m =>
      `<a style="color:var(--accent);cursor:pointer" data-title="${escHtml(m.title)}">${escHtml(m.display)}</a>`).join(', ');
    nolen.innerHTML = `No length set: ${links} — open to add a progress bar and include `
      + `${missing.length === 1 ? 'it' : 'them'}.`;
    nolen.style.marginTop = '6px';
    nolen.querySelectorAll('a').forEach(a =>
      a.addEventListener('click', () => openMediaDetail(a.dataset.title)));
  } else {
    nolen.style.marginTop = '';
  }

  section.style.display = 'block';
}

function renderSeriesDetail(s, memberDetails = []) {
  document.getElementById('series-detail-name').textContent = s.name;

  // Stacked cover art in hero — at most two covers (front + one peek), matching
  // the grid card; the badge still shows the true member count.
  const coverEl = document.getElementById('series-detail-cover');
  const members = s.members;
  const front = members[0], mid = members[1];
  let coverHtml = '';
  if (mid)   coverHtml += `<div class="series-layer series-layer-mid">${cardLayerHTML(mid)}</div>`;
  if (front) coverHtml += `<div class="series-layer series-layer-front">${cardLayerHTML(front)}</div>`;
  if (members.length > 1) coverHtml += `<div class="series-badge">${members.length}</div>`;
  coverEl.innerHTML = coverHtml;

  // Badge
  const label = members.length === 1 ? 'entry' : 'entries';
  document.getElementById('series-detail-badge').innerHTML =
    `<span class="genre-badge">Series · ${members.length} ${label}</span>`;

  // Build a title→detail map for per-member meta lines
  const detailByTitle = {};
  memberDetails.forEach(d => { if (d && d.title) detailByTitle[d.title] = d; });

  // Inline member list
  const membersEl = document.getElementById('series-detail-members');
  membersEl.innerHTML = '';
  s.members.forEach(m => {
    const row = document.createElement('div');
    row.className = 'series-member-row';
    const thumb = m.image
      ? `<img src="${m.image}" alt="${escHtml(m.display_title)}">`
      : (m.display_title || '?')[0].toUpperCase();

    const md = detailByTitle[m.title];
    const meta = md ? fmtMediaMemberMeta(md) : '';
    const metaHtml = meta ? `<span class="series-member-meta">${escHtml(meta)}</span>` : '';

    row.innerHTML = `
      <div class="series-member-mini-thumb">${thumb}</div>
      <div class="series-member-main">
        <span class="series-member-mini-title">${escHtml(m.display_title || m.title)}</span>
        ${metaHtml}
      </div>
      <button class="btn btn-xs btn-danger series-remove-btn" title="Remove from series">✕</button>`;
    const openDetail = e => { e.stopPropagation(); openMediaDetail(m.title); };
    row.querySelector('.series-member-mini-thumb').addEventListener('click', openDetail);
    row.querySelector('.series-member-main').addEventListener('click', openDetail);
    row.querySelector('.series-remove-btn').addEventListener('click', async e => {
      e.stopPropagation();
      const r = await window.pywebview.api.remove_from_series(s.id, m.title);
      if (r.ok) {
        seriesData = await window.pywebview.api.get_series();
        const updated = seriesData.find(x => x.id === s.id);
        if (updated) {
          const updatedDetails = await Promise.all(
            updated.members.map(mem => window.pywebview.api.get_title_detail(mem.title))
          );
          renderSeriesDetail(updated, updatedDetails.filter(Boolean));
        } else {
          closeSeriesDetail();
        }
      }
    });
    membersEl.appendChild(row);
  });

  // Per-book color + label, keyed by title in series order. Same MILESTONE_PALETTE
  // pool (and same index basis) the series progress bar uses, so a book's chart
  // color matches its progress-bar segment.
  const bookInfo = {};
  s.members.forEach((m, i) => {
    bookInfo[m.title] = {
      key: m.title,
      color: MILESTONE_PALETTE[i % MILESTONE_PALETTE.length],
      label: m.display_title || m.title,
    };
  });

  // Aggregate stats from member details
  let totalSecs = 0, totalChars = 0;
  const allDates = new Set();
  const dailyMap = {};
  const byBookMap = {};   // date -> { title -> {chars, secs} }, for the split-by-book toggle
  memberDetails.forEach(d => {
    totalSecs  += d.total_secs  || 0;
    totalChars += d.total_chars || 0;
    (d.daily || []).forEach(row => {
      allDates.add(row.date);
      if (!dailyMap[row.date]) dailyMap[row.date] = { date: row.date, chars: 0, seconds: 0 };
      dailyMap[row.date].chars   += row.chars;
      dailyMap[row.date].seconds += row.seconds;
      // speed is recomputed per-day from aggregated chars/seconds
      const bb = byBookMap[row.date] || (byBookMap[row.date] = {});
      const slot = bb[d.title] || (bb[d.title] = { chars: 0, secs: 0 });
      slot.chars += row.chars;
      slot.secs  += row.seconds;
    });
  });
  if (!memberDetails.length) totalSecs = s.total_secs || 0;

  const daily     = Object.values(dailyMap).sort((a, b) => a.date.localeCompare(b.date));
  const byBook    = daily.map(r => byBookMap[r.date] || {});
  // Books that actually contributed daily data, in series order — the split
  // datasets. Only members with a known color/label (present in bookInfo).
  const books = s.members
    .map(m => bookInfo[m.title])
    .filter(b => b && byBook.some(bb => bb[b.key]));
  currentSeriesChart = { daily, byBook, books };
  renderSeriesProgress(s, detailByTitle, daily);
  const daysCount = allDates.size;
  const dates     = [...allDates].sort();
  const firstDate = dates[0] || '—';
  const lastDate  = dates[dates.length - 1] || '—';
  const avgSpeed  = totalSecs > 0 && totalChars > 0
    ? Math.round(totalChars / (totalSecs / 3600)) : 0;

  const last7s = daily.slice(-7);
  const l7chars = last7s.reduce((s, r) => s + r.chars, 0);
  const l7secs  = last7s.reduce((s, r) => s + r.seconds, 0);
  const l7speed = l7secs > 0 && l7chars > 0 ? Math.round(l7chars / (l7secs / 3600)) : 0;
  const l7display = l7speed > 0 ? `${fmtChars(l7speed)}/h` : '—';

  // Stat cards
  const statsEl = document.getElementById('series-detail-stats');
  statsEl.style.gridTemplateColumns = 'repeat(4,1fr)';
  statsEl.innerHTML = `
    <div class="stat-card">
      <div class="label">Total time</div>
      <div class="value" style="color:var(--accent);font-size:22px">${fmtTime(totalSecs)}</div>
    </div>
    <div class="stat-card">
      <div class="label">Characters</div>
      <div class="value" style="color:var(--success);font-size:22px">${totalChars > 0 ? fmtChars(totalChars) : '—'}</div>
    </div>
    <div class="stat-card">
      <div class="label">Avg read speed</div>
      <div class="value" style="color:var(--warn);font-size:22px">${avgSpeed > 0 ? fmtChars(avgSpeed) + '/h' : '—'}</div>
    </div>
    <div class="stat-card">
      <div class="label">Speed last 7d</div>
      <div class="value" style="color:var(--purple);font-size:22px">${l7display}</div>
    </div>
  `;

  // Show the "Split by book" toggle only when >1 book contributed data (a
  // single book has nothing to split against).
  const splitLabel = document.getElementById('series-split-label');
  if (splitLabel) splitLabel.style.display = books.length > 1 ? 'flex' : 'none';
  const splitToggle = document.getElementById('series-split-toggle');
  if (splitToggle) splitToggle.checked = splitBySeriesBook;

  renderSeriesCharts();
}

function onSeriesSplitToggle() {
  splitBySeriesBook = document.getElementById('series-split-toggle').checked;
  renderSeriesCharts();
}

function renderSeriesCharts() {
  const cs     = currentSeriesChart;
  const daily  = cs ? cs.daily  : [];
  const books  = cs ? cs.books  : [];
  const byBook = cs ? cs.byBook : [];
  detailChartCfg.series = {
    key: 'series', canvasId: 'chart-series-main', segId: 'series-metric-seg',
    viewSegId: 'series-view-seg',
    splitLabelId: 'series-split-label',
    daily,
    // Series keep per-day resolution (unchanged from before the merge); only
    // media detail rolls up to weeks.
    weeklyOver: null,
    splitOn: splitBySeriesBook && books.length > 1,
    splitSource: byBook,
    splitMembers: () => books,      // books are already [{key, color, label}]
    stackName: 'book',
  };
  renderDetailMetricChart('series');
}

function closeSeriesDetail() {
  destroyChart('series');
  destroyChart('detail');
  currentSeriesId    = null;
  currentSeriesChart = null;
  currentDetailTitle = null;
  showMediaView('grid');
  renderMediaGrid();
}

async function doRenameSeriesPrompt() {
  const s = seriesData.find(x => x.id === currentSeriesId);
  if (!s) return;
  const name = prompt('Series name:', s.name);
  if (name === null) return;
  const r = await window.pywebview.api.rename_series(currentSeriesId, name);
  if (r.ok) {
    seriesData = await window.pywebview.api.get_series();
    const updated = seriesData.find(x => x.id === currentSeriesId);
    if (updated) {
      const md = await Promise.all(
        updated.members.map(m => window.pywebview.api.get_title_detail(m.title)));
      renderSeriesDetail(updated, md.filter(Boolean));
    }
  }
}

// ── Media detail view ──────────────────────────────────────────────────────
async function openMediaDetail(title) {
  const detail = await window.pywebview.api.get_title_detail(title);
  if (!detail) return;
  currentDetailTitle = title;

  showMediaView('detail');
  renderMediaDetail(detail);
}

function closeMediaDetail() {
  destroyChart('detail');
  currentDetailTitle = null;
  currentMilestones  = [];
  // If we came from a series view, go back to it; otherwise go to grid
  if (currentSeriesId !== null) {
    const s = seriesData.find(x => x.id === currentSeriesId);
    if (s) { openSeriesDetail(currentSeriesId); return; }
  }
  showMediaView('grid');
}

function onMilestoneSplitToggle() {
  splitByMilestone = document.getElementById('ms-split-toggle').checked;
  if (currentDetailData) renderDetailChart(currentDetailData.daily, currentDetailData.source === 'gsm');
}

// Build stacked datasets for a media-detail bar, one per milestone (in position
// order) plus an '_uncovered' accent segment, colored by milestone color.
// `field` is 'chars' or 'secs'; `scale` converts to the chart's display unit.
function milestoneMembers() {
  const accent = currentDetailData ? acolor(currentDetailData.activity_type) : '#6B6B8A';
  const order  = currentMilestones.map(m => ({ key: String(m.id), color: m.color || accent, label: m.name }));
  order.push({ key: '_uncovered', color: accent, label: 'Other' });
  return order;
}

function renderMediaDetail(d) {
  const isGSM = d.source === 'gsm';
  const color  = acolor(d.activity_type);
  currentDetailData = d;

  // Breadcrumb
  document.getElementById('detail-breadcrumb').textContent = `Media  ›  ${d.display_title || d.title}`;

  // Cover image or placeholder
  const coverEl = document.getElementById('detail-cover');
  coverEl.innerHTML = '';
  coverEl.style.background = '';
  coverEl.style.border = '';
  coverEl.onclick = () => pickCoverImage(d.title);
  coverEl.ondragover = e => { e.preventDefault(); coverEl.classList.add('drag-over'); };
  coverEl.ondragleave = () => coverEl.classList.remove('drag-over');
  coverEl.ondrop = e => { e.preventDefault(); coverEl.classList.remove('drag-over'); dropCoverImage(e, d.title); };
  if (d.image) {
    const img = document.createElement('img');
    img.src = d.image;
    img.alt = d.title;
    coverEl.appendChild(img);
    coverEl.style.background = 'transparent';
    coverEl.style.border = 'none';
  } else {
    coverEl.textContent = mediaIcon(d.source, d.activity_type);
    coverEl.style.background = `${color}22`;
    coverEl.style.border = `1px solid ${color}33`;
  }
  const hint = document.createElement('div');
  hint.className = 'cover-hint';
  hint.textContent = 'drop or click to set cover';
  coverEl.appendChild(hint);

  // Title + rename button
  renderDetailTitle(d.display_title || d.title);

  // Genres or activity type badge
  const genresEl = document.getElementById('detail-genres');
  if (d.genres && d.genres.length) {
    genresEl.innerHTML = d.genres.map(g =>
      `<span class="genre-badge">${g}</span>`
    ).join('');
  } else {
    genresEl.innerHTML = `<span class="genre-badge" style="color:${color};border-color:${color}44">${d.activity_type}</span>`;
  }

  // Completion progress bar: chars read / total length. The denominator is
  // GSM's game length or, for media GSM has no length for (books, manual
  // media), a user-entered total from the "Add progress bar" modal — the
  // user's value wins when both exist. Hidden when neither is known.
  // A user-marked completion ("Complete game/book") pins the bar at 100%: the
  // effective length becomes the chars actually read, so the fill, milestone
  // section positions, and milestone list percentages all re-derive against
  // the finished total instead of the length estimate.
  const completed = !!d.completed;
  const baseLen = d.user_char_count > 0 ? d.user_char_count : d.game_char_count;
  const gcc = completed && d.total_chars > 0 ? d.total_chars : baseLen;
  const progEl = document.getElementById('detail-progress');
  const track  = document.getElementById('detail-progress-track');
  // Clear any segments/ticks injected on a previous render.
  track.querySelectorAll('.progress-seg, .progress-tick').forEach(n => n.remove());
  hideProgressTip();   // a segment could be removed mid-hover
  if (gcc > 0) {
    const pct = Math.min(100, d.total_chars / gcc * 100);
    // 1-decimal, always shown (matches goal-card % formatting).
    const pctDisp = fmtPct(pct);
    document.getElementById('detail-progress-pct').textContent = `${pctDisp}%`;
    document.getElementById('detail-progress-counts').textContent =
      `${fmtChars(d.total_chars)} / ${fmtChars(gcc)} chars`;
    // ✎ next to the counts: edit/remove a user-entered length. GSM-provided
    // lengths aren't editable, and while completed the denominator is the
    // chars read, so editing would have no visible effect — hide it there too.
    const lenEditBtn = document.getElementById('detail-progress-edit');
    if (d.user_char_count > 0 && !completed) {
      lenEditBtn.style.display = 'inline';
      lenEditBtn.onclick = () => openMediaLengthModal(d);
    } else {
      lenEditBtn.style.display = 'none';
      lenEditBtn.onclick = null;
    }
    const fill = document.getElementById('detail-progress-fill');
    fill.style.width = `${pct}%`;
    fill.style.background = color;

    // Est. hours to finish, projected from the trailing 7-reading-day speed.
    // Blank when that window has no reading to project from.
    const etaEl     = document.getElementById('detail-progress-eta');
    const remaining = gcc - d.total_chars;
    const spd       = recentSpeed(d.daily, 7);
    etaEl.classList.toggle('completed', completed);
    if (completed) {
      etaEl.textContent = 'Completed ✓';
      etaEl.title = d.completed_at ? `Marked complete on ${d.completed_at.slice(0, 10)}` : '';
    } else if (remaining <= 0) {
      etaEl.textContent = 'Complete';
      etaEl.title = '';
    } else if (spd > 0) {
      etaEl.textContent = `Est. hours to complete: ${(remaining / spd).toFixed(1)}h`;
      etaEl.title = `${fmtChars(remaining)} chars left at ${fmtChars(Math.round(spd))} chars/h (7-day avg)`;
    } else {
      etaEl.textContent = '';
      etaEl.title = '';
    }

    // Milestone section tints + boundary ticks. Positions are media-cumulative
    // char bounds (start_chars/end_chars) over the full game length, so they
    // line up with the chars-denominated fill. Sections overlay the base accent
    // fill; the read portion not covered by any milestone keeps the accent.
    const ticks = new Set();
    (d.milestones || []).forEach(m => {
      if (m.start_chars == null || m.end_chars == null) return;
      const l = Math.max(0, Math.min(100, m.start_chars / gcc * 100));
      const r = Math.max(0, Math.min(100, m.end_chars   / gcc * 100));
      if (r - l > 0) {
        const seg = document.createElement('div');
        seg.className = 'progress-seg';
        seg.style.left = `${l}%`;
        seg.style.width = `${r - l}%`;
        seg.style.background = m.color || color;
        // Custom hover: milestone name (centered) above the same compact
        // "time · chars · speed · %" summary the milestone list rows show
        // (fmtMilestoneTotals). Native `title` can't center its text, so we
        // drive a small floating tooltip instead.
        const segName = m.name;
        const segMeta = fmtMilestoneTotals(m, gcc);
        seg.addEventListener('mouseenter', () => showProgressTip(seg, segName, segMeta));
        seg.addEventListener('mouseleave', hideProgressTip);
        track.appendChild(seg);
      }
      [l, r].forEach(p => { if (p > 0.05 && p < 99.95) ticks.add(p.toFixed(3)); });
    });
    ticks.forEach(p => {
      const tick = document.createElement('div');
      tick.className = 'progress-tick';
      tick.style.left = `${p}%`;
      track.appendChild(tick);
    });

    progEl.style.display = 'block';
  } else {
    progEl.style.display = 'none';
  }

  // Top-right action (back-nav row): "Complete <noun>" toggle when a bar
  // exists, or "Add progress bar" (enter a total char count) when it doesn't.
  // Completing asks for confirmation (it repins the bar); un-completing is
  // the one-click undo of that same display flag. Chars-less media (anime,
  // listening) gets neither — a chars-denominated bar is meaningless there.
  const compBtn = document.getElementById('detail-complete-btn');
  const noun = mediaNoun(d);
  if (gcc > 0) {
    compBtn.style.display = 'inline-flex';
    compBtn.textContent = completed ? '↺ Mark incomplete' : `✓ Complete ${noun}`;
    compBtn.title = completed
      ? `Clear the completed mark and go back to the ${noun}'s full length`
      : `Mark this ${noun} finished: the bar fills to 100%`;
    compBtn.onclick = () => onCompleteMediaToggle(d, !completed);
  } else if (d.total_chars > 0) {
    compBtn.style.display = 'inline-flex';
    compBtn.textContent = '+ Add progress bar';
    compBtn.title = `Enter the ${noun}'s total character count to track completion`;
    compBtn.onclick = () => openMediaLengthModal(d);
  } else {
    compBtn.style.display = 'none';
    compBtn.onclick = null;
  }

  // Milestones replace the description when present; otherwise description shows.
  currentMilestones = d.milestones || [];

  // Show the "Split by milestone" toggle only when this title has milestones.
  const msLabel = document.getElementById('ms-split-label');
  if (msLabel) msLabel.style.display = currentMilestones.length > 0 ? 'flex' : 'none';
  const msToggle = document.getElementById('ms-split-toggle');
  if (msToggle) msToggle.checked = splitByMilestone;
  const descEl     = document.getElementById('detail-desc');
  const milesEl    = document.getElementById('detail-milestones');
  if (currentMilestones.length > 0) {
    descEl.style.display  = 'none';
    milesEl.style.display = 'grid';   // must match .milestones-list; inline wins over CSS
    renderMilestonesList(milesEl, currentMilestones, gcc);
  } else if (d.description) {
    descEl.textContent    = d.description;
    descEl.style.display  = 'block';
    milesEl.style.display = 'none';
  } else {
    descEl.style.display  = 'none';
    milesEl.style.display = 'none';
  }

  // Compute derived speed if avg_speed is 0 but we have chars+time
  const computedSpeed = d.avg_speed > 0
    ? d.avg_speed
    : (d.total_secs > 60 && d.total_chars > 0
       ? d.total_chars / (d.total_secs / 3600)
       : 0);
  const speedDisplay = computedSpeed > 0
    ? `${fmtChars(Math.round(computedSpeed))}/h`
    : '—';

  // Stats grid
  const last7 = (d.daily || []).slice(-7);
  const l7chars = last7.reduce((s, r) => s + r.chars, 0);
  const l7secs  = last7.reduce((s, r) => s + r.seconds, 0);
  const l7speed = l7secs > 0 && l7chars > 0 ? Math.round(l7chars / (l7secs / 3600)) : 0;
  const l7display = l7speed > 0 ? `${fmtChars(l7speed)}/h` : '—';

  const statsGrid = document.getElementById('detail-stats-grid');
  statsGrid.style.gridTemplateColumns = 'repeat(4,1fr)';

  statsGrid.innerHTML = `
    <div class="stat-card">
      <div class="label">Total time</div>
      <div class="value" style="color:var(--accent);font-size:22px">${fmtTime(d.total_secs)}</div>
    </div>
    <div class="stat-card">
      <div class="label">Characters</div>
      <div class="value" style="color:var(--success);font-size:22px">${d.total_chars > 0 ? fmtChars(d.total_chars) : '—'}</div>
    </div>
    <div class="stat-card">
      <div class="label">Avg read speed</div>
      <div class="value" style="color:var(--warn);font-size:22px">${speedDisplay}</div>
    </div>
    <div class="stat-card">
      <div class="label">Speed last 7d</div>
      <div class="value" style="color:var(--purple);font-size:22px">${l7display}</div>
    </div>
  `;

  // Chart
  renderDetailChart(d.daily, isGSM);

  // Session list
  const countEl = document.getElementById('detail-session-count');
  countEl.textContent = `(${d.days_count})`;
  setDetailSessions('detail', d.daily);
}

// ── Detail charts (shared) ─────────────────────────────────────────────────
// Media detail, series detail and milestone detail each used to render the same
// four stacked charts — time bar, chars bar, speed line, speed 7d-rolling line —
// from three near-identical functions. They are now one chart driven by a
// Time / Chars / Speed switcher, built here once.
//
// Speed mode draws the raw per-day series and its 7d rolling average on the SAME
// chart; comparing a spike against its own trend used to mean scrolling between
// two of them.
//
// Reading-speed invariant: every speed value below is derived from a chars total
// over a time total. `sessions.reading_speed` is never consulted.

let detailMetric = 'time';        // 'time' | 'chars' | 'speed' — shared by all three views
let detailCumulative = false;     // chart shape: per-bucket bars vs running total, likewise shared
const detailChartCfg = {};        // view -> config, set by that view's render fn

// Roll a daily series up to weekly buckets past `weeklyOver` days, so a long
// title doesn't render hundreds of 1px bars. `splitSource` is an array parallel
// to `daily` of { key: { chars, secs } } — the same shape for milestone splits
// and book splits, so one rollup serves both.
function rollDetailSeries(daily, splitSource, weeklyOver) {
  const blank = daily.map(() => ({}));
  if (!weeklyOver || daily.length <= weeklyOver) {
    return {
      labels: daily.map(r => r.date.slice(5)),
      chars:  daily.map(r => r.chars),
      secs:   daily.map(r => r.seconds),
      split:  splitSource || blank,
    };
  }
  const cb = {}, tb = {}, sb = {};
  daily.forEach((r, i) => {
    const d = new Date(r.date);
    // Bucket by the Monday of that date's week. The previous key was built from
    // the day of MONTH -- `year-W{ceil((getDate() + jan1Dow) / 7)}` -- so Jan 2,
    // Feb 2 and Mar 2 all landed in "W01" and a full year collapsed into six
    // buckets, silently averaging months together in one bar.
    const monday = new Date(d);
    monday.setDate(d.getDate() - ((d.getDay() + 6) % 7));
    const wk = isoDateFromObj(monday);
    cb[wk] = (cb[wk] || 0) + r.chars;
    tb[wk] = (tb[wk] || 0) + r.seconds;
    const src = splitSource && splitSource[i];
    if (src) {
      const dst = sb[wk] || (sb[wk] = {});
      for (const k in src) {
        const s = dst[k] || (dst[k] = { chars: 0, secs: 0 });
        s.chars += src[k].chars || 0;
        s.secs  += src[k].secs  || 0;
      }
    }
  });
  const keys = Object.keys(cb).sort();   // ISO week-start dates sort chronologically
  return {
    labels: keys.map(k => k.slice(5)),   // MM-DD of the week start, like the daily labels
    chars:  keys.map(k => cb[k]),
    secs:   keys.map(k => tb[k]),
    split:  keys.map(k => sb[k] || {}),
  };
}

// Stacked bar segments, one per split member. `members` is [{key,color,label}] —
// milestones for media detail, books for a series — and is the single source of
// truth for both this and the per-member speed lines below.
function splitBarDatasets(split, members, field, scale, stackName) {
  return members
    .filter(o => split.some(m => m[o.key] && m[o.key][field] > 0))
    .map(o => ({
      label: o.label,
      data: split.map(m => ((m[o.key] && m[o.key][field]) || 0) * scale),
      backgroundColor: o.color,
      stack: stackName,
      borderRadius: 3,
      borderSkipped: false,
    }));
}

// Splitting speed COLORS the existing line rather than recomputing per member.
//
// Time and chars split by segmenting the same totals, so speed should too: the
// line you see is identical whether the toggle is on or off, and the split only
// annotates which member you were in. Recomputing a separate rolling average per
// member instead meant each line carried its own trailing-window boundary, which
// ran past the end of a milestone and tangled with the next one — a whole bug
// class that simply doesn't exist when nothing is recalculated.
//
// Returns one color per bucket: the member with the most chars in that bucket
// (falling back to secs for chars-less reading). A bucket where two members were
// both read — the handoff day — takes the dominant one; the line only has a
// single value there, so a single color is the honest representation.
function speedSegmentColors(split, members) {
  const active = members.filter(o =>
    split.some(m => m[o.key] && ((m[o.key].chars || 0) > 0 || (m[o.key].secs || 0) > 0)));
  const colors = split.map(m => {
    let best = null, bestChars = -1, bestSecs = -1;
    for (const o of active) {
      const v = m[o.key];
      if (!v) continue;
      const c = v.chars || 0, s = v.secs || 0;
      if (c > bestChars || (c === bestChars && c === 0 && s > bestSecs)) {
        best = o; bestChars = c; bestSecs = s;
      }
    }
    return best ? best.color : null;
  });
  return { colors, active };
}

// Legend entries for a member color key (split speed mode), where the swatches
// describe milestones/books rather than datasets.
//
// `fontColor` is NOT optional: Chart.js v4 draws legend text with
// `ctx.fillStyle = item.fontColor` and no fallback, so an item missing it renders
// black regardless of `labels.color`. The built-in generateLabels populates it
// from labels.color; a custom one has to do the same.
function memberLegendLabels(items) {
  return (items || []).map(o => ({
    text: o.label,
    fillStyle: o.color,
    strokeStyle: o.color,
    fontColor: CT.dim,
    lineWidth: 0,
    pointStyle: 'circle',
    hidden: false,
  }));
}

// Grey out Chars/Speed for a title that has no character data (listening, say)
// and fall back to Time so the view never lands on an empty metric.
function syncDetailMetricSeg(view, avail) {
  const cfg = detailChartCfg[view];
  const seg = document.getElementById(cfg?.segId);
  if (seg) {
    seg.querySelectorAll('.seg-btn').forEach(b => {
      const ok = avail[b.dataset.metric];
      b.disabled = !ok;
      b.classList.toggle('active', ok && b.dataset.metric === detailMetric);
    });
  }
  // Cumulative is off the table for Speed (a running total of a rate is
  // nonsense) — the seg fades but keeps its choice, so switching away to Speed
  // and back doesn't silently drop you into Daily.
  const vseg = document.getElementById(cfg?.viewSegId);
  if (vseg) {
    vseg.querySelectorAll('.seg-btn').forEach(b => {
      b.disabled = detailMetric === 'speed';
      b.classList.toggle('active', (b.dataset.view === 'cum') === detailCumulative);
    });
  }
}

function setDetailMetric(view, metric) {
  detailMetric = metric;
  renderDetailMetricChart(view);
}

function setDetailView(view, v) {
  detailCumulative = (v === 'cum');
  renderDetailMetricChart(view);
}

function renderDetailMetricChart(view) {
  const cfg = detailChartCfg[view];
  if (!cfg) return;
  const { key, canvasId, daily, splitOn, splitMembers, stackName, splitSource, weeklyOver, splitLabelId } = cfg;

  destroyChart(key);
  if (!daily || !daily.length) {
    setChartEmpty(canvasId, 'No session data yet');
    return;
  }

  const { labels, chars, secs, split } = rollDetailSeries(daily, splitSource, weeklyOver);
  const speed   = chars.map((c, i) => secs[i] > 0 && c > 0 ? c / (secs[i] / 3600) : 0);
  const rolling = twRolling(chars, secs, 7);

  const avail = {
    time:  secs.some(v => v > 0),
    chars: chars.some(v => v > 0),
    speed: speed.some(v => v > 0),
  };
  if (!avail[detailMetric]) detailMetric = avail.time ? 'time' : (avail.chars ? 'chars' : 'time');
  syncDetailMetricSeg(view, avail);

  const metric  = detailMetric;
  // Splitting applies to every metric. Time and chars stack into bar segments;
  // Speed and Cumulative are single curves that can't stack, so for those the
  // split recolors the one line per bucket instead (see the `seg` note below).
  const members = splitMembers ? splitMembers() : null;
  const doSplit = !!splitOn && !!members && split.some(s => Object.keys(s).length);

  if (!avail[metric]) {
    setChartEmpty(canvasId, 'No data for this metric');
    return;
  }

  // Cumulative is a shape, not a metric — it re-plots Time/Chars as a running
  // total. Speed opts out (see syncDetailMetricSeg).
  const cum = detailCumulative && metric !== 'speed';

  reserveLegendRoom(canvasId, key, 180, doSplit || metric === 'speed');

  // One color per bucket for whichever member dominated it. Shared by split
  // Speed and split Cumulative: both are single curves that can't stack, so the
  // split ANNOTATES the line rather than dividing it, and the curve is identical
  // whether the toggle is on or off. `segC(a)` paints a line's segments from it.
  const seg  = doSplit ? speedSegmentColors(split, members) : null;
  const segC = (a) => seg
    ? { segment: { borderColor: ctx => {
          const c = seg.colors[ctx.p1DataIndex];
          return c ? (a < 1 ? ctAlpha(c, a) : c) : undefined;
        } } }
    : {};

  // Same shape decision as the Stats chart (renderDailyCumChart): the running
  // total REPLACES the bars on the one axis, and time is HOURS at every rollup —
  // not the bar view's minutes, which a title-sized total would read in the
  // thousands of.
  const cumCfg = () => {
    const asChars = metric === 'chars';
    const color   = asChars ? CT.success : CT.accent;
    return {
      type: 'line',
      legendItems: seg ? seg.active : null,
      datasets: [{
        label: asChars ? 'Characters' : 'Time',
        data: statsCumSeries({ chars, secs }, asChars),
        borderColor: color,
        // No area fill under a segmented line — one flat tint would contradict
        // the colors the line is shifting through. Unsplit, it fills like Stats.
        backgroundColor: seg ? 'transparent' : ctAlpha(color, 0.12),
        fill: seg ? false : 'origin',
        borderWidth: 2.5, pointRadius: 0, pointHoverRadius: 5,
        pointBackgroundColor: seg ? (ctx => seg.colors[ctx.dataIndex] || color) : color,
        pointBorderColor: CT.card, pointBorderWidth: 2,
        // tension 0: a running total is monotonic, and cubic interpolation
        // overshoots into a dip on a flat stretch — reading that went backwards.
        tension: 0, ...segC(1),
      }],
      yTick: asChars ? (v => fmtChars(v)) : (v => fmtHourTick(v)),
      tip:   asChars ? (c => `Total: ${fmtChars(Math.round(c.raw))} chars`)
                     : (c => `Total: ${fmtTime(c.raw * 3600)}`),
      foot:  undefined,
    };
  };

  const cfgByMetric = {
    time: () => ({
      type: 'bar',
      datasets: doSplit
        ? splitBarDatasets(split, members, 'secs', 1 / 60, stackName)
        : [{ label: 'Time', data: secs.map(s => s / 60), backgroundColor: CT.accent,
             borderRadius: 3, borderSkipped: false }],
      yTick: v => fmtTime(v * 60),
      tip:   c => `${doSplit ? c.dataset.label + ': ' : ''}${fmtTime(c.raw * 60)}`,
      foot:  c => `Total: ${fmtTime(c.reduce((a, x) => a + x.raw, 0) * 60)}`,
    }),
    chars: () => ({
      type: 'bar',
      datasets: doSplit
        ? splitBarDatasets(split, members, 'chars', 1, stackName)
        : [{ label: 'Characters', data: chars, backgroundColor: CT.success,
             borderRadius: 3, borderSkipped: false }],
      yTick: v => fmtChars(v),
      tip:   c => `${doSplit ? c.dataset.label + ': ' : ''}${fmtChars(Math.round(c.raw))} chars`,
      foot:  c => `Total: ${fmtChars(Math.round(c.reduce((a, x) => a + x.raw, 0)))}`,
    }),
    speed: () => {
      // Two purple lines: the raw daily dotted and dimmed, the 7d trend solid on
      // top. One hue separated by weight and dash reads more calmly than two
      // competing colors.
      //
      // With split on, these are the SAME two lines — only recolored per segment
      // by whichever member dominated that bucket. Nothing is recomputed, so the
      // curve is identical whether the toggle is on or off.
      //
      // Array order is the draw order and the legend order: daily first so it
      // sits behind and reads first in the key. Don't add `order:` here — lower
      // order draws FIRST (behind) and also re-sorts the legend, reversing both.
      //
      // No area fill: speed is a rate, so the region under the line isn't a
      // quantity that means anything.
      return {
      type: 'line',
      legendItems: seg ? seg.active : null,
      datasets: [
        { label: 'Daily', data: speed.map(v => v > 0 ? v : null),
          borderColor: ctAlpha(CT.purple, 0.45), backgroundColor: 'transparent',
          borderWidth: 1.5, borderDash: [3, 3],
          pointRadius: 0, pointHoverRadius: 5,
          pointBackgroundColor: ctAlpha(CT.purple, 0.45), pointBorderWidth: 0,
          fill: false, tension: 0.35, spanGaps: false, ...segC(0.4) },
        { label: '7d rolling', data: rolling,
          borderColor: CT.purple, backgroundColor: 'transparent',
          borderWidth: 2.5, pointRadius: 0, pointHoverRadius: 6,
          pointBackgroundColor: CT.purple, pointBorderColor: CT.card, pointBorderWidth: 2,
          fill: false, tension: 0.35, spanGaps: true, ...segC(1) },
      ],
      yTick: v => fmtChars(v),
      tip:   c => c.raw != null ? `${c.dataset.label}: ${fmtChars(Math.round(c.raw))}/h` : '',
      foot:  undefined,
      };
    },
  };

  const m       = cum ? cumCfg() : cfgByMetric[metric]();
  const stacked = doSplit && m.type === 'bar';
  const legend  = doSplit || metric === 'speed';

  charts[key] = new Chart(document.getElementById(canvasId).getContext('2d'), {
    type: m.type,
    data: { labels, datasets: m.datasets },
    options: {
      responsive: true, maintainAspectRatio: false, animation: false,
      interaction: (stacked || metric === 'speed' || cum) ? { mode: 'index', intersect: false } : undefined,
      plugins: {
        legend: {
          display: legend, position: 'bottom',
          labels: {
            color: CT.dim, boxWidth: 12, boxHeight: 12, usePointStyle: true,
            // In split speed mode the color key describes members, not datasets
            // (there are only two datasets and both are recolored per segment).
            ...(m.legendItems ? {
              generateLabels: () => memberLegendLabels(m.legendItems),
            } : {}),
          },
          // Those synthesized entries don't map to datasets, so clicking one
          // would try to toggle a dataset that isn't there.
          onClick: m.legendItems ? () => {} : undefined,
        },
        tooltip: { callbacks: {
          title:  c => labels[c[0].dataIndex],
          label:  m.tip,
          footer: stacked ? m.foot : undefined,
        } },
      },
      scales: {
        x: { stacked, grid: { color: CT.grid },
             ticks: { color: CT.dim, maxRotation: 0, autoSkip: true, maxTicksLimit: 14 } },
        y: { stacked, grid: { color: CT.grid },
             // Speed mode carries two differently-colored series, so the axis
             // stays neutral — tinting it would imply one series owns it.
             ticks: { color: CT.dim, callback: m.yTick },
             beginAtZero: metric !== 'speed',
             afterFit: s => { s.width = 62; } },
      },
    },
  });
}

function renderDetailChart(daily, isGSM) {
  detailChartCfg.detail = {
    key: 'detail', canvasId: 'chart-detail-main', segId: 'detail-metric-seg',
    viewSegId: 'detail-view-seg',
    splitLabelId: 'ms-split-label',
    daily,
    // Media detail is the one view that rolls up to weeks past ~3 months; a
    // long title otherwise renders hundreds of hairline bars.
    weeklyOver: 90,
    splitOn: splitByMilestone && currentMilestones.length > 0,
    splitSource: daily.map(r => r.by_milestone || {}),
    splitMembers: milestoneMembers,
    stackName: 'milestone',
  };
  renderDetailMetricChart('detail');
}

// ── Detail session lists (collapsible) ─────────────────────────────────────
// Media detail and milestone detail each end in a day-by-day list that runs to
// hundreds of rows on a long title, burying the charts above it. Both lists now
// start collapsed behind their own heading and build their rows on first
// expand; opening a different title resets them to collapsed.
const detailSessionCfg = {
  detail:    { listId: 'detail-session-list',    caretId: 'detail-session-caret',
               empty: 'No session data.' },
  milestone: { listId: 'milestone-session-list', caretId: 'milestone-session-caret',
               empty: 'No session data in this milestone yet.' },
};
const detailSessionRows  = { detail: [], milestone: [] };
const detailSessionsOpen = { detail: false, milestone: false };

// Stash the data for a view's list and reset it to collapsed + empty.
function setDetailSessions(key, daily) {
  detailSessionRows[key]  = [...(daily || [])].reverse();   // newest first
  detailSessionsOpen[key] = false;
  const el = document.getElementById(detailSessionCfg[key].listId);
  if (el) { el.innerHTML = ''; el.style.display = 'none'; }
  syncDetailSessionCaret(key);
}

function syncDetailSessionCaret(key) {
  const caret = document.getElementById(detailSessionCfg[key].caretId);
  if (caret) caret.textContent = detailSessionsOpen[key] ? '▴' : '▾';
}

function toggleDetailSessions(key) {
  const el = document.getElementById(detailSessionCfg[key].listId);
  if (!el) return;
  const open = !detailSessionsOpen[key];
  detailSessionsOpen[key] = open;
  if (open && !el.childElementCount) buildDetailSessionRows(key);
  el.style.display = open ? '' : 'none';
  syncDetailSessionCaret(key);
}

function buildDetailSessionRows(key) {
  const el   = document.getElementById(detailSessionCfg[key].listId);
  const rows = detailSessionRows[key];

  if (!rows.length) {
    el.innerHTML = `<p class="empty-msg">${detailSessionCfg[key].empty}</p>`;
    return;
  }

  const frag = document.createDocumentFragment();
  rows.forEach(s => {
    const row = document.createElement('div');
    row.className = 'detail-session-row';

    const speedHTML = s.speed > 0
      ? `<span class="dsr-speed">${fmtChars(Math.round(s.speed))}/h</span>`
      : '';

    row.innerHTML = `
      <span class="dsr-date">${s.date}</span>
      <span class="dsr-time">${fmtTime(s.seconds)}</span>
      <span class="dsr-chars">${s.chars > 0 ? fmtChars(s.chars) + ' chars' : ''}</span>
      ${speedHTML}
    `;
    frag.appendChild(row);
  });
  el.appendChild(frag);
}

// ── Title alias editing ────────────────────────────────────────────────────
let _titleEditPrev = '';

function renderDetailTitle(display) {
  const el = document.getElementById('detail-title');
  el.innerHTML =
    `<span id="detail-title-text">${escHtml(display)}</span>` +
    `<button class="btn btn-xs btn-outline" onclick="startEditTitle()" ` +
    `style="margin-left:10px;font-size:11px;vertical-align:middle;flex-shrink:0;opacity:0.7">✎</button>`;
}

function startEditTitle() {
  _titleEditPrev = document.getElementById('detail-title-text')?.textContent || '';
  const el = document.getElementById('detail-title');
  el.innerHTML =
    `<input id="title-edit-input" type="text" value="${escHtml(_titleEditPrev)}"
            style="font-size:18px;font-weight:700;color:var(--text);background:#141422;
                   border:1px solid var(--accent);border-radius:8px;padding:4px 10px;
                   outline:none;flex:1;min-width:0"
            onkeydown="handleTitleEditKey(event)">` +
    `<span style="font-size:10px;color:var(--dim);margin-left:8px;white-space:nowrap;flex-shrink:0">↵ save · Esc cancel</span>`;
  el.style.display = 'flex';
  el.style.alignItems = 'center';
  const input = document.getElementById('title-edit-input');
  input.focus(); input.select();
}

function handleTitleEditKey(e) {
  if (e.key === 'Enter') {
    e.preventDefault();
    commitTitleEdit(document.getElementById('title-edit-input').value.trim());
  } else if (e.key === 'Escape') {
    renderDetailTitle(_titleEditPrev);
  }
}

async function commitTitleEdit(newDisplay) {
  const r = await window.pywebview.api.set_title_alias(currentDetailTitle, newDisplay);
  const effective = (r.ok && newDisplay) ? newDisplay : (r.ok ? currentDetailTitle : _titleEditPrev);
  renderDetailTitle(effective);
  if (r.ok) {
    // Update breadcrumb and refresh media grid
    document.getElementById('detail-breadcrumb').textContent = `Media  ›  ${effective}`;
    mediaAllData = await window.pywebview.api.get_media();
    renderMediaGrid();
  }
}

// ── Theme ──────────────────────────────────────────────────────────────────
function applyTheme(theme) {
  if (theme === 'mint') {
    document.documentElement.setAttribute('data-theme', 'mint');
    HEATMAP_COLORS = ['#E8F5F0','#A8DDD2','#62C4B4','#2EAA92','#1A7060'];
    refreshChartTheme();
    // Mint's chart text/grid were hand-tuned softer than its --dim/--grid;
    // keep those exact values rather than letting the vars win.
    Chart.defaults.color       = '#8AADA9';
    Chart.defaults.borderColor = '#C2E4DC';
    CT.dim  = '#8AADA9';
    CT.grid = '#C2E4DC';
  } else {
    document.documentElement.removeAttribute('data-theme');
    HEATMAP_COLORS = ['#1E1E30','#1a3b4a','#1e6b52','#26a06e','#4ECBA0'];
    refreshChartTheme();
  }
  // Update active-page charts to reflect new theme colors
  loadPage(currentPage);
}

function setTheme(theme) {
  appSettings = { ...appSettings, theme };
  window.pywebview.api.save_settings({ theme });
  applyTheme(theme);
  document.querySelectorAll('.theme-opt').forEach(el =>
    el.classList.toggle('selected', el.dataset.theme === theme));
}

// ── Catalog ────────────────────────────────────────────────────────────────
let catalogRows = [];

async function loadCatalog() {
  const data = await window.pywebview.api.get_catalog();
  catalogRows = data.rows || [];
  const books = document.getElementById('catalog-books');
  if (books) books.textContent = (+(data.total_books || 0)).toFixed(1);
  renderCatalogBody();
}

function catTypeLabel(t) { return t === 'game' ? 'Game' : t === 'manga' ? 'Manga' : 'Book'; }
function catCountText(r) {
  if (r.reading_type === 'manga') return `${r.volumes} vol${r.volumes === 1 ? '' : 's'}`;
  return `${fmtChars(r.chars)} chars`;
}

function renderCatalogBody() {
  const body  = document.getElementById('catalog-body');
  const empty = document.getElementById('catalog-empty');
  body.innerHTML = '';
  if (!catalogRows.length) { empty.style.display = ''; return; }
  empty.style.display = 'none';
  catalogRows.forEach(r => {
    const tr = document.createElement('tr');
    const nameCell = r.linked
      ? `<span class="cat-name">${escHtml(r.display_name)}</span><span class="cat-chip" title="Auto-added from your sessions; char count grows as you read more">tracked</span>`
      : `<span class="cat-name cat-editable" title="Double-click to rename"
           ondblclick="startCatNameEdit(this, ${r.id})">${escHtml(r.name)}</span>`;
    tr.innerHTML = `
      <td>${nameCell}</td>
      <td><span class="cat-editable" title="Double-click to change"
            ondblclick="startCatTypeEdit(this, ${r.id})">${catTypeLabel(r.reading_type)}</span></td>
      <td class="cat-count-cell"><span class="cat-editable" title="Double-click to edit"
            ondblclick="startCatCountEdit(this, ${r.id})">${catCountText(r)}</span></td>
      <td><button class="cat-del" title="Remove" onclick="deleteCatalogEntry(${r.id})">✕</button></td>`;
    body.appendChild(tr);
  });
}

async function _catSave(id, fields) {
  const res = await window.pywebview.api.update_catalog_entry(id, fields);
  if (res && res.ok === false) { alert(res.error || 'Could not save'); }
  await loadCatalog();
}
// Every field is plain text until you double-click it. The edit control commits
// on blur (or Enter / select-change) and reverts to text on Escape or no-change.
// Manual editing is rare, so the table reads cleanly by default.
function startCatNameEdit(span, id) {
  const cur = span.textContent.trim();
  const input = document.createElement('input');
  input.type = 'text';
  input.className = 'cat-input cat-name-input';
  input.value = cur;
  _catEdit(span, () => {
    const next = input.value.trim();
    return (next && next !== cur) ? { name: next } : null;
  }, input, id);
  input.select();
}

function startCatTypeEdit(span, id) {
  const r = catalogRows.find(x => x.id === id); if (!r) return;
  const sel = document.createElement('select');
  sel.className = 'cat-input cat-type';
  [['book','Book'], ['game','Game'], ['manga','Manga']].forEach(([v, l]) => {
    const o = document.createElement('option');
    o.value = v; o.textContent = l;
    if (r.reading_type === v) o.selected = true;
    sel.appendChild(o);
  });
  _catEdit(span, () => sel.value !== r.reading_type ? { reading_type: sel.value } : null,
           sel, id, 'change');
}

function startCatCountEdit(span, id) {
  const r = catalogRows.find(x => x.id === id); if (!r) return;
  const field = r.reading_type === 'manga' ? 'volumes' : 'chars';
  const cur   = r.reading_type === 'manga' ? r.volumes : r.chars;
  const input = document.createElement('input');
  input.type = 'number'; input.min = '0'; input.className = 'cat-input cat-count';
  input.value = cur;
  _catEdit(span, () => {
    const next = parseInt(input.value || '0', 10);
    return (!isNaN(next) && next !== cur) ? { [field]: next } : null;
  }, input, id);
  input.select();
}

// Shared inline-edit lifecycle: swap `span` for `control`, focus it, then commit
// (via `diff()` → fields-or-null) on blur/Enter/change, or revert on Escape/no-op.
function _catEdit(span, diff, control, id, commitOn) {
  const td = span.parentElement;
  let done = false;
  const finish = (save) => {
    if (done) return;
    done = true;
    const fields = save ? diff() : null;
    if (fields) _catSave(id, fields);   // reloads the table
    else renderCatalogBody();           // revert to text style
  };
  control.addEventListener('blur', () => finish(true));
  control.addEventListener('keydown', (e) => {
    if (e.key === 'Enter')  { e.preventDefault(); control.blur(); }
    else if (e.key === 'Escape') { done = true; renderCatalogBody(); }
  });
  if (commitOn === 'change') control.addEventListener('change', () => finish(true));
  td.innerHTML = '';
  td.appendChild(control);
  control.focus();
}

async function addCatalogRow() {
  const name = (prompt('Title name?') || '').trim();
  if (!name) return;
  const res = await window.pywebview.api.add_catalog_entry(name, 'book', 0, 0);
  if (res && res.ok === false) { alert(res.error || 'Could not add'); return; }
  await loadCatalog();
}

async function deleteCatalogEntry(id) {
  const r = catalogRows.find(x => x.id === id);
  const label = r ? (r.display_name || r.name) : 'this entry';
  if (!confirm(`Remove "${label}" from the catalog?`)) return;
  await window.pywebview.api.delete_catalog_entry(id);
  await loadCatalog();
}

// ── Settings ───────────────────────────────────────────────────────────────
async function loadSettings() {
  const s = await window.pywebview.api.get_all_settings();
  appSettings = s;
  document.getElementById('gsm-url').value             = s.gsm_url || 'http://localhost:7275/api/stats';
  document.getElementById('rollover-hour').value       = String(s.rollover_hour || 0);
  document.getElementById('gsm-debounce').value        = s.gsm_debounce_secs || 60;
  document.getElementById('gsm-open-gap').value         = s.gsm_open_gap_secs ?? 0;
  const todayStatsEl = document.getElementById('gsm-today-stats');
  if (todayStatsEl) todayStatsEl.value = s.gsm_today_stats || 'off';
  document.getElementById('ext-host').value            = s.ext_host  || '127.0.0.1';
  document.getElementById('ext-port').value            = s.ext_port  || 18463;
  document.getElementById('ext-token').value           = s.ext_token || '';
  const lanBox = document.getElementById('lan-ingest');
  if (lanBox) {
    lanBox.checked = !!s.lan_ingest;
    renderLanHint(!!s.lan_ingest, s.ext_port || 18463);
  }
  const inboxUrlEl = document.getElementById('inbox-url');
  if (inboxUrlEl) {
    inboxUrlEl.value = s.inbox_url || '';
    document.getElementById('inbox-drain-secs').value = s.inbox_drain_secs || 120;
    // Status is a network round trip; only pay for it when it's configured.
    document.getElementById('inbox-status').textContent = s.inbox_url ? '' : 'Not configured.';
  }
  const gsmTimeBox  = document.getElementById('gsm-history-include-time');
  const ttsuTimeBox = document.getElementById('ttsu-history-include-time');
  if (gsmTimeBox)  gsmTimeBox.checked  = !!s.gsm_history_include_time;
  if (ttsuTimeBox) ttsuTimeBox.checked = !!s.ttsu_history_include_time;
  const theme = s.theme || 'dark';
  document.querySelectorAll('.theme-opt').forEach(el =>
    el.classList.toggle('selected', el.dataset.theme === theme));
}

// ── First-time setup wizard ────────────────────────────────────────────────
function openSetupWizard() {
  navigate('settings');
  document.getElementById('settings-main-view').style.display  = 'none';
  document.getElementById('settings-setup-view').style.display = '';
  loadSettings();
  loadGSMGamesList();
}

function closeSetupWizard() {
  document.getElementById('settings-setup-view').style.display = 'none';
  document.getElementById('settings-main-view').style.display  = '';
  clearSetupFeedback();
}

function clearSetupFeedback() {
  ['setup-csv-feedback', 'setup-gsm-feedback', 'setup-ttsu-feedback'].forEach(id => {
    const el = document.getElementById(id);
    if (el) { el.className = ''; el.textContent = ''; }
  });
}

async function onSetupTogglePastTime(kind) {
  const id  = kind === 'gsm' ? 'gsm-history-include-time' : 'ttsu-history-include-time';
  const fb  = document.getElementById(kind === 'gsm' ? 'setup-gsm-feedback' : 'setup-ttsu-feedback');
  const box = document.getElementById(id);
  if (box.checked) {
    const ok = await showConfirm(
      'Including past session time will add historical hours to your stats. ' +
      'This affects time totals, streaks, and the heatmap. Are you sure?',
      'Yes, include past time'
    );
    if (!ok) { box.checked = false; return; }
  }
  const key = kind === 'gsm' ? 'gsm_history_include_time' : 'ttsu_history_include_time';
  await window.pywebview.api.save_settings({ [key]: box.checked });
  appSettings[key] = box.checked;
  if (fb) {
    fb.className = 'feedback ok';
    fb.textContent = box.checked
      ? '✓ Past session time will be included on next import.'
      : '✓ Past session time will be excluded on next import.';
  }
}

async function dismissFirstRun(goToSetup) {
  document.getElementById('firstrun-overlay').style.display = 'none';
  await window.pywebview.api.complete_first_run();
  appSettings.first_run_complete = true;
  if (goToSetup) openSetupWizard();
}

async function maybeShowFirstRunModal() {
  if (appSettings && appSettings.first_run_complete) return;
  const overlay = document.getElementById('firstrun-overlay');
  if (overlay) overlay.style.display = '';
}

function copyExtField(id) {
  const el = document.getElementById(id);
  if (!el) return;
  // Inputs expose .value; the firewall command is a <code> block, so fall back
  // to its text.
  const val = ('value' in el && el.value !== undefined) ? el.value : el.textContent;
  navigator.clipboard.writeText(val).catch(() => {});
}

// The firewall rule is only relevant once we're actually binding off loopback,
// and only on Windows — where a missing inbound rule looks exactly like a broken
// server from the other device's side.
function renderLanHint(on, port) {
  const hint = document.getElementById('lan-firewall-hint');
  const cmd  = document.getElementById('lan-firewall-cmd');
  if (!hint || !cmd) return;
  cmd.textContent = `New-NetFirewallRule -DisplayName "Konseki sync" -Direction Inbound -Protocol TCP -LocalPort ${port} -Action Allow -Profile Private`;
  hint.style.display = on ? '' : 'none';
}

async function saveInboxSettings() {
  const inbox_url = document.getElementById('inbox-url').value.trim().replace(/\/+$/, '');
  const raw = document.getElementById('inbox-drain-secs').value;
  const inbox_drain_secs = raw === '' ? 120 : Math.max(15, parseInt(raw) || 120);
  appSettings = { ...appSettings, inbox_url, inbox_drain_secs };
  await window.pywebview.api.save_settings({ inbox_url, inbox_drain_secs });
  refreshInboxStatus();
}

// Draining is meant to be invisible — an inbox that's merely unreachable is the
// normal case, not an error. This readout exists so a drain that has quietly
// stopped working is findable, and so "did my phone's log arrive?" is answerable.
async function refreshInboxStatus() {
  const el = document.getElementById('inbox-status');
  if (!el) return;
  el.textContent = 'Checking…';
  const s = await window.pywebview.api.drain_inbox_now();
  if (!s || s.enabled === false) { el.textContent = 'Not configured.'; return; }
  if (!s.reachable) {
    el.textContent = `Can't reach it${s.last_error ? ' — ' + s.last_error : ''}.`;
    return;
  }
  const bits = [];
  if (s.applied) bits.push(`Collected ${s.applied} session${s.applied === 1 ? '' : 's'}`);
  bits.push(s.pending ? `${s.pending} still waiting` : 'nothing waiting');
  el.textContent = bits.join(' · ') + '.';
}

async function onToggleLanIngest() {
  const on = document.getElementById('lan-ingest').checked;
  appSettings = { ...appSettings, lan_ingest: on };
  await window.pywebview.api.save_settings({ lan_ingest: on });
  renderLanHint(on, (appSettings && appSettings.ext_port) || 18463);
  setStatus(on ? 'LAN sync on — restart Konseki to apply'
               : 'LAN sync off — restart Konseki to apply');
}

async function rerollExtToken() {
  if (!confirm('Reroll the token? You will need to paste the new token into the extension.')) return;
  const res = await window.pywebview.api.reroll_ext_token();
  if (res.ok) {
    document.getElementById('ext-token').value = res.token;
    setStatus('Token rerolled — update your extension');
  }
}

/* ── GSM aggregate import JS — INACTIVE ──────────────────────────────────────
   Restore alongside gsm_aggregate_import() in tracker.py and the HTML card.

async function loadGSMImportStatus() { ... }
async function doImportGSMHistory()  { ... }
── ────────────────────────────────────────────────────────────────────────── */

async function saveSettings() {
  const rollover         = parseInt(document.getElementById('rollover-hour').value) || 0;
  const gsm_url          = document.getElementById('gsm-url').value.trim();
  const gsm_debounce_secs = parseInt(document.getElementById('gsm-debounce').value) || 60;
  const gapRaw = document.getElementById('gsm-open-gap').value;
  const gsm_open_gap_secs = gapRaw === '' ? 0 : (parseInt(gapRaw) || 0);
  const tsEl = document.getElementById('gsm-today-stats');
  const gsm_today_stats = tsEl ? tsEl.value : 'off';
  appSettings = { ...appSettings, rollover_hour: rollover, gsm_url, gsm_debounce_secs, gsm_open_gap_secs, gsm_today_stats };
  await window.pywebview.api.save_settings({ rollover_hour: rollover, gsm_url, gsm_debounce_secs, gsm_open_gap_secs, gsm_today_stats });
  scheduleRolloverRefresh();
  setStatus('Settings saved');
}

// Shadow-phase readout for plans/GSM-TODAY-PLAN.md. Pulls fresh evidence, then
// shows what the per-sitting timestamps say the rollover split should have been
// versus what the snapshot writer recorded. Read-only — nothing here writes.
async function refreshGsmEvidence() {
  const st  = document.getElementById('gsm-evidence-status');
  const box = document.getElementById('gsm-evidence-detail');
  if (!st || !box) return;
  const esc = s => String(s ?? '').replace(/[&<>"]/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;'}[c]));
  st.textContent = 'Checking…';
  box.innerHTML  = '';
  try {
    const pull = await window.pywebview.api.gsm_collect_evidence_now();
    const r    = await window.pywebview.api.gsm_evidence_report();
    if (r.mode === 'off') {
      st.textContent = 'Shadow mode is off — switch it on above to start recording.';
      return;
    }
    if (!pull.ok) {
      st.textContent = `Could not reach /api/today-stats (${pull.error}). Showing what was already recorded.`;
    } else {
      st.textContent = `${r.days} day/game record${r.days === 1 ? '' : 's'}, ${r.complete} complete.`;
    }
    if (!r.days) {
      box.innerHTML = '<p class="muted" style="font-size:12px">Nothing recorded yet. Evidence is captured on each GSM pull.</p>';
      return;
    }
    const delta = r.mean_secs_delta === null
      ? '<span class="muted">not enough complete days yet</span>'
      : `${r.mean_secs_delta > 0 ? '+' : ''}${r.mean_secs_delta}s average, ${r.max_secs_delta > 0 ? '+' : ''}${r.max_secs_delta}s worst`;
    const rows = r.rows.slice(0, 14).map(d => `
      <tr>
        <td>${d.real_date}</td>
        <td>${esc(d.title)}</td>
        <td style="text-align:right">${d.sittings}</td>
        <td style="text-align:right">${d.complete ? '✓' : '<span class="muted">partial</span>'}</td>
        <td style="text-align:right">${d.time_source === 'measured'
            ? '<span style="color:var(--ok,inherit)">measured</span>'
            : '<span class="muted">calculated</span>'}</td>
        <td style="text-align:right">${d.secs_delta === null ? '—' : (d.secs_delta > 0 ? '+' : '') + d.secs_delta + 's'}</td>
        <td style="text-align:right">${d.attr_chars_stored} → ${d.attr_chars_implied}${d.agrees ? '' : ' <strong>≠</strong>'}</td>
      </tr>`).join('');
    box.innerHTML = `
      <p class="muted" style="font-size:12px;margin-bottom:8px">
        Using GSM's measured time on <strong>${r.applied}</strong> of ${r.days}.
        Gap where it isn't: ${delta}.
        Split disagreements: <strong>${r.disagree}</strong> of ${r.days}.
      </p>
      <div style="overflow-x:auto">
        <table style="font-size:12px;width:100%;border-collapse:collapse">
          <thead><tr style="text-align:left;color:var(--text-muted)">
            <th>Date</th><th>Title</th><th style="text-align:right">Sittings</th>
            <th style="text-align:right">Saw all</th><th style="text-align:right">Time from</th>
            <th style="text-align:right">Time Δ</th>
            <th style="text-align:right">Rolled chars</th>
          </tr></thead>
          <tbody>${rows}</tbody>
        </table>
      </div>`;
  } catch (e) {
    st.textContent = `Error: ${e}`;
  }
}

async function doTestGSM() {
  const url = document.getElementById('gsm-url').value.trim();
  const fb  = document.getElementById('gsm-status');
  fb.className=''; fb.textContent='Testing…';
  const r = await window.pywebview.api.test_gsm(url);
  fb.className = r.ok ? 'feedback ok' : 'feedback err';
  fb.textContent = r.ok ? '✓ Connected' : `✗ ${r.error || 'Could not connect — is GSM running?'}`;
}

// ── GSM history import ────────────────────────────────────────────────────────
function fmtHours(secs) {
  const h = secs / 3600;
  if (h >= 10) return h.toFixed(1) + 'h';
  if (h >= 1)  return h.toFixed(2) + 'h';
  return Math.round(secs / 60) + 'min';
}

async function loadGSMAnomalies() {
  const banner = document.getElementById('gsm-anomalies-banner');
  if (!banner) return;
  const r = await window.pywebview.api.gsm_list_anomalies();
  if (!r.ok || !r.anomalies || r.anomalies.length === 0) {
    banner.innerHTML = '';
    return;
  }
  const esc = s => String(s ?? '').replace(/[&<>"]/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;'}[c]));
  const rows = r.anomalies.map(a => `
    <li style="padding:8px;background:var(--surface-2);border-radius:4px;margin-bottom:6px">
      <div style="font-size:12px;margin-bottom:4px">
        <strong>${esc(a.game_name || a.game_id)}</strong> on <strong>${esc(a.session_date)}</strong>
      </div>
      <div style="font-size:11px;color:var(--text-muted);margin-bottom:6px">
        GSM rollup is empty (0 chars, 0s) but your tracker has ${fmtChars(a.existing_chars)} chars / ${fmtHours(a.existing_time)}. Update was blocked.
      </div>
      <div style="display:flex;gap:6px">
        <button class="btn btn-outline btn-sm" onclick="doResolveAnomaly(${a.id}, true)">Apply (zero it out)</button>
        <button class="btn btn-outline btn-sm" onclick="doResolveAnomaly(${a.id}, false)">Keep tracker value</button>
      </div>
    </li>`).join('');
  banner.innerHTML = `
    <div style="padding:10px 12px;border:1px solid var(--warn,#c08040);border-radius:6px;background:rgba(192,128,64,0.08)">
      <div style="font-weight:600;font-size:13px;margin-bottom:8px">⚠ GSM sync blocked ${r.anomalies.length} update${r.anomalies.length === 1 ? '' : 's'}</div>
      <ul style="list-style:none;padding:0;margin:0">${rows}</ul>
    </div>`;
}

async function doResolveAnomaly(id, applyChange) {
  await window.pywebview.api.gsm_resolve_anomaly(id, applyChange);
  await loadGSMAnomalies();
}

async function loadGSMGamesList() {
  const list  = document.getElementById('gsm-games-list');
  const pathEl = document.getElementById('gsm-db-path');
  if (!list || !pathEl) return;
  list.innerHTML = '<p class="muted" style="font-size:12px">Loading…</p>';
  loadGSMAnomalies();
  const r = await window.pywebview.api.gsm_list_games();
  pathEl.textContent = r.path || '(unknown)';
  if (!r.ok || !r.games || r.games.length === 0) {
    list.innerHTML = '<p class="muted" style="font-size:12px">No games found in GSM\'s database. Make sure GSM has been used at least once.</p>';
    return;
  }
  const esc = s => String(s ?? '').replace(/[&<>"]/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;'}[c]));
  const rows = r.games.map(g => `
    <tr>
      <td style="padding:6px 8px;max-width:280px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap" title="${esc(g.game_name)}">${esc(g.game_name)}</td>
      <td style="padding:6px 8px;text-align:right;font-size:12px;color:var(--text-muted)">${fmtChars(g.total_chars)}</td>
      <td style="padding:6px 8px;text-align:right;font-size:12px;color:var(--text-muted)">${fmtHours(g.total_time_s)}</td>
      <td style="padding:6px 8px;text-align:center">
        <input type="checkbox" ${g.tracked ? 'checked' : ''}
               onchange="setGSMGamePref('${esc(g.game_id)}', this.checked, document.getElementById('gsm-ct-${esc(g.game_id)}').checked)">
      </td>
      <td style="padding:6px 8px;text-align:center">
        <input type="checkbox" id="gsm-ct-${esc(g.game_id)}" ${g.count_as_time ? 'checked' : ''}
               onchange="setGSMGamePref('${esc(g.game_id)}', this.parentElement.previousElementSibling.firstElementChild.checked, this.checked)">
      </td>
    </tr>`).join('');
  list.innerHTML = `
    <table style="width:100%;border-collapse:collapse;font-size:13px">
      <thead><tr style="border-bottom:1px solid var(--border);color:var(--text-muted);font-size:11px;text-align:left">
        <th style="padding:4px 8px;font-weight:500">Game</th>
        <th style="padding:4px 8px;text-align:right;font-weight:500">Chars</th>
        <th style="padding:4px 8px;text-align:right;font-weight:500">Time</th>
        <th style="padding:4px 8px;text-align:center;font-weight:500">Track</th>
        <th style="padding:4px 8px;text-align:center;font-weight:500">Count as time</th>
      </tr></thead>
      <tbody>${rows}</tbody>
    </table>`;
}

async function setGSMGamePref(gameId, track, countAsTime) {
  await window.pywebview.api.gsm_set_game_prefs(gameId, !!track, !!countAsTime);
  document.getElementById('gsm-apply-btn').disabled = true;
  document.getElementById('gsm-import-preview').innerHTML = '';
}

async function doRefreshGSMGames() {
  await loadGSMGamesList();
  document.getElementById('gsm-apply-btn').disabled = true;
  document.getElementById('gsm-import-preview').innerHTML = '';
}

async function doPreviewGSMImport() {
  const box = document.getElementById('gsm-import-preview');
  const fb  = document.getElementById('gsm-import-feedback');
  fb.className = ''; fb.textContent = '';
  box.innerHTML = '<p class="muted" style="font-size:12px">Computing preview…</p>';
  const r = await window.pywebview.api.gsm_preview_import();
  if (!r.ok || !r.games || r.games.length === 0) {
    box.innerHTML = '<p class="muted" style="font-size:12px">No tracked games to import. Enable Track for at least one game above.</p>';
    document.getElementById('gsm-apply-btn').disabled = true;
    return;
  }
  const esc = s => String(s ?? '').replace(/[&<>"]/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;'}[c]));
  const sign = n => (n >= 0 ? '+' : '') + n;
  const rows = r.games.map(g => {
    const cDelta = g.chars_after - g.chars_before;
    const tDelta = (g.time_after_s - g.time_before_s) / 3600;
    return `<tr>
      <td style="padding:6px 8px;max-width:240px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap" title="${esc(g.game_name)}">${esc(g.game_name)}</td>
      <td style="padding:6px 8px;text-align:right;color:var(--accent)">${g.n_insert}</td>
      <td style="padding:6px 8px;text-align:right">${g.n_update}</td>
      <td style="padding:6px 8px;text-align:right;color:var(--text-muted)">${g.n_unchanged}</td>
      <td style="padding:6px 8px;text-align:right">${sign(cDelta)} chars</td>
      <td style="padding:6px 8px;text-align:right">${(tDelta >= 0 ? '+' : '') + tDelta.toFixed(2)}h</td>
    </tr>`;
  }).join('');
  box.innerHTML = `
    <table style="width:100%;border-collapse:collapse;font-size:12px;border:1px solid var(--border);border-radius:4px">
      <thead><tr style="background:var(--surface-2);color:var(--text-muted);font-size:11px;text-align:left">
        <th style="padding:6px 8px;font-weight:500">Game</th>
        <th style="padding:6px 8px;text-align:right;font-weight:500">Insert</th>
        <th style="padding:6px 8px;text-align:right;font-weight:500">Update</th>
        <th style="padding:6px 8px;text-align:right;font-weight:500">Same</th>
        <th style="padding:6px 8px;text-align:right;font-weight:500">Chars Δ</th>
        <th style="padding:6px 8px;text-align:right;font-weight:500">Time Δ</th>
      </tr></thead>
      <tbody>${rows}</tbody>
    </table>
    <p class="muted" style="font-size:11px;margin-top:6px">Updates preserve each row's existing time-excluded state. Inserts use the per-game "Count as time" setting above.</p>`;
  document.getElementById('gsm-apply-btn').disabled = false;
}

async function doApplyGSMImport() {
  const fb = document.getElementById('gsm-import-feedback');
  if (!confirm('Apply the import? This will update your tracker rows to match GSM\'s authoritative data.')) return;
  fb.className = ''; fb.textContent = 'Applying…';
  const r = await window.pywebview.api.gsm_apply_import();
  if (!r.ok) {
    fb.className = 'feedback err'; fb.textContent = '✗ ' + (r.error || 'Import failed');
    return;
  }
  const total = r.games.reduce((s, g) => s + g.inserted + g.updated, 0);
  fb.className = 'feedback ok';
  fb.textContent = `✓ Imported — ${total} row${total === 1 ? '' : 's'} touched across ${r.games.length} game${r.games.length === 1 ? '' : 's'}.`;
  document.getElementById('gsm-apply-btn').disabled = true;
  document.getElementById('gsm-import-preview').innerHTML = '';
  await loadGSMGamesList();
}

// ── Rollover refresh ───────────────────────────────────────────────────────
let rolloverTimer = null;
function scheduleRolloverRefresh() {
  if (rolloverTimer) { clearTimeout(rolloverTimer); rolloverTimer = null; }
  const rollover = appSettings.rollover_hour || 0;
  const now  = new Date();
  const next = new Date(now.getFullYear(), now.getMonth(), now.getDate(), rollover, 0, 0, 0);
  if (next <= now) next.setDate(next.getDate() + 1);
  const ms = (next - now) + 1000;
  rolloverTimer = setTimeout(() => {
    rolloverTimer = null;
    document.getElementById('log-date')._flatpickr?.setDate(today(), false);
    document.getElementById('tlog-date')._flatpickr?.setDate(today(), false);
    loadPage(currentPage);
    scheduleRolloverRefresh();
  }, ms);
}

// ── Dev page ───────────────────────────────────────────────────────────────
let devLogTimer   = null;
let devPyLogs     = [];   // accumulated backend entries (src:'py')
let devPySeq      = 0;    // highest seq fetched; never reset (survives Clear)
let devLogLastSig = '';   // count + last-ts signature to skip no-op re-renders

let devNotes      = [];    // last fetched notes, cached for tab switches
let devTabs       = [];    // user-defined tabs: [{id, name}]; always ≥1
let devActiveTab  = null;  // numeric tab id; resolved to the first tab on load
let draggedNoteId = null;  // id of the note being dragged onto a tab, or null

async function loadDevPage() {
  await refreshDevLogs();
  await loadDevNotes();
  if (!devLogTimer) devLogTimer = setInterval(refreshDevLogs, 2000);
}

function stopDevLogPoll() {
  if (devLogTimer) { clearInterval(devLogTimer); devLogTimer = null; }
}

async function refreshDevLogs() {
  try {
    const entries = await window.pywebview.api.get_dev_logs(devPySeq);
    if (entries && entries.length) {
      devPySeq = entries[entries.length - 1].seq;
      entries.forEach(e => devPyLogs.push({ ts: e.ts, level: e.level, text: e.text, src: 'py' }));
      if (devPyLogs.length > 2000) devPyLogs = devPyLogs.slice(-2000);
    }
  } catch (e) { /* bridge hiccup — next poll retries */ }
  renderDevLogs();
}

function renderDevLogs() {
  const box = document.getElementById('dev-log-output');
  if (!box) return;
  const all = devPyLogs
    .concat(window.__jsLogBuf.map(e => ({ ...e, src: 'js' })))
    .sort((a, b) => a.ts - b.ts);
  const sig = `${all.length}:${all.length ? all[all.length - 1].ts : 0}`;
  if (sig === devLogLastSig) return;
  devLogLastSig = sig;
  const atBottom = box.scrollTop + box.clientHeight >= box.scrollHeight - 4;
  if (!all.length) {
    box.innerHTML = '<p class="empty-msg">No log output yet.</p>';
  } else {
    box.innerHTML = all.map(e => {
      const cls = (e.level === 'err' || e.level === 'error') ? ' err'
                : (e.level === 'warn' ? ' warn' : '');
      const t = new Date(e.ts * 1000).toTimeString().slice(0, 8);
      return `<div class="dev-log-line${cls}"><span class="dev-log-time">${t}</span>` +
             `<span class="dev-log-src">[${e.src}]</span>${escHtml(e.text)}</div>`;
    }).join('');
  }
  const count = document.getElementById('dev-log-count');
  if (count) count.textContent = all.length ? `${all.length} lines` : '';
  if (atBottom) box.scrollTop = box.scrollHeight;
}

async function clearDevLogs() {
  try { await window.pywebview.api.clear_dev_logs(); } catch (e) {}
  window.__jsLogBuf.length = 0;
  devPyLogs = [];
  devLogLastSig = '';   // devPySeq intentionally kept — new entries keep arriving
  renderDevLogs();
}

async function loadDevNotes() {
  [devTabs, devNotes] = await Promise.all([
    window.pywebview.api.get_dev_tabs(),
    window.pywebview.api.get_dev_notes(),
  ]);
  // Resolve the active tab: keep it if still present, else fall back to the first.
  if (!devTabs.some(t => t.id === devActiveTab)) devActiveTab = devTabs.length ? devTabs[0].id : null;
  renderDevNotes();
}

function renderDevNotes() {
  const list = document.getElementById('dev-notes-list');
  const tabs = document.getElementById('dev-note-tabs');
  if (!list) return;

  // Tab bar: one button per tab, all equal. Double-click a tab to rename it;
  // drop a dragged note onto a tab to move it there.
  if (tabs) {
    tabs.innerHTML = devTabs.map(t =>
      `<button class="seg-btn${devActiveTab === t.id ? ' active' : ''}" ` +
      `onclick="setDevNoteFilter(${t.id})" ondblclick="renameDevTab()" ` +
      `ondragover="onDevTabDragOver(event)" ondragenter="onDevTabDragEnter(event)" ` +
      `ondragleave="onDevTabDragLeave(event)" ondrop="onDevTabDrop(event, ${t.id})">${escHtml(t.name)}</button>`
    ).join('');
  }
  // Rename always applies to the active tab; delete only when there's a spare
  // (the last tab can't be deleted — notes need somewhere to live).
  const rn = document.getElementById('dev-tab-rename');
  const dl = document.getElementById('dev-tab-delete');
  if (rn) rn.style.display = devActiveTab !== null ? '' : 'none';
  if (dl) dl.style.display = (devActiveTab !== null && devTabs.length > 1) ? '' : 'none';

  const shown = devNotes.filter(n => n.tab_id === devActiveTab);

  if (!shown.length) {
    list.innerHTML = '<p class="empty-msg">No notes yet.</p>';
    return;
  }
  // Float important notes to the top (red, then yellow, then grey), newest-first within each.
  shown.sort((a, b) => (b.importance || 0) - (a.importance || 0) || b.id - a.id);
  const dots = (n) => ['grey', 'yellow', 'red'].map((color, level) =>
    `<span class="dev-dot ${color}${(n.importance || 0) === level ? ' on' : ''}" ` +
    `title="${['Not important', 'Medium', 'High'][level]}" ` +
    `onclick="setDevNoteImportance(${n.id}, ${level})"></span>`).join('');
  list.innerHTML = shown.map(n => `
    <div class="dev-note-row" draggable="true" title="Drag onto a tab to move it there"
         ondragstart="onDevNoteDragStart(event, ${n.id})" ondragend="onDevNoteDragEnd(event)">
      <span class="dev-note-grip">⠿</span>
      <span class="dev-note-dots">${dots(n)}</span>
      <span class="dev-note-date">${escHtml((n.created_at || '').slice(0, 16).replace('T', ' '))}</span>
      <span class="dev-note-body">${escHtml(n.body)}</span>
      <button class="btn btn-outline btn-sm" onclick="deleteDevNote(${n.id})">✕</button>
    </div>`).join('');
}

// ── Drag a note onto a tab to move it ──────────────────────────────────────
function onDevNoteDragStart(ev, id) {
  draggedNoteId = id;
  ev.dataTransfer.effectAllowed = 'move';
  ev.dataTransfer.setData('text/plain', String(id));   // Firefox needs some payload
  ev.currentTarget.classList.add('dragging');
}

function onDevNoteDragEnd(ev) {
  ev.currentTarget.classList.remove('dragging');
  draggedNoteId = null;
  document.querySelectorAll('#dev-note-tabs .seg-btn.drop-target')
    .forEach(b => b.classList.remove('drop-target'));
}

function onDevTabDragOver(ev) {
  if (draggedNoteId === null) return;
  ev.preventDefault();                    // allow the drop
  ev.dataTransfer.dropEffect = 'move';
}

function onDevTabDragEnter(ev) {
  if (draggedNoteId !== null) ev.currentTarget.classList.add('drop-target');
}

function onDevTabDragLeave(ev) {
  ev.currentTarget.classList.remove('drop-target');
}

async function onDevTabDrop(ev, tabId) {
  ev.preventDefault();
  ev.currentTarget.classList.remove('drop-target');
  const id = draggedNoteId;
  draggedNoteId = null;
  if (id === null || tabId === devActiveTab) return;   // dropped on the tab it's already in
  const r = await window.pywebview.api.set_dev_note_tab(id, tabId);
  if (r.ok) await loadDevNotes();          // note leaves the current tab's view
}

function setDevNoteFilter(tabId) {
  devActiveTab = tabId;   // null or a numeric id; filters the cached list, no re-fetch
  renderDevNotes();
}

async function addDevTab() {
  const name = (prompt('New tab name:') || '').trim();
  if (!name) return;
  const r = await window.pywebview.api.add_dev_tab(name);
  if (r.ok) { devActiveTab = r.id; await loadDevNotes(); }   // jump to the new tab
}

async function renameDevTab() {
  if (devActiveTab === null) return;
  const cur = devTabs.find(t => t.id === devActiveTab);
  const name = (prompt('Rename tab:', cur ? cur.name : '') || '').trim();
  if (!name) return;
  const r = await window.pywebview.api.rename_dev_tab(devActiveTab, name);
  if (r.ok) await loadDevNotes();
}

async function deleteDevTab() {
  if (devActiveTab === null || devTabs.length <= 1) return;
  const cur = devTabs.find(t => t.id === devActiveTab);
  if (!await showConfirm(`Delete tab “${cur ? cur.name : ''}”? Its notes move to the next tab.`)) return;
  const r = await window.pywebview.api.delete_dev_tab(devActiveTab);
  if (r.ok) { devActiveTab = r.moved_to; await loadDevNotes(); }
  else setStatus(r.error || 'Could not delete tab');
}

async function setDevNoteImportance(id, level) {
  const r = await window.pywebview.api.set_dev_note_importance(id, level);
  if (r.ok) await loadDevNotes();
}

async function addDevNote() {
  const input = document.getElementById('dev-note-input');
  const body = (input.value || '').trim();
  if (!body) return;
  const r = await window.pywebview.api.add_dev_note(body, devActiveTab);   // files under the active tab
  if (r.ok) { input.value = ''; await loadDevNotes(); }
}

async function deleteDevNote(id) {
  if (!await showConfirm('Delete this note?')) return;
  const r = await window.pywebview.api.delete_dev_note(id);
  if (r.ok) await loadDevNotes();
}

// ── Data changed (file watcher) ────────────────────────────────────────────
function onDataChanged() {
  statsCache = {};
  setStatus('New session ingested');
  if      (currentPage === 'dashboard') loadDashboard();
  else if (currentPage === 'history')   loadHistory();
  else if (currentPage === 'stats')     loadStats(currentRange);
  else if (currentPage === 'goals')     loadGoals();
  else if (currentPage === 'media')     {
    // If viewing a detail, refresh it; otherwise refresh the grid
    if (currentDetailTitle) {
      openMediaDetail(currentDetailTitle);
    } else {
      loadMedia();
    }
  }
}

// ── Init ───────────────────────────────────────────────────────────────────
async function init() {
  appSettings = await window.pywebview.api.get_all_settings();
  applyTheme(appSettings.theme || 'dark');
  const urlInput = document.getElementById('gsm-url');
  if (urlInput && appSettings.gsm_url) urlInput.value = appSettings.gsm_url;

  flatpickr('#log-date', {
    dateFormat:    'Y-m-d',
    defaultDate:   today(),
    disableMobile: true,
  });
  flatpickr('#tlog-date', {
    dateFormat:    'Y-m-d',
    defaultDate:   today(),
    disableMobile: true,
  });
  flatpickr('#edit-log-date', {
    dateFormat:    'Y-m-d',
    defaultDate:   today(),
    disableMobile: true,
  });
  flatpickr('#add-media-date', {
    dateFormat:    'Y-m-d',
    defaultDate:   today(),
    disableMobile: true,
  });
  flatpickr('#add-epub-date', {
    dateFormat:    'Y-m-d',
    defaultDate:   today(),
    disableMobile: true,
  });
  flatpickr('#goal-deadline', {
    dateFormat:    'Y-m-d',
    minDate:       'today',
    disableMobile: true,
  });
  flatpickr('#goal-start', {
    dateFormat:    'Y-m-d',
    maxDate:       'today',
    disableMobile: true,
  });

  await buildLogPage();
  setStatus('Ready');
  loadPage('dashboard');
  scheduleRolloverRefresh();
  maybeShowFirstRunModal();
}

// Floating hover tooltip for milestone sections on the completion progress bar.
// One body-level position:fixed element reused across segments — the track
// clips its own overflow and a native `title` can't center its text. Content
// is the milestone name (centered) over its fmtMilestoneTotals summary.
function _progressTipEl() {
  let tip = document.getElementById('progress-tip');
  if (!tip) {
    tip = document.createElement('div');
    tip.id = 'progress-tip';
    tip.className = 'progress-tip';
    tip.setAttribute('role', 'tooltip');
    document.body.appendChild(tip);
  }
  return tip;
}

function showProgressTip(seg, name, meta) {
  const tip = _progressTipEl();
  tip.innerHTML =
    `<div class="progress-tip-name">${escHtml(name)}</div>` +
    (meta ? `<div class="progress-tip-meta">${escHtml(meta)}</div>` : '');
  tip.style.display = 'block';
  // Measure once visible, then center over the segment and sit just above it,
  // flipping below and clamping to the viewport when there's no room.
  const r  = seg.getBoundingClientRect();
  const tr = tip.getBoundingClientRect();
  let left = r.left + r.width / 2 - tr.width / 2;
  left = Math.max(4, Math.min(left, window.innerWidth - tr.width - 4));
  let top = r.top - tr.height - 6;
  if (top < 4) top = r.bottom + 6;
  tip.style.left = `${left}px`;
  tip.style.top  = `${top}px`;
}

function hideProgressTip() {
  const tip = document.getElementById('progress-tip');
  if (tip) tip.style.display = 'none';
}

// ── Milestones ─────────────────────────────────────────────────────────────
function fmtMilestoneTotals(m, gcc) {
  // Compact "1h 30m · 1,200 chars · 800/h · 33%" summary for the row meta line.
  const parts = [];
  if (m.total_secs > 0) parts.push(fmtTime(m.total_secs));
  if (m.total_chars > 0) parts.push(`${fmtChars(m.total_chars)} chars`);
  if (m.total_secs > 60 && m.total_chars > 0) {
    const speed = Math.round(m.total_chars / (m.total_secs / 3600));
    if (speed > 0) parts.push(`${fmtChars(speed)}/h`);
  }
  // When a completion progress bar exists (GSM titles with a known game length),
  // append the share of that bar this milestone spans — same start_chars→end_chars
  // range that draws its tinted section on the bar.
  if (gcc > 0 && m.start_chars != null && m.end_chars != null) {
    const span = Math.max(0, (m.end_chars - m.start_chars) / gcc * 100);
    if (span > 0) parts.push(`${fmtPct(span)}%`);
  }
  return parts.join(' · ') || '—';
}

function fmtMediaMemberMeta(d) {
  // Same time · chars · speed line used for series-member rows.
  const parts = [];
  if (d.total_secs > 0) parts.push(fmtTime(d.total_secs));
  if (d.total_chars > 0) parts.push(`${fmtChars(d.total_chars)} chars`);
  if (d.total_secs > 60 && d.total_chars > 0) {
    const speed = Math.round(d.total_chars / (d.total_secs / 3600));
    if (speed > 0) parts.push(`${fmtChars(speed)}/h`);
  }
  return parts.join(' · ');
}

function renderMilestonesList(el, milestones, gcc) {
  el.innerHTML = '';
  // Fill a 2-column grid row-major (across then down): 1 2 / 3 4. Always 2
  // columns, even for a single milestone — a lone milestone sits in a half
  // column so its size matches the two-up layout and never reflows when a
  // second one is added.
  el.style.gridTemplateColumns = `repeat(2, minmax(0, 1fr))`;
  el.style.gridTemplateRows    = '';
  milestones.forEach((m, idx) => {
    const row = document.createElement('div');
    row.className = 'milestone-row';
    row.draggable = true;
    row.dataset.milestoneId = m.id;

    row.innerHTML = `
      <span class="milestone-index">${idx + 1}</span>
      <span class="milestone-swatch" style="background:${m.color || '#6E92E0'}"></span>
      <div class="milestone-main">
        <span class="milestone-name">${escHtml(m.name)}</span>
        <span class="milestone-meta">${escHtml(fmtMilestoneTotals(m, gcc))}</span>
      </div>
      <button class="btn btn-xs btn-danger" title="Delete milestone">✕</button>
    `;

    row.addEventListener('click', e => {
      if (e.target.closest('.btn-danger')) return;
      openMilestoneDetail(m.id);
    });
    row.querySelector('.btn-danger').addEventListener('click', async e => {
      e.stopPropagation();
      const ok = await showConfirm(`Delete milestone "${m.name}"?`);
      if (!ok) return;
      const r = await window.pywebview.api.delete_milestone(m.id);
      if (r.ok) await refreshCurrentMediaDetail();
    });

    // Drag-reorder
    row.addEventListener('dragstart', e => {
      _milestoneDragId = m.id;
      row.classList.add('dragging');
      e.dataTransfer.effectAllowed = 'move';
    });
    row.addEventListener('dragend', () => {
      _milestoneDragId = null;
      row.classList.remove('dragging');
      document.querySelectorAll('.milestone-row.drag-over')
              .forEach(r => r.classList.remove('drag-over'));
    });
    row.addEventListener('dragover', e => {
      if (_milestoneDragId == null || _milestoneDragId === m.id) return;
      e.preventDefault();
      row.classList.add('drag-over');
    });
    row.addEventListener('dragleave', () => row.classList.remove('drag-over'));
    row.addEventListener('drop', async e => {
      e.preventDefault();
      row.classList.remove('drag-over');
      if (_milestoneDragId == null || _milestoneDragId === m.id) return;
      const ids = currentMilestones.map(x => x.id).filter(id => id !== _milestoneDragId);
      const idx = ids.indexOf(m.id);
      ids.splice(idx, 0, _milestoneDragId);
      const r = await window.pywebview.api.reorder_milestones(currentDetailTitle, ids);
      if (r.ok) await refreshCurrentMediaDetail();
      else alert(r.error || 'Reorder failed');
    });

    el.appendChild(row);
  });
}

async function onCompleteMediaToggle(d, complete) {
  if (complete) {
    const disp = d.display_title || d.title;
    const ok = await showConfirm(
      `Mark this ${mediaNoun(d)} ("${disp}") as complete? The progress bar will fill to 100% and milestone percentages will be recalculated against the chars you actually read.`,
      'Complete', CT.success
    );
    if (!ok) return;
  }
  const r = await window.pywebview.api.set_media_complete(d.title, complete);
  if (!r || !r.ok) { alert((r && r.error) || 'Failed to update completion'); return; }
  // Keep the cached grid data (and its ✓ badge) in sync without a full reload.
  if (Array.isArray(mediaAllData)) {
    const m = mediaAllData.find(x => x.title === d.title);
    if (m) m.completed = complete;
    renderMediaGrid();
  }
  await refreshCurrentMediaDetail();
}

// ── Media length (custom progress bar) modal ────────────────────────────────
// Lets the user punch in a total character count for media GSM has no length
// for, creating the same completion bar games get. Saving 0 (the Remove-bar
// button) clears it.
let _mediaLengthTitle = null;

function openMediaLengthModal(d) {
  _mediaLengthTitle = d.title;
  const editing = d.user_char_count > 0;
  document.getElementById('media-length-title').textContent =
    editing ? 'Edit progress bar' : 'Add progress bar';
  document.getElementById('media-length-sub').textContent =
    `Total character count of this ${mediaNoun(d)}. Progress = chars you've read ÷ this total.`;
  const input = document.getElementById('media-length-input');
  input.value = editing ? d.user_char_count : '';
  document.getElementById('media-length-remove-btn').style.display = editing ? 'inline-flex' : 'none';
  document.getElementById('media-length-error').style.display = 'none';
  document.getElementById('media-length-overlay').style.display = 'flex';
  input.focus();
}

function closeMediaLengthModal() {
  document.getElementById('media-length-overlay').style.display = 'none';
  _mediaLengthTitle = null;
}

async function submitMediaLength(forceValue) {
  if (_mediaLengthTitle == null) return;
  const err = document.getElementById('media-length-error');
  const n = forceValue !== undefined
    ? forceValue
    : Math.round(Number(document.getElementById('media-length-input').value));
  if (forceValue === undefined && (!Number.isFinite(n) || n <= 0)) {
    err.textContent = 'Enter a total character count above zero.';
    err.style.display = 'block';
    return;
  }
  const r = await window.pywebview.api.set_media_char_count(_mediaLengthTitle, n);
  if (!r || !r.ok) {
    err.textContent = (r && r.error) || 'Failed to save';
    err.style.display = 'block';
    return;
  }
  closeMediaLengthModal();
  await refreshCurrentMediaDetail();
}

let _pendingDetail = null;

async function refreshCurrentMediaDetail() {
  if (!currentDetailTitle) return;
  const detail = await window.pywebview.api.get_title_detail(currentDetailTitle);
  if (!detail) return;
  const detailVisible =
    document.getElementById('media-detail-view').style.display !== 'none';
  if (detailVisible) {
    _pendingDetail = null;
    renderMediaDetail(detail);
  } else {
    // Rendering Chart.js into a hidden container makes the canvases grow
    // unbounded (responsive + maintainAspectRatio:false can't measure a
    // display:none parent). Stash the data and re-render on the way back.
    currentMilestones = detail.milestones || [];
    _pendingDetail = detail;
  }
}

// ── Milestone add/edit modal ───────────────────────────────────────────────
// Mirror of db.py MILESTONE_PALETTE — used to pre-fill the add modal with the
// next distinct default color (backend re-derives/validates on save). Every
// entry is also a member of MILESTONE_SWATCHES so the default highlights a
// real swatch.
const MILESTONE_PALETTE = [
  '#6E92E0', '#5FB98C', '#E0935A', '#B07FD6',
  '#DB82A6', '#4FB3B0', '#DAD06A', '#8487D6',
];

// Full set of pickable colors, hue-ordered so the strip reads as one spectrum
// bar. Clear, recognizable hues at moderate saturation — the only colors a user
// can choose, so picks stay vivid-but-not-scorching by construction.
const MILESTONE_SWATCHES = [
  '#D96B6B', '#E0935A', '#E0B45F', '#DAD06A', '#A9CC6B', '#5FB98C',
  '#4FB3B0', '#5AA6CF', '#6E92E0', '#8487D6', '#B07FD6', '#DB82A6', '#A9A6B0',
];
let _selectedMilestoneColor = MILESTONE_SWATCHES[0];

// Build the swatch strip into the modal, marking `selectedHex` active. If the
// stored color isn't a standard swatch (legacy/custom), it's prepended so it
// still shows as selected and isn't silently lost.
function renderMilestoneColorStrip(selectedHex) {
  const strip = document.getElementById('milestone-color-strip');
  if (!strip) return;
  _selectedMilestoneColor = selectedHex || MILESTONE_SWATCHES[0];
  const sel = _selectedMilestoneColor.toUpperCase();
  const colors = MILESTONE_SWATCHES.slice();
  if (!colors.some(c => c.toUpperCase() === sel)) colors.unshift(_selectedMilestoneColor);
  strip.innerHTML = '';
  colors.forEach(c => {
    const sw = document.createElement('button');
    sw.type = 'button';
    sw.className = 'color-swatch' + (c.toUpperCase() === sel ? ' selected' : '');
    sw.style.background = c;
    sw.title = c;
    sw.addEventListener('click', () => {
      _selectedMilestoneColor = c;
      strip.querySelectorAll('.color-swatch').forEach(s => s.classList.remove('selected'));
      sw.classList.add('selected');
    });
    strip.appendChild(sw);
  });
}

function openAddMilestoneModal() {
  if (!currentDetailTitle) return;
  _milestoneEditingId = null;
  document.getElementById('milestone-modal-title').textContent = 'Add milestone';
  document.getElementById('milestone-input-name').value  = '';
  document.getElementById('milestone-input-unit').value  = 'hours';
  document.getElementById('milestone-input-start').value = '';
  document.getElementById('milestone-input-end').value   = '';
  renderMilestoneColorStrip(MILESTONE_PALETTE[currentMilestones.length % MILESTONE_PALETTE.length]);
  document.getElementById('milestone-error').style.display = 'none';
  updateMilestoneHintsForUnit();
  document.getElementById('milestone-overlay').style.display = 'flex';
  setTimeout(() => document.getElementById('milestone-input-name').focus(), 30);
}

function openEditMilestoneModal() {
  if (currentMilestoneId == null) return;
  const m = currentMilestones.find(x => x.id === currentMilestoneId);
  if (!m) return;
  _milestoneEditingId = m.id;
  document.getElementById('milestone-modal-title').textContent = 'Edit milestone';
  document.getElementById('milestone-input-name').value  = m.name;
  document.getElementById('milestone-input-unit').value  = m.unit;
  document.getElementById('milestone-input-start').value = m.start_val == null ? '' : m.start_val;
  document.getElementById('milestone-input-end').value   = m.end_val   == null ? '' : m.end_val;
  renderMilestoneColorStrip(m.color || MILESTONE_PALETTE[0]);
  document.getElementById('milestone-error').style.display = 'none';
  updateMilestoneHintsForUnit();
  document.getElementById('milestone-overlay').style.display = 'flex';
}

function updateMilestoneHintsForUnit() {
  const unit = document.getElementById('milestone-input-unit').value;
  const label = unit === 'hours' ? 'hours (e.g. 22.7)' : 'characters (e.g. 50000)';
  document.getElementById('milestone-input-start').placeholder = 'empty';
  document.getElementById('milestone-input-end').placeholder   = 'empty';
  document.getElementById('milestone-start-hint').textContent  = `(empty = from previous milestone) — ${label}`;
  document.getElementById('milestone-end-hint').textContent    = `(empty = ongoing) — ${label}`;
}

function closeMilestoneModal() {
  document.getElementById('milestone-overlay').style.display = 'none';
}

async function saveMilestoneModal() {
  const name      = document.getElementById('milestone-input-name').value.trim();
  const unit      = document.getElementById('milestone-input-unit').value;
  const startStr  = document.getElementById('milestone-input-start').value.trim();
  const endStr    = document.getElementById('milestone-input-end').value.trim();
  const startVal  = startStr === '' ? null : parseFloat(startStr);
  const endVal    = endStr   === '' ? null : parseFloat(endStr);
  const color     = _selectedMilestoneColor;
  const errEl     = document.getElementById('milestone-error');
  errEl.style.display = 'none';

  if (!name) { errEl.textContent = 'Name required.'; errEl.style.display = 'block'; return; }
  if (startStr !== '' && !Number.isFinite(startVal)) { errEl.textContent = 'Start must be a number or empty.'; errEl.style.display = 'block'; return; }
  if (endStr   !== '' && !Number.isFinite(endVal))   { errEl.textContent = 'End must be a number or empty.';   errEl.style.display = 'block'; return; }

  const r = _milestoneEditingId == null
    ? await window.pywebview.api.add_milestone(currentDetailTitle, name, unit, startVal, endVal, color)
    : await window.pywebview.api.update_milestone(_milestoneEditingId, name, unit, startVal, endVal, color);
  if (!r.ok) {
    errEl.textContent = r.error || 'Failed to save milestone.';
    errEl.style.display = 'block';
    return;
  }
  closeMilestoneModal();
  await refreshCurrentMediaDetail();
  // If we were editing from inside a milestone view, refresh that too
  if (currentMilestoneId != null && _milestoneEditingId === currentMilestoneId) {
    openMilestoneDetail(currentMilestoneId);
  }
}

// Listen for unit changes in the modal (set up once)
document.addEventListener('DOMContentLoaded', () => {
  const unitSel = document.getElementById('milestone-input-unit');
  if (unitSel) unitSel.addEventListener('change', updateMilestoneHintsForUnit);
  initDailyBrush();
});

// ── Milestone detail view ──────────────────────────────────────────────────
async function openMilestoneDetail(milestoneId) {
  const detail = await window.pywebview.api.get_milestone_detail(milestoneId);
  if (!detail) return;
  currentMilestoneId = milestoneId;

  showMediaView('milestone');
  renderMilestoneDetail(detail);
}

function closeMilestoneDetail() {
  destroyChart('milestone');
  currentMilestoneId = null;
  // Return to parent media detail
  showMediaView(currentDetailTitle ? 'detail' : 'grid');
  if (currentDetailTitle && _pendingDetail) {
    const d = _pendingDetail;
    _pendingDetail = null;
    renderMediaDetail(d);
  }
}

function renderMilestoneDetail(d) {
  const color = acolor(d.activity_type);

  document.getElementById('milestone-breadcrumb').textContent =
    `Media  ›  ${d.parent_title}  ›  ${d.name}`;

  // Cover (parent's cover)
  const coverEl = document.getElementById('milestone-cover');
  coverEl.innerHTML = '';
  if (d.parent_image) {
    const img = document.createElement('img');
    img.src = d.parent_image;
    img.alt = d.name;
    coverEl.appendChild(img);
    coverEl.style.background = 'transparent';
    coverEl.style.border = 'none';
  } else {
    coverEl.textContent = mediaIcon(d.source, d.activity_type);
    coverEl.style.background = `${color}22`;
    coverEl.style.border = `1px solid ${color}33`;
  }

  document.getElementById('milestone-title').textContent = d.name;

  // Show "End milestone" button only for ongoing milestones
  document.getElementById('milestone-end-btn').style.display =
    (d.end_val == null) ? 'inline-flex' : 'none';

  // Stats
  const computedSpeed = d.avg_speed > 0
    ? d.avg_speed
    : (d.total_secs > 60 && d.total_chars > 0 ? d.total_chars / (d.total_secs / 3600) : 0);
  const speedDisplay = computedSpeed > 0 ? `${fmtChars(Math.round(computedSpeed))}/h` : '—';

  const last7 = (d.daily || []).slice(-7);
  const l7c = last7.reduce((s, r) => s + r.chars, 0);
  const l7s = last7.reduce((s, r) => s + r.seconds, 0);
  const l7speed = l7s > 0 && l7c > 0 ? Math.round(l7c / (l7s / 3600)) : 0;
  const l7display = l7speed > 0 ? `${fmtChars(l7speed)}/h` : '—';

  const grid = document.getElementById('milestone-stats-grid');
  grid.style.gridTemplateColumns = 'repeat(4,1fr)';
  grid.innerHTML = `
    <div class="stat-card">
      <div class="label">Total time</div>
      <div class="value" style="color:var(--accent);font-size:22px">${fmtTime(d.total_secs)}</div>
    </div>
    <div class="stat-card">
      <div class="label">Characters</div>
      <div class="value" style="color:var(--success);font-size:22px">${d.total_chars > 0 ? fmtChars(d.total_chars) : '—'}</div>
    </div>
    <div class="stat-card">
      <div class="label">Avg read speed</div>
      <div class="value" style="color:var(--warn);font-size:22px">${speedDisplay}</div>
    </div>
    <div class="stat-card">
      <div class="label">Speed last 7d</div>
      <div class="value" style="color:var(--purple);font-size:22px">${l7display}</div>
    </div>
  `;

  renderMilestoneCharts(d.daily || []);
  document.getElementById('milestone-session-count').textContent = `(${d.session_count})`;
  setDetailSessions('milestone', d.daily || []);
}

function renderMilestoneCharts(daily) {
  detailChartCfg.milestone = {
    key: 'milestone', canvasId: 'chart-milestone-main', segId: 'milestone-metric-seg',
    viewSegId: 'milestone-view-seg',
    splitLabelId: null,
    daily: daily || [],
    weeklyOver: null,
    splitOn: false,          // a milestone is already one slice; nothing to split by
    splitSource: null,
    splitMembers: null,
    stackName: null,
  };
  renderDetailMetricChart('milestone');
}

async function endCurrentMilestone() {
  if (currentMilestoneId == null) return;
  const m = currentMilestones.find(x => x.id === currentMilestoneId);
  const label = m ? m.name : 'this milestone';
  const ok = await showConfirm(`End milestone "${label}" at the current point?`, 'End', CT.accent);
  if (!ok) return;
  const r = await window.pywebview.api.end_milestone(currentMilestoneId);
  if (!r.ok) { alert(r.error || 'Failed to end milestone'); return; }
  // Refresh parent list so currentMilestones reflects the new end_val, then re-open detail
  await refreshCurrentMediaDetail();
  openMilestoneDetail(currentMilestoneId);
}

async function deleteCurrentMilestone() {
  if (currentMilestoneId == null) return;
  const m = currentMilestones.find(x => x.id === currentMilestoneId);
  const label = m ? m.name : 'this milestone';
  const ok = await showConfirm(`Delete milestone "${label}"?`);
  if (!ok) return;
  const r = await window.pywebview.api.delete_milestone(currentMilestoneId);
  if (r.ok) {
    closeMilestoneDetail();
    await refreshCurrentMediaDetail();
  }
}

// ── Media stat portal ───────────────────────────────────────────────────────
// Compares selected titles side by side. All derived series (rolling speed,
// cumulative totals, normalized curves, speed-gain) are computed here from each
// title's raw daily chars/seconds — the payload deliberately omits per-day speed
// so every chars/hour value is chars/(secs/3600), never sessions.reading_speed.
// Charts only ever render while #media-portal-view is visible (hidden-canvas
// gotcha), and are destroyed on the way out via destroyPortalCharts().
const PORTAL_CHART_IDS = ['portal-speed','portal-norm','portal-cum-chars','portal-cum-time','portal-gain','portal-scatter'];
function destroyPortalCharts() { PORTAL_CHART_IDS.forEach(destroyChart); }

// ── Drag-to-zoom ────────────────────────────────────────────────────────────
// Drag across a chart to restrict its x-domain; double-click to reset. Works on
// both axis kinds the portal uses: a category scale yields an index from
// getValueForPixel (snapped to whole buckets), a linear scale yields the value.
// Zoom lives on the chart instance, so re-rendering (any toggle) clears it.
const PORTAL_ZOOMABLE = ['portal-speed','portal-norm','portal-cum-chars','portal-cum-time'];

function portalResetZoom() {
  PORTAL_ZOOMABLE.forEach(key => {
    const c = charts[key];
    if (!c) return;
    delete c.options.scales.x.min;
    delete c.options.scales.x.max;
    c.update();
  });
}

function portalAttachZoom(chartKey, canvasId) {
  const canvas = document.getElementById(canvasId);
  const chart  = charts[chartKey];
  if (!canvas || !chart) return;
  const wrap = canvas.parentElement;
  let sel = wrap.querySelector('.portal-zoom-sel');
  if (!sel) { sel = document.createElement('div'); sel.className = 'portal-zoom-sel'; wrap.appendChild(sel); }

  let startX = null;
  const clamp = px => Math.max(chart.chartArea.left, Math.min(px, chart.chartArea.right));
  const posX  = e => clamp(e.clientX - canvas.getBoundingClientRect().left);

  canvas.onpointerdown = e => {
    if (!chart.chartArea) return;
    startX = posX(e);
    Object.assign(sel.style, {
      display: 'block',
      left:   (canvas.offsetLeft + startX) + 'px',
      width:  '0px',
      top:    (canvas.offsetTop + chart.chartArea.top) + 'px',
      height: (chart.chartArea.bottom - chart.chartArea.top) + 'px',
    });
    canvas.setPointerCapture(e.pointerId);
  };
  canvas.onpointermove = e => {
    if (startX == null) return;
    const x = posX(e);
    sel.style.left  = (canvas.offsetLeft + Math.min(startX, x)) + 'px';
    sel.style.width = Math.abs(x - startX) + 'px';
  };
  canvas.onpointerup = e => {
    if (startX == null) return;
    const a = Math.min(startX, posX(e)), b = Math.max(startX, posX(e));
    sel.style.display = 'none';
    startX = null;
    if (b - a < 8) return;                       // a click, not a drag
    const scale = chart.scales.x;
    let v1 = scale.getValueForPixel(a), v2 = scale.getValueForPixel(b);
    if (v1 == null || v2 == null || !isFinite(v1) || !isFinite(v2)) return;
    if (scale.type === 'category') {             // snap to whole buckets
      v1 = Math.floor(v1); v2 = Math.ceil(v2);
      if (v2 - v1 < 1) return;
    }
    chart.options.scales.x.min = v1;
    chart.options.scales.x.max = v2;
    chart.update();
  };
  canvas.ondblclick = () => {
    delete chart.options.scales.x.min;
    delete chart.options.scales.x.max;
    chart.update();
  };
}

async function openStatPortal() {
  showMediaView('portal');                        // visibility FIRST
  // Always pull fresh media/series and drop the per-title compare cache so the
  // portal reflects reading done since it was last opened. It used to reuse
  // whatever landed in portalDataCache on first open (and only fetched media
  // when empty), so it appeared frozen in time until the app restarted.
  [mediaAllData, seriesData] = await Promise.all([
    window.pywebview.api.get_media(), window.pywebview.api.get_series(),
  ]);
  seriesData = seriesData || [];
  portalDataCache = {};
  const entries = portalEntries();
  if (!portalSelected.size) {                      // first open: preselect top 5 by time
    entries.slice(0, 5).forEach(e => { portalSelected.add(e.key); portalColorFor(e.key); });
  }
  renderPortalPicker();
  await portalFetchAndRender();
}

function closeStatPortal() { destroyPortalCharts(); closePortalAdd(); showMediaView('grid'); }

// Selectable entries, keyed 's:<id>' (a whole series) or 't:<title>'. A series is
// one long media item — its member titles collapse into a single entry — unless
// "Split series" is on. Mirrors renderMediaGrid: manual-only titles hidden,
// series members never also appear standalone. Sorted by total time desc.
function portalSplitSeries() {
  const el = document.getElementById('portal-split-toggle');
  return !!(el && el.checked);
}

function portalEntries() {
  const titles = mediaAllData.filter(m => !isGridHidden(m));
  const out = [];
  if (portalSplitSeries()) {
    titles.forEach(m => out.push({
      key: 't:' + m.title, isSeries: false, titles: [m.title],
      display_title: m.display_title, total_secs: m.total_secs,
    }));
  } else {
    // A series' time is summed from its members' get_media totals, NOT from
    // get_series_data's raw SUM(time_seconds) — only the former carries the
    // manual time overlay, so this keeps series chips consistent with title chips.
    const secsByTitle = new Map(mediaAllData.map(m => [m.title, m.total_secs || 0]));
    const inSeries = new Set(seriesData.flatMap(s => s.members.map(m => m.title)));
    seriesData.forEach(s => {
      const members = s.members.map(m => m.title);
      out.push({
        key: 's:' + s.id, isSeries: true, titles: members, display_title: s.name,
        total_secs: members.reduce((acc, t) => acc + (secsByTitle.get(t) || 0), 0),
      });
    });
    titles.filter(m => !inSeries.has(m.title)).forEach(m => out.push({
      key: 't:' + m.title, isSeries: false, titles: [m.title],
      display_title: m.display_title, total_secs: m.total_secs,
    }));
  }
  return out.sort((a, b) => (b.total_secs || 0) - (a.total_secs || 0));
}

function portalEntryMap() { return new Map(portalEntries().map(e => [e.key, e])); }

// Stable string -> palette index (djb2). Deterministic across sessions, so a
// title's color doesn't depend on when the app was opened.
function paletteIndex(str, n) {
  let h = 5381;
  for (let i = 0; i < str.length; i++) h = ((h << 5) + h + str.charCodeAt(i)) >>> 0;
  return h % n;
}

// A title's color is derived from its own name, so it's the same every time it's
// selected and doesn't shift with selection order. Collisions still have to be
// broken, though — telling two lines apart is the whole point of this view — so
// if another selected title already holds the preferred color we walk forward
// from it. The portal caps at 8 selections against a 10-color palette, so a
// distinct color is always available.
function portalColorFor(key) {
  if (portalColorMap[key]) return portalColorMap[key];
  const taken = new Set([...portalSelected].filter(k => k !== key).map(k => portalColorMap[k]));
  const start = paletteIndex(key, PORTAL_PALETTE.length);
  let color = PORTAL_PALETTE[start];
  for (let i = 0; i < PORTAL_PALETTE.length; i++) {
    const c = PORTAL_PALETTE[(start + i) % PORTAL_PALETTE.length];
    if (!taken.has(c)) { color = c; break; }
  }
  portalColorMap[key] = color;
  return color;
}

// The picker shows ONLY selected entries as chips plus an "+ Add" button, so its
// height stays constant no matter how large the library grows. Everything else
// lives behind the searchable add-panel.
function renderPortalPicker() {
  const box = document.getElementById('portal-picker');
  const byKey = portalEntryMap();
  const atCap = portalSelected.size >= PORTAL_MAX;
  box.innerHTML = '';
  [...portalSelected].forEach(key => {
    const e = byKey.get(key);
    if (!e) return;
    const color = portalColorMap[key] || '#6B6B8A';
    const chip = document.createElement('div');
    chip.className = 'portal-chip';
    chip.style.color = color;
    chip.innerHTML = `<span class="dot" style="background:${color}"></span>`
      + `<span>${escHtml(e.display_title)}</span>`
      + (e.isSeries ? `<span class="chip-badge">SERIES</span>` : '')
      + `<span style="opacity:.6">${fmtTime(e.total_secs)}</span>`
      + `<span class="chip-x" title="Remove">✕</span>`;
    chip.querySelector('.chip-x').onclick = () => onPortalRemove(key);
    box.appendChild(chip);
  });
  const add = document.createElement('button');
  add.className = 'portal-add-btn';
  add.textContent = atCap ? `+ Add title (${PORTAL_MAX} max)` : '+ Add title';
  add.disabled = atCap;
  add.onclick = e => { e.stopPropagation(); togglePortalAdd(); };
  box.appendChild(add);
  document.getElementById('portal-sel-count').textContent =
    `${portalSelected.size}/${PORTAL_MAX} selected`;
}

function togglePortalAdd() {
  const panel = document.getElementById('portal-add-panel');
  const open = panel.style.display !== 'none';
  if (open) { closePortalAdd(); return; }
  panel.style.display = 'block';
  const search = document.getElementById('portal-search');
  search.value = '';
  renderPortalAddList();
  search.focus();
  setTimeout(() => document.addEventListener('click', portalAddOutside), 0);
}

function closePortalAdd() {
  const panel = document.getElementById('portal-add-panel');
  if (panel) panel.style.display = 'none';
  document.removeEventListener('click', portalAddOutside);
}

function portalAddOutside(e) {
  if (!e.target.closest('.portal-picker-wrap')) closePortalAdd();
}

function renderPortalAddList() {
  const q = (document.getElementById('portal-search').value || '').toLowerCase().trim();
  const list = document.getElementById('portal-add-list');
  const rows = portalEntries().filter(e =>
    !portalSelected.has(e.key) && (!q || e.display_title.toLowerCase().includes(q)));
  list.innerHTML = '';
  if (!rows.length) {
    list.innerHTML = '<div class="portal-add-empty">No matching titles.</div>';
    return;
  }
  rows.forEach(e => {
    const row = document.createElement('div');
    row.className = 'portal-add-row';
    row.innerHTML = `<span>${escHtml(e.display_title)}</span>`
      + (e.isSeries ? `<span class="chip-badge">SERIES</span>` : '')
      + `<span class="sub">${fmtTime(e.total_secs)}</span>`;
    row.onclick = () => onPortalAdd(e.key);
    list.appendChild(row);
  });
}

async function onPortalAdd(key) {
  if (portalSelected.size >= PORTAL_MAX || portalSelected.has(key)) return;
  portalSelected.add(key);
  portalColorFor(key);
  closePortalAdd();
  renderPortalPicker();
  await portalFetchAndRender();
}

async function onPortalRemove(key) {
  portalSelected.delete(key);
  delete portalColorMap[key];                     // free the color for reuse
  renderPortalPicker();
  await portalFetchAndRender();
}

// Toggling split remaps the selection between series keys and member-title keys
// so the user's picks survive the switch (capped, dedup'd).
async function onPortalSplit() {
  const split = portalSplitSeries();
  const memberOf = new Map();                     // title -> series id
  seriesData.forEach(s => s.members.forEach(m => memberOf.set(m.title, s.id)));
  const next = [];
  [...portalSelected].forEach(key => {
    if (split && key.startsWith('s:')) {
      const s = seriesData.find(x => String(x.id) === key.slice(2));
      if (s) s.members.forEach(m => next.push('t:' + m.title));
    } else if (!split && key.startsWith('t:')) {
      const sid = memberOf.get(key.slice(2));
      next.push(sid != null ? 's:' + sid : key);
    } else {
      next.push(key);
    }
  });
  portalSelected = new Set(next.slice(0, PORTAL_MAX));
  portalColorMap = {};
  [...portalSelected].forEach(portalColorFor);
  renderPortalPicker();
  await portalFetchAndRender();
}

// Sum member titles into one synthetic entry. Totals are summed and avg_speed is
// re-derived from them (chars ÷ time) — never averaged from the parts' speeds.
function portalMergeEntry(key, name, parts) {
  const map = new Map();
  parts.forEach(p => p.daily.forEach(x => {
    const cur = map.get(x.date) || { chars: 0, seconds: 0 };
    cur.chars += x.chars; cur.seconds += x.seconds;
    map.set(x.date, cur);
  }));
  const daily = [...map.keys()].sort().map(date => ({ date, ...map.get(date) }));
  const total_chars = parts.reduce((s, p) => s + p.total_chars, 0);
  const total_secs  = parts.reduce((s, p) => s + p.total_secs, 0);
  return {
    key, title: key, display_title: name,
    source: parts[0].source, activity_type: parts[0].activity_type,
    total_chars, total_secs,
    avg_speed: (total_secs > 0 && total_chars > 0) ? total_chars / (total_secs / 3600) : 0,
    session_count: parts.reduce((s, p) => s + p.session_count, 0),
    days_count: daily.length,                     // distinct days across the series
    first_date: daily.length ? daily[0].date : null,
    last_date:  daily.length ? daily[daily.length - 1].date : null,
    daily,
  };
}

async function portalFetchAndRender() {
  const byKey = portalEntryMap();
  const missing = [...portalSelected].filter(k => !(k in portalDataCache) && byKey.has(k));
  if (missing.length) {
    const need = [...new Set(missing.flatMap(k => byKey.get(k).titles))];
    const rows = await window.pywebview.api.get_compare_data(need);
    const byTitle = new Map(rows.map(r => [r.title, r]));
    missing.forEach(k => {
      const e = byKey.get(k);
      const parts = e.titles.map(t => byTitle.get(t)).filter(Boolean);
      if (!parts.length) return;
      portalDataCache[k] = (parts.length === 1 && !e.isSeries)
        ? Object.assign({}, parts[0], { key: k })
        : portalMergeEntry(k, e.display_title, parts);
    });
  }
  renderPortal();
}

// ── Derived-series helpers (all chars/(secs/3600)) ──────────────────────────
function portalUnionDates(sel) {
  const set = new Set();
  sel.forEach(d => d.daily.forEach(x => set.add(x.date)));
  return [...set].sort();
}

// Map a title's daily rows onto the shared union axis, filling missing days.
function portalAlignedRolling(d, dates) {
  const byDate = new Map(d.daily.map(x => [x.date, x]));
  const chars = d.daily.map(x => x.chars);
  const secs  = d.daily.map(x => x.seconds);
  const roll  = twRolling(chars, secs, 7);         // aligned to d.daily order
  const rollByDate = new Map(d.daily.map((x, i) => [x.date, roll[i]]));
  return dates.map(dt => {
    if (!byDate.has(dt)) return null;
    return rollByDate.get(dt);
  });
}

function portalAlignedRaw(d, dates) {
  const byDate = new Map(d.daily.map(x => [x.date, x]));
  return dates.map(dt => {
    const x = byDate.get(dt);
    if (!x) return null;
    return (x.seconds > 0 && x.chars > 0) ? x.chars / (x.seconds / 3600) : null;
  });
}

// Cumulative running total on the union axis, carried forward on idle days,
// null before the title's first read date so each line starts where it began.
function portalCumulative(d, dates, field) {
  const byDate = new Map(d.daily.map(x => [x.date, x]));
  const first = d.daily.length ? d.daily[0].date : null;
  let run = 0;
  return dates.map(dt => {
    if (first == null || dt < first) return null;
    const x = byDate.get(dt);
    if (x) run += (field === 'chars' ? x.chars : x.seconds / 3600);
    return run;
  });
}

// {x,y} points: x = cumulative hours into the title (or nth reading day),
// y = 7d-rolling speed. Unequal per-title spacing → linear axis, not category.
function portalNormPoints(d, byDay) {
  const chars = d.daily.map(x => x.chars);
  const secs  = d.daily.map(x => x.seconds);
  const roll  = twRolling(chars, secs, 7);
  let cumHours = 0;
  const pts = [];
  d.daily.forEach((x, i) => {
    cumHours += x.seconds / 3600;
    if (roll[i] != null) pts.push({ x: byDay ? i + 1 : cumHours, y: roll[i] });
  });
  return pts;
}

// ── "Align to a common start" mode ──────────────────────────────────────────
// When on, the calendar charts (speed overlay + both cumulative races) re-plot
// against days-since-each-title's-own-first-read-day, so every line begins at
// x=0. Real pacing (gaps) is preserved; only the origin shifts.
function portalIsAligned() {
  const el = document.getElementById('portal-align-toggle');
  return !!(el && el.checked);
}

function portalDayOffset(firstDate, dateStr) {
  return Math.round((new Date(dateStr) - firstDate) / 86400000);
}

// Speed as {x: days since start, y: speed} — rolling or raw per the sub-toggle.
function portalSpeedPoints(d, rolling) {
  if (!d.daily.length) return [];
  const first = new Date(d.daily[0].date);
  const chars = d.daily.map(x => x.chars);
  const secs  = d.daily.map(x => x.seconds);
  const roll  = rolling ? twRolling(chars, secs, 7) : null;
  const pts = [];
  d.daily.forEach((x, i) => {
    const y = rolling ? roll[i]
                      : (x.seconds > 0 && x.chars > 0 ? x.chars / (x.seconds / 3600) : null);
    if (y != null) pts.push({ x: portalDayOffset(first, x.date), y });
  });
  return pts;
}

// Cumulative total as {x: days since start, y: running total}.
function portalCumPoints(d, field) {
  if (!d.daily.length) return [];
  const first = new Date(d.daily[0].date);
  let run = 0;
  return d.daily.map(x => {
    run += field === 'chars' ? x.chars : x.seconds / 3600;
    return { x: portalDayOffset(first, x.date), y: run };
  });
}

// First vs last 20% of the title's chars. Chars, not time: the first fifth of
// the material vs the last fifth is symmetric in content. Guarded for small
// samples. Whole-day granularity (bucket includes the boundary day).
function portalSpeedGain(d) {
  if (d.days_count < 10 || d.total_chars < 20000) return null;
  const target = d.total_chars * 0.2;
  let c = 0, s = 0, i = 0;
  for (; i < d.daily.length && c < target; i++) { c += d.daily[i].chars; s += d.daily[i].seconds; }
  const early = s > 0 ? c / (s / 3600) : null;
  c = 0; s = 0;
  for (let j = d.daily.length - 1; j >= i && c < target; j--) { c += d.daily[j].chars; s += d.daily[j].seconds; }
  const late = s > 0 ? c / (s / 3600) : null;
  if (early == null || late == null || early <= 0) return null;
  return { early, late, pct: (late - early) / early * 100 };
}

// ── Shared chart config ─────────────────────────────────────────────────────
function portalLineDataset(d, data, extra) {
  const color = portalColorMap[d.key] || '#6B6B8A';
  return Object.assign({
    label: d.display_title,
    data,
    borderColor: color,
    backgroundColor: color,
    pointBackgroundColor: color,
    pointBorderColor: CT.card,
    pointBorderWidth: 1,
    borderWidth: 2,
    tension: 0.3,
    fill: false,
  }, extra || {});
}

function portalDateScale(yTickCb) {
  return {
    x: { grid: { color: CT.grid }, ticks: { color: CT.dim, autoSkip: true, maxTicksLimit: 14, maxRotation: 0 } },
    y: { grid: { color: CT.grid }, ticks: { color: CT.dim, callback: yTickCb }, beginAtZero: false },
  };
}

// Linear "days since start" x-axis, used by the calendar charts in aligned mode.
function portalDayScale(yTickCb) {
  return {
    x: { type: 'linear', grid: { color: CT.grid }, ticks: { color: CT.dim, maxRotation: 0, callback: (v, _i, ts) => fmtTick(v, ts, 'd') }, title: { display: true, text: 'Days since start', color: CT.dim }, beginAtZero: true },
    y: { grid: { color: CT.grid }, ticks: { color: CT.dim, callback: yTickCb }, beginAtZero: false },
  };
}

const PORTAL_LEGEND = { display: true, position: 'bottom', labels: { color: CT.dim, usePointStyle: true, boxWidth: 8, padding: 12 } };

function renderPortal() {
  destroyPortalCharts();
  const sel = [...portalSelected].map(t => portalDataCache[t]).filter(Boolean);
  const empty = document.getElementById('portal-empty');
  const content = document.getElementById('portal-content');
  if (!sel.length) {
    empty.style.display = 'block';
    content.style.display = 'none';
    return;
  }
  empty.style.display = 'none';
  content.style.display = 'block';

  const dates = portalUnionDates(sel);
  const withChars = sel.filter(d => d.total_chars > 0);

  renderPortalTable(sel);
  renderPortalSpeed(withChars, dates);
  renderPortalNorm(withChars);
  renderPortalCum(sel, dates, 'chars', 'chart-portal-cum-chars', 'portal-cum-chars', v => fmtChars(v));
  renderPortalCum(sel, dates, 'hours', 'chart-portal-cum-time', 'portal-cum-time', v => v.toFixed(0) + 'h');
  renderPortalGain(withChars);
  renderPortalScatter(withChars);
}

function renderPortalTable(sel) {
  const dash = '—';
  const rows = sel.map(d => {
    const color = portalColorMap[d.key] || '#6B6B8A';
    const speed = d.total_chars > 0 && d.total_secs > 0 ? fmtChars(Math.round(d.avg_speed)) + '/h' : dash;
    const cpd = d.total_chars > 0 && d.days_count ? fmtChars(Math.round(d.total_chars / d.days_count)) : dash;
    // Avg day, not avg session: GSM/ttsu collapse a day into one session row while
    // manual logging can write several, so per-session would not be comparable.
    const avgDay = d.days_count ? fmtTime(d.total_secs / d.days_count) : dash;
    return `<tr>
      <td><span class="dot" style="background:${color}"></span>${escHtml(d.display_title)}</td>
      <td>${fmtTime(d.total_secs)}</td>
      <td>${d.total_chars > 0 ? fmtChars(d.total_chars) : dash}</td>
      <td>${speed}</td>
      <td>${cpd}</td>
      <td>${avgDay}</td>
      <td>${d.days_count}</td>
    </tr>`;
  }).join('');
  document.getElementById('portal-table-wrap').innerHTML = `
    <table class="portal-table">
      <thead><tr>
        <th>Title</th><th>Total time</th><th>Total chars</th><th>Avg speed</th>
        <th>Chars/active day</th><th>Avg day</th><th>Active days</th>
      </tr></thead>
      <tbody>${rows}</tbody>
    </table>`;
}

function renderPortalSpeed(withChars, dates) {
  const section = document.getElementById('portal-speed-section');
  if (!withChars.length) { section.style.display = 'none'; return; }
  section.style.display = 'block';
  const rolling = document.getElementById('portal-rolling-toggle').checked;
  const aligned = portalIsAligned();
  const datasets = withChars.map(d => portalLineDataset(
    d,
    aligned ? portalSpeedPoints(d, rolling)
            : (rolling ? portalAlignedRolling(d, dates) : portalAlignedRaw(d, dates)),
    { spanGaps: rolling, pointRadius: rolling ? 0 : 2, pointHoverRadius: 5 }
  ));
  charts['portal-speed'] = new Chart(document.getElementById('chart-portal-speed').getContext('2d'), {
    type: 'line',
    data: aligned ? { datasets } : { labels: dates, datasets },
    options: {
      responsive: true, maintainAspectRatio: false, animation: false,
      interaction: { mode: aligned ? 'nearest' : 'index', intersect: false },
      plugins: {
        legend: PORTAL_LEGEND,
        tooltip: { callbacks: { label: c => c.parsed.y != null ? `${c.dataset.label}: ${fmtChars(Math.round(c.parsed.y))}/h${aligned ? ' @ day ' + c.parsed.x : ''}` : '' } },
      },
      scales: aligned ? portalDayScale(v => fmtChars(v)) : portalDateScale(v => fmtChars(v)),
    },
  });
  portalAttachZoom('portal-speed', 'chart-portal-speed');
}

function renderPortalNorm(withChars) {
  const section = document.getElementById('portal-norm-section');
  if (!withChars.length) { section.style.display = 'none'; return; }
  section.style.display = 'block';
  const byDay = document.getElementById('portal-norm-toggle').checked;
  const datasets = withChars.map(d => portalLineDataset(d, portalNormPoints(d, byDay),
    { spanGaps: true, pointRadius: 0, pointHoverRadius: 5 }));
  const unit = byDay ? 'd' : 'h';
  charts['portal-norm'] = new Chart(document.getElementById('chart-portal-norm').getContext('2d'), {
    type: 'line',
    data: { datasets },
    options: {
      responsive: true, maintainAspectRatio: false, animation: false,
      parsing: false,
      interaction: { mode: 'nearest', intersect: false },
      plugins: {
        legend: PORTAL_LEGEND,
        tooltip: { callbacks: { label: c => `${c.dataset.label}: ${fmtChars(Math.round(c.parsed.y))}/h @ ${c.parsed.x.toFixed(byDay ? 0 : 1)}${unit}` } },
      },
      scales: {
        x: { type: 'linear', grid: { color: CT.grid }, ticks: { color: CT.dim, maxRotation: 0, callback: (v, _i, ts) => fmtTick(v, ts, unit) }, title: { display: true, text: byDay ? 'Reading day' : 'Hours into title', color: CT.dim } },
        y: { grid: { color: CT.grid }, ticks: { color: CT.dim, callback: v => fmtChars(v) }, beginAtZero: false },
      },
    },
  });
  portalAttachZoom('portal-norm', 'chart-portal-norm');
}

function renderPortalCum(sel, dates, field, canvasId, chartKey, yTickCb) {
  const aligned = portalIsAligned();
  const datasets = sel
    .filter(d => field === 'hours' || d.total_chars > 0)
    .map(d => portalLineDataset(d,
      aligned ? portalCumPoints(d, field) : portalCumulative(d, dates, field),
      { spanGaps: true, pointRadius: 0, pointHoverRadius: 4 }));
  charts[chartKey] = new Chart(document.getElementById(canvasId).getContext('2d'), {
    type: 'line',
    data: aligned ? { datasets } : { labels: dates, datasets },
    options: {
      responsive: true, maintainAspectRatio: false, animation: false,
      interaction: { mode: aligned ? 'nearest' : 'index', intersect: false },
      plugins: {
        legend: PORTAL_LEGEND,
        tooltip: { callbacks: { label: c => c.parsed.y != null ? `${c.dataset.label}: ${field === 'chars' ? fmtChars(Math.round(c.parsed.y)) + ' chars' : c.parsed.y.toFixed(1) + 'h'}${aligned ? ' @ day ' + c.parsed.x : ''}` : '' } },
      },
      scales: aligned ? portalDayScale(yTickCb) : portalDateScale(yTickCb),
    },
  });
  portalAttachZoom(chartKey, canvasId);
}

function renderPortalGain(withChars) {
  const section = document.getElementById('portal-gain-section');
  const gains = withChars.map(d => ({ d, g: portalSpeedGain(d) }));
  const ok = gains.filter(x => x.g).sort((a, b) => b.g.pct - a.g.pct);
  const excluded = gains.filter(x => !x.g).map(x => x.d.display_title);
  if (!ok.length) { section.style.display = 'none'; return; }
  section.style.display = 'block';
  charts['portal-gain'] = new Chart(document.getElementById('chart-portal-gain').getContext('2d'), {
    type: 'bar',
    data: {
      labels: ok.map(x => x.d.display_title),
      datasets: [{
        data: ok.map(x => x.g.pct),
        backgroundColor: ok.map(x => portalColorMap[x.d.key] || '#6B6B8A'),
        borderRadius: 4,
      }],
    },
    options: {
      indexAxis: 'y',
      responsive: true, maintainAspectRatio: false, animation: false,
      plugins: {
        legend: { display: false },
        tooltip: { callbacks: { label: c => {
          const g = ok[c.dataIndex].g;
          return `${fmtChars(Math.round(g.early))} → ${fmtChars(Math.round(g.late))}/h  (${g.pct >= 0 ? '+' : ''}${g.pct.toFixed(0)}%)`;
        } } },
      },
      scales: {
        x: { grid: { color: CT.grid }, ticks: { color: CT.dim, callback: (v, _i, ts) => fmtTick(v, ts, '%') }, beginAtZero: true },
        y: { grid: { display: false }, ticks: { color: CT.dim } },
      },
    },
  });
  const note = document.getElementById('portal-gain-note');
  note.textContent = excluded.length ? `Not enough data: ${excluded.join(', ')}` : '';
}

function renderPortalScatter(withChars) {
  const section = document.getElementById('portal-scatter-section');
  if (!withChars.length) { section.style.display = 'none'; return; }
  section.style.display = 'block';
  const maxHours = Math.max(...withChars.map(d => d.total_secs / 3600), 1);
  const datasets = withChars.map(d => {
    const color = portalColorMap[d.key] || '#6B6B8A';
    const hours = d.total_secs / 3600;
    const r = 6 + 16 * Math.sqrt(hours / maxHours);
    return {
      label: d.display_title,
      data: [{ x: d.total_chars, y: d.avg_speed, r, _hours: hours }],
      backgroundColor: color + 'cc',
      borderColor: color,
      borderWidth: 1,
      hoverRadius: r + 2,
    };
  });
  charts['portal-scatter'] = new Chart(document.getElementById('chart-portal-scatter').getContext('2d'), {
    type: 'bubble',
    data: { datasets },
    options: {
      responsive: true, maintainAspectRatio: false, animation: false,
      plugins: {
        legend: PORTAL_LEGEND,
        tooltip: { callbacks: { label: c => {
          const p = c.raw;
          return `${c.dataset.label}: ${fmtChars(p.x)} chars, ${fmtChars(Math.round(p.y))}/h, ${fmtTime(p._hours * 3600)}`;
        } } },
      },
      scales: {
        x: { grid: { color: CT.grid }, ticks: { color: CT.dim, callback: v => fmtChars(v) }, title: { display: true, text: 'Total characters', color: CT.dim } },
        y: { grid: { color: CT.grid }, ticks: { color: CT.dim, callback: v => fmtChars(v) }, title: { display: true, text: 'Avg speed (chars/h)', color: CT.dim }, beginAtZero: false },
      },
    },
  });
}

function onPortalSpeedMode() {
  destroyChart('portal-speed');
  const sel = [...portalSelected].map(t => portalDataCache[t]).filter(Boolean);
  renderPortalSpeed(sel.filter(d => d.total_chars > 0), portalUnionDates(sel));
}

function onPortalNormMode() {
  destroyChart('portal-norm');
  const sel = [...portalSelected].map(t => portalDataCache[t]).filter(Boolean);
  renderPortalNorm(sel.filter(d => d.total_chars > 0));
}

// Re-render just the three calendar charts the align toggle affects.
function onPortalAlign() {
  const sel = [...portalSelected].map(t => portalDataCache[t]).filter(Boolean);
  const dates = portalUnionDates(sel);
  const withChars = sel.filter(d => d.total_chars > 0);
  destroyChart('portal-speed');     renderPortalSpeed(withChars, dates);
  destroyChart('portal-cum-chars'); renderPortalCum(sel, dates, 'chars', 'chart-portal-cum-chars', 'portal-cum-chars', v => fmtChars(v));
  destroyChart('portal-cum-time');  renderPortalCum(sel, dates, 'hours', 'chart-portal-cum-time', 'portal-cum-time', v => v.toFixed(0) + 'h');
}

// ── Media to-read list ──────────────────────────────────────────────────────
// Backlog of titles not started yet. Same tabs-and-rows model as the dev notes:
// every item lives in exactly one category, and there's always ≥1 category.
// The extra "All" tab (toreadActiveCat === null) is a read-only aggregate view,
// so the rename/delete category controls hide while it's active.
let toreadItems     = [];    // [{id, title, category_id, difficulty, created_at}]
let toreadCats      = [];    // [{id, name}]; always ≥1 after a load
let toreadActiveCat = null;  // numeric category id, or null for the All tab

async function openToRead() {
  showMediaView('toread');                  // visibility FIRST, like openStatPortal
  await loadToRead();
}

// ── Shelf ──────────────────────────────────────────────────────────────────
// Every title that's partway through, as one sorted list: how far in, how much
// is left, and how long that would take at the title's own recent pace. The
// per-row numbers come from get_media_shelf(), which routes through the same
// attribution-aware helpers as the detail page, so a row here and that title's
// completion bar agree.
function closeShelf() { showMediaView('grid'); }

async function openShelf() {
  showMediaView('shelf');
  const rows = await window.pywebview.api.get_media_shelf();
  renderShelf(rows || []);
}

function renderShelf(rows) {
  const el  = document.getElementById('shelf-list');
  const cnt = document.getElementById('shelf-count');
  if (cnt) cnt.textContent = rows.length ? `${rows.length} in progress` : '';
  if (!rows.length) {
    el.innerHTML = '<p class="empty-msg">Nothing in progress. A title appears here once it has a known length and some reading.</p>';
    return;
  }
  el.innerHTML = rows.map(r => {
    const color = acolor(r.activity_type);
    const eta = r.eta_hours > 0
      ? `${r.eta_hours < 1 ? '<1' : r.eta_hours.toFixed(1)}h left`
      : (r.remaining <= 0 ? 'Ready to finish' : 'No recent pace');
    const etaTitle = r.speed > 0
      ? `${fmtChars(r.remaining)} chars left at ${fmtChars(Math.round(r.speed))} chars/h (7 reading days)`
      : `${fmtChars(r.remaining)} chars left — no reading in the last 7 sessions to project from`;
    return `
      <div class="shelf-row" onclick="openMediaDetail(${JSON.stringify(r.title).replace(/"/g, '&quot;')})">
        <div>
          <div class="shelf-name">${escHtml(r.display_title || r.title)}</div>
          <div class="shelf-sub">${fmtChars(r.total_chars)} / ${fmtChars(r.length)} chars${
            r.length_source === 'gsm' ? '' : ' · your length'}</div>
        </div>
        <div>
          <div class="shelf-track"><div class="shelf-fill" style="width:${r.pct}%;background:${color}"></div></div>
          ${sparkHTML(r.spark, color)}
        </div>
        <div class="shelf-right">
          <div class="shelf-pct" style="color:${color}">${fmtPct(r.pct)}%</div>
          <div class="shelf-eta" title="${escHtml(etaTitle)}">${eta}</div>
        </div>
      </div>`;
  }).join('');
}

function closeToRead() { showMediaView('grid'); }

async function loadToRead() {
  const data = await window.pywebview.api.get_toread();
  toreadCats  = (data && data.categories) || [];
  toreadItems = (data && data.items) || [];
  // Fall back to All if the active category was deleted out from under us.
  if (toreadActiveCat !== null && !toreadCats.some(c => c.id === toreadActiveCat)) {
    toreadActiveCat = null;
  }
  renderToRead();
}

function renderToRead() {
  const list = document.getElementById('toread-list');
  const tabs = document.getElementById('toread-tabs');
  if (!list) return;

  if (tabs) {
    tabs.innerHTML =
      `<button class="seg-btn${toreadActiveCat === null ? ' active' : ''}" ` +
      `onclick="setToReadFilter(null)">All</button>` +
      toreadCats.map(c =>
        `<button class="seg-btn${toreadActiveCat === c.id ? ' active' : ''}" ` +
        `onclick="setToReadFilter(${c.id})" ondblclick="renameToReadCategory()">` +
        `${escHtml(c.name)}</button>`
      ).join('');
  }
  // Rename/delete act on the active category, so they're meaningless on All.
  // Delete also needs a spare — the last category can't go (items need a home).
  const rn = document.getElementById('toread-cat-rename');
  const dl = document.getElementById('toread-cat-delete');
  if (rn) rn.style.display = toreadActiveCat !== null ? '' : 'none';
  if (dl) dl.style.display = (toreadActiveCat !== null && toreadCats.length > 1) ? '' : 'none';

  // The add-row category defaults to the active tab, or the first category on All.
  const sel = document.getElementById('toread-cat');
  if (sel) {
    sel.innerHTML = toreadCats.map(c =>
      `<option value="${c.id}">${escHtml(c.name)}</option>`).join('');
    const want = toreadActiveCat !== null ? toreadActiveCat
               : (toreadCats.length ? toreadCats[0].id : null);
    if (want !== null) sel.value = String(want);
  }

  const shown = toreadActiveCat === null
    ? toreadItems
    : toreadItems.filter(i => i.category_id === toreadActiveCat);

  const count = document.getElementById('toread-count');
  if (count) count.textContent = shown.length ? `${shown.length} item${shown.length === 1 ? '' : 's'}` : '';

  if (!shown.length) {
    list.innerHTML = '<p class="empty-msg">Nothing on the list yet.</p>';
    return;
  }
  const catName = id => {
    const c = toreadCats.find(x => x.id === id);
    return c ? c.name : '';
  };
  list.innerHTML = shown.map(i => {
    const d = i.difficulty;
    const diff = (d === null || d === undefined)
      ? '<span class="toread-diff none" title="No difficulty set">–</span>'
      : `<span class="toread-diff" title="Difficulty ${d}/10">${d}</span>`;
    // The category label only earns its place on All, where rows are mixed.
    const cat = toreadActiveCat === null
      ? `<span class="toread-cat-label">${escHtml(catName(i.category_id))}</span>` : '';
    return `
    <div class="toread-row">
      ${diff}
      <span class="toread-title">${escHtml(i.title)}</span>
      ${cat}
      <button class="btn btn-outline btn-sm" onclick="deleteToReadItem(${i.id})" title="Remove from the list">✕</button>
    </div>`;
  }).join('');
}

function setToReadFilter(catId) {
  toreadActiveCat = catId;   // null or a numeric id; filters the cached list, no re-fetch
  renderToRead();
}

async function addToReadItem() {
  const fb    = document.getElementById('toread-feedback');
  const tEl   = document.getElementById('toread-title');
  const dEl   = document.getElementById('toread-diff');
  const title = (tEl.value || '').trim();
  const diffRaw = (dEl.value || '').trim();

  if (!title) {
    fb.className = 'feedback err'; fb.textContent = 'Enter a title.'; return;
  }
  if (diffRaw && (isNaN(diffRaw) || Number(diffRaw) < 1 || Number(diffRaw) > 10)) {
    fb.className = 'feedback err'; fb.textContent = 'Difficulty must be between 1 and 10.'; return;
  }
  const catRaw = document.getElementById('toread-cat').value;
  const r = await window.pywebview.api.add_toread_item(
    title, catRaw ? Number(catRaw) : null, diffRaw ? Number(diffRaw) : null);
  if (!r.ok) {
    fb.className = 'feedback err'; fb.textContent = r.error || 'Could not add that.'; return;
  }
  fb.className = 'feedback'; fb.textContent = '';
  tEl.value = ''; dEl.value = '';
  tEl.focus();
  await loadToRead();
}

async function deleteToReadItem(id) {
  if (!await showConfirm('Remove this from the to-read list?')) return;
  const r = await window.pywebview.api.delete_toread_item(id);
  if (r.ok) await loadToRead();
}

async function addToReadCategory() {
  const name = (prompt('New category name:') || '').trim();
  if (!name) return;
  const r = await window.pywebview.api.add_toread_category(name);
  if (r.ok) { toreadActiveCat = r.id; await loadToRead(); }   // jump to the new category
}

async function renameToReadCategory() {
  if (toreadActiveCat === null) return;
  const cur = toreadCats.find(c => c.id === toreadActiveCat);
  const name = (prompt('Rename category:', cur ? cur.name : '') || '').trim();
  if (!name) return;
  const r = await window.pywebview.api.rename_toread_category(toreadActiveCat, name);
  if (r.ok) await loadToRead();
}

async function deleteToReadCategory() {
  if (toreadActiveCat === null || toreadCats.length <= 1) return;
  const cur = toreadCats.find(c => c.id === toreadActiveCat);
  if (!await showConfirm(`Delete category “${cur ? cur.name : ''}”? Its items move to the first category.`)) return;
  const r = await window.pywebview.api.delete_toread_category(toreadActiveCat);
  if (r.ok) { toreadActiveCat = r.moved_to; await loadToRead(); }
  else setStatus(r.error || 'Could not delete category');
}

if (window.pywebview) {
  init();
} else {
  window.addEventListener('pywebviewready', init);
}
