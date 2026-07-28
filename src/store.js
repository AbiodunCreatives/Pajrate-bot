/**
 * store.js
 * --------
 * Tiny JSON-file persistence layer. No external DB — just reads/writes
 * a file on disk. Good enough for a single-instance bot; if you deploy
 * with multiple replicas or want durability across redeploys on Fly.io,
 * mount a persistent volume at DATA_DIR (see fly.toml).
 */

const fs = require("fs");
const path = require("path");

const DATA_DIR = process.env.DATA_DIR || path.join(__dirname, "..", "data");
const ALERTS_FILE = path.join(DATA_DIR, "alerts.json");

function ensureStore() {
  if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, { recursive: true });
  if (!fs.existsSync(ALERTS_FILE)) fs.writeFileSync(ALERTS_FILE, "[]", "utf8");
}

function readAlerts() {
  ensureStore();
  try {
    const raw = fs.readFileSync(ALERTS_FILE, "utf8");
    const parsed = JSON.parse(raw || "[]");
    return Array.isArray(parsed) ? parsed : [];
  } catch (err) {
    console.error("Failed to read alerts store, starting fresh:", err.message);
    return [];
  }
}

function writeAlerts(alerts) {
  ensureStore();
  // Write to a temp file then rename, to avoid truncating the file if the
  // process dies mid-write.
  const tmpFile = `${ALERTS_FILE}.tmp`;
  fs.writeFileSync(tmpFile, JSON.stringify(alerts, null, 2), "utf8");
  fs.renameSync(tmpFile, ALERTS_FILE);
}

module.exports = { readAlerts, writeAlerts };
