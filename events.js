'use strict';
/**
 * events.js — Replaces all inline onclick/oninput/onchange handlers in index.html.
 * Loaded last so all JS modules are already in global scope.
 * After this file is loaded, CSP can drop 'unsafe-inline' from scriptSrc/scriptSrcAttr.
 */

function viewerBlock(fn) {
  return function(...args) {
    if (isViewer()) { showToast('View-only access — action not permitted', 'warning'); return; }
    return fn.apply(this, args);
  };
}

document.addEventListener('DOMContentLoaded', () => {

  // ── Sidebar / Top bar ────────────────────────────────────
  on('sidebar-toggle',     'click', toggleSidebar);
  on('logout-btn',         'click', logOut);
  on('quick-scan-btn',     'click', viewerBlock(quickScanToday));

  // ── Mobile bottom navigation ──────────────────────────────
  delegate('.mbn-item', 'click', (el, e) => {
    e.preventDefault();
    if (el.dataset.tab) switchTab(el.dataset.tab);
  });

  // ── Dashboard ────────────────────────────────────────────
  on('dash-manage-nodes-btn', 'click', () => switchTab('nodes'));

  delegate('.cpt-btn', 'click', el => {
    if (el.dataset.days === 'monthly') switchChartMonthly(el);
    else switchChartPeriod(Number(el.dataset.days), el);
  });
  delegate('.cct-btn', 'click', el => switchChartCurrency(el.dataset.currency, el));

  // ── Nodes tab ────────────────────────────────────────────
  on('import-all-btn',       'click', viewerBlock(importAllGroups));
  on('check-duplicates-btn', 'click', viewerBlock(checkGroupDuplicates));
  on('add-node-open-btn',    'click', viewerBlock(showAddNodeModal));
  on('clear-nodes-btn',      'click', viewerBlock(clearAllNodes));
  on('copy-wallet-keys-btn', 'click', copySelectedWalletKeys);
  oninput('nodes-search',    v => filterNodes(v));

  // ── Scheduler bar ────────────────────────────────────────
  on('scheduler-enable-btn',  'click', viewerBlock(() => toggleScheduler(true)));
  on('scheduler-disable-btn', 'click', viewerBlock(() => toggleScheduler(false)));

  // Scan mode radio buttons
  document.querySelectorAll('[name="scan-mode"]').forEach(el => {
    el.addEventListener('change', e => setScanMode(e.target.value));
  });

  // ── Scan tab ─────────────────────────────────────────────
  on('scan-btn',              'click', viewerBlock(startScan));
  on('resume-scan-btn',       'click', viewerBlock(resumeScan));
  on('cancel-scan-btn',       'click', viewerBlock(cancelScan));
  on('scan-history-refresh-btn', 'click', loadScanHistory);
  on('gap-analyze-btn',       'click', loadGapAnalysis);
  on('esb-refresh-btn',       'click', loadExplorerStatus);
  on('ssa-reset-btn',         'click', viewerBlock(resetStuckScan));

  // ── Reports tabs (delegation) ─────────────────────────────
  delegate('.report-tab', 'click', el => switchReportTab(el.dataset.rtab));

  on('daily-load-btn',    'click', loadDailyReport);
  on('daily-excel-btn',   'click', viewerBlock(() => downloadExcel('daily')));
  on('daily-csv-btn',     'click', viewerBlock(() => downloadCsv('daily')));

  on('monthly-load-btn',  'click', loadMonthlyReport);
  on('monthly-excel-btn', 'click', viewerBlock(() => downloadExcel('monthly')));
  on('monthly-csv-btn',   'click', viewerBlock(() => downloadCsv('monthly')));

  on('range-load-btn',    'click', loadRangeReport);
  on('range-excel-btn',   'click', viewerBlock(() => downloadExcel('range')));
  on('range-csv-btn',     'click', viewerBlock(() => downloadCsv('range')));

  on('matrix-load-btn',   'click', loadMatrixReport);
  on('matrix-csv-btn',    'click', viewerBlock(downloadMatrixCsv));
  on('matrix-excel-btn',  'click', viewerBlock(() => downloadExcel('matrix')));

  on('roi-refresh-btn',   'click', () => { _roiLoaded = false; loadRoiReport(); });

  on('leaderboard-load-btn', 'click', loadLeaderboard);

  on('grouped-load-btn',  'click', loadGroupedReport);
  on('grouped-excel-btn', 'click', viewerBlock(() => downloadExcel('grouped')));

  on('perkey-load-btn',   'click', loadPerKeyReport);
  on('perkey-excel-btn',  'click', viewerBlock(() => downloadExcel('per-key')));

  // ── Analytics nav (delegation via data-section) ──────────
  delegate('.analytics-nav-btn', 'click', el => scrollToAnalytics(el.dataset.section, el));

  // Portfolio intelligence period tabs (delegation via data-days)
  delegate('.pi-tab', 'click', el => setPiPeriod(Number(el.dataset.days), el));

  on('nethistory-refresh-btn', 'click', () => { _analyticsLoaded['nethistory-section'] = false; loadNetworkHistory(); });
  on('topearners-load-btn',    'click', loadTopEarners);

  oninput('nhm-search', v => filterNHM(v));
  oninput('lowperf-search', v => filterAnalyticsTable('lowperf-content', 'lowperf-search'));
  on('lowperf-refresh-btn', 'click', loadLowPerformers);

  onchange('heatmap-year', () => loadHeatmap());
  delegate('#heatmap-container .hm-cell[data-action-target]', 'click', handleHeatmapDayOpen);
  delegate('#heatmap-container .hm-cell[data-action-target]', 'keydown', (el, e) => {
    if (e.key === 'Enter' || e.key === ' ') {
      e.preventDefault();
      handleHeatmapDayOpen(el);
    }
  });

  oninput('anomaly-search', v => filterAnalyticsTable('anomaly-table', 'anomaly-search'));
  on('anomaly-refresh-btn',    'click', loadAnomalies);

  // ── Backfill / Gaps ──────────────────────────────────────
  on('backfill-trigger-btn',   'click', viewerBlock(triggerBackfill));
  on('backfill-detect-btn',    'click', viewerBlock(loadGaps));
  on('backfill-cancel-btn',    'click', viewerBlock(cancelBackfill));

  // ── Database tab ─────────────────────────────────────────
  on('prune-btn',              'click', viewerBlock(pruneRewards));
  on('db-stats-refresh-btn',   'click', loadDbDetailedStats);
  on('db-backup-btn',          'click', viewerBlock(downloadDb));
  on('vacuum-btn',             'click', viewerBlock(runVacuum));
  on('archive-btn',            'click', viewerBlock(runArchive));
  on('archive-log-refresh-btn','click', loadArchiveLog);

  // ── Node Status tab ──────────────────────────────────────
  on('status-check-btn',       'click', viewerBlock(startStatusCheck));
  on('status-cancel-btn',      'click', viewerBlock(cancelStatusCheck));
  on('status-load-saved-btn',  'click', loadLatestStatus);
  on('status-excel-btn',       'click', viewerBlock(() => downloadExcel('status')));
  on('status-csv-btn',         'click', viewerBlock(() => downloadCsv('status')));

  // ── Modals ────────────────────────────────────────────────
  // Node detail modal
  const ndOverlay = document.getElementById('node-detail-modal');
  if (ndOverlay) ndOverlay.addEventListener('click', closeNodeDetail);
  on('node-detail-close-btn', 'click', () => { if (ndOverlay) ndOverlay.style.display = 'none'; });

  document.addEventListener('keydown', (e) => {
    if (e.key !== 'Escape') return;

    // Close topmost visible modal in reverse priority order
    const matrixModal = document.querySelector('.matrix-modal-overlay');
    if (matrixModal && matrixModal.style.display !== 'none') {
      _closeMatrixDrill();
      return;
    }

    const safetyModal = document.getElementById('safety-modal-overlay');
    if (safetyModal && safetyModal.style.display !== 'none') {
      safetyModal.style.display = 'none';
      return;
    }

    const addNodeOverlayEsc = document.getElementById('add-node-modal');
    if (addNodeOverlayEsc && addNodeOverlayEsc.style.display !== 'none') {
      addNodeOverlayEsc.style.display = 'none';
      return;
    }

    const groupPreviewOverlayEsc = document.getElementById('group-preview-modal');
    if (groupPreviewOverlayEsc && groupPreviewOverlayEsc.style.display !== 'none') {
      closeGroupPreviewModal();
      return;
    }

    const drillOverlayEsc = document.getElementById('drillthrough-modal');
    if (drillOverlayEsc && drillOverlayEsc.style.display !== 'none') {
      closeDrillModal();
      return;
    }

    if (ndOverlay && ndOverlay.style.display !== 'none') {
      ndOverlay.style.display = 'none';
    }
  });

  // Drill-through modal
  const drillOverlay = document.getElementById('drillthrough-modal');
  if (drillOverlay) drillOverlay.addEventListener('click', closeDrillModal);
  on('drill-close-btn', 'click', () => closeDrillModal());

  // Add Node modal
  const addNodeOverlay = document.getElementById('add-node-modal');
  if (addNodeOverlay) addNodeOverlay.addEventListener('click', closeAddNodeModal);
  on('add-node-close-btn',  'click', () => { if (addNodeOverlay) addNodeOverlay.style.display = 'none'; });
  on('add-node-cancel-btn', 'click', () => { if (addNodeOverlay) addNodeOverlay.style.display = 'none'; });
  on('modal-submit-btn',    'click', submitNodeModal);

  // Seed group modal
  const groupPreviewOverlay = document.getElementById('group-preview-modal');
  if (groupPreviewOverlay) groupPreviewOverlay.addEventListener('click', closeGroupPreviewModal);
  if (groupPreviewOverlay) groupPreviewOverlay.addEventListener('keydown', handleGroupPreviewModalKeydown);
  on('group-preview-close-btn', 'click', () => closeGroupPreviewModal());

  // Generated UI actions: tables, pagination, matrix toolbar, modals, copy buttons.
  document.addEventListener('click', handleGeneratedClick);
  document.addEventListener('input', handleGeneratedInput);
  document.addEventListener('change', handleGeneratedChange);

  // Restore saved timezone toggle state
  const savedTz = localStorage.getItem('report-tz') || 'utc';
  document.querySelectorAll('.tz-pill').forEach(b => b.classList.toggle('tz-pill-active', b.dataset.tz === savedTz));
  const tzHint = document.getElementById('tz-hint');
  if (tzHint) tzHint.style.display = savedTz === 'ist' ? 'flex' : 'none';
});

