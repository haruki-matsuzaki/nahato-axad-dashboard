import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";

import { getMonthBootstrapState, isFirstBusinessDay } from "./jst-business-calendar.mjs";

const saturday = getMonthBootstrapState(new Date("2026-08-01T12:00:00+09:00"));
assert.equal(saturday.active, false, "8/1 must still update the previous month");
assert.equal(saturday.targetMonth, "2026-07");

const sunday = getMonthBootstrapState(new Date("2026-08-02T18:00:00+09:00"));
assert.equal(sunday.active, true, "the new month must wait through the weekend");
assert.equal(sunday.targetMonth, "2026-08");
assert.equal(sunday.readyAtJst, "2026-08-03 15:30 JST");

const beforeCutoff = getMonthBootstrapState(new Date("2026-08-03T15:29:59+09:00"));
assert.equal(beforeCutoff.active, true, "the grace period must remain active before 15:30 JST");

const atCutoff = getMonthBootstrapState(new Date("2026-08-03T15:30:00+09:00"));
assert.equal(atCutoff.active, false, "the grace period must end at 15:30 JST");
assert.equal(isFirstBusinessDay({ year: 2026, month: 8, day: 3 }), true);
assert.equal(isFirstBusinessDay({ year: 2026, month: 8, day: 4 }), false);

const holidayMonth = getMonthBootstrapState(new Date("2027-01-03T18:00:00+09:00"));
assert.equal(holidayMonth.active, true, "Japanese holidays must extend the grace period");
assert.equal(holidayMonth.readyAtJst, "2027-01-04 15:30 JST");

const pendingRun = JSON.parse(
  execFileSync(
    process.execPath,
    [
      "scripts/update-month-from-sources.mjs",
      "--mode",
      "daily",
      "--dryRun",
      "--runDate",
      "2026-08-02T18:00:00+09:00",
    ],
    { cwd: process.cwd(), encoding: "utf8" },
  ),
);
assert.deepEqual(pendingRun.updated, []);
assert.match(pendingRun.skipped, /^month_source_pending_until_2026-08-03 15:30 JST$/);

const pendingMonitor = JSON.parse(
  execFileSync(
    process.execPath,
    ["scripts/monitor-update-schedule.mjs", "--apply", "--runDate", "2026-08-03T12:37:00+09:00"],
    { cwd: process.cwd(), encoding: "utf8" },
  ),
);
assert.equal(pendingMonitor.status, "pending");
assert.equal(pendingMonitor.reason, "month_source_pending");
assert.equal(pendingMonitor.readyAtJst, "2026-08-03 15:30 JST");

console.log("month bootstrap tests ok");
