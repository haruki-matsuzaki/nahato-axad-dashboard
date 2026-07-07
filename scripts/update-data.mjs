import crypto from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import process from "node:process";

const DEFAULT_SPREADSHEET_ID = "1zMzWe0dg3dOrhRWJ6X7a6vIRhrLh9TYTKV9bzcXuefY";
const DEFAULT_SHEET_NAME = "◆案件媒体別日次_全体";
const DEFAULT_TOTAL_SHEET_NAME = "◆案件別日次_全体_固定用";
const DEFAULT_RANGE = "A1:ZZ3000";
const DEFAULT_MONTH = "2026-06";

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
  const totalProjects = totalValues ? new Set(totalParsed.records.map((record) => record.project)) : null;
  const mediaRecords = totalProjects
    ? mediaParsed.records.filter((record) => totalProjects.has(record.project))
    : mediaParsed.records;
  const records = [...totalParsed.records, ...mediaRecords];
  const warnings = [...totalParsed.warnings, ...mediaParsed.warnings];
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
    },
    projects,
    media,
    warnings,
    records,
  };
}

function parseBlockSheet(values, config, options) {
  const records = [];
  const warnings = [];
  let currentProject = "";

  for (let rowIndex = 0; rowIndex < values.length; rowIndex += 1) {
    const row = values[rowIndex] || [];
    const totalCol = row.findIndex((cell) => normalize(cell) === "合計");
    if (totalCol < 1) continue;

    const labelCol = findLabelColumn(row, totalCol);
    const blockName = labelCol >= 0 ? normalize(row[labelCol]) : "";
    const dateColumns = collectDateColumns(row, totalCol + 1, config.month);
    if (!blockName || !dateColumns.length) continue;
    if (blockName === "-- NO DATA --") continue;

    const isProjectBlock = options.totalsOnly || hasProjectIndex(row, labelCol) || !currentProject;
    const media = isProjectBlock ? "全体" : canonicalMedia(blockName);
    if (isProjectBlock) {
      currentProject = blockName;
    }
    if (isProjectBlock && options.skipProjectRows) continue;

    const project = isProjectBlock ? blockName : currentProject;
    if (!project) {
      warnings.push(`Row ${rowIndex + 1}: media block without project`);
      continue;
    }

    const metricRows = collectMetricRows(values, rowIndex + 1, labelCol);
    const required = ["売上", "粗利", "消化金額"];
    if (!required.every((key) => metricRows.has(key))) {
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

  return { records, warnings };
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
  const accessToken = await getAccessToken();
  const range = `${quoteSheetName(config.sheetName)}!${config.sheetRange}`;
  const url = new URL(
    `https://sheets.googleapis.com/v4/spreadsheets/${config.spreadsheetId}/values/${encodeURIComponent(range)}`,
  );
  url.searchParams.set("valueRenderOption", "FORMATTED_VALUE");
  url.searchParams.set("dateTimeRenderOption", "FORMATTED_STRING");

  const response = await fetch(url, {
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

async function getAccessToken() {
  const credentials = readServiceAccount();
  const now = Math.floor(Date.now() / 1000);
  const header = { alg: "RS256", typ: "JWT" };
  const claim = {
    iss: credentials.client_email,
    scope: "https://www.googleapis.com/auth/spreadsheets.readonly",
    aud: "https://oauth2.googleapis.com/token",
    exp: now + 3600,
    iat: now,
  };
  const unsigned = `${base64Url(JSON.stringify(header))}.${base64Url(JSON.stringify(claim))}`;
  const signature = crypto.createSign("RSA-SHA256").update(unsigned).sign(credentials.private_key);
  const assertion = `${unsigned}.${base64Url(signature)}`;

  const response = await fetch("https://oauth2.googleapis.com/token", {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      grant_type: "urn:ietf:params:oauth:grant-type:jwt-bearer",
      assertion,
    }),
  });

  if (!response.ok) {
    throw new Error(`Google OAuth ${response.status}: ${await response.text()}`);
  }

  const payload = await response.json();
  return payload.access_token;
}

function readServiceAccount() {
  if (process.env.GOOGLE_SERVICE_ACCOUNT_JSON) {
    const raw = process.env.GOOGLE_SERVICE_ACCOUNT_JSON;
    return JSON.parse(raw);
  }

  if (process.env.GOOGLE_CLIENT_EMAIL && process.env.GOOGLE_PRIVATE_KEY) {
    return {
      client_email: process.env.GOOGLE_CLIENT_EMAIL,
      private_key: process.env.GOOGLE_PRIVATE_KEY.replaceAll("\\n", "\n"),
    };
  }

  throw new Error("GOOGLE_SERVICE_ACCOUNT_JSON or GOOGLE_CLIENT_EMAIL/GOOGLE_PRIVATE_KEY is required");
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

function base64Url(input) {
  const buffer = Buffer.isBuffer(input) ? input : Buffer.from(input);
  return buffer.toString("base64").replaceAll("+", "-").replaceAll("/", "_").replaceAll("=", "");
}

function localeSort(a, b) {
  return String(a).localeCompare(String(b), "ja");
}
