/**
 * db.js
 * -----
 * Supabase client + pajcash_onramps table helpers.
 *
 * Ported from HeadlineOdds-Arena:
 *   src/db/client.ts  +  src/db/pajcash.ts
 *
 * Table used: pajcash_onramps
 *   id, order_id, telegram_id, recipient_address, sender, mint, chain,
 *   currency, bank_name, account_name, account_number, fiat_amount,
 *   expected_usdc_amount, actual_usdc_amount, rate, fee, status,
 *   transaction_type, paj_signature, raw_payload, paid_at, completed_at,
 *   created_at, updated_at
 */

"use strict";

const { createClient } = require("@supabase/supabase-js");
const ws               = require("ws");

// ─── Supabase client ──────────────────────────────────────────────────────────

const SUPABASE_URL             = process.env.SUPABASE_URL             ?? "";
const SUPABASE_SERVICE_ROLE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY ?? "";

if (!SUPABASE_URL || !SUPABASE_SERVICE_ROLE_KEY) {
  console.warn(
    "[db] SUPABASE_URL or SUPABASE_SERVICE_ROLE_KEY is missing — " +
    "buy-USDC flow will not work until these are set."
  );
}

const supabase = createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY, {
  auth:      { persistSession: false },
  realtime:  { transport: ws },
});

// ─── Rounding helpers ─────────────────────────────────────────────────────────

function roundMoney(value) {
  return Math.round((value + Number.EPSILON) * 100) / 100;
}

function roundUsdc(value) {
  return Math.round((value + Number.EPSILON) * 1_000_000) / 1_000_000;
}

function parseMoney(value) {
  if (typeof value === "number") return Number.isFinite(value) ? roundMoney(value) : 0;
  if (typeof value === "string") {
    const p = Number.parseFloat(value);
    return Number.isFinite(p) ? roundMoney(p) : 0;
  }
  return 0;
}

function parseUsdc(value) {
  if (typeof value === "number") return Number.isFinite(value) ? roundUsdc(value) : 0;
  if (typeof value === "string") {
    const p = Number.parseFloat(value);
    return Number.isFinite(p) ? roundUsdc(p) : 0;
  }
  return 0;
}

function normalizeRow(row) {
  return {
    ...row,
    fiat_amount:          parseMoney(row.fiat_amount),
    expected_usdc_amount: parseUsdc(row.expected_usdc_amount),
    actual_usdc_amount:   parseUsdc(row.actual_usdc_amount),
    rate:                 parseUsdc(row.rate),
    fee:                  parseUsdc(row.fee),
    raw_payload:          row.raw_payload ?? {},
  };
}

// ─── Table name ───────────────────────────────────────────────────────────────

const TABLE = "pajcash_onramps";

// ─── createOnrampRecord ───────────────────────────────────────────────────────

/**
 * Insert a new onramp record (status = INIT).
 *
 * @param {object} input
 * @param {string} input.orderId
 * @param {number} input.telegramId
 * @param {string} input.recipientAddress  wallet address USDC will land in
 * @param {string} input.mint              USDC mint address
 * @param {string} input.chain             "SOLANA"
 * @param {string} input.currency          "NGN"
 * @param {string} input.bankName
 * @param {string} input.accountName
 * @param {string} input.accountNumber
 * @param {number} input.fiatAmount
 * @param {number} input.expectedUsdcAmount
 * @param {number} input.rate
 * @param {number} input.fee
 * @param {object} input.rawPayload
 * @returns {Promise<object>} normalized row
 */
async function createOnrampRecord(input) {
  const now = new Date().toISOString();
  const { data, error } = await supabase
    .from(TABLE)
    .insert({
      order_id:             input.orderId,
      telegram_id:          input.telegramId,
      recipient_address:    input.recipientAddress,
      mint:                 input.mint,
      chain:                input.chain,
      currency:             input.currency,
      bank_name:            input.bankName,
      account_name:         input.accountName,
      account_number:       input.accountNumber,
      fiat_amount:          roundMoney(input.fiatAmount),
      expected_usdc_amount: roundUsdc(input.expectedUsdcAmount),
      rate:                 roundUsdc(input.rate),
      fee:                  roundUsdc(input.fee),
      status:               "INIT",
      transaction_type:     "ON_RAMP",
      raw_payload:          input.rawPayload,
      created_at:           now,
      updated_at:           now,
    })
    .select("*")
    .single();

  if (error) throw error;
  return normalizeRow(data);
}

