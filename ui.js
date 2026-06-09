// ── Globals ────────────────────────────────────────────────────────────────
let currentPage        = 'dashboard';
let currentRange       = '30d';
let currentGranularity = 'day';
let statsCache    = {};
let charts        = {};
let selectedAtype = 'Listening';
let selectedCatColor = '#5B8CFF';
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
let _milestoneEditingId = null;        // null = adding, number = editing
let _milestoneDragId    = null;        // dragged milestone id for reorder

const BUILTIN_TYPES = ['Listening','Reading','Speaking','Vocabulary','Other'];
const ACOLORS = {
  Reading:'#5B8CFF', Listening:'#4ECBA0',
  Speaking:'#C78BFF', Vocabulary:'#FF7BAC', Other:'#6B6B8A'
};
const CAT_PALETTE = [
  '#5B8CFF','#4ECBA0','#FF9F5B','#C78BFF','#FF7BAC',
  '#5BE8C4','#FFD15B','#FF6B6B','#6B6B8A','#38BDF8'
];
const PALETTE = ['#5B8CFF','#4ECBA0','#FF9F5B','#C78BFF','#FF7BAC','#5BE8C4','#FFD15B','#6B6B8A'];
let HEATMAP_COLORS = ['#1E1E30','#1a3b4a','#1e6b52','#26a06e','#4ECBA0'];

Chart.defaults.color       = '#9090A8';
Chart.defaults.borderColor = '#2E2E48';
Chart.defaults.font.family = "'Segoe UI', system-ui, sans-serif";
Chart.defaults.font.size   = 11;

// ── Helpers ────────────────────────────────────────────────────────────────
function fmtTime(s) {
  if (!s || s <= 0) return '0 min';
  if (s < 3600) return `${(s / 60).toFixed(1)} min`;
  const h = Math.floor(s / 3600), m = Math.floor((s % 3600) / 60);
  return m > 0 ? `${h}h ${m}m` : `${h}h`;
}
function fmtChars(n) {
  if (n >= 1_000_000) return `${(n/1_000_000).toFixed(2)} mil`;
  if (n >= 1000)      return `${(n/1000).toFixed(1)}k`;
  return String(n);
}
function twRolling(charArr, secsArr, window) {
  return charArr.map((_, i) => {
    const start = Math.max(0, i - window + 1);
    let c = 0, s = 0;
    for (let j = start; j <= i; j++) { c += charArr[j]; s += secsArr[j]; }
    return s > 0 && c > 0 ? c / (s / 3600) : null;
  });
}

function escHtml(s) {
  return String(s ?? '').replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;');
}
function srcLabel(s) {
  return {gsm:'Game',anki:'Anki',ttu:'Book',ttsureader:'Book',manual:'Manual',csv:'Import'}[s?.toLowerCase()] || (s||'').toUpperCase();
}
function acolor(t) { return ACOLORS[t] || '#6B6B8A'; }
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
    const fb = document.getElementById('log-feedback');
    if (fb) { fb.className = ''; fb.textContent = ''; }
  }
  if (currentPage === 'settings' && page !== 'settings') {
    const setup = document.getElementById('settings-setup-view');
    const main  = document.getElementById('settings-main-view');
    if (setup) setup.style.display = 'none';
    if (main)  main.style.display  = '';
    clearSetupFeedback();
  }
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
  else if (page === 'settings')  await loadSettings();
}

// ── Dashboard ──────────────────────────────────────────────────────────────
async function loadDashboard() {
  const d = await window.pywebview.api.get_dashboard();
  document.getElementById('today-date').textContent = today();

  const todaySec = d.today.reduce((a,r) => a + r.seconds, 0);
  const todayChars = d.today.reduce((a,r) => a+r.chars, 0);
  const readingSec = d.today.filter(r => r.activity_type === 'Reading').reduce((a,r) => a + r.seconds, 0);
  const readingChars = d.today.filter(r => r.activity_type === 'Reading').reduce((a,r) => a + r.chars, 0);
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

function makeSessionRow(s) {
  const color = acolor(s.activity_type);
  const el    = document.createElement('div');
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
      <button class="btn btn-xs btn-danger" style="margin-top:4px" onclick="doDeleteSession(${s.id}, this)">✕</button>
    </div>`;
  return el;
}

function makeGroupedSessionRow(sessions) {
  const s = sessions[0];
  const totalSeconds = sessions.reduce((a, r) => a + r.seconds, 0);
  const totalChars   = sessions.reduce((a, r) => a + r.chars, 0);
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
      <button class="btn btn-xs btn-danger" style="margin-top:4px" onclick="doDeleteSessionGroup([${ids.join(',')}], this)">✕</button>
    </div>`;
  return el;
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

  function getColor(secs) {
    if (!secs) return HEATMAP_COLORS[0];
    const h = secs / 3600;
    if (h < 0.25) return HEATMAP_COLORS[1];
    if (h < 0.75) return HEATMAP_COLORS[2];
    if (h < 1.5)  return HEATMAP_COLORS[3];
    return HEATMAP_COLORS[4];
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
        const color = getColor(day.secs);
        const tip   = `${day.date}  ${fmtTime(day.secs)}`;
        html += `<div class="heatmap-cell" style="background:${color}" title="${tip}"></div>`;
      }
    });
    html += '</div>';
  });

  html += '</div>';
  html += '<div class="heatmap-legend"><span>Less</span>';
  HEATMAP_COLORS.forEach(c => {
    html += `<div class="heatmap-legend-cell" style="background:${c}"></div>`;
  });
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

