import fs from "node:fs/promises";
import path from "node:path";
import process from "node:process";
import { getGoogleAccessToken } from "./google-auth.mjs";

const DEFAULT_SPREADSHEET_ID = "1zMzWe0dg3dOrhRWJ6X7a6vIRhrLh9TYTKV9bzcXuefY";
const DEFAULT_SHEET_NAME = "◆案件/媒体別日次_全体";
const DEFAULT_TOTAL_SHEET_NAME = "◆案件別日次_全体_固定用";
const DEFAULT_RANGE = "A1:ZZ3000";
const DEFAULT_MONTH = "2026-06";
const FETCH_TIMEOUT_MS = Number(process.env.FETCH_TIMEOUT_MS || 45_000);

const args = parseArgs(process.argv.slice(2));

const config = {
  month: args.month || process.env.TARGET_MONTH || DEFAULT_MONTH,
  spreadsheetId: args.spreadsheetId || process.env.SPREADSHEET_ID || DEFAULT_SPREADSHEET_ID,
  sheetName: args.sheetName || process.env.SHEET_NAME || DEFAULT_SHEET_NAME,
  totalSheetName: args.totalSheetName || process.env.TOTAL_SHEET_NAME || DEFAULT_TOTAL_SHEET_NAME,
  sheetRange: args.range || process.env.SHEET_RANGE || DEFAULT_RANGE,
  out: args.out || process.env.OUT_FILE || `data/${args.month || process.env.TARGET_MONTH || DEFAULT_MONTH}.json`,
  index: args.index || process.env.INDEX_FILE || "data/index.json",
  fixture: args.fixture,
  totalFixture: args.totalFixture,
  sourceMode: args.sourceMode || process.env.SOURCE_MODE,
  totalsOnly: Boolean(args.totalsOnly || process.env.TOTALS_ONLY),
  defaultMonth: args.defaultMonth || process.env.DEFAULT_INDEX_MONTH,
};

const values = config.fixture ? await readFixture(config.fixture) : await fetchSheetValues(config);
const totalValues = config.totalFixture
  ? await readFixture(config.totalFixture)
  : config.fixture
    ? null
    : await fetchSheetValues({ ...config, sheetName: config.totalSheetName });
const parsed = parseNachtSheet(values, config, totalValues);

await writeJson(config.out, parsed);
await writeIndex(config.index, parsed, config.defaultMonth);

console.log(
  JSON.stringify(
    {
      month: parsed.month,
      records: parsed.records.length,
      projects: parsed.projects.length,
      media: parsed.media.length,
      out: config.out,
      index: config.index,
    },
    null,
    2,
  ),
);

function parseNachtSheet(values, config, totalValues = null) {
  const mediaParsed = config.totalsOnly
    ? { records: [], warnings: [] }
    : parseBlockSheet(values, config, { skipProjectRows: Boolean(totalValues), totalsOnly: false });
  const totalParsed = config.totalsOnly
    ? parseBlockSheet(values, config, { skipProjectRows: false, totalsOnly: true })
    : totalValues
    ? parseBlockSheet(totalValues, config, { skipProjectRows: false, totalsOnly: true })
    : { records: [], warnings: [] };
  if (!config.totalsOnly) {
    assertSheetStructure(mediaParsed, config.sheetName);
  }
  if (config.totalsOnly || totalValues) {
    assertSheetStructure(totalParsed, config.totalSheetName);
  }
  const mediaRecords = mediaParsed.records;
  const synthesizedTotals = totalValues ? synthesizeMissingProjectTotals(totalParsed.records, mediaRecords) : [];
  const records = [...totalParsed.records, ...synthesizedTotals, ...mediaRecords];
  const warnings = [...totalParsed.warnings, ...mediaParsed.warnings];
  if (synthesizedTotals.length) {
    const projects = [...new Set(synthesizedTotals.map((record) => record.project))].sort(localeSort);
    warnings.push(
      `Synthesized project totals from media rows for ${projects.length} project(s): ${projects.join(", ")}`,
    );
  }
  const projects = [...new Set(records.map((record) => record.project))].sort(localeSort);
  const media = [...new Set(records.map((record) => record.media))].sort(localeSort);

  return {
    month: config.month,
    source: {
      mode: config.sourceMode || (config.fixture ? "sample" : "google_sheets"),
      spreadsheetId: config.spreadsheetId,
      sheetName: config.sheetName,
      totalSheetName: totalValues || config.totalsOnly ? config.totalSheetName : null,
      range: config.sheetRange,
      generatedAt: new Date().toISOString(),
      structure: {
        detail: mediaParsed.stats || null,
        total: totalParsed.stats || null,
      },
    },
    projects,
    media,
    warnings,
    records,
  };
}

