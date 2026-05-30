// ══════════════════════════════════════════════
// ── Scan ──
// ══════════════════════════════════════════════
function setScanMode(mode) {
  document.getElementById('scan-by-date').style.display = mode==='date'?'block':'none';
  document.getElementById('scan-by-daterange').style.display = mode==='daterange'?'block':'none';
  document.getElementById('scan-by-range').style.display = mode==='range'?'block':'none';
}

let _pollErrors = 0;

function _stopScanPoll() {
  if (scanPoll) { clearInterval(scanPoll); scanPoll = null; }
  _pollErrors = 0;
  _scanRunning = false;
  document.getElementById('scan-btn').disabled = false;
  document.getElementById('cancel-scan-btn').style.display = 'none';
  document.getElementById('scan-progress-wrap').style.display = 'none';
  document.getElementById('scan-progress-bar').style.width = '0%';
  loadResumeInfo();
}

let _scanStartTime = 0;
function _updateScanProgress(p) {
  const pct = p.total > 0 ? Math.round(p.progress / p.total * 100) : 0;
  document.getElementById('scan-progress-bar').style.width = pct + '%';
  document.getElementById('scan-progress-text').textContent = pct + '%';
  const blocksEl = document.getElementById('scan-progress-blocks');
  const foundEl = document.getElementById('scan-progress-found');
  const etaEl = document.getElementById('scan-progress-eta');
  if (blocksEl) blocksEl.textContent = `${(p.progress||0).toLocaleString()} / ${(p.total||0).toLocaleString()} blocks`;
  if (foundEl) foundEl.textContent = `${p.found||0} rewards found`;
  if (etaEl && p.progress > 0 && p.total > 0 && _scanStartTime > 0) {
    const elapsed = (Date.now() - _scanStartTime) / 1000;
    const rate = p.progress / elapsed;
    const remaining = rate > 0 ? Math.ceil((p.total - p.progress) / rate) : 0;
    etaEl.textContent = remaining > 60
      ? `ETA ${Math.floor(remaining/60)}m ${remaining%60}s`
      : (remaining > 0 ? `ETA ${remaining}s` : '');
  }
}

function _logLineClass(text) {
  if (text.startsWith('[gov]')) return 'scan-log-line--gov';
  if (text.startsWith('Error') || text.startsWith('error')) return 'scan-log-line--error';
  if (text.startsWith('⚠')) return 'scan-log-line--warn';
  if (text.startsWith('Done') || text.startsWith('Scan complete') || text.startsWith('done')) return 'scan-log-line--done';
  if (text.startsWith('Resuming') || text.startsWith('[Auto]')) return 'scan-log-line--resume';
  return '';
}

// Shared polling loop for both startScan and resumeScan (fix #7)
function _startScanPolling() {
  const log = document.getElementById('scan-log');
  let lastLogLen = 0;
  _pollErrors = 0;
  scanPoll = setInterval(async () => {
    try {
      const p = await apiJson(API+'/api/scan/progress');
      _updateScanProgress(p);
      if (p.log && p.log.length > lastLogLen) {
        for (let i = lastLogLen; i < p.log.length; i++) {
          // fix #1: apply _logLineClass to ALL lines; mark last line for scroll-anchor only
          const contentClass = _logLineClass(p.log[i]);
          const isLast = i === p.log.length - 1;
          const classes = ['scan-log-line', contentClass, isLast ? 'scan-log-line--last' : ''].filter(Boolean).join(' ');
          log.insertAdjacentHTML('beforeend', `<div class="${classes}">${escHtml(p.log[i])}</div>`);
        }
        lastLogLen = p.log.length; log.scrollTop = log.scrollHeight;
      }
      if (!p.running) {
        _stopScanPoll();
        document.getElementById('scan-status-area').innerHTML = `<div class="success-msg">Scan complete! Found ${p.found||0} rewards.</div>`;
        showToast(`Scan complete! Found ${p.found||0} rewards.`, p.found > 0 ? 'success' : 'info');
        sendBrowserNotification('Beldex Scan Complete', `Found ${p.found||0} new rewards.`);
        loadDashboard();
        loadLastScanInfo();
      }
    } catch(e) {
      _pollErrors = (_pollErrors || 0) + 1;
      if (_pollErrors >= 5) {
        _stopScanPoll();
        document.getElementById('scan-status-area').innerHTML = `<div class="error-msg">Lost connection to server. Refresh the page to check scan status.</div>`;
      }
    }
  }, 1500);
}

