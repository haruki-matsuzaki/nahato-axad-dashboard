import fs from "node:fs/promises";
import { execFileSync } from "node:child_process";
import path from "node:path";
import process from "node:process";

const root = process.cwd();
const args = parseArgs(process.argv.slice(2));
const qualityStartMonth = args.qualityStartMonth || process.env.DATA_QUALITY_START_MONTH || "2026-02";
const allowDrops = toBoolean(args.allowDrops || process.env.DATA_QUALITY_ALLOW_DROPS);
const failOnError = toBoolean(args.failOnError);
const writeStatusPath = args.writeStatus || "";
const maxItemsPerMonth = Number(args.maxItemsPerMonth || process.env.DATA_QUALITY_MAX_ITEMS || 12);

const index = await readJson("data/index.json");
const report = {
  generatedAt: new Date().toISOString(),
  status: "ok",
  qualityStartMonth,
  summary: {
    checkedMonths: 0,
    monthsWithErrors: 0,
    monthsWithWarnings: 0,
    errorCount: 0,
    warningCount: 0,
  },
  errors: [],
  warnings: [],
  months: [],
};

for (const month of index.months || []) {
  const monthReport = await checkMonth(month);
  if (!monthReport) continue;
  report.months.push(monthReport);
  report.summary.checkedMonths += 1;
  report.summary.errorCount += monthReport.errors.length;
  report.summary.warningCount += monthReport.warnings.length;
  if (monthReport.errors.length) report.summary.monthsWithErrors += 1;
  if (monthReport.warnings.length) report.summary.monthsWithWarnings += 1;
  report.errors.push(...monthReport.errors);
  report.warnings.push(...monthReport.warnings);
}

if (report.summary.errorCount) {
  report.status = "error";
} else if (report.summary.warningCount) {
  report.status = "warning";
}

if (writeStatusPath) {
  await writeJson(writeStatusPath, report);
}

console.log(
  JSON.stringify(
    {
      status: report.status,
      checkedMonths: report.summary.checkedMonths,
      errors: report.summary.errorCount,
      warnings: report.summary.warningCount,
      statusPath: writeStatusPath || null,
    },
    null,
    2,
  ),
);

if (failOnError && report.status === "error") {
  process.exitCode = 1;
}

async function checkMonth(month) {
  const data = await readJson(month.path);
  const business = await readOptionalJson(`data/overall-business-sales-${month.id}.json`);
  const monthReport = {
    month: month.id,
    status: "ok",
    errors: [],
    warnings: [],
    checks: {
      missingProjects: 0,
      missingProjectDates: 0,
      totalValueMismatches: 0,
      missingMediaDates: 0,
      mediaValueMismatches: 0,
      previousMissingProjects: 0,
      previousRecordDrop: 0,
      previousProjectDrop: 0,
    },
  };

  if (business) {
    checkBusinessConsistency(month, data, business, monthReport);
  }
  checkPreviousSnapshot(month, data, monthReport);

  if (monthReport.errors.length) {
    monthReport.status = "error";
  } else if (monthReport.warnings.length) {
    monthReport.status = "warning";
  }
  return monthReport;
}

