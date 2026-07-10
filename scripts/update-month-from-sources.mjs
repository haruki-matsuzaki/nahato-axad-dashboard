import fs from "node:fs/promises";
import path from "node:path";
import process from "node:process";
import { spawn } from "node:child_process";
import { getGoogleAccessToken } from "./google-auth.mjs";
import { auditSourceSheet } from "./audit-source-sheet.mjs";
import {
  assertRangeCoverage,
  compareSources,
  DYNAMIC_SHEET_RANGE,
  selectSourceForMonth,
  sourcePriority,
  validateSourceMetadata,
} from "./sheet-source-guard.mjs";
import { syncOverallSalesTopRows } from "./sync-overall-sales-top-rows.mjs";

const DEFAULT_MASTER_SPREADSHEET_ID = "1Xk-p_-6Np-e5keqOy5fcgmU-TF28H5dU7UeEYDUX_7k";
const DEFAULT_MASTER_SHEET_ID = "2127655846";
const DEFAULT_MASTER_RANGE = DYNAMIC_SHEET_RANGE;
const DEFAULT_SHEET_NAME = "◆案件/媒体別日次_全体";
const DEFAULT_TOTAL_SHEET_NAME = "◆案件別日次_全体_固定用";
const DEFAULT_SHEET_RANGE = DYNAMIC_SHEET_RANGE;
const DEFAULT_MASTER_MAX_ROWS = 2000;
const DEFAULT_SOURCE_MAX_ROWS = 3000;
const JST_TIME_ZONE = "Asia/Tokyo";
const MONTHLY_SCHEDULE_CRONS = new Set(["0 6 * * *", "7 6 * * *", "17 6 * * *", "27 6 * * *"]);
const FETCH_TIMEOUT_MS = Number(process.env.FETCH_TIMEOUT_MS || 45_000);

const args = parseArgs(process.argv.slice(2));
const options = {
  mode: args.mode || process.env.UPDATE_MODE || "scheduled",
  month: args.month || process.env.TARGET_MONTH || "",
  spreadsheetId: args.spreadsheetId || process.env.SPREADSHEET_ID || "",
  forceMonthly: toBoolean(args.force || args.forceMonthly || process.env.FORCE_MONTHLY),
  dryRun: toBoolean(args.dryRun || process.env.DRY_RUN),
  runDate: parseRunDate(args.runDate || process.env.RUN_DATE),
  masterSpreadsheetId: args.masterSpreadsheetId || process.env.MASTER_SPREADSHEET_ID || DEFAULT_MASTER_SPREADSHEET_ID,
  masterSheetId: String(args.masterSheetId || process.env.MASTER_SHEET_ID || DEFAULT_MASTER_SHEET_ID),
  masterRange: args.masterRange || process.env.MASTER_RANGE || DEFAULT_MASTER_RANGE,
  sheetName: args.sheetName || process.env.SHEET_NAME || DEFAULT_SHEET_NAME,
  totalSheetName: args.totalSheetName || process.env.TOTAL_SHEET_NAME || DEFAULT_TOTAL_SHEET_NAME,
  sheetRange: args.range || process.env.SHEET_RANGE || DEFAULT_SHEET_RANGE,
  masterMaxRows: Number(args.masterMaxRows || process.env.MAX_MASTER_ROWS || DEFAULT_MASTER_MAX_ROWS),
  sourceMaxRows: Number(args.maxRows || process.env.MAX_SOURCE_ROWS || DEFAULT_SOURCE_MAX_ROWS),
  indexPath: args.index || process.env.INDEX_FILE || "data/index.json",
  statusPath: args.status || process.env.UPDATE_STATUS_FILE || "data/update-status.json",
  updateLogPath: args.updateLog || process.env.UPDATE_LOG_FILE || "data/update-log.json",
  sourceManifestPath: args.sourceManifest || process.env.SOURCE_MANIFEST || "data/sheet-sources.json",
  sourceAuditStatusPath:
    args.sourceAuditStatus || process.env.SOURCE_AUDIT_STATUS_FILE || "data/source-audit-status.json",
  chatworkRoomId: args.chatworkRoomId || process.env.CHATWORK_ANALYSIS_ROOM_ID || process.env.CHATWORK_ROOM_ID_ANALYSIS || "",
  githubEventSchedule: process.env.GITHUB_EVENT_SCHEDULE || "",
};

