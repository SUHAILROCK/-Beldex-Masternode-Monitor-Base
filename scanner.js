/**
 * Beldex Masternode Monitor - Scanner Module
 * Fetches data from Beldex Explorer API and checks node status.
 */

const EXPLORER_BASE = "https://explorer.beldex.io";
const API_BASE = `${EXPLORER_BASE}/api`;
const ATOMIC_UNITS = 1_000_000_000;
const REQUEST_DELAY = 50;    // ms between requests in parallel batches
const PARALLEL = 10;          // concurrent block fetches — 10x speed vs sequential
const MAX_RETRIES = 5;
const RETRY_DELAY = 3000;
const SAVE_EVERY = 100;      // save to DB every N blocks scanned
const SEARCH_WINDOW = 5760;  // ±5760 blocks (~3 days) initial buffer around calibrated estimate
// Governance lump sum threshold: every 5040 blocks, 3.75×5040=18,900 BDX is paid
// to the winning MN as protocol treasury. The MN's actual per-block earnings are
// only 6.25 BDX. Any block.reward > GOVERNANCE_THRESHOLD triggers this detection.
const GOVERNANCE_THRESHOLD = 100; // BDX — safely above normal (~6.25) and below payout (~18,900)
const GOVERNANCE_MN_REWARD_BDX = 6.25; // actual MN share per block won

let _rateLimitedUntil = 0; // shared across all concurrent fetches — set on 429

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function fetchJson(url, retries = MAX_RETRIES) {
  for (let attempt = 0; attempt < retries; attempt++) {
    // If a 429 was recently hit by any fetch, wait until the shared cooldown passes
    const now = Date.now();
    if (_rateLimitedUntil > now) {
      await sleep(_rateLimitedUntil - now);
    }
    try {
      const resp = await fetch(url, { signal: AbortSignal.timeout(30000) });
      if (resp.status === 429) {
        // Back off all concurrent fetches, not just this one
        const wait = RETRY_DELAY * (attempt + 1);
        _rateLimitedUntil = Math.max(_rateLimitedUntil, Date.now() + wait);
        console.log(`  Rate limited. Shared backoff ${wait / 1000}s...`);
        await sleep(wait);
        continue;
      }
      if (!resp.ok) throw new Error(`HTTP ${resp.status}`);
      const text = await resp.text();
      try { return JSON.parse(text); } catch { throw new Error(`Invalid JSON from ${url}`); }
    } catch (e) {
      if (attempt < retries - 1) {
        await sleep(RETRY_DELAY);
        continue;
      }
      throw e;
    }
  }
  return null;
}


async function getNetworkStats() {
  // /api/get_stats is currently returning 500 — try it with 1 attempt, fall back to networkinfo
  try {
    const data = await fetchJson(`${API_BASE}/get_stats`, 1);
    if (data && data.status === "ok") return data.data;
  } catch (_) {}
  const ni = await fetchJson(`${API_BASE}/networkinfo`, 1);
  if (ni && ni.status === "OK" && ni.data) return ni.data;
  return null;
}

async function getMasterNodeStats() {
  const data = await fetchJson(`${API_BASE}/master_node_stats`);
  if (data && data.status === "OK") return data.data;
  return null;
}

async function getBlock(height) {
  const data = await fetchJson(`${API_BASE}/block/${height}`);
  if (data && data.status === "OK") return data.data;
  return null;
}

async function fetchHtml(url, retries = MAX_RETRIES) {
  for (let attempt = 0; attempt < retries; attempt++) {
    try {
      const resp = await fetch(url, { signal: AbortSignal.timeout(30000) });
      if (!resp.ok) throw new Error(`HTTP ${resp.status}`);
      return await resp.text();
    } catch (e) {
      if (attempt < retries - 1) { await sleep(RETRY_DELAY); continue; }
      throw e;
    }
  }
  return null;
}

