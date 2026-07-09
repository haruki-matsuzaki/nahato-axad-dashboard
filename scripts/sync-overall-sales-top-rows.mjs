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
  const startRow = startRowFromRange(range);
  const updatedCells = overlayFormattedValues(sheet, values, startRow);
  if (!updatedCells) {
    throw new Error(`${out} had no cells matching ${sheetName}!${range}`);
  }
  const syncedAt = new Date().toISOString();
  sheet.source = {
    ...(sheet.source || {}),
    overallRowsSyncedAt: syncedAt,
    overallRowsSource: {
      spreadsheetId,
      sheetName,
      range,
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
