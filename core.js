// Beldex Masternode Monitor — Client App v2
const API = '';

// ── CSRF protection ──
// _csrf is fetched once on page load and injected automatically into all
// mutating fetch calls (POST/PUT/DELETE/PATCH) via the patched window.fetch below.
let _csrf = null;

// Patch window.fetch to auto-inject X-CSRF-Token on mutating API requests.
// Uses _origFetch for the /api/csrf-token call itself to avoid recursion.
const _origFetch = window.fetch.bind(window);
window.fetch = function(url, opts) {
  opts = opts || {};
  const method = (opts.method || 'GET').toUpperCase();
  if (_csrf && typeof url === 'string' && url.startsWith(API + '/api') &&
      ['POST','PUT','DELETE','PATCH'].includes(method)) {
    opts.headers = Object.assign({}, opts.headers, { 'X-CSRF-Token': _csrf });
  }
  return _origFetch(url, opts);
};

async function initCsrf() {
  try {
    const r = await _origFetch(API + '/api/csrf-token');
    if (r.ok) { const d = await r.json(); _csrf = d.token; }
  } catch(e) { /* non-fatal - server will 403 mutating calls until resolved */ }
}

const escHtml = s => String(s).replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;');
const shortKey = (pk, l=16) => pk.length > l ? pk.slice(0,8)+'...'+pk.slice(-4) : pk;
const fmtBdx = n => Number(n || 0).toLocaleString('en-US', {
  minimumFractionDigits: 4,
  maximumFractionDigits: 4
});
const today = () => new Date().toISOString().slice(0,10);
const MAX_REPORT_RANGE_DAYS = 366;
const MAX_MANUAL_SCAN_BLOCKS = 100000;
let scanPoll = null, statusPoll = null, _scanRunning = false;

function rangeDaysInclusive(from, to) {
  if (!from || !to) return null;
  return Math.floor((new Date(to + 'T00:00:00Z') - new Date(from + 'T00:00:00Z')) / 86400000) + 1;
}

function validateUiDateRange(from, to, label, maxDays = MAX_REPORT_RANGE_DAYS) {
  const days = rangeDaysInclusive(from, to);
  if (!days || days < 1) {
    showToast(`${label}: invalid date range`, 'warning');
    return false;
  }
  if (days > maxDays) {
    showToast(`${label}: maximum ${maxDays} days`, 'warning', 5000);
    return false;
  }
  return true;
}

async function apiJson(url, opts) {
  const resp = await fetch(url, opts);
  let data = null;
  try { data = await resp.json(); } catch (_) {}
  if (!resp.ok) {
    throw new Error((data && data.error) || `Server returned ${resp.status}`);
  }
  return data;
}

function normalizeWalletName(name) {
  return name ? String(name) : 'Ungrouped';
}

function computeTrendPct(current, previous) {
  if (previous === null || previous === undefined) return null;
  if (previous === 0) return current === 0 ? 0 : null;
  return ((current - previous) / previous) * 100;
}

function renderTrendHtml(current, previous, label) {
  const pct = computeTrendPct(current, previous);
  if (pct === null) return `<div class="xpi-trend xpi-trend-flat">No prior ${label}</div>`;
  if (pct === 0) return `<div class="xpi-trend xpi-trend-flat">0.0% vs previous ${label}</div>`;
  const up = pct > 0;
  return `<div class="xpi-trend" style="color:${up ? 'var(--green)' : 'var(--red)'}">${up ? '▲' : '▼'} ${Math.abs(pct).toFixed(1)}% vs previous ${label}</div>`;
}

// ── State ──
let _allNodes = [];
let _nodesPage = 1;
const NODES_PER_PAGE = 50;
let _nodesFilter = '';
let _sortState = {};
let _perkeyAllData = [];
const _pagOrig = {}; // pagId → original full dataset before search filtering

// ══════════════════════════════════════════════
// ── Universal Pagination Engine ──
// ══════════════════════════════════════════════
const _pag = {}; // id → { data, page, pageSize, renderer, wrapId }

function pagInit(id, data, pageSize, renderer, wrapId) {
  _pag[id] = { data, page: 1, pageSize, renderer, wrapId };
  _pagOrig[id] = data; // save original for search filtering
  pagRender(id);
}

// Re-render with filtered data without overwriting _pagOrig
function pagInitFiltered(id, data) {
  if (!_pag[id]) return;
  _pag[id].data = data;
  _pag[id].page = 1;
  pagRender(id);
}

function pagGo(id, page) {
  if (!_pag[id]) return;
  _pag[id].page = page;
  pagRender(id);
}

function pagSetSize(id, size) {
  if (!_pag[id]) return;
  _pag[id].pageSize = +size;
  _pag[id].page = 1;
  pagRender(id);
}

