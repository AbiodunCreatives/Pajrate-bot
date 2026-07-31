/**
 * pajcash.js
 * ----------
 * PajCash API client — NGN → USDC onramp.
 * Ported from HeadlineOdds-Arena src/pajcash.ts (onramp path only).
 */

"use strict";

const { randomUUID } = require("crypto");
const { createOnrampRecord, getOnrampByOrderId, upsertOnrampStatus } = require("./db");

const TIMEOUT_MS   = 20_000;
const USDC_EPSILON = 0.000001;

// ─── Config helpers ───────────────────────────────────────────────────────────

function getBaseUrl() {
  const e = (process.env.PAJCASH_ENV ?? "production").trim();
  if (e === "staging") return "https://api-staging.paj.cash";
  if (e === "local")   return "http://localhost:3000";
  return "https://api.paj.cash";
}

function getApiKey() {
  const v = (process.env.PAJCASH_API_KEY ?? "").trim();
  if (!v) throw new Error("PAJCASH_API_KEY is missing.");
  return v;
}

function getSessionToken() {
  const token = (process.env.PAJCASH_SESSION_TOKEN ?? "").trim();
  if (!token) throw new Error("PAJCASH_SESSION_TOKEN is missing. Run the OTP session script to obtain one.");
  const exp = (process.env.PAJCASH_SESSION_EXPIRES_AT ?? "").trim();
  if (exp) {
    const ms = Date.parse(exp);
    if (Number.isFinite(ms) && ms <= Date.now() + 60_000)
      throw new Error("PajCash session token is expired. Re-run the OTP session script.");
  }
  return token;
}

function getWebhookSecret() {
  const v = (process.env.PAJCASH_WEBHOOK_PATH_SECRET ?? "").trim();
  if (!v) throw new Error("PAJCASH_WEBHOOK_PATH_SECRET is missing.");
  return v;
}

function getWebhookBaseUrl() {
  const v = (process.env.PAJCASH_WEBHOOK_BASE_URL ?? "").trim();
  if (!v) throw new Error("PAJCASH_WEBHOOK_BASE_URL is missing.");
  return v.replace(/\/+$/, "");
}

// ─── HTTP ─────────────────────────────────────────────────────────────────────

async function parseResponse(res) {
  const raw = await res.text();
  let parsed = {};
  if (raw) {
    try { parsed = JSON.parse(raw); }
    catch {
      if (!res.ok) throw new Error(raw || `PajCash ${res.status}`);
      throw new Error(`PajCash invalid JSON (${res.status})`);
    }
  }
  if (!res.ok) {
    const msg = parsed?.message ? String(parsed.message) : raw || `PajCash ${res.status}`;
    throw new Error(msg);
  }
  return parsed;
}

async function request(path, { method = "GET", token, apiKey, body } = {}) {
  const headers = { "Content-Type": "application/json" };
  if (token)  headers["Authorization"] = `Bearer ${token}`;
  if (apiKey) headers["x-api-key"]     = apiKey;
  const res = await fetch(`${getBaseUrl()}${path}`, {
    method, headers,
    body:   body ? JSON.stringify(body) : undefined,
    signal: AbortSignal.timeout(TIMEOUT_MS),
  });
  return parseResponse(res);
}

// ─── Math helpers ─────────────────────────────────────────────────────────────

function roundFiat(v) { return Math.round((v + Number.EPSILON) * 100)       / 100;       }
function roundUsdc(v) { return Math.round((v + Number.EPSILON) * 1_000_000) / 1_000_000; }

function getUsdcAmount(payload) {
  if (typeof payload.usdcAmount === "number" && Number.isFinite(payload.usdcAmount))
    return roundUsdc(payload.usdcAmount);
  if (typeof payload.amount === "number" && Number.isFinite(payload.amount))
    return roundUsdc(payload.amount);
  return null;
}

function normalizeStatus(status) {
  const s = (status ?? "").trim().toUpperCase();
  if (!s) throw new Error("PajCash payload missing status.");
  return s;
}