function synthesizeMissingProjectTotals(totalRecords, mediaRecords) {
  const existingTotalKeys = new Set(
    totalRecords
      .filter((record) => record.media === "全体")
      .map((record) => projectDateKey(record.project, record.date)),
  );
  const totals = new Map();

  for (const record of mediaRecords) {
    if (!record.project || !record.date || record.media === "全体") continue;
    const key = projectDateKey(record.project, record.date);
    if (existingTotalKeys.has(key)) continue;
    const total = totals.get(key) || {
      date: record.date,
      project: record.project,
      media: "全体",
      sales: 0,
      grossProfit: 0,
      cost: 0,
      cv: 0,
      roas: 0,
      cpa: 0,
    };
    total.sales += Number(record.sales) || 0;
    total.grossProfit += Number(record.grossProfit) || 0;
    total.cost += Number(record.cost) || 0;
    total.cv += Number(record.cv) || 0;
    totals.set(key, total);
  }

  return [...totals.values()]
    .map((record) => ({
      ...record,
      roas: record.cost ? record.sales / record.cost : 0,
      cpa: record.cv ? record.cost / record.cv : 0,
    }))
    .filter((record) => [record.sales, record.grossProfit, record.cost, record.cv].some((value) => value !== 0))
    .sort((a, b) => a.project.localeCompare(b.project, "ja") || a.date.localeCompare(b.date));
}

function projectDateKey(project, date) {
  return `${project}\u0000${date}`;
}

function parseBlockSheet(values, config, options) {
  const records = [];
  const warnings = [];
  const stats = {
    candidateBlocks: 0,
    blocksWithDates: 0,
    parsedBlocks: 0,
    skippedProjectBlocks: 0,
    missingDateBlocks: 0,
    missingRequiredBlocks: 0,
    records: 0,
  };
  let currentProject = "";

  for (let rowIndex = 0; rowIndex < values.length; rowIndex += 1) {
    const row = values[rowIndex] || [];
    const totalCol = row.findIndex((cell) => normalize(cell) === "合計");
    if (totalCol < 1) continue;

    const labelCol = findLabelColumn(row, totalCol);
    const blockName = labelCol >= 0 ? normalize(row[labelCol]) : "";
    const dateColumns = collectDateColumns(row, totalCol + 1, config.month);
    if (!blockName) continue;
    stats.candidateBlocks += 1;
    if (!dateColumns.length) {
      stats.missingDateBlocks += 1;
      continue;
    }
    stats.blocksWithDates += 1;
    if (blockName === "-- NO DATA --") continue;

    const isProjectBlock = options.totalsOnly || hasProjectIndex(row, labelCol) || !currentProject;
    const media = isProjectBlock ? "全体" : canonicalMedia(blockName);
    if (isProjectBlock) {
      currentProject = blockName;
    }
    if (isProjectBlock && options.skipProjectRows) {
      stats.skippedProjectBlocks += 1;
      continue;
    }
    stats.parsedBlocks += 1;

    const project = isProjectBlock ? blockName : currentProject;
    if (!project) {
      warnings.push(`Row ${rowIndex + 1}: media block without project`);
      continue;
    }

    const metricRows = collectMetricRows(values, rowIndex + 1, labelCol);
    const required = ["売上", "粗利", "消化金額"];
    if (!required.every((key) => metricRows.has(key))) {
      stats.missingRequiredBlocks += 1;
      warnings.push(`Row ${rowIndex + 1}: missing metrics for ${project}/${media}`);
      continue;
    }

    for (const dateColumn of dateColumns) {
      const sales = parseNumber(metricRows.get("売上")?.[dateColumn.col]);
      const grossProfit = parseNumber(metricRows.get("粗利")?.[dateColumn.col]);
      const cv = parseNumber(metricRows.get("件数")?.[dateColumn.col]);
      const cost = parseNumber(metricRows.get("消化金額")?.[dateColumn.col]);
      const roasCell = parseRatio(metricRows.get("ROAS")?.[dateColumn.col]);
      const roas = cost ? sales / cost : roasCell;
      const cpa = cv ? cost / cv : 0;

      if ([sales, grossProfit, cv, cost].every((value) => value === 0)) continue;

      records.push({
        date: dateColumn.date,
        project,
        media,
        sales,
        grossProfit,
        cost,
        cv,
        roas,
        cpa,
      });
    }
  }

  stats.records = records.length;
  return { records, warnings, stats };
}