function pagRender(id) {
  const s = _pag[id];
  if (!s) return;
  const wrap = document.getElementById(s.wrapId);
  if (!wrap) return;
  const { data, pageSize, renderer } = s;
  const total = data.length;
  if (!total) { wrap.innerHTML = ''; return; }
  const totalPages = Math.max(1, Math.ceil(total / pageSize));
  s.page = Math.min(Math.max(1, s.page), totalPages);
  const start = (s.page - 1) * pageSize;
  const end = Math.min(start + pageSize, total);
  wrap.innerHTML = renderer(data.slice(start, end), start) + pagBarHtml(id, s.page, totalPages, total, start, end, pageSize);
}

function pagBarHtml(id, page, totalPages, total, start, end, pageSize) {
  const sizes = [10, 25, 50, 100];
  const nums = [];
  if (totalPages <= 7) {
    for (let i = 1; i <= totalPages; i++) nums.push(i);
  } else {
    nums.push(1);
    if (page > 3) nums.push('…');
    for (let i = Math.max(2, page - 1); i <= Math.min(totalPages - 1, page + 1); i++) nums.push(i);
    if (page < totalPages - 2) nums.push('…');
    nums.push(totalPages);
  }
  return '<div class="pag-bar">' +
    '<span class="pag-info">Showing ' + (start + 1) + ' – ' + end + ' of ' + total + '</span>' +
    '<div class="pag-nav">' +
      '<button class="pag-btn" ' + (page === 1 ? 'disabled' : '') + ' data-action="pag-go" data-pag-id="' + escHtml(id) + '" data-page="' + (page - 1) + '">‹</button>' +
      nums.map(function(n) { return n === '…'
        ? '<span class="pag-ellipsis">···</span>'
        : '<button class="pag-btn' + (n === page ? ' pag-active' : '') + '" data-action="pag-go" data-pag-id="' + escHtml(id) + '" data-page="' + n + '">' + n + '</button>';
      }).join('') +
      '<button class="pag-btn" ' + (page === totalPages ? 'disabled' : '') + ' data-action="pag-go" data-pag-id="' + escHtml(id) + '" data-page="' + (page + 1) + '">›</button>' +
    '</div>' +
    '<label class="pag-size-label">Show rows' +
      '<select class="pag-size-sel" data-action="pag-size" data-pag-id="' + escHtml(id) + '">' +
        sizes.map(function(s) { return '<option value="' + s + '"' + (s === pageSize ? ' selected' : '') + '>' + s + '</option>'; }).join('') +
      '</select>' +
    '</label>' +
  '</div>';
}

// ══════════════════════════════════════════════
// ── Search Helpers ──
// ══════════════════════════════════════════════

// Insert a search bar before the pag-wrap (outside it so it survives page changes).
// If pagId is provided, search filters the full dataset and re-paginates.
function addReportSearch(containerId, pagId) {
  const container = document.getElementById(containerId);
  if (!container || container.querySelector('.report-search-bar')) return;
  // Insert before the pag-wrap so pagRender never wipes the search bar
  const pagWrap = pagId
    ? document.getElementById(_pag[pagId] ? _pag[pagId].wrapId : pagId + '-pag-wrap')
    : container.querySelector('[id$="-pag-wrap"]');
  const bar = document.createElement('div');
  bar.className = 'report-search-bar';
  const attrs = pagId
    ? 'data-action="pag-search" data-pag-id="' + escHtml(pagId) + '"'
    : 'data-action="report-table-search" data-container-id="' + escHtml(containerId) + '"';
  bar.innerHTML = '<input type="text" class="input input-sm" placeholder="Search…" style="width:260px" ' + attrs + ' />' +
    '<span class="muted report-search-count" style="font-size:11px"></span>';
  if (pagWrap && pagWrap.parentNode) {
    pagWrap.parentNode.insertBefore(bar, pagWrap);
  } else {
    container.appendChild(bar);
  }
}

// Filters the full dataset for a paginated report and re-paginates from page 1.
// Searches all string fields in each row object, plus any title attributes in rendered rows.
function filterPagSearch(input, pagId) {
  if (!_pag[pagId] || !_pagOrig[pagId]) return;
  const q = input.value.trim().toLowerCase();
  const orig = _pagOrig[pagId];
  const filtered = q
    ? orig.filter(function(r) {
        var label = (r.label || '').toLowerCase();
        var wallet = (r.wallet_name || '').toLowerCase();
        if (label.includes(q) || wallet.includes(q)) return true;
        if (q.length >= 8) {
          var pubkey = (r.pubkey || '').toLowerCase();
          var addr = (r.wallet_address || '').toLowerCase();
          if (pubkey.includes(q) || addr.includes(q)) return true;
        }
        return false;
      })
    : orig;
  const countEl = input.parentNode.querySelector('.report-search-count');
  if (countEl) countEl.textContent = q ? (filtered.length + ' of ' + orig.length) : '';
  pagInitFiltered(pagId, filtered);
}