async function getNodeStatus(pubkey) {
  try {
    const html = await fetchHtml(`${EXPLORER_BASE}/mn/${pubkey}`);
    if (!html) return { status: "unknown", last_uptime_proof: null, version: null };

    const textLower = html.toLowerCase();
    let status = "unknown";
    if (textLower.includes("registered, staked, and active") || textLower.includes("active on the network")) {
      status = "active";
    } else if (textLower.includes("decommissioned")) {
      status = "decommissioned";
    } else if (textLower.includes("deregistered")) {
      status = "deregistered";
    } else if (textLower.includes("awaiting contribution")) {
      status = "awaiting_contribution";
    } else if (textLower.includes("not found") || textLower.includes("invalid")) {
      status = "not_found";
    }

    let version = null;
    const versionMatch = html.match(/(?:version|Version)[:\s]*(\d+\.\d+\.\d+)/i);
    if (versionMatch) version = versionMatch[1];
    version = (version || '').trim().slice(0, 20);

    let lastUptimeProof = null;
    const uptimeMatch = html.match(/(?:last uptime proof|Last Uptime Proof)[:\s]*([^<\n]+)/i);
    if (uptimeMatch) lastUptimeProof = uptimeMatch[1].trim();
    lastUptimeProof = (lastUptimeProof || '').replace(/<[^>]*>/g, '').trim().slice(0, 100);

    status = (status || '').replace(/<[^>]*>/g, '').trim().slice(0, 200);

    return { status, last_uptime_proof: lastUptimeProof, version };
  } catch (e) {
    return { status: "error", last_uptime_proof: null, version: e.message };
  }
}

/**
 * Check all nodes in parallel batches of PARALLEL_STATUS concurrent requests.
 * Returns a Map of pubkey → { status, last_uptime_proof, version }
 */
const PARALLEL_STATUS = 20;
async function getAllNodeStatuses(pubkeys, progressCallback = null, cancelCheck = null) {
  const map = new Map();
  let checked = 0;
  for (let i = 0; i < pubkeys.length; i += PARALLEL_STATUS) {
    if (cancelCheck && cancelCheck()) break;
    const batch = pubkeys.slice(i, i + PARALLEL_STATUS);
    const results = await Promise.all(batch.map(pk => getNodeStatus(pk)));
    for (let j = 0; j < batch.length; j++) {
      map.set(batch[j], results[j]);
      checked++;
    }
    if (progressCallback) progressCallback(checked, pubkeys.length);
    if (i + PARALLEL_STATUS < pubkeys.length) await sleep(50);
  }
  return map;
}

/**
 * Scan blocks for masternode rewards.
 * Fetches PARALLEL blocks concurrently for ~5x speed vs sequential.
 * Saves to DB every SAVE_EVERY blocks so crashes don't lose progress.
 *
 * @param {number} startHeight
 * @param {number} endHeight
 * @param {string[]} nodePubkeys
 * @param {function} progressCallback - (scanned, total)
 * @param {function} cancelCheck - returns true if scan should stop
 * @param {function} saveCallback - (rewardsBatch) => insertedCount, called every SAVE_EVERY blocks
 */
async function scanBlocksForRewards(startHeight, endHeight, nodePubkeys, progressCallback = null, cancelCheck = null, saveCallback = null) {
  const pubkeySet = new Set(nodePubkeys);
  const total = endHeight - startHeight + 1;
  let scanned = 0;
  let pendingRewards = [];
  let totalFound = 0;

  let wasCancelled = false;
  let missedBlocks = 0;

  // Process blocks in parallel batches of PARALLEL size
  for (let height = startHeight; height <= endHeight; height += PARALLEL) {
    if (cancelCheck && cancelCheck()) { wasCancelled = true; break; }

    // Build a batch of up to PARALLEL heights
    const batchHeights = [];
    for (let i = 0; i < PARALLEL && height + i <= endHeight; i++) {
      batchHeights.push(height + i);
    }

    // Fetch all blocks in batch concurrently
    const blocks = await Promise.all(batchHeights.map(h => getBlock(h).catch(() => null)));

    for (let i = 0; i < blocks.length; i++) {
      const block = blocks[i];
      if (!block) { missedBlocks++; scanned++; continue; }
      const winner = block.master_node_winner;
      if (winner && pubkeySet.has(winner)) {
        const rewardAtomic = block.reward || 0;
        const rewardBdx = rewardAtomic / ATOMIC_UNITS;
        const isGovernance = rewardBdx > GOVERNANCE_THRESHOLD;
        const actualReward = isGovernance ? GOVERNANCE_MN_REWARD_BDX : rewardBdx;
        if (isGovernance) {
          console.log(`  [gov] Block ${batchHeights[i]}: governance block — raw=${rewardBdx.toFixed(2)} BDX, recording MN share as ${GOVERNANCE_MN_REWARD_BDX} BDX`);
        }
        const blockTs = block.timestamp || 0;
        const d = new Date(blockTs * 1000);
        const rewardDate = `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, "0")}-${String(d.getUTCDate()).padStart(2, "0")}`;
        pendingRewards.push({
          pubkey: winner,
          block_height: batchHeights[i],
          reward_amount: actualReward,
          is_governance: isGovernance ? 1 : 0,
          block_timestamp: blockTs,
          reward_date: rewardDate,
        });
      }
      scanned++;
    }

    // Update progress first so save callback sees the correct scanned count
    if (progressCallback && (scanned % 20 === 0 || scanned >= total)) {
      progressCallback(Math.min(scanned, total), total);
    }

    // Save to DB every SAVE_EVERY blocks regardless of whether rewards were found
    if (scanned % SAVE_EVERY === 0 || scanned >= total) {
      if (pendingRewards.length > 0 && saveCallback) {
        const inserted = saveCallback(pendingRewards);
        totalFound += inserted;
        pendingRewards = [];
      } else if (saveCallback) {
        saveCallback([]);
      }
    }

    // Small delay between batches to avoid hammering the API
    await sleep(REQUEST_DELAY);
  }

  // Final flush of any remaining rewards
  if (pendingRewards.length > 0 && saveCallback) {
    const inserted = saveCallback(pendingRewards);
    totalFound += inserted;
  }

  // Only report 100% if the loop completed naturally — cancelled scans keep their real progress count
  if (progressCallback && !wasCancelled) progressCallback(total, total);
  return { found: totalFound, missed: missedBlocks };
}