async function startScan() {
  if (_scanRunning) { showToast('A scan is already running.', 'warning'); return; }
  const mode = document.querySelector('input[name="scan-mode"]:checked').value;
  let body;
  if (mode==='date') {
    const d = document.getElementById('scan-date').value;
    if (!d) { showToast('Please select a date.', 'warning'); return; }
    // fix #4: reject future dates
    if (d > today()) { showToast('Cannot scan a future date.', 'warning'); return; }
    body = {date: d};
  } else if (mode==='daterange') {
    const fromDate = document.getElementById('scan-from-date').value;
    const toDate = document.getElementById('scan-to-date').value;
    if (!fromDate || !toDate) { showToast('Please select both From and To dates.', 'warning'); return; }
    if (fromDate > toDate) { showToast('From date must be before To date.', 'warning'); return; }
    if (!validateUiDateRange(fromDate, toDate, 'Scan range')) return;
    // fix #4: reject future from-date
    if (fromDate > today()) { showToast('From date cannot be in the future.', 'warning'); return; }
    const spanDays = Math.round((new Date(toDate) - new Date(fromDate)) / 86400000);
    if (spanDays > 14) {
      showScanSafetyModal(spanDays, fromDate, toDate, () => _fireScan({fromDate, toDate}));
      return;
    }
    body = {fromDate, toDate};
  } else {
    const s = document.getElementById('scan-start').value;
    const e = document.getElementById('scan-end').value;
    if (!s || !e) { showToast('Please enter both start and end block heights.', 'warning'); return; }
    const startHeight = parseInt(s, 10);
    const endHeight = parseInt(e, 10);
    if (!Number.isInteger(startHeight) || !Number.isInteger(endHeight) || startHeight < 1 || endHeight < startHeight) {
      showToast('Invalid block range.', 'warning');
      return;
    }
    if (endHeight - startHeight + 1 > MAX_MANUAL_SCAN_BLOCKS) {
      showToast(`Block range too large. Max ${MAX_MANUAL_SCAN_BLOCKS.toLocaleString()} blocks.`, 'warning', 6000);
      return;
    }
    body = {startHeight: s, endHeight: e};
  }

  await _fireScan(body);
}

async function _fireScan(body) {
  try {
    const prog = await fetch(API+'/api/scan/progress');
    if (prog.ok) {
      const progData = await prog.json();
      if (progData.running) {
        showToast('A scan is already running', 'warning'); return;
      }
    }
  } catch(_) { /* progress check failed — proceed with reset */ }
  await apiJson(API+'/api/scan/reset', {method:'POST'});
  let scanResp;
  try {
    scanResp = await apiJson(API+'/api/scan', {method:'POST', headers:{'Content-Type':'application/json'}, body:JSON.stringify(body)});
  } catch(e) {
    showToast('Could not reach server - check connection.', 'error'); return;
  }
  if (!scanResp.started) {
    showToast(scanResp.message || 'Scan could not start.', 'error', 5000); return;
  }
  _scanRunning = true;
  document.getElementById('scan-btn').disabled = true;
  document.getElementById('cancel-scan-btn').style.display = 'block';
  document.getElementById('scan-progress-wrap').style.display = 'block';
  document.getElementById('scan-status-area').innerHTML = '<div class="empty-state"><div class="empty-state-text">Scan started. Watching progress...</div></div>';
  const log = document.getElementById('scan-log'); log.style.display='block'; log.innerHTML='';
  showToast('Scan started', 'info');
  _scanStartTime = Date.now();
  _startScanPolling();
}

async function cancelScan() {
  try {
    await apiJson(API+'/api/scan/cancel', {method:'POST'});
    _stopScanPoll();
    document.getElementById('scan-status-area').innerHTML = '<div class="empty-state"><div class="empty-state-text">Scan cancelled. You can resume it later.</div></div>';
    showToast('Scan cancelled - progress saved. Click Resume to continue later.', 'warning', 5000);
  } catch(e) {
    showToast('Cancel request failed - try again.', 'error');
    // Do NOT reset UI — leave cancel button enabled so user can retry
  }
}

