// ══════════════════════════════════════════════
// ── Data Quality Score ──
// ══════════════════════════════════════════════
async function loadDataQuality() {
  var el = document.getElementById('data-quality-strip');
  if (!el) return;
  try {
    var q = await apiJson(API + '/api/scan/quality');
    var scan = q.lastAutoScan || q.lastScan;
    if (!scan) {
      el.innerHTML = '<div class="dq-strip dq-strip-warn"><span class="dq-pill dq-pill-warn">NO DATA</span><span class="dq-item">No scan history found — run a scan first</span></div>';
      return;
    }

    var now = Date.now();
    var scanTs = new Date(scan.scanned_at).getTime();
    var hoursAgo = Math.floor((now - scanTs) / 3600000);
    var daysAgo = Math.floor(hoursAgo / 24);

    var missed = scan.missed_blocks || 0;
    var found = scan.rewards_found || 0;
    var totalBlocks = (scan.end_height && scan.start_height) ? (scan.end_height - scan.start_height + 1) : null;
    var coveragePct = (totalBlocks && totalBlocks > 0) ? Math.round((totalBlocks - missed) / totalBlocks * 100) : null;

    var isStale = hoursAgo >= 48;
    var hasSkipped = missed > 0;
    var trust = (!isStale && !hasSkipped) ? 'good' : (isStale ? 'stale' : 'warn');

    var trustLabel = trust === 'good' ? 'TRUSTED' : trust === 'stale' ? 'STALE' : 'CHECK';
    var trustClass = trust === 'good' ? 'dq-pill-ok' : trust === 'stale' ? 'dq-pill-stale' : 'dq-pill-warn';
    var ageLabel = hoursAgo < 1 ? 'just now' : hoursAgo < 24 ? hoursAgo + 'h ago' : daysAgo + 'd ago';
    var scanDate = scan.scanned_at ? scan.scanned_at.slice(0, 10) : '—';

    var items = [
      '<span class="dq-item"><span class="dq-label">Last Scan</span><span class="dq-val">' + escHtml(ageLabel) + ' (' + escHtml(scanDate) + ')</span></span>',
      coveragePct !== null
        ? '<span class="dq-item"><span class="dq-label">Coverage</span><span class="dq-val ' + (coveragePct < 99 ? 'dq-val-warn' : 'dq-val-ok') + '">' + coveragePct + '%</span></span>'
        : '',
      '<span class="dq-item"><span class="dq-label">Skipped Blocks</span><span class="dq-val ' + (missed > 0 ? 'dq-val-warn' : 'dq-val-ok') + '">' + missed.toLocaleString() + '</span></span>',
      '<span class="dq-item"><span class="dq-label">Rewards Found</span><span class="dq-val">' + found.toLocaleString() + '</span></span>',
    ].filter(Boolean).join('<span class="dq-sep">·</span>');

    el.innerHTML = '<div class="dq-strip dq-strip-' + trust + '">' +
      '<span class="dq-pill ' + trustClass + '">' + trustLabel + '</span>' +
      items + '</div>';
  } catch(e) {
    el.innerHTML = '';
  }
}

// ══════════════════════════════════════════════
// ── Last Scan Info ──
// ══════════════════════════════════════════════
async function loadLastScanInfo() {
  try {
    const info = await apiJson(API+'/api/scan/last-height');
    const el = document.getElementById('last-scan-info');
    if (info.lastScanTime) {
      const ago = timeAgo(info.lastScanTime);
      el.textContent = `Last scan: ${ago}`;
      el.style.display = 'inline';
    }
  } catch(e) {}
}

function timeAgo(dateStr) {
  const diff = Date.now() - new Date(dateStr).getTime();
  const mins = Math.floor(diff / 60000);
  if (mins < 1) return 'just now';
  if (mins < 60) return `${mins}m ago`;
  const hrs = Math.floor(mins / 60);
  if (hrs < 24) return `${hrs}h ago`;
  return `${Math.floor(hrs/24)}d ago`;
}

// ══════════════════════════════════════════════
// ── Dashboard ──
// ══════════════════════════════════════════════
// Render a vs-yesterday trend badge into an element
function renderTrend(elId, current, prev) {
  const el = document.getElementById(elId);
  if (!el) return;
  if (!prev || prev === 0) { el.innerHTML = ''; return; }
  const pct = (current - prev) / prev * 100;
  const abs = Math.abs(pct);
  if (abs < 0.5) {
    el.innerHTML = '<span class="stat-trend stat-trend-flat">&mdash; same</span>';
    return;
  }
  const cls = pct > 0 ? 'stat-trend-up' : 'stat-trend-down';
  const arrow = pct > 0 ? '&uarr;' : '&darr;';
  const label = abs < 10 ? abs.toFixed(1) + '%' : Math.round(abs) + '%';
  el.innerHTML = `<span class="stat-trend ${cls}">${arrow} ${label} vs yd</span>`;
}

let _dashLastLoad = 0;
let _quickScanPoll = null;
let _autoScanCountdownTimer = null;
let _autoScanPollTimer = null;