const plan = buildUpdatePlan(options);
try {
  const result = await main(plan);
  if (!options.dryRun) {
    await writeUpdateStatus(options.statusPath, result);
    await writeUpdateLog(options.updateLogPath, result);
  }
  console.log(JSON.stringify({ updated: result.results, skipped: result.skippedReason || null }, null, 2));
  if (result.failed) {
    process.exitCode = 1;
  }
} catch (error) {
  if (!options.dryRun) {
    const result = {
      plan,
      results: [],
      failed: true,
      fatalError: errorToPayload(error),
    };
    await writeUpdateStatus(options.statusPath, result);
    await writeUpdateLog(options.updateLogPath, result);
  }
  console.error(error);
  process.exitCode = 1;
}

async function main(plan) {
  if (!plan.targets.length) {
    return {
      plan,
      results: [],
      failed: false,
      skippedReason: plan.reason,
    };
  }

  const sourceCatalog = options.spreadsheetId
    ? directSourceCatalog(options.spreadsheetId, plan.targets, options)
    : await discoverSourceCatalog(options);

  if (!options.spreadsheetId) {
    await writeJson(options.sourceManifestPath, sourceCatalog.manifest);
  }

  const defaultMonth = await resolveDefaultMonth(options.indexPath, plan.targets.map((target) => target.month));
  const results = [];
  let failed = false;

  for (const target of dedupeTargets(plan.targets)) {
    const source = selectSourceForMonth(sourceCatalog.candidates || sourceCatalog.sources, target.month);
    if (!source) {
      const message = `No Nacht sheet source found for ${target.month}. Check the master sheet or Chatwork source.`;
      if (target.required) failed = true;
      results.push({
        month: target.month,
        reason: target.reason,
        status: "error",
        statusTypes: statusTypesForTarget(target, options),
        required: Boolean(target.required),
        message,
      });
      continue;
    }

    if (options.dryRun) {
      results.push({
        month: target.month,
        reason: target.reason,
        status: "ok",
        statusTypes: statusTypesForTarget(target, options),
        spreadsheetId: source.spreadsheetId,
        title: source.title || "",
        dryRun: true,
      });
      continue;
    }

    try {
      const sourceValidation = await validateSelectedSource({ source, month: target.month, options });
      const sourceAudit = await runUpdateData({
        month: target.month,
        spreadsheetId: source.spreadsheetId,
        defaultMonth,
        sourceMode: source.sourceType || "discovered",
        options,
      });
      const overallSalesSync = await trySyncOverallSalesTopRows({
        month: target.month,
        spreadsheetId: source.spreadsheetId,
      });
      const overallSalesFailed = overallSalesSync.status !== "ok";
      if (overallSalesFailed) failed = true;
      results.push({
        month: target.month,
        reason: target.reason,
        status: overallSalesFailed ? "error" : "ok",
        statusTypes: statusTypesForTarget(target, options),
        required: Boolean(target.required || overallSalesFailed),
        spreadsheetId: source.spreadsheetId,
        title: source.title || "",
        message: overallSalesFailed ? overallSalesSync.message || overallSalesSync.reason || "Overall sales sync failed" : null,
        sourceValidation,
        sourceAudit,
        overallSalesSync,
        dryRun: false,
      });
    } catch (error) {
      failed = true;
      results.push({
        month: target.month,
        reason: target.reason,
        status: "error",
        statusTypes: statusTypesForTarget(target, options),
        required: true,
        spreadsheetId: source.spreadsheetId,
        title: source.title || "",
        message: error.message,
      });
    }
  }

  return {
    plan,
    results,
    failed,
  };
}

async function trySyncOverallSalesTopRows({ month, spreadsheetId }) {
  try {
    return await syncOverallSalesTopRows({
      month,
      spreadsheetId,
      fetchWithTimeout,
    });
  } catch (error) {
    const result = {
      status: "warning",
      message: error.message,
    };
    console.warn(`overall-sales rows sync warning for ${month}: ${error.message}`);
    return result;
  }
}