async function resumeScan() {
  if (_scanRunning) { showToast('A scan is already running.', 'warning'); return; }
  // Build body same as current form selection but with resume:true
  const mode = document.querySelector('input[name="scan-mode"]:checked').value;
  let body = { resume: true };
  if (mode === 'date') {
    // fix #3: strip empty strings before sending
    body.date = document.getElementById('scan-date').value || undefined;
  } else if (mode === 'daterange') {
    // fix #3: strip empty strings before sending
    body.fromDate = document.getElementById('scan-from-date').value || undefined;
    body.toDate = document.getElementById('scan-to-date').value || undefined;
  } else {
    body.startHeight = document.getElementById('scan-start').value || undefined;
    body.endHeight = document.getElementById('scan-end').value || undefined;
  }
  await apiJson(API+'/api/scan/reset', {method:'POST'});
  let resumeResp;
  try {
    resumeResp = await apiJson(API+'/api/scan', {method:'POST', headers:{'Content-Type':'application/json'}, body: JSON.stringify(body)});
  } catch(e) {
    showToast('Could not reach server - check connection.', 'error'); return;
  }
  if (!resumeResp.started) {
    showToast(resumeResp.message || 'Could not resume scan.', 'error', 5000); return;
  }
  _scanRunning = true;
  document.getElementById('scan-btn').disabled = true;
  document.getElementById('resume-scan-btn').style.display = 'none';
  document.getElementById('cancel-scan-btn').style.display = 'block';
  document.getElementById('scan-progress-wrap').style.display = 'block';
  document.getElementById('scan-status-area').innerHTML = '<div class="empty-state"><div class="empty-state-text">Resuming scan...</div></div>';
  const log = document.getElementById('scan-log'); log.style.display = 'block'; log.innerHTML = '';
  showToast('Resuming scan from where it stopped...', 'info');
  _scanStartTime = Date.now();
  _startScanPolling();
}

async function loadResumeInfo() {
  try {
    const info = await apiJson(API+'/api/scan/last-height');
    const btn = document.getElementById('resume-scan-btn');
    // Only show Resume when the last scan was explicitly cancelled (not just "last known block")
    if (info && info.height && info.cancelled && !_scanRunning) {
      btn.style.display = 'block';
      btn.textContent = `↺ Resume from block ${info.height.toLocaleString()}`;
    } else {
      btn.style.display = 'none';
    }
  } catch(e) {}
}

// ══════════════════════════════════════════════
// ── Auto-Scan Scheduler ──
// ══════════════════════════════════════════════
async function loadSchedulerStatus() {
  try {
    const cfg = await apiJson(API+'/api/scheduler');
    const badge = document.getElementById('scheduler-status-badge');
    const enableBtn = document.getElementById('scheduler-enable-btn');
    const disableBtn = document.getElementById('scheduler-disable-btn');
    const intervalSel = document.getElementById('scheduler-interval');
    const lastScan = document.getElementById('scheduler-last-scan');

    const pulse = document.getElementById('sched-pulse-dot');
    if (cfg.enabled) {
      if (badge) badge.innerHTML = '';
      if (pulse) pulse.className = 'sched-pulse active';
      enableBtn.style.display = 'none';
      disableBtn.style.display = 'inline-flex';
    } else {
      if (badge) badge.innerHTML = '';
      if (pulse) pulse.className = 'sched-pulse';
      enableBtn.style.display = 'inline-flex';
      disableBtn.style.display = 'none';
    }
    if (intervalSel) intervalSel.value = cfg.intervalHours || 24;
    if (cfg.lastAutoScan) {
      lastScan.textContent = 'Last auto-scan: ' + timeAgo(cfg.lastAutoScan);
    } else {
      lastScan.textContent = 'No auto-scan run yet';
    }
  } catch(e) {}
}

async function toggleScheduler(enable) {
  const intervalHours = parseInt(document.getElementById('scheduler-interval').value) || 24;
  try {
    const cfg = await apiJson(API+'/api/scheduler', {
      method:'POST',
      headers:{'Content-Type':'application/json'},
      body: JSON.stringify({ enabled: enable, intervalHours })
    });
    loadSchedulerStatus();
    if (enable) {
      showToast(`Auto-scan enabled - runs every ${cfg.intervalHours}h`, 'success');
    } else {
      showToast('Auto-scan disabled', 'info');
    }
  } catch(e) {
    showToast('Failed to update scheduler: ' + e.message, 'error');
  }
}


// ══════════════════════════════════════════════
// ── Browser Notifications ──
// ══════════════════════════════════════════════
function requestNotificationPermission() {
  if ('Notification' in window && Notification.permission === 'default') {
    Notification.requestPermission();
  }
}

function sendBrowserNotification(title, body) {
  if ('Notification' in window && Notification.permission === 'granted') {
    new Notification(title, { body, icon: '/favicon.ico' });
  }
}


// ── Scan History ──
// ══════════════════════════════════════════════
// ══════════════════════════════════════════════
// ── Gap Analysis ──
// ══════════════════════════════════════════════
var _gapQueue = [];
var _gapQueueIdx = 0;
var _gapRepairPoll = null;
var _pendingGapDates = [];

