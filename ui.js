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
let currentSeriesId = null;
let draggedItem   = null; // {type:'title'|'series', id:string|number}
let heatmapYear     = new Date().getFullYear();
let dashHeatmapYear = new Date().getFullYear();
let appSettings   = { rollover_hour: 0, gsm_url: 'http://localhost:7275/api/stats', theme: 'dark' };
let currentDetailTitle = null;

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
    d.today.forEach(s => list.appendChild(makeSessionRow(s)));
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

// ── Delete session ─────────────────────────────────────────────────────────
async function doDeleteSession(id, btn) {
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
    if (r.cards > 0)  parts.push(`${r.cards} cards`);
    if (r.speed > 0)  parts.push(`${fmtChars(Math.round(r.speed))}/hr`);
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
      document.getElementById('log-chars-group').style.display = t === 'Reading' ? '' : 'none';
    };
    pills.appendChild(b);
  });

  const charsGroup = document.getElementById('log-chars-group');
  if (charsGroup) charsGroup.style.display = selectedAtype === 'Reading' ? '' : 'none';
  renderCustomCatList(customCats);
  buildColorSwatches();
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
  const chars     = selectedAtype === 'Reading' && charsRaw ? Number(charsRaw) : 0;
  const fb        = document.getElementById('log-feedback');

  if (!minutes || isNaN(minutes) || Number(minutes) <= 0) {
    fb.className = 'feedback err'; fb.textContent = 'Enter a positive number of minutes.'; return;
  }
  if (!/^\d{4}-\d{2}-\d{2}$/.test(dt)) {
    fb.className = 'feedback err'; fb.textContent = 'Date must be YYYY-MM-DD.'; return;
  }
  const r = await window.pywebview.api.log_session(selectedAtype, Number(minutes), title, dt, chars);
  if (r.ok) {
    const charsPart = chars > 0 ? ` · ${fmtChars(chars)} chars` : '';
    fb.className = 'feedback ok'; fb.textContent = `✓ Logged ${fmtTime(Number(minutes) * 60)} of ${selectedAtype}${charsPart}`;
    document.getElementById('log-minutes').value = '';
    document.getElementById('log-chars').value   = '';
    document.getElementById('log-title').value   = '';
    document.getElementById('log-date')._flatpickr?.setDate(today(), false);
    statsCache = {};
    setStatus('Session logged');
  } else {
    fb.className = 'feedback err'; fb.textContent = r.error || 'Something went wrong.';
  }
}

async function doImportCSV() {
  const path = await window.pywebview.api.open_csv_dialog();
  const fb   = document.getElementById('csv-feedback');
  if (!path) { fb.className=''; fb.textContent=''; return; }
  const r = await window.pywebview.api.do_import_csv(path);
  fb.className = r.imported ? 'feedback ok' : 'feedback';
  fb.textContent = `✓ Imported ${r.imported} row(s)` + (r.skipped ? `  (${r.skipped} skipped)` : '');
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
    mediaAllData = await window.pywebview.api.get_media();
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
function autoGranularity(range) {
  return {'30d': 'day', '90d': 'week', '6m': 'week', '1y': 'month', 'All': 'month'}[range] || 'day';
}

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
  currentGranularity = autoGranularity(rv);
  updateGranularityUI();
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
  renderDailyCharsChart(d.daily);
  renderDonutChart(d.activity);
}

// ── Charts ─────────────────────────────────────────────────────────────────
function destroyChart(id) {
  if (charts[id]) { charts[id].destroy(); delete charts[id]; }
}

