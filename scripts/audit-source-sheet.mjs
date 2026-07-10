import crypto from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import process from "node:process";
import { pathToFileURL } from "node:url";
import { getGoogleAccessToken } from "./google-auth.mjs";

const DEFAULT_DETAIL_SHEET_NAME = "◆案件/媒体別日次_全体";
const DEFAULT_TOTAL_SHEET_NAME = "◆案件別日次_全体_固定用";
const DEFAULT_RANGE = "A1:ZZ3000";
const DEFAULT_STATUS_PATH = "data/source-audit-status.json";
const FETCH_TIMEOUT_MS = Number(process.env.FETCH_TIMEOUT_MS || 45_000);
const MAX_EXAMPLES = 12;
const METRICS = ["sales", "grossProfit", "cost", "cv"];

export class SourceAuditError extends Error {
  constructor(message, result) {
    super(message);
    this.name = "SourceAuditError";
    this.code = "source_sheet_mismatch";
    this.result = result;
  }
}

export async function auditSourceSheet({
  month,
  spreadsheetId,
  detailSheetName = DEFAULT_DETAIL_SHEET_NAME,
  totalSheetName = DEFAULT_TOTAL_SHEET_NAME,
  range = DEFAULT_RANGE,
  generatedPath = `data/${month}.json`,
  statusPath = DEFAULT_STATUS_PATH,
  fetchWithTimeout = defaultFetchWithTimeout,
} = {}) {
  if (!/^\d{4}-\d{2}$/.test(String(month || ""))) throw new Error("month must be YYYY-MM");
  if (!spreadsheetId) throw new Error("spreadsheetId is required");

  const accessToken = await getGoogleAccessToken({ fetchWithTimeout });
  const [detailValues, totalValues, generatedData] = await Promise.all([
    fetchSheetValues({ spreadsheetId, sheetName: detailSheetName, range, accessToken, fetchWithTimeout }),
    fetchSheetValues({ spreadsheetId, sheetName: totalSheetName, range, accessToken, fetchWithTimeout }),
    readJson(generatedPath),
  ]);
  const result = auditSourceValues({
    month,
    spreadsheetId,
    detailSheetName,
    totalSheetName,
    detailValues,
    totalValues,
    generatedData,
  });
  await writeAuditStatus(statusPath, result);

  if (result.status !== "ok") {
    const counts = result.summary;
    throw new SourceAuditError(
      `Source sheet audit failed for ${month}: missing=${counts.missingKeys}, extra=${counts.extraKeys}, mismatches=${counts.valueMismatches}, structure=${counts.structureIssues}`,
      result,
    );
  }
  return result;
}

export function auditSourceValues({
  month,
  spreadsheetId = "fixture",
  detailSheetName = DEFAULT_DETAIL_SHEET_NAME,
  totalSheetName = DEFAULT_TOTAL_SHEET_NAME,
  detailValues,
  totalValues,
  generatedData,
} = {}) {
  const detail = parseSourceBlocks(detailValues || [], { month, totalsOnly: false, sheetName: detailSheetName });
  const total = parseSourceBlocks(totalValues || [], { month, totalsOnly: true, sheetName: totalSheetName });
  const expectedTotals = withSynthesizedTotals(total.records, detail.records);
  const expected = mergeRecordMaps(expectedTotals, detail.records);
  const actual = aggregateGeneratedRecords(generatedData?.records || []);
  const missing = [];
  const extra = [];
  const mismatches = [];
  const structureIssues = [...detail.structureIssues, ...total.structureIssues];

  for (const [key, expectedValue] of expected.entries()) {
    const actualValue = actual.get(key);
    if (!actualValue) {
      missing.push(formatKey(key));
      continue;
    }
    for (const metric of METRICS) {
      if (!valuesClose(expectedValue[metric], actualValue[metric], metric)) {
        mismatches.push({
          ...formatKey(key),
          metric,
          expected: expectedValue[metric],
          actual: actualValue[metric],
          diff: actualValue[metric] - expectedValue[metric],
        });
      }
    }
  }

  for (const key of actual.keys()) {
    if (!expected.has(key)) extra.push(formatKey(key));
  }

  const expectedProjects = new Set([...expected.keys()].map((key) => key.split("\u0000")[0]));
  const actualProjects = new Set((generatedData?.projects || []).map(normalize).filter(Boolean));
  const missingProjects = [...expectedProjects].filter((project) => !actualProjects.has(project)).sort(localeSort);
  const extraProjects = [...actualProjects].filter((project) => !expectedProjects.has(project)).sort(localeSort);
  for (const project of missingProjects) {
    structureIssues.push({ type: "missing_project", sheet: "generated", project });
  }
  for (const project of extraProjects) {
    structureIssues.push({ type: "extra_project", sheet: "generated", project });
  }

  const status = missing.length || extra.length || mismatches.length || structureIssues.length ? "error" : "ok";
  return {
    generatedAt: new Date().toISOString(),
    status,
    month,
    spreadsheetId,
    sheets: {
      detail: detailSheetName,
      total: totalSheetName,
    },
    sourceFingerprint: fingerprint(expected),
    generatedFingerprint: fingerprint(actual),
    summary: {
      sourceProjects: expectedProjects.size,
      generatedProjects: actualProjects.size,
      sourceKeys: expected.size,
      generatedKeys: actual.size,
      verifiedMetrics: Math.max(0, expected.size - missing.length) * METRICS.length,
      missingKeys: missing.length,
      extraKeys: extra.length,
      valueMismatches: mismatches.length,
      structureIssues: structureIssues.length,
      detailBlocks: detail.stats.parsedBlocks,
      totalBlocks: total.stats.parsedBlocks,
    },
    issues: {
      missing: missing.slice(0, MAX_EXAMPLES),
      extra: extra.slice(0, MAX_EXAMPLES),
      mismatches: mismatches.slice(0, MAX_EXAMPLES),
      structure: structureIssues.slice(0, MAX_EXAMPLES),
    },
  };
}