async function loadAutoScanStatus() {
  const pill = document.getElementById('autoscan-topbar-pill');
  if (!pill) return;
  let isScanning = false;
  try {
    const cfg = await apiJson(API + '/api/scheduler');
    isScanning = _renderAutoScanPill(pill, cfg);
  } catch(e) { pill.style.display = 'none'; }

  // Poll every 30s while scanning so pill clears as soon as scan completes
  if (_autoScanPollTimer) clearInterval(_autoScanPollTimer);
  _autoScanPollTimer = setInterval(loadAutoScanStatus, isScanning ? 30000 : 5 * 60 * 1000);
}

function _renderAutoScanPill(pill, cfg) {
  if (_autoScanCountdownTimer) { clearInterval(_autoScanCountdownTimer); _autoScanCountdownTimer = null; }

  if (!cfg.enabled) {
    pill.style.display = 'inline-flex';
    pill.className = 'autoscan-topbar-pill asb-disabled';
    pill.innerHTML = `<span class="asb-dot"></span><span class="asb-pill-text">Auto · Off</span>`;
    return;
  }

  const intervalMs = cfg.intervalHours * 3600000;
  const nextScanAt = cfg.lastAutoScan ? new Date(cfg.lastAutoScan).getTime() + intervalMs : null;
  pill.style.display = 'inline-flex';

  const tick = () => {
    const now = Date.now();
    if (!nextScanAt) {
      pill.className = 'autoscan-topbar-pill asb-pending';
      pill.innerHTML = `<span class="asb-dot asb-dot-pulse"></span><span class="asb-pill-text">Auto · Pending</span>`;
      return;
    }
    const diff = nextScanAt - now;
    const fmtDiff = ms => {
      const h = Math.floor(ms / 3600000);
      const m = Math.floor((ms % 3600000) / 60000);
      const s = Math.floor((ms % 60000) / 1000);
      return h > 0 ? `in ${h}h ${m}m` : m > 0 ? `in ${m}m ${s}s` : `in ${s}s`;
    };
    if (diff <= 0) {
      pill.className = 'autoscan-topbar-pill asb-overdue';
      pill.innerHTML = `<span class="asb-dot asb-dot-pulse"></span><span class="asb-pill-text">Auto · Scanning...</span>`;
    } else {
      pill.className = 'autoscan-topbar-pill asb-active';
      pill.innerHTML = `<span class="asb-dot"></span><span class="asb-pill-text">Auto · ${fmtDiff(diff)}</span>`;
    }
  };

  tick();
  _autoScanCountdownTimer = setInterval(tick, 1000);
  return !nextScanAt || (nextScanAt - Date.now()) <= 0;
}

