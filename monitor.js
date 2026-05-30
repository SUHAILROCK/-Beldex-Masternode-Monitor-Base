#!/usr/bin/env node
/**
 * Beldex Masternode Monitor - Main CLI
 *
 * Usage:
 *   node monitor.js add-node <pubkey> [--label NAME]
 *   node monitor.js add-nodes <file>
 *   node monitor.js remove-node <pubkey>
 *   node monitor.js list-nodes
 *   node monitor.js scan [--date YYYY-MM-DD]
 *   node monitor.js scan-range <start> <end>
 *   node monitor.js status
 *   node monitor.js report daily [--date YYYY-MM-DD]
 *   node monitor.js report monthly [--year YYYY --month MM]
 */

const fs = require("fs");
const path = require("path");
const chalk = require("chalk");
const db = require("./db");
const scanner = require("./scanner");
const reporter = require("./reporter");

// --- Progress bar helper ---
function progressBar(current, total, width = 40) {
  const pct = Math.min(current / total, 1);
  const filled = Math.round(width * pct);
  const empty = width - filled;
  const bar = "█".repeat(filled) + "░".repeat(empty);
  const pctStr = (pct * 100).toFixed(1).padStart(5);
  process.stdout.write(`\r  [${bar}] ${pctStr}% (${current}/${total})`);
  if (current >= total) process.stdout.write("\n");
}

// --- Commands ---

function cmdAddNode(args) {
  if (args.length < 1) {
    console.log(chalk.red("Usage: node monitor.js add-node <pubkey> [--label NAME]"));
    return;
  }

  const pubkey = args[0].trim();
  let label = null;
  const labelIdx = args.indexOf("--label");
  if (labelIdx !== -1 && labelIdx + 1 < args.length) {
    label = args[labelIdx + 1];
  }

  if (pubkey.length !== 64) {
    console.log(chalk.red(`Invalid pubkey length (${pubkey.length}). Expected 64 hex characters.`));
    return;
  }

  if (db.addNode(pubkey, label)) {
    const lbl = label ? ` (label: ${label})` : "";
    console.log(chalk.green(`Added node: ${pubkey.slice(0, 16)}...${lbl}`));
  } else {
    console.log(chalk.yellow(`Node already exists: ${pubkey.slice(0, 16)}...`));
  }
}

function cmdAddNodesFromFile(args) {
  if (args.length < 1) {
    console.log(chalk.red("Usage: node monitor.js add-nodes <file>"));
    return;
  }

  const filepath = path.resolve(args[0]);
  if (!fs.existsSync(filepath)) {
    console.log(chalk.red(`File not found: ${filepath}`));
    return;
  }

  const lines = fs.readFileSync(filepath, "utf-8").split("\n");
  let added = 0;
  let skipped = 0;

  lines.forEach((line, lineNum) => {
    const parts = line.trim().split(",");
    const pubkey = parts[0].trim();
    const label = parts.length > 1 ? parts[1].trim() : null;

    if (!pubkey || pubkey.startsWith("#")) return;
    if (pubkey.length !== 64) {
      console.log(chalk.yellow(`Line ${lineNum + 1}: Skipping invalid pubkey (${pubkey.length} chars)`));
      skipped++;
      return;
    }

    if (db.addNode(pubkey, label)) added++;
    else skipped++;
  });

  console.log(chalk.green(`Added: ${added} nodes`) + " | " + chalk.yellow(`Skipped: ${skipped}`));
}

function cmdRemoveNode(args) {
  if (args.length < 1) {
    console.log(chalk.red("Usage: node monitor.js remove-node <pubkey>"));
    return;
  }
  const pubkey = args[0].trim();
  if (db.removeNode(pubkey)) {
    console.log(chalk.green(`Removed node: ${pubkey.slice(0, 16)}...`));
  } else {
    console.log(chalk.yellow(`Node not found: ${pubkey.slice(0, 16)}...`));
  }
}

function cmdListNodes() {
  const nodes = db.getAllNodes();
  if (nodes.length === 0) {
    console.log(chalk.yellow("No nodes registered. Use 'add-node' or 'add-nodes' to add some."));
    return;
  }

  const Table = require("cli-table3");
  const table = new Table({
    head: ["#", "Label", "Public Key", "Added"],
    colWidths: [5, 12, 70, 22],
    style: { head: ["cyan"] },
  });

  nodes.forEach((node, idx) => {
    table.push([idx + 1, node.label || "-", node.pubkey, node.added_date]);
  });

  console.log(chalk.bold.cyan(`\n  Registered Masternodes (${nodes.length})`));
  console.log(table.toString());
}