function parseSourceBlocks(values, { month, totalsOnly, sheetName }) {
  const records = new Map();
  const structureIssues = [];
  const stats = {
    candidateBlocks: 0,
    dateBlocks: 0,
    parsedBlocks: 0,
    missingMetricBlocks: 0,
    orphanMediaBlocks: 0,
  };
  let currentProject = "";

  for (let rowIndex = 0; rowIndex < values.length; rowIndex += 1) {
    const row = values[rowIndex] || [];
    const totalCol = row.findIndex((cell) => normalize(cell) === "合計");
    if (totalCol < 1) continue;
    const labelCol = findLabelColumn(row, totalCol);
    const blockName = labelCol >= 0 ? normalize(row[labelCol]) : "";
    if (!blockName || blockName === "-- NO DATA --") continue;
    stats.candidateBlocks += 1;

    const dateColumns = collectDateColumns(row, totalCol + 1, month);
    if (!dateColumns.length) continue;
    stats.dateBlocks += 1;

    let project;
    let media;
    if (totalsOnly) {
      project = blockName;
      media = "全体";
    } else {
      const isProjectBlock = hasProjectIndex(row, labelCol) || !currentProject;
      if (isProjectBlock) {
        currentProject = blockName;
        continue;
      }
      project = currentProject;
      media = canonicalMedia(blockName);
      if (!project) {
        stats.orphanMediaBlocks += 1;
        structureIssues.push({ type: "orphan_media_block", sheet: sheetName, row: rowIndex + 1, media });
        continue;
      }
    }

    const metricRows = collectMetricRows(values, rowIndex + 1, labelCol);
    const missingMetrics = ["売上", "粗利", "件数", "消化金額"].filter((metric) => !metricRows.has(metric));
    if (missingMetrics.length) {
      stats.missingMetricBlocks += 1;
      structureIssues.push({
        type: "missing_metric_rows",
        sheet: sheetName,
        row: rowIndex + 1,
        project,
        media,
        missingMetrics,
      });
      continue;
    }
    stats.parsedBlocks += 1;

    for (const dateColumn of dateColumns) {
      const record = {
        sales: parseNumber(metricRows.get("売上")?.[dateColumn.col]),
        grossProfit: parseNumber(metricRows.get("粗利")?.[dateColumn.col]),
        cost: parseNumber(metricRows.get("消化金額")?.[dateColumn.col]),
        cv: parseNumber(metricRows.get("件数")?.[dateColumn.col]),
      };
      if (!hasMetricValue(record)) continue;
      addRecord(records, recordKey(project, media, dateColumn.date), record);
    }
  }

  if (!stats.candidateBlocks) structureIssues.push({ type: "no_blocks", sheet: sheetName });
  if (!stats.dateBlocks) structureIssues.push({ type: "no_date_headers", sheet: sheetName, month });
  if (!stats.parsedBlocks) structureIssues.push({ type: "no_parsed_blocks", sheet: sheetName });
  return { records, structureIssues, stats };
}