async function loadGapAnalysis() {
  const el = document.getElementById('gap-analysis-content');
  const btn = document.getElementById('gap-analyze-btn');
  const fromInput = document.getElementById('gap-from-date');
  const fromDate = fromInput && fromInput.value ? fromInput.value : null;
  if (btn) btn.disabled = true;
  el.innerHTML = '<div class="muted" style="padding:10px;font-size:13px">Analyzing block heights across all scanned dates...</div>';
  try {
    const url = API + '/api/scan/gaps?threshold=50' + (fromDate ? '&from_date=' + fromDate : '');
    const data = await apiJson(url);
    _renderGapResults(data.gaps || [], data.from_date);
  } catch(e) {
    el.innerHTML = '<div class="empty-state"><div class="empty-state-text">Error: ' + escHtml(e.message) + '</div></div>';
  }
  if (btn) btn.disabled = false;
}

function _renderGapResults(gaps, fromDate) {
  const el = document.getElementById('gap-analysis-content');
  const floorNote = fromDate
    ? `<div style="font-size:11px;color:var(--text2);margin-bottom:8px">Checking from <strong style="color:var(--amber);font-family:var(--font-mono)">${fromDate}</strong> onwards</div>`
    : '';
  if (!gaps.length) {
    el.innerHTML = floorNote + '<div class="gap-ok"><span class="gap-ok-icon">✓</span> No gaps detected - all scanned dates look complete.</div>';
    return;
  }
  // Build exact block ranges from DB data — avoids date→height estimation errors
  _pendingGapDates = gaps.map(function(g) {
    return {
      label: g.reward_date,
      startHeight: g.day_end + 1,
      endHeight: g.next_day_start - 1
    };
  });
  var totalMissing = gaps.reduce(function(s, g) { return s + g.trailing_gap; }, 0);

  var html = floorNote + '<div class="gap-summary-bar">' +
    '<span class="gap-badge-warn">' + gaps.length + ' gap' + (gaps.length > 1 ? 's' : '') + ' found</span>' +
    '<span class="muted" style="font-size:12px;margin-left:10px">~' + totalMissing.toLocaleString() + ' unscanned blocks across ' + gaps.length + ' gap(s)</span>' +
    '</div>' +
    '<div style="overflow-x:auto"><table class="gap-table"><thead><tr>' +
    '<th>Date with Gap</th><th>Rewards in DB</th><th>Unscanned Blocks</th><th>Exact Block Range</th>' +
    '</tr></thead><tbody>' +
    gaps.map(function(g) {
      return '<tr id="gap-row-' + escHtml(g.reward_date) + '">' +
        '<td class="mono">' + escHtml(g.reward_date) + '</td>' +
        '<td>' + g.reward_count + '</td>' +
        '<td><span class="gap-missing-count">~' + g.trailing_gap.toLocaleString() + '</span></td>' +
        '<td class="mono" style="font-size:11px;color:var(--text2)">' + (g.day_end + 1) + ' → ' + (g.next_day_start - 1) + '</td>' +
        '</tr>';
    }).join('') +
    '</tbody></table></div>' +
    '<div class="gap-actions">' +
    '<button class="btn btn-primary" id="gap-fix-btn" data-action="start-gap-repair">Fix All Gaps (' + _pendingGapDates.length + ')</button>' +
    '<span id="gap-repair-status" class="muted" style="font-size:12px;margin-left:12px"></span>' +
    '</div>';
  el.innerHTML = html;
}

var _gapRepairActive = false;
var _gapRepairSkipped = 0;

async function startGapRepair() {
  if (_scanRunning || _gapRepairActive) { showToast('A scan is already running - wait for it to finish.', 'warning'); return; }
  if (!_pendingGapDates || !_pendingGapDates.length) return;
  _gapQueue = _pendingGapDates.slice();
  _gapQueueIdx = 0;
  _gapRepairSkipped = 0;
  _gapRepairActive = true;
  var btn = document.getElementById('gap-fix-btn');
  if (btn) btn.disabled = true;
  // Wire cancel button on main scan panel to cancel the repair queue
  var cancelBtn = document.getElementById('cancel-scan-btn');
  if (cancelBtn) { cancelBtn.textContent = '✕ CANCEL REPAIR'; cancelBtn.onclick = cancelGapRepair; }
  showToast('Gap repair started: ' + _gapQueue.length + ' gaps to scan', 'info', 4000);
  _processNextGapDate();
}

function cancelGapRepair() {
  _gapRepairActive = false;
  clearInterval(_gapRepairPoll);
  apiJson(API + '/api/scan/cancel', { method: 'POST' }).catch(() => {});
  var statusEl = document.getElementById('gap-repair-status');
  if (statusEl) statusEl.innerHTML = '<span style="color:var(--amber)">Repair cancelled.</span>';
  _restoreScanPanel();
  showToast('Gap repair cancelled.', 'warning');
}

