/**
 * store.js
 * --------
 * Tiny JSON-file persistence layer. No external DB — just reads/writes
 * files on disk. Good enough for a single-instance bot; if you deploy
 * with multiple replicas or want durability across redeploys on Fly.io,
 * mount a persistent volume at DATA_DIR (see fly.toml).
 *
 * Files:
 *   data/alerts.json  — active price alerts
 *   data/users.json   — all users who have ever interacted with the bot
 */

const fs   = require("fs");
const path = require("path");

const DATA_DIR    = process.env.DATA_DIR || path.join(__dirname, "..", "data");
const ALERTS_FILE = path.join(DATA_DIR, "alerts.json");
const USERS_FILE  = path.join(DATA_DIR, "users.json");
const META_FILE   = path.join(DATA_DIR, "meta.json");

function ensureStore() {
  if (!fs.existsSync(DATA_DIR))   fs.mkdirSync(DATA_DIR, { recursive: true });
  if (!fs.existsSync(ALERTS_FILE)) fs.writeFileSync(ALERTS_FILE, "[]",   "utf8");
  if (!fs.existsSync(USERS_FILE))  fs.writeFileSync(USERS_FILE,  "[]",   "utf8");
  if (!fs.existsSync(META_FILE))   fs.writeFileSync(META_FILE,   "{}",   "utf8");
}

// ─── Helpers ──────────────────────────────────────────────────────────────────

function readJson(file, fallback) {
  try {
    const raw    = fs.readFileSync(file, "utf8");
    const parsed = JSON.parse(raw || JSON.stringify(fallback));
    // Arrays stay arrays, objects stay objects
    if (Array.isArray(fallback)) return Array.isArray(parsed) ? parsed : fallback;
    return (parsed && typeof parsed === "object") ? parsed : fallback;
  } catch (err) {
    console.error(`Failed to read ${file}, starting fresh:`, err.message);
    return fallback;
  }
}

function writeJson(file, data) {
  const tmp = `${file}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(data, null, 2), "utf8");
  fs.renameSync(tmp, file);
}

// ─── Meta (bot-level flags) ───────────────────────────────────────────────────

function readMeta() {
  ensureStore();
  return readJson(META_FILE, {});
}

function writeMeta(meta) {
  ensureStore();
  writeJson(META_FILE, meta);
}

/**
 * Returns true if a named broadcast has already been sent.
 * @param {string} broadcastId  e.g. "v2-features"
 */
function isBroadcastSent(broadcastId) {
  const meta = readMeta();
  return meta.broadcasts?.[broadcastId]?.sent === true;
}

/**
 * Marks a named broadcast as sent so it won't fire again on restart.
 * @param {string} broadcastId
 */
function markBroadcastSent(broadcastId) {
  const meta = readMeta();
  if (!meta.broadcasts) meta.broadcasts = {};
  meta.broadcasts[broadcastId] = { sent: true, sentAt: new Date().toISOString() };
  writeMeta(meta);
}

// ─── Alerts ───────────────────────────────────────────────────────────────────

function readAlerts() {
  ensureStore();
  return readJson(ALERTS_FILE, []);
}

function writeAlerts(alerts) {
  ensureStore();
  writeJson(ALERTS_FILE, alerts);
}

// ─── Users ────────────────────────────────────────────────────────────────────
// User records are now stored in Supabase (bot_users table via db.js).
// These stubs are kept so any old imports don't crash — they are no-ops.

/** @deprecated Use db.js upsertUser instead */
function readUsers()  { return []; }
/** @deprecated Use db.js upsertUser instead */
function writeUsers() {}
/** @deprecated Use db.js upsertUser instead */
function upsertUser() {}

// ─── Wallet addresses ─────────────────────────────────────────────────────────
// Wallet addresses are now stored in Supabase (bot_users.wallet_address via db.js).
// These stubs kept for safety — index.js now imports from db.js directly.

/** @deprecated Use db.js getWalletAddress instead */
function getWalletAddress() { return null; }
/** @deprecated Use db.js setWalletAddress instead */
function setWalletAddress() {}

module.exports = {
  readAlerts, writeAlerts,
  readUsers, writeUsers, upsertUser,
  readMeta, writeMeta, isBroadcastSent, markBroadcastSent,
  getWalletAddress, setWalletAddress,
};