// Populate the media dropdown. Option value is the original title so a manual entry
// merges into the existing media card (GSM titles included — purely additive, never
// touches the GSM rollover-attribution path, which only reconciles source='gsm' rows).
async function populateMediaTitles() {
  const dl = document.getElementById('media-titles');
  if (!dl) return;
  try {
    const titles = await window.pywebview.api.get_media_titles();
    dl.innerHTML = '';
    titles.forEach(m => {
      if (!m.title) return;
      const o = document.createElement('option');
      o.value = m.title;
      if (m.display_title && m.display_title !== m.title) o.label = m.display_title;
      dl.appendChild(o);
    });
  } catch (e) { /* dropdown is optional; free-text entry still works */ }
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
  if (!file || !file.type.startsWith('image/')) return;
  await uploadCoverFile(file, title);
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

function bucketDaily(daily, gran) {
  const MONTH_NAMES = ['Jan','Feb','Mar','Apr','May','Jun','Jul','Aug','Sep','Oct','Nov','Dec'];
  if (!daily.length) return { labels: [], secs: [], chars: [] };

  if (gran === 'day') {
    return {
      labels: daily.map(r => r.date.slice(5)),
      secs:   daily.map(r => r.seconds),
      chars:  daily.map(r => r.chars),
    };
  }

  const buckets = {}, order = [];
  const weekStart = dt => {
    const d = new Date(dt);
    const day = d.getDay();
    d.setDate(d.getDate() - (day === 0 ? 6 : day - 1)); // snap to Monday
    return d.toISOString().slice(0, 10);
  };

  const getKey = r => {
    if (gran === 'week') return weekStart(r.date);
    if (gran === '2wk') {
      const origin = new Date(daily[0].date);
      const dt     = new Date(r.date);
      const idx    = Math.floor((dt - origin) / (86400000 * 14));
      const start  = new Date(+origin + idx * 14 * 86400000);
      return start.toISOString().slice(0, 10);
    }
    if (gran === 'month') return r.date.slice(0, 7);
  };

  daily.forEach(r => {
    const k = getKey(r);
    if (!buckets[k]) { buckets[k] = { secs: 0, chars: 0 }; order.push(k); }
    buckets[k].secs  += r.seconds;
    buckets[k].chars += r.chars;
  });

  const multiYear = order[0].slice(0, 4) !== order[order.length - 1].slice(0, 4);
  let labels;
  if (gran === 'week' || gran === '2wk') {
    labels = order.map(k => multiYear ? k.slice(2, 10).replace(/-/g, '/') : k.slice(5));
  } else {
    labels = order.map(k => {
      const mon = MONTH_NAMES[parseInt(k.slice(5), 10) - 1];
      return multiYear ? `${mon} '${k.slice(2, 4)}` : mon;
    });
  }

  return {
    labels,
    secs:  order.map(k => buckets[k].secs),
    chars: order.map(k => buckets[k].chars),
  };
}

function bucketByDayOfWeek(daily) {
  const labels = ['Mon','Tue','Wed','Thu','Fri','Sat','Sun'];
  const secs   = [0,0,0,0,0,0,0];
  daily.forEach(r => {
    const [y, m, d] = r.date.split('-').map(Number);
    const wd = (new Date(y, m - 1, d).getDay() + 6) % 7; // Mon=0 .. Sun=6
    secs[wd] += r.seconds;
  });
  return { labels, secs };
}

// ── Stats ──────────────────────────────────────────────────────────────────
async function loadStats(range_val) {
  await refreshStatsHeatmap();

  if (!statsCache[range_val]) {
    statsCache[range_val] = await window.pywebview.api.get_stats(range_val);
    const others = ['30d','90d','6m','1y','All'].filter(r => r !== range_val);
    setTimeout(() => prefetchStats(others, 0), 500);
  }
  renderStats(statsCache[range_val]);
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

async function setRange(rv) {
  currentRange = rv;
  document.querySelectorAll('#range-seg .seg-btn').forEach(b =>
    b.classList.toggle('active', b.dataset.range === rv));
  await loadStats(rv);
}

async function setGranularity(g) {
  currentGranularity = g;
  updateGranularityUI();
  if (statsCache[currentRange]) renderStats(statsCache[currentRange]);
}

function onCumToggle() {
  if (statsCache[currentRange]) renderDailyChart(statsCache[currentRange].daily);
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
  document.getElementById('sc-streak').textContent     = `${d.cur_streak}d`;
  document.getElementById('es-best-day').textContent   = fmtTime(d.best_day_secs);
  document.getElementById('es-best-day-date').textContent  = d.best_day_date || '—';
  document.getElementById('es-best-week').textContent  = fmtTime(d.best_week_secs);
  document.getElementById('es-best-week-date').textContent = d.best_week_start ? `w/o ${d.best_week_start}` : '—';
  document.getElementById('sc-avg').textContent        = fmtTime(d.avg_secs);
  document.getElementById('es-consistency').textContent    = `${d.consistency_pct}%`;
  document.getElementById('es-consistency-sub').textContent = d.active_days ? `${d.active_days}/${d.window_days}d active` : '';
  renderDailyChart(d.daily);
  renderTimeRollingChart(d.daily);
  renderDailyCharsChart(d.daily);
  renderDowChart(d.daily);
  renderDonutChart(d.activity);
}

// ── Charts ─────────────────────────────────────────────────────────────────
function destroyChart(id) {
  if (charts[id]) { charts[id].destroy(); delete charts[id]; }
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

  const oldBars  = chart.getDatasetMeta(0).data.map(b => ({ x:b.x, y:b.y, base:b.base, width:b.width }));
  const N        = oldBars.length;
  const oldColor = typeof chart.data.datasets[0].backgroundColor === 'string'
                   ? chart.data.datasets[0].backgroundColor : '#5B8CFF';

  const morphData = {
    labels: newConfig.data.labels,
    datasets: newConfig.data.datasets.map((d, i) => ({
      ...d,
      backgroundColor: 'rgba(0,0,0,0)',
      ...(i > 0 ? { borderColor: 'rgba(0,0,0,0)' } : {})
    }))
  };
  chart.data    = morphData;
  chart.options = { ...newConfig.options, animation: false };
  chart.update();

  const newBars  = chart.getDatasetMeta(0).data.map(b => ({ x:b.x, y:b.y, base:b.base, width:b.width }));
  const M        = newBars.length;
  const newColor = typeof newConfig.data.datasets[0].backgroundColor === 'string'
                   ? newConfig.data.datasets[0].backgroundColor : oldColor;

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

  const offRight = W + 60;
  const items    = [];
  const morphN   = Math.min(N, M);

  for (let i = 0; i < morphN; i++) {
    items.push({
      sx:oldBars[i].x, sy:oldBars[i].y, sb:oldBars[i].base, sw:oldBars[i].width,
      ex:newBars[i].x, ey:newBars[i].y, eb:newBars[i].base, ew:newBars[i].width,
      color: oldColor, fade: false
    });
  }
  for (let i = M; i < N; i++) {
    items.push({
      sx:oldBars[i].x, sy:oldBars[i].y, sb:oldBars[i].base, sw:oldBars[i].width,
      ex:offRight,     ey:oldBars[i].y, eb:oldBars[i].base, ew:oldBars[i].width,
      color: oldColor, fade: true
    });
  }
  for (let i = N; i < M; i++) {
    items.push({
      sx:offRight,     sy:newBars[i].y, sb:newBars[i].base, sw:newBars[i].width,
      ex:newBars[i].x, ey:newBars[i].y, eb:newBars[i].base, ew:newBars[i].width,
      color: newColor, fade: false
    });
  }

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
  if (existing && existing.config.type === config.type) {
    const oldLen = existing.data.labels?.length ?? 0;
    const newLen = config.data.labels?.length ?? 0;
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

function renderDailyChart(daily) {
  const cum     = document.getElementById('cum-toggle').checked;
  const { labels, secs } = bucketDaily(daily, currentGranularity);
  const isHours = currentGranularity !== 'day';
  const values  = isHours ? secs.map(s => s / 3600) : secs.map(s => s / 60);
  const fmt     = v => isHours ? `${v.toFixed(1)}h` : fmtTime(v * 60);

  const step        = Math.max(1, Math.floor(labels.length / 14));
  const shownLabels = labels.map((l, i) => i % step === 0 ? l : '');

  const datasets = [{
    label: 'Time', data: values, backgroundColor: '#5B8CFF',
    borderRadius: 3, borderSkipped: false,
  }];

  if (cum) {
    let run = 0;
    const cumVals = values.map(v => (run += v, run));
    datasets.push({
      label: 'Cumulative', data: cumVals, type: 'line',
      borderColor: '#4ECBA0', backgroundColor: 'rgba(78,203,160,0.08)',
      borderWidth: 2, pointRadius: 0, fill: true, tension: 0.3,
      yAxisID: 'y2',
    });
  }

  upsertChart('daily', 'chart-daily', {
    type: 'bar',
    data: { labels: shownLabels, datasets },
    options: {
      responsive: true, maintainAspectRatio: false, animation: CHART_ANIM,
      plugins: {
        legend: { display: cum },
        tooltip: { callbacks: { title: c => labels[c[0].dataIndex], label: c => fmt(c.raw) } }
      },
      scales: {
        x: { grid:{color:'#2E2E48'}, ticks:{color:'#9090A8',maxRotation:0} },
        y: { grid:{color:'#2E2E48'}, ticks:{color:'#9090A8', callback: v => fmt(v)}, afterFit: s => { s.width = 62; } },
        ...(cum ? {y2:{position:'right',grid:{display:false},ticks:{color:'#4ECBA0',callback:v=>fmt(v)}}} : {})
      }
    }
  });
}

function renderTimeRollingChart(daily) {
  const section = document.getElementById('time-rolling-section');
  const show = (currentRange === 'All' || currentRange === '1y') && currentGranularity === 'day';
  if (!show || !daily.length || !daily.some(r => r.seconds > 0)) {
    section.style.display = 'none';
    destroyChart('time-rolling');
    return;
  }
  section.style.display = 'block';

  const win     = 7;
  const secsArr = daily.map(r => r.seconds);
  const rollHrs = secsArr.map((_, i) => {
    const start = Math.max(0, i - win + 1);
    let s = 0;
    for (let j = start; j <= i; j++) s += secsArr[j];
    return s / (i - start + 1) / 3600;
  });

  const labels      = daily.map(r => r.date.slice(5));
  const step        = Math.max(1, Math.floor(labels.length / 14));
  const shownLabels = labels.map((l, i) => i % step === 0 ? l : '');

  upsertChart('time-rolling', 'chart-time-rolling', {
    type: 'line',
    data: {
      labels: shownLabels,
      datasets: [{
        label: 'Time (7d rolling avg)',
        data: rollHrs,
        borderColor: '#5B8CFF',
        backgroundColor: 'rgba(91,140,255,0.08)',
        borderWidth: 2,
        pointRadius: 0,
        pointHoverRadius: 6,
        pointBackgroundColor: '#5B8CFF',
        pointBorderColor: '#24243A',
        pointBorderWidth: 2,
        fill: true,
        tension: 0.35,
        spanGaps: true,
      }]
    },
    options: {
      responsive: true, maintainAspectRatio: false, animation: CHART_ANIM,
      plugins: {
        legend: { display: false },
        tooltip: { callbacks: {
          title: c => labels[c[0].dataIndex],
          label: c => `${fmtTime(c.raw * 3600)}/day`
        } }
      },
      scales: {
        x: { grid:{color:'#2E2E48'}, ticks:{color:'#9090A8',maxRotation:0} },
        y: { grid:{color:'#2E2E48'}, ticks:{color:'#9090A8', callback: v => `${v.toFixed(1)}h`}, beginAtZero: true, afterFit: s => { s.width = 62; } },
      }
    }
  });
}

function renderDailyCharsChart(daily) {
  const { labels, chars } = bucketDaily(daily, currentGranularity);
  if (!chars.some(c => c > 0)) { destroyChart('daily-chars'); return; }

  const step        = Math.max(1, Math.floor(labels.length / 14));
  const shownLabels = labels.map((l, i) => i % step === 0 ? l : '');

  upsertChart('daily-chars', 'chart-daily-chars', {
    type: 'bar',
    data: { labels: shownLabels, datasets: [{
      label: 'Characters', data: chars, backgroundColor: '#4ECBA0',
      borderRadius: 3, borderSkipped: false,
    }]},
    options: {
      responsive: true, maintainAspectRatio: false, animation: CHART_ANIM,
      plugins: {
        legend: { display: false },
        tooltip: { callbacks: { title: c => labels[c[0].dataIndex], label: c => fmtChars(c.raw) + ' chars' } }
      },
      scales: {
        x: { grid:{color:'#2E2E48'}, ticks:{color:'#9090A8',maxRotation:0} },
        y: { grid:{color:'#2E2E48'}, ticks:{color:'#9090A8', callback: v => fmtChars(v)}, afterFit: s => { s.width = 62; } },
      }
    }
  });
}

function renderDowChart(daily) {
  const { labels, secs } = bucketByDayOfWeek(daily);
  if (!secs.some(s => s > 0)) { destroyChart('dow'); return; }
  const values = secs.map(s => s / 3600);

  upsertChart('dow', 'chart-dow', {
    type: 'bar',
    data: { labels, datasets: [{
      label: 'Time', data: values, backgroundColor: '#5B8CFF',
      borderRadius: 3, borderSkipped: false,
    }]},
    options: {
      responsive: true, maintainAspectRatio: false, animation: CHART_ANIM,
      plugins: {
        legend: { display: false },
        tooltip: { callbacks: {
          title: c => labels[c[0].dataIndex],
          label: c => fmtTime(secs[c.dataIndex])
        } }
      },
      scales: {
        x: { grid:{color:'#2E2E48'}, ticks:{color:'#9090A8',maxRotation:0} },
        y: { grid:{color:'#2E2E48'}, ticks:{color:'#9090A8', callback: v => `${v.toFixed(1)}h`}, afterFit: s => { s.width = 62; } },
      }
    }
  });
}

function renderDonutChart(activity) {
  if (!activity.length) { destroyChart('donut'); return; }
  const labels = activity.map(a=>a.type);
  const values = activity.map(a=>a.seconds);
  const colors = labels.map(acolor);
  upsertChart('donut', 'chart-donut', {
    type: 'doughnut',
    data: {
      labels,
      datasets: [{ data: values, backgroundColor: colors,
                   borderColor:'#24243A', borderWidth:2, hoverOffset:4 }]
    },
    options: {
      responsive: true, maintainAspectRatio: false, animation: CHART_ANIM, cutout: '60%',
      plugins: {
        legend: { position:'bottom', labels:{color:'#9090A8',padding:10,boxWidth:12,boxHeight:12,usePointStyle:true} },
        tooltip: { callbacks: { label: c => `${c.label}: ${fmtTime(c.raw)}` } }
      }
    }
  });
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
  await populateGoalActivitySelect();
  const goals = await window.pywebview.api.get_goals();
  goals.forEach(g => { goalDataCache[g.id] = g; });
  const list  = document.getElementById('goal-list');
  list.innerHTML = '';
  const active = goals.filter(g => !g.user_finished);
  if (!active.length) {
    list.innerHTML = '<p class="empty-msg">No goals yet. Add one above.</p>'; return;
  }
  const inProgress = active.filter(g => !g.is_overdue);
  const overdue    = active.filter(g => g.is_overdue);
  [...inProgress, ...overdue].forEach(g => list.appendChild(makeGoalCard(g)));
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
  if (goalPanelMode === 'completed') { setGoalPanelMode('default'); return; }
  setGoalPanelMode('completed');
  const goals = await window.pywebview.api.get_goals();
  goals.forEach(g => { goalDataCache[g.id] = g; });
  const list  = document.getElementById('goal-completed-list');
  list.innerHTML = '';
  const finished = goals.filter(g => g.user_finished);
  if (!finished.length) {
    list.innerHTML = '<p class="empty-msg">No completed goals yet.</p>'; return;
  }
  finished.forEach(g => list.appendChild(makeGoalCard(g)));
}

function hideCompletedGoals() {
  setGoalPanelMode('default');
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
  const fillColor = g.is_complete ? '#4ECBA0' : '#FF6B6B';

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
    const color    = behind ? '#FF9F5B' : ahead ? '#4ECBA0' : 'var(--dim)';
    const periodPct = barTarget > 0 ? Math.min(100, periodDone / barTarget * 100) : 0;
    const barColor  = periodPct >= 100 ? '#4ECBA0' : '#5B8CFF';
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

  const actLabel = g.activity_type ? ` · ${g.activity_type}` : '';
  const charsLabel = g.track_chars
    ? ` · <span class="goal-chars-companion">${fmtChars(Math.round(g.chars_completed || 0))} chars</span>`
    : '';

  const finishBtn = g.is_complete && !g.user_finished
    ? `<button class="btn btn-xs btn-outline" style="border-color:#4ECBA0;color:#4ECBA0" onclick="doFinishGoal(${g.id})">Mark finished</button>`
    : '';

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
        // Match the right-side progress %: 1-decimal precision, trailing zeros dropped.
        const expDisp = Math.round(expPct * 10) / 10;
        const expVal = fmtMetric((expPct / 100) * g.target);
        return `<div class="progress-expected" style="left:${expPct}%" title="Expected by end of today: ${expDisp}% (${expVal})"></div>`;
      })()}
    </div>
    <div class="goal-meta">
      <span class="goal-numbers">${fmtMetric(g.completed)} / ${fmtMetric(g.target)}${actLabel}${charsLabel}</span>
      <span class="goal-pct" style="color:${fillColor}">${pct}%</span>
    </div>
    ${chunkHtml}
    <div style="display:flex;justify-content:space-between;align-items:center;margin-top:2px">
      <div style="font-size:10px;color:var(--muted)">deadline: ${g.deadline} · started: ${g.start_date}</div>
      <button class="btn btn-xs" style="background:none;border:none;color:var(--dim);font-size:11px;padding:0 2px;cursor:pointer;opacity:0.55" title="Edit goal" onclick="openGoalEdit(${g.id})">✎</button>
    </div>`;
  return el;
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

  let target = metric === 'time_seconds' ? rawTarget * 3600 : rawTarget;

  let r;
  if (editingGoalId !== null) {
    r = await window.pywebview.api.update_goal(editingGoalId, label, target, deadline, atype, trackChars);
  } else {
    if (chunkPeriod !== 'none') {
      const daysUntil = Math.round((new Date(deadline) - new Date(today())) / 86400000);
      const periods   = chunkPeriod === 'weekly' ? Math.ceil(daysUntil / 7) : chunkPeriod === 'monthly' ? Math.ceil(daysUntil / 30.44) : daysUntil;
      if (periods < 1) {
        fb.className = 'feedback err'; fb.textContent = 'Deadline is too soon for that pace.'; return;
      }
      target *= periods;
    }
    r = await window.pywebview.api.add_goal(label, metric, target, deadline, chunkPeriod, atype, trackChars);
  }

  if (r.ok) {
    document.getElementById('goal-label').value    = '';
    document.getElementById('goal-target').value   = '';
    document.getElementById('goal-deadline').value = '';
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
// The Media page has four mutually-exclusive sub-views. Switching must hide ALL
// the others — milestone-view was added late and several callers forgot it,
// leaving its stat/graph page stacked under the next view.
function showMediaView(name) {
  const views = {
    grid:      'media-grid-view',
    detail:    'media-detail-view',
    series:    'media-series-view',
    milestone: 'media-milestone-view',
  };
  for (const [key, id] of Object.entries(views)) {
    document.getElementById(id).style.display = key === name ? 'block' : 'none';
  }
}

async function loadMedia() {
  destroyChart('detail');
  destroyChart('detail-time');
  currentDetailTitle = null;
  currentSeriesId    = null;
  showMediaView('grid');

  [mediaAllData, seriesData, mediaOrderMap] = await Promise.all([
    window.pywebview.api.get_media(),
    window.pywebview.api.get_series(),
    window.pywebview.api.get_media_order(),
  ]);
  mediaOrderMap = mediaOrderMap || {};
  const nonManualCount = mediaAllData.filter(m => m.source !== 'manual').length;
  document.getElementById('media-count').textContent = `${nonManualCount} titles`;
  renderMediaGrid();
}

function renderMediaGrid() {
  const grid = document.getElementById('media-grid');

  // Titles that belong to a series — hidden as standalone cards
  const inSeries = new Set(seriesData.flatMap(s => s.members.map(m => m.title)));
  const filtered = mediaAllData.filter(m => m.source !== 'manual');
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
  const ungrouped = mediaAllData.filter(m => m.source !== 'manual' && !inSeries.has(m.title));
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
  const back   = members[2];

  let html = '';
  if (back)  html += `<div class="series-layer series-layer-back">${cardLayerHTML(back)}</div>`;
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

function renderSeriesDetail(s, memberDetails = []) {
  document.getElementById('series-detail-name').textContent = s.name;

  // Stacked cover art in hero
  const coverEl = document.getElementById('series-detail-cover');
  const members = s.members;
  const front = members[0], mid = members[1], back = members[2];
  let coverHtml = '';
  if (back)  coverHtml += `<div class="series-layer series-layer-back">${cardLayerHTML(back)}</div>`;
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

  // Aggregate stats from member details
  let totalSecs = 0, totalChars = 0;
  const allDates = new Set();
  const dailyMap = {};
  memberDetails.forEach(d => {
    totalSecs  += d.total_secs  || 0;
    totalChars += d.total_chars || 0;
    (d.daily || []).forEach(row => {
      allDates.add(row.date);
      if (!dailyMap[row.date]) dailyMap[row.date] = { date: row.date, chars: 0, seconds: 0 };
      dailyMap[row.date].chars   += row.chars;
      dailyMap[row.date].seconds += row.seconds;
      // speed is recomputed per-day from aggregated chars/seconds
    });
  });
  if (!memberDetails.length) totalSecs = s.total_secs || 0;

  const daily     = Object.values(dailyMap).sort((a, b) => a.date.localeCompare(b.date));
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

  renderSeriesCharts(daily);
}

function renderSeriesCharts(daily) {
  destroyChart('series-chars');
  destroyChart('series-time');
  destroyChart('series-speed');
  destroyChart('series-speed-rolling');
  if (!daily.length) return;

  const labels      = daily.map(r => r.date.slice(5));
  const charVals    = daily.map(r => r.chars);
  const timeVals    = daily.map(r => r.seconds);
  const speedVals   = daily.map(r => r.seconds > 0 && r.chars > 0 ? r.chars / (r.seconds / 3600) : 0);
  const twSpeedVals = twRolling(charVals, timeVals, 7);
  const step        = Math.max(1, Math.floor(labels.length / 14));
  const shownLabels = labels.map((l, i) => i % step === 0 ? l : '');

  if (charVals.some(v => v > 0)) {
    const ctx = document.getElementById('chart-series-chars').getContext('2d');
    charts['series-chars'] = new Chart(ctx, {
      type: 'bar',
      data: { labels: shownLabels, datasets: [{
        label: 'Characters', data: charVals, backgroundColor: '#4ECBA0',
        borderRadius: 3, borderSkipped: false,
      }]},
      options: {
        responsive: true, maintainAspectRatio: false, animation: false,
        plugins: { legend: { display: false },
          tooltip: { callbacks: { title: c => labels[c[0].dataIndex], label: c => `${fmtChars(c.raw)} chars` } } },
        scales: {
          x: { grid:{color:'#2E2E48'}, ticks:{color:'#9090A8',maxRotation:0} },
          y: { grid:{color:'#2E2E48'}, ticks:{color:'#9090A8', callback: v => fmtChars(v)}, afterFit: s => { s.width = 62; } },
        }
      }
    });
  }

  if (timeVals.some(v => v > 0)) {
    const ctx = document.getElementById('chart-series-time').getContext('2d');
    charts['series-time'] = new Chart(ctx, {
      type: 'bar',
      data: { labels: shownLabels, datasets: [{
        label: 'Time', data: timeVals.map(s => s / 60), backgroundColor: '#5B8CFF',
        borderRadius: 3, borderSkipped: false,
      }]},
      options: {
        responsive: true, maintainAspectRatio: false, animation: false,
        plugins: { legend: { display: false },
          tooltip: { callbacks: { title: c => labels[c[0].dataIndex], label: c => fmtTime(c.raw * 60) } } },
        scales: {
          x: { grid:{color:'#2E2E48'}, ticks:{color:'#9090A8',maxRotation:0} },
          y: { grid:{color:'#2E2E48'}, ticks:{color:'#9090A8', callback: v => fmtTime(v * 60)}, afterFit: s => { s.width = 62; } },
        }
      }
    });
  }

  const speedSection = document.getElementById('series-speed-section');
  if (speedVals.some(v => v > 0)) {
    speedSection.style.display = 'block';
    const seriesSpeedOpts = {
      responsive: true, maintainAspectRatio: false, animation: false,
      plugins: {
        legend: { display: false },
        tooltip: {
          callbacks: {
            title: c => labels[c[0].dataIndex],
            label: c => c.raw != null ? `${fmtChars(Math.round(c.raw))}/h` : ''
          }
        }
      },
      scales: {
        x: { grid:{color:'#2E2E48'}, ticks:{color:'#9090A8',maxRotation:0} },
        y: { grid:{color:'#2E2E48'}, ticks:{color:'#4ECBA0', callback: v => fmtChars(v)}, beginAtZero: false, afterFit: s => { s.width = 62; } },
      },
    };
    const speedCtx = document.getElementById('chart-series-speed').getContext('2d');
    charts['series-speed'] = new Chart(speedCtx, {
      type: 'line',
      data: {
        labels: shownLabels,
        datasets: [{
          label: 'Read speed',
          data: speedVals.map(v => v > 0 ? v : null),
          borderColor: '#4ECBA0',
          backgroundColor: 'rgba(78,203,160,0.08)',
          borderWidth: 2,
          pointRadius: 4,
          pointHoverRadius: 7,
          pointBackgroundColor: '#4ECBA0',
          pointBorderColor: '#24243A',
          pointBorderWidth: 2,
          fill: true,
          tension: 0.35,
          spanGaps: false,
        }]
      },
      options: seriesSpeedOpts,
    });
    const rollingCtx = document.getElementById('chart-series-speed-rolling').getContext('2d');
    charts['series-speed-rolling'] = new Chart(rollingCtx, {
      type: 'line',
      data: {
        labels: shownLabels,
        datasets: [{
          label: 'Read speed (7d rolling)',
          data: twSpeedVals,
          borderColor: '#4ECBA0',
          backgroundColor: 'rgba(78,203,160,0.08)',
          borderWidth: 2,
          pointRadius: 4,
          pointHoverRadius: 7,
          pointBackgroundColor: '#4ECBA0',
          pointBorderColor: '#24243A',
          pointBorderWidth: 2,
          fill: true,
          tension: 0.35,
          spanGaps: true,
        }]
      },
      options: seriesSpeedOpts,
    });
  } else {
    speedSection.style.display = 'none';
  }
}

function closeSeriesDetail() {
  destroyChart('series-chars');
  destroyChart('series-time');
  destroyChart('series-speed');
  destroyChart('series-speed-rolling');
  destroyChart('detail');
  destroyChart('detail-time');
  currentSeriesId    = null;
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
    if (updated) renderSeriesDetail(updated);
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
  destroyChart('detail-time');
  destroyChart('detail-speed');
  destroyChart('detail-speed-rolling');
  currentDetailTitle = null;
  currentMilestones  = [];
  // If we came from a series view, go back to it; otherwise go to grid
  if (currentSeriesId !== null) {
    const s = seriesData.find(x => x.id === currentSeriesId);
    if (s) { openSeriesDetail(currentSeriesId); return; }
  }
  showMediaView('grid');
}

function renderMediaDetail(d) {
  const isGSM = d.source === 'gsm';
  const color  = acolor(d.activity_type);

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

  // Milestones replace the description when present; otherwise description shows.
  currentMilestones = d.milestones || [];
  const descEl     = document.getElementById('detail-desc');
  const milesEl    = document.getElementById('detail-milestones');
  if (currentMilestones.length > 0) {
    descEl.style.display  = 'none';
    milesEl.style.display = 'flex';
    renderMilestonesList(milesEl, currentMilestones);
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
  countEl.textContent = `(${d.session_count})`;
  renderDetailSessions(d.daily, isGSM);
}

function renderDetailChart(daily, isGSM) {
  destroyChart('detail');
  destroyChart('detail-time');
  destroyChart('detail-speed');
  destroyChart('detail-speed-rolling');
  if (!daily.length) return;

  const n = daily.length;
  let labels, charVals, speedVals, timeVals;

  if (n > 90) {
    const wb = {}, tb = {};
    daily.forEach(({ date: dt, chars: c, seconds: sec }) => {
      const d  = new Date(dt);
      const wk = `${d.getFullYear()}-W${String(Math.ceil(
        (d.getDate() + new Date(d.getFullYear(), 0, 1).getDay()) / 7
      )).padStart(2,'0')}`;
      wb[wk] = (wb[wk] || 0) + c;
      tb[wk] = (tb[wk] || 0) + sec;
    });
    const agg = Object.entries(wb).sort();
    labels    = agg.map(([k]) => k);
    charVals  = agg.map(([k]) => wb[k]);
    timeVals  = agg.map(([k]) => tb[k]);
    speedVals = charVals.map((c, i) => timeVals[i] > 0 ? c / (timeVals[i] / 3600) : 0);
  } else {
    labels    = daily.map(r => r.date.slice(5));
    charVals  = daily.map(r => r.chars);
    timeVals  = daily.map(r => r.seconds);
    speedVals = daily.map(r => r.seconds > 0 && r.chars > 0 ? r.chars / (r.seconds / 3600) : 0);
  }

  const twSpeedVals = twRolling(charVals, timeVals, 7);

  const step        = Math.max(1, Math.floor(labels.length / 14));
  const shownLabels = labels.map((l, i) => i % step === 0 ? l : '');
  const hasSpeed    = speedVals.some(s => s > 0);

  // Characters chart (bars only)
  const ctx = document.getElementById('chart-detail').getContext('2d');
  charts['detail'] = new Chart(ctx, {
    type: 'bar',
    data: {
      labels: shownLabels,
      datasets: [{
        label: 'Characters',
        data: charVals,
        backgroundColor: '#4ECBA0',
        borderRadius: 3,
        borderSkipped: false,
      }]
    },
    options: {
      responsive: true, maintainAspectRatio: false, animation: false,
      plugins: {
        legend: { display: false },
        tooltip: { callbacks: { title: c => labels[c[0].dataIndex], label: c => `${fmtChars(c.raw)} chars` } }
      },
      scales: {
        x: { grid:{color:'#2E2E48'}, ticks:{color:'#9090A8',maxRotation:0} },
        y: { grid:{color:'#2E2E48'}, ticks:{color:'#9090A8', callback: v => fmtChars(v)}, afterFit: s => { s.width = 62; } },
      },
    }
  });

  // Read speed chart (line with visible points)
  const speedSection = document.getElementById('detail-speed-section');
  if (hasSpeed) {
    speedSection.style.display = 'block';
    const speedCtx = document.getElementById('chart-detail-speed').getContext('2d');
    const speedLineOpts = {
      responsive: true, maintainAspectRatio: false, animation: false,
      plugins: {
        legend: { display: false },
        tooltip: { callbacks: { title: c => labels[c[0].dataIndex], label: c => c.raw != null ? `${fmtChars(Math.round(c.raw))}/h` : '' } }
      },
      scales: {
        x: { grid:{color:'#2E2E48'}, ticks:{color:'#9090A8',maxRotation:0} },
        y: { grid:{color:'#2E2E48'}, ticks:{color:'#4ECBA0', callback: v => fmtChars(v)}, beginAtZero: false, afterFit: s => { s.width = 62; } },
      },
    };
    charts['detail-speed'] = new Chart(speedCtx, {
      type: 'line',
      data: {
        labels: shownLabels,
        datasets: [{
          label: 'Read speed',
          data: speedVals.map(v => v > 0 ? v : null),
          borderColor: '#4ECBA0',
          backgroundColor: 'rgba(78,203,160,0.08)',
          borderWidth: 2,
          pointRadius: 4,
          pointHoverRadius: 7,
          pointBackgroundColor: '#4ECBA0',
          pointBorderColor: '#24243A',
          pointBorderWidth: 2,
          fill: true,
          tension: 0.35,
          spanGaps: false,
        }]
      },
      options: speedLineOpts,
    });

    const rollingCtx = document.getElementById('chart-detail-speed-rolling').getContext('2d');
    charts['detail-speed-rolling'] = new Chart(rollingCtx, {
      type: 'line',
      data: {
        labels: shownLabels,
        datasets: [{
          label: 'Read speed (7d rolling)',
          data: twSpeedVals,
          borderColor: '#4ECBA0',
          backgroundColor: 'rgba(78,203,160,0.08)',
          borderWidth: 2,
          pointRadius: 4,
          pointHoverRadius: 7,
          pointBackgroundColor: '#4ECBA0',
          pointBorderColor: '#24243A',
          pointBorderWidth: 2,
          fill: true,
          tension: 0.35,
          spanGaps: true,
        }]
      },
      options: speedLineOpts,
    });
  } else {
    speedSection.style.display = 'none';
  }

  // Time chart
  const hasTime = timeVals.some(v => v > 0);
  if (hasTime) {
    const timeCtx = document.getElementById('chart-detail-time').getContext('2d');
    charts['detail-time'] = new Chart(timeCtx, {
      type: 'bar',
      data: {
        labels: shownLabels,
        datasets: [{
          label: 'Time',
          data: timeVals.map(s => s / 60),
          backgroundColor: '#5B8CFF',
          borderRadius: 3,
          borderSkipped: false,
        }]
      },
      options: {
        responsive: true, maintainAspectRatio: false, animation: false,
        plugins: {
          legend: { display: false },
          tooltip: { callbacks: { title: c => labels[c[0].dataIndex], label: c => fmtTime(c.raw * 60) } }
        },
        scales: {
          x: { grid:{color:'#2E2E48'}, ticks:{color:'#9090A8',maxRotation:0} },
          y: { grid:{color:'#2E2E48'}, ticks:{color:'#9090A8', callback: v => fmtTime(v*60)}, afterFit: s => { s.width = 62; } },
        }
      }
    });
  }
}

function renderDetailSessions(daily, isGSM) {
  const el = document.getElementById('detail-session-list');
  el.innerHTML = '';

  if (!daily.length) {
    el.innerHTML = '<p class="empty-msg">No session data.</p>';
    return;
  }

  // Show newest first
  const reversed = [...daily].reverse();

  reversed.forEach(s => {
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
    el.appendChild(row);
  });
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
    Chart.defaults.color       = '#8AADA9';
    Chart.defaults.borderColor = '#C2E4DC';
  } else {
    document.documentElement.removeAttribute('data-theme');
    HEATMAP_COLORS = ['#1E1E30','#1a3b4a','#1e6b52','#26a06e','#4ECBA0'];
    Chart.defaults.color       = '#9090A8';
    Chart.defaults.borderColor = '#2E2E48';
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

// ── Settings ───────────────────────────────────────────────────────────────
async function loadSettings() {
  const s = await window.pywebview.api.get_all_settings();
  appSettings = s;
  document.getElementById('sessions-dir').textContent  = await window.pywebview.api.get_sessions_dir();
  document.getElementById('gsm-url').value             = s.gsm_url || 'http://localhost:7275/api/stats';
  document.getElementById('rollover-hour').value       = String(s.rollover_hour || 0);
  document.getElementById('gsm-debounce').value        = s.gsm_debounce_secs || 60;
  document.getElementById('gsm-open-gap').value         = s.gsm_open_gap_secs ?? 0;
  document.getElementById('ext-port').value            = s.ext_port  || 18463;
  document.getElementById('ext-token').value           = s.ext_token || '';
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
  const val = document.getElementById(id).value;
  navigator.clipboard.writeText(val).catch(() => {});
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
  appSettings = { ...appSettings, rollover_hour: rollover, gsm_url, gsm_debounce_secs, gsm_open_gap_secs };
  await window.pywebview.api.save_settings({ rollover_hour: rollover, gsm_url, gsm_debounce_secs, gsm_open_gap_secs });
  scheduleRolloverRefresh();
  setStatus('Settings saved');
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
    loadPage(currentPage);
    scheduleRolloverRefresh();
  }, ms);
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
  flatpickr('#goal-deadline', {
    dateFormat:    'Y-m-d',
    minDate:       'today',
    disableMobile: true,
  });

  await buildLogPage();
  setStatus('Ready');
  loadPage('dashboard');
  scheduleRolloverRefresh();
  maybeShowFirstRunModal();
}

// ── Milestones ─────────────────────────────────────────────────────────────
function fmtMilestoneTotals(m) {
  // Compact "1h 30m · 1,200 chars · 800/h" summary for the row meta line.
  const parts = [];
  if (m.total_secs > 0) parts.push(fmtTime(m.total_secs));
  if (m.total_chars > 0) parts.push(`${fmtChars(m.total_chars)} chars`);
  if (m.total_secs > 60 && m.total_chars > 0) {
    const speed = Math.round(m.total_chars / (m.total_secs / 3600));
    if (speed > 0) parts.push(`${fmtChars(speed)}/h`);
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

function renderMilestonesList(el, milestones) {
  el.innerHTML = '';
  milestones.forEach((m, idx) => {
    const row = document.createElement('div');
    row.className = 'milestone-row';
    row.draggable = true;
    row.dataset.milestoneId = m.id;

    row.innerHTML = `
      <span class="milestone-index">${idx + 1}</span>
      <div class="milestone-main">
        <span class="milestone-name">${escHtml(m.name)}</span>
        <span class="milestone-meta">${escHtml(fmtMilestoneTotals(m))}</span>
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
function openAddMilestoneModal() {
  if (!currentDetailTitle) return;
  _milestoneEditingId = null;
  document.getElementById('milestone-modal-title').textContent = 'Add milestone';
  document.getElementById('milestone-input-name').value  = '';
  document.getElementById('milestone-input-unit').value  = 'hours';
  document.getElementById('milestone-input-start').value = '';
  document.getElementById('milestone-input-end').value   = '';
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
  const errEl     = document.getElementById('milestone-error');
  errEl.style.display = 'none';

  if (!name) { errEl.textContent = 'Name required.'; errEl.style.display = 'block'; return; }
  if (startStr !== '' && !Number.isFinite(startVal)) { errEl.textContent = 'Start must be a number or empty.'; errEl.style.display = 'block'; return; }
  if (endStr   !== '' && !Number.isFinite(endVal))   { errEl.textContent = 'End must be a number or empty.';   errEl.style.display = 'block'; return; }

  const r = _milestoneEditingId == null
    ? await window.pywebview.api.add_milestone(currentDetailTitle, name, unit, startVal, endVal)
    : await window.pywebview.api.update_milestone(_milestoneEditingId, name, unit, startVal, endVal);
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
  destroyChart('milestone-time');
  destroyChart('milestone-chars');
  destroyChart('milestone-speed');
  destroyChart('milestone-speed-rolling');
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

  // Badge shows the milestone's unit (totals are visible in the stat cards)
  const unitLabel = d.unit === 'hours' ? 'Hours' : 'Characters';
  document.getElementById('milestone-badge').innerHTML =
    `<span class="genre-badge" style="color:${color};border-color:${color}44">${unitLabel}</span>`;

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
  renderMilestoneSessions(d.daily || []);
}

function renderMilestoneCharts(daily) {
  destroyChart('milestone-time');
  destroyChart('milestone-chars');
  destroyChart('milestone-speed');
  destroyChart('milestone-speed-rolling');
  if (!daily.length) return;

  const labels    = daily.map(r => r.date.slice(5));
  const charVals  = daily.map(r => r.chars);
  const timeVals  = daily.map(r => r.seconds);
  const speedVals = daily.map(r => r.seconds > 0 && r.chars > 0 ? r.chars / (r.seconds / 3600) : 0);
  const twSpeedVals = twRolling(charVals, timeVals, 7);
  const step = Math.max(1, Math.floor(labels.length / 14));
  const shown = labels.map((l, i) => i % step === 0 ? l : '');

  if (timeVals.some(v => v > 0)) {
    const ctx = document.getElementById('chart-milestone-time').getContext('2d');
    charts['milestone-time'] = new Chart(ctx, {
      type: 'bar',
      data: { labels: shown, datasets: [{
        label: 'Time', data: timeVals.map(s => s / 60),
        backgroundColor: '#5B8CFF', borderRadius: 3, borderSkipped: false,
      }]},
      options: {
        responsive: true, maintainAspectRatio: false, animation: false,
        plugins: { legend: { display: false },
          tooltip: { callbacks: { title: c => labels[c[0].dataIndex], label: c => fmtTime(c.raw * 60) } } },
        scales: {
          x: { grid:{color:'#2E2E48'}, ticks:{color:'#9090A8',maxRotation:0} },
          y: { grid:{color:'#2E2E48'}, ticks:{color:'#9090A8', callback: v => fmtTime(v*60)}, afterFit: s => { s.width = 62; } },
        }
      }
    });
  }

  if (charVals.some(v => v > 0)) {
    const ctx = document.getElementById('chart-milestone-chars').getContext('2d');
    charts['milestone-chars'] = new Chart(ctx, {
      type: 'bar',
      data: { labels: shown, datasets: [{
        label: 'Characters', data: charVals,
        backgroundColor: '#4ECBA0', borderRadius: 3, borderSkipped: false,
      }]},
      options: {
        responsive: true, maintainAspectRatio: false, animation: false,
        plugins: { legend: { display: false },
          tooltip: { callbacks: { title: c => labels[c[0].dataIndex], label: c => `${fmtChars(c.raw)} chars` } } },
        scales: {
          x: { grid:{color:'#2E2E48'}, ticks:{color:'#9090A8',maxRotation:0} },
          y: { grid:{color:'#2E2E48'}, ticks:{color:'#9090A8', callback: v => fmtChars(v)}, afterFit: s => { s.width = 62; } },
        }
      }
    });
  }

  const speedSection = document.getElementById('milestone-speed-section');
  if (speedVals.some(v => v > 0)) {
    speedSection.style.display = 'block';
    const opts = {
      responsive: true, maintainAspectRatio: false, animation: false,
      plugins: { legend: { display: false },
        tooltip: { callbacks: { title: c => labels[c[0].dataIndex], label: c => c.raw != null ? `${fmtChars(Math.round(c.raw))}/h` : '' } } },
      scales: {
        x: { grid:{color:'#2E2E48'}, ticks:{color:'#9090A8',maxRotation:0} },
        y: { grid:{color:'#2E2E48'}, ticks:{color:'#4ECBA0', callback: v => fmtChars(v)}, beginAtZero: false, afterFit: s => { s.width = 62; } },
      },
    };
    const cfg = (label, data, spanGaps) => ({
      type: 'line',
      data: { labels: shown, datasets: [{
        label, data, borderColor: '#4ECBA0',
        backgroundColor: 'rgba(78,203,160,0.08)', borderWidth: 2,
        pointRadius: 4, pointHoverRadius: 7, pointBackgroundColor: '#4ECBA0',
        pointBorderColor: '#24243A', pointBorderWidth: 2,
        fill: true, tension: 0.35, spanGaps,
      }]},
      options: opts,
    });
    charts['milestone-speed'] = new Chart(
      document.getElementById('chart-milestone-speed').getContext('2d'),
      cfg('Read speed', speedVals.map(v => v > 0 ? v : null), false)
    );
    charts['milestone-speed-rolling'] = new Chart(
      document.getElementById('chart-milestone-speed-rolling').getContext('2d'),
      cfg('Read speed (7d rolling)', twSpeedVals, true)
    );
  } else {
    speedSection.style.display = 'none';
  }
}

function renderMilestoneSessions(daily) {
  const el = document.getElementById('milestone-session-list');
  el.innerHTML = '';
  if (!daily.length) {
    el.innerHTML = '<p class="empty-msg">No session data in this milestone yet.</p>';
    return;
  }
  [...daily].reverse().forEach(s => {
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
    el.appendChild(row);
  });
}

async function endCurrentMilestone() {
  if (currentMilestoneId == null) return;
  const m = currentMilestones.find(x => x.id === currentMilestoneId);
  const label = m ? m.name : 'this milestone';
  const ok = await showConfirm(`End milestone "${label}" at the current point?`, 'End', '#5B8CFF');
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

if (window.pywebview) {
  init();
} else {
  window.addEventListener('pywebviewready', init);
}