async function writeUpdateStatus(statusPath, result) {
  const now = new Date().toISOString();
  const existing = await readExistingStatus(statusPath);
  const next = {
    generatedAt: now,
    daily: existing.daily || emptyUpdateStatus("daily"),
    monthly: existing.monthly || emptyUpdateStatus("monthly"),
    overallSales: existing.overallSales || emptyUpdateStatus("overallSales"),
    lastRun: {
      checkedAt: now,
      failed: Boolean(result.failed),
      skippedReason: result.skippedReason || null,
      fatalError: result.fatalError || null,
    },
  };

  const statusItems = result.fatalError
    ? dedupeTargets(result.plan?.targets || []).map((target) => ({
        month: target.month,
        reason: target.reason,
        status: "error",
        statusTypes: statusTypesForTarget(target, options),
        required: Boolean(target.required),
        message: result.fatalError.message,
      }))
    : result.results || [];

  for (const item of statusItems) {
    const status = item.status === "error" ? "error" : "ok";
    for (const type of item.statusTypes || statusTypesForReason(item.reason, options)) {
      next[type] = {
        status,
        checkedAt: now,
        month: item.month || null,
        reason: item.reason || null,
        message: status === "error" ? item.message || "Update failed" : null,
      };
    }
    if (item.overallSalesSync) {
      const overallSalesFailed = item.overallSalesSync.status !== "ok";
      next.overallSales = {
        status: overallSalesFailed ? "error" : "ok",
        checkedAt: now,
        month: item.month || null,
        reason: item.reason || null,
        message: overallSalesFailed ? item.overallSalesSync.message || item.overallSalesSync.reason || "Overall sales sync failed" : null,
      };
    }
  }

  await writeJson(statusPath, next);
}

async function writeUpdateLog(logPath, result) {
  const now = new Date().toISOString();
  const existing = await readExistingLog(logPath);
  const entry = {
    checkedAt: now,
    failed: Boolean(result.failed),
    skippedReason: result.skippedReason || null,
    fatalError: result.fatalError || null,
    targets: dedupeTargets(result.plan?.targets || []).map((target) => ({
      month: target.month,
      reason: target.reason,
      required: Boolean(target.required),
    })),
    results: await Promise.all((result.results || []).map(enrichLogResult)),
  };
  const entries = [entry, ...(existing.entries || [])].slice(0, 100);
  await writeJson(logPath, {
    generatedAt: now,
    entries,
  });
}

async function enrichLogResult(item) {
  const monthSummary = item.month ? await summarizeMonthData(`data/${item.month}.json`) : null;
  return {
    month: item.month || null,
    reason: item.reason || null,
    status: item.status || null,
    required: Boolean(item.required),
    spreadsheetId: item.spreadsheetId || null,
    title: item.title || "",
    message: item.message || null,
    overallSalesSync: item.overallSalesSync || null,
    sourceAudit: item.sourceAudit || null,
    sourceValidation: item.sourceValidation || null,
    data: monthSummary,
  };
}

async function summarizeMonthData(filePath) {
  try {
    const data = JSON.parse(await fs.readFile(filePath, "utf8"));
    return {
      records: Array.isArray(data.records) ? data.records.length : 0,
      projects: Array.isArray(data.projects) ? data.projects.length : 0,
      media: Array.isArray(data.media) ? data.media.length : 0,
      generatedAt: data.source?.generatedAt || null,
    };
  } catch {
    return null;
  }
}

async function readExistingLog(logPath) {
  try {
    return JSON.parse(await fs.readFile(logPath, "utf8"));
  } catch {
    return {};
  }
}

async function readExistingStatus(statusPath) {
  try {
    return JSON.parse(await fs.readFile(statusPath, "utf8"));
  } catch {
    return {};
  }
}

function emptyUpdateStatus(type) {
  return {
    status: "ok",
    checkedAt: null,
    month: null,
    reason: null,
    message: null,
    type,
  };
}

function statusTypesForTarget(target, options) {
  return statusTypesForReason(target?.reason, options);
}

