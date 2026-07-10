export const DYNAMIC_SHEET_RANGE = "A:ZZ";

export class SheetSourceGuardError extends Error {
  constructor(code, message, details = {}) {
    super(message);
    this.name = "SheetSourceGuardError";
    this.code = code;
    this.details = details;
  }
}

export function assertRangeCoverage(
  values,
  range,
  { spreadsheetId = "", sheetName = "", safeMaxRows = 0 } = {},
) {
  const parsed = parseA1Range(range);
  const rows = Array.isArray(values) ? values : [];
  const lastRelativeRow = findLastPopulatedRow(rows);
  const lastRow = lastRelativeRow >= 0 ? parsed.startRow + lastRelativeRow : 0;
  const label = [spreadsheetId, sheetName].filter(Boolean).join("/") || "Google Sheet";

  if (parsed.endRow && lastRow >= parsed.endRow) {
    throw new SheetSourceGuardError(
      "sheet_range_row_boundary_reached",
      `${label}!${range} has data at the final requested row ${parsed.endRow}; use an open-ended row range`,
      { spreadsheetId, sheetName, range, lastRow, endRow: parsed.endRow },
    );
  }
  if (safeMaxRows > 0 && lastRow >= safeMaxRows) {
    throw new SheetSourceGuardError(
      "sheet_safe_row_limit_reached",
      `${label}!${range} reached the safe row limit ${safeMaxRows} (last populated row: ${lastRow})`,
      { spreadsheetId, sheetName, range, lastRow, safeMaxRows },
    );
  }

  const width = parsed.endColumn - parsed.startColumn + 1;
  const boundaryRow = rows.findIndex((row) => hasValue(row?.[width - 1]));
  if (boundaryRow >= 0) {
    throw new SheetSourceGuardError(
      "sheet_range_column_boundary_reached",
      `${label}!${range} has data at the final requested column ${parsed.endColumnLabel}; expand the column range`,
      {
        spreadsheetId,
        sheetName,
        range,
        row: parsed.startRow + boundaryRow,
        endColumn: parsed.endColumnLabel,
      },
    );
  }

  return {
    range,
    lastPopulatedRow: lastRow || null,
    returnedRows: rows.length,
    safeMaxRows: safeMaxRows || null,
    columnBoundaryClear: true,
  };
}

export function validateSourceMetadata({
  metadata,
  source,
  expectedMonth,
  requiredSheetNames = [],
} = {}) {
  const expectedSpreadsheetId = normalize(source?.spreadsheetId);
  const actualSpreadsheetId = normalize(metadata?.spreadsheetId);
  if (!expectedSpreadsheetId || !actualSpreadsheetId || expectedSpreadsheetId !== actualSpreadsheetId) {
    throw new SheetSourceGuardError(
      "spreadsheet_id_mismatch",
      `Selected spreadsheet ID does not match Google Sheets metadata for ${expectedMonth}`,
      { expectedSpreadsheetId, actualSpreadsheetId, expectedMonth },
    );
  }
  if (normalize(source?.month) !== normalize(expectedMonth)) {
    throw new SheetSourceGuardError(
      "source_month_mismatch",
      `Selected source month ${source?.month || "(missing)"} does not match requested month ${expectedMonth}`,
      { sourceMonth: source?.month || null, expectedMonth },
    );
  }

  const actualTitle = normalize(metadata?.properties?.title);
  const catalogTitle = normalize(source?.title);
  if (catalogTitle && actualTitle && catalogTitle !== actualTitle) {
    throw new SheetSourceGuardError(
      "spreadsheet_title_changed",
      `Spreadsheet title changed during source discovery for ${expectedMonth}`,
      { catalogTitle, actualTitle, expectedMonth },
    );
  }
  const titleMonth = inferMonth(actualTitle);
  if (titleMonth && titleMonth !== expectedMonth) {
    throw new SheetSourceGuardError(
      "spreadsheet_title_month_mismatch",
      `Spreadsheet title month ${titleMonth} does not match requested month ${expectedMonth}: ${actualTitle}`,
      { actualTitle, titleMonth, expectedMonth },
    );
  }

  const availableSheets = new Set(
    (metadata?.sheets || []).map((sheet) => normalize(sheet?.properties?.title)).filter(Boolean),
  );
  const missingSheets = requiredSheetNames.map(normalize).filter((sheetName) => !availableSheets.has(sheetName));
  if (missingSheets.length) {
    throw new SheetSourceGuardError(
      "required_sheet_missing",
      `Required sheet tab(s) missing for ${expectedMonth}: ${missingSheets.join(", ")}`,
      { expectedMonth, missingSheets, availableSheets: [...availableSheets] },
    );
  }

  return {
    spreadsheetId: actualSpreadsheetId,
    title: actualTitle,
    titleMonth: titleMonth || null,
    requiredSheets: requiredSheetNames,
    sourceLabel: source?.sourceLabel || null,
  };
}

