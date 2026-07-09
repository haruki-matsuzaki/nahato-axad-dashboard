import assert from "node:assert/strict";
import fs from "node:fs";
import { execFileSync } from "node:child_process";

const out = "/tmp/nacht-media-only-project-test.json";
const index = "/tmp/nacht-media-only-project-index.json";

execFileSync(
  process.execPath,
  [
    "scripts/update-data.mjs",
    "--fixture",
    "scripts/fixtures/nacht-media-only-project-values.json",
    "--totalFixture",
    "scripts/fixtures/nacht-total-missing-project-values.json",
    "--month",
    "2026-07",
    "--out",
    out,
    "--index",
    index,
  ],
  { stdio: "pipe" },
);

const parsed = JSON.parse(fs.readFileSync(out, "utf8"));
const babyRecords = parsed.records.filter((record) => record.project === "ベビーパーク");
const babyTotal = babyRecords.find((record) => record.media === "全体" && record.date === "2026-07-02");
const babyMedia = babyRecords.find((record) => record.media === "TikTok" && record.date === "2026-07-02");

assert.ok(parsed.projects.includes("ベビーパーク"), "media-only project should be included in project list");
assert.ok(babyMedia, "media row for media-only project should be retained");
assert.ok(babyTotal, "project total should be synthesized from media rows when total sheet is missing it");
assert.equal(babyTotal.sales, 80000);
assert.equal(babyTotal.grossProfit, 30000);
assert.equal(babyTotal.cost, 50000);
assert.equal(babyTotal.cv, 4);