// Fallback DOM-level search (used for matrix and other non-paginated tables).
// Also checks title attributes so full pubkeys are searchable even when truncated in display.
function filterReportTableRows(input, containerId) {
  const container = document.getElementById(containerId);
  if (!container) return;
  const q = input.value.trim().toLowerCase();
  const rows = container.querySelectorAll('table tbody tr');
  let visible = 0;
  rows.forEach(function(row) {
    const text = row.textContent.toLowerCase();
    const titles = Array.from(row.querySelectorAll('[title]')).map(function(el) { return el.getAttribute('title').toLowerCase(); }).join(' ');
    const match = !q || text.includes(q) || titles.includes(q);
    row.style.display = match ? '' : 'none';
    if (match) visible++;
  });
  const countEl = input.parentNode.querySelector('.report-search-count');
  if (countEl) countEl.textContent = q ? (visible + ' of ' + rows.length) : '';
}

// Card grid search — for By Wallet
function addCardSearch(containerId, cardSelector) {
  const container = document.getElementById(containerId);
  if (!container || container.querySelector('.report-search-bar')) return;
  const bar = document.createElement('div');
  bar.className = 'report-search-bar';
  bar.innerHTML = '<input type="text" class="input input-sm" placeholder="Search wallets…" style="width:240px" data-action="card-search" data-container-id="' + escHtml(containerId) + '" data-card-selector="' + escHtml(cardSelector) + '" />' +
    '<span class="muted report-search-count" style="font-size:11px"></span>';
  container.insertBefore(bar, container.firstChild);
}

function filterCards(input, containerId, cardSelector) {
  const container = document.getElementById(containerId);
  if (!container) return;
  const q = input.value.trim().toLowerCase();
  const cards = container.querySelectorAll(cardSelector);
  let visible = 0;
  cards.forEach(function(card) {
    const match = !q || card.textContent.toLowerCase().includes(q);
    card.style.display = match ? '' : 'none';
    if (match) visible++;
  });
  const countEl = input.parentNode.querySelector('.report-search-count');
  if (countEl) countEl.textContent = q ? (visible + ' / ' + cards.length + ' wallets') : '';
}

// ══════════════════════════════════════════════
// ── Toast Notifications ──
// ══════════════════════════════════════════════
const TOAST_ICONS = { success:'✓', error:'✕', warning:'⚠', info:'ℹ' };
function showToast(message, type='info', duration=3500) {
  const container = document.getElementById('toast-container');
  const toast = document.createElement('div');
  toast.className = `toast toast-${type}`;
  toast.innerHTML = `<span class="toast-icon">${TOAST_ICONS[type]||'ℹ'}</span><span>${escHtml(message)}</span>`;
  container.appendChild(toast);
  setTimeout(() => {
    toast.classList.add('toast-exit');
    setTimeout(() => toast.remove(), 300);
  }, duration);
}

// ══════════════════════════════════════════════
// ── Animated Counter ──
// ══════════════════════════════════════════════
function animateCounter(el, target, duration=700, decimals=0) {
  if (typeof el === 'string') el = document.getElementById(el);
  if (!el) return;
  const formatValue = value => Number(value || 0).toLocaleString('en-US', {
    minimumFractionDigits: decimals,
    maximumFractionDigits: decimals
  });
  const start = parseFloat(String(el.textContent || '').replace(/,/g, '')) || 0;
  if (start === target) { el.textContent = decimals ? formatValue(target) : Math.round(target).toLocaleString('en-US'); return; }
  const startTime = performance.now();
  function update(now) {
    const p = Math.min((now - startTime) / duration, 1);
    const eased = 1 - Math.pow(1 - p, 3);
    const val = start + (target - start) * eased;
    el.textContent = decimals ? formatValue(val) : Math.round(val).toLocaleString('en-US');
    if (p < 1) requestAnimationFrame(update);
  }
  requestAnimationFrame(update);
}

// ══════════════════════════════════════════════
// ── Copy to Clipboard ──
// ══════════════════════════════════════════════
async function copyToClipboard(text, btn) {
  try {
    await navigator.clipboard.writeText(text);
    if (btn) { btn.classList.add('copied'); setTimeout(() => btn.classList.remove('copied'), 1500); }
    showToast('Copied to clipboard', 'success', 2000);
  } catch(e) {
    // Fallback
    const ta = document.createElement('textarea'); ta.value = text; ta.style.position = 'fixed'; ta.style.opacity = '0';
    document.body.appendChild(ta); ta.select(); document.execCommand('copy'); ta.remove();
    showToast('Copied to clipboard', 'success', 2000);
  }
}

// ══════════════════════════════════════════════
// ── Skeleton Loader ──
// ══════════════════════════════════════════════
function showSkeleton(containerId, rows=4) {
  const el = document.getElementById(containerId);
  if (!el) return;
  el.innerHTML = Array.from({length:rows}, () => '<div class="skeleton skeleton-row"></div>').join('');
}

