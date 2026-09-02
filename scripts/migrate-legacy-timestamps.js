/**
 * migrate-legacy-timestamps.js
 * ----------------------------
 * Gives the legacy CSV-imported attendance rows a real Date `timestamp`.
 *
 * Those rows store their time as a STRING ("Sat Jun 27 2020 09:40:19 GMT+0500").
 * Mongo compares strings lexically, so a date range on that field returns the
 * wrong set - which is why every read had to pull the rows back and filter them
 * in JS. With a real Date they are served by the existing {timestamp:1} index
 * like every other row, and the read stops touching them at all.
 *
 * Additive and idempotent: it only ever $sets `timestamp` and `date` on rows
 * that lack `timestamp`, and never edits the original "Timestamp" string, so
 * the source of truth is preserved and a re-run is a no-op.
 *
 *   node scripts/migrate-legacy-timestamps.js [--dry-run]
 */

require("dotenv").config();
const mongoose = require("mongoose");
const { localDateString } = require("../utils/timezone");

const dryRun = process.argv.includes("--dry-run");
const BATCH = 1000;

async function main() {
  const uri = process.env.MONGODB_URI;
  if (!uri) {
    console.error("MONGODB_URI is not set.");
    process.exit(1);
  }

  await mongoose.connect(uri, { serverSelectionTimeoutMS: 20000 });
  const collection = mongoose.connection.db.collection("attendancelogs");
  console.error(`Database: ${mongoose.connection.db.databaseName}`);

  const pending = await collection.countDocuments({
    Timestamp: { $exists: true },
    timestamp: { $exists: false },
  });
  console.error(`Legacy rows without a Date timestamp: ${pending}`);

  if (pending === 0) {
    console.error("Nothing to migrate.");
    await mongoose.disconnect();
    return;
  }

  const cursor = collection.find(
    { Timestamp: { $exists: true }, timestamp: { $exists: false } },
    { projection: { Timestamp: 1 } }
  );

  let writes = [];
  let converted = 0;
  let unparseable = 0;

  const flush = async () => {
    if (!writes.length || dryRun) {
      writes = [];
      return;
    }
    await collection.bulkWrite(writes, { ordered: false });
    writes = [];
  };

  while (await cursor.hasNext()) {
    const doc = await cursor.next();
    const parsed = new Date(doc.Timestamp);

    // A row whose string will not parse cannot be indexed, and guessing a date
    // for it would be worse than leaving it on the JS-filtered path.
    if (Number.isNaN(parsed.getTime())) {
      unparseable += 1;
      continue;
    }

    writes.push({
      updateOne: {
        filter: { _id: doc._id },
        update: {
          $set: { timestamp: parsed, date: localDateString(parsed) },
        },
      },
    });
    converted += 1;

    if (writes.length >= BATCH) {
      await flush();
      process.stderr.write(`\r  ${converted}/${pending} converted`);
    }
  }

  await flush();
  console.error(`\r  ${converted}/${pending} converted`);

  if (unparseable) {
    console.error(`${unparseable} row(s) had an unreadable Timestamp and were left alone.`);
  }

  if (dryRun) {
    console.error("Dry run - nothing was written.");
  } else {
    const remaining = await collection.countDocuments({
      Timestamp: { $exists: true },
      timestamp: { $exists: false },
    });
    console.error(`Legacy rows still without a Date timestamp: ${remaining}`);
  }

  await mongoose.disconnect();
}

main().catch((error) => {
  console.error("Migration failed:", error.message);
  process.exit(1);
});