function checkBusinessConsistency(month, data, business, monthReport) {
  const columnIndexes = indexBusinessColumns(business.columns || []);
  if (!columnIndexes) return;

  const expected = aggregateBusinessRows(business.rows || [], columnIndexes);
  const actual = aggregateDataRows(data.records || []);
  const actualProjects = new Set((data.records || []).map((record) => normalize(record.project)));
  const expectedProjects = new Set([...expected.total.keys()].map((key) => key.split("\u0000")[0]));
  const missingProjects = [...expectedProjects].filter((project) => !actualProjects.has(project)).sort(localeSort);
  if (missingProjects.length) {
    monthReport.checks.missingProjects = missingProjects.length;
    pushIssue(monthReport.errors, monthReport, {
      type: "missing_project",
      message: `${month.id}: overall business sales project missing from detail data`,
      count: missingProjects.length,
      examples: missingProjects.slice(0, maxItemsPerMonth),
    });
  }

  if (month.id < qualityStartMonth) return;

  compareCoverage({
    expected: expected.total,
    actual: actual.total,
    metricKeys: ["sales", "grossProfit", "cv"],
    missingType: "missing_project_date",
    mismatchType: "total_value_mismatch",
    missingTarget: monthReport.errors,
    mismatchTarget: monthReport.warnings,
    month,
    monthReport,
    missingCounter: "missingProjectDates",
    mismatchCounter: "totalValueMismatches",
  });

  compareCoverage({
    expected: expected.media,
    actual: actual.media,
    metricKeys: ["sales", "grossProfit", "cv"],
    missingType: "missing_media_date",
    mismatchType: "media_value_mismatch",
    missingTarget: monthReport.warnings,
    mismatchTarget: monthReport.warnings,
    month,
    monthReport,
    missingCounter: "missingMediaDates",
    mismatchCounter: "mediaValueMismatches",
  });
}

function checkPreviousSnapshot(month, data, monthReport) {
  if (allowDrops) return;
  const previous = readGitHeadJson(month.path);
  if (!previous?.records?.length || !data?.records?.length) return;

  const previousProjectTotals = projectTotals(previous.records);
  const currentProjectTotals = projectTotals(data.records);
  const missingProjects = [...previousProjectTotals.entries()]
    .filter(([project, score]) => score !== 0 && !currentProjectTotals.has(project))
    .map(([project]) => project)
    .sort(localeSort);
  if (missingProjects.length) {
    monthReport.checks.previousMissingProjects = missingProjects.length;
    pushIssue(monthReport.errors, monthReport, {
      type: "previous_project_missing",
      message: `${month.id}: project existed in previous snapshot but disappeared`,
      count: missingProjects.length,
      examples: missingProjects.slice(0, maxItemsPerMonth),
    });
  }

  const previousRecordCount = previous.records.length;
  const currentRecordCount = data.records.length;
  if (previousRecordCount >= 50 && currentRecordCount < previousRecordCount * 0.8) {
    monthReport.checks.previousRecordDrop = previousRecordCount - currentRecordCount;
    pushIssue(monthReport.errors, monthReport, {
      type: "previous_record_drop",
      message: `${month.id}: record count dropped more than 20% from previous snapshot`,
      previous: previousRecordCount,
      current: currentRecordCount,
    });
  }

  const previousProjectCount = previousProjectTotals.size;
  const currentProjectCount = currentProjectTotals.size;
  if (previousProjectCount >= 5 && currentProjectCount < previousProjectCount * 0.8) {
    monthReport.checks.previousProjectDrop = previousProjectCount - currentProjectCount;
    pushIssue(monthReport.errors, monthReport, {
      type: "previous_project_drop",
      message: `${month.id}: project count dropped more than 20% from previous snapshot`,
      previous: previousProjectCount,
      current: currentProjectCount,
    });
  }
}

function compareCoverage({
  expected,
  actual,
  metricKeys,
  missingType,
  mismatchType,
  missingTarget,
  mismatchTarget,
  month,
  monthReport,
  missingCounter,
  mismatchCounter,
}) {
  const missing = [];
  const mismatches = [];

  for (const [key, expectedValue] of expected.entries()) {
    const actualValue = actual.get(key);
    if (!actualValue) {
      missing.push({ key, expected: expectedValue });
      continue;
    }
    for (const metric of metricKeys) {
      if (!valuesClose(expectedValue[metric], actualValue[metric], metric)) {
        mismatches.push({
          key,
          metric,
          expected: expectedValue[metric],
          actual: actualValue[metric],
          diff: actualValue[metric] - expectedValue[metric],
        });
        break;
      }
    }
  }

  if (missing.length) {
    monthReport.checks[missingCounter] = missing.length;
    pushIssue(missingTarget, monthReport, {
      type: missingType,
      message: `${month.id}: expected business sales key missing from detail data`,
      count: missing.length,
      examples: missing.slice(0, maxItemsPerMonth).map(formatIssueKey),
    });
  }
  if (mismatches.length) {
    monthReport.checks[mismatchCounter] = mismatches.length;
    pushIssue(mismatchTarget, monthReport, {
      type: mismatchType,
      message: `${month.id}: business sales value differs from detail data`,
      count: mismatches.length,
      examples: mismatches.slice(0, maxItemsPerMonth).map((item) => ({
        ...formatIssueKey(item),
        metric: item.metric,
        expected: item.expected,
        actual: item.actual,
        diff: item.diff,
      })),
    });
  }
}

