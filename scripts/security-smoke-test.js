/**
 * Security smoke test - run against a LOCAL server backed by a throwaway
 * database, never production. It creates two companies and users.
 *
 *   BASE=http://localhost:5055/api node scripts/security-smoke-test.js
 *
 * The server must run with ALLOW_COMPANY_REGISTRATION=true for the fixtures.
 */
const BASE = process.env.BASE || "http://localhost:5055/api";
if (/railway\.app|vercel\.app/.test(BASE)) {
  console.error("Refusing to run against a deployed environment.");
  process.exit(1);
}

let passed = 0;
let failed = 0;
const check = (name, ok, detail = "") => {
  if (ok) passed++;
  else failed++;
  console.log(`${ok ? "PASS" : "FAIL"}  ${name}${ok ? "" : `  -> ${detail}`}`);
};

const call = async (method, path, { token, body, raw, headers = {} } = {}) => {
  const res = await fetch(BASE + path, {
    method,
    headers: {
      ...(body && !raw ? { "Content-Type": "application/json" } : {}),
      ...(token ? { Authorization: `Bearer ${token}` } : {}),
      ...headers,
    },
    body: raw || (body ? JSON.stringify(body) : undefined),
  });
  let data = null;
  try {
    data = await res.json();
  } catch (_) {}
  return { status: res.status, data, headers: res.headers };
};

const uniq = Date.now().toString(36);
const PW = "Str0ngPassw0rd!";