function withSynthesizedTotals(totalRecords, detailRecords) {
  const totals = new Map(totalRecords);
  const synthesized = new Map();
  for (const [key, record] of detailRecords.entries()) {
    const { project, date } = formatKey(key);
    const totalKey = recordKey(project, "全体", date);
    if (totals.has(totalKey)) continue;
    addRecord(synthesized, totalKey, record);
  }
  for (const [key, record] of synthesized.entries()) totals.set(key, record);
  return totals;
}

function mergeRecordMaps(...maps) {
  const result = new Map();
  for (const map of maps) {
    for (const [key, record] of map.entries()) result.set(key, { ...record });
  }
  return result;
}

function aggregateGeneratedRecords(records) {
  const result = new Map();
  for (const record of records || []) {
    const project = normalize(record.project);
    const media = canonicalMedia(normalize(record.media));
    const date = normalize(record.date);
    if (!project || !media || !date) continue;
    addRecord(result, recordKey(project, media, date), {
      sales: finiteNumber(record.sales),
      grossProfit: finiteNumber(record.grossProfit),
      cost: finiteNumber(record.cost),
      cv: finiteNumber(record.cv),
    });
  }
  return result;
}

function addRecord(map, key, record) {
  const current = map.get(key) || emptyMetrics();
  for (const metric of METRICS) current[metric] += finiteNumber(record[metric]);
  map.set(key, current);
}

function emptyMetrics() {
  return { sales: 0, grossProfit: 0, cost: 0, cv: 0 };
}

function hasMetricValue(record) {
  return METRICS.some((metric) => finiteNumber(record[metric]) !== 0);
}

function recordKey(project, media, date) {
  return `${normalize(project)}\u0000${canonicalMedia(normalize(media))}\u0000${normalize(date)}`;
}

function formatKey(key) {
  const [project, media, date] = String(key || "").split("\u0000");
  return { project, media, date };
}

function valuesClose(expected, actual, metric) {
  const diff = Math.abs(finiteNumber(actual) - finiteNumber(expected));
  return metric === "cv" ? diff <= 0.001 : diff <= 1;
}

function fingerprint(records) {
  const normalized = [...records.entries()]
    .sort(([left], [right]) => left.localeCompare(right, "ja"))
    .map(([key, record]) => [key, ...METRICS.map((metric) => finiteNumber(record[metric]))]);
  return crypto.createHash("sha256").update(JSON.stringify(normalized)).digest("hex");
}

function collectDateColumns(row, startCol, month) {
  const columns = [];
  for (let col = startCol; col < row.length; col += 1) {
    const date = parseSheetDate(row[col], month);
    if (date) columns.push({ col, date });
  }
  return columns;
}

function parseSheetDate(value, month) {
  const [year, monthNumber] = month.split("-").map(Number);
  const text = normalize(value);
  const iso = text.match(/^(\d{4})-(\d{1,2})-(\d{1,2})(?:[ T].*)?$/);
  if (iso) {
    const parsedYear = Number(iso[1]);
    const parsedMonth = Number(iso[2]);
    const day = Number(iso[3]);
    return parsedYear === year && parsedMonth === monthNumber
      ? `${parsedYear}-${String(parsedMonth).padStart(2, "0")}-${String(day).padStart(2, "0")}`
      : "";
  }
  const short = text.match(/^(\d{1,2})\/(\d{1,2})(?:\(.+\))?$/);
  if (!short || Number(short[1]) !== monthNumber) return "";
  return `${year}-${String(monthNumber).padStart(2, "0")}-${String(Number(short[2])).padStart(2, "0")}`;
}

function findLabelColumn(row, totalCol) {
  for (let col = totalCol - 1; col >= Math.max(0, totalCol - 4); col -= 1) {
    if (normalize(row[col])) return col;
  }
  return -1;
}

function hasProjectIndex(row, labelCol) {
  return row.slice(0, Math.max(labelCol, 0)).some((cell) => {
    const text = normalize(cell);
    return text && Number.isFinite(Number(text));
  });
}

function collectMetricRows(values, startRow, labelCol) {
  const rows = new Map();
  for (let rowIndex = startRow; rowIndex < Math.min(values.length, startRow + 10); rowIndex += 1) {
    const row = values[rowIndex] || [];
    if (row.some((cell) => normalize(cell) === "合計")) break;
    const metric = canonicalMetric(row[labelCol]);
    if (["売上", "粗利", "件数", "消化金額"].includes(metric)) rows.set(metric, row);
  }
  return rows;
}