function statusTypesForReason(reason, options) {
  const text = String(reason || "");
  const types = [];
  if (text.includes("daily")) types.push("daily");
  if (text.includes("monthly")) types.push("monthly");
  if (text.includes("requested_month")) {
    types.push(options.mode === "monthly" ? "monthly" : "daily");
  }
  if (!types.length) types.push(options.mode === "monthly" ? "monthly" : "daily");
  return [...new Set(types)];
}

function errorToPayload(error) {
  return {
    name: error?.name || "Error",
    message: error?.message || String(error),
  };
}

function buildUpdatePlan(options) {
  const today = getJstDateParts(options.runDate);
  const yesterday = addDays(today, -1);
  const requestedMonth = normalizeMonth(options.month);
  const targets = [];

  if (requestedMonth) {
    targets.push({ month: requestedMonth, reason: "requested_month", required: true });
    return { targets };
  }

  if (options.mode === "daily") {
    targets.push({ month: monthId(yesterday), reason: "daily_previous_day", required: true });
    return { targets };
  }

  if (options.mode === "monthly") {
    if (options.forceMonthly || isFirstBusinessDay(today)) {
      targets.push({
        month: monthId(today),
        reason: options.forceMonthly ? "monthly_forced" : "monthly_first_business_day",
        required: Boolean(options.forceMonthly),
      });
      return { targets };
    }
    return { targets, reason: `${formatYmd(today)} is not the first business day in JST` };
  }

  if (options.mode === "all") {
    targets.push({ month: monthId(yesterday), reason: "daily_previous_day", required: true });
    if (options.forceMonthly || isFirstBusinessDay(today)) {
      targets.push({
        month: monthId(today),
        reason: options.forceMonthly ? "monthly_forced" : "monthly_first_business_day",
        required: Boolean(options.forceMonthly),
      });
    }
    return { targets };
  }

  if (options.mode !== "scheduled") {
    throw new Error(`Unknown UPDATE_MODE: ${options.mode}`);
  }

  targets.push({ month: monthId(yesterday), reason: "daily_previous_day", required: true });
  if (isMonthlySchedule(options) && isFirstBusinessDay(today)) {
    targets.push({ month: monthId(today), reason: "monthly_first_business_day", required: false });
  }
  return { targets };
}

function isMonthlySchedule(options) {
  if (options.githubEventSchedule) return MONTHLY_SCHEDULE_CRONS.has(options.githubEventSchedule);
  return getJstHour(options.runDate) === 15;
}

function directSourceCatalog(spreadsheetId, targets, options) {
  const sources = targets.map((target) => ({
    month: target.month,
    spreadsheetId,
    title: "",
    sourceType: "direct",
    sourceLabel: "workflow_input",
    discoveredAt: new Date().toISOString(),
  }));
  return {
    sources,
    candidates: sources,
    manifest: {
      generatedAt: new Date().toISOString(),
      masterSpreadsheetId: options.masterSpreadsheetId,
      sources: [],
      warnings: [],
    },
  };
}

async function discoverSourceCatalog(options) {
  const warnings = [];
  const masterSources = await discoverFromMasterSheet(options, warnings);
  const chatworkSources = await discoverFromChatwork(options, warnings);
  const enriched = await enrichSourceTitles([...masterSources, ...chatworkSources], warnings);
  const sources = enriched
    .map((source) => ({
      ...source,
      month: source.month || inferMonth([source.title, source.context]),
    }))
    .filter((source) => source.month && source.spreadsheetId);

  const deduped = dedupeSources(sources);

  return {
    sources: deduped,
    candidates: sources,
    manifest: {
      generatedAt: new Date().toISOString(),
      masterSpreadsheetId: options.masterSpreadsheetId,
      masterSheetId: options.masterSheetId,
      chatworkRoomId: options.chatworkRoomId || null,
      sources: deduped,
      warnings,
    },
  };
}