function _restoreScanPanel() {
  _scanRunning = false;
  var cancelBtn = document.getElementById('cancel-scan-btn');
  if (cancelBtn) { cancelBtn.textContent = '✕ CANCEL'; cancelBtn.onclick = cancelScan; cancelBtn.style.display = 'none'; }
  document.getElementById('scan-btn').disabled = false;
  document.getElementById('scan-progress-wrap').style.display = 'none';
}

async function _processNextGapDate() {
  if (_gapRepairPoll) { clearInterval(_gapRepairPoll); _gapRepairPoll = null; }
  var statusEl = document.getElementById('gap-repair-status');

  // Abort if repair was cancelled
  if (!_gapRepairActive) return;

  if (_gapQueueIdx >= _gapQueue.length) {
    _gapRepairActive = false;
    var skipped = _gapRepairSkipped;
    var repaired = _gapQueue.length - skipped;
    var doneMsg = skipped > 0
      ? repaired + ' gap(s) repaired, ' + skipped + ' failed (could not start scan)'
      : 'All ' + repaired + ' gaps repaired!';
    var doneColor = skipped > 0 ? 'var(--amber)' : 'var(--green)';
    var doneIcon = skipped > 0 ? '&#9888; ' : '&#10003; ';
    if (statusEl) statusEl.innerHTML = '<span style="color:' + doneColor + '">' + doneIcon + doneMsg + '</span>';
    var btn = document.getElementById('gap-fix-btn');
    if (btn) { btn.disabled = false; btn.textContent = 'Re-analyze'; btn.onclick = loadGapAnalysis; }
    _restoreScanPanel();
    document.getElementById('scan-status-area').innerHTML = '<div class="' + (skipped > 0 ? 'warning-msg' : 'success-msg') + '">Gap repair complete — ' + doneMsg + '</div>';
    showToast('Gap repair complete — ' + doneMsg, skipped > 0 ? 'warning' : 'success');
    loadDashboard();
    loadScanHistory();
    return;
  }

  var gap = _gapQueue[_gapQueueIdx];
  var label = gap.label || ('gap ' + (_gapQueueIdx + 1));
  var progress = (_gapQueueIdx + 1) + ' of ' + _gapQueue.length;
  if (statusEl) statusEl.textContent = 'Scanning ' + progress + ': ' + label + '…';

  try {
    await apiJson(API + '/api/scan/reset', { method: 'POST' });
    var resp = await apiJson(API + '/api/scan', { method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ startHeight: gap.startHeight, endHeight: gap.endHeight }) });
    if (!resp.started) {
      _gapRepairSkipped++;
      _gapQueueIdx++;
      setTimeout(_processNextGapDate, 600);
      return;
    }
  } catch(e) {
    _gapRepairSkipped++;
    _gapQueueIdx++;
    setTimeout(_processNextGapDate, 600);
    return;
  }

  // Show progress in the main scan monitor with a clear "GAP REPAIR" badge
  document.getElementById('scan-progress-wrap').style.display = 'block';
  document.getElementById('scan-btn').disabled = true;
  document.getElementById('cancel-scan-btn').style.display = 'block';
  document.getElementById('scan-status-area').innerHTML =
    '<div class="gap-repair-badge">GAP REPAIR ' + progress + '</div>' +
    '<div class="empty-state"><div class="empty-state-text">' + escHtml(label) + ' &mdash; blocks ' + gap.startHeight + '&ndash;' + gap.endHeight + '</div></div>';
  var log = document.getElementById('scan-log');
  log.style.display = 'block';
  log.innerHTML = '';
  var lastLogLen = 0;

  _gapRepairPoll = setInterval(async function() {
    if (!_gapRepairActive) { clearInterval(_gapRepairPoll); return; }
    try {
      var p = await apiJson(API + '/api/scan/progress');
      var pct = p.total > 0 ? Math.round(p.progress / p.total * 100) : 0;
      document.getElementById('scan-progress-bar').style.width = pct + '%';
      document.getElementById('scan-progress-text').textContent = pct + '% — ' + (p.progress||0).toLocaleString() + ' / ' + (p.total||0).toLocaleString() + ' blocks';
      if (p.log && p.log.length > lastLogLen) {
        for (var i = lastLogLen; i < p.log.length; i++) {
          log.insertAdjacentHTML('beforeend', '<div class="scan-log-line">' + escHtml(p.log[i]) + '</div>');
        }
        lastLogLen = p.log.length;
        log.scrollTop = log.scrollHeight;
      }
      if (!p.running) {
        clearInterval(_gapRepairPoll);
        document.getElementById('scan-status-area').innerHTML =
          '<div class="gap-repair-badge">GAP REPAIR ' + progress + '</div>' +
          '<div class="success-msg">Done: ' + escHtml(label) + ' -found ' + (p.found||0) + ' new rewards.</div>';
        _gapQueueIdx++;
        setTimeout(_processNextGapDate, 800);
      }
    } catch(e) {}
  }, 1500);
}