// ─── Public: webhook URL ──────────────────────────────────────────────────────

function getPajCashWebhookUrl() {
  return `${getWebhookBaseUrl()}/webhook/pajcash/${getWebhookSecret()}`;
}

// ─── Public: session (OTP) ────────────────────────────────────────────────────

async function initiatePajCashSession() {
  const recipient = (process.env.PAJCASH_SESSION_RECIPIENT ?? "").trim();
  if (!recipient) throw new Error("PAJCASH_SESSION_RECIPIENT is missing.");
  const body = recipient.includes("@") ? { email: recipient } : { phone: recipient };
  return request("/pub/initiate", { method: "POST", apiKey: getApiKey(), body });
}

async function verifyPajCashSessionOtp(otp) {
  const trimmed = (otp ?? "").trim();
  if (!trimmed) throw new Error("OTP is required.");
  const recipient = (process.env.PAJCASH_SESSION_RECIPIENT ?? "").trim();
  if (!recipient) throw new Error("PAJCASH_SESSION_RECIPIENT is missing.");
  const device = { uuid: `pajrate-${Date.now()}`, device: "Pajrate Bot", os: process.platform, browser: "Node.js" };
  const body = recipient.includes("@")
    ? { email: recipient, otp: trimmed, device }
    : { phone: recipient, otp: trimmed, device };
  return request("/pub/verify", { method: "POST", apiKey: getApiKey(), body });
}

// ─── Public: createOnramp ─────────────────────────────────────────────────────

/**
 * Create a PajCash NGN→USDC onramp order and persist it to Supabase.
 *
 * @param {number} telegramId
 * @param {number} fiatAmount       NGN amount, e.g. 5000
 * @param {string} recipientAddress Solana wallet address that will receive USDC
 * @returns {Promise<object>}       pajcash_onramps row
 */
async function createOnramp(telegramId, fiatAmount, recipientAddress) {
  const amount = roundFiat(fiatAmount);
  if (!Number.isFinite(amount) || amount <= 0)
    throw new Error("Fiat amount must be greater than zero.");

  const usdcMint = (process.env.SOLANA_USDC_MINT ?? "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v").trim();
  const apiKey   = (process.env.PAJCASH_API_KEY       ?? "").trim();
  const token    = (process.env.PAJCASH_SESSION_TOKEN ?? "").trim();
  const isProd   = (process.env.NODE_ENV ?? "development") === "production";
  const feeRaw   = process.env.PAJCASH_BUSINESS_USDC_FEE;
  const fee      = feeRaw != null && feeRaw !== "" ? Number(feeRaw) : 0;

  // Dev / missing-credentials fallback — mock order for local testing
  if (!apiKey || !token || !isProd) {
    return createOnrampRecord({
      orderId:            `DEV-${randomUUID()}`,
      telegramId,
      recipientAddress,
      mint:               usdcMint,
      chain:              "SOLANA",
      currency:           "NGN",
      bankName:           "PAJ CASH (DEV)",
      accountName:        "PAJ CASH",
      accountNumber:      "0000000000",
      fiatAmount:         amount,
      expectedUsdcAmount: roundUsdc(amount / 1000), // mock: 1000 NGN = 1 USDC
      rate:               1,
      fee,
      rawPayload:         { devMock: true },
    });
  }

  const reqBody = {
    fiatAmount: amount,
    currency:   "NGN",
    recipient:  recipientAddress,
    mint:       usdcMint,
    chain:      "SOLANA",
    webhookURL: getPajCashWebhookUrl(),
  };
  if (fee) reqBody.businessUSDCFee = fee;

  const order = await request("/pub/onramp", { method: "POST", token, body: reqBody });

  return createOnrampRecord({
    orderId:            order.id,
    telegramId,
    recipientAddress,
    mint:               order.mint,
    chain:              "SOLANA",
    currency:           order.currency,
    bankName:           order.bank,
    accountName:        order.accountName,
    accountNumber:      order.accountNumber,
    fiatAmount:         order.fiatAmount,
    expectedUsdcAmount: order.amount,
    rate:               order.rate,
    fee:                order.fee ?? fee,
    rawPayload:         order,
  });
}

