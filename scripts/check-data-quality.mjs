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
const projectDropRatio = Number(args.projectDropRatio || process.env.DATA_QUALITY_PROJECT_DROP_RATIO || 0.4);
const crossSourceRatioShift = Number(
  args.crossSourceRatioShift || process.env.DATA_QUALITY_CROSS_SOURCE_RATIO_SHIFT || 0.35,
);
const runDate = parseRunDate(args.runDate || process.env.RUN_DATE);
const today = getJstDateParts(runDate);
const todayYmd = formatYmd(today);
const previousDay = addDays(today, -1);
const previousDayYmd = formatYmd(previousDay);
const previousDayMonth = monthId(previousDay);

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
  freshness: null,
};

for (const month of index.months || []) {
  const monthReport = await checkMonth(month);
  if (!monthReport) continue;
  if (monthReport.freshness) {
    report.freshness = monthReport.freshness;
    delete monthReport.freshness;
  }
  report.months.push(monthReport);
  report.summary.checkedMonths += 1;
  report.summary.errorCount += monthReport.errors.length;
  report.summary.warningCount += monthReport.warnings.length;
  if (monthReport.errors.length) report.summary.monthsWithErrors += 1;
  if (monthReport.warnings.length) report.summary.monthsWithWarnings += 1;
  report.errors.push(...monthReport.errors);
  report.warnings.push(...monthReport.warnings);
}

checkIndexFreshness(index, report);

if (report.summary.errorCount) {
  report.status = "error";
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
  const overallSales = await readOptionalJson(`data/overall-sales-${month.id}.json`);
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
      previousDayRecords: 0,
      duplicateRecordKeys: 0,
      outsideMonthDates: 0,
      futureDates: 0,
      previousMissingProjects: 0,
      previousRecordDrop: 0,
      previousProjectDrop: 0,
    },
  };

  if (business) {
    checkBusinessConsistency(month, data, business, monthReport);
  }
  checkRecordIntegrity(month, data, monthReport);
  checkPreviousDayPresence(month, data, monthReport);
  checkCurrentDailyCoverage(month, data, overallSales, monthReport);
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

function checkRecordIntegrity(month, data, monthReport) {
  const checkDetailedIntegrity = month.id >= qualityStartMonth;
  const duplicateKeys = new Map();
  const outsideMonthDates = [];
  const futureDates = [];

  for (const [index, record] of (data.records || []).entries()) {
    const key = `${normalize(record.project)}\u0000${canonicalMedia(record.media)}\u0000${record.date}`;
    duplicateKeys.set(key, (duplicateKeys.get(key) || 0) + 1);

    if (!isYmd(record.date)) continue;
    if (!record.date.startsWith(`${month.id}-`)) {
      outsideMonthDates.push({ index: index + 1, project: record.project, media: record.media, date: record.date });
    } else if (record.date > todayYmd) {
      futureDates.push({ index: index + 1, project: record.project, media: record.media, date: record.date });
    }
  }

  const duplicates = [...duplicateKeys.entries()]
    .filter(([, count]) => count > 1)
    .map(([key, count]) => ({ ...formatIssueKey({ key }), count }));

  if (checkDetailedIntegrity && duplicates.length) {
    monthReport.checks.duplicateRecordKeys = duplicates.length;
    pushIssue(monthReport.warnings, monthReport, {
      type: "duplicate_record_key",
      message: `${month.id}: duplicate project/media/date records found`,
      count: duplicates.length,
      examples: duplicates.slice(0, maxItemsPerMonth),
    });
  }

  if (outsideMonthDates.length) {
    monthReport.checks.outsideMonthDates = outsideMonthDates.length;
    pushIssue(monthReport.errors, monthReport, {
      type: "outside_month_date",
      message: `${month.id}: record date is outside its month file`,
      count: outsideMonthDates.length,
      examples: outsideMonthDates.slice(0, maxItemsPerMonth),
    });
  }

  if (checkDetailedIntegrity && futureDates.length) {
    monthReport.checks.futureDates = futureDates.length;
    pushIssue(monthReport.warnings, monthReport, {
      type: "future_date",
      message: `${month.id}: future-dated records found`,
      count: futureDates.length,
      examples: futureDates.slice(0, maxItemsPerMonth),
    });
  }
}

function checkPreviousDayPresence(month, data, monthReport) {
  if (month.id !== previousDayMonth) return;
  const records = (data.records || []).filter((record) => record.date === previousDayYmd);
  const meaningfulRecords = records.filter(hasRecordValue);
  monthReport.checks.previousDayRecords = meaningfulRecords.length;
  if (!meaningfulRecords.length) {
    pushIssue(monthReport.warnings, monthReport, {
      type: "previous_day_missing",
      message: `${month.id}: previous day data is not present`,
      date: previousDayYmd,
    });
  }
}