async function loadDashboard(force = false) {
  const now = Date.now();
  if (!force && now - _dashLastLoad < 60000) return;
  try {
    const yd = new Date();
    yd.setUTCDate(yd.getUTCDate() - 1);
    const ydStr = yd.toISOString().slice(0, 10);
    const monthStart = new Date();
    monthStart.setUTCDate(1);
    const monthStartStr = monthStart.toISOString().slice(0, 10);

    const _ft = (url, ms = 8000) => Promise.race([
      fetch(url).then(r => r.json()),
      new Promise((_, rej) => setTimeout(() => rej(new Error('timeout')), ms))
    ]);
    const _settled = await Promise.allSettled([
      _ft(API+'/api/nodes'),
      _ft(API+'/api/report/daily?date='+today()),
      _ft(API+'/api/network-stats'),
      _ft(API+'/api/report/daily?date='+ydStr),
      _ft(API+`/api/report/grouped?from=${monthStartStr}&to=${today()}`)
    ]);
    const _val = (r, fb) => r.status === 'fulfilled' ? r.value : fb;
    const nodes       = _val(_settled[0], []);
    const daily       = _val(_settled[1], {});
    const stats       = _val(_settled[2], {});
    const prevDaily   = _val(_settled[3], {});
    const monthGroups = _val(_settled[4], []);

    animateCounter('stat-total-nodes', nodes.length);
    document.getElementById('node-count-badge').textContent = nodes.length;

    const rewardCount = daily.summary ? daily.summary.reduce((s,r)=>s+r.reward_count,0) : 0;
    const prevRewardCount = prevDaily.summary ? prevDaily.summary.reduce((s,r)=>s+r.reward_count,0) : 0;
    animateCounter('stat-rewards-count', rewardCount);
    renderTrend('trend-rewards-count', rewardCount, prevRewardCount);

    const bdxToday = daily.totalBdx || 0;
    const bdxYest = prevDaily.totalBdx || 0;
    animateCounter(document.getElementById('stat-bdx-today'), bdxToday, 700, 4);
    renderTrend('trend-bdx-today', bdxToday, bdxYest);

    if (stats.height) {
      animateCounter('stat-block-height', stats.height);
      const liveEl = document.getElementById('stat-block-live');
      if (liveEl) liveEl.innerHTML = '<span class="stat-live-dot"></span>LIVE';
    }

    // Show fiat value for today's BDX earnings
    const fiatEl = document.getElementById('stat-bdx-today-fiat');
    if (fiatEl && _lastPrice && bdxToday > 0) {
      const usd = _lastPrice.usd ? '$' + fmtChartMoney(bdxToday * _lastPrice.usd) : null;
      const cleanInr = _lastPrice.inr ? String.fromCharCode(8377) + fmtChartInteger(bdxToday * _lastPrice.inr) : null;
      const parts = [usd, cleanInr].filter(Boolean);
      fiatEl.textContent = parts.length ? '~' + parts.join(' / ') : '';
    } else if (fiatEl) {
      fiatEl.textContent = '';
    }

    // Group rewards aggregation – track earning nodes per group for progress bar
    const groups = {};
    nodes.forEach(n => {
      const g = n.wallet_name || 'Ungrouped';
      if(!groups[g]) groups[g] = {count:0, addr:n.wallet_address, totalBdx:0, earnedNodes:0, rewardCount:0};
      groups[g].count++;
    });
    if (daily.summary) {
      daily.summary.forEach(r => {
        const g = r.wallet_name || 'Ungrouped';
        if (groups[g]) {
          groups[g].totalBdx += r.total_amount || 0;
          groups[g].earnedNodes++;
          groups[g].rewardCount += r.reward_count || 0;
        }
      });
    }
    renderDashboardWalletSignals(groups, monthGroups || []);

    const gl = document.getElementById('group-list-dashboard');
    gl.innerHTML = Object.keys(groups).length ? Object.entries(groups).map(([name,v]) => {
      const fillPct = v.count > 0 ? Math.round(v.earnedNodes / v.count * 100) : 0;
      return `<div class="group-item group-item-drill" data-wallet="${escHtml(name)}" title="Click to inspect wallet nodes">
        <div class="group-item-core">
          <div class="group-item-row">
            <div class="group-name">${escHtml(name)}</div>
            <div class="group-item-metrics">
              ${v.totalBdx > 0 ? `<span class="group-reward">${fmtBdx(v.totalBdx)} BDX</span>` : ''}
              <span class="group-count">${v.count} nodes</span>
            </div>
          </div>
          <div class="group-item-progress" title="${fillPct}% nodes earned today"><div class="group-item-progress-fill" style="width:${fillPct}%"></div></div>
        </div>
      </div>`;
    }).join('') : '<div class="empty-state"><div class="empty-state-icon">&#11041;</div><div class="empty-state-text">No nodes yet</div><button class="btn btn-sm btn-primary" data-action="switch-tab" data-tab="nodes">Import Groups</button></div>';

    // Today rewards – paginated
    gl.onclick = function(e) {
      const item = e.target.closest('.group-item-drill');
      if (!item) return;
      openWalletDrill(item.dataset.wallet, today(), today(), 'Dashboard wallet view');
    };

    const tw = document.getElementById('today-rewards-table');
    const summaryPill = document.getElementById('dash-rewards-summary');
    if (daily.summary && daily.summary.length) {
      const nodeCount = daily.summary.length;
      if (summaryPill) summaryPill.textContent = nodeCount + ' node' + (nodeCount !== 1 ? 's' : '') + ' earned';
      const renderTodayRows = (rows, si) => '<table><thead><tr><th>#</th><th>Label</th><th>Key</th><th>Rewards</th><th>BDX</th></tr></thead><tbody>' + rows.map((r,i) => '<tr><td>' + (si+i+1) + '</td><td>' + escHtml(r.label||r.wallet_name||'-') + '</td><td class="mono">' + escHtml(shortKey(r.pubkey)) + '<button class="copy-btn" data-action="copy" data-copy-value="' + escHtml(r.pubkey) + '" title="Copy public key">Copy</button></td><td>' + r.reward_count + '</td><td style="color:var(--green)">' + fmtBdx(r.total_amount) + '</td></tr>').join('') + '</tbody></table>';
      tw.innerHTML = '<div id="today-pag-wrap"></div>';
      pagInit('todayRewards', daily.summary, 10, renderTodayRows, 'today-pag-wrap');
    } else {
      if (summaryPill) summaryPill.textContent = '';
      tw.innerHTML = '<div class="empty-state"><div class="empty-state-icon">&#9670;</div><div class="empty-state-text">No rewards found today</div><button class="btn btn-sm btn-primary" data-action="switch-tab" data-tab="scan">Run a Scan</button></div>';
    }

    _dashLastLoad = Date.now();
    loadDashboardChart();
    loadDbHealth();
    loadAutoScanStatus();
  } catch(e) { console.error(e); }
}

function _walletSignalEntriesFromToday(groups) {
  return Object.entries(groups || {}).map(([name, v]) => ({
    wallet_name: name,
    total_bdx: Number(v.totalBdx || 0),
    reward_count: Number(v.rewardCount || 0),
    node_count: Number(v.count || 0)
  }));
}

function _walletSignalEntriesFromMonth(monthGroups) {
  return (Array.isArray(monthGroups) ? monthGroups : []).map(r => ({
    wallet_name: r.wallet_name || 'Ungrouped',
    total_bdx: Number(r.total_bdx || r.total_amount || 0),
    reward_count: Number(r.reward_count || 0),
    node_count: Number(r.node_count || r.nodes || 0)
  }));
}

