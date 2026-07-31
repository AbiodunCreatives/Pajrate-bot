/**
 * scripts/renew-session.js
 * ------------------------
 * Renews the PajCash session token interactively.
 *
 * Usage:
 *   node scripts/renew-session.js
 *
 * It will:
 *   1. Send an OTP to PAJCASH_SESSION_RECIPIENT (email or phone)
 *   2. Prompt you to enter the OTP
 *   3. Print the new token + expiry
 *   4. Print the exact `fly secrets set` command to run
 */

require("dotenv").config();
const readline = require("readline");
const { initiatePajCashSession, verifyPajCashSessionOtp } = require("../src/pajcash");

const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
const ask = (q) => new Promise((res) => rl.question(q, res));

async function main() {
  const recipient = (process.env.PAJCASH_SESSION_RECIPIENT ?? "").trim();
  if (!recipient) {
    console.error("❌ PAJCASH_SESSION_RECIPIENT is not set in .env");
    process.exit(1);
  }

  console.log(`\n📧 Sending OTP to ${recipient}...`);

  try {
    await initiatePajCashSession();
    console.log("✅ OTP sent.\n");
  } catch (err) {
    console.error("❌ Failed to send OTP:", err.message);
    process.exit(1);
  }

  const otp = (await ask("Enter OTP: ")).trim();
  if (!otp) {
    console.error("❌ No OTP entered.");
    process.exit(1);
  }

  console.log("\n🔄 Verifying OTP...");

  let result;
  try {
    result = await verifyPajCashSessionOtp(otp);
  } catch (err) {
    console.error("❌ OTP verification failed:", err.message);
    process.exit(1);
  }

  rl.close();

  const token     = result?.token ?? result?.sessionToken ?? result?.data?.token;
  const expiresAt = result?.expiresAt ?? result?.data?.expiresAt ?? result?.expires_at;

  if (!token) {
    console.error("❌ No token in response. Full response:");
    console.log(JSON.stringify(result, null, 2));
    process.exit(1);
  }

  console.log("\n✅ Session renewed!\n");
  console.log(`Token:      ${token}`);
  console.log(`Expires at: ${expiresAt ?? "unknown"}\n`);
  console.log("─────────────────────────────────────────────────────────────");
  console.log("Run this to update Fly:\n");
  console.log(`fly secrets set PAJCASH_SESSION_TOKEN=${token} PAJCASH_SESSION_EXPIRES_AT=${expiresAt ?? ""} -a pajrate-bot`);
  console.log("─────────────────────────────────────────────────────────────\n");
}

main().catch((err) => {
  console.error("Unexpected error:", err.message);
  process.exit(1);
});