async function cmdScan(args) {
  const nodes = db.getAllNodes();
  if (nodes.length === 0) {
    console.log(chalk.red("No nodes registered. Add nodes first."));
    return;
  }

  const pubkeys = nodes.map((n) => n.pubkey);

  // Determine target date
  let targetDate;
  const dateIdx = args.indexOf("--date");
  if (dateIdx !== -1 && dateIdx + 1 < args.length) {
    targetDate = args[dateIdx + 1];
  } else {
    const now = new Date();
    targetDate = `${now.getUTCFullYear()}-${String(now.getUTCMonth() + 1).padStart(2, "0")}-${String(now.getUTCDate()).padStart(2, "0")}`;
  }

  console.log(chalk.bold.cyan(`\nScanning rewards for: ${targetDate}`));
  console.log(chalk.dim(`Monitoring ${pubkeys.length} masternodes`));

  // Get current height
  const stats = await scanner.getNetworkStats();
  if (!stats) {
    console.log(chalk.red("Failed to connect to Beldex Explorer API."));
    return;
  }

  const currentHeight = stats.height;
  console.log(chalk.dim(`Current blockchain height: ${currentHeight.toLocaleString()}`));

  // Find block range
  console.log(chalk.dim("Finding block range for target date..."));
  const startHeight = await scanner.findStartHeightForDate(targetDate, currentHeight);
  if (!startHeight) {
    console.log(chalk.red("Could not determine start height."));
    return;
  }

  const today = new Date();
  const todayStr = `${today.getUTCFullYear()}-${String(today.getUTCMonth() + 1).padStart(2, "0")}-${String(today.getUTCDate()).padStart(2, "0")}`;
  let endHeight;
  if (targetDate === todayStr) {
    endHeight = currentHeight;
  } else {
    endHeight = await scanner.findEndHeightForDate(targetDate, currentHeight);
  }

  const totalBlocks = endHeight - startHeight + 1;
  console.log(chalk.dim(`Scanning blocks ${startHeight.toLocaleString()} to ${endHeight.toLocaleString()} (${totalBlocks.toLocaleString()} blocks)\n`));

  // Scan — collect rewards via saveCallback (same pattern as web server)
  const allRewards = [];
  let totalInserted = 0;
  await scanner.scanBlocksForRewards(startHeight, endHeight, pubkeys,
    (scanned, total) => { progressBar(scanned, total); },
    null,
    (batch) => {
      if (batch.length > 0) {
        const inserted = db.insertRewardsBatch(batch);
        allRewards.push(...batch);
        totalInserted += inserted;
        return inserted;
      }
      return 0;
    }
  );

  if (allRewards.length > 0) {
    console.log(chalk.bold.green(`\nFound ${allRewards.length} reward events! (${totalInserted} new)`));

    const totalBdx = allRewards.reduce((s, r) => s + r.reward_amount, 0);
    const uniqueNodes = new Set(allRewards.map((r) => r.pubkey)).size;
    console.log(chalk.green(`Total BDX earned: ${totalBdx.toFixed(4)} BDX across ${uniqueNodes} nodes`));

    // Multi-reward detection
    const counts = {};
    allRewards.forEach((r) => (counts[r.pubkey] = (counts[r.pubkey] || 0) + 1));
    const multi = Object.entries(counts).filter(([, v]) => v > 1);
    if (multi.length > 0) {
      console.log(chalk.bold.yellow("\nNodes with multiple rewards today:"));
      multi.sort((a, b) => b[1] - a[1]).forEach(([pk, count]) => {
        const node = db.getNodeByPubkey(pk);
        const label = node && node.label ? ` (${node.label})` : "";
        console.log(`  ${pk.slice(0, 12)}...${pk.slice(-4)}${label}: ${chalk.yellow(`${count} rewards`)}`);
      });
    }
  } else {
    console.log(chalk.yellow(`\nNo rewards found for your nodes on ${targetDate}.`));
  }

  db.setLastScannedHeight(endHeight);
}

async function cmdScanRange(args) {
  if (args.length < 2) {
    console.log(chalk.red("Usage: node monitor.js scan-range <start_height> <end_height>"));
    return;
  }

  const nodes = db.getAllNodes();
  if (nodes.length === 0) {
    console.log(chalk.red("No nodes registered."));
    return;
  }

  const startHeight = parseInt(args[0]);
  const endHeight = parseInt(args[1]);
  if (isNaN(startHeight) || isNaN(endHeight)) {
    console.log(chalk.red("Heights must be integers."));
    return;
  }

  const pubkeys = nodes.map((n) => n.pubkey);
  const totalBlocks = endHeight - startHeight + 1;
  console.log(chalk.bold.cyan(`\nScanning blocks ${startHeight.toLocaleString()} to ${endHeight.toLocaleString()} (${totalBlocks.toLocaleString()} blocks)`));

  const allRewards = [];
  let totalInserted = 0;
  await scanner.scanBlocksForRewards(startHeight, endHeight, pubkeys,
    (scanned, total) => { progressBar(scanned, total); },
    null,
    (batch) => {
      if (batch.length > 0) {
        const inserted = db.insertRewardsBatch(batch);
        allRewards.push(...batch);
        totalInserted += inserted;
        return inserted;
      }
      return 0;
    }
  );

  if (allRewards.length > 0) {
    console.log(chalk.bold.green(`\nFound ${allRewards.length} reward events! (${totalInserted} new)`));
    const totalBdx = allRewards.reduce((s, r) => s + r.reward_amount, 0);
    console.log(chalk.green(`Total BDX: ${totalBdx.toFixed(4)}`));
  } else {
    console.log(chalk.yellow("\nNo rewards found for your nodes in this range."));
  }

  db.setLastScannedHeight(endHeight);
}