function _pickWalletSignal(entries, mode) {
  const clean = (entries || []).filter(r => r.wallet_name && Number.isFinite(r.total_bdx));
  if (!clean.length) return null;
  const sorted = [...clean].sort((a, b) => {
    const diff = mode === 'best' ? b.total_bdx - a.total_bdx : a.total_bdx - b.total_bdx;
    return diff || String(a.wallet_name).localeCompare(String(b.wallet_name));
  });
  return sorted[0];
}

function _renderWalletSignalCard(label, period, row, tone) {
  const empty = !row;
  const value = empty ? '--' : fmtBdx(row.total_bdx);
  const wallet = empty ? 'No wallet data yet' : row.wallet_name;
  const meta = empty
    ? 'Scan rewards to unlock ranking'
    : `${row.reward_count || 0} rewards - ${row.node_count || 0} nodes`;
  return `<div class="wallet-signal-card wallet-signal-card--${tone}">
    <div class="wallet-signal-topline">
      <span class="wallet-signal-chip">${label}</span>
      <span class="wallet-signal-period">${period}</span>
    </div>
    <div class="wallet-signal-name" title="${escHtml(wallet)}">${escHtml(wallet)}</div>
    <div class="wallet-signal-bdx">${value}<span>BDX</span></div>
    <div class="wallet-signal-meta">${escHtml(meta)}</div>
  </div>`;
}

function renderDashboardWalletSignals(todayGroups, monthGroups) {
  const el = document.getElementById('dashboard-wallet-signals');
  if (!el) return;
  const todayEntries = _walletSignalEntriesFromToday(todayGroups);
  const monthEntries = _walletSignalEntriesFromMonth(monthGroups);
  el.innerHTML = [
    _renderWalletSignalCard('Top wallet', 'Today', _pickWalletSignal(todayEntries, 'best'), 'best'),
    _renderWalletSignalCard('Worst wallet', 'Today', _pickWalletSignal(todayEntries, 'worst'), 'worst'),
    _renderWalletSignalCard('Top wallet', 'Month', _pickWalletSignal(monthEntries, 'best'), 'best'),
    _renderWalletSignalCard('Worst wallet', 'Month', _pickWalletSignal(monthEntries, 'worst'), 'worst')
  ].join('');
}

async function loadAlertBanner() {
  try {
    const status = await apiJson(API+'/api/status/latest');
    const issues = status.filter(s => s.status !== 'active');
    const area = document.getElementById('alert-banner-area');
    if (issues.length > 0) {
      area.innerHTML = `<div class="alert-banner">
        <span class="alert-banner-text">&#9888; ${issues.length} node${issues.length>1?'s':''} with issues detected</span>
        <button class="btn btn-sm btn-danger-outline" data-action="switch-tab" data-tab="status">Check Status</button>
      </div>`;
    } else if (status.length > 0) {
      area.innerHTML = `<div class="alert-banner alert-banner-success">
        <span class="alert-banner-text">&#10004; All ${status.length} nodes active</span>
        <button class="btn btn-sm btn-outline" data-action="switch-tab" data-tab="status">View Details</button>
      </div>`;
    } else {
      area.innerHTML = '';
    }
  } catch(e) { document.getElementById('alert-banner-area').innerHTML = ''; }
}

async function loadNetworkStats() {
  try {
    const s = await apiJson(API+'/api/network-stats');
    document.getElementById('network-height').textContent = s.height ? `Height: ${s.height.toLocaleString()}` : 'Offline';
  } catch(e) { document.getElementById('network-height').textContent = 'Offline'; }
}

// ══════════════════════════════════════════════
// ── Quick Scan Today ──
// ══════════════════════════════════════════════
async function quickScanToday() {
  if (_scanRunning) { showToast('A scan is already running. Check the Scan tab.', 'warning'); return; }
  if (_quickScanPoll) { clearInterval(_quickScanPoll); _quickScanPoll = null; }
  const btn = document.getElementById('quick-scan-btn');
  btn.disabled = true; btn.classList.add('btn-loading'); btn.textContent = '';
  _scanRunning = true;
  try {
    await apiJson(API+'/api/scan/reset', {method:'POST'});
    const scanResp = await apiJson(API+'/api/scan', {method:'POST', headers:{'Content-Type':'application/json'}, body:JSON.stringify({date: today()})});
    if (!scanResp || !scanResp.started) {
      showToast(scanResp?.error || 'Could not start scan', 'error');
      _scanRunning = false;
      clearInterval(_quickScanPoll); _quickScanPoll = null;
      btn.disabled = false; btn.classList.remove('btn-loading'); btn.textContent = '⟳ Scan Today';
      return;
    }
    showToast('Scanning today\'s blocks...', 'info');
    _quickScanPoll = setInterval(async () => {
      try {
        const p = await apiJson(API+'/api/scan/progress');
        if (!p.running) {
          clearInterval(_quickScanPoll); _quickScanPoll = null;
          _scanRunning = false;
          btn.disabled = false; btn.classList.remove('btn-loading'); btn.textContent = '⟳ Scan Today';
          showToast(`Scan complete! Found ${p.found||0} rewards.`, p.found > 0 ? 'success' : 'info');
          loadDashboard();
          loadLastScanInfo();
        }
      } catch(e) { /* keep polling on network hiccup */ }
    }, 2000);
  } catch(e) {
    clearInterval(_quickScanPoll); _quickScanPoll = null;
    _scanRunning = false;
    btn.disabled = false; btn.classList.remove('btn-loading'); btn.textContent = '⟳ Scan Today';
    showToast('Scan failed: ' + e.message, 'error');
  }
}