// ══════════════════════════════════════════════
// ══════════════════════════════════════════════
// ── Sidebar Toggle ──
// ══════════════════════════════════════════════
let _mobileWasCollapsed = false;

function _openMobileSidebar(sidebar, overlay) {
  _mobileWasCollapsed = sidebar.classList.contains('collapsed');
  sidebar.classList.remove('collapsed');
  sidebar.classList.add('mobile-open');
  overlay?.classList.add('active');
}

function _closeMobileSidebar(sidebar, overlay) {
  sidebar.classList.remove('mobile-open');
  overlay?.classList.remove('active');
  if (_mobileWasCollapsed) sidebar.classList.add('collapsed');
}

function toggleSidebar() {
  const sidebar = document.querySelector('.sidebar');
  const overlay = document.getElementById('sidebar-overlay');
  if (window.innerWidth <= 768) {
    // Mobile: toggle drawer
    const isOpen = sidebar.classList.contains('mobile-open');
    if (isOpen) _closeMobileSidebar(sidebar, overlay);
    else _openMobileSidebar(sidebar, overlay);
  } else {
    // Desktop: toggle collapsed
    const btn = document.getElementById('sidebar-toggle');
    sidebar.classList.toggle('collapsed');
    const collapsed = sidebar.classList.contains('collapsed');
    document.documentElement.style.setProperty('--sidebar-w', collapsed ? '60px' : '220px');
    if (btn) btn.title = collapsed ? 'Expand sidebar' : 'Collapse sidebar';
    localStorage.setItem('sidebar-collapsed', collapsed);
  }
}



// ── Scroll to Analytics section ──
var _analyticsLoaded = {};
function scrollToAnalytics(sectionId, btn) {
  var el = document.getElementById(sectionId);
  if (el) el.scrollIntoView({ behavior: 'smooth', block: 'start' });
  document.querySelectorAll('.analytics-nav-btn').forEach(function(b) { b.classList.remove('active'); });
  if (btn) btn.classList.add('active');
  // Lazy-load sections that aren't auto-loaded on tab open
  if (!_analyticsLoaded[sectionId]) {
    _analyticsLoaded[sectionId] = true;
    if (sectionId === 'nethistory-section') loadNetworkHistory();
  }
}

// ── Analytics table search/filter ──
function filterAnalyticsTable(containerId, inputId) {
  var q = document.getElementById(inputId).value.toLowerCase();
  var container = document.getElementById(containerId);
  if (!container) return;
  var pagMap = {
    'anomaly-table': {
      id: 'anomaly',
      data: _pagOrig.anomaly || [],
      filter: function(n, term) {
        return !term ||
          (n.label || '').toLowerCase().includes(term) ||
          (n.wallet_name || '').toLowerCase().includes(term) ||
          (n.pubkey || '').toLowerCase().includes(term) ||
          String(n.last_reward || '').toLowerCase().includes(term);
      }
    },
    'lowperf-content': {
      id: 'lowperf',
      data: _pagOrig.lowperf || [],
      filter: function(n, term) {
        return !term ||
          (n.label || '').toLowerCase().includes(term) ||
          (n.wallet_name || '').toLowerCase().includes(term) ||
          (n.pubkey || '').toLowerCase().includes(term) ||
          (n.level || '').toLowerCase().includes(term);
      }
    }
  };
  if (pagMap[containerId]) {
    var cfg = pagMap[containerId];
    var filtered = cfg.data.filter(function(row) { return cfg.filter(row, q); });
    pagInitFiltered(cfg.id, filtered);
    return;
  }
  var rows = container.querySelectorAll('tbody tr');
  rows.forEach(function(row) {
    var text = row.textContent.toLowerCase();
    row.style.display = text.includes(q) ? '' : 'none';
  });
}

// ── Node Health Matrix search/filter ──
function filterNHM(query) {
  var q = String(query || '').trim().toLowerCase();
  var grid = document.getElementById('node-health-matrix');
  if (!grid) return;
  var tiles = grid.querySelectorAll('.nhm-tile');
  var visible = 0;
  tiles.forEach(function(tile) {
    var text = [
      tile.dataset.search || '',
      tile.dataset.pubkey || '',
      tile.getAttribute('title') || '',
      tile.textContent || ''
    ].join(' ').toLowerCase();
    var show = !q || text.includes(q);
    tile.style.display = show ? '' : 'none';
    if (show) visible++;
  });
  var countEl = document.getElementById('nhm-count');
  if (countEl) countEl.textContent = q ? visible + ' matching' : tiles.length + ' nodes';
  var empty = document.getElementById('nhm-empty');
  if (!empty) {
    empty = document.createElement('div');
    empty.id = 'nhm-empty';
    empty.className = 'nhm-empty';
    empty.textContent = 'No node found for this search.';
    grid.after(empty);
  }
  empty.style.display = q && visible === 0 ? '' : 'none';
}

