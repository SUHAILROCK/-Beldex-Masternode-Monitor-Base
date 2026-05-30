/**
 * Beldex Masternode Monitor - Report Generator
 * Generates daily and monthly earnings reports with formatted tables.
 */

const chalk = require("chalk");
const Table = require("cli-table3");
const db = require("./db");

function shortKey(pubkey, len = 16) {
  if (pubkey.length > len) return `${pubkey.slice(0, 8)}...${pubkey.slice(-4)}`;
  return pubkey;
}

function formatBdx(amount) {
  return amount.toFixed(4);
}

function line(char = "=", len = 70) {
  return char.repeat(len);
}

function dailyReport(targetDate = null) {
  if (!targetDate) {
    const now = new Date();
    targetDate = `${now.getUTCFullYear()}-${String(now.getUTCMonth() + 1).padStart(2, "0")}-${String(now.getUTCDate()).padStart(2, "0")}`;
  }

  const summary = db.getDailySummary(targetDate);
  const allNodes = db.getAllNodes();
  const nodePubkeys = new Set(allNodes.map((n) => n.pubkey));
  const rewardedPubkeys = new Set(summary.map((r) => r.pubkey));
  const noRewardPubkeys = [...nodePubkeys].filter((pk) => !rewardedPubkeys.has(pk));

  const totalRewards = summary.reduce((s, r) => s + r.reward_count, 0);
  const totalBdx = summary.reduce((s, r) => s + r.total_amount, 0);
  const nodesEarned = rewardedPubkeys.size;

  // Header
  console.log("\n" + chalk.cyan(line("═")));
  console.log(chalk.bold.cyan("  BELDEX MASTERNODE DAILY REPORT"));
  console.log(chalk.cyan(line("═")));
  console.log(chalk.white(`  Date:                  ${targetDate}`));
  console.log(chalk.white(`  Total Monitored Nodes: ${allNodes.length}`));
  console.log(
    nodesEarned > 0
      ? chalk.green(`  Nodes That Earned:     ${nodesEarned}`)
      : chalk.red(`  Nodes That Earned:     ${nodesEarned}`)
  );
  console.log(chalk.yellow(`  Total Reward Events:   ${totalRewards}`));
  console.log(chalk.bold.green(`  Total BDX Earned:      ${formatBdx(totalBdx)} BDX`));
  if (nodesEarned > 0) {
    console.log(chalk.white(`  Avg Per Earning Node:  ${formatBdx(totalBdx / nodesEarned)} BDX`));
  }
  console.log(chalk.cyan(line("─")));

  // Rewards breakdown
  if (summary.length > 0) {
    console.log(chalk.bold.yellow("\n  Reward Breakdown by Node:"));
    const table = new Table({
      head: ["#", "Label", "Public Key", "Rewards", "BDX Earned", "Multi?"],
      colWidths: [5, 12, 22, 10, 16, 8],
      style: { head: ["cyan"] },
    });

    summary.forEach((row, idx) => {
      const multi = row.reward_count > 1 ? chalk.bold.red("YES") : chalk.dim("-");
      table.push([
        idx + 1,
        row.label || "-",
        shortKey(row.pubkey),
        row.reward_count,
        formatBdx(row.total_amount),
        multi,
      ]);
    });
    console.log(table.toString());
  }

  // Nodes without rewards
  if (noRewardPubkeys.length > 0) {
    console.log(chalk.bold.red(`\n  Nodes With No Rewards Today (${noRewardPubkeys.length}):`));
    const nodeLabels = {};
    allNodes.forEach((n) => (nodeLabels[n.pubkey] = n.label));

    const table = new Table({
      head: ["#", "Label", "Public Key"],
      colWidths: [5, 12, 70],
      style: { head: ["red"] },
    });

    noRewardPubkeys.sort().forEach((pk, idx) => {
      table.push([idx + 1, nodeLabels[pk] || "-", pk]);
    });
    console.log(table.toString());
  }

  console.log(chalk.cyan(line("═")) + "\n");

  return { date: targetDate, total_nodes: allNodes.length, nodes_earned: nodesEarned, total_rewards: totalRewards, total_bdx: totalBdx };
}