/**
 * Calibrate actual avg block time using two known data points.
 * Fetches a block 10,000 heights ago and computes (timeDiff / heightDiff).
 * Returns seconds-per-block. Falls back to 120 on failure.
 */
async function calibrateBlockTime(currentHeight, _currentTs) {
  // Use two historical anchor blocks (not the tip) so the measurement is
  // independent of any clock skew between wall-clock and the chain tip timestamp.
  const hi = Math.max(1, currentHeight - 1000);
  const lo = Math.max(1, currentHeight - 11000);
  const [hiBlock, loBlock] = await Promise.all([getBlock(hi), getBlock(lo)]);
  if (!hiBlock || !loBlock) return 44; // Beldex empirical default
  const secs = (hiBlock.timestamp - loBlock.timestamp) / (hi - lo);
  // Sanity-check: Beldex block time should be between 10s and 300s
  return (secs >= 10 && secs <= 300) ? secs : 44;
}

/**
 * Core binary search: finds the lowest block height whose timestamp >= targetTs,
 * within [low, high]. Returns the found height (not validated).
 */
async function _binarySearchBlock(targetTs, low, high) {
  for (let i = 0; i < 32; i++) {
    if (low >= high) break;
    const mid = Math.floor((low + high) / 2);
    const block = await getBlock(mid);
    if (!block) { low = mid + 1; continue; }
    if (block.timestamp < targetTs) low = mid + 1;
    else high = mid;
    await sleep(80);
  }
  return low;
}

/**
 * Find the block height at the START of a given date.
 * Uses calibrated block time for the initial estimate, then validates the result.
 * If the found block falls on the wrong date, widens the search window and retries
 * (handles cases where the calibration estimate is off by more than SEARCH_WINDOW blocks).
 */
async function findStartHeightForDate(targetDateStr, currentHeight, currentTs = null, avgBlockTime = null) {
  const targetDate = new Date(targetDateStr + "T00:00:00Z");
  const targetTs = Math.floor(targetDate.getTime() / 1000);
  const targetEndTs = targetTs + 86400; // end of target day

  if (!currentTs) currentTs = Math.floor(Date.now() / 1000);
  if (!avgBlockTime) avgBlockTime = await calibrateBlockTime(currentHeight, currentTs);

  const secondsDiff = currentTs - targetTs;
  const blocksDiff = Math.floor(secondsDiff / avgBlockTime);
  const estimated = Math.max(1, currentHeight - blocksDiff);

  // Adaptive widening: start with SEARCH_WINDOW, double up to ±120000 blocks (~60 days)
  for (const window of [SEARCH_WINDOW, 15000, 40000, 120000]) {
    const low  = Math.max(1, estimated - window);
    const high = Math.min(currentHeight, estimated + window);
    const result = await _binarySearchBlock(targetTs, low, high);

    // Validate: fetch the block we landed on and confirm its date is correct
    const found = await getBlock(result);
    if (found && found.timestamp >= targetTs && found.timestamp < targetEndTs) {
      return result; // confirmed correct
    }
    if (found && found.timestamp >= targetTs && found.timestamp < targetTs + 86400 * 2) {
      // Within 2 days — close enough, the binary search converged at a boundary edge
      return result;
    }
    // Wrong date — widen and retry
    if (window < 120000) continue;
  }

  // Last resort: return best estimate even if not validated
  return estimated;
}

