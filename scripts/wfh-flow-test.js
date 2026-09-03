/**
 * wfh-flow-test.js
 * ----------------
 * End-to-end check of the Work From Home chain, against a running server:
 *
 *   employee submits -> admin sees it in the queue -> admin approves
 *     -> Socket.IO notification reaches the employee
 *     -> in-app Notification row exists
 *     -> attendance reports the day as work_from_home, not absent
 *     -> the leave balance is untouched
 *
 * Then the same for a rejection, and the guards (past dates, overlaps, an
 * employee trying to review).
 *
 * Usage:
 *   node scripts/wfh-flow-test.js                 # expects a server on :5098
 *   BASE_URL=http://localhost:5000 node scripts/wfh-flow-test.js
 *
 * It creates its own throwaway employee and removes every record it wrote, so
 * it is safe to re-run. It refuses to touch the production database.
 */

require("dotenv").config();
const mongoose = require("mongoose");
const { io } = require("../../frontend/node_modules/socket.io-client");

const { generateToken } = require("../utils/jwt");
const User = require("../models/User");
const Company = require("../models/Company");
const WorkFromHome = require("../models/WorkFromHome");
const Notification = require("../models/Notification");
const Leave = require("../models/Leave");
const AttendanceLog = require("../models/AttendanceLog");

const BASE_URL = process.env.BASE_URL || "http://localhost:5098";
const TEST_EMPLOYEE_NAME = "WFH Test Employee";
const LOCAL_URI =
  process.env.LOCAL_MONGODB_URI ||
  "mongodb://127.0.0.1:27018/leave-management-dev";

let passed = 0;
let failed = 0;

const check = (label, condition, detail = "") => {
  if (condition) {
    passed += 1;
    console.log(`  PASS  ${label}`);
  } else {
    failed += 1;
    console.log(`  FAIL  ${label}${detail ? ` - ${detail}` : ""}`);
  }
};

const section = (title) => console.log(`\n== ${title} ==`);

const request = async (method, path, token, body) => {
  const res = await fetch(`${BASE_URL}${path}`, {
    method,
    headers: {
      "Content-Type": "application/json",
      ...(token ? { Authorization: `Bearer ${token}` } : {}),
    },
    body: body ? JSON.stringify(body) : undefined,
  });
  let json = null;
  try {
    json = await res.json();
  } catch {
    json = null;
  }
  return { status: res.status, body: json };
};

/** YYYY-MM-DD, n days from today. */
const dayFromNow = (n) => {
  const d = new Date();
  d.setDate(d.getDate() + n);
  return d.toISOString().slice(0, 10);
};

const isWeekendDay = (iso) => {
  const day = new Date(`${iso}T00:00:00Z`).getUTCDay();
  return day === 0 || day === 6;
};

/**
 * The next Monday at least `minAhead` days out.
 *
 * Attendance excludes weekends, so a test range that lands on a Saturday would
 * assert against days the module deliberately does not report on. Anchoring to
 * a Monday makes the run identical whatever day it is executed.
 */
const nextMonday = (minAhead) => {
  const d = new Date();
  d.setDate(d.getDate() + minAhead);
  while (d.getUTCDay() !== 1) d.setDate(d.getDate() + 1);
  return d.toISOString().slice(0, 10);
};

/** The next Saturday, for the "weekends are never charged" case. */
const nextSaturday = () => {
  const d = new Date();
  while (d.getUTCDay() !== 6) d.setDate(d.getDate() + 1);
  return d.toISOString().slice(0, 10);
};

/** The most recent weekday strictly before an ISO date. */
const weekdayBefore = (iso) => {
  const d = new Date(`${iso}T00:00:00Z`);
  do {
    d.setUTCDate(d.getUTCDate() - 1);
  } while (isWeekendDay(d.toISOString().slice(0, 10)));
  return d.toISOString().slice(0, 10);
};

/**
 * The nth weekday before today.
 *
 * The rule sections need days that are over, distinct from each other, and
 * still inside the backdating window. Three weekdays back is at most five
 * calendar days, whatever day the run happens on.
 */
const weekdaysAgo = (n) => {
  let iso = dayFromNow(0);
  for (let i = 0; i < n; i += 1) iso = weekdayBefore(iso);
  return iso;
};

/**
 * Removes every record any run of this test could have written.
 *
 * Notifications are cleared by the request they reference as well as by
 * recipient: a request notification goes to the ADMINS, so deleting by the
 * test employee alone would leave those behind.
 */