// ── Helpers ──────────────────────────────────────────────────
function on(id, event, handler) {
  const el = document.getElementById(id);
  if (el) el.addEventListener(event, handler);
}

function oninput(id, handler) {
  const el = document.getElementById(id);
  if (el) el.addEventListener('input', e => handler(e.target.value));
}

function onchange(id, handler) {
  const el = document.getElementById(id);
  if (el) el.addEventListener('change', handler);
}

function delegate(selector, event, handler) {
  document.addEventListener(event, e => {
    const el = e.target.closest(selector);
    if (el) handler(el, e);
  });
}

function handleGeneratedClick(e) {
  const el = e.target.closest('[data-action]');
  if (!el) return;
  const action = el.dataset.action;

  if (action === 'copy') {
    e.preventDefault();
    e.stopPropagation();
    copyToClipboard(el.dataset.copyValue || '', el);
    return;
  }

  if (action === 'switch-tab') {
    e.preventDefault();
    const VALID_TABS = ['dashboard','nodes','scan','reports','analytics','status','database'];
    if (!VALID_TABS.includes(el.dataset.tab)) return;
    switchTab(el.dataset.tab);
    return;
  }

  if (action === 'node-detail') {
    e.preventDefault();
    e.stopPropagation();
    if (el.dataset.closeDrill) closeDrillModal();
    showNodeDetail(el.dataset.pubkey);
    return;
  }

  if (action === 'close-drill') {
    e.preventDefault();
    closeDrillModal();
    return;
  }

  if (action === 'matrix-close') {
    e.preventDefault();
    _closeMatrixDrill();
    return;
  }

  if (action === 'pag-go') {
    e.preventDefault();
    pagGo(el.dataset.pagId, Number(el.dataset.page));
    return;
  }

  if (action === 'sort-nodes') {
    e.preventDefault();
    sortNodes(el.dataset.key);
    return;
  }

  if (action === 'edit-node') {
    e.preventDefault();
    if (isViewer()) { showToast('View-only access — action not permitted', 'warning'); return; }
    showEditNodeModal(el.dataset.pubkey);
    return;
  }

  if (action === 'delete-node') {
    e.preventDefault();
    removeNode(el.dataset.pubkey);
    return;
  }

  if (action === 'preview-group') {
    e.preventDefault();
    openGroupPreviewModal(Number(el.dataset.index));
    return;
  }

  if (action === 'import-group') {
    e.preventDefault();
    if (isViewer()) { showToast('View-only access — action not permitted', 'warning'); return; }
    importGroup(Number(el.dataset.index));
    return;
  }

  if (action === 'show-group-registry') {
    e.preventDefault();
    showGroupInRegistry(el.dataset.wallet || '');
    closeGroupPreviewModal();
    return;
  }

  if (action === 'seed-add') {
    e.preventDefault();
    if (isViewer()) { showToast('View-only access — action not permitted', 'warning'); return; }
    showSeedKeyAddModal(Number(el.dataset.index), el.dataset.pubkey || '');
    return;
  }

  if (action === 'seed-add-group') {
    e.preventDefault();
    if (isViewer()) { showToast('View-only access — action not permitted', 'warning'); return; }
    showSeedGroupAddModal(Number(el.dataset.index));
    return;
  }

  if (action === 'import-all-groups') {
    e.preventDefault();
    if (isViewer()) { showToast('View-only access — action not permitted', 'warning'); return; }
    importAllGroups();
    return;
  }

  if (action === 'matrix-view') {
    e.preventDefault();
    _setMatrixView(el.dataset.value);
    return;
  }

  if (action === 'matrix-currency') {
    e.preventDefault();
    _setMatrixCurrency(el.dataset.value);
    return;
  }

  if (action === 'matrix-grouping') {
    e.preventDefault();
    _setMatrixGrouping(el.dataset.value);
    return;
  }

  if (action === 'matrix-density') {
    e.preventDefault();
    _setMatrixDensity(el.dataset.value);
    return;
  }

  if (action === 'anomaly-drill') {
    e.preventDefault();
    openAnomalyDrill(
      el.dataset.pubkey,
      el.dataset.label,
      el.dataset.wallet,
      el.dataset.days,
      el.dataset.avg,
      el.dataset.last,
      el.dataset.ratio
    );
    return;
  }

  if (action === 'prune-status') {
    e.preventDefault();
    if (isViewer()) { showToast('View-only access — action not permitted', 'warning'); return; }
    pruneStatusRows();
    return;
  }

  if (action === 'wallet-import-scan') {
    e.preventDefault();
    if (isViewer()) { showToast('View-only access — action not permitted', 'warning'); return; }
    runWalletImportScan();
    return;
  }

  if (action === 'start-gap-repair') {
    e.preventDefault();
    startGapRepair();
    return;
  }

  if (action === 'show-silent') {
    e.preventDefault();
    renderSilentPanel(el.dataset.pagId);
    return;
  }

  if (action === 'set-tz') {
    e.preventDefault();
    localStorage.setItem('report-tz', el.dataset.tz);
    document.querySelectorAll('.tz-pill').forEach(b => b.classList.toggle('tz-pill-active', b.dataset.tz === el.dataset.tz));
    const hint = document.getElementById('tz-hint');
    if (hint) hint.style.display = el.dataset.tz === 'ist' ? 'flex' : 'none';
    // reload active report after tz change — only if user already generated it
    const activeRtab = document.querySelector('.report-tab.active');
    if (activeRtab && activeRtab.dataset.rtab) {
      const rtab = activeRtab.dataset.rtab;
      if (_tabLoaded[rtab]) {
        if (rtab === 'daily') loadDailyReport();
        else if (rtab === 'monthly') loadMonthlyReport();
        else if (rtab === 'range') loadRangeReport();
        else if (rtab === 'grouped') loadGroupedReport();
        else if (rtab === 'perkey') loadPerKeyReport();
        else if (rtab === 'matrix') loadMatrixReport();
      }
    }
    return;
  }

  if (action === 'roi-currency') {
    e.preventDefault();
    _setRoiCurrency(el.dataset.cur);
    return;
  }
}

