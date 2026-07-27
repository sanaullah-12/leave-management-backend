/**
 * Normalize leave policy to the current allocation:
 *   Annual 10 · Casual 10 · Sick 8  (Total 28)
 *
 * Safe by default: this is a DRY RUN unless you pass --apply.
 *
 * Usage (from backend/):
 *   node scripts/normalize-leave-policy.js                 # dry run  (company policy)
 *   node scripts/normalize-leave-policy.js --apply         # write company policy
 *   node scripts/normalize-leave-policy.js --with-quotas   # dry run  (company + employee quotas)
 *   node scripts/normalize-leave-policy.js --apply --with-quotas
 *
 * It only touches annual/casual/sick. Maternity, paternity, emergency and all
 * policy flags are left untouched.
 */
require("dotenv").config();
const mongoose = require("mongoose");

const APPLY = process.argv.includes("--apply");
const WITH_QUOTAS = process.argv.includes("--with-quotas");

const TARGET = { annual: 10, casual: 10, sick: 8 };

function resolveConnectionString() {
  const isProd = process.env.NODE_ENV === "production";
  const useProd = process.env.USE_PRODUCTION_DB === "true";
  if (isProd || useProd) {
    if (!process.env.MONGODB_URI) {
      throw new Error("MONGODB_URI is not set but production DB was requested.");
    }
    return process.env.MONGODB_URI;
  }
  return (
    process.env.LOCAL_MONGODB_URI ||
    "mongodb://127.0.0.1:27018/leave-management-dev"
  );
}

(async () => {
  const conn = resolveConnectionString();
  const masked = conn.replace(/\/\/[^:]*:[^@]*@/, "//***:***@");
  console.log(`\n${APPLY ? "🟢 APPLY" : "🔍 DRY RUN"} — leave policy normalize`);
  console.log("📍 DB:", masked);
  console.log("🎯 Target:", TARGET, WITH_QUOTAS ? "(+ employee quotas)" : "");

  await mongoose.connect(conn, { serverSelectionTimeoutMS: 8000 });
  console.log("✅ Connected to:", mongoose.connection.db.databaseName, "\n");

  const Company = require("../models/Company");
  const User = require("../models/User");

  // ---- Companies ----
  const companies = await Company.find({}).select("name leavePolicy").lean();
  console.log(`🏢 Companies: ${companies.length}`);
  companies.forEach((c) => {
    const p = c.leavePolicy || {};
    console.log(
      `   • ${c.name || c._id}: annual=${p.annualLeave} casual=${p.casualLeave} sick=${p.sickLeave}`
    );
  });

  if (APPLY) {
    const res = await Company.updateMany(
      {},
      {
        $set: {
          "leavePolicy.annualLeave": TARGET.annual,
          "leavePolicy.casualLeave": TARGET.casual,
          "leavePolicy.sickLeave": TARGET.sick,
        },
      }
    );
    console.log(`   ↳ ✅ Updated ${res.modifiedCount} company policy record(s).`);
  }

  // ---- Employee quotas (optional) ----
  if (WITH_QUOTAS) {
    const users = await User.countDocuments({});
    const stale = await User.countDocuments({
      $or: [
        { "leaveQuota.annual": { $ne: TARGET.annual } },
        { "leaveQuota.casual": { $ne: TARGET.casual } },
        { "leaveQuota.sick": { $ne: TARGET.sick } },
      ],
    });
    console.log(`\n👤 Users: ${users} (with non-matching core quotas: ${stale})`);

    if (APPLY) {
      const res = await User.updateMany(
        {},
        {
          $set: {
            "leaveQuota.annual": TARGET.annual,
            "leaveQuota.casual": TARGET.casual,
            "leaveQuota.sick": TARGET.sick,
          },
        }
      );
      console.log(`   ↳ ✅ Updated ${res.modifiedCount} user quota record(s).`);
    }
  }

  if (!APPLY) {
    console.log(
      "\nℹ️  Dry run only — nothing was written. Re-run with --apply to save."
    );
  } else {
    console.log("\n🎉 Done.");
  }

  await mongoose.connection.close();
  process.exit(0);
})().catch(async (err) => {
  console.error("❌ Migration failed:", err.message);
  try {
    await mongoose.connection.close();
  } catch {}
  process.exit(1);
});