function checkCurrentDailyCoverage(month, data, overallSales, monthReport) {
  if (month.id !== previousDayMonth) return;

  const meaningfulTotalRows = (data.records || []).filter(
    (record) => record.media === "全体" && hasRecordValue(record),
  );
  const detailByDate = aggregateDetailDays(meaningfulTotalRows);
  const overallByDate = extractOverallDailyMetrics(overallSales, month.id);
  const previousDetail = detailByDate.get(previousDayYmd) || emptyDetailDay();
  const previousOverall = overallByDate.get(previousDayYmd) || emptyOverallDay();
  const detailHasData = previousDetail.records > 0;
  const overallHasData = hasOverallDayValue(previousOverall);
  const latestDataDate = [...detailByDate.keys()]
    .filter((date) => date <= previousDayYmd)
    .sort()
    .at(-1) || null;
  const previousComparisonDate = [...detailByDate.keys()]
    .filter((date) => date < previousDayYmd)
    .sort()
    .at(-1);
  const previousComparison = previousComparisonDate ? detailByDate.get(previousComparisonDate) : null;

  monthReport.checks.overallSalesPreviousDayRecords = overallHasData ? 1 : 0;

  if (detailHasData !== overallHasData) {
    monthReport.checks.crossSourceCoverageMismatch = 1;
    pushIssue(monthReport.errors, monthReport, {
      type: detailHasData ? "overall_sales_previous_day_missing" : "detail_previous_day_missing",
      message: `${month.id}: previous day exists in only one daily source`,
      date: previousDayYmd,
      detailHasData,
      overallHasData,
    });
  }

  if (
    previousComparison &&
    previousComparison.projects >= 5 &&
    previousDetail.projects < previousComparison.projects * (1 - projectDropRatio)
  ) {
    monthReport.checks.dailyProjectDrop = previousComparison.projects - previousDetail.projects;
    pushIssue(monthReport.warnings, monthReport, {
      type: "daily_project_drop",
      message: `${month.id}: previous day project count dropped sharply from the prior populated date`,
      date: previousDayYmd,
      comparisonDate: previousComparisonDate,
      previous: previousComparison.projects,
      current: previousDetail.projects,
      dropRatio: 1 - previousDetail.projects / previousComparison.projects,
    });
  }

  const ratioCheck = compareCrossSourceSalesRatio(detailByDate, overallByDate, previousDayYmd);
  if (ratioCheck && ratioCheck.shift > crossSourceRatioShift) {
    monthReport.checks.crossSourceRatioShift = 1;
    pushIssue(monthReport.warnings, monthReport, {
      type: "cross_source_sales_ratio_shift",
      message: `${month.id}: detail-to-overall sales ratio shifted from its recent baseline`,
      date: previousDayYmd,
      baselineRatio: ratioCheck.baseline,
      currentRatio: ratioCheck.current,
      shift: ratioCheck.shift,
    });
  }

  monthReport.freshness = {
    expectedDate: previousDayYmd,
    latestDataDate,
    previousDayHasData: detailHasData && overallHasData,
    detailPreviousDayHasData: detailHasData,
    overallSalesPreviousDayHasData: overallHasData,
    previousDayRecordCount: previousDetail.records,
    previousDayProjectCount: previousDetail.projects,
    comparisonDate: previousComparisonDate || null,
    comparisonProjectCount: previousComparison?.projects || 0,
    detailGeneratedAt: data.source?.generatedAt || null,
    overallSalesGeneratedAt:
      overallSales?.source?.overallRowsSyncedAt ||
      overallSales?.source?.topRowsSyncedAt ||
      overallSales?.source?.generatedAt ||
      null,
    checkedAt: new Date().toISOString(),
  };
}

function aggregateDetailDays(records) {
  const days = new Map();
  for (const record of records || []) {
    if (!isYmd(record.date)) continue;
    const day = days.get(record.date) || emptyDetailDay();
    day.records += 1;
    day.projectNames.add(normalize(record.project));
    day.sales += finiteNumber(record.sales);
    day.grossProfit += finiteNumber(record.grossProfit);
    day.cost += finiteNumber(record.cost);
    day.cv += finiteNumber(record.cv);
    days.set(record.date, day);
  }
  for (const day of days.values()) {
    day.projects = day.projectNames.size;
    delete day.projectNames;
  }
  return days;
}

function emptyDetailDay() {
  return {
    records: 0,
    projects: 0,
    projectNames: new Set(),
    sales: 0,
    grossProfit: 0,
    cost: 0,
    cv: 0,
  };
}

function extractOverallDailyMetrics(overallSales, month) {
  const rows = overallSales?.rows || [];
  if (!rows.length) return new Map();

  const header = rows
    .slice(0, 12)
    .map((row) => ({
      row,
      dates: (row.cells || [])
        .map((cell) => ({
          column: columnLettersFromAddress(cell.address),
          date: parseOverallDate(cell.text ?? cell.value, month),
        }))
        .filter((item) => item.column && item.date),
    }))
    .sort((a, b) => b.dates.length - a.dates.length)[0];
  if (!header?.dates.length) return new Map();

  const metricRows = new Map();
  for (const row of rows.slice(0, 16)) {
    const label = (row.cells || []).map((cell) => normalize(cell.text ?? cell.value)).find((value) =>
      ["売上", "粗利", "消化金額", "ROAS"].includes(value),
    );
    if (label && !metricRows.has(label)) metricRows.set(label, row);
  }

  const days = new Map();
  for (const item of header.dates) {
    const day = emptyOverallDay();
    for (const [label, key] of [
      ["売上", "sales"],
      ["粗利", "grossProfit"],
      ["消化金額", "cost"],
      ["ROAS", "roas"],
    ]) {
      const row = metricRows.get(label);
      if (!row) continue;
      const cell = (row.cells || []).find((candidate) => columnLettersFromAddress(candidate.address) === item.column);
      day[key] = parseNumberValue(cell?.value ?? cell?.text);
    }
    days.set(item.date, day);
  }
  return days;
}

