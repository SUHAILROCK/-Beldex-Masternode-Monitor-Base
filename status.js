// ══════════════════════════════════════════════
// ── Status ──
// ══════════════════════════════════════════════
let _statusCancelling = false;

async function startStatusCheck() {
  if (_statusCancelling) { showToast('Cancel in progress...', 'warn'); return; }
  if (statusPoll) { showToast('Status check already running.', 'warning'); return; }
  document.getElementById('status-check-btn').disabled = true;
  document.getElementById('status-cancel-btn').style.display = 'inline-flex';
  document.getElementById('status-progress-wrap').style.display = 'block';
  await apiJson(API+'/api/status/check', {method:'POST'});
  showToast('Status check started...', 'info');
  statusPoll = setInterval(async () => {
    try {
      const p = await apiJson(API+'/api/status/progress');
      const isStatusTabActive = document.getElementById('tab-status')?.classList.contains('active');
      if (isStatusTabActive) {
        const pct = p.total > 0 ? Math.round(p.checked / p.total * 100) : 0;
        document.getElementById('status-progress-bar').style.width = pct + '%';
        document.getElementById('status-progress-text').textContent = `${p.checked} / ${p.total} nodes checked`;
        renderStatusResults(p.results || []);
      }
      if (!p.running) {
        clearInterval(statusPoll); statusPoll = null;
        document.getElementById('status-check-btn').disabled = false;
        document.getElementById('status-cancel-btn').style.display = 'none';
        document.getElementById('status-progress-wrap').style.display = 'none';
        showToast('Status check complete', 'success');
        loadAlertBanner();
      }
    } catch(e) {}
  }, 2000);
}

async function cancelStatusCheck() {
  if (!statusPoll) return;
  _statusCancelling = true;
  try {
    await apiJson(API+'/api/status/cancel', {method:'POST'});
    if (statusPoll) { clearInterval(statusPoll); statusPoll = null; }
    document.getElementById('status-check-btn').disabled = false;
    document.getElementById('status-cancel-btn').style.display = 'none';
    document.getElementById('status-progress-wrap').style.display = 'none';
    showToast('Status check cancelled', 'warning');
  } finally {
    _statusCancelling = false;
  }
}

async function loadLatestStatus() {
  showSkeleton('status-active-list', 3);
  showSkeleton('status-issue-list', 2);
  try {
    const data = await apiJson(API+'/api/status/latest');
    renderStatusResults(data);
    loadAlertBanner();
  } catch(e) {
    showToast('Failed to load status: ' + e.message, 'error');
  }
}

function renderStatusResults(results) {
  var active = results.filter(function(r) { return r.status==='active'; });
  var issues = results.filter(function(r) { return r.status!=='active'; });
  var summaryEl = document.getElementById('status-summary');
  if (summaryEl) {
    var total = results.length;
    var activePct = total ? Math.round(active.length / total * 100) : 0;
    var issuePct = total ? Math.round(issues.length / total * 100) : 0;
    var updated = results[0] && results[0].checked_at ? escHtml(String(results[0].checked_at)) : 'Load saved or run a check';
    summaryEl.innerHTML =
      '<div class="status-summary-card status-summary-card-total"><span>Total checked</span><strong>' + total.toLocaleString() + '</strong><em>' + updated + '</em></div>' +
      '<div class="status-summary-card status-summary-card-good"><span>Active</span><strong>' + active.length.toLocaleString() + '</strong><em>' + activePct + '% healthy</em></div>' +
      '<div class="status-summary-card status-summary-card-issue"><span>Issues</span><strong>' + issues.length.toLocaleString() + '</strong><em>' + issuePct + '% need review</em></div>';
  }
  var badgeClass = function(s) { return s==='active'?'badge-green':s==='decommissioned'||s==='deregistered'?'badge-red':s==='error'?'badge-red':'badge-yellow'; };
  var renderStatusRows = function(list, si) {
    if (!list.length) return '<div class="empty-state"><div class="empty-state-icon">◉</div><div class="empty-state-text">None</div></div>';
    return '<table><thead><tr><th>#</th><th>Label</th><th>Key</th><th>Status</th><th>Version</th><th>Uptime</th></tr></thead><tbody>' +
    list.map(function(s,i) { return '<tr><td>' + (si+i+1) + '</td><td>' + escHtml(s.label||s.walletName||shortKey(s.pubkey)) + '</td><td class="mono">' + shortKey(s.pubkey) + '<button class="copy-btn" data-action="copy" data-copy-value="' + escHtml(s.pubkey) + '">⎘</button></td><td><span class="badge ' + badgeClass(s.status) + '">' + escHtml(s.status) + '</span></td><td class="muted">' + escHtml(s.version||'-') + '</td><td class="muted">' + escHtml(s.last_uptime_proof||'-') + '</td></tr>'; }).join('') +
    '</tbody></table>';
  };
  var activeEl = document.getElementById('status-active-list');
  if (active.length) {
    activeEl.innerHTML = '<div id="status-active-pag-wrap"></div>';
    pagInit('statusActive', active, 25, renderStatusRows, 'status-active-pag-wrap');
  } else { activeEl.innerHTML = renderStatusRows([], 0); }
  var issueEl = document.getElementById('status-issue-list');
  if (issues.length) {
    issueEl.innerHTML = '<div id="status-issue-pag-wrap"></div>';
    pagInit('statusIssues', issues, 25, renderStatusRows, 'status-issue-pag-wrap');
  } else { issueEl.innerHTML = renderStatusRows([], 0); }
}