// ─── Public: reconcileWebhook ─────────────────────────────────────────────────

/**
 * Process an incoming PajCash webhook. Upserts the record and verifies
 * the transaction against the API before returning the final state.
 *
 * @param {object} payload  Raw PajCash webhook body
 * @returns {Promise<object|null>}
 */
async function reconcileWebhook(payload) {
  if (!payload.id) throw new Error("PajCash webhook missing id.");

  const payloadStatus = normalizeStatus(payload.status);
  const txType        = (payload.transactionType ?? "").toUpperCase();

  // Only handle onramps (or unknown type — default to ON_RAMP)
  if (txType && txType !== "ON_RAMP") return null;

  const existing  = await getOnrampByOrderId(payload.id);
  const preserved = existing?.expected_usdc_amount > 0
    ? existing.expected_usdc_amount
    : getUsdcAmount(payload);

  // First upsert from webhook payload
  let record = await upsertOnrampStatus({
    orderId:            payload.id,
    telegramId:         existing?.telegram_id        ?? null,
    recipientAddress:   payload.recipient            ?? existing?.recipient_address ?? null,
    sender:             payload.sender               ?? existing?.sender            ?? null,
    mint:               payload.mint                 ?? existing?.mint              ?? null,
    chain:              "SOLANA",
    currency:           payload.currency             ?? existing?.currency          ?? "NGN",
    actualUsdcAmount:   getUsdcAmount(payload),
    expectedUsdcAmount: preserved,
    fiatAmount:         typeof payload.fiatAmount === "number" ? roundFiat(payload.fiatAmount) : null,
    rate:               typeof payload.rate       === "number" ? roundUsdc(payload.rate)       : null,
    status:             payloadStatus,
    transactionType:    txType || existing?.transaction_type || "ON_RAMP",
    pajSignature:       payload.signature ?? existing?.paj_signature ?? null,
    rawPayload:         payload,
  });

  // Verify against PajCash API
  try {
    const verified = await request(`/pub/transactions/${payload.id}`, { token: getSessionToken() });

    record = await upsertOnrampStatus({
      orderId:            payload.id,
      telegramId:         record.telegram_id,
      recipientAddress:   verified.recipient ?? record.recipient_address,
      sender:             verified.sender    ?? record.sender,
      mint:               verified.mint      ?? record.mint,
      chain:              "SOLANA",
      currency:           verified.currency  ?? record.currency,
      actualUsdcAmount:   getUsdcAmount(verified),
      expectedUsdcAmount: record.expected_usdc_amount > 0 ? record.expected_usdc_amount : getUsdcAmount(verified),
      fiatAmount:         typeof verified.fiatAmount === "number" ? roundFiat(verified.fiatAmount) : record.fiat_amount,
      rate:               typeof verified.rate       === "number" ? roundUsdc(verified.rate)       : record.rate,
      fee:                typeof verified.fee        === "number" ? roundUsdc(verified.fee)        : record.fee,
      status:             normalizeStatus(verified.status),
      transactionType:    verified.transactionType ?? record.transaction_type,
      pajSignature:       verified.signature ?? record.paj_signature,
      rawPayload:         verified,
    });
  } catch (err) {
    console.warn("[pajcash] Verification failed:", err.message);
  }

  return record;
}

function isPajCashCompleted(status) {
  return (status ?? "").trim().toUpperCase() === "COMPLETED";
}

module.exports = {
  createOnramp,
  reconcileWebhook,
  getPajCashWebhookUrl,
  getWebhookSecret,
  initiatePajCashSession,
  verifyPajCashSessionOtp,
  isPajCashCompleted,
};
