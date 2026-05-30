/**
 * Beldex Masternode Monitor - Auto-Scan Scheduler
 * Persists scheduler config to disk and runs background scans automatically.
 */

const fs = require("fs");
const path = require("path");

const CONFIG_PATH = path.join(__dirname, "scheduler_config.json");

const DEFAULT_CONFIG = {
  enabled: false,
  intervalHours: 24,      // how often to auto-scan (1, 4, 12, 24)
  lastAutoScan: null,     // ISO timestamp of last successful completion
  lastAutoScanHeight: null, // block height reached at last successful completion
  lastAutoScanDate: null, // date string of last successful completion (YYYY-MM-DD)
};

const VALID_INTERVALS = [1, 4, 12, 24];

function loadConfig() {
  try {
    if (fs.existsSync(CONFIG_PATH)) {
      const cfg = { ...DEFAULT_CONFIG, ...JSON.parse(fs.readFileSync(CONFIG_PATH, "utf8")) };
      if (!VALID_INTERVALS.includes(cfg.intervalHours)) cfg.intervalHours = DEFAULT_CONFIG.intervalHours;
      if (typeof cfg.enabled !== 'boolean') cfg.enabled = false;
      if (cfg.lastAutoScan !== null && typeof cfg.lastAutoScan !== 'string') cfg.lastAutoScan = null;
      if (cfg.lastAutoScanHeight !== null && !Number.isInteger(cfg.lastAutoScanHeight)) cfg.lastAutoScanHeight = null;
      if (cfg.lastAutoScanDate !== null && typeof cfg.lastAutoScanDate !== 'string') cfg.lastAutoScanDate = null;
      return cfg;
    }
  } catch (e) {
    console.warn("[Scheduler] Could not read config, using defaults:", e.message);
  }
  return { ...DEFAULT_CONFIG };
}

function saveConfig(cfg) {
  try {
    fs.writeFileSync(CONFIG_PATH, JSON.stringify(cfg, null, 2));
  } catch (e) {
    console.warn("[Scheduler] Could not save config:", e.message);
  }
}

module.exports = { loadConfig, saveConfig, CONFIG_PATH };