async function discoverFromMasterSheet(options, warnings) {
  const metadata = await fetchSpreadsheetMetadata(options.masterSpreadsheetId);
  const sheet = metadata?.sheets?.find((item) => String(item.properties?.sheetId) === options.masterSheetId);
  const sheetTitle = sheet?.properties?.title || metadata?.sheets?.[0]?.properties?.title;
  if (!sheetTitle) {
    throw new Error(`Master sheet tab not found: gid ${options.masterSheetId}`);
  }

  const values = await fetchSheetValues(options.masterSpreadsheetId, sheetTitle, options.masterRange, {
    safeMaxRows: options.masterMaxRows,
  });
  const candidates = [];

  for (let rowIndex = 0; rowIndex < values.length; rowIndex += 1) {
    const row = values[rowIndex] || [];
    const rowText = row.map(normalize).filter(Boolean).join(" ");
    for (let colIndex = 0; colIndex < row.length; colIndex += 1) {
      const cell = normalize(row[colIndex]);
      if (!cell) continue;
      for (const spreadsheetId of extractSpreadsheetIds(cell)) {
        candidates.push({
          month: inferMonth([cell, rowText]),
          spreadsheetId,
          title: "",
          context: rowText,
          sourceType: "master_sheet",
          sourceLabel: `${sheetTitle}!${rowIndex + 1}:${colIndex + 1}`,
          rowIndex,
          colIndex,
          discoveredAt: new Date().toISOString(),
        });
      }
    }
  }

  if (!candidates.length) {
    warnings.push(`No spreadsheet links found in master sheet ${sheetTitle}`);
  }

  return candidates;
}

async function discoverFromChatwork(options, warnings) {
  const token = process.env.CHATWORK_API_TOKEN;
  if (!token || !options.chatworkRoomId) {
    warnings.push("Chatwork discovery skipped because CHATWORK_API_TOKEN or CHATWORK_ANALYSIS_ROOM_ID is not set");
    return [];
  }

  const url = new URL(`https://api.chatwork.com/v2/rooms/${options.chatworkRoomId}/messages`);
  url.searchParams.set("force", "1");

  const response = await fetchWithTimeout(url, {
    headers: {
      "X-ChatWorkToken": token,
    },
  });

  if (!response.ok) {
    warnings.push(`Chatwork discovery failed: ${response.status} ${await response.text()}`);
    return [];
  }

  const messages = await response.json();
  const candidates = [];
  for (const message of messages) {
    const body = normalize(message.body);
    if (!/\[(?:toall|To:all)\]/i.test(body)) continue;
    if (!/(ナハト|売上|総合売上)/.test(body)) continue;
    for (const spreadsheetId of extractSpreadsheetIds(body)) {
      candidates.push({
        month: inferMonth([body]),
        spreadsheetId,
        title: "",
        context: body,
        sourceType: "chatwork",
        sourceLabel: `message:${message.message_id}`,
        messageId: message.message_id,
        discoveredAt: new Date().toISOString(),
      });
    }
  }

  return candidates;
}

async function enrichSourceTitles(sources, warnings) {
  const titleCache = new Map();
  const enriched = [];

  for (const source of sources) {
    if (!titleCache.has(source.spreadsheetId)) {
      const metadata = await fetchSpreadsheetMetadata(source.spreadsheetId, warnings);
      titleCache.set(source.spreadsheetId, metadata?.properties?.title || "");
    }
    enriched.push({
      ...source,
      title: titleCache.get(source.spreadsheetId),
    });
  }

  return enriched;
}

async function fetchSpreadsheetMetadata(spreadsheetId, warnings = null) {
  const accessToken = await getGoogleAccessToken({ fetchWithTimeout });
  const url = new URL(`https://sheets.googleapis.com/v4/spreadsheets/${spreadsheetId}`);
  url.searchParams.set("fields", "spreadsheetId,properties.title,sheets.properties(sheetId,title,gridProperties(rowCount,columnCount))");

  const response = await fetchWithTimeout(url, {
    headers: {
      Authorization: `Bearer ${accessToken}`,
    },
  });

  if (!response.ok) {
    const message = `Google Sheets metadata ${spreadsheetId} failed: ${response.status} ${await response.text()}`;
    if (warnings) {
      warnings.push(message);
      return null;
    }
    throw new Error(message);
  }

  return response.json();
}

async function fetchSheetValues(spreadsheetId, sheetName, range, { safeMaxRows = 0 } = {}) {
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
  const values = payload.values || [];
  assertRangeCoverage(values, range, { spreadsheetId, sheetName, safeMaxRows });
  return values;
}