function aggregateBusinessRows(rows, columnIndexes) {
  const total = new Map();
  const media = new Map();

  for (const row of rows) {
    const values = row.values || [];
    const project = normalize(values[columnIndexes.project]);
    const mediaName = inferBusinessMedia(values, columnIndexes);
    const metric = metricKey(values[columnIndexes.metric]);
    if (!project || !metric) continue;

    for (const dateColumn of columnIndexes.dateColumns) {
      const value = finiteNumber(values[dateColumn.valueIndex]);
      if (!value) continue;
      addMetric(total, `${project}\u0000${dateColumn.date}`, metric, value);
      if (isCheckableMedia(mediaName)) {
        addMetric(media, `${project}\u0000${mediaName}\u0000${dateColumn.date}`, metric, value);
      }
    }
  }

  return { total, media };
}

function aggregateDataRows(records) {
  const total = new Map();
  const media = new Map();

  for (const record of records || []) {
    const project = normalize(record.project);
    if (!project || !record.date) continue;
    const item = {
      sales: finiteNumber(record.sales),
      grossProfit: finiteNumber(record.grossProfit),
      cv: finiteNumber(record.cv),
    };
    if (record.media === "全体") {
      addRecord(total, `${project}\u0000${record.date}`, item);
    } else {
      addRecord(media, `${project}\u0000${canonicalMedia(record.media)}\u0000${record.date}`, item);
    }
  }

  return { total, media };
}

function indexBusinessColumns(columns) {
  const byKey = new Map(columns.map((column, index) => [column.key, index]));
  const required = ["media", "officialName", "metric"];
  if (!required.every((key) => byKey.has(key))) return null;
  const dateColumns = columns
    .map((column, index) => ({ column, index }))
    .filter(({ column }) => /^\d{4}-\d{2}-\d{2}$/.test(column.key))
    .map(({ column, index }) => ({
      date: column.key,
      valueIndex: index,
    }));
  if (!dateColumns.length) return null;
  return {
    media: byKey.get("media"),
    detail: byKey.get("detail"),
    project: byKey.get("officialName"),
    metric: byKey.get("metric"),
    dateColumns,
  };
}

function projectTotals(records) {
  const totals = new Map();
  for (const record of records || []) {
    const project = normalize(record.project);
    if (!project) continue;
    const score =
      Math.abs(finiteNumber(record.sales)) +
      Math.abs(finiteNumber(record.grossProfit)) +
      Math.abs(finiteNumber(record.cost)) +
      Math.abs(finiteNumber(record.cv));
    totals.set(project, (totals.get(project) || 0) + score);
  }
  return totals;
}

function addMetric(map, key, metric, value) {
  const current = map.get(key) || emptyMetrics();
  current[metric] += value;
  map.set(key, current);
}

function addRecord(map, key, record) {
  const current = map.get(key) || emptyMetrics();
  current.sales += record.sales;
  current.grossProfit += record.grossProfit;
  current.cv += record.cv;
  map.set(key, current);
}

function emptyMetrics() {
  return {
    sales: 0,
    grossProfit: 0,
    cv: 0,
  };
}

function pushIssue(target, monthReport, issue) {
  target.push(issue);
}

function formatIssueKey(item) {
  const parts = String(item.key || "").split("\u0000");
  if (parts.length === 2) {
    return {
      project: parts[0],
      date: parts[1],
    };
  }
  return {
    project: parts[0],
    media: parts[1],
    date: parts[2],
  };
}