function monthlyReport(year = null, month = null) {
  const now = new Date();
  if (!year) year = now.getFullYear();
  if (!month) month = now.getMonth() + 1;

  const monthNames = ["", "January", "February", "March", "April", "May", "June", "July", "August", "September", "October", "November", "December"];
  const monthName = `${monthNames[month]} ${year}`;

  const summary = db.getMonthlySummary(year, month);
  const allNodes = db.getAllNodes();
  const nodePubkeys = new Set(allNodes.map((n) => n.pubkey));
  const rewardedPubkeys = new Set(summary.map((r) => r.pubkey));
  const noRewardPubkeys = [...nodePubkeys].filter((pk) => !rewardedPubkeys.has(pk));

  const totalRewards = summary.reduce((s, r) => s + r.reward_count, 0);
  const totalBdx = summary.reduce((s, r) => s + r.total_amount, 0);
  const nodesEarned = rewardedPubkeys.size;

  // Header
  console.log("\n" + chalk.magenta(line("═")));
  console.log(chalk.bold.magenta("  BELDEX MASTERNODE MONTHLY REPORT"));
  console.log(chalk.magenta(line("═")));
  console.log(chalk.white(`  Month:                 ${monthName}`));
  console.log(chalk.white(`  Total Monitored Nodes: ${allNodes.length}`));
  console.log(
    nodesEarned > 0
      ? chalk.green(`  Nodes That Earned:     ${nodesEarned}`)
      : chalk.red(`  Nodes That Earned:     ${nodesEarned}`)
  );
  console.log(chalk.yellow(`  Total Reward Events:   ${totalRewards}`));
  console.log(chalk.bold.green(`  Total BDX Earned:      ${formatBdx(totalBdx)} BDX`));
  if (nodesEarned > 0) {
    console.log(chalk.white(`  Avg Per Earning Node:  ${formatBdx(totalBdx / nodesEarned)} BDX`));
  }
  console.log(chalk.magenta(line("─")));

  // Per-node breakdown
  if (summary.length > 0) {
    console.log(chalk.bold.yellow(`\n  Monthly Earnings - ${monthName}:`));
    const table = new Table({
      head: ["#", "Label", "Public Key", "Rewards", "Total BDX", "Avg/Reward"],
      colWidths: [5, 12, 22, 10, 16, 14],
      style: { head: ["cyan"] },
    });

    summary.forEach((row, idx) => {
      const avg = row.reward_count > 0 ? row.total_amount / row.reward_count : 0;
      table.push([
        idx + 1,
        row.label || "-",
        shortKey(row.pubkey),
        row.reward_count,
        formatBdx(row.total_amount),
        formatBdx(avg),
      ]);
    });
    console.log(table.toString());
  }

  // Daily breakdown within month
  const allRewards = db.getMonthlyRewards(year, month);
  if (allRewards.length > 0) {
    const dailyTotals = {};
    allRewards.forEach((r) => {
      if (!dailyTotals[r.reward_date]) dailyTotals[r.reward_date] = { count: 0, amount: 0 };
      dailyTotals[r.reward_date].count++;
      dailyTotals[r.reward_date].amount += r.reward_amount;
    });

    console.log(chalk.bold.cyan("\n  Daily Totals Within Month:"));
    const dayTable = new Table({
      head: ["Date", "Reward Events", "BDX Earned"],
      colWidths: [14, 16, 16],
      style: { head: ["yellow"] },
    });

    Object.keys(dailyTotals)
      .sort()
      .forEach((d) => {
        dayTable.push([d, dailyTotals[d].count, formatBdx(dailyTotals[d].amount)]);
      });
    console.log(dayTable.toString());
  }

  // Nodes with zero rewards
  if (noRewardPubkeys.length > 0) {
    console.log(chalk.bold.red(`\n  Nodes with ZERO rewards in ${monthName}: ${noRewardPubkeys.length}`));
    const nodeLabels = {};
    allNodes.forEach((n) => (nodeLabels[n.pubkey] = n.label));
    noRewardPubkeys.sort().forEach((pk) => {
      const lbl = nodeLabels[pk] ? ` (${nodeLabels[pk]})` : "";
      console.log(chalk.dim(`    ${shortKey(pk, 20)}${lbl}`));
    });
  }

  console.log(chalk.magenta(line("═")) + "\n");

  return { month: monthName, total_nodes: allNodes.length, nodes_earned: nodesEarned, total_rewards: totalRewards, total_bdx: totalBdx };
}

function statusReport(statusData) {
  if (!statusData || statusData.length === 0) {
    console.log(chalk.yellow("No status data available."));
    return;
  }

  const active = statusData.filter((s) => s.status === "active");
  const inactive = statusData.filter((s) => s.status !== "active");

  console.log("\n" + chalk.cyan(line("═")));
  console.log(chalk.bold.cyan("  MASTERNODE STATUS CHECK"));
  console.log(chalk.cyan(line("═")));
  console.log(chalk.white(`  Total Checked:     ${statusData.length}`));
  console.log(chalk.bold.green(`  Active:            ${active.length}`));
  console.log(
    inactive.length > 0
      ? chalk.bold.red(`  Inactive/Issues:   ${inactive.length}`)
      : chalk.green(`  Inactive/Issues:   0`)
  );
  console.log(chalk.cyan(line("─")));

  // Problem nodes
  if (inactive.length > 0) {
    console.log(chalk.bold.red("\n  NODES WITH ISSUES:"));
    const table = new Table({
      head: ["#", "Label", "Public Key", "Status", "Version", "Last Uptime"],
      colWidths: [5, 12, 22, 20, 10, 22],
      style: { head: ["red"] },
    });

    inactive.forEach((s, idx) => {
      table.push([
        idx + 1,
        s.label || "-",
        shortKey(s.pubkey),
        s.status.toUpperCase(),
        s.version || "-",
        s.last_uptime_proof || "-",
      ]);
    });
    console.log(table.toString());
  }

  // Active nodes
  if (active.length > 0) {
    console.log(chalk.bold.green(`\n  ACTIVE NODES (${active.length}):`));
    const table = new Table({
      head: ["#", "Label", "Public Key", "Version", "Last Uptime"],
      colWidths: [5, 12, 22, 10, 22],
      style: { head: ["green"] },
    });

    active.forEach((s, idx) => {
      table.push([
        idx + 1,
        s.label || "-",
        shortKey(s.pubkey),
        s.version || "-",
        s.last_uptime_proof || "-",
      ]);
    });
    console.log(table.toString());
  }

  console.log(chalk.cyan(line("═")) + "\n");
}

module.exports = { dailyReport, monthlyReport, statusReport };