(async () => {
  // ---------- fixtures ----------
  const regA = await call("POST", "/auth/register-company", {
    body: { companyName: `A ${uniq}`, companyEmail: `a-${uniq}@example.com`, adminName: "Admin A", adminEmail: `admin-a-${uniq}@example.com`, password: PW },
  });
  check("register company A", regA.status === 201, JSON.stringify(regA.data));
  const adminA = regA.data.token;
  check("login response carries refresh token", !!regA.data.refreshToken);

  // Second tenant (employeeId ADMIN001 is globally unique, so use invite flow for B admin)
  const regB = await call("POST", "/auth/register-company", {
    body: { companyName: `B ${uniq}`, companyEmail: `b-${uniq}@example.com`, adminName: "Admin B", adminEmail: `admin-b-${uniq}@example.com`, password: PW },
  });
  let adminB = regB.data && regB.data.token;
  console.log(`      (second company registration status ${regB.status}: ${regB.data && regB.data.message})`);

  // Employee in A via invite
  const inv = await call("POST", "/auth/invite-employee", {
    token: adminA,
    body: { name: "Emp One", email: `emp1-${uniq}@example.com`, department: "Eng", position: "Dev", joinDate: "2026-01-01", employeeId: `E1${uniq}` },
  });
  check("admin can invite employee", inv.status === 201, JSON.stringify(inv.data));
  const inv2 = await call("POST", "/auth/invite-employee", {
    token: adminA,
    body: { name: "Emp Two", email: `emp2-${uniq}@example.com`, department: "Eng", position: "Dev", joinDate: "2026-01-01", employeeId: `E2${uniq}` },
  });

  // Activate employees directly in the test DB (tokens are only emailed).
  const mongoose = require("mongoose");
  await mongoose.connect(process.env.TEST_DB || "mongodb://127.0.0.1:27018/nexora-security-test");
  const User = require("../models/User");
  for (const id of [inv.data.employee.id, inv2.data.employee.id]) {
    const u = await User.findById(id);
    u.password = PW;
    u.status = "active";
    await u.save();
  }
  if (!adminB) {
    // Second registration collides on the global ADMIN001 id; seed B's admin directly.
    const Company = require('../models/Company');
    const compB = await Company.findOne({ email: `b-${uniq}@example.com` });
    await User.create({ name: "Admin B", email: `admin-b-${uniq}@example.com`, password: PW, role: "admin", employeeId: `ADMB${uniq}`, department: "Admin", position: "Admin", joinDate: new Date(), company: compB._id, status: "active", isActive: true });
    adminB = (await call("POST", "/auth/login", { body: { email: `admin-b-${uniq}@example.com`, password: PW } })).data.token;
  }
  const emp1Login = await call("POST", "/auth/login", { body: { email: `emp1-${uniq}@example.com`, password: PW } });
  const emp1 = emp1Login.data.token;
  const emp1Refresh = emp1Login.data.refreshToken;
  const emp2Id = inv2.data.employee.id;
  const emp1Id = inv.data.employee.id;
  check("employee login", emp1Login.status === 200);

  // ---------- authentication ----------
  const inj = await call("POST", "/auth/login", { body: { email: { $ne: null }, password: PW } });
  check("login rejects operator injection in email", inj.status === 400, inj.status);
  const injQ = await call("GET", "/users?role[$ne]=x", { token: adminA });
  check("query operator syntax is inert", injQ.status === 200, injQ.status);
  const proto = await call("PUT", `/users/${emp1Id}`, { token: emp1, raw: '{"__proto__":{"role":"admin"}}', headers: { "Content-Type": "application/json" } });
  check("prototype-pollution key rejected", proto.status === 400, proto.status);

  const bad1 = await call("POST", "/auth/login", { body: { email: `emp1-${uniq}@example.com`, password: "REMOVED" } });
  const bad2 = await call("POST", "/auth/login", { body: { email: `nobody-${uniq}@example.com`, password: "REMOVED" } });
  check("no account enumeration on login", bad1.status === 401 && bad2.status === 401 && bad1.data.message === bad2.data.message, `${bad1.data.message} | ${bad2.data.message}`);

  const forged = await call("GET", "/auth/profile", {
    token: require("jsonwebtoken").sign({ id: emp1Id, role: "admin" }, "guessed-secret"),
  });
  check("forged/unsigned token rejected", forged.status === 401);
  const noneAlg = await call("GET", "/auth/profile", {
    token: require("jsonwebtoken").sign({ sid: "x" }, null, { algorithm: "none", subject: emp1Id }),
  });
  check("alg=none token rejected", noneAlg.status === 401);

  // Refresh rotation + reuse detection
  const r1 = await call("POST", "/auth/refresh", { body: { refreshToken: emp1Refresh } });
  check("refresh issues new pair", r1.status === 200 && r1.data.refreshToken !== emp1Refresh, r1.status);
  const reuseSoon = await call("POST", "/auth/refresh", { body: { refreshToken: emp1Refresh } });
  check("replayed refresh token within grace -> 409 (no new tokens)", reuseSoon.status === 409, reuseSoon.status);

  // Logout invalidates the access token immediately
  const s2 = await call("POST", "/auth/login", { body: { email: `emp1-${uniq}@example.com`, password: PW } });
  await call("POST", "/auth/logout", { token: s2.data.token });
  const afterLogout = await call("GET", "/auth/profile", { token: s2.data.token });
  check("access token dead after logout", afterLogout.status === 401, afterLogout.status);
  const refreshAfterLogout = await call("POST", "/auth/refresh", { body: { refreshToken: s2.data.refreshToken } });
  check("refresh token dead after logout", refreshAfterLogout.status === 401);

  // Password change revokes other sessions
  const other = await call("POST", "/auth/login", { body: { email: `emp1-${uniq}@example.com`, password: PW } });
  const weak = await call("PUT", "/auth/change-password", { token: emp1, body: { currentPassword: PW, newPassword: "short" } });
  check("weak new password rejected", weak.status === 400);
  const cp = await call("PUT", "/auth/change-password", { token: emp1, body: { currentPassword: PW, newPassword: PW + "2" } });
  check("password change ok", cp.status === 200, JSON.stringify(cp.data));
  const otherAfter = await call("GET", "/auth/profile", { token: other.data.token });
  check("other sessions revoked by password change", otherAfter.status === 401, otherAfter.status);
  const sameAfter = await call("GET", "/auth/profile", { token: emp1 });
  check("current session survives own password change", sameAfter.status === 200);

  // ---------- authorization / IDOR ----------
  // 503 = device owner unresolved: still a denial (fails closed).
  const e = (r) => (r.status === 503 ? 403 : r.status);
  check("employee cannot list employees", e(await call("GET", "/users", { token: emp1 })) === 403);
  check("employee cannot read another employee", e(await call("GET", `/users/${emp2Id}`, { token: emp1 })) === 403);
  const upd = await call("PUT", `/users/${emp2Id}`, { token: emp1, body: { name: "Hacked" } });
  check("employee cannot modify another employee", upd.status === 403, upd.status);
  const selfEsc = await call("PUT", `/users/${emp1Id}`, { token: emp1, body: { role: "admin" } });
  check("role field not accepted on profile update", selfEsc.status === 400 || (selfEsc.data?.user?.role === "employee"), JSON.stringify(selfEsc.data));
  const me = await call("GET", "/auth/profile", { token: emp1 });
  check("employee is still an employee", me.data.user.role === "employee");
  check("employee cannot invite", e(await call("POST", "/auth/invite-admin", { token: emp1, body: { name: "X", email: `x-${uniq}@example.com` } })) === 403);
  check("employee cannot deactivate", e(await call("PUT", `/users/${emp2Id}/deactivate`, { token: emp1 })) === 403);
  check("employee cannot read audit log", e(await call("GET", "/audit-logs", { token: emp1 })) === 403);
  check("employee cannot unlock door", e(await call("POST", "/attendance/door/unlock", { token: emp1, body: {} })) === 403);
  check("employee cannot change lateness policy", e(await call("PUT", "/attendance/settings/late-time", { token: emp1, body: { policy: "strict" } })) === 403);
  check("employee cannot see company status summary", e(await call("GET", "/attendance/db/status-summary?startDate=2026-09-01&endDate=2026-09-02", { token: emp1 })) === 403);
  check("employee cannot read another's attendance", e(await call("GET", `/attendance/db/frontend/E2${uniq}?days=7`, { token: emp1 })) === 403);
  check("employee blocked from sync-from-database", e(await call("GET", "/attendance-sync/from-database/192.168.1.201", { token: emp1 })) === 403);
  check("employee blocked from simple-performance", e(await call("GET", "/simple-performance/simple-stats", { token: emp1 })) === 403);
  check("employee blocked from real-machine-performance", e(await call("GET", "/real-machine-performance/machine-summary/192.168.1.201", { token: emp1 })) === 403);
  check("employee cannot broadcast release", e(await call("POST", "/app-release/announce", { token: emp1, body: { version: "9.9.9" } })) === 403);
  check("employee cannot review leave", e(await call("PUT", `/leaves/${emp2Id}/review`, { token: emp1, body: { status: "approved" } })) === 403);

  // Cross-tenant
  if (adminB) {
    check("admin B cannot read company A employee", e(await call("GET", `/users/${emp1Id}`, { token: adminB })) === 404);
    check("admin B cannot unlock A's door", [403, 503].includes(e(await call("POST", "/attendance/door/unlock", { token: adminB, body: {} }))));
    const hijack = await call("POST", "/auth/invite-employee", {
      token: adminB,
      body: { name: "Steal", email: `emp1-${uniq}@example.com`, department: "X", position: "Y", joinDate: "2026-01-01" },
    });
    check("admin B cannot re-invite A's user", hijack.status === 400, hijack.status);
  } else {
    console.log("      (cross-tenant checks skipped: second company could not register)");
  }

  // SSRF guard
  const ssrf = await call("POST", "/attendance/connect", { token: adminA, body: { ip: "169.254.169.254", port: 80 } });
  check("device connect to metadata IP rejected", [400, 403, 503].includes(ssrf.status), ssrf.status);
  const push = await call("POST", "/push/subscribe", { token: emp1, body: { endpoint: "https://internal.example.com/hook", keys: { p256dh: "a", auth: "b" } } });
  check("push subscribe to non-push host rejected", push.status === 400, push.status);

  // ---------- uploads ----------
  const fd = new FormData();
  fd.append("category", "complaint");
  fd.append("title", "t");
  fd.append("description", "d");
  fd.append("isAnonymous", "true");
  fd.append("attachments", new Blob(["<script>alert(1)</script>"], { type: "image/png" }), "evil.html");
  const evil = await fetch(BASE + "/employee-voice", { method: "POST", headers: { Authorization: `Bearer ${emp1}` }, body: fd });
  check("HTML disguised as PNG rejected", evil.status === 400, evil.status);

  const png = Buffer.from("89504e470d0a1a0a0000000d4948445200000001000000010806000000", "hex");
  const fd2 = new FormData();
  fd2.append("category", "complaint");
  fd2.append("title", "Anonymous issue");
  fd2.append("description", "details");
  fd2.append("isAnonymous", "true");
  fd2.append("attachments", new Blob([png], { type: "image/png" }), "../../etc/passwd.png");
  const okUp = await fetch(BASE + "/employee-voice", { method: "POST", headers: { Authorization: `Bearer ${emp1}` }, body: fd2 });
  const okData = await okUp.json();
  check("valid image attachment accepted", okUp.status === 201, okUp.status);
  const att = okData.voice.attachments[0];
  check("attachment path is the authenticated route", att.path.startsWith("/api/employee-voice/"), att.path);
  const dl = await fetch(BASE.replace(/\/api$/, "") + att.path, { headers: { Authorization: `Bearer ${emp1}` } });
  check("owner can download attachment", dl.status === 200 && /attachment/.test(dl.headers.get("content-disposition") || ""), dl.status);
  const emp2Login = await call("POST", "/auth/login", { body: { email: `emp2-${uniq}@example.com`, password: PW } });
  const dl2 = await fetch(BASE.replace(/\/api$/, "") + att.path, { headers: { Authorization: `Bearer ${emp2Login.data.token}` } });
  check("other employee cannot download attachment", dl2.status === 404, dl2.status);
  const dlAnon = await fetch(BASE.replace(/\/api$/, "") + att.path);
  check("anonymous cannot download attachment", dlAnon.status === 401, dlAnon.status);
  const staticVoice = await fetch(BASE.replace(/\/api$/, "") + "/uploads/voice/anything.png");
  check("/uploads/voice no longer served", staticVoice.status === 404, staticVoice.status);
  const adminView = await call("GET", `/employee-voice/${okData.voice._id}`, { token: adminA });
  check("anonymous submitter hidden from admin", adminView.data.voice.employee.name === "Anonymous");

  // ---------- headers / errors ----------
  const h = await fetch(BASE + "/health");
  check("HSTS header", !!h.headers.get("strict-transport-security"));
  check("CSP header", /default-src 'none'/.test(h.headers.get("content-security-policy") || ""));
  check("nosniff header", h.headers.get("x-content-type-options") === "nosniff");
  check("no x-powered-by", !h.headers.get("x-powered-by"));
  const cors = await fetch(BASE + "/health", { headers: { Origin: "https://evil.example" } });
  check("untrusted origin gets no CORS grant", !cors.headers.get("access-control-allow-origin"));
  const badJson = await call("POST", "/auth/login", { raw: "{bad", headers: { "Content-Type": "application/json" } });
  check("malformed JSON -> 400 without stack", badJson.status === 400 && !JSON.stringify(badJson.data).includes("at "), JSON.stringify(badJson.data));
  const castErr = await call("GET", "/users/not-an-id", { token: adminA });
  check("invalid id -> 400", castErr.status === 400, castErr.status);

  // Audit trail
  const logs = await call("GET", "/audit-logs?limit=100", { token: adminA });
  const actions = new Set((logs.data.entries || []).map((x) => x.action));
  check("audit: login success recorded", actions.has("auth.login.success"));
  check("audit: login failure recorded", actions.has("auth.login.failure"));
  check("audit: password change recorded", actions.has("auth.password.change"));
  check("audit: attachment download recorded", actions.has("voice.attachment.download"));
  const verify = await call("GET", "/audit-logs/verify", { token: adminA });
  check("audit hash chain verifies", verify.data.ok === true, JSON.stringify(verify.data));
  const AuditLog = require("../models/AuditLog");
  let tamperBlocked = false;
  try {
    await AuditLog.updateOne({}, { action: "tampered" });
  } catch (_) {
    tamperBlocked = true;
  }
  check("audit entries cannot be updated through the model", tamperBlocked);

  // Brute force lockout (per account)
  let locked = false;
  for (let i = 0; i < 7; i++) {
    const r = await call("POST", "/auth/login", { body: { email: `emp2-${uniq}@example.com`, password: "REMOVED" } });
    if (r.status === 429) locked = true;
  }
  check("account locked after repeated failures", locked);

  await mongoose.disconnect();
  console.log(`\n${passed} passed, ${failed} failed`);
  process.exit(failed ? 1 : 0);
})().catch((err) => {
  console.error("Test run crashed:", err);
  process.exit(2);
});