function valuesClose(expected, actual, metric) {
  const diff = Math.abs(finiteNumber(actual) - finiteNumber(expected));
  if (metric === "cv") return diff < 0.01;
  const scale = Math.max(Math.abs(finiteNumber(expected)), Math.abs(finiteNumber(actual)), 1);
  return diff <= 1000 || diff / scale <= 0.01;
}

function metricKey(value) {
  const label = normalize(value);
  if (label === "売上") return "sales";
  if (["粗利", "利鞘", "利益"].includes(label)) return "grossProfit";
  if (["件数", "CV"].includes(label)) return "cv";
  return "";
}

function isCheckableMedia(media) {
  return new Set(["FB", "TikTok", "YT", "Pangle", "X", "LINE", "YDA", "YSA", "Google", "Microsoft", "YtoL"]).has(
    media,
  );
}

function canonicalMedia(value) {
  const media = normalize(value);
  const lower = media.toLowerCase();
  if (["facebook", "fb", "meta"].includes(lower)) return "FB";
  if (["youtube", "yt"].includes(lower)) return "YT";
  if (lower === "pangle") return "Pangle";
  if (["lap", "line"].includes(lower)) return "LINE";
  if (["yahoo", "yda"].includes(lower)) return "YDA";
  return media;
}

function inferBusinessMedia(values, columnIndexes) {
  const explicit = canonicalMedia(values[columnIndexes.media]);
  if (explicit) return explicit;

  const detail = normalize(values[columnIndexes.detail]).toLowerCase();
  if (detail.includes("facebook") || detail.includes("_fb") || detail.includes("/fb")) return "FB";
  if (detail.includes("tiktok")) return "TikTok";
  if (detail.includes("youtube") || detail.includes("_yt") || detail.includes("/yt")) return "YT";
  if (detail.includes("pangle")) return "Pangle";
  if (detail.includes("line") || detail.includes("lap")) return "LINE";
  if (detail.includes("yahoo") || detail.includes("yda")) return "YDA";
  if (detail.includes("_x") || detail.includes("/x") || detail.endsWith(" x")) return "X";
  return "";
}

function readGitHeadJson(filePath) {
  try {
    const raw = execFileSync("git", ["show", `HEAD:${filePath}`], {
      cwd: root,
      encoding: "utf8",
      stdio: ["ignore", "pipe", "ignore"],
    });
    return JSON.parse(raw);
  } catch {
    return null;
  }
}

async function readJson(filePath) {
  return JSON.parse(await fs.readFile(resolvePath(filePath), "utf8"));
}

async function readOptionalJson(filePath) {
  try {
    return await readJson(filePath);
  } catch (error) {
    if (error.code !== "ENOENT") throw error;
    return null;
  }
}

async function writeJson(filePath, value) {
  const resolvedPath = resolvePath(filePath);
  await fs.mkdir(path.dirname(resolvedPath), { recursive: true });
  await fs.writeFile(resolvedPath, `${JSON.stringify(value, null, 2)}\n`);
}

function resolvePath(filePath) {
  return path.isAbsolute(filePath) ? filePath : path.join(root, filePath);
}

function parseArgs(argv) {
  const parsed = {};
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (!arg.startsWith("--")) continue;
    const key = arg.slice(2);
    const next = argv[index + 1];
    if (!next || next.startsWith("--")) {
      parsed[key] = true;
    } else {
      parsed[key] = next;
      index += 1;
    }
  }
  return parsed;
}

function toBoolean(value) {
  return ["1", "true", "yes", "on"].includes(String(value || "").toLowerCase());
}

function normalize(value) {
  return String(value ?? "").replace(/\s+/g, " ").trim();
}

function finiteNumber(value) {
  const number = Number(value);
  return Number.isFinite(number) ? number : 0;
}

function localeSort(a, b) {
  return String(a).localeCompare(b, "ja");
}