function renderDailyChart(daily) {
  destroyChart('daily');
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

  const ctx = document.getElementById('chart-daily').getContext('2d');
  charts['daily'] = new Chart(ctx, {
    type: 'bar',
    data: { labels: shownLabels, datasets },
    options: {
      responsive: true, maintainAspectRatio: false, animation: false,
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

function renderDailyCharsChart(daily) {
  destroyChart('daily-chars');
  const { labels, chars } = bucketDaily(daily, currentGranularity);
  if (!chars.some(c => c > 0)) return;

  const step        = Math.max(1, Math.floor(labels.length / 14));
  const shownLabels = labels.map((l, i) => i % step === 0 ? l : '');

  const ctx = document.getElementById('chart-daily-chars').getContext('2d');
  charts['daily-chars'] = new Chart(ctx, {
    type: 'bar',
    data: { labels: shownLabels, datasets: [{
      label: 'Characters', data: chars, backgroundColor: '#4ECBA0',
      borderRadius: 3, borderSkipped: false,
    }]},
    options: {
      responsive: true, maintainAspectRatio: false, animation: false,
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

function renderDonutChart(activity) {
  destroyChart('donut');
  if (!activity.length) return;
  const labels = activity.map(a=>a.type);
  const values = activity.map(a=>a.seconds);
  const colors = labels.map(acolor);
  const ctx    = document.getElementById('chart-donut').getContext('2d');
  charts['donut'] = new Chart(ctx, {
    type: 'doughnut',
    data: {
      labels,
      datasets: [{ data: values, backgroundColor: colors,
                   borderColor:'#24243A', borderWidth:2, hoverOffset:4 }]
    },
    options: {
      responsive: true, maintainAspectRatio: false, animation: false, cutout: '60%',
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
  const suffix = chunk === 'daily' ? '/day' : chunk === 'weekly' ? '/week' : chunk === 'monthly' ? '/month' : '';
  document.getElementById('goal-target-label').textContent =
    metric === 'time_seconds' ? `Target (hours${suffix})` : `Target (characters${suffix})`;
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

async function loadGoals() {
  await populateGoalActivitySelect();
  const goals = await window.pywebview.api.get_goals();
  const list  = document.getElementById('goal-list');
  list.innerHTML = '';
  if (!goals.length) {
    list.innerHTML = '<p class="empty-msg">No goals yet. Add one above.</p>'; return;
  }
  const active   = goals.filter(g => !g.is_complete && !g.is_overdue);
  const complete = goals.filter(g => g.is_complete);
  const overdue  = goals.filter(g => g.is_overdue);
  [...active, ...overdue, ...complete].forEach(g => list.appendChild(makeGoalCard(g)));
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
  const fillColor = g.is_complete ? '#4ECBA0'
                  : g.is_overdue  ? '#FF6B6B'
                  : pct >= 75     ? '#5B8CFF'
                  : pct >= 40     ? '#FF9F5B'
                  :                 '#FF6B6B';

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
    if (goalPaceView === 'daily') {
      chunkNeeded   = g.remaining / g.days_left;
      originalChunk = g.target / Math.max(1, g.total_days);
      periodDone    = g.today_completed || 0;
      periodLabel   = 'Today';
      periodUnit    = '/day';
    } else if (goalPaceView === 'weekly') {
      chunkNeeded   = g.remaining / Math.max(0.01, g.days_left / 7);
      originalChunk = g.target / Math.max(1, g.total_days / 7);
      periodDone    = g.week_completed || 0;
      periodLabel   = 'This week';
      periodUnit    = '/week';
    } else {
      chunkNeeded   = g.remaining / Math.max(0.01, g.days_left / 30.44);
      originalChunk = g.target / Math.max(1, g.total_days / 30.44);
      periodDone    = g.month_completed || 0;
      periodLabel   = 'This month';
      periodUnit    = '/month';
    }
    const behind   = chunkNeeded > originalChunk * 1.05;
    const ahead    = chunkNeeded < originalChunk * 0.95;
    const icon     = behind ? '⚠' : ahead ? '↓' : '→';
    const color    = behind ? '#FF9F5B' : ahead ? '#4ECBA0' : 'var(--dim)';
    const periodPct = chunkNeeded > 0 ? Math.min(100, periodDone / chunkNeeded * 100) : 0;
    const barColor  = periodPct >= 100 ? '#4ECBA0' : '#5B8CFF';
    chunkHtml = `
      <div class="goal-chunk" style="color:${color}">
        <span>${icon} ${fmtMetric(chunkNeeded)}${periodUnit} to finish on time</span>
      </div>
      <div class="daily-bar-row">
        <span class="daily-bar-label">${periodLabel} ${fmtMetric(periodDone)} / ${fmtMetric(chunkNeeded)}</span>
        <div class="daily-bar-track">
          <div class="daily-bar-fill" style="width:${periodPct}%;background:${barColor}"></div>
        </div>
      </div>`;
  } else if (g.is_overdue) {
    chunkHtml = `<div class="goal-chunk" style="color:#FF6B6B">Missed deadline — ${fmtMetric(g.remaining)} still remaining</div>`;
  }

  const actLabel = g.activity_type ? ` · ${g.activity_type}` : '';

  el.innerHTML = `
    <div class="goal-card-header">
      <span class="goal-label">${g.label}</span>
      <div class="goal-badges">
        ${statusBadge}
        <button class="btn btn-xs btn-danger" onclick="doDeleteGoal(${g.id})">✕</button>
      </div>
    </div>
    <div class="progress-track">
      <div class="progress-fill" style="width:${pct}%;background:${fillColor}"></div>
    </div>
    <div class="goal-meta">
      <span class="goal-numbers">${fmtMetric(g.completed)} / ${fmtMetric(g.target)}${actLabel}</span>
      <span class="goal-pct" style="color:${fillColor}">${g.is_complete ? '100%' : pct + '%'}</span>
    </div>
    ${chunkHtml}
    <div style="font-size:10px;color:var(--muted)">deadline: ${g.deadline} · started: ${g.start_date}</div>`;
  return el;
}

function toggleGoalForm() {
  const card = document.getElementById('goal-form-card');
  card.style.display = card.style.display === 'none' ? 'block' : 'none';
}

async function doAddGoal() {
  const label       = document.getElementById('goal-label').value.trim();
  const metric      = document.getElementById('goal-metric').value;
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
  if (deadline <= today()) {
    fb.className = 'feedback err'; fb.textContent = 'Deadline must be a future date.'; return;
  }

  let target = metric === 'time_seconds' ? rawTarget * 3600 : rawTarget;

  if (chunkPeriod !== 'none') {
    const daysUntil = Math.round((new Date(deadline) - new Date(today())) / 86400000);
    const periods   = chunkPeriod === 'weekly' ? Math.ceil(daysUntil / 7) : chunkPeriod === 'monthly' ? Math.ceil(daysUntil / 30.44) : daysUntil;
    if (periods < 1) {
      fb.className = 'feedback err'; fb.textContent = 'Deadline is too soon for that pace.'; return;
    }
    target *= periods;
  }

  const r = await window.pywebview.api.add_goal(label, metric, target, deadline, chunkPeriod, atype);
  if (r.ok) {
    document.getElementById('goal-form-card').style.display = 'none';
    document.getElementById('goal-label').value    = '';
    document.getElementById('goal-target').value   = '';
    document.getElementById('goal-deadline').value = '';
    statsCache = {};
    await loadGoals();
  } else {
    fb.className = 'feedback err'; fb.textContent = r.error || 'Error';
  }
}

async function doDeleteGoal(id) {
  const r = await window.pywebview.api.delete_goal(id);
  if (r.ok) await loadGoals();
}

// ── Media (grid) ────────────────────────────────────────────────────────────
async function loadMedia() {
  destroyChart('detail');
  destroyChart('detail-time');
  currentDetailTitle = null;
  currentSeriesId    = null;
  document.getElementById('media-grid-view').style.display   = 'block';
  document.getElementById('media-detail-view').style.display  = 'none';
  document.getElementById('media-series-view').style.display  = 'none';

  [mediaAllData, seriesData] = await Promise.all([
    window.pywebview.api.get_media(),
    window.pywebview.api.get_series(),
  ]);
  const nonManualCount = mediaAllData.filter(m => m.source !== 'manual').length;
  document.getElementById('media-count').textContent = `${nonManualCount} titles`;
  renderMediaGrid();
}

function renderMediaGrid() {
  const grid = document.getElementById('media-grid');

  // Titles that belong to a series — hidden as standalone cards
  const inSeries = new Set(seriesData.flatMap(s => s.members.map(m => m.title)));

  const filtered = mediaAllData.filter(m => m.source !== 'manual');

  grid.innerHTML = '';

  // Series cards first (always shown regardless of filter)
  seriesData.forEach(s => grid.appendChild(makeSeriesCard(s)));

  // Then ungrouped individual cards
  const ungrouped = filtered.filter(m => !inSeries.has(m.title));
  if (!ungrouped.length && !seriesData.length) {
    grid.innerHTML = '<p class="empty-msg">No media found.</p>'; return;
  }
  ungrouped.forEach(m => grid.appendChild(makeMediaCard(m)));
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
  document.getElementById('media-grid-view').style.display  = 'none';
  document.getElementById('media-series-view').style.display = 'block';
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

  // Inline member list
  const membersEl = document.getElementById('series-detail-members');
  membersEl.innerHTML = '';
  s.members.forEach(m => {
    const row = document.createElement('div');
    row.className = 'series-member-row';
    const thumb = m.image
      ? `<img src="${m.image}" alt="${escHtml(m.display_title)}">`
      : (m.display_title || '?')[0].toUpperCase();
    row.innerHTML = `
      <div class="series-member-mini-thumb">${thumb}</div>
      <span class="series-member-mini-title">${escHtml(m.display_title || m.title)}</span>
      <button class="btn btn-xs btn-danger series-remove-btn" title="Remove from series">✕</button>`;
    const openDetail = e => { e.stopPropagation(); openMediaDetail(m.title); };
    row.querySelector('.series-member-mini-thumb').addEventListener('click', openDetail);
    row.querySelector('.series-member-mini-title').addEventListener('click', openDetail);
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
  let totalSecs = 0, totalChars = 0, totalCards = 0;
  const allDates = new Set();
  const dailyMap = {};
  memberDetails.forEach(d => {
    totalSecs  += d.total_secs  || 0;
    totalChars += d.total_chars || 0;
    totalCards += d.total_cards || 0;
    (d.daily || []).forEach(row => {
      allDates.add(row.date);
      if (!dailyMap[row.date]) dailyMap[row.date] = { date: row.date, chars: 0, seconds: 0 };
      dailyMap[row.date].chars   += row.chars;
      dailyMap[row.date].seconds += row.seconds;
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

  // Stat cards
  const statsEl = document.getElementById('series-detail-stats');
  const hasMining = totalCards > 0;
  statsEl.style.gridTemplateColumns = hasMining ? 'repeat(5,1fr)' : 'repeat(4,1fr)';
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
      <div class="label">Days Read</div>
      <div class="value" style="color:var(--purple);font-size:22px">${daysCount}</div>
      <div class="sub">${firstDate} → ${lastDate}</div>
    </div>
    ${hasMining ? `
    <div class="stat-card">
      <div class="label">Cards mined</div>
      <div class="value" style="color:var(--purple);font-size:22px">${totalCards}</div>
    </div>` : ''}
  `;

  renderSeriesCharts(daily);
}

function renderSeriesCharts(daily) {
  destroyChart('series-chars');
  destroyChart('series-time');
  if (!daily.length) return;

  const labels      = daily.map(r => r.date.slice(5));
  const charVals    = daily.map(r => r.chars);
  const timeVals    = daily.map(r => r.seconds);
  const step        = Math.max(1, Math.floor(labels.length / 14));
  const shownLabels = labels.map((l, i) => i % step === 0 ? l : '');

  if (charVals.some(v => v > 0)) {
    const ctx = document.getElementById('chart-series-chars').getContext('2d');
    charts['series-chars'] = new Chart(ctx, {
      type: 'bar',
      data: { labels: shownLabels, datasets: [{
        label: 'Characters', data: charVals, backgroundColor: '#5B8CFF',
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
        label: 'Time', data: timeVals.map(s => s / 60), backgroundColor: '#7C5CBF',
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
}

function closeSeriesDetail() {
  destroyChart('series-chars');
  destroyChart('series-time');
  currentSeriesId = null;
  document.getElementById('media-series-view').style.display = 'none';
  document.getElementById('media-grid-view').style.display   = 'block';
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

  document.getElementById('media-grid-view').style.display  = 'none';
  document.getElementById('media-detail-view').style.display = 'block';
  renderMediaDetail(detail);
}

function closeMediaDetail() {
  destroyChart('detail');
  destroyChart('detail-time');
  currentDetailTitle = null;
  document.getElementById('media-detail-view').style.display  = 'none';
  // If we came from a series view, go back to it; otherwise go to grid
  if (currentSeriesId !== null) {
    const s = seriesData.find(x => x.id === currentSeriesId);
    if (s) { openSeriesDetail(currentSeriesId); return; }
  }
  document.getElementById('media-grid-view').style.display = 'block';
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

  // Description
  const descEl = document.getElementById('detail-desc');
  if (d.description) {
    descEl.textContent = d.description;
    descEl.style.display = 'block';
  } else {
    descEl.style.display = 'none';
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

  // Stats grid — always show 4 base cards; add cards mined if present
  const statsGrid = document.getElementById('detail-stats-grid');
  const hasMining = isGSM && d.total_cards > 0;
  statsGrid.style.gridTemplateColumns = hasMining ? 'repeat(5,1fr)' : 'repeat(4,1fr)';

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
      <div class="label">Days Read</div>
      <div class="value" style="color:var(--purple);font-size:22px">${d.days_count}</div>
      <div class="sub">${d.first_date} → ${d.last_date}</div>
    </div>
    ${hasMining ? `
    <div class="stat-card">
      <div class="label">Cards mined</div>
      <div class="value" style="color:var(--purple);font-size:22px">${d.total_cards}</div>
    </div>` : ''}
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
  if (!daily.length) return;

  const n = daily.length;
  let labels, charVals, speedVals, timeVals;

  if (n > 90) {
    const wb = {}, tb = {}, sb = {}, sc = {};
    daily.forEach(({ date: dt, chars: c, seconds: sec, speed: sp }) => {
      const d  = new Date(dt);
      const wk = `${d.getFullYear()}-W${String(Math.ceil(
        (d.getDate() + new Date(d.getFullYear(), 0, 1).getDay()) / 7
      )).padStart(2,'0')}`;
      wb[wk] = (wb[wk] || 0) + c;
      tb[wk] = (tb[wk] || 0) + sec;
      if (sp > 0) { sb[wk] = (sb[wk] || 0) + sp; sc[wk] = (sc[wk] || 0) + 1; }
    });
    const agg = Object.entries(wb).sort();
    labels    = agg.map(([k]) => k);
    charVals  = agg.map(([k]) => wb[k]);
    timeVals  = agg.map(([k]) => tb[k]);
    speedVals = agg.map(([k]) => sc[k] ? sb[k] / sc[k] : 0);
  } else {
    labels    = daily.map(r => r.date.slice(5));
    charVals  = daily.map(r => r.chars);
    timeVals  = daily.map(r => r.seconds);
    speedVals = daily.map(r => r.speed || 0);
  }

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
        backgroundColor: '#5B8CFF',
        borderRadius: 3,
        borderSkipped: false,
      }]
    },
    options: {
      responsive: true, maintainAspectRatio: false, animation: false,
      plugins: {
        legend: { display: false },
        tooltip: { callbacks: { label: c => `${fmtChars(c.raw)} chars` } }
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
      options: {
        responsive: true, maintainAspectRatio: false, animation: false,
        plugins: {
          legend: { display: false },
          tooltip: {
            callbacks: { label: c => c.raw != null ? `${fmtChars(Math.round(c.raw))}/h` : '' }
          }
        },
        scales: {
          x: { grid:{color:'#2E2E48'}, ticks:{color:'#9090A8',maxRotation:0} },
          y: { grid:{color:'#2E2E48'}, ticks:{color:'#4ECBA0', callback: v => fmtChars(v)}, beginAtZero: false, afterFit: s => { s.width = 62; } },
        },
      }
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
          backgroundColor: '#7C5CBF',
          borderRadius: 3,
          borderSkipped: false,
        }]
      },
      options: {
        responsive: true, maintainAspectRatio: false, animation: false,
        plugins: {
          legend: { display: false },
          tooltip: { callbacks: { label: c => fmtTime(c.raw * 60) } }
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
    const cardsHTML = (isGSM && s.cards > 0)
      ? `<span class="dsr-cards">${s.cards} cards</span>`
      : (isGSM ? `<span class="dsr-cards" style="color:var(--muted)">0 cards</span>` : '');

    row.innerHTML = `
      <span class="dsr-date">${s.date}</span>
      <span class="dsr-time">${fmtTime(s.seconds)}</span>
      <span class="dsr-chars">${s.chars > 0 ? fmtChars(s.chars) + ' chars' : ''}</span>
      ${speedHTML}
      ${cardsHTML}
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
  document.getElementById('ext-port').value            = s.ext_port  || 18463;
  document.getElementById('ext-token').value           = s.ext_token || '';
  const theme = s.theme || 'dark';
  document.querySelectorAll('.theme-opt').forEach(el =>
    el.classList.toggle('selected', el.dataset.theme === theme));
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
  const rollover = parseInt(document.getElementById('rollover-hour').value) || 0;
  const gsm_url  = document.getElementById('gsm-url').value.trim();
  appSettings = { ...appSettings, rollover_hour: rollover, gsm_url };
  await window.pywebview.api.save_settings({ rollover_hour: rollover, gsm_url });
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
}

if (window.pywebview) {
  init();
} else {
  window.addEventListener('pywebviewready', init);
}
