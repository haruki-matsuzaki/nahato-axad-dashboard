import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { spawnSync } from "node:child_process";

const downloadsDir = "/Users/matsuzakiharuki/Downloads";
const workbookSheet = "◆全体売上表";
const targetMonths = new Set(JSON.parse(readFileSync("data/index.json", "utf8")).months.map((month) => month.id));

const workbooks = readdirSync(downloadsDir)
  .filter((name) => name.endsWith(".xlsx") && name.includes("総合売上管理表"))
  .map((name) => {
    const month = monthIdFromFilename(name);
    return month ? { name, month, path: join(downloadsDir, name) } : null;
  })
  .filter(Boolean)
  .filter((workbook) => targetMonths.has(workbook.month))
  .sort((a, b) => a.month.localeCompare(b.month));

const results = [];

for (const workbook of workbooks) {
  const out = `data/overall-sales-${workbook.month}.json`;
  const result = spawnSync(
    "python3",
    [
      "scripts/extract-overall-sales.py",
      "--xlsx",
      workbook.path,
      "--sheet",
      workbookSheet,
      "--month",
      workbook.month,
      "--start-row",
      "3",
      "--end-row",
      "55",
      "--out",
      out,
    ],
    { encoding: "utf8" },
  );

  if (result.status === 0) {
    results.push({ month: workbook.month, status: "ok", workbook: workbook.name, out });
    continue;
  }

  results.push({
    month: workbook.month,
    status: "failed",
    workbook: workbook.name,
    error: (result.stderr || result.stdout || "").trim(),
  });
}

const ok = results.filter((result) => result.status === "ok");
const failed = results.filter((result) => result.status === "failed");
console.log(JSON.stringify({ ok: ok.length, failed: failed.length, results }, null, 2));

if (failed.length > 0) {
  process.exitCode = 1;
}

function monthIdFromFilename(name) {
  const japaneseMatch = name.match(/(20\d{2})年\s*0?(\d{1,2})月/);
  if (japaneseMatch) return formatMonth(japaneseMatch[1], japaneseMatch[2]);

  const underscoreMatch = name.match(/(20\d{2})_0?(\d{1,2})月/);
  if (underscoreMatch) return formatMonth(underscoreMatch[1], underscoreMatch[2]);

  return null;
}

function formatMonth(year, month) {
  return `${year}-${String(Number(month)).padStart(2, "0")}`;
}