let _userRole = 'admin';
function isViewer() { return _userRole === 'viewer'; }

async function initRole() {
  try {
    const r = await _origFetch('/api/me');
    if (r.ok) { const d = await r.json(); _userRole = d.role || 'admin'; }
  } catch(e) {}
  if (_userRole === 'viewer') document.body.classList.add('viewer-mode');
}

document.addEventListener('DOMContentLoaded', () => {
  initCsrf();
  initRole();
  // Sidebar always starts expanded — clicking collapsed sidebar also expands it
  try { localStorage.removeItem('sidebar-collapsed'); } catch(e) {}
  document.documentElement.style.setProperty('--sidebar-w', '220px');
  const sidebar = document.querySelector('.sidebar');
  if (sidebar) {
    sidebar.addEventListener('click', (e) => {
      if (sidebar.classList.contains('collapsed') && !e.target.closest('.nav-item') && !e.target.closest('.logout-btn') && !e.target.closest('.sidebar-toggle')) {
        toggleSidebar();
      }
    });
  }

  // Mobile sidebar overlay close
  const sidebarOverlay = document.getElementById('sidebar-overlay');
  if (sidebarOverlay) {
    sidebarOverlay.addEventListener('click', () => {
      _closeMobileSidebar(sidebar, sidebarOverlay);
    });
  }

  // Mobile menu button opens sidebar drawer
  const mobileMenuBtn = document.getElementById('mobile-menu-btn');
  if (mobileMenuBtn) {
    mobileMenuBtn.addEventListener('click', () => {
      _openMobileSidebar(sidebar, sidebarOverlay);
    });
  }

  // Restore collapsed sidebar state on desktop only
  if (window.innerWidth > 768) {
    const savedCollapsed = localStorage.getItem('sidebar-collapsed') === 'true';
    if (savedCollapsed) document.querySelector('.sidebar')?.classList.add('collapsed');
  }

  document.getElementById('scan-date').value = today();
  const firstOfMonth = new Date(); firstOfMonth.setDate(1);
  document.getElementById('scan-from-date').value = firstOfMonth.toISOString().slice(0,10);
  document.getElementById('scan-to-date').value = today();
  document.getElementById('report-daily-date').value = today();
  const now = new Date();
  document.getElementById('report-year').value = now.getFullYear();
  document.getElementById('report-month').value = now.getMonth() + 1;
  const d = new Date(); d.setDate(1);
  document.getElementById('report-from').value = d.toISOString().slice(0,10);
  document.getElementById('report-to').value = today();
  document.getElementById('grouped-from').value = firstOfMonth.toISOString().slice(0,10);
  document.getElementById('grouped-to').value = today();
  document.getElementById('matrix-from').value = firstOfMonth.toISOString().slice(0,10);
  document.getElementById('matrix-to').value = today();
  const lbFrom = document.getElementById('lb-from');
  const lbTo = document.getElementById('lb-to');
  if (lbFrom) lbFrom.value = firstOfMonth.toISOString().slice(0,10);
  if (lbTo) lbTo.value = today();
  requestNotificationPermission();
  renderGroupImportGrid();
  loadDashboard();
  loadNetworkStats();
  loadLastScanInfo();
  loadResumeInfo();
  loadSchedulerStatus();
  loadScanHistory();
  loadExplorerStatus();
  checkStuckScan();
  loadScanCoverage();
  loadBdxPrice();
  setInterval(loadNetworkStats, 60000);
  setInterval(loadBdxPrice, 300000); // refresh price every 5 min
  setInterval(() => document.getElementById('time-display').textContent = new Date().toLocaleTimeString(), 1000);
  document.querySelectorAll('.nav-item').forEach(el => el.addEventListener('click', e => { e.preventDefault(); switchTab(el.dataset.tab); }));
  normalizeOperationsCopy();
});

