/**
 * backfill-attendance-state.js
 * ----------------------------
 * Fills in `state` and `mode` on attendance records that were stored without
 * them.
 *
 * Records synced before attendanceReader captured the device's verification
 * byte carry no `state`. attendanceDbService.normalizeLog() reads
 * `doc.state ?? doc.State` first, so those records read back with an undefined
 * state where the 82,668 historically imported ones report 1, 2, 3 or 4. This
 * re-reads the device log and sets the missing values in place.
 *
 * Non-destructive: it only ever $sets state and mode on documents that already
 * exist, matched on the same {machineIp, employeeId, timestamp} triple the
 * unique index uses. Nothing is inserted and nothing is deleted, so it is safe
 * to re-run.
 *
 *   node scripts/backfill-attendance-state.js [ip] [--dry-run]
 */

require("dotenv").config();
const mongoose = require("mongoose");
const { readAttendanceLogs } = require("../services/attendanceReader");

const args = process.argv.slice(2);
const dryRun = args.includes("--dry-run");
const ip = args.find((a) => !a.startsWith("--")) || process.env.ZKTECO_IP || "192.168.1.201";
const port = parseInt(process.env.ZKTECO_PORT || "4370", 10);

/** Mongo caps a single bulkWrite; stay comfortably under it. */
const BATCH = 1000;

async function main() {
  const uri = process.env.MONGODB_URI;
  if (!uri) {
    console.error("MONGODB_URI is not set.");
    process.exit(1);
  }

  await mongoose.connect(uri, { serverSelectionTimeoutMS: 15000 });
  console.log(`Database: ${mongoose.connection.db.databaseName}`);

  const collection = mongoose.connection.db.collection("attendancelogs");

  const missing = await collection.countDocuments({
    machineIp: ip,
    state: { $exists: false },
  });
  console.log(`Records for ${ip} with no state: ${missing}`);

  if (missing === 0) {
    console.log("Nothing to backfill.");
    await mongoose.disconnect();
    return;
  }

  console.log(`Reading the full device log from ${ip}:${port}...`);
  const logs = await readAttendanceLogs(ip, port, null);
  console.log(`Device returned ${logs.length} records`);

  let matched = 0;
  let modified = 0;

  for (let i = 0; i < logs.length; i += BATCH) {
    const operations = logs
      .slice(i, i + BATCH)
      .filter((log) => typeof log.state === "number")
      .map((log) => ({
        updateOne: {
          filter: {
            machineIp: ip,
            employeeId: String(log.userId),
            timestamp: new Date(log.timestamp),
            state: { $exists: false },
          },
          update: { $set: { state: log.state, mode: log.mode } },
        },
      }));

    if (!operations.length) continue;

    if (dryRun) {
      matched += operations.length;
      continue;
    }

    const result = await collection.bulkWrite(operations, { ordered: false });
    matched += result.matchedCount;
    modified += result.modifiedCount;
    process.stdout.write(
      `\r  ${Math.min(i + BATCH, logs.length)}/${logs.length} processed, ${modified} updated`
    );
  }

  console.log(
    dryRun
      ? `\nDry run: ${matched} device records would be applied.`
      : `\nBackfilled ${modified} record(s).`
  );

  const remaining = await collection.countDocuments({
    machineIp: ip,
    state: { $exists: false },
  });
  console.log(`Records still without state: ${remaining}`);

  await mongoose.disconnect();
}

main().catch((error) => {
  console.error("Backfill failed:", error.message);
  process.exit(1);
});
