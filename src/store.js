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

function readUsers() {
  ensureStore();
  return readJson(USERS_FILE, []);
}

function writeUsers(users) {
  ensureStore();
  writeJson(USERS_FILE, users);
}

/**
 * Inserts or updates a user record.
 * @param {{ chatId: number|string, username?: string }} user
 */
function upsertUser({ chatId, username }) {
  const users = readUsers();
  const id    = String(chatId);
  const idx   = users.findIndex((u) => u.chatId === id);

  if (idx === -1) {
    users.push({ chatId: id, username: username || null, firstSeen: new Date().toISOString() });
  } else {
    // Update username if it changed
    if (username && users[idx].username !== username) {
      users[idx].username = username;
    }
  }

  writeUsers(users);
}

// ─── Wallet addresses ─────────────────────────────────────────────────────────

/**
 * Returns the stored Solana wallet address for a user, or null.
 * @param {number|string} chatId
 * @returns {string|null}
 */
function getWalletAddress(chatId) {
  const users = readUsers();
  const user  = users.find((u) => u.chatId === String(chatId));
  return user?.walletAddress ?? null;
}

/**
 * Persists a Solana wallet address for a user.
 * @param {number|string} chatId
 * @param {string} address
 */
function setWalletAddress(chatId, address) {
  const users = readUsers();
  const id    = String(chatId);
  const idx   = users.findIndex((u) => u.chatId === id);
  if (idx === -1) {
    users.push({ chatId: id, username: null, firstSeen: new Date().toISOString(), walletAddress: address });
  } else {
    users[idx].walletAddress = address;
  }
  writeUsers(users);
}

module.exports = {
  readAlerts, writeAlerts,
  readUsers, writeUsers, upsertUser,
  readMeta, writeMeta, isBroadcastSent, markBroadcastSent,
  getWalletAddress, setWalletAddress,
};