async function cmdStatus() {
  const nodes = db.getAllNodes();
  if (nodes.length === 0) {
    console.log(chalk.red("No nodes registered."));
    return;
  }

  console.log(chalk.bold.cyan(`\nChecking status of ${nodes.length} masternodes...`));

  const statusData = [];
  for (let i = 0; i < nodes.length; i++) {
    const node = nodes[i];
    const result = await scanner.getNodeStatus(node.pubkey);
    result.pubkey = node.pubkey;
    result.label = node.label;
    statusData.push(result);

    db.saveNodeStatus(node.pubkey, result.status, result.last_uptime_proof, result.version);

    progressBar(i + 1, nodes.length);
    await scanner.sleep(scanner.REQUEST_DELAY);
  }

  reporter.statusReport(statusData);
}

function cmdReport(args) {
  if (args.length === 0) {
    console.log(chalk.red("Usage: node monitor.js report daily|monthly [options]"));
    return;
  }

  const reportType = args[0];

  if (reportType === "daily") {
    let targetDate = null;
    const dateIdx = args.indexOf("--date");
    if (dateIdx !== -1 && dateIdx + 1 < args.length) targetDate = args[dateIdx + 1];
    reporter.dailyReport(targetDate);
  } else if (reportType === "monthly") {
    let year = null, month = null;
    const yearIdx = args.indexOf("--year");
    if (yearIdx !== -1 && yearIdx + 1 < args.length) year = parseInt(args[yearIdx + 1]);
    const monthIdx = args.indexOf("--month");
    if (monthIdx !== -1 && monthIdx + 1 < args.length) month = parseInt(args[monthIdx + 1]);
    reporter.monthlyReport(year, month);
  } else {
    console.log(chalk.red(`Unknown report type: ${reportType}. Use 'daily' or 'monthly'.`));
  }
}

function printHelp() {
  console.log(`
${chalk.bold.cyan("Beldex Masternode Monitor")}
${chalk.dim("Track rewards and status for your Beldex masternodes")}

${chalk.bold("Commands:")}

  ${chalk.green("add-node")} <pubkey> [--label NAME]     Add a single masternode
  ${chalk.green("add-nodes")} <file>                     Add nodes from file (one pubkey per line)
  ${chalk.green("remove-node")} <pubkey>                 Remove a masternode
  ${chalk.green("list-nodes")}                           List all registered nodes

  ${chalk.green("scan")} [--date YYYY-MM-DD]             Scan blocks for rewards (default: today)
  ${chalk.green("scan-range")} <start> <end>             Scan a specific block range

  ${chalk.green("status")}                               Check live status of all nodes

  ${chalk.green("report daily")} [--date YYYY-MM-DD]     Daily earnings report
  ${chalk.green("report monthly")} [--year Y --month M]  Monthly earnings report

${chalk.bold("Examples:")}
  node monitor.js add-nodes nodes.txt
  node monitor.js scan
  node monitor.js scan --date 2026-03-25
  node monitor.js status
  node monitor.js report daily
  node monitor.js report monthly --year 2026 --month 3
`);
}

// --- Main ---
async function main() {
  db.initDb();

  const args = process.argv.slice(2);
  if (args.length === 0) {
    printHelp();
    return;
  }

  const command = args[0].toLowerCase();
  const cmdArgs = args.slice(1);

  try {
    switch (command) {
      case "add-node":     cmdAddNode(cmdArgs); break;
      case "add-nodes":    cmdAddNodesFromFile(cmdArgs); break;
      case "remove-node":  cmdRemoveNode(cmdArgs); break;
      case "list-nodes":   cmdListNodes(); break;
      case "scan":         await cmdScan(cmdArgs); break;
      case "scan-range":   await cmdScanRange(cmdArgs); break;
      case "status":       await cmdStatus(); break;
      case "report":       cmdReport(cmdArgs); break;
      case "help":         printHelp(); break;
      default:
        console.log(chalk.red(`Unknown command: ${command}`));
        printHelp();
    }
  } finally {
    db.closeDb();
  }
}

main().catch((err) => {
  console.error(chalk.red(`Error: ${err.message}`));
  db.closeDb();
  process.exit(1);
});