// ══════════════════════════════════════════════
// ── BDX Price ──
// ══════════════════════════════════════════════
let _lastPrice = null;
async function loadBdxPrice() {
  try {
    const data = await apiJson(API+'/api/price/bdx');
    _lastPrice = data;
    const pill = document.getElementById('bdx-price-pill');
    const usdEl = document.getElementById('bdx-price-usd');
    const inrEl = document.getElementById('bdx-price-inr');
    if (data.usd !== null || data.inr !== null) {
      if (usdEl) usdEl.textContent = data.usd !== null ? '$'+data.usd.toFixed(4) : '–';
      if (inrEl) inrEl.textContent = data.inr !== null ? '₹'+data.inr.toFixed(2) : '–';
      pill.style.display = 'inline-flex';
      if (data.stale) {
        pill.title = `BDX price is stale (CoinGecko unreachable) – showing last known values`;
        pill.style.opacity = '0.55';
        pill.style.outline = '1px dashed var(--amber)';
      } else {
        pill.title = `BDX/USD: $${data.usd||'?'} | BDX/INR: ₹${data.inr||'?'} (CoinGecko, 15min cache)`;
        pill.style.opacity = '';
        pill.style.outline = '';
      }
    }
  } catch(e) {}
}

// ══════════════════════════════════════════════
// ── Earnings Chart ──
// ══════════════════════════════════════════════
let _chartDays = 30;
let _chartCurrency = 'bdx';
let _chartData = null;
let _chartMode = 'daily'; // 'daily' | 'monthly'

function fmtChartNumber(value, decimals = 4) {
  return Number(value || 0).toLocaleString('en-US', {
    minimumFractionDigits: decimals,
    maximumFractionDigits: decimals
  });
}

function fmtChartMoney(value) {
  return Number(value || 0).toLocaleString('en-US', {
    minimumFractionDigits: 2,
    maximumFractionDigits: 2
  });
}

function fmtChartInteger(value) {
  return Math.round(Number(value || 0)).toLocaleString('en-US');
}

async function loadDashboardChart() {
  try {
    const data = await apiJson(API + `/api/report/chart?days=${_chartDays}`);
    _chartData = data;
    renderChart(data);
  } catch(e) {}
}