// ══════════════════════════════════════════════
// ── Navigation ──
// ══════════════════════════════════════════════
function switchTab(tab) {
  document.querySelectorAll('.tab-content').forEach(el => el.classList.remove('active'));
  document.querySelectorAll('.nav-item').forEach(el => el.classList.remove('active'));
  document.getElementById('tab-' + tab).classList.add('active');
  document.querySelector(`[data-tab="${tab}"]`).classList.add('active');
  // sync bottom nav
  document.querySelectorAll('.mbn-item').forEach(a => {
    a.classList.toggle('active', a.dataset.tab === tab);
  });
  // close mobile sidebar if open
  const sidebar = document.querySelector('.sidebar');
  const overlay = document.getElementById('sidebar-overlay');
  if (sidebar?.classList.contains('mobile-open')) {
    _closeMobileSidebar(sidebar, overlay);
  }
  normalizeOperationsCopy();
  const titles = {
    dashboard:'Dashboard', nodes:'Nodes', scan:'Scan Blocks', reports:'Reports',
    status:'Node Status', analytics:'Analytics', queue:'Reward Queue', database:'Database'
  };
  document.getElementById('page-title').textContent = titles[tab] || tab;
  if (tab === 'nodes') { loadNodes(); loadStreaks().then(() => renderNodesTable()); checkGroupDuplicates(); }
  if (tab === 'dashboard') loadDashboard();
  if (tab === 'scan') { loadDataQuality(); loadResumeInfo(); loadSchedulerStatus(); loadScanHistory(); loadExplorerStatus(); checkStuckScan(); loadScanCoverage(); }
  if (tab === 'status') { loadRiskSummary(); loadLatestStatus(); }
  if (tab === 'analytics') {
    normalizeAnalyticsCopy();
    loadPortfolioIntelligence();
    loadLowPerformers();
    loadNodeHealthMatrix();
    loadHeatmap();
    loadAnomalies();
    loadTopEarners();
    loadNetworkHistory();
    _analyticsLoaded['nethistory-section'] = true;
  }
  if (tab === 'database') {
    loadGaps(); loadDbDetailedStats(); loadArchiveLog();
    const pruneEl = document.getElementById('prune-date');
    if (pruneEl && !pruneEl.value) pruneEl.value = new Date().getFullYear() + '-03-01';
  }
  if (tab === 'reports') {
    const d = new Date(); d.setDate(1);
    const grouped_from = document.getElementById('grouped-from');
    const grouped_to = document.getElementById('grouped-to');
    if (grouped_from && !grouped_from.value) grouped_from.value = d.toISOString().slice(0,10);
    if (grouped_to && !grouped_to.value) grouped_to.value = today();
  }
}

function normalizeAnalyticsCopy() {
  const nhmSearch = document.getElementById('nhm-search');
  if (nhmSearch) nhmSearch.placeholder = 'Search public key, label, wallet...';
  const anomalySearch = document.getElementById('anomaly-search');
  if (anomalySearch) anomalySearch.placeholder = 'Search...';
  const nhmDesc = document.querySelector('#nhm-section .card-desc');
  if (nhmDesc) nhmDesc.textContent = "Quick overview of every node's reward status. Click a tile to open full detail.";
  const nhmLegend = document.querySelector('#nhm-section .nhm-legend');
  if (nhmLegend) {
    nhmLegend.innerHTML = [
      '<span class="nhm-legend-item"><span class="nhm-dot" style="background:var(--green)"></span>Earning normally</span>',
      '<span class="nhm-legend-item"><span class="nhm-dot" style="background:var(--amber)"></span>Waiting (1-1.5x avg)</span>',
      '<span class="nhm-legend-item"><span class="nhm-dot" style="background:var(--red)"></span>Overdue (&gt;1.5x avg)</span>',
      '<span class="nhm-legend-item"><span class="nhm-dot" style="background:var(--border2)"></span>No data</span>'
    ].join('');
  }
  const anomalyDesc = document.querySelector('#anomaly-section .card-desc');
  if (anomalyDesc) anomalyDesc.textContent = 'Nodes that have not earned in more than 1.5x their personal average wait time.';
}

function openDrillModal(title, subtitle, bodyHtml) {
  const overlay = document.getElementById('drillthrough-modal');
  if (!overlay) return;
  document.getElementById('drill-modal-title').textContent = title || 'Details';
  document.getElementById('drill-modal-subtitle').textContent = subtitle || '';
  // All user-sourced values in bodyHtml must be escaped with escHtml() before this point
  document.getElementById('drill-modal-body').innerHTML = bodyHtml || '';
  overlay.style.display = 'flex';
}

function closeDrillModal(e) {
  if (!e || e.target === e.currentTarget) {
    const overlay = document.getElementById('drillthrough-modal');
    if (overlay) overlay.style.display = 'none';
  }
}

function normalizeOperationsCopy() {
  const textMap = {
    'queue-refresh-btn': 'Scrape Queue',
    'queue-load-btn': 'Load Saved',
    'status-check-btn': 'Check All Nodes',
    'db-stats-refresh-btn': 'Refresh',
    'db-backup-btn': 'Backup DB'
  };
  Object.entries(textMap).forEach(([id, text]) => {
    const el = document.getElementById(id);
    if (el && !el.disabled) el.textContent = text;
  });

  const activeTitle = document.querySelector('.status-active-title');
  if (activeTitle) activeTitle.textContent = 'Active Nodes';
  const issueTitle = document.querySelector('.status-issue-title');
  if (issueTitle) issueTitle.textContent = 'Nodes with Issues';
}

function drillToDailyReport(date) {
  if (!date) return;
  switchTab('reports');
  const input = document.getElementById('report-daily-date');
  if (input) input.value = date;
  switchReportTab('daily');
  loadDailyReport();
}