function dedupeSources(sources) {
  const byKey = new Map();
  for (const source of sources) {
    const key = `${source.month}:${source.spreadsheetId}`;
    const existing = byKey.get(key);
    if (!existing || sourcePriority(source) >= sourcePriority(existing)) {
      byKey.set(key, source);
    }
  }

  const byMonth = new Map();
  for (const source of byKey.values()) {
    const existing = byMonth.get(source.month);
    if (!existing || compareSources(source, existing) > 0) {
      byMonth.set(source.month, source);
    }
  }

  return [...byMonth.values()].sort((a, b) => a.month.localeCompare(b.month));
}

async function validateSelectedSource({ source, month, options }) {
  const metadata = await fetchSpreadsheetMetadata(source.spreadsheetId);
  return validateSourceMetadata({
    metadata,
    source,
    expectedMonth: month,
    requiredSheetNames: [options.sheetName, options.totalSheetName],
  });
}

function dedupeTargets(targets) {
  const byMonth = new Map();
  for (const target of targets) {
    const existing = byMonth.get(target.month);
    if (existing) {
      byMonth.set(target.month, {
        ...target,
        reason: `${existing.reason}+${target.reason}`,
        required: Boolean(existing.required || target.required),
      });
    } else {
      byMonth.set(target.month, target);
    }
  }
  return [...byMonth.values()].sort((a, b) => a.month.localeCompare(b.month));
}

async function resolveDefaultMonth(indexPath, targetMonths) {
  let months = [...targetMonths];
  try {
    const index = JSON.parse(await fs.readFile(indexPath, "utf8"));
    months = [...months, ...(index.months || []).map((month) => month.id), index.defaultMonth].filter(Boolean);
  } catch {
    // A missing index is fine on first generation.
  }
  return months.sort((a, b) => a.localeCompare(b)).at(-1) || targetMonths.at(-1);
}

async function runUpdateData({ month, spreadsheetId, defaultMonth, sourceMode, options }) {
  const dataPath = `data/${month}.json`;
  const backups = await createBackups([dataPath, options.indexPath]);
  try {
    await spawnUpdateData({ month, spreadsheetId, defaultMonth, sourceMode, options });
    await validateUpdatedMonth(dataPath, backups.get(dataPath));
    return await auditSourceSheet({
      month,
      spreadsheetId,
      detailSheetName: options.sheetName,
      totalSheetName: options.totalSheetName,
      range: options.sheetRange,
      generatedPath: dataPath,
      statusPath: options.sourceAuditStatusPath,
      safeMaxRows: options.sourceMaxRows,
      fetchWithTimeout,
    });
  } catch (error) {
    await restoreBackups(backups);
    throw error;
  }
}

async function spawnUpdateData({ month, spreadsheetId, defaultMonth, sourceMode, options }) {
  await new Promise((resolve, reject) => {
    const child = spawn(
      process.execPath,
      [
        "scripts/update-data.mjs",
        "--month",
        month,
        "--spreadsheetId",
        spreadsheetId,
        "--sheetName",
        options.sheetName,
        "--totalSheetName",
        options.totalSheetName,
        "--range",
        options.sheetRange,
        "--maxRows",
        String(options.sourceMaxRows),
        "--defaultMonth",
        defaultMonth,
      ],
      {
        stdio: "inherit",
        env: {
          ...process.env,
          SOURCE_MODE: sourceMode,
        },
      },
    );

    child.on("error", reject);
    child.on("exit", (code) => {
      if (code === 0) {
        resolve();
      } else {
        reject(new Error(`update-data.mjs failed for ${month} with exit code ${code}`));
      }
    });
  });
}

async function validateUpdatedMonth(dataPath, backup) {
  const next = JSON.parse(await fs.readFile(dataPath, "utf8"));
  const nextRecords = Array.isArray(next.records) ? next.records.length : 0;
  const previous = backup?.exists ? JSON.parse(backup.raw) : null;
  const previousRecords = Array.isArray(previous?.records) ? previous.records.length : 0;

  if (previousRecords > 0 && nextRecords === 0) {
    throw new Error(`${dataPath} update produced zero records; restored previous data`);
  }
  if (previousRecords >= 50 && nextRecords < previousRecords * 0.2) {
    throw new Error(
      `${dataPath} record count dropped from ${previousRecords} to ${nextRecords}; restored previous data`,
    );
  }
}