function emptyOverallDay() {
  return { sales: 0, grossProfit: 0, cost: 0, roas: 0 };
}

function hasOverallDayValue(day) {
  return [day?.sales, day?.grossProfit, day?.cost].some((value) => finiteNumber(value) !== 0);
}

function compareCrossSourceSalesRatio(detailByDate, overallByDate, targetDate) {
  const targetDetail = detailByDate.get(targetDate);
  const targetOverall = overallByDate.get(targetDate);
  if (!targetDetail?.sales || !targetOverall?.sales) return null;

  const baselineRatios = [...detailByDate.entries()]
    .filter(([date]) => date < targetDate)
    .map(([date, detail]) => {
      const overall = overallByDate.get(date);
      return detail.sales && overall?.sales ? detail.sales / overall.sales : null;
    })
    .filter((value) => Number.isFinite(value) && value > 0)
    .slice(-7);
  if (baselineRatios.length < 3) return null;

  const baseline = median(baselineRatios);
  const current = targetDetail.sales / targetOverall.sales;
  return {
    baseline,
    current,
    shift: Math.abs(current / baseline - 1),
  };
}

function parseOverallDate(value, month) {
  const match = normalize(value).match(/^(\d{1,2})\/(\d{1,2})(?:\D|$)/);
  if (!match) return "";
  const [year] = month.split("-");
  return `${year}-${String(Number(match[1])).padStart(2, "0")}-${String(Number(match[2])).padStart(2, "0")}`;
}

function columnLettersFromAddress(address) {
  return String(address || "").match(/^[A-Z]+/i)?.[0]?.toUpperCase() || "";
}

function parseNumberValue(value) {
  if (typeof value === "number") return Number.isFinite(value) ? value : 0;
  const text = normalize(value).replaceAll(",", "").replaceAll("¥", "");
  if (!text) return 0;
  if (/^-?\d+(?:\.\d+)?%$/.test(text)) return Number(text.slice(0, -1)) / 100;
  const number = Number(text);
  return Number.isFinite(number) ? number : 0;
}

function median(values) {
  const sorted = [...values].sort((a, b) => a - b);
  const middle = Math.floor(sorted.length / 2);
  return sorted.length % 2 ? sorted[middle] : (sorted[middle - 1] + sorted[middle]) / 2;
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

function checkIndexFreshness(index, report) {
  const months = (index.months || []).map((month) => month.id).filter(Boolean).sort();
  const latestMonth = months.at(-1);
  if (latestMonth && index.defaultMonth !== latestMonth) {
    pushGlobalWarning(report, {
      type: "default_month_not_latest",
      message: `defaultMonth is not the latest month in data/index.json`,
      expected: latestMonth,
      actual: index.defaultMonth || null,
    });
  }

  const currentMonth = monthId(today);
  if (latestMonth && latestMonth < currentMonth && today.day >= 2) {
    pushGlobalWarning(report, {
      type: "latest_month_missing",
      message: `current month is not present in data/index.json`,
      expectedAtLeast: currentMonth,
      actual: latestMonth,
    });
  }
}

function pushGlobalWarning(report, issue) {
  report.warnings.push(issue);
  report.summary.warningCount += 1;
  report.summary.monthsWithWarnings += 1;
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

function hasRecordValue(record) {
  return ["sales", "grossProfit", "cost", "cv"].some((key) => finiteNumber(record?.[key]) !== 0);
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

function parseRunDate(value) {
  const date = value ? new Date(value) : new Date();
  return Number.isFinite(date.getTime()) ? date : new Date();
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

function getJstDateParts(date) {
  const parts = new Intl.DateTimeFormat("en-CA", {
    timeZone: "Asia/Tokyo",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).formatToParts(date);
  const byType = Object.fromEntries(parts.map((part) => [part.type, part.value]));
  return {
    year: Number(byType.year),
    month: Number(byType.month),
    day: Number(byType.day),
  };
}

function addDays(parts, amount) {
  const date = new Date(Date.UTC(parts.year, parts.month - 1, parts.day + amount));
  return {
    year: date.getUTCFullYear(),
    month: date.getUTCMonth() + 1,
    day: date.getUTCDate(),
  };
}

function monthId(parts) {
  return `${parts.year}-${String(parts.month).padStart(2, "0")}`;
}

function formatYmd(parts) {
  return `${monthId(parts)}-${String(parts.day).padStart(2, "0")}`;
}

function isYmd(value) {
  return /^\d{4}-\d{2}-\d{2}$/.test(String(value || ""));
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