// ══════════════════════════════════════════════
// ── Feature: Explorer Connection Status ──
// ══════════════════════════════════════════════
async function loadExplorerStatus() {
  const dot    = document.getElementById('esb-dot');
  const label  = document.getElementById('esb-status-text');
  const latEl  = document.getElementById('esb-latency');
  const heightEl = document.getElementById('esb-height');
  const bar    = document.getElementById('explorer-status-bar');
  if (!bar) return;

  dot.className = 'esb-dot esb-dot-checking';
  label.textContent = 'Checking...';
  latEl.textContent = '';
  heightEl.textContent = '';

  try {
    const d = await apiJson(API + '/api/explorer/status');
    if (d.ok) {
      const slow = d.slow;
      dot.className = 'esb-dot ' + (slow ? 'esb-dot-slow' : 'esb-dot-ok');
      label.textContent = slow ? 'SLOW CONNECTION' : 'LINK NOMINAL';
      latEl.textContent = d.latency + 'ms';
      if (d.height) heightEl.textContent = '⬡ ' + Number(d.height).toLocaleString();
      bar.className = 'explorer-status-bar esb-' + (slow ? 'slow' : 'ok');
    } else {
      dot.className = 'esb-dot esb-dot-offline';
      label.textContent = 'SIGNAL LOST';
      latEl.textContent = '';
      heightEl.textContent = '';
      bar.className = 'explorer-status-bar esb-offline';
    }
  } catch(e) {
    dot.className = 'esb-dot esb-dot-offline';
    label.textContent = 'SIGNAL LOST';
    bar.className = 'explorer-status-bar esb-offline';
  }
}

// ══════════════════════════════════════════════
// ── Feature: Stuck Scan Recovery ──
// ══════════════════════════════════════════════
async function checkStuckScan() {
  try {
    const p = await apiJson(API + '/api/scan/progress');
    const alert = document.getElementById('stuck-scan-alert');
    if (!alert) return;
    // Show recovery if server thinks scan is running but we know it's not (page reload scenario)
    if (p.running && !_scanRunning) {
      alert.style.display = 'flex';
      alert.style.animation = 'ssaSlideIn 0.35s cubic-bezier(0.34,1.56,0.64,1)';
    } else {
      alert.style.display = 'none';
    }
  } catch(e) {}
}

async function resetStuckScan() {
  const btn = document.getElementById('ssa-reset-btn');
  if (btn) { btn.disabled = true; btn.textContent = 'Resetting...'; }
  try {
    await apiJson(API + '/api/scan/reset?force=true', {method:'POST'});
    const alert = document.getElementById('stuck-scan-alert');
    if (alert) alert.style.display = 'none';
    showToast('Scan state cleared — you can start a new scan.', 'success', 4000);
    loadResumeInfo();
  } catch(e) {
    showToast('Reset failed — try refreshing the page.', 'error');
    if (btn) { btn.disabled = false; btn.textContent = '↺ RESET STUCK SCAN'; }
  }
}

// ══════════════════════════════════════════════
// ── Feature: Scan Coverage Calendar ──
// ══════════════════════════════════════════════
async function loadScanCoverage() {
  const wrap = document.getElementById('scan-coverage-wrap');
  if (!wrap) return;
  try {
    const data = await apiJson(API + '/api/scan/coverage?days=90');
    _renderCoverageCalendar(wrap, data.scanned || [], data.from, data.to);
  } catch(e) {
    wrap.innerHTML = '<div class="scan-empty">Coverage data unavailable</div>';
  }
}

