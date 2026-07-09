import fs from "node:fs/promises";
import path from "node:path";
import process from "node:process";
import { pathToFileURL } from "node:url";
import { getGoogleAccessToken } from "./google-auth.mjs";

const DEFAULT_SHEET_NAME = "◆全体売上表";
const DEFAULT_RANGE = "A3:ZZ55";
const FETCH_TIMEOUT_MS = Number(process.env.FETCH_TIMEOUT_MS || 45_000);

export async function syncOverallSalesTopRows({
  month,
  spreadsheetId,
  sheetName = DEFAULT_SHEET_NAME,
  range = DEFAULT_RANGE,
  out = `data/overall-sales-${month}.json`,
  fetchWithTimeout = defaultFetchWithTimeout,
} = {}) {
  if (!month) throw new Error("month is required");
  if (!spreadsheetId) throw new Error("spreadsheetId is required");

  const raw = await readOptionalFile(out);
  if (!raw) {
    return {
      status: "skipped",
      reason: `${out} does not exist`,
      out,
    };
  }

  const sheet = JSON.parse(raw);
  const values = await fetchSheetValues({
    spreadsheetId,
    sheetName,
    range,
    fetchWithTimeout,
  });
  if (!values.length) {
    throw new Error(`${sheetName}!${range} returned no rows`);
  }
  const expectedRows = rowCountFromRange(range);
  if (expectedRows && values.length < expectedRows) {
    throw new Error(`${sheetName}!${range} returned ${values.length} rows; expected ${expectedRows}`);
  }
  const sourceStructure = validateOverallSalesSource(values, sheetName, range);
  const startRow = startRowFromRange(range);
  const updatedCells = overlayFormattedValues(sheet, values, startRow);
  if (!updatedCells) {
    throw new Error(`${out} had no cells matching ${sheetName}!${range}`);
  }
  const verification = verifySyncedValues(sheet, values, startRow);
  if (verification.mismatches.length) {
    throw new Error(
      `${out} differs from ${sheetName}!${range}: ${verification.mismatches
        .slice(0, 5)
        .map((item) => `${item.address} expected ${JSON.stringify(item.expected)} got ${JSON.stringify(item.actual)}`)
        .join("; ")}`,
    );
  }
  const syncedAt = new Date().toISOString();
  sheet.source = {
    ...(sheet.source || {}),
    overallRowsSyncedAt: syncedAt,
    overallRowsSource: {
      spreadsheetId,
      sheetName,
      range,
      expectedRows: expectedRows || null,
      syncedRows: values.length,
      verifiedCells: verification.checkedCells,
      mismatchCells: verification.mismatches.length,
      structure: sourceStructure,
    },
    topRowsSyncedAt: syncedAt,
    topRowsSource: {
      spreadsheetId,
      sheetName,
      range,
    },
  };

  await writeJson(out, sheet);
  return {
    status: "ok",
    out,
    rows: values.length,
    updatedCells,
    verification: {
      checkedCells: verification.checkedCells,
      mismatches: verification.mismatches.length,
    },
    structure: sourceStructure,
  };
}

async function fetchSheetValues({ spreadsheetId, sheetName, range, fetchWithTimeout }) {
  const accessToken = await getGoogleAccessToken({ fetchWithTimeout });
  const sheetRange = `${quoteSheetName(sheetName)}!${range}`;
  const url = new URL(`https://sheets.googleapis.com/v4/spreadsheets/${spreadsheetId}/values/${encodeURIComponent(sheetRange)}`);
  url.searchParams.set("valueRenderOption", "FORMATTED_VALUE");
  url.searchParams.set("dateTimeRenderOption", "FORMATTED_STRING");

  const response = await fetchWithTimeout(url, {
    headers: {
      Authorization: `Bearer ${accessToken}`,
    },
  });

  if (!response.ok) {
    throw new Error(`Google Sheets values ${spreadsheetId} failed: ${response.status} ${await response.text()}`);
  }

  const payload = await response.json();
  return payload.values || [];
}

function overlayFormattedValues(sheet, values, startRow) {
  let updatedCells = 0;
  const rowsByIndex = new Map((sheet.rows || []).map((row) => [row.index, row]));

  for (let rowOffset = 0; rowOffset < values.length; rowOffset += 1) {
    const row = rowsByIndex.get(startRow + rowOffset);
    const sourceRow = values[rowOffset] || [];
    if (!row) continue;

    for (const cell of row.cells || []) {
      if (cell.skip || !cell.address) continue;
      const columnIndex = columnIndexFromAddress(cell.address);
      if (!columnIndex) continue;
      const text = String(sourceRow[columnIndex - 1] ?? "");
      cell.text = text;
      cell.value = parseFormattedValue(text);
      updatedCells += 1;
    }
  }

  return updatedCells;
}