/**
 * Find the block height at the END of a given date.
 * Same adaptive widening strategy as findStartHeightForDate.
 */
async function findEndHeightForDate(targetDateStr, currentHeight, currentTs = null, avgBlockTime = null) {
  const targetDate = new Date(targetDateStr + "T00:00:00Z");
  const nextDay = new Date(targetDate.getTime() + 86400000);
  const nextDayTs = Math.floor(nextDay.getTime() / 1000);

  if (!currentTs) currentTs = Math.floor(Date.now() / 1000);
  if (nextDayTs > currentTs) return currentHeight;

  if (!avgBlockTime) avgBlockTime = await calibrateBlockTime(currentHeight, currentTs);

  const secondsDiff = currentTs - nextDayTs;
  const blocksDiff = Math.floor(secondsDiff / avgBlockTime);
  const estimated = Math.max(1, currentHeight - blocksDiff);

  for (const window of [SEARCH_WINDOW, 15000, 40000, 120000]) {
    const low  = Math.max(1, estimated - window);
    const high = Math.min(currentHeight, estimated + window);
    const result = await _binarySearchBlock(nextDayTs, low, high);
    const endBlock = Math.max(1, result - 1);

    const found = await getBlock(endBlock);
    if (found) {
      const foundDate = new Date(found.timestamp * 1000).toISOString().slice(0, 10);
      if (foundDate === targetDateStr) return endBlock; // confirmed
      // Within 1 day off — accept it
      const diff = Math.abs(found.timestamp - (nextDayTs - 1));
      if (diff < 86400) return endBlock;
    }
    if (window < 120000) continue;
  }

  return Math.max(1, estimated - 1);
}

// ─── BDX Price (CoinGecko) ───────────────────────────────

// ─── BDX Price (CoinGecko) ───────────────────────────────

async function fetchBdxPrice() {
  try {
    const resp = await fetch(
      "https://api.coingecko.com/api/v3/simple/price?ids=beldex&vs_currencies=usd,inr",
      { signal: AbortSignal.timeout(10000) }
    );
    if (!resp.ok) throw new Error(`HTTP ${resp.status}`);
    const data = await resp.json();
    return {
      usd: data?.beldex?.usd ?? null,
      inr: data?.beldex?.inr ?? null
    };
  } catch (e) {
    return null;
  }
}

async function scanSpecificBlocks(blockHeights, pubkeys) {
  const pubkeySet = new Set(pubkeys);
  const rewards = [];
  let missed = 0;

  for (let i = 0; i < blockHeights.length; i += PARALLEL) {
    const batch = blockHeights.slice(i, i + PARALLEL);
    const blocks = await Promise.all(batch.map(h => getBlock(h).catch(() => null)));
    for (let j = 0; j < blocks.length; j++) {
      const block = blocks[j];
      if (!block) { missed++; continue; }
      const winner = block.master_node_winner;
      if (winner && pubkeySet.has(winner)) {
        const rewardAtomic = block.reward || 0;
        const rewardBdx = rewardAtomic / ATOMIC_UNITS;
        const isGovernance = rewardBdx > GOVERNANCE_THRESHOLD;
        const actualReward = isGovernance ? GOVERNANCE_MN_REWARD_BDX : rewardBdx;
        if (isGovernance) {
          console.log(`  [gov] Block ${batch[j]}: governance block — raw=${rewardBdx.toFixed(2)} BDX, recording MN share as ${GOVERNANCE_MN_REWARD_BDX} BDX`);
        }
        const blockTs = block.timestamp || 0;
        const d = new Date(blockTs * 1000);
        const rewardDate = `${d.getUTCFullYear()}-${String(d.getUTCMonth()+1).padStart(2,'0')}-${String(d.getUTCDate()).padStart(2,'0')}`;
        rewards.push({ pubkey: winner, block_height: batch[j], reward_amount: actualReward,
          is_governance: isGovernance ? 1 : 0, block_timestamp: blockTs, reward_date: rewardDate });
      }
    }
    if (i + PARALLEL < blockHeights.length) await sleep(REQUEST_DELAY);
  }
  return { rewards, missed };
}

module.exports = {
  getNetworkStats, getMasterNodeStats, getBlock, getNodeStatus, getAllNodeStatuses,
  scanBlocksForRewards, scanSpecificBlocks,
  findStartHeightForDate, findEndHeightForDate, calibrateBlockTime,
  fetchBdxPrice,
  REQUEST_DELAY, PARALLEL, sleep,
};
