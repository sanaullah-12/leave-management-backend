#!/usr/bin/env node
/**
 * Email diagnostic harness (provider: Resend).
 *
 * Runs the delivery path one layer at a time so a failure points at a single
 * cause instead of "email didn't arrive". Each stage is independent: if stage 3
 * fails, stages 1-2 still tell you what *did* work.
 *
 *   Stage 1  Environment + config validation
 *   Stage 2  DNS resolution of api.resend.com
 *   Stage 3  Outbound HTTPS reachability (443)
 *   Stage 4  API key validation (no email sent)
 *   Stage 5  Send a real invitation email        <-- only with --to=
 *
 * Usage:
 *   node test-invite-email.js                      # diagnose only, sends nothing
 *   node test-invite-email.js --to=you@gmail.com   # diagnose, then send a real invite
 *
 * IMPORTANT — where you run this changes what it proves:
 *   `railway run ...` executes on YOUR machine with Railway's variables, so it
 *   tests your network, not Railway's. To test the deployment itself, hit the
 *   equivalent endpoint: GET /api/debug/email-diagnose
 */

const path = require("path");
const dns = require("dns").promises;

// ---------------------------------------------------------------------------
// Env loading — mirrors server.js so this tests the same config the app uses.
// ---------------------------------------------------------------------------
const isDeployedProduction =
  process.env.NODE_ENV === "production" ||
  !!process.env.RAILWAY_ENVIRONMENT_NAME ||
  !!process.env.RAILWAY_ENVIRONMENT;

if (isDeployedProduction) {
  require("dotenv").config({ path: path.join(__dirname, ".env.production") });
  process.env.NODE_ENV = "production";
} else {
  require("dotenv").config();
}

// ---------------------------------------------------------------------------
const args = process.argv.slice(2);
const getArg = (name) => {
  const hit = args.find((a) => a.startsWith(`--${name}=`));
  return hit ? hit.split("=").slice(1).join("=") : undefined;
};
const recipient = getArg("to");

const results = [];
const line = (s = "") => console.log(s);
const stage = (n, title) => {
  line("");
  line(`━━━ STAGE ${n}: ${title} ${"━".repeat(Math.max(0, 44 - title.length))}`);
};
const pass = (msg) => line(`  ✅ ${msg}`);
const fail = (msg) => line(`  ❌ ${msg}`);
const info = (msg) => line(`  •  ${msg}`);
const record = (name, ok, detail) => results.push({ name, ok, detail });

const maskEmail = (e) => {
  if (!e) return "NOT SET";
  const at = e.indexOf("@");
  return at < 1 ? "***" : `${e.slice(0, 2)}***${e.slice(at)}`;
};

const { probeTcp } = require("./services/email/diagnose");

const API_HOST = "api.resend.com";