function renderChart(data) {
  const wrap = document.getElementById('dashboard-chart');
  if (!wrap) return;
  if (!data || !data.length) {
    wrap.innerHTML = '<div class="empty-state" style="width:100%;padding:20px 0"><div class="empty-state-text">No reward data yet. Run a scan to populate the chart.</div></div>';
    _updateChartMeta(0);
    return;
  }

  const days = _chartDays;
  const currency = _chartCurrency;
  const todayStr = new Date().toISOString().slice(0, 10);

  // Fill gaps – full array with 0 for missing days
  const filled = [];
  for (let i = days - 1; i >= 0; i--) {
    const d = new Date(); d.setUTCDate(d.getUTCDate() - i);
    const ds = d.toISOString().slice(0, 10);
    const found = data.find(r => r.reward_date === ds);
    filled.push({ date: ds, total_bdx: found ? found.total_bdx : 0, reward_count: found ? found.reward_count : 0 });
  }

  // Stats
  const nonZero = filled.filter(d => d.total_bdx > 0);
  const avgBdx = nonZero.length ? nonZero.reduce((s, d) => s + d.total_bdx, 0) / nonZero.length : 0;
  const bestDate = filled.reduce((best, d) => d.total_bdx > (best ? best.total_bdx : 0) ? d : best, null);
  const bestDateStr = bestDate ? bestDate.date : null;

  // Currency converter
  const toDisplay = bdx => {
    if (currency === 'usd' && _lastPrice && _lastPrice.usd) return bdx * _lastPrice.usd;
    if (currency === 'inr' && _lastPrice && _lastPrice.inr) return bdx * _lastPrice.inr;
    return bdx;
  };

  const displayMax = Math.max(...filled.map(d => toDisplay(d.total_bdx)), 0.0001);
  const BAR_MAX_PX = 125; // safe within 130px bar-wrap
  const LABEL_AREA = 24; // label(9px) + gap(3) + tick(3) + gap(3) + rounding(6)
  // Tag the wrap so CSS can adjust label style per period; also set gap inline for reliability
  wrap.dataset.period = days;
  wrap.style.gap = days === 7 ? '8px' : days === 30 ? '3px' : '1px';

  wrap.innerHTML = filled.map((d, idx) => {
    const displayVal = toDisplay(d.total_bdx);
    const barH = d.total_bdx > 0 ? Math.max(Math.round(displayVal / displayMax * BAR_MAX_PX), 4) : 2;
    const isEmpty = d.total_bdx === 0;
    const isToday = d.date === todayStr;
    const isBest = d.date === bestDateStr && !isEmpty;
    const belowAvg = !isEmpty && d.total_bdx < avgBdx;

    let barCls = 'chart-bar';
    if (isEmpty) barCls += ' no-data';
    if (isToday) barCls += ' is-today';
    if (belowAvg && !isToday) barCls += ' below-avg';

    const bestBadge = isBest ? `<div class="chart-best-badge">&#9733; best</div>` : '';

    const prev = filled[idx - 1];
    const isMonthAnchor = !prev || prev.date.slice(5, 7) !== d.date.slice(5, 7);
    const monthName = ['Jan','Feb','Mar','Apr','May','Jun','Jul','Aug','Sep','Oct','Nov','Dec'][parseInt(d.date.slice(5, 7), 10) - 1];
    const monthLabel = days === 90 && isMonthAnchor ? monthName : '';
    const monthCls = monthLabel ? ' month-anchor' : '';

    // 90D shows month markers only; 7D shows MM-DD; 30D shows day-only to fit.
    const labelText = (isToday ? '&#9679; ' : '') +
      (days === 30 ? d.date.slice(8) : d.date.slice(5));

    return `<div class="chart-col${isToday ? ' today-col' : ''}${monthCls}" data-date="${d.date}" data-bdx="${d.total_bdx}" data-count="${d.reward_count}" data-empty="${isEmpty}">
      <div class="chart-bar-wrap">
        ${bestBadge}
        <div class="${barCls}" style="height:${barH}px"></div>
      </div>
      <div class="chart-tick"></div>
      <div class="chart-label">${days === 90 ? monthLabel : labelText}</div>
    </div>`;
  }).join('');

  // Average line
  if (avgBdx > 0) {
    const avgLineBottom = LABEL_AREA + Math.round(toDisplay(avgBdx) / displayMax * BAR_MAX_PX);
    const fmtAvg = currency === 'usd' ? `$${fmtChartMoney(toDisplay(avgBdx))}` :
                   currency === 'inr' ? `${String.fromCharCode(8377)}${Math.round(toDisplay(avgBdx)).toLocaleString()}` :
                   `${fmtChartNumber(avgBdx)} BDX`;
    const avgEl = document.createElement('div');
    avgEl.className = 'chart-avg-line';
    avgEl.style.bottom = avgLineBottom + 'px';
    avgEl.innerHTML = `<span class="chart-avg-label">avg ${fmtAvg}</span>`;
    wrap.appendChild(avgEl);
  }

  // Today notice
  const noticeEl = document.getElementById('chart-today-notice');
  if (noticeEl) {
    noticeEl.textContent = '';
    noticeEl.style.display = 'none';
  }

  _updateChartMeta(filled.reduce((s, d) => s + d.total_bdx, 0));

  // Click → drill to daily report
  wrap.onclick = function(e) {
    const col = e.target.closest('.chart-col');
    if (!col || col.dataset.empty === 'true') return;
    drillToDailyReport(col.dataset.date);
  };

  // Floating rich tooltip
  let tip = document.getElementById('chart-float-tip');
  if (!tip) {
    tip = document.createElement('div');
    tip.id = 'chart-float-tip';
    tip.className = 'chart-float-tip';
    document.body.appendChild(tip);
  }

  wrap.onmousemove = function(e) {
    const col = e.target.closest('.chart-col');
    if (!col || col.dataset.empty === 'true') { tip.style.display = 'none'; return; }
    const bdx = parseFloat(col.dataset.bdx) || 0;
    const count = parseInt(col.dataset.count) || 0;
    const date = col.dataset.date;
    const usd = _lastPrice && _lastPrice.usd;
    const inr = _lastPrice && _lastPrice.inr;
    const isToday = date === todayStr;
    const isBest = date === bestDateStr && bdx > 0;

    const bestBadgeHtml = isBest ? `<div class="cft-badge cft-badge-best">&#9733; Best day</div>` : '';
    const todayHtml = '';
    const vsAvgPct = avgBdx > 0 && bdx > 0 ? ((bdx - avgBdx) / avgBdx * 100) : null;
    const vsAvgHtml = vsAvgPct !== null
      ? `<div class="cft-vs-avg ${vsAvgPct >= 0 ? 'above' : 'below'}">${vsAvgPct >= 0 ? '&#9650;' : '&#9660;'} ${Math.abs(vsAvgPct).toFixed(1)}% vs avg</div>`
      : '';
    const fiatHtml = (bdx > 0 && (usd || inr))
      ? `<div class="cft-fiat">${usd ? `<span class="cft-usd">$${fmtChartMoney(bdx * usd)}</span>` : ''}${usd && inr ? '<span class="cft-sep">&middot;</span>' : ''}${inr ? `<span class="cft-inr">&#8377;${fmtChartInteger(bdx * inr)}</span>` : ''}</div>`
      : '';

    tip.innerHTML = `${bestBadgeHtml}<div class="cft-date">${escHtml(date)}</div>
      <div class="cft-bdx">${fmtChartNumber(bdx)} <span class="cft-unit">BDX</span></div>
      ${fiatHtml}
      <div class="cft-events">${count} reward event${count !== 1 ? 's' : ''}</div>
      ${vsAvgHtml}${todayHtml}`;
    tip.style.display = 'block';
    tip.style.left = (e.clientX + 16) + 'px';
    tip.style.top = (e.clientY - 16) + 'px';
    const r = tip.getBoundingClientRect();
    if (r.right > window.innerWidth - 10) tip.style.left = (e.clientX - r.width - 10) + 'px';
    if (r.bottom > window.innerHeight - 10) tip.style.top = (e.clientY - r.height - 8) + 'px';
  };
  wrap.onmouseleave = function() { tip.style.display = 'none'; };
}

