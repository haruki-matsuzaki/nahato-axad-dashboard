import assert from "node:assert/strict";
import { evaluateHealth } from "../cloudflare/update-monitor.js";
import { buildExternalMonitorAlertMessage } from "./automation-alert-message.mjs";

const now = new Date("2026-07-10T04:30:00.000Z");
const updateStatus = {
  generatedAt: "2026-07-10T03:10:00.000Z",
  daily: { status: "ok", checkedAt: "2026-07-10T03:10:00.000Z", month: "2026-07" },
};
const index = { months: [{ id: "2026-07", path: "data/2026-07.json" }] };
const qualityStatus = { status: "ok" };
const monthData = {
  source: { generatedAt: "2026-07-10T03:10:00.000Z" },
  records: [
    { date: "2026-07-09", project: "案件A", media: "全体", sales: 100000, grossProfit: 20000, cost: 80000, cv: 10 },
  ],
};
const overallSales = {
  source: { overallRowsSyncedAt: "2026-07-10T03:10:00.000Z" },
  rows: [
    { index: 3, cells: [{ address: "T3", text: "7/9", value: "7/9" }] },
    { index: 5, cells: [{ address: "J5", text: "売上", value: "売上" }, { address: "T5", text: "¥90,000", value: 90000 }] },
    { index: 6, cells: [{ address: "J6", text: "粗利", value: "粗利" }, { address: "T6", text: "¥18,000", value: 18000 }] },
    { index: 7, cells: [{ address: "J7", text: "消化金額", value: "消化金額" }, { address: "T7", text: "¥72,000", value: 72000 }] },
  ],
};

const healthy = evaluateHealth({ now, index, updateStatus, qualityStatus, monthData, overallSales });
assert.equal(healthy.status, "ok");
assert.equal(healthy.detail.projects, 1);
assert.equal(healthy.overallSales.sales, 90000);

const missingOverall = evaluateHealth({ now, index, updateStatus, qualityStatus, monthData, overallSales: { rows: [] } });
assert.equal(missingOverall.status, "error");
assert.ok(missingOverall.issues.includes("overall_sales_previous_day_missing"));
const missingOverallAlert = buildExternalMonitorAlertMessage(missingOverall);
assert.match(missingOverallAlert.body, /【何が起きたか】/);
assert.match(missingOverallAlert.body, /案件別日時には前日分がありますが、全体売上表には前日分がありません/);
assert.match(missingOverallAlert.body, /元シートの「◆全体売上表」/);
assert.match(missingOverallAlert.body, /検知コード: overall_sales_previous_day_missing/);

const missingBoth = evaluateHealth({
  now,
  index,
  updateStatus,
  qualityStatus,
  monthData: { records: [] },
  overallSales: { rows: [] },
});
assert.equal(missingBoth.status, "error");
assert.ok(missingBoth.issues.includes("previous_day_missing_from_both_sources"));
const missingBothAlert = buildExternalMonitorAlertMessage(missingBoth);
assert.match(missingBothAlert.body, /案件別日時と全体売上表の両方で確認できません/);

console.log("external monitor tests ok");