// ---------------------------------------------------------------------------
(async () => {
  line("");
  line("╔════════════════════════════════════════════════════════════╗");
  line("║   EMAIL DIAGNOSTIC — provider: Resend                      ║");
  line("╚════════════════════════════════════════════════════════════╝");
  line(`  Time:        ${new Date().toISOString()}`);
  line(`  NODE_ENV:    ${process.env.NODE_ENV || "(unset)"}`);
  line(`  Railway env: ${process.env.RAILWAY_ENVIRONMENT || "(not on Railway)"}`);
  line(`  Platform:    ${process.platform} / node ${process.version}`);
  line(
    `  Mode:        ${
      recipient ? `WILL SEND to ${maskEmail(recipient)}` : "diagnose only (no email sent)"
    }`
  );

  // ---- STAGE 1 ------------------------------------------------------------
  stage(1, "Environment & config validation");
  let config;
  try {
    const { loadEmailConfig } = require("./services/email/config");
    config = loadEmailConfig();
    pass("RESEND_API_KEY present and well-formed");
    info(`API key:  ${String(config.apiKey).length} chars, prefix "re_" (value never printed)`);
    info(`From:     ${config.from}`);
    if (config.replyTo) info(`Reply-To: ${maskEmail(config.replyTo)}`);
    record("Config validation", true);

    if (config.isTestSender) {
      line("");
      info("⚠️  Using Resend's shared test sender (onboarding@resend.dev).");
      info("   It ONLY delivers to the address that owns the Resend account.");
      info("   Sends to anyone else return success but never arrive.");
      info("   Verify a domain, then set EMAIL_FROM to send to real recipients.");
    }
  } catch (err) {
    fail(err.message);
    record("Config validation", false, err.message);
    line("");
    line("⛔ Cannot continue without valid configuration.");
    process.exit(1);
  }

  // ---- STAGE 2 ------------------------------------------------------------
  stage(2, "DNS resolution");
  try {
    const addrs = await dns.lookup(API_HOST, { all: true });
    pass(`${API_HOST} resolved to ${addrs.length} address(es)`);
    addrs.slice(0, 3).forEach((a) => info(`${a.address} (IPv${a.family})`));
    record("DNS resolution", true);
  } catch (err) {
    fail(`DNS lookup failed: ${err.code} — ${err.message}`);
    record("DNS resolution", false, err.code);
  }

  // ---- STAGE 3 ------------------------------------------------------------
  stage(3, "Outbound HTTPS reachability");
  info("Resend is an HTTPS API — only port 443 is required.");
  info("(This is why it is unaffected by SMTP port blocking.)");
  line("");
  const probe = await probeTcp(API_HOST, 443, 10000);
  if (probe.ok) pass(`port 443 OPEN (${probe.ms}ms) — ${probe.reason}`);
  else fail(`port 443 BLOCKED (${probe.ms}ms) — ${probe.reason}`);
  record("HTTPS reachability", probe.ok, `443:${probe.ok ? "open" : "blocked"}`);

  // ---- STAGE 4 ------------------------------------------------------------
  stage(4, "API key validation");
  let authOk = false;
  if (!probe.ok) {
    info("Skipped — cannot reach api.resend.com (see stage 3).");
    record("API key", false, "skipped, network blocked");
  } else {
    try {
      const { checkEmailHealth } = require("./services/email");
      const health = await checkEmailHealth();
      if (health.ok) {
        pass("Resend accepted the API key");
        info(health.message);
        authOk = true;
        record("API key", true);
      } else {
        fail(`${health.reason} [${health.code}]`);
        info(`Cause: ${health.cause}`);
        info(`Fix:   ${health.solution}`);
        record("API key", false, health.code);
      }
    } catch (err) {
      fail(err.message);
      record("API key", false, err.code);
    }
  }

  // ---- STAGE 5 ------------------------------------------------------------
  stage(5, "Send real invitation email");
  if (!recipient) {
    info("Skipped — no --to= given. Re-run with --to=you@gmail.com to send.");
    record("Invite send", null, "not attempted");
  } else if (!authOk) {
    info("Skipped — stages above failed; a send would repeat the same error.");
    record("Invite send", false, "skipped, prerequisites failed");
  } else {
    try {
      const { sendInvitationEmail } = require("./services/email");
      const fakeEmployee = {
        name: "Diagnostic Test User",
        email: recipient,
        company: "Nexora Diagnostics",
        position: "Email Test",
        department: "Engineering",
      };

      info(`Sending invitation to ${maskEmail(recipient)}...`);
      const result = await sendInvitationEmail(
        fakeEmployee,
        `diagnostic-${Date.now()}`,
        "Email Diagnostic",
        "employee"
      );

      pass("Invitation accepted by Resend");
      info(`Message ID: ${result.messageId}`);
      info(`Attempts:   ${result.attempts}`);
      record("Invite send", true);

      line("");
      info("NOTE: 'accepted' means Resend queued it, not that it landed in the");
      info("inbox. Check https://resend.com/emails for per-message delivery status.");
      if (config.isTestSender) {
        info("With the test sender, only the Resend account owner's address receives mail.");
      }
    } catch (err) {
      fail(err.message);
      if (err.emailDiagnosis) {
        info(`Code:  ${err.emailDiagnosis.code}`);
        info(`Cause: ${err.emailDiagnosis.cause}`);
        info(`Fix:   ${err.emailDiagnosis.solution}`);
      }
      record("Invite send", false, err.code);
    }
  }

  // ---- Summary ------------------------------------------------------------
  line("");
  line("━━━ SUMMARY ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━");
  for (const r of results) {
    const icon = r.ok === null ? "⏭️ " : r.ok ? "✅" : "❌";
    line(`  ${icon} ${r.name.padEnd(22)} ${r.detail || ""}`);
  }

  line("");
  line("━━━ VERDICT ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━");
  if (!probe.ok) {
    line("  Outbound HTTPS to api.resend.com is blocked. This is unusual —");
    line("  port 443 is open on virtually every host — check network egress.");
  } else if (!authOk) {
    line("  Network is fine; the API key was rejected. Set a valid");
    line("  RESEND_API_KEY (from https://resend.com/api-keys) in Railway.");
  } else if (recipient && results.find((r) => r.name === "Invite send")?.ok) {
    line("  Full path works end to end.");
    if (config.isTestSender) {
      line("  Reminder: the test sender only delivers to the Resend account owner.");
      line("  Verify a domain and set EMAIL_FROM to reach real recipients.");
    }
  } else {
    line("  Config, network and API key all pass. Re-run with --to= to send.");
  }
  line("");

  process.exit(results.some((r) => r.ok === false) ? 1 : 0);
})().catch((err) => {
  console.error("");
  console.error("💥 Diagnostic harness crashed:");
  console.error(err);
  process.exit(1);
});