function canonicalMetric(value) {
  const metric = normalize(value);
  if (["粗利", "利鞘", "利益"].includes(metric)) return "粗利";
  if (metric === "消化") return "消化金額";
  if (metric === "CV") return "件数";
  return metric;
}

function canonicalMedia(value) {
  if (value === "YouTube") return "YT";
  if (value === "Meta") return "FB";
  return value;
}

function parseNumber(value) {
  const text = normalize(value).replaceAll("−", "-").replace(/[¥,%\s,]/g, "");
  if (!text || text === "-") return 0;
  const number = Number(text);
  return Number.isFinite(number) ? number : 0;
}

function finiteNumber(value) {
  const number = Number(value);
  return Number.isFinite(number) ? number : 0;
}

function normalize(value) {
  return String(value ?? "").replace(/\s+/g, " ").trim();
}

function localeSort(left, right) {
  return String(left).localeCompare(String(right), "ja");
}

async function fetchSheetValues({ spreadsheetId, sheetName, range, accessToken, fetchWithTimeout }) {
  const sheetRange = `${quoteSheetName(sheetName)}!${range}`;
  const url = new URL(`https://sheets.googleapis.com/v4/spreadsheets/${spreadsheetId}/values/${encodeURIComponent(sheetRange)}`);
  url.searchParams.set("valueRenderOption", "FORMATTED_VALUE");
  url.searchParams.set("dateTimeRenderOption", "FORMATTED_STRING");
  const response = await fetchWithTimeout(url, { headers: { Authorization: `Bearer ${accessToken}` } });
  if (!response.ok) throw new Error(`Google Sheets source audit ${spreadsheetId}/${sheetName} failed: ${response.status} ${await response.text()}`);
  return (await response.json()).values || [];
}

async function writeAuditStatus(filePath, result) {
  const existing = await readOptionalJson(filePath);
  const entries = [result, ...(existing?.entries || []).filter((item) => item.month !== result.month)].slice(0, 24);
  await writeJson(filePath, {
    generatedAt: result.generatedAt,
    status: result.status,
    latestMonth: result.month,
    entries,
  });
}

async function readJson(filePath) {
  return JSON.parse(await fs.readFile(filePath, "utf8"));
}

async function readOptionalJson(filePath) {
  try {
    return await readJson(filePath);
  } catch (error) {
    if (error.code === "ENOENT") return null;
    throw error;
  }
}

async function writeJson(filePath, value) {
  await fs.mkdir(path.dirname(filePath), { recursive: true });
  await fs.writeFile(filePath, `${JSON.stringify(value, null, 2)}\n`);
}

function quoteSheetName(sheetName) {
  return `'${String(sheetName).replaceAll("'", "''")}'`;
}

async function defaultFetchWithTimeout(url, options = {}) {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS);
  try {
    return await fetch(url, { ...options, signal: controller.signal });
  } finally {
    clearTimeout(timeout);
  }
}

function parseArgs(argv) {
  const parsed = {};
  for (let index = 0; index < argv.length; index += 1) {
    const item = argv[index];
    if (!item.startsWith("--")) continue;
    const key = item.slice(2);
    const next = argv[index + 1];
    if (!next || next.startsWith("--")) parsed[key] = true;
    else {
      parsed[key] = next;
      index += 1;
    }
  }
  return parsed;
}

if (import.meta.url === pathToFileURL(process.argv[1]).href) {
  const args = parseArgs(process.argv.slice(2));
  const result = await auditSourceSheet({
    month: args.month || process.env.TARGET_MONTH,
    spreadsheetId: args.spreadsheetId || process.env.SPREADSHEET_ID,
    detailSheetName: args.detailSheetName || process.env.SHEET_NAME || DEFAULT_DETAIL_SHEET_NAME,
    totalSheetName: args.totalSheetName || process.env.TOTAL_SHEET_NAME || DEFAULT_TOTAL_SHEET_NAME,
    range: args.range || process.env.SHEET_RANGE || DEFAULT_RANGE,
    generatedPath: args.generated || process.env.GENERATED_DATA_FILE,
    statusPath: args.status || process.env.SOURCE_AUDIT_STATUS_FILE || DEFAULT_STATUS_PATH,
  });
  console.log(JSON.stringify(result, null, 2));
}