let _metaTotalBdx = 0;
let _metaMonthly = false;

function _updateChartMeta(totalBdx, monthly = false) {
  if (totalBdx !== undefined) { _metaTotalBdx = totalBdx; _metaMonthly = monthly; }
  const days = _chartDays;
  const fiatBar = document.getElementById('chart-fiat-bar');
  if (!fiatBar || !_metaTotalBdx || !_lastPrice) { if (fiatBar) fiatBar.style.display = 'none'; return; }
  const earnedLabel = _metaMonthly ? 'Earned last 12 months' : `Earned last ${days} days`;
  let valueStr = '';
  if (_chartCurrency === 'bdx') {
    valueStr = `<strong>${fmtChartNumber(_metaTotalBdx)} BDX</strong>`;
  } else if (_chartCurrency === 'usd' && _lastPrice.usd) {
    valueStr = `<strong>$${fmtChartMoney(_metaTotalBdx * _lastPrice.usd)} USD</strong>`;
  } else if (_chartCurrency === 'inr' && _lastPrice.inr) {
    valueStr = `<strong>${String.fromCharCode(8377)}${fmtChartInteger(_metaTotalBdx * _lastPrice.inr)} INR</strong>`;
  } else {
    valueStr = `<strong>${fmtChartNumber(_metaTotalBdx)} BDX</strong>`;
  }
  fiatBar.innerHTML = `<span class="chart-fiat-label">${earnedLabel}: ${valueStr}</span>`;
  fiatBar.style.display = 'block';
}

function switchChartPeriod(days, btn) {
  _chartMode = 'daily';
  _chartDays = Number(days) || 30;
  document.querySelectorAll('.cpt-btn').forEach(b => b.classList.toggle('active', b === btn));
  const label = document.getElementById('chart-period-label');
  if (label) label.textContent = `Last ${_chartDays} Days`;
  loadDashboardChart();
}

function switchChartCurrency(currency, btn) {
  _chartCurrency = currency;
  document.querySelectorAll('.cct-btn').forEach(b => b.classList.toggle('active', b === btn));
  _updateChartMeta();
  if (_chartMode === 'monthly' && _chartMonthlyData) renderMonthlyChart(_chartMonthlyData);
  else if (_chartData) renderChart(_chartData);
}

let _chartMonthlyData = null;

async function switchChartMonthly(btn) {
  _chartMode = 'monthly';
  document.querySelectorAll('.cpt-btn').forEach(b => b.classList.toggle('active', b === btn));
  const label = document.getElementById('chart-period-label');
  if (label) label.textContent = 'Last 12 Months';
  try {
    const data = await apiJson(API + '/api/report/chart/monthly?months=12');
    _chartMonthlyData = data;
    renderMonthlyChart(data);
  } catch(e) {}
}