function copyAllKeys(keys) {
  const clean = (keys || []).filter(Boolean);
  if (!clean.length) return showToast('No keys available to copy', 'warning');
  copyToClipboard(clean.join('\n'));
  showToast(`Copied ${clean.length} public keys`, 'success');
}

async function openWalletDrill(walletName, from, to, sourceLabel) {
  const wallet = normalizeWalletName(walletName);
  openDrillModal(wallet, `${sourceLabel || 'Wallet detail'} · ${from} → ${to}`, '<div class="skeleton skeleton-row" style="height:120px"></div>');
  try {
    const [reportData, nodes] = await Promise.all([
      apiJson(API + `/api/report/range?from=${from}&to=${to}`),
      apiJson(API + '/api/nodes')
    ]);

    const walletNodes = (nodes || []).filter(n => normalizeWalletName(n.wallet_name) === wallet);
    const rewardRows = (reportData.summary || []).filter(r => normalizeWalletName(r.wallet_name) === wallet);
    const rewardMap = new Map(rewardRows.map(r => [r.pubkey, r]));
    const totalBdx = rewardRows.reduce((s, r) => s + (r.total_amount || 0), 0);
    const totalRewards = rewardRows.reduce((s, r) => s + (r.reward_count || 0), 0);

    const rows = walletNodes.map(n => {
      const reward = rewardMap.get(n.pubkey);
      const rewardCount = reward ? reward.reward_count : 0;
      const totalAmount = reward ? reward.total_amount : 0;
      return {
        pubkey: n.pubkey,
        label: n.label || '-',
        reward_count: rewardCount,
        total_amount: totalAmount,
        avg_amount: rewardCount > 0 ? totalAmount / rewardCount : 0
      };
    }).sort((a, b) => (b.total_amount - a.total_amount) || a.label.localeCompare(b.label));

    const silentCount = rows.filter(r => r.reward_count === 0).length;
    const earnedCount = rows.length - silentCount;
    const coveragePct = rows.length ? Math.round(earnedCount / rows.length * 100) : 0;
    const topNode = rows.find(r => r.total_amount > 0);
    const avgPerNode = rows.length ? totalBdx / rows.length : 0;
    const bodyHtml = `
      <div class="drill-summary-grid">
        <div class="drill-stat drill-stat--nodes"><div class="drill-stat-kicker">Total</div><div class="drill-stat-val">${rows.length}</div><div class="drill-stat-label">Nodes In Wallet</div></div>
        <div class="drill-stat drill-stat--earned"><div class="drill-stat-kicker">Online</div><div class="drill-stat-val">${earnedCount}</div><div class="drill-stat-label">Nodes Earned</div></div>
        <div class="drill-stat drill-stat--silent"><div class="drill-stat-kicker">Watch</div><div class="drill-stat-val">${silentCount}</div><div class="drill-stat-label">Silent Nodes</div></div>
        <div class="drill-stat drill-stat--bdx"><div class="drill-stat-kicker">Yield</div><div class="drill-stat-val">${fmtBdx(totalBdx)}</div><div class="drill-stat-label">Wallet BDX</div></div>
      </div>
      <div class="wallet-drill-insights">
        <div class="wallet-drill-insight wallet-drill-insight--coverage"><span>Coverage</span><strong>${coveragePct}%</strong><em>${earnedCount}/${rows.length} nodes paid</em></div>
        <div class="wallet-drill-insight wallet-drill-insight--top"><span>Top node</span><strong>${topNode ? fmtBdx(topNode.total_amount) + ' BDX' : 'No rewards'}</strong><em>${topNode ? escHtml(topNode.label) : 'No earning node found'}</em></div>
        <div class="wallet-drill-insight"><span>Avg per node</span><strong>${fmtBdx(avgPerNode)} BDX</strong><em>${totalRewards} reward events</em></div>
      </div>
      ${rows.length ? `<div class="wallet-drill-toolbar"><div class="wallet-drill-count">${rows.length} public keys tracked</div><button class="btn btn-sm btn-outline wallet-copy-all" data-action="copy" data-copy-value="${escHtml(rows.map(r => r.pubkey).join('\n'))}">Copy All Keys</button></div><div class="drill-table-wrap"><table class="drill-table wallet-drill-table"><thead><tr><th>Status</th><th>Node</th><th>Public Key</th><th>Rewards</th><th>Total BDX</th><th>Avg/Reward</th><th></th></tr></thead><tbody>${
        rows.map(r => `
          <tr>
            <td><span class="wallet-status-pill ${r.reward_count === 0 ? 'wallet-status-pill--silent' : 'wallet-status-pill--earned'}">${r.reward_count === 0 ? 'Silent' : 'Earned'}</span></td>
            <td class="wallet-node-cell"><strong>${escHtml(r.label)}</strong>${r.reward_count === 0 ? ' <span class="pk-inactive-badge">SILENT</span>' : ''}</td>
            <td class="mono">${escHtml(shortKey(r.pubkey, 20))}<button class="copy-btn" data-action="copy" data-copy-value="${escHtml(r.pubkey)}" title="Copy public key">⎘</button></td>
            <td class="wallet-reward-count">${r.reward_count}</td>
            <td class="wallet-bdx-cell">${fmtBdx(r.total_amount)}</td>
            <td class="wallet-avg-cell">${fmtBdx(r.avg_amount)}</td>
            <td class="wallet-open-cell"><button class="btn btn-sm btn-outline wallet-open-btn" data-action="node-detail" data-close-drill="1" data-pubkey="${escHtml(r.pubkey)}">Open</button></td>
          </tr>
        `).join('')
      }</tbody></table></div>` : '<div class="empty-state"><div class="empty-state-text">No nodes found in this wallet</div></div>'}
    `;
    openDrillModal(wallet, `${sourceLabel || 'Wallet detail'} · ${from} → ${to} · ${totalRewards} rewards`, bodyHtml);
  } catch (e) {
    openDrillModal(wallet, `${sourceLabel || 'Wallet detail'} · ${from} → ${to}`, `<div class="empty-state"><div class="empty-state-text">Failed to load wallet detail: ${escHtml(e.message)}</div></div>`);
  }
}