async function sweepTestData() {
  const stale = await User.find({ name: TEST_EMPLOYEE_NAME })
    .select("_id employeeId")
    .lean();
  if (!stale.length) return;

  const ids = stale.map((u) => u._id);
  const requests = await WorkFromHome.find({ employee: { $in: ids } })
    .select("_id")
    .lean();

  await Notification.deleteMany({
    $or: [
      { recipient: { $in: ids } },
      { wfhId: { $in: requests.map((r) => r._id) } },
    ],
  });
  await WorkFromHome.deleteMany({ employee: { $in: ids } });
  await Leave.deleteMany({ employee: { $in: ids } });
  await AttendanceLog.deleteMany({
    employeeId: { $in: stale.map((u) => u.employeeId) },
  });
  await User.deleteMany({ _id: { $in: ids } });
}

async function main() {
  if (process.env.USE_PRODUCTION_DB === "true") {
    console.error(
      "Refusing to run: USE_PRODUCTION_DB=true. This test writes and deletes records."
    );
    process.exit(1);
  }

  await mongoose.connect(LOCAL_URI);
  console.log(`Database: ${mongoose.connection.db.databaseName}`);
  console.log(`Server:   ${BASE_URL}\n`);

  const company = await Company.findOne();
  const admin = await User.findOne({ role: "admin", company: company._id });
  if (!company || !admin) {
    console.error("No company or admin in the local database. Seed one first.");
    process.exit(1);
  }

  // Sweep anything a previous run left behind - a run killed mid-flight (a
  // dropped database connection, a Ctrl-C) never reaches its own cleanup, and
  // the admin-side request notifications would otherwise accumulate.
  await sweepTestData();

  // A throwaway employee, so nothing this test does lands on a real record.
  const suffix = Date.now().toString().slice(-6);
  const employee = await User.create({
    name: TEST_EMPLOYEE_NAME,
    email: `wfh.test.${suffix}@example.com`,
    password: "TestPassword123!",
    role: "employee",
    employeeId: `WFH${suffix}`,
    department: "Engineering",
    position: "Tester",
    joinDate: new Date(),
    company: company._id,
    status: "active",
    isActive: true,
  });

  // The auth middleware reads `id` off the decoded payload.
  const employeeToken = generateToken({ id: String(employee._id) });
  const adminToken = generateToken({ id: String(admin._id) });
  /** Ids created by this run, for the assertions that reference them. */
  const createdIds = [];
  /**
   * Leave the forced rule runs raised for OTHER employees.
   *
   * A run is company-wide by design, so exercising it charges every real
   * employee who has no attendance on that day. The response names each record
   * it wrote, so the test removes exactly what it caused and nothing else.
   */
  const collateralLeaveIds = [];
  const collectCollateral = (report) => {
    (report?.marked || []).forEach((m) => {
      if (m.leaveId && m.employeeId !== employee.employeeId) {
        collateralLeaveIds.push(m.leaveId);
      }
    });
  };

  try {
    // -- 1. Submit ---------------------------------------------------------
    section("1. Employee submits a request");
    // Monday and Tuesday: both working days, so every count below is stable.
    const start = nextMonday(3);
    const end = new Date(
      new Date(`${start}T00:00:00Z`).getTime() + 86400000
    )
      .toISOString()
      .slice(0, 10);

    const submitted = await request("POST", "/api/work-from-home", employeeToken, {
      startDate: start,
      endDate: end,
      reason: "Fibre engineer visiting the flat",
      note: "Reachable on Slack all day",
    });
    check("returns 201", submitted.status === 201, `got ${submitted.status}`);
    check("status is pending", submitted.body?.request?.status === "pending");
    check("day count is 2", submitted.body?.request?.totalDays === 2);
    const requestId = submitted.body?.request?._id;
    if (requestId) createdIds.push(requestId);

    // -- 2. Guards ---------------------------------------------------------
    section("2. Guards");
    // A recent past date is NOT rejected - backdating inside the policy window
    // is deliberate, and section 12 covers it. What must be refused is a date
    // older than the window.
    const tooFarBack = await request("POST", "/api/work-from-home", employeeToken, {
      startDate: dayFromNow(-400),
      reason: "Last year",
    });
    check(
      "a date older than the backdating window is rejected",
      tooFarBack.status === 400,
      `got ${tooFarBack.status}`
    );

    const overlap = await request("POST", "/api/work-from-home", employeeToken, {
      startDate: start,
      reason: "Same day again",
    });
    check(
      "an overlapping request is rejected",
      overlap.status === 400,
      overlap.body?.message
    );

    const noReason = await request("POST", "/api/work-from-home", employeeToken, {
      startDate: dayFromNow(20),
    });
    check("a missing reason is rejected", noReason.status === 400);

    const employeeReview = await request(
      "PUT",
      `/api/work-from-home/${requestId}/review`,
      employeeToken,
      { status: "approved" }
    );
    check(
      "an employee cannot review",
      employeeReview.status === 403,
      `got ${employeeReview.status}`
    );

    // -- 3. Admin sees it --------------------------------------------------
    section("3. Admin queue");
    const queue = await request(
      "GET",
      "/api/work-from-home?status=pending",
      adminToken
    );
    check("admin can list", queue.status === 200);
    const inQueue = (queue.body?.requests || []).find(
      (r) => r._id === requestId
    );
    check("the request is in the admin queue", !!inQueue);
    check(
      "the employee is populated for the reviewer",
      inQueue?.employee?.name === TEST_EMPLOYEE_NAME
    );
    check("reason is visible", inQueue?.reason?.includes("Fibre engineer"));

    const employeeList = await request("GET", "/api/work-from-home", employeeToken);
    check(
      "an employee sees only their own",
      (employeeList.body?.requests || []).every(
        (r) => String(r.employee?._id || r.employee) === String(employee._id)
      )
    );

    // -- 4. Approve, with the socket listening ------------------------------
    section("4. Approval and notification");
    const socket = io(BASE_URL, {
      auth: { token: employeeToken },
      transports: ["websocket"],
    });
    const received = { notification: null, reviewed: null };

    await new Promise((resolve, reject) => {
      socket.on("connect", resolve);
      socket.on("connect_error", reject);
      setTimeout(() => reject(new Error("socket connect timeout")), 8000);
    });
    check("employee socket connected", socket.connected);

    socket.on("notification:new", (n) => {
      if (/^(wfh_|leave_auto_)/.test(n?.type || "")) received.notification = n;
    });
    socket.on("wfh:reviewed", (p) => {
      received.reviewed = p;
    });

    const approved = await request(
      "PUT",
      `/api/work-from-home/${requestId}/review`,
      adminToken,
      { status: "approved", reviewComments: "Approved, keep Slack on" }
    );
    check("review returns 200", approved.status === 200, approved.body?.message);
    check("status is approved", approved.body?.request?.status === "approved");
    check("reviewer recorded", !!approved.body?.request?.reviewedBy);

    // Give the socket a moment to deliver.
    await new Promise((r) => setTimeout(r, 1200));

    check(
      "wfh:reviewed reached the employee socket",
      received.reviewed?.status === "approved",
      JSON.stringify(received.reviewed)
    );
    check(
      "notification:new reached the employee socket",
      received.notification?.type === "wfh_approved",
      JSON.stringify(received.notification)
    );

    const stored = await Notification.findOne({
      recipient: employee._id,
      type: "wfh_approved",
    }).lean();
    check("an in-app notification row was written", !!stored);
    check("it references the request", String(stored?.wfhId) === String(requestId));
    check(
      "the copy says the leave balance is untouched",
      /leave balance/i.test(stored?.message || "")
    );

    const alreadyReviewed = await request(
      "PUT",
      `/api/work-from-home/${requestId}/review`,
      adminToken,
      { status: "rejected" }
    );
    check(
      "a decided request cannot be reviewed twice",
      alreadyReviewed.status === 404
    );

    // -- 5. Attendance and work mode ---------------------------------------
    section("5. Attendance reports the day as work from home");
    const schedule = await request(
      "GET",
      `/api/work-from-home/schedule?startDate=${start}&endDate=${end}`,
      adminToken
    );
    check("schedule endpoint responds", schedule.status === 200);
    check(
      "the approved days are in the schedule",
      schedule.body?.schedule?.[String(employee._id)]?.[start] ===
        "work_from_home",
      JSON.stringify(schedule.body?.schedule)
    );

    const attendance = await request(
      "GET",
      `/api/attendance/db/frontend/${employee.employeeId}?startDate=${start}&endDate=${end}`,
      adminToken
    );
    check("attendance read responds", attendance.status === 200);
    const workModes = attendance.body?.workModes || {};
    check(
      "the day carries work_from_home",
      workModes[start] === "work_from_home",
      JSON.stringify(workModes)
    );

    const summary = attendance.body?.summary || {};
    const workingDaysInRange = [start, end].filter((d) => {
      const day = new Date(`${d}T00:00:00Z`).getUTCDay();
      return day !== 0 && day !== 6;
    }).length;
    check(
      "wfhDays counts the approved working days",
      summary.wfhDays === workingDaysInRange,
      `wfhDays=${summary.wfhDays}, expected ${workingDaysInRange}`
    );
    check(
      "those days are NOT counted as absent",
      summary.absentDays === 0,
      `absentDays=${summary.absentDays}`
    );
    check(
      "attendedDays includes the WFH days",
      summary.attendedDays === workingDaysInRange,
      `attendedDays=${summary.attendedDays}`
    );

    // -- 6. The leave balance is untouched ---------------------------------
    section("6. Leave balance untouched");
    const balance = await request("GET", "/api/leaves/balance", employeeToken);
    check("balance endpoint responds", balance.status === 200);
    const bal = balance.body?.balance || {};
    const usedTotal = ["annual", "sick", "casual"].reduce(
      (sum, type) => sum + (bal[type]?.used || 0),
      0
    );
    check(
      "no leave days were consumed by the approved WFH",
      usedTotal === 0,
      `used total = ${usedTotal}`
    );

    // -- 7. Rejection path -------------------------------------------------
    section("7. Rejection path");
    const second = await request("POST", "/api/work-from-home", employeeToken, {
      startDate: dayFromNow(10),
      reason: "Deliveries",
    });
    const secondId = second.body?.request?._id;
    if (secondId) createdIds.push(secondId);

    received.notification = null;
    const rejected = await request(
      "PUT",
      `/api/work-from-home/${secondId}/review`,
      adminToken,
      { status: "rejected", reviewComments: "Team on-site day" }
    );
    check("rejection returns 200", rejected.status === 200);
    check("status is rejected", rejected.body?.request?.status === "rejected");

    await new Promise((r) => setTimeout(r, 1200));
    check(
      "the employee is notified of the rejection",
      received.notification?.type === "wfh_rejected",
      JSON.stringify(received.notification)
    );

    const rejectedSchedule = await request(
      "GET",
      `/api/work-from-home/schedule?startDate=${dayFromNow(
        10
      )}&endDate=${dayFromNow(10)}`,
      adminToken
    );
    check(
      "a rejected request grants no work from home day",
      !rejectedSchedule.body?.schedule?.[String(employee._id)],
      JSON.stringify(rejectedSchedule.body?.schedule)
    );

    // -- 8. Withdrawal -----------------------------------------------------
    section("8. Employee withdraws a pending request");
    const third = await request("POST", "/api/work-from-home", employeeToken, {
      startDate: dayFromNow(15),
      reason: "Plumber",
    });
    const thirdId = third.body?.request?._id;
    if (thirdId) createdIds.push(thirdId);

    const cancelled = await request(
      "PUT",
      `/api/work-from-home/${thirdId}/cancel`,
      employeeToken
    );
    check("withdrawal returns 200", cancelled.status === 200);
    check("status is cancelled", cancelled.body?.request?.status === "cancelled");

    const cancelAgain = await request(
      "PUT",
      `/api/work-from-home/${thirdId}/cancel`,
      employeeToken
    );
    check("a cancelled request cannot be cancelled twice", cancelAgain.status === 404);

    // -- 9. Stats ----------------------------------------------------------
    section("9. Counts");
    const stats = await request("GET", "/api/work-from-home/stats", employeeToken);
    check("stats respond", stats.status === 200);
    check("one approved", stats.body?.approved === 1, JSON.stringify(stats.body));
    check("one rejected", stats.body?.rejected === 1);
    check("one cancelled", stats.body?.cancelled === 1);

    // -- 10. Workforce split ------------------------------------------------
    section("10. Dashboard work mode split");
    const statusSummary = await request(
      "GET",
      `/api/attendance/db/status-summary?startDate=${start}&endDate=${end}`,
      adminToken
    );
    check("status summary responds", statusSummary.status === 200);
    check(
      "it reports a work from home count",
      typeof statusSummary.body?.workFromHome === "number",
      JSON.stringify(statusSummary.body)
    );
    check(
      "it reports an on leave count",
      typeof statusSummary.body?.onLeave === "number"
    );

    // -- 11. Office days, and precedence over a punch ----------------------
    section("11. Office days alongside work from home");

    // Two working days: one with a punch and no schedule (office), one that is
    // both approved as WFH and punched (the approval wins).
    const officeDay = weekdaysAgo(1);
    const punchedWfhDay = start;
    for (const day of [officeDay, punchedWfhDay]) {
      await AttendanceLog.create({
        machineIp: "127.0.0.1",
        company: company._id,
        employeeId: employee.employeeId,
        machineUserId: employee.employeeId,
        timestamp: new Date(`${day}T03:55:00.000Z`), // 08:55 in Asia/Karachi
        date: day,
        type: "check-in",
        state: 1,
      });
    }

    const withPunches = await request(
      "GET",
      `/api/attendance/db/frontend/${employee.employeeId}?startDate=${officeDay}&endDate=${end}`,
      adminToken
    );
    const modes = withPunches.body?.workModes || {};
    const records = withPunches.body?.records || [];
    const officeRecord = records.find((r) => r.date === officeDay);
    const wfhRecord = records.find((r) => r.date === punchedWfhDay);

    check(
      "a punched day with no schedule is office",
      officeRecord?.workMode === "office",
      JSON.stringify(officeRecord?.workMode)
    );
    check(
      "an approved WFH day stays work_from_home even when punched",
      wfhRecord?.workMode === "work_from_home",
      JSON.stringify(wfhRecord?.workMode)
    );
    check(
      "the schedule still reports the WFH day",
      modes[punchedWfhDay] === "work_from_home"
    );

    const withPunchSummary = withPunches.body?.summary || {};
    const counts = withPunches.body?.workModeCounts || {};
    const workingDays = withPunchSummary.totalDays || 0;
    check(
      "the four modes add up to the working days in the range",
      (counts.office || 0) +
        (counts.work_from_home || 0) +
        (counts.on_leave || 0) +
        (counts.absent || 0) ===
        workingDays,
      JSON.stringify(counts)
    );
    check(
      "a punched day counts as an office day",
      (counts.office || 0) >= 1,
      JSON.stringify(counts)
    );

    // -- 12. Backdating: "I worked from home and forgot to tell you" -------
    section("12. Backdated request corrects a day already recorded absent");

    const policyRes = await request("GET", "/api/work-from-home/policy", employeeToken);
    check("policy endpoint responds", policyRes.status === 200);
    const window = policyRes.body?.policy?.backdatingWindowDays;
    check("it states a backdating window", typeof window === "number", String(window));

    // The most recent weekday strictly before today, which is inside the
    // window and has no punch - so today it reads as absent.
    const pastDay = weekdaysAgo(2);
    const beforeApproval = await request(
      "GET",
      `/api/attendance/db/frontend/${employee.employeeId}?startDate=${pastDay}&endDate=${pastDay}`,
      adminToken
    );
    check(
      "the forgotten day currently reads as absent",
      (beforeApproval.body?.workModeCounts?.absent || 0) === 1,
      JSON.stringify(beforeApproval.body?.workModeCounts)
    );

    const backdated = await request("POST", "/api/work-from-home", employeeToken, {
      startDate: pastDay,
      reason: "Worked from home, forgot to tell you",
    });
    check(
      "a request for a past day inside the window is accepted",
      backdated.status === 201,
      backdated.body?.message
    );
    check("it is flagged as backdated", backdated.body?.request?.isBackdated === true);
    const backdatedId = backdated.body?.request?._id;
    if (backdatedId) createdIds.push(backdatedId);

    const tooOld = await request("POST", "/api/work-from-home", employeeToken, {
      startDate: dayFromNow(-(window + 5)),
      reason: "Far too long ago",
    });
    check(
      "a request beyond the window is refused",
      tooOld.status === 400,
      tooOld.body?.message
    );
    check(
      "the refusal names the earliest date and points at an admin",
      /earliest date|administrator/i.test(tooOld.body?.message || ""),
      tooOld.body?.message
    );

    received.notification = null;
    const backdatedApproval = await request(
      "PUT",
      `/api/work-from-home/${backdatedId}/review`,
      adminToken,
      { status: "approved" }
    );
    check("the admin can approve it", backdatedApproval.status === 200);

    await new Promise((r) => setTimeout(r, 1200));
    check(
      "the employee is notified",
      received.notification?.type === "wfh_approved",
      JSON.stringify(received.notification)
    );

    const afterApproval = await request(
      "GET",
      `/api/attendance/db/frontend/${employee.employeeId}?startDate=${pastDay}&endDate=${pastDay}`,
      adminToken
    );
    check(
      "the day is no longer absent",
      (afterApproval.body?.workModeCounts?.absent || 0) === 0,
      JSON.stringify(afterApproval.body?.workModeCounts)
    );
    check(
      "the day now reads as work from home",
      afterApproval.body?.workModes?.[pastDay] === "work_from_home",
      JSON.stringify(afterApproval.body?.workModes)
    );
    check(
      "the attendance record was corrected retroactively",
      (afterApproval.body?.summary?.wfhDays || 0) === 1 &&
        (afterApproval.body?.summary?.attendedDays || 0) === 1,
      JSON.stringify(afterApproval.body?.summary)
    );

    // -- 13. The 2 PM rule: silence becomes leave --------------------------
    section("13. Unreported absence becomes annual leave");

    const policyGet = await request(
      "GET",
      "/api/unreported-absence/policy",
      adminToken
    );
    check("the rule has a policy", policyGet.status === 200);
    check(
      "its cutoff defaults to 14:00",
      policyGet.body?.policy?.cutoffTime === "14:00",
      JSON.stringify(policyGet.body?.policy)
    );
    check(
      "it charges annual leave",
      policyGet.body?.policy?.leaveType === "annual"
    );

    // A working day this employee neither punched on nor accounted for.
    const silentDay = weekdaysAgo(3);

    const preview = await request(
      "GET",
      `/api/unreported-absence/preview?date=${silentDay}&force=true`,
      adminToken
    );
    check("preview responds", preview.status === 200);
    const previewed = (preview.body?.marked || []).find(
      (m) => m.employeeId === employee.employeeId
    );
    check("it would charge the silent employee", !!previewed);
    check("as annual leave", previewed?.leaveType === "annual", previewed?.leaveType);
    check(
      "with a reason naming the cutoff and the missing notice",
      /before 14:00/.test(previewed?.reason || "") &&
        /no work from home or leave request/i.test(previewed?.reason || ""),
      previewed?.reason
    );
    check(
      "a dry run writes nothing",
      (await Leave.countDocuments({ employee: employee._id })) === 0
    );

    received.notification = null;
    const run = await request("POST", "/api/unreported-absence/run", adminToken, {
      date: silentDay,
      force: true,
    });
    check("the run succeeds", run.status === 200, run.body?.message);
    collectCollateral(run.body);

    const autoLeave = await Leave.findOne({
      employee: employee._id,
      isAutoMarked: true,
    }).lean();
    check("a leave record was created", !!autoLeave);
    check("it is annual leave", autoLeave?.leaveType === "annual");
    check("it is approved, so it counts", autoLeave?.status === "approved");
    check("it is flagged as automatic", autoLeave?.isAutoMarked === true);
    check(
      "its source is recorded",
      autoLeave?.autoMarkSource === "unreported_absence"
    );
    check(
      "the reason explains no information was given",
      /no attendance recorded and no work from home or leave request received before 14:00/i.test(
        autoLeave?.reason || ""
      ),
      autoLeave?.reason
    );

    await new Promise((r) => setTimeout(r, 1200));
    check(
      "the employee is notified it happened",
      received.notification?.type === "leave_auto_marked",
      JSON.stringify(received.notification)
    );

    const secondRun = await request(
      "POST",
      "/api/unreported-absence/run",
      adminToken,
      { date: silentDay, force: true }
    );
    collectCollateral(secondRun.body);
    check(
      "re-running charges nobody twice",
      (secondRun.body?.marked || []).every(
        (m) => m.employeeId !== employee.employeeId
      ),
      JSON.stringify(secondRun.body?.marked)
    );
    check(
      "and says why it skipped them",
      (secondRun.body?.skipped || []).some(
        (sk) =>
          sk.employeeId === employee.employeeId &&
          /already recorded/i.test(sk.reason)
      ),
      JSON.stringify(secondRun.body?.skipped)
    );

    const balanceAfterAutoMark = await request(
      "GET",
      "/api/leaves/balance",
      employeeToken
    );
    check(
      "the day came out of the annual balance",
      (balanceAfterAutoMark.body?.balance?.annual?.used || 0) === 1,
      JSON.stringify(balanceAfterAutoMark.body?.balance?.annual)
    );

    const autoRecords = await request(
      "GET",
      "/api/unreported-absence/records",
      employeeToken
    );
    check(
      "the employee can see what the rule recorded",
      (autoRecords.body?.records || []).length === 1,
      JSON.stringify(autoRecords.body?.total)
    );

    // -- 14. Correcting it: "I was working from home that day" -------------
    section("14. A backdated WFH request reverses the charge");

    const correction = await request("POST", "/api/work-from-home", employeeToken, {
      startDate: silentDay,
      reason: "I was working from home, sorry for the late notice",
    });
    check(
      "the auto-marked leave does not block the correction",
      correction.status === 201,
      correction.body?.message
    );
    const correctionId = correction.body?.request?._id;
    if (correctionId) createdIds.push(correctionId);

    received.notification = null;
    const correctionApproval = await request(
      "PUT",
      `/api/work-from-home/${correctionId}/review`,
      adminToken,
      { status: "approved" }
    );
    check("the admin approves it", correctionApproval.status === 200);
    check(
      "the response reports the returned day",
      correctionApproval.body?.reversedLeave?.days === 1,
      JSON.stringify(correctionApproval.body?.reversedLeave)
    );

    check(
      "the automatic leave record is gone",
      (await Leave.countDocuments({
        employee: employee._id,
        isAutoMarked: true,
      })) === 0
    );

    const balanceAfterReversal = await request(
      "GET",
      "/api/leaves/balance",
      employeeToken
    );
    check(
      "the annual day was returned to the balance",
      (balanceAfterReversal.body?.balance?.annual?.used || 0) === 0,
      JSON.stringify(balanceAfterReversal.body?.balance?.annual)
    );

    const correctedDay = await request(
      "GET",
      `/api/attendance/db/frontend/${employee.employeeId}?startDate=${silentDay}&endDate=${silentDay}`,
      adminToken
    );
    check(
      "the day now reads as work from home",
      correctedDay.body?.workModes?.[silentDay] === "work_from_home",
      JSON.stringify(correctedDay.body?.workModes)
    );

    // -- 15. The rule leaves accounted-for people alone --------------------
    section("15. The rule only charges silence");

    const accountedRun = await request(
      "POST",
      "/api/unreported-absence/run",
      adminToken,
      { date: silentDay, force: true }
    );
    collectCollateral(accountedRun.body);
    const skipped = (accountedRun.body?.skipped || []).find(
      (sk) => sk.employeeId === employee.employeeId
    );
    check(
      "someone with an approved WFH day is skipped",
      /work from home/i.test(skipped?.reason || ""),
      JSON.stringify(skipped)
    );

    const punchedRun = await request(
      "POST",
      "/api/unreported-absence/run",
      adminToken,
      { date: officeDay, force: true }
    );
    collectCollateral(punchedRun.body);
    const punchedSkip = (punchedRun.body?.skipped || []).find(
      (sk) => sk.employeeId === employee.employeeId
    );
    check(
      "someone who punched in is skipped",
      /attendance recorded/i.test(punchedSkip?.reason || ""),
      JSON.stringify(punchedSkip)
    );

    const weekendRun = await request(
      "POST",
      "/api/unreported-absence/run",
      adminToken,
      { date: nextSaturday(), force: true }
    );
    check(
      "a weekend charges nobody",
      weekendRun.body?.ran === false &&
        /working day/i.test(weekendRun.body?.reason || ""),
      JSON.stringify(weekendRun.body?.reason)
    );

    socket.disconnect();
  } finally {
    if (collateralLeaveIds.length) {
      await Notification.deleteMany({ leaveId: { $in: collateralLeaveIds } });
      await Leave.deleteMany({ _id: { $in: collateralLeaveIds } });
      console.log(
        `\nCleaned ${collateralLeaveIds.length} leave record(s) the forced runs raised for other employees.`
      );
    }
    await sweepTestData();
    await mongoose.disconnect();
  }

  console.log(`\n${passed} passed, ${failed} failed`);
  process.exit(failed === 0 ? 0 : 1);
}

main().catch(async (error) => {
  console.error("\nTest run failed:", error);
  try {
    await mongoose.disconnect();
  } catch {
    /* already closed */
  }
  process.exit(1);
});