async function createBackups(filePaths) {
  const backups = new Map();
  for (const filePath of filePaths) {
    try {
      backups.set(filePath, {
        filePath,
        exists: true,
        raw: await fs.readFile(filePath, "utf8"),
      });
    } catch (error) {
      if (error.code !== "ENOENT") throw error;
      backups.set(filePath, { filePath, exists: false, raw: "" });
    }
  }
  return backups;
}

async function restoreBackups(backups) {
  for (const backup of backups.values()) {
    if (backup.exists) {
      await writeRawFile(backup.filePath, backup.raw);
    } else {
      await fs.rm(backup.filePath, { force: true });
    }
  }
}

async function writeRawFile(filePath, raw) {
  await fs.mkdir(path.dirname(filePath), { recursive: true });
  await fs.writeFile(filePath, raw);
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

function inferMonth(parts) {
  for (const part of parts) {
    const text = normalize(part);
    if (!text) continue;

    const jpMatch = text.match(/((?:19|20)\d{2})\s*年\s*(\d{1,2})\s*月/);
    if (jpMatch) return formatMonth(Number(jpMatch[1]), Number(jpMatch[2]));

    const numericMatch = text.match(/((?:19|20)\d{2})\s*[-/.年_]\s*(\d{1,2})(?:\s*月)?/);
    if (numericMatch) return formatMonth(Number(numericMatch[1]), Number(numericMatch[2]));

    const yearMatch = text.match(/((?:19|20)\d{2})/);
    const monthMatch = text.match(/(\d{1,2})\s*月(?:分)?/);
    if (yearMatch && monthMatch) return formatMonth(Number(yearMatch[1]), Number(monthMatch[1]));
  }

  return "";
}

function extractSpreadsheetIds(text) {
  const ids = new Set();
  for (const match of String(text).matchAll(/docs\.google\.com\/spreadsheets\/d\/([a-zA-Z0-9-_]+)/g)) {
    ids.add(match[1]);
  }
  return [...ids];
}

function normalizeMonth(value) {
  const text = normalize(value);
  if (!text) return "";
  const match = text.match(/^((?:19|20)\d{2})[-/年.](\d{1,2})/);
  if (!match) return "";
  return formatMonth(Number(match[1]), Number(match[2]));
}

function formatMonth(year, month) {
  if (!Number.isInteger(year) || !Number.isInteger(month) || month < 1 || month > 12) return "";
  return `${year}-${String(month).padStart(2, "0")}`;
}

function monthId(parts) {
  return formatMonth(parts.year, parts.month);
}

function isFirstBusinessDay(parts) {
  if (!isBusinessDay(parts)) return false;
  for (let day = 1; day < parts.day; day += 1) {
    if (isBusinessDay({ year: parts.year, month: parts.month, day })) return false;
  }
  return true;
}

function isBusinessDay(parts) {
  const weekday = weekdayOf(parts);
  if (weekday === 0 || weekday === 6) return false;
  return !japaneseHolidaySet(parts.year).has(formatYmd(parts));
}

function japaneseHolidaySet(year) {
  const holidays = new Set();
  addHoliday(holidays, year, 1, 1);
  addHoliday(holidays, year, 1, nthWeekdayOfMonth(year, 1, 1, 2));
  addHoliday(holidays, year, 2, 11);
  addHoliday(holidays, year, 2, 23);
  addHoliday(holidays, year, 3, vernalEquinoxDay(year));
  addHoliday(holidays, year, 4, 29);
  addHoliday(holidays, year, 5, 3);
  addHoliday(holidays, year, 5, 4);
  addHoliday(holidays, year, 5, 5);
  addHoliday(holidays, year, 7, nthWeekdayOfMonth(year, 7, 1, 3));
  addHoliday(holidays, year, 8, 11);
  addHoliday(holidays, year, 9, nthWeekdayOfMonth(year, 9, 1, 3));
  addHoliday(holidays, year, 9, autumnEquinoxDay(year));
  addHoliday(holidays, year, 10, nthWeekdayOfMonth(year, 10, 1, 2));
  addHoliday(holidays, year, 11, 3);
  addHoliday(holidays, year, 11, 23);

  for (const ymd of [...holidays].sort()) {
    const parts = parseYmd(ymd);
    if (weekdayOf(parts) !== 0) continue;
    let observed = addDays(parts, 1);
    while (holidays.has(formatYmd(observed))) {
      observed = addDays(observed, 1);
    }
    if (observed.year === year) holidays.add(formatYmd(observed));
  }

  for (let month = 1; month <= 12; month += 1) {
    const daysInMonth = new Date(Date.UTC(year, month, 0)).getUTCDate();
    for (let day = 2; day < daysInMonth; day += 1) {
      const parts = { year, month, day };
      const ymd = formatYmd(parts);
      if (holidays.has(ymd)) continue;
      if (weekdayOf(parts) === 0 || weekdayOf(parts) === 6) continue;
      if (holidays.has(formatYmd(addDays(parts, -1))) && holidays.has(formatYmd(addDays(parts, 1)))) {
        holidays.add(ymd);
      }
    }
  }

  return holidays;
}

function addHoliday(set, year, month, day) {
  set.add(formatYmd({ year, month, day }));
}

function nthWeekdayOfMonth(year, month, weekday, nth) {
  let count = 0;
  const daysInMonth = new Date(Date.UTC(year, month, 0)).getUTCDate();
  for (let day = 1; day <= daysInMonth; day += 1) {
    if (weekdayOf({ year, month, day }) === weekday) {
      count += 1;
      if (count === nth) return day;
    }
  }
  return 1;
}

function vernalEquinoxDay(year) {
  return Math.floor(20.8431 + 0.242194 * (year - 1980) - Math.floor((year - 1980) / 4));
}

function autumnEquinoxDay(year) {
  return Math.floor(23.2488 + 0.242194 * (year - 1980) - Math.floor((year - 1980) / 4));
}

function getJstDateParts(date) {
  const parts = new Intl.DateTimeFormat("en-CA", {
    timeZone: JST_TIME_ZONE,
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

function getJstHour(date) {
  const parts = new Intl.DateTimeFormat("en-GB", {
    timeZone: JST_TIME_ZONE,
    hour: "2-digit",
    hour12: false,
  }).formatToParts(date);
  const hour = parts.find((part) => part.type === "hour")?.value || "0";
  return Number(hour);
}

function addDays(parts, amount) {
  const date = new Date(Date.UTC(parts.year, parts.month - 1, parts.day + amount));
  return {
    year: date.getUTCFullYear(),
    month: date.getUTCMonth() + 1,
    day: date.getUTCDate(),
  };
}

function weekdayOf(parts) {
  return new Date(Date.UTC(parts.year, parts.month - 1, parts.day)).getUTCDay();
}

function parseYmd(value) {
  const [year, month, day] = value.split("-").map(Number);
  return { year, month, day };
}

function formatYmd(parts) {
  return `${parts.year}-${String(parts.month).padStart(2, "0")}-${String(parts.day).padStart(2, "0")}`;
}

function parseRunDate(value) {
  if (!value) return new Date();
  if (/^\d{4}-\d{2}-\d{2}$/.test(value)) return new Date(`${value}T15:00:00+09:00`);
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) throw new Error(`Invalid RUN_DATE: ${value}`);
  return date;
}

async function writeJson(filePath, value) {
  await fs.mkdir(path.dirname(filePath), { recursive: true });
  await fs.writeFile(filePath, `${JSON.stringify(value, null, 2)}\n`);
}

function quoteSheetName(sheetName) {
  return `'${sheetName.replaceAll("'", "''")}'`;
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

function toBoolean(value) {
  if (typeof value === "boolean") return value;
  return ["1", "true", "yes", "on"].includes(String(value || "").toLowerCase());
}

function normalize(value) {
  return String(value ?? "").replace(/\s+/g, " ").trim();
}