export function selectSourceForMonth(sources, month) {
  const candidates = (sources || []).filter((source) => source?.month === month && source?.spreadsheetId);
  if (!candidates.length) return null;

  const highestPriority = Math.max(...candidates.map(sourcePriority));
  const preferred = candidates.filter((source) => sourcePriority(source) === highestPriority);
  const spreadsheetIds = [...new Set(preferred.map((source) => source.spreadsheetId))];
  if (spreadsheetIds.length > 1) {
    throw new SheetSourceGuardError(
      "ambiguous_month_sources",
      `Multiple equally preferred Nacht sheet sources found for ${month}: ${spreadsheetIds.join(", ")}`,
      {
        month,
        candidates: preferred.map((source) => ({
          spreadsheetId: source.spreadsheetId,
          sourceType: source.sourceType || null,
          sourceLabel: source.sourceLabel || null,
        })),
      },
    );
  }
  return [...preferred].sort(compareSources).at(-1) || null;
}

export function sourcePriority(source) {
  if (source?.sourceType === "direct") return 4;
  if (source?.sourceType === "master_sheet") return 3;
  if (source?.sourceType === "chatwork") return 2;
  return 1;
}

export function compareSources(left, right) {
  const priorityDelta = sourcePriority(left) - sourcePriority(right);
  if (priorityDelta !== 0) return priorityDelta;
  return Number(left?.rowIndex || 0) - Number(right?.rowIndex || 0);
}

function parseA1Range(range) {
  const text = normalize(range).replaceAll("$", "").split("!").at(-1);
  const match = text.match(/^([A-Z]+)(\d*):([A-Z]+)(\d*)$/i);
  if (!match) {
    throw new SheetSourceGuardError("invalid_sheet_range", `Unsupported Google Sheets range: ${range}`, { range });
  }
  const startColumn = columnNumber(match[1]);
  const endColumn = columnNumber(match[3]);
  const startRow = match[2] ? Number(match[2]) : 1;
  const endRow = match[4] ? Number(match[4]) : null;
  if (!startColumn || !endColumn || startColumn > endColumn || (endRow && startRow > endRow)) {
    throw new SheetSourceGuardError("invalid_sheet_range", `Invalid Google Sheets range: ${range}`, { range });
  }
  return {
    startColumn,
    endColumn,
    endColumnLabel: match[3].toUpperCase(),
    startRow,
    endRow,
  };
}

function columnNumber(label) {
  let number = 0;
  for (const character of String(label).toUpperCase()) {
    number = number * 26 + character.charCodeAt(0) - 64;
  }
  return number;
}

function findLastPopulatedRow(rows) {
  for (let index = rows.length - 1; index >= 0; index -= 1) {
    if ((rows[index] || []).some(hasValue)) return index;
  }
  return -1;
}

function hasValue(value) {
  return value !== null && value !== undefined && String(value).trim() !== "";
}

function inferMonth(value) {
  const text = normalize(value);
  const match = text.match(/((?:19|20)\d{2})\s*(?:年|[-/._])\s*(\d{1,2})\s*(?:月)?/);
  if (!match) return "";
  const month = Number(match[2]);
  if (month < 1 || month > 12) return "";
  return `${match[1]}-${String(month).padStart(2, "0")}`;
}

function normalize(value) {
  return String(value ?? "").replace(/\s+/g, " ").trim();
}