function assertSheetStructure(parsed, sheetName) {
  const stats = parsed.stats || {};
  if (!stats.candidateBlocks) {
    throw new Error(
      `Sheet structure changed in ${sheetName}: no blocks with "合計" were found. Check the sheet name/range and the total header label.`,
    );
  }
  if (!stats.blocksWithDates) {
    throw new Error(
      `Sheet structure changed in ${sheetName}: no date columns for the target month were found after "合計". Check the date header format.`,
    );
  }
  if (!stats.parsedBlocks) {
    throw new Error(
      `Sheet structure changed in ${sheetName}: no parseable project/media blocks were found. Check the project/media label columns.`,
    );
  }
  if (!stats.records) {
    throw new Error(
      `Sheet structure changed in ${sheetName}: parsed blocks produced zero records. Check 売上 / 粗利 / 消化金額 rows.`,
    );
  }
  if (stats.missingRequiredBlocks >= Math.max(3, stats.parsedBlocks * 0.8)) {
    throw new Error(
      `Sheet structure changed in ${sheetName}: ${stats.missingRequiredBlocks}/${stats.parsedBlocks} block(s) are missing 売上 / 粗利 / 消化金額 rows.`,
    );
  }
}

function collectDateColumns(row, startCol, month) {
  const columns = [];
  const [year, monthNumber] = month.split("-").map(Number);

  for (let col = startCol; col < row.length; col += 1) {
    const parsed = parseSheetDate(row[col], year, monthNumber);
    if (parsed) {
      columns.push({ col, date: parsed });
    }
  }

  return columns;
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
    if (!text) return false;
    return Number.isFinite(Number(text));
  });
}

function collectMetricRows(values, startRow, labelCol) {
  const rows = new Map();

  for (let rowIndex = startRow; rowIndex < Math.min(values.length, startRow + 10); rowIndex += 1) {
    const row = values[rowIndex] || [];
    if (row.findIndex((cell) => normalize(cell) === "合計") >= 0) break;
    const label = canonicalMetricLabel(row[labelCol]);
    if (["売上", "粗利", "件数", "消化金額", "ROAS"].includes(label)) {
      rows.set(label, row);
    }
  }

  return rows;
}

function canonicalMetricLabel(value) {
  const label = normalize(value);
  if (["粗利", "利鞘", "利益"].includes(label)) return "粗利";
  if (label === "消化") return "消化金額";
  if (label === "CV") return "件数";
  return label;
}

async function fetchSheetValues(config) {
  const accessToken = await getGoogleAccessToken({ fetchWithTimeout });
  const range = `${quoteSheetName(config.sheetName)}!${config.sheetRange}`;
  const url = new URL(
    `https://sheets.googleapis.com/v4/spreadsheets/${config.spreadsheetId}/values/${encodeURIComponent(range)}`,
  );
  url.searchParams.set("valueRenderOption", "FORMATTED_VALUE");
  url.searchParams.set("dateTimeRenderOption", "FORMATTED_STRING");

  const response = await fetchWithTimeout(url, {
    headers: {
      Authorization: `Bearer ${accessToken}`,
    },
  });

  if (!response.ok) {
    throw new Error(`Google Sheets API ${response.status}: ${await response.text()}`);
  }

  const payload = await response.json();
  return payload.values || [];
}

