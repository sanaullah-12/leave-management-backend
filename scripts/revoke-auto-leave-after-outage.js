/**
 * revoke-auto-leave-after-outage.js
 * ---------------------------------
 * Removes leave the unreported absence rule recorded for employees who were in
 * fact present, once the attendance that proves it has arrived.
 *
 * The rule charges a working day as leave when no punch exists by the cutoff.
 * While the attendance feed is down nobody has a punch, so everyone present is
 * charged. When the feed recovers, those punches land after the fact and the
 * leave stays. This revokes it - the same effect as revokeAutoMarkedLeave(),
 * which approving a backdated work-from-home request triggers.
 *
 * Only leave the rule created (isAutoMarked, source unreported_absence) is
 * considered, and only where the employee has a punch on that same day under
 * the same day window the rule uses. Leave anybody applied for is never
 * touched, and an auto-marked day with no punch is reported and kept.
 *
 * Leave balances are computed from approved leave, so removing the record is
 * what returns the day. Every removed document is written to a backup file
 * first so the change can be undone.
 *
 *   node scripts/revoke-auto-leave-after-outage.js 2026-10-01 2026-10-05            (dry run)
 *   node scripts/revoke-auto-leave-after-outage.js 2026-10-01 2026-10-05 --apply
 */

require("dotenv").config();
const fs = require("fs");
const path = require("path");
const mongoose = require("mongoose");
const Leave = require("../models/Leave");
const User = require("../models/User");
const AttendanceLog = require("../models/AttendanceLog");

/**
 * unreportedAbsenceService.AUTO_MARK_SOURCE. Not imported: that module pulls in
 * the socket and notification services, which a one-off script has no use for.
 */
const AUTO_MARK_SOURCE = "unreported_absence";

const args = process.argv.slice(2);
const apply = args.includes("--apply");
const [fromArg, toArg] = args.filter((a) => !a.startsWith("--"));

const ISO_DAY = /^\d{4}-\d{2}-\d{2}$/;

/** The rule's own day window: UTC midnight to the last millisecond. */
const dayStart = (iso) => new Date(`${iso}T00:00:00.000Z`);
const dayEnd = (iso) => new Date(`${iso}T23:59:59.999Z`);
const isoOf = (date) => new Date(date).toISOString().slice(0, 10);

async function main() {
  if (!ISO_DAY.test(fromArg || "") || !ISO_DAY.test(toArg || fromArg || "")) {
    console.error("Usage: node scripts/revoke-auto-leave-after-outage.js FROM [TO] [--apply]");
    process.exit(1);
  }
  const from = fromArg;
  const to = toArg || fromArg;

  const uri = process.env.MONGODB_URI;
  if (!uri) {
    console.error("MONGODB_URI is not set.");
    process.exit(1);
  }
  await mongoose.connect(uri, { serverSelectionTimeoutMS: 15000 });
  console.log(`Connected to ${mongoose.connection.host}/${mongoose.connection.name}`);
  console.log(`${apply ? "APPLYING" : "DRY RUN"} for ${from} .. ${to}\n`);

  const leaves = await Leave.find({
    isAutoMarked: true,
    autoMarkSource: AUTO_MARK_SOURCE,
    status: { $ne: "rejected" },
    startDate: { $lte: dayEnd(to) },
    endDate: { $gte: dayStart(from) },
  })
    .sort({ startDate: 1 })
    .lean();

  if (!leaves.length) {
    console.log("No automatically recorded leave in that range.");
    return;
  }

  const users = await User.find({ _id: { $in: leaves.map((l) => l.employee) } })
    .select("name employeeId")
    .lean();
  const userById = new Map(users.map((u) => [String(u._id), u]));

  const revoke = [];
  const keep = [];

  for (const leave of leaves) {
    const user = userById.get(String(leave.employee));
    const day = isoOf(leave.startDate);
    const row = {
      day,
      employeeId: user?.employeeId || "?",
      name: user?.name || String(leave.employee),
      leaveType: leave.leaveType,
    };

    const punches = user?.employeeId
      ? await AttendanceLog.countDocuments({
          employeeId: user.employeeId,
          timestamp: { $gte: dayStart(day), $lte: dayEnd(isoOf(leave.endDate)) },
        })
      : 0;

    if (punches > 0) revoke.push({ ...row, punches, leave });
    else keep.push(row);
  }

  const print = (rows, extra) =>
    rows.forEach((r) =>
      console.log(
        `  ${r.day}  ${String(r.employeeId).padEnd(8)} ${r.name.padEnd(28)} ${r.leaveType.padEnd(8)} ${extra(r)}`
      )
    );

  console.log(`Present on the day - leave to revoke (${revoke.length}):`);
  print(revoke, (r) => `${r.punches} punch(es)`);
  console.log(`\nNo punch on the day - kept (${keep.length}):`);
  print(keep, () => "");

  if (!apply) {
    console.log("\nDry run: nothing changed. Re-run with --apply to revoke.");
    return;
  }
  if (!revoke.length) return;

  const backupDir = path.join(__dirname, "backups");
  fs.mkdirSync(backupDir, { recursive: true });
  const backupFile = path.join(
    backupDir,
    `revoked-auto-leave-${from}_${to}-${Date.now()}.json`
  );
  fs.writeFileSync(
    backupFile,
    JSON.stringify(revoke.map((r) => r.leave), null, 2)
  );
  console.log(`\nBackup of ${revoke.length} leave record(s): ${backupFile}`);

  const result = await Leave.deleteMany({
    _id: { $in: revoke.map((r) => r.leave._id) },
    isAutoMarked: true,
  });
  console.log(`Revoked ${result.deletedCount} automatically recorded leave day(s).`);
}

main()
  .catch((error) => {
    console.error("Failed:", error.message);
    process.exitCode = 1;
  })
  .finally(() => mongoose.disconnect());
