import crypto from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import process from "node:process";
import { spawn } from "node:child_process";

const DEFAULT_MASTER_SPREADSHEET_ID = "1Xk-p_-6Np-e5keqOy5fcgmU-TF28H5dU7UeEYDUX_7k";
const DEFAULT_MASTER_SHEET_ID = "2127655846";
const DEFAULT_MASTER_RANGE = "A1:ZZ2000";
const DEFAULT_SHEET_NAME = "◆案件媒体別日次_全体";
const DEFAULT_TOTAL_SHEET_NAME = "◆案件別日次_全体_固定用";
const DEFAULT_SHEET_RANGE = "A1:ZZ3000";
const JST_TIME_ZONE = "Asia/Tokyo";
const MONTHLY_SCHEDULE_CRON = "0 6 * * *";

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
  indexPath: args.index || process.env.INDEX_FILE || "data/index.json",
  sourceManifestPath: args.sourceManifest || process.env.SOURCE_MANIFEST || "data/sheet-sources.json",
  chatworkRoomId: args.chatworkRoomId || process.env.CHATWORK_ANALYSIS_ROOM_ID || process.env.CHATWORK_ROOM_ID_ANALYSIS || "",
  githubEventSchedule: process.env.GITHUB_EVENT_SCHEDULE || "",
};

await main();

async function main() {
  const plan = buildUpdatePlan(options);
  if (!plan.targets.length) {
    console.log(JSON.stringify({ skipped: true, reason: plan.reason }, null, 2));
    return;
  }

  const sourceCatalog = options.spreadsheetId
    ? directSourceCatalog(options.spreadsheetId, plan.targets, options)
    : await discoverSourceCatalog(options);

  if (!options.spreadsheetId) {
    await writeJson(options.sourceManifestPath, sourceCatalog.manifest);
  }

  const defaultMonth = await resolveDefaultMonth(options.indexPath, plan.targets.map((target) => target.month));
  const results = [];

  for (const target of dedupeTargets(plan.targets)) {
    const source = selectSourceForMonth(sourceCatalog.sources, target.month);
    if (!source) {
      const message = `No Nacht sheet source found for ${target.month}. Check the master sheet or Chatwork source.`;
      if (target.required) {
        throw new Error(message);
      }
      results.push({
        month: target.month,
        reason: target.reason,
        skipped: true,
        message,
      });
      continue;
    }

    if (options.dryRun) {
      results.push({
        month: target.month,
        reason: target.reason,
        spreadsheetId: source.spreadsheetId,
        title: source.title || "",
        dryRun: true,
      });
      continue;
    }

    await runUpdateData({
      month: target.month,
      spreadsheetId: source.spreadsheetId,
      defaultMonth,
      sourceMode: source.sourceType || "discovered",
      options,
    });
    results.push({
      month: target.month,
      reason: target.reason,
      spreadsheetId: source.spreadsheetId,
      title: source.title || "",
      dryRun: false,
    });
  }

  console.log(JSON.stringify({ updated: results }, null, 2));
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
  if (options.githubEventSchedule) return options.githubEventSchedule === MONTHLY_SCHEDULE_CRON;
  return getJstHour(options.runDate) === 15;
}

function directSourceCatalog(spreadsheetId, targets, options) {
  return {
    sources: targets.map((target) => ({
      month: target.month,
      spreadsheetId,
      title: "",
      sourceType: "direct",
      sourceLabel: "workflow_input",
      discoveredAt: new Date().toISOString(),
    })),
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

  const values = await fetchSheetValues(options.masterSpreadsheetId, sheetTitle, options.masterRange);
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

  const response = await fetch(url, {
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
  const accessToken = await getAccessToken();
  const url = new URL(`https://sheets.googleapis.com/v4/spreadsheets/${spreadsheetId}`);
  url.searchParams.set("fields", "properties.title,sheets.properties(sheetId,title)");

  const response = await fetch(url, {
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

async function fetchSheetValues(spreadsheetId, sheetName, range) {
  const accessToken = await getAccessToken();
  const sheetRange = `${quoteSheetName(sheetName)}!${range}`;
  const url = new URL(`https://sheets.googleapis.com/v4/spreadsheets/${spreadsheetId}/values/${encodeURIComponent(sheetRange)}`);
  url.searchParams.set("valueRenderOption", "FORMATTED_VALUE");
  url.searchParams.set("dateTimeRenderOption", "FORMATTED_STRING");

  const response = await fetch(url, {
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

function selectSourceForMonth(sources, month) {
  return sources.find((source) => source.month === month) || null;
}

function sourcePriority(source) {
  if (source.sourceType === "master_sheet") return 3;
  if (source.sourceType === "chatwork") return 2;
  if (source.sourceType === "direct") return 4;
  return 1;
}

function compareSources(a, b) {
  const priorityDelta = sourcePriority(a) - sourcePriority(b);
  if (priorityDelta !== 0) return priorityDelta;
  return Number(a.rowIndex || 0) - Number(b.rowIndex || 0);
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
    return JSON.parse(process.env.GOOGLE_SERVICE_ACCOUNT_JSON);
  }

  if (process.env.GOOGLE_CLIENT_EMAIL && process.env.GOOGLE_PRIVATE_KEY) {
    return {
      client_email: process.env.GOOGLE_CLIENT_EMAIL,
      private_key: process.env.GOOGLE_PRIVATE_KEY.replaceAll("\\n", "\n"),
    };
  }

  throw new Error("GOOGLE_SERVICE_ACCOUNT_JSON or GOOGLE_CLIENT_EMAIL/GOOGLE_PRIVATE_KEY is required");
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

function base64Url(input) {
  const buffer = Buffer.isBuffer(input) ? input : Buffer.from(input);
  return buffer.toString("base64").replaceAll("+", "-").replaceAll("/", "_").replaceAll("=", "");
}