async function openAnomalyDrill(pubkey, label, walletName, daysSince, avgInterval, lastReward, ratio) {
  const safeLabel = escHtml(label || shortKey(pubkey));
  const safeWallet = escHtml(walletName || 'Ungrouped');
  const safeLastReward = escHtml(lastReward || '—');
  const thresholdDays = (Number(avgInterval || 0) * 1.5).toFixed(1);
  openDrillModal(`Why ${safeLabel} is flagged`, 'Anomaly explanation', '<div class="skeleton skeleton-row" style="height:120px"></div>');
  try {
    const [uptimeRows, networkResp] = await Promise.all([
      fetch(API + '/api/analytics/uptime-summary').then(r => r.json()).catch(() => []),
      fetch(API + '/api/analytics/network-overdue').then(r => r.json()).catch(() => ({ nodes: [] }))
    ]);
    const uptime = (uptimeRows || []).find(u => u.pubkey === pubkey);
    const netOverdue = (networkResp.nodes || []).find(n => n.pubkey === pubkey);
    const uptime30 = uptime && uptime.total_30d ? ((uptime.active_30d / uptime.total_30d) * 100).toFixed(1) : '—';
    const bodyHtml = `
      <div class="drill-callout">
        <strong>${safeLabel}</strong> is flagged because it has waited <strong>${daysSince} days</strong> since the last reward.
        Its usual baseline is <strong>${avgInterval} days</strong>, so anything above roughly <strong>${thresholdDays} days</strong> becomes suspicious.
      </div>
      <div class="drill-summary-grid">
        <div class="drill-stat"><div class="drill-stat-val" style="color:var(--red)">${daysSince}d</div><div class="drill-stat-label">Current Delay</div></div>
        <div class="drill-stat"><div class="drill-stat-val">${avgInterval}d</div><div class="drill-stat-label">Baseline Wait</div></div>
        <div class="drill-stat"><div class="drill-stat-val">${ratio}×</div><div class="drill-stat-label">Overdue Ratio</div></div>
        <div class="drill-stat"><div class="drill-stat-val">${safeLastReward}</div><div class="drill-stat-label">Last Reward</div></div>
      </div>
      <div class="drill-meta-list">
        <div><span class="muted">Wallet</span> ${safeWallet}</div>
        <div><span class="muted">Public Key</span> <span class="mono">${escHtml(shortKey(pubkey, 28))}</span><button class="copy-btn" data-action="copy" data-copy-value="${escHtml(pubkey)}" title="Copy public key">⎘</button></div>
        <div><span class="muted">30d Uptime</span> ${uptime30 === '—' ? 'No history yet' : uptime30 + '%'}</div>
        <div><span class="muted">Network Overdue</span> ${netOverdue ? escHtml((netOverdue.overdue_ratio || 0).toFixed(1) + '× expected interval') : 'Within expected network range'}</div>
      </div>
      <div class="modal-footer" style="margin-top:18px">
        <button class="btn btn-outline" data-action="close-drill">Close</button>
        <button class="btn btn-primary" data-action="node-detail" data-close-drill="1" data-pubkey="${escHtml(pubkey)}">Open Node Detail</button>
      </div>
    `;
    openDrillModal(`Why ${safeLabel} is flagged`, 'Anomaly explanation', bodyHtml);
  } catch (e) {
    openDrillModal(`Why ${safeLabel} is flagged`, 'Anomaly explanation', `<div class="empty-state"><div class="empty-state-text">Failed to load explanation: ${escHtml(e.message)}</div></div>`);
  }
}