async function fetchWithTimeout(url, options = {}) {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS);
  try {
    return await fetch(url, {
      ...options,
      signal: controller.signal,
    });
  } catch (error) {
    if (error?.name === "AbortError") {
      throw new Error(`Fetch timed out after ${FETCH_TIMEOUT_MS}ms: ${String(url)}`);
    }
    throw error;
  } finally {
    clearTimeout(timeout);
  }
}

async function writeIndex(indexPath, parsed, defaultMonth) {
  let existing = { defaultMonth: parsed.month, months: [] };
  try {
    existing = JSON.parse(await fs.readFile(indexPath, "utf8"));
  } catch {
    // Create a fresh index when it does not exist.
  }

  const nextMonth = {
    id: parsed.month,
    label: `${Number(parsed.month.slice(0, 4))}年${Number(parsed.month.slice(5, 7))}月`,
    path: `data/${parsed.month}.json`,
  };
  const months = [...(existing.months || []).filter((month) => month.id !== parsed.month), nextMonth].sort((a, b) =>
    a.id.localeCompare(b.id),
  );

  await writeJson(indexPath, {
    generatedAt: new Date().toISOString(),
    defaultMonth: defaultMonth || existing.defaultMonth || months.at(-1)?.id || parsed.month,
    months,
  });
}

async function writeJson(filePath, value) {
  await fs.mkdir(path.dirname(filePath), { recursive: true });
  await fs.writeFile(filePath, `${JSON.stringify(value, null, 2)}\n`);
}

async function readFixture(filePath) {
  return JSON.parse(await fs.readFile(filePath, "utf8"));
}

function parseArgs(argv) {
  const result = {};
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (!arg.startsWith("--")) continue;
    const key = arg.slice(2);
    result[key] = argv[i + 1] && !argv[i + 1].startsWith("--") ? argv[++i] : true;
  }
  return result;
}

function parseSheetDate(value, year, monthNumber) {
  const text = normalize(value);
  const isoMatch = text.match(/^(\d{4})-(\d{1,2})-(\d{1,2})(?:[ T].*)?$/);
  if (isoMatch) {
    const parsedYear = Number(isoMatch[1]);
    const month = Number(isoMatch[2]);
    const day = Number(isoMatch[3]);
    if (parsedYear === year && month === monthNumber) {
      return `${parsedYear}-${String(month).padStart(2, "0")}-${String(day).padStart(2, "0")}`;
    }
    return null;
  }

  const match = text.match(/^(\d{1,2})\/(\d{1,2})(?:\(.+\))?$/);
  if (!match) return null;
  const month = Number(match[1]);
  const day = Number(match[2]);
  if (month !== monthNumber) return null;
  return `${year}-${String(month).padStart(2, "0")}-${String(day).padStart(2, "0")}`;
}

function parseNumber(value) {
  const text = normalize(value)
    .replaceAll("−", "-")
    .replace(/[¥,%\s,]/g, "");
  if (!text || text === "-") return 0;
  const number = Number(text);
  return Number.isFinite(number) ? number : 0;
}

function parseRatio(value) {
  const text = normalize(value);
  if (!text) return 0;
  const number = parseNumber(text);
  if (text.includes("%")) return number / 100;
  return number > 10 ? number / 100 : number;
}

function normalize(value) {
  return String(value ?? "").replace(/\s+/g, " ").trim();
}

function canonicalMedia(value) {
  if (value === "YouTube") return "YT";
  if (value === "Meta") return "FB";
  return value;
}

function quoteSheetName(sheetName) {
  return `'${sheetName.replaceAll("'", "''")}'`;
}

function localeSort(a, b) {
  return String(a).localeCompare(String(b), "ja");
}