function _renderCoverageCalendar(wrap, scannedDates, from, to) {
  const scannedSet = new Set(scannedDates);
  const todayStr   = new Date().toISOString().slice(0, 10);
  const MONTH_NAMES = ['January','February','March','April','May','June',
                       'July','August','September','October','November','December'];
  const DOW = ['S','M','T','W','T','F','S'];

  // Build list of months to show (last 3)
  const toDate   = new Date(to   + 'T00:00:00Z');
  const months   = [];
  for (let i = 2; i >= 0; i--) {
    const y = toDate.getUTCFullYear();
    const m = toDate.getUTCMonth() - i;
    const d = new Date(Date.UTC(y, m, 1));
    months.push({ year: d.getUTCFullYear(), month: d.getUTCMonth() });
  }

  // Count stats
  const totalPastDays  = scannedDates.length > 0
    ? (() => {
        let n = 0;
        const s = new Date(from + 'T00:00:00Z');
        const e = new Date(todayStr + 'T00:00:00Z');
        for (let d = new Date(s); d <= e; d.setUTCDate(d.getUTCDate() + 1)) n++;
        return n;
      })()
    : 0;
  const scannedCount   = scannedSet.size;
  const missingCount   = Math.max(0, totalPastDays - scannedCount);
  const coveragePct    = totalPastDays > 0 ? Math.round(scannedCount / totalPastDays * 100) : 0;

  let html = `<div class="cov-stats-bar">
    <div class="cov-stat"><span class="cov-stat-val cov-stat-green">${scannedCount}</span><span class="cov-stat-label">Scanned</span></div>
    <div class="cov-stat"><span class="cov-stat-val cov-stat-red">${missingCount}</span><span class="cov-stat-label">Missing</span></div>
    <div class="cov-stat"><span class="cov-stat-val">${coveragePct}%</span><span class="cov-stat-label">Coverage</span></div>
    <div class="cov-stat"><span class="cov-stat-val">${totalPastDays}</span><span class="cov-stat-label">Days Tracked</span></div>
  </div><div class="cov-calendar-grid">`;

  for (const {year, month} of months) {
    const daysInMonth = new Date(Date.UTC(year, month + 1, 0)).getUTCDate();
    const firstDow    = new Date(Date.UTC(year, month, 1)).getUTCDay();

    html += `<div class="cov-month">
      <div class="cov-month-header"><span class="cov-month-name">${MONTH_NAMES[month]}</span><span class="cov-month-year">${year}</span></div>
      <div class="cov-dow-row">${DOW.map(d => `<span class="cov-dow">${d}</span>`).join('')}</div>
      <div class="cov-day-grid">`;

    for (let i = 0; i < firstDow; i++) html += `<span class="cov-day-cell cov-cell-empty"></span>`;

    for (let day = 1; day <= daysInMonth; day++) {
      const ds  = `${year}-${String(month+1).padStart(2,'0')}-${String(day).padStart(2,'0')}`;
      const isFuture  = ds > todayStr;
      const isToday   = ds === todayStr;
      const isScanned = scannedSet.has(ds);

      let cls = 'cov-day-cell';
      let tip = ds;
      if (isFuture)       { cls += ' cov-cell-future'; }
      else if (isScanned) { cls += ' cov-cell-scanned'; if (isToday) cls += ' cov-cell-today'; tip += ' · scanned'; }
      else                { cls += ' cov-cell-missing'; if (isToday) cls += ' cov-cell-today'; tip += ' · no scan'; }

      html += `<span class="${cls}" title="${tip}" data-date="${ds}"><span class="cov-day-num">${day}</span></span>`;
    }
    html += `</div></div>`;
  }

  html += '</div>';
  wrap.innerHTML = html;

  // Cell click — quick-fill the date field
  wrap.querySelectorAll('.cov-day-cell[data-date]').forEach(cell => {
    cell.addEventListener('click', () => {
      const d = cell.dataset.date;
      if (!d || d > todayStr) return;
      const inp = document.getElementById('scan-date');
      if (inp) {
        inp.value = d;
        document.querySelector('input[name="scan-mode"][value="date"]').checked = true;
        setScanMode('date');
        inp.dispatchEvent(new Event('change'));
        showToast('Date set to ' + d + ' — click Execute Scan to scan it.', 'info', 3000);
      }
    });
  });
}