function verifySyncedValues(sheet, values, startRow) {
  let checkedCells = 0;
  const mismatches = [];
  const rowsByIndex = new Map((sheet.rows || []).map((row) => [row.index, row]));

  for (let rowOffset = 0; rowOffset < values.length; rowOffset += 1) {
    const row = rowsByIndex.get(startRow + rowOffset);
    const sourceRow = values[rowOffset] || [];
    if (!row) continue;

    for (const cell of row.cells || []) {
      if (cell.skip || !cell.address) continue;
      const columnIndex = columnIndexFromAddress(cell.address);
      if (!columnIndex) continue;

      const expected = String(sourceRow[columnIndex - 1] ?? "");
      const actual = String(cell.text ?? "");
      checkedCells += 1;
      if (actual !== expected) {
        mismatches.push({
          address: cell.address,
          expected,
          actual,
        });
      }
    }
  }

  return { checkedCells, mismatches };
}

function validateOverallSalesSource(values, sheetName, range) {
  const requiredMetrics = ["売上", "粗利", "消化金額", "ROAS"];
  const metricCounts = Object.fromEntries(requiredMetrics.map((metric) => [metric, 0]));
  let dateHeaders = 0;
  let totalHeaders = 0;

  for (const row of values) {
    for (const cell of row || []) {
      const text = String(cell ?? "").trim();
      if (Object.hasOwn(metricCounts, text)) metricCounts[text] += 1;
      if (text === "Total" || text === "合計") totalHeaders += 1;
      if (/^\d{1,2}\/\d{1,2}(?:\(.+\))?$/.test(text) || /^\d{4}-\d{1,2}-\d{1,2}/.test(text)) {
        dateHeaders += 1;
      }
    }
  }

  const missingMetrics = requiredMetrics.filter((metric) => !metricCounts[metric]);
  if (missingMetrics.length) {
    throw new Error(
      `Sheet structure changed in ${sheetName}!${range}: missing metric label(s): ${missingMetrics.join(", ")}`,
    );
  }
  if (!dateHeaders) {
    throw new Error(`Sheet structure changed in ${sheetName}!${range}: no date header cells were found`);
  }
  if (!totalHeaders) {
    throw new Error(`Sheet structure changed in ${sheetName}!${range}: no Total/合計 header cells were found`);
  }

  return {
    metricCounts,
    dateHeaders,
    totalHeaders,
  };
}

function parseFormattedValue(value) {
  const text = String(value ?? "").trim();
  if (!text) return null;
  const numeric = text.replaceAll(",", "").replaceAll("¥", "");
  if (/^-?\d+(?:\.\d+)?%$/.test(numeric)) return Number(numeric.slice(0, -1)) / 100;
  if (/^-?\d+(?:\.\d+)?$/.test(numeric)) return Number(numeric);
  return text;
}

function startRowFromRange(range) {
  const match = String(range || "").match(/[A-Z]+(\d+)/i);
  return match ? Number(match[1]) : 1;
}

function rowCountFromRange(range) {
  const match = String(range || "").match(/[A-Z]+(\d+):[A-Z]+(\d+)/i);
  if (!match) return 0;
  const start = Number(match[1]);
  const end = Number(match[2]);
  if (!Number.isFinite(start) || !Number.isFinite(end) || end < start) return 0;
  return end - start + 1;
}

function columnIndexFromAddress(address) {
  const letters = String(address || "").match(/^[A-Z]+/i)?.[0]?.toUpperCase();
  if (!letters) return 0;
  return [...letters].reduce((acc, character) => acc * 26 + character.charCodeAt(0) - 64, 0);
}

function quoteSheetName(sheetName) {
  return `'${String(sheetName).replaceAll("'", "''")}'`;
}

async function readOptionalFile(filePath) {
  try {
    return await fs.readFile(filePath, "utf8");
  } catch (error) {
    if (error.code === "ENOENT") return "";
    throw error;
  }
}

async function writeJson(filePath, value) {
  await fs.mkdir(path.dirname(filePath), { recursive: true });
  await fs.writeFile(filePath, `${JSON.stringify(value, null, 2)}\n`);
}

async function defaultFetchWithTimeout(url, options = {}) {
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

function parseArgs(argv) {
  const result = {};
  for (let index = 0; index < argv.length; index += 1) {
    const item = argv[index];
    if (!item.startsWith("--")) continue;
    const key = item.slice(2);
    const next = argv[index + 1];
    if (!next || next.startsWith("--")) {
      result[key] = true;
    } else {
      result[key] = next;
      index += 1;
    }
  }
  return result;
}

if (import.meta.url === pathToFileURL(process.argv[1]).href) {
  const args = parseArgs(process.argv.slice(2));
  const result = await syncOverallSalesTopRows({
    month: args.month || process.env.TARGET_MONTH,
    spreadsheetId: args.spreadsheetId || process.env.SPREADSHEET_ID,
    sheetName: args.sheetName || process.env.OVERALL_SALES_SHEET_NAME || DEFAULT_SHEET_NAME,
    range: args.range || process.env.OVERALL_SALES_RANGE || process.env.OVERALL_SALES_TOP_RANGE || DEFAULT_RANGE,
    out: args.out,
  });
  console.log(JSON.stringify(result, null, 2));
}