function renderMonthlyChart(data) {
  const wrap = document.getElementById('dashboard-chart');
  if (!wrap) return;

  const MONTH_NAMES = ['Jan','Feb','Mar','Apr','May','Jun','Jul','Aug','Sep','Oct','Nov','Dec'];
  const curMonthStr = new Date().toISOString().slice(0, 7);

  const filled = [];
  for (let i = 11; i >= 0; i--) {
    const d = new Date();
    d.setUTCDate(1);
    d.setUTCMonth(d.getUTCMonth() - i);
    const monthStr = d.toISOString().slice(0, 7);
    const found = data && data.find(r => r.month === monthStr);
    filled.push({ month: monthStr, total_bdx: found ? found.total_bdx : 0, reward_count: found ? found.reward_count : 0 });
  }

  if (!filled.some(d => d.total_bdx > 0)) {
    wrap.innerHTML = '<div class="empty-state" style="width:100%;padding:20px 0"><div class="empty-state-text">No reward data yet. Run a scan to populate the chart.</div></div>';
    _updateChartMeta(0, true);
    return;
  }

  const currency = _chartCurrency;
  const toDisplay = bdx => {
    if (currency === 'usd' && _lastPrice && _lastPrice.usd) return bdx * _lastPrice.usd;
    if (currency === 'inr' && _lastPrice && _lastPrice.inr) return bdx * _lastPrice.inr;
    return bdx;
  };

  const nonZero = filled.filter(d => d.total_bdx > 0);
  const avgBdx = nonZero.length ? nonZero.reduce((s, d) => s + d.total_bdx, 0) / nonZero.length : 0;
  const bestMonth = filled.reduce((best, d) => d.total_bdx > (best ? best.total_bdx : 0) ? d : best, null);
  const displayMax = Math.max(...filled.map(d => toDisplay(d.total_bdx)), 0.0001);
  const BAR_MAX_PX = 125;
  const LABEL_AREA = 24;

  wrap.dataset.period = 'monthly';
  wrap.style.gap = '6px';

  wrap.innerHTML = filled.map(d => {
    const displayVal = toDisplay(d.total_bdx);
    const barH = d.total_bdx > 0 ? Math.max(Math.round(displayVal / displayMax * BAR_MAX_PX), 4) : 2;
    const isEmpty = d.total_bdx === 0;
    const isCurrent = d.month === curMonthStr;
    const isBest = bestMonth && d.month === bestMonth.month && !isEmpty;
    const belowAvg = !isEmpty && d.total_bdx < avgBdx;

    let barCls = 'chart-bar';
    if (isEmpty) barCls += ' no-data';
    if (isCurrent) barCls += ' is-today';
    if (belowAvg && !isCurrent) barCls += ' below-avg';

    const bestBadge = isBest ? `<div class="chart-best-badge">&#9733; best</div>` : '';
    const monthIdx = parseInt(d.month.slice(5, 7), 10) - 1;

    return `<div class="chart-col${isCurrent ? ' today-col' : ''}" data-month="${d.month}" data-bdx="${d.total_bdx}" data-count="${d.reward_count}" data-empty="${isEmpty}">
      <div class="chart-bar-wrap">
        ${bestBadge}
        <div class="${barCls}" style="height:${barH}px"></div>
      </div>
      <div class="chart-tick"></div>
      <div class="chart-label">${MONTH_NAMES[monthIdx]}</div>
    </div>`;
  }).join('');

  if (avgBdx > 0) {
    const avgLineBottom = LABEL_AREA + Math.round(toDisplay(avgBdx) / displayMax * BAR_MAX_PX);
    const fmtAvg = currency === 'usd' ? `$${fmtChartMoney(toDisplay(avgBdx))}` :
                   currency === 'inr' ? `${String.fromCharCode(8377)}${Math.round(toDisplay(avgBdx)).toLocaleString()}` :
                   `${fmtChartNumber(avgBdx)} BDX`;
    const avgEl = document.createElement('div');
    avgEl.className = 'chart-avg-line';
    avgEl.style.bottom = avgLineBottom + 'px';
    avgEl.innerHTML = `<span class="chart-avg-label">avg ${fmtAvg}</span>`;
    wrap.appendChild(avgEl);
  }

  _updateChartMeta(filled.reduce((s, d) => s + d.total_bdx, 0), true);

  let tip = document.getElementById('chart-float-tip');
  if (!tip) {
    tip = document.createElement('div');
    tip.id = 'chart-float-tip';
    tip.className = 'chart-float-tip';
    document.body.appendChild(tip);
  }

  wrap.onclick = null;

  wrap.onmousemove = function(e) {
    const col = e.target.closest('.chart-col');
    if (!col || col.dataset.empty === 'true') { tip.style.display = 'none'; return; }
    const bdx = parseFloat(col.dataset.bdx) || 0;
    const count = parseInt(col.dataset.count) || 0;
    const month = col.dataset.month;
    const usd = _lastPrice && _lastPrice.usd;
    const inr = _lastPrice && _lastPrice.inr;
    const isBest = bestMonth && month === bestMonth.month && bdx > 0;
    const vsAvgPct = avgBdx > 0 && bdx > 0 ? ((bdx - avgBdx) / avgBdx * 100) : null;
    const monthLabel = MONTH_NAMES[parseInt(month.slice(5,7),10)-1] + ' ' + month.slice(0,4);
    const bestBadgeHtml = isBest ? `<div class="cft-badge cft-badge-best">&#9733; Best month</div>` : '';
    const vsAvgHtml = vsAvgPct !== null
      ? `<div class="cft-vs-avg ${vsAvgPct >= 0 ? 'above' : 'below'}">${vsAvgPct >= 0 ? '&#9650;' : '&#9660;'} ${Math.abs(vsAvgPct).toFixed(1)}% vs avg</div>`
      : '';
    const fiatHtml = (bdx > 0 && (usd || inr))
      ? `<div class="cft-fiat">${usd ? `<span class="cft-usd">$${fmtChartMoney(bdx * usd)}</span>` : ''}${usd && inr ? '<span class="cft-sep">&middot;</span>' : ''}${inr ? `<span class="cft-inr">&#8377;${fmtChartInteger(bdx * inr)}</span>` : ''}</div>`
      : '';
    tip.innerHTML = `${bestBadgeHtml}<div class="cft-date">${monthLabel}</div>
      <div class="cft-bdx">${fmtChartNumber(bdx)} <span class="cft-unit">BDX</span></div>
      ${fiatHtml}
      <div class="cft-events">${count} reward event${count !== 1 ? 's' : ''}</div>
      ${vsAvgHtml}`;
    tip.style.display = 'block';
    tip.style.left = (e.clientX + 16) + 'px';
    tip.style.top = (e.clientY - 16) + 'px';
    const r = tip.getBoundingClientRect();
    if (r.right > window.innerWidth - 10) tip.style.left = (e.clientX - r.width - 10) + 'px';
    if (r.bottom > window.innerHeight - 10) tip.style.top = (e.clientY - r.height - 8) + 'px';
  };
  wrap.onmouseleave = function() { tip.style.display = 'none'; };
}


