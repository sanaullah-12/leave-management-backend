/**
 * Debug script to check UserID vs UID in ZKTeco data
 */

const ZKTecoService = require("./services/zktecoService");

async function checkUserIdVsUid() {
  console.log("🔍 CHECKING USERID VS UID IN ZKTECO DATA");
  console.log("========================================\n");

  const machineIP = "192.168.1.201";

  try {
    const zkService = new ZKTecoService(machineIP, 4370);

    await zkService.connect();
    const users = await zkService.getUsers();
    await zkService.disconnect();

    console.log(`Found ${users.length} users from ZKTeco device\n`);

    console.log("🔍 RAW USER DATA ANALYSIS:");
    console.log("─".repeat(80));
    console.log(
      "Name".padEnd(15) +
        "UID".padEnd(8) +
        "UserID".padEnd(12) +
        "CardNo".padEnd(12) +
        "RawData Keys"
    );
    console.log("─".repeat(80));

    users.slice(0, 10).forEach((user) => {
      const name = (user.name || "Unknown").substring(0, 13).padEnd(15);
      const uid = (user.uid || "N/A").toString().padEnd(8);
      const userId = (user.userId || user.rawData?.userid || "N/A")
        .toString()
        .padEnd(12);
      const cardno = (user.cardno || "N/A").toString().padEnd(12);
      const rawKeys = Object.keys(user.rawData || {}).join(", ");

      console.log(`${name}${uid}${userId}${cardno}${rawKeys}`);
    });

    console.log("\n🎯 KEY FINDINGS:");
    console.log("─".repeat(50));

    const hasUserId = users.some((u) => u.userId || u.rawData?.userid);
    const hasUid = users.some((u) => u.uid);

    console.log(`✅ UID present: ${hasUid ? "Yes" : "No"}`);
    console.log(`✅ UserID present: ${hasUserId ? "Yes" : "No"}`);

    if (hasUserId) {
      console.log("\n📋 UserID values found:");
      users.slice(0, 5).forEach((user) => {
        const userId = user.userId || user.rawData?.userid;
        if (userId) {
          console.log(`  ${user.name}: UserID = ${userId}, UID = ${user.uid}`);
        }
      });
    }
  } catch (error) {
    console.error("❌ Failed to check UserID vs UID:", error);
  }
}

checkUserIdVsUid();
