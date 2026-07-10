import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import { auditSourceValues } from "./audit-source-sheet.mjs";

const month = "2026-07";
const out = "/tmp/nacht-source-audit-test.json";
const index = "/tmp/nacht-source-audit-index.json";
const detailValues = readJson("scripts/fixtures/nacht-media-only-project-values.json");
const totalValues = readJson("scripts/fixtures/nacht-total-missing-project-values.json");

execFileSync(
  process.execPath,
  [
    "scripts/update-data.mjs",
    "--fixture",
    "scripts/fixtures/nacht-media-only-project-values.json",
    "--totalFixture",
    "scripts/fixtures/nacht-total-missing-project-values.json",
    "--month",
    month,
    "--out",
    out,
    "--index",
    index,
  ],
  { stdio: "pipe" },
);

const generatedData = readJson(out);
const matching = runAudit(generatedData);
assert.equal(matching.status, "ok", JSON.stringify(matching.issues));
assert.equal(matching.sourceFingerprint, matching.generatedFingerprint);
assert.equal(matching.summary.sourceKeys, matching.summary.generatedKeys);
assert.ok(matching.summary.verifiedMetrics > 0);

const missingRecordData = structuredClone(generatedData);
missingRecordData.records = missingRecordData.records.filter(
  (record) => !(record.project === "ベビーパーク" && record.media === "TikTok" && record.date === "2026-07-02"),
);
const missing = runAudit(missingRecordData);
assert.equal(missing.status, "error");
assert.equal(missing.summary.missingKeys, 1);

const changedValueData = structuredClone(generatedData);
const changedRecord = changedValueData.records.find(
  (record) => record.project === "ベビーパーク" && record.media === "TikTok" && record.date === "2026-07-02",
);
assert.ok(changedRecord);
changedRecord.sales += 1000;
const changed = runAudit(changedValueData);
assert.equal(changed.status, "error");
assert.equal(changed.summary.valueMismatches, 1);
assert.equal(changed.issues.mismatches[0].metric, "sales");

const missingMetricValues = structuredClone(detailValues);
const mediaHeaderIndex = missingMetricValues.findIndex((row) => row.includes("TikTok") && row.includes("合計"));
const countRow = missingMetricValues
  .slice(mediaHeaderIndex + 1, mediaHeaderIndex + 10)
  .find((row) => row.includes("件数"));
assert.ok(mediaHeaderIndex >= 0);
assert.ok(countRow);
countRow[countRow.indexOf("件数")] = "";
const missingMetric = auditSourceValues({
  month,
  spreadsheetId: "fixture",
  detailValues: missingMetricValues,
  totalValues,
  generatedData,
});
assert.equal(missingMetric.status, "error");
assert.ok(missingMetric.issues.structure.some((issue) => issue.type === "missing_metric_rows"));

console.log(
  `Source audit fixture passed: ${matching.summary.sourceProjects} projects, ${matching.summary.sourceKeys} keys, ${matching.summary.verifiedMetrics} metrics verified`,
);

function runAudit(data) {
  return auditSourceValues({
    month,
    spreadsheetId: "fixture",
    detailValues,
    totalValues,
    generatedData: data,
  });
}

function readJson(filePath) {
  return JSON.parse(fs.readFileSync(filePath, "utf8"));
}