function handleGeneratedInput(e) {
  const el = e.target.closest('[data-action]');
  if (!el) return;
  const action = el.dataset.action;

  if (action === 'pag-search') {
    filterPagSearch(el, el.dataset.pagId);
    return;
  }

  if (action === 'report-table-search') {
    filterReportTableRows(el, el.dataset.containerId);
    return;
  }

  if (action === 'card-search') {
    filterCards(el, el.dataset.containerId, el.dataset.cardSelector);
    return;
  }


  if (action === 'perkey-search') {
    filterPerkeySearch(el.value);
    return;
  }



  if (action === 'matrix-wallet-filter') {
    _setMatrixWalletFilter(el.value);
    return;
  }

  if (action === 'matrix-min-bdx') {
    _setMatrixMinBdx(el.value);
  }
}

function handleGeneratedChange(e) {
  const el = e.target.closest('[data-action]');
  if (!el) return;
  const action = el.dataset.action;

  if (action === 'pag-size') {
    pagSetSize(el.dataset.pagId, el.value);
    return;
  }

  if (action === 'matrix-sort') {
    _setMatrixSort(el.value);
    return;
  }

  if (action === 'matrix-group-filter') {
    _setMatrixGroupFilter(el.value);
    return;
  }

  if (action === 'matrix-reward-only') {
    _setMatrixRewardOnly(el.checked);
    return;
  }

  if (action === 'matrix-unscanned-only') {
    _setMatrixUnscannedOnly(el.checked);
  }
}