// ─── getOnrampByOrderId ───────────────────────────────────────────────────────

/**
 * @param {string} orderId
 * @returns {Promise<object|null>}
 */
async function getOnrampByOrderId(orderId) {
  const { data, error } = await supabase
    .from(TABLE)
    .select("*")
    .eq("order_id", orderId)
    .maybeSingle();

  if (error) throw error;
  return data ? normalizeRow(data) : null;
}

// ─── listRecentOnramps ────────────────────────────────────────────────────────

/**
 * @param {number} telegramId
 * @param {number} [limit=4]
 * @returns {Promise<object[]>}
 */
async function listRecentOnramps(telegramId, limit = 4) {
  const { data, error } = await supabase
    .from(TABLE)
    .select("*")
    .eq("telegram_id", telegramId)
    .eq("transaction_type", "ON_RAMP")
    .order("created_at", { ascending: false })
    .limit(limit);

  if (error) throw error;
  return (data ?? []).map(normalizeRow);
}

// ─── upsertOnrampStatus ───────────────────────────────────────────────────────

/**
 * Create or update a pajcash onramp row. Only sets fields that are non-null in input.
 *
 * @param {object} input
 * @returns {Promise<object>} normalized row
 */
async function upsertOnrampStatus(input) {
  const existing = await getOnrampByOrderId(input.orderId);
  const now      = new Date().toISOString();
  const normalizedStatus = (input.status ?? "INIT").trim() || "INIT";

  const payload = {
    order_id:   input.orderId,
    status:     normalizedStatus,
    updated_at: now,
  };

  if (input.telegramId != null)       payload.telegram_id        = input.telegramId;
  if (input.recipientAddress != null) payload.recipient_address  = input.recipientAddress;
  if (input.sender != null)           payload.sender             = input.sender;
  if (input.mint != null)             payload.mint               = input.mint;
  if (input.chain != null)            payload.chain              = input.chain;
  if (input.currency != null)         payload.currency           = input.currency;
  if (input.bankName != null)         payload.bank_name          = input.bankName;
  if (input.accountName != null)      payload.account_name       = input.accountName;
  if (input.accountNumber != null)    payload.account_number     = input.accountNumber;
  if (input.fiatAmount != null)       payload.fiat_amount        = roundMoney(input.fiatAmount);
  if (input.expectedUsdcAmount != null) payload.expected_usdc_amount = roundUsdc(input.expectedUsdcAmount);
  if (input.actualUsdcAmount != null) payload.actual_usdc_amount = roundUsdc(input.actualUsdcAmount);
  if (input.rate != null)             payload.rate               = roundUsdc(input.rate);
  if (input.fee != null)              payload.fee                = roundUsdc(input.fee);
  if (input.transactionType != null)  payload.transaction_type   = input.transactionType;
  if (input.pajSignature != null)     payload.paj_signature      = input.pajSignature;
  if (input.rawPayload != null)       payload.raw_payload        = input.rawPayload;

  if (!existing) {
    if (payload.telegram_id   == null) payload.telegram_id    = null;
    if (payload.chain         == null) payload.chain          = "SOLANA";
    if (payload.currency      == null) payload.currency       = "NGN";
    if (payload.raw_payload   == null) payload.raw_payload    = {};
  }

  if (normalizedStatus.toUpperCase() === "PAID" && !existing?.paid_at) {
    payload.paid_at = now;
  }
  if (normalizedStatus.toUpperCase() === "COMPLETED" && !existing?.completed_at) {
    payload.completed_at = now;
  }

  const query = existing
    ? supabase.from(TABLE).update(payload).eq("order_id", input.orderId)
    : supabase.from(TABLE).insert({ ...payload, created_at: now });

  const { data, error } = await query.select("*").single();
  if (error) throw error;
  return normalizeRow(data);
}

module.exports = {
  supabase,
  createOnrampRecord,
  getOnrampByOrderId,
  listRecentOnramps,
  upsertOnrampStatus,
};