// ══════════════════════════════════════════════
// ── Feature: Scan Safety Modal ──
// ══════════════════════════════════════════════
function showScanSafetyModal(spanDays, fromDate, toDate, onConfirm) {
  const overlay  = document.getElementById('safety-modal-overlay');
  const input    = document.getElementById('safety-confirm-input');
  const procBtn  = document.getElementById('safety-proceed-btn');
  const cancelBtn = document.getElementById('safety-cancel-btn');
  if (!overlay) { onConfirm(); return; }

  const estMinutes = Math.ceil(spanDays * 1440 / (10 * 60)); // rough: 10 blocks/s, ~1440 blocks/day
  const estHours   = estMinutes > 90 ? (estMinutes / 60).toFixed(1) + 'h' : estMinutes + 'm';
  const approxBlocks = (spanDays * 1440).toLocaleString();

  document.getElementById('safety-range-val').textContent  = fromDate + ' → ' + toDate + ' (' + spanDays + ' days)';
  document.getElementById('safety-time-val').textContent   = '~' + estHours;
  document.getElementById('safety-blocks-val').textContent = '~' + approxBlocks + ' blocks';

  input.value = '';
  procBtn.disabled = true;
  overlay.style.display = 'flex';
  setTimeout(() => input.focus(), 100);

  function onInput() {
    procBtn.disabled = input.value.trim().toUpperCase() !== 'CONFIRM';
  }
  function onProceed() {
    cleanup();
    overlay.style.display = 'none';
    onConfirm();
  }
  function onCancel() {
    cleanup();
    overlay.style.display = 'none';
  }
  function onKeydown(e) {
    if (e.key === 'Escape') onCancel();
    if (e.key === 'Enter' && !procBtn.disabled) onProceed();
  }
  function cleanup() {
    input.removeEventListener('input', onInput);
    procBtn.removeEventListener('click', onProceed);
    cancelBtn.removeEventListener('click', onCancel);
    document.removeEventListener('keydown', onKeydown);
  }

  input.addEventListener('input', onInput);
  procBtn.addEventListener('click', onProceed);
  cancelBtn.addEventListener('click', onCancel);
  document.addEventListener('keydown', onKeydown);
}

// ══════════════════════════════════════════════
// ── Feature: Enhanced Scan History ──
// ══════════════════════════════════════════════
async function loadScanHistory() {
  try {
    const data = await apiJson(API+'/api/scan-history');
    const wrap = document.getElementById('scan-history-list');
    if (!wrap) return;
    if (!data.length) {
      wrap.innerHTML = '<div class="empty-state"><div class="empty-state-text">No completed scans yet</div></div>';
      return;
    }
    const limitNotice = data.length > 100
      ? '<div class="info-banner">Showing 100 most recent of ' + data.length + ' total scans.</div>'
      : '';
    wrap.innerHTML = limitNotice + data.slice(0, 100).map(s => {
      const dateLabel = s.date_from && s.date_to
        ? (s.date_from === s.date_to ? escHtml(s.date_from) : `${escHtml(s.date_from)} → ${escHtml(s.date_to)}`)
        : (s.start_height ? `Block scan` : '—');
      const dur = s.duration_seconds >= 3600
        ? `${Math.floor(s.duration_seconds/3600)}h ${Math.floor((s.duration_seconds%3600)/60)}m`
        : s.duration_seconds >= 60
          ? `${Math.floor(s.duration_seconds/60)}m ${s.duration_seconds%60}s`
          : `${s.duration_seconds}s`;
      const typeClass = s.scan_type === 'date' ? 'scan-hist-type--date'
        : s.scan_type === 'block_range' ? 'scan-hist-type--block'
        : 'scan-hist-type--range';
      const typeLabel = s.scan_type === 'date' ? 'DATE'
        : s.scan_type === 'block_range' ? 'BLOCKS'
        : 'RANGE';
      const hasBlocks   = s.start_height && s.end_height;
      const blockCount  = hasBlocks ? (s.end_height - s.start_height + 1).toLocaleString() : null;
      const blockRange  = hasBlocks
        ? `${Number(s.start_height).toLocaleString()} → ${Number(s.end_height).toLocaleString()}`
        : null;
      const rewardColor = s.rewards_found === 0 ? 'shc-rewards-zero'
        : s.rewards_found < 5 ? 'shc-rewards-low' : 'shc-rewards-high';

      return `<div class="shc-card">
        <div class="shc-top">
          <span class="scan-hist-type ${typeClass}">${typeLabel}</span>
          <span class="shc-date-range">${dateLabel}</span>
          <span class="shc-spacer"></span>
          <span class="shc-ago">${timeAgo(s.scanned_at)}</span>
        </div>
        <div class="shc-bottom">
          ${blockRange ? `<span class="shc-tel"><span class="shc-tel-lbl">BLOCKS</span><span class="shc-tel-val">${blockRange}</span></span>` : ''}
          ${blockCount ? `<span class="shc-tel"><span class="shc-tel-lbl">COUNT</span><span class="shc-tel-val">${blockCount}</span></span>` : ''}
          <span class="shc-tel"><span class="shc-tel-lbl">DURATION</span><span class="shc-tel-val">${dur}</span></span>
          <span class="shc-spacer"></span>
          <span class="shc-rewards ${rewardColor}">+${s.rewards_found} rewards</span>
        </div>
      </div>`;
    }).join('');
  } catch(e) {}
}

