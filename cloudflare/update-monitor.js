import { buildExternalMonitorAlertMessage } from "../scripts/automation-alert-message.mjs";

const DEFAULT_RAW_BASE_URL = "https://raw.githubusercontent.com/haruki-matsuzaki/nahato-axad-dashboard/main";
const DEFAULT_PRODUCTION_ORIGIN = "https://nahato-axad-dashboard.pages.dev";
const DEFAULT_CHATWORK_ROOM_ID = "398449612";
const JST_OFFSET_MS = 9 * 60 * 60 * 1000;
const DEPLOY_STALE_TOLERANCE_MS = 15 * 60 * 1000;

export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    if (request.method !== "GET" || url.pathname !== "/health") {
      return jsonResponse({ status: "not_found" }, 404);
    }

    try {
      const health = await inspectDataHealth(env);
      return jsonResponse({
        status: health.status,
        checkedAt: health.checkedAt,
        expectedDate: health.expectedDate,
      });
    } catch (error) {
      return jsonResponse({ status: "error", message: sanitize(error?.message || String(error)) }, 500);
    }
  },

  async scheduled(_controller, env, context) {
    context.waitUntil(runScheduledMonitor(env));
  },
};

export async function runScheduledMonitor(env) {
  let health;
  try {
    health = await inspectDataHealth(env);
  } catch (error) {
    health = {
      status: "error",
      expectedDate: previousJstDate(new Date()),
      issues: ["external_monitor_request_failed"],
      analysis: sanitize(error?.message || String(error)),
    };
  }

  if (health.status === "ok") return health;
  await sendChatworkAlert(env, health);
  return health;
}

export async function inspectDataHealth(env, now = new Date()) {
  const rawBaseUrl = trimTrailingSlash(env.RAW_BASE_URL || DEFAULT_RAW_BASE_URL);
  const productionOrigin = trimTrailingSlash(env.PRODUCTION_ORIGIN || DEFAULT_PRODUCTION_ORIGIN);
  const expectedDate = previousJstDate(now);
  const month = expectedDate.slice(0, 7);
  const cacheBust = `monitor=${now.getTime()}`;

  const [index, updateStatus, qualityStatus, monthData, overallSales, productionStatus] = await Promise.all([
    fetchJson(`${rawBaseUrl}/data/index.json?${cacheBust}`),
    fetchJson(`${rawBaseUrl}/data/update-status.json?${cacheBust}`),
    fetchOptionalJson(`${rawBaseUrl}/data/data-quality-status.json?${cacheBust}`),
    fetchJson(`${rawBaseUrl}/data/${month}.json?${cacheBust}`),
    fetchJson(`${rawBaseUrl}/data/overall-sales-${month}.json?${cacheBust}`),
    fetchOptionalJson(`${productionOrigin}/data/update-status.json?${cacheBust}`),
  ]);

  return evaluateHealth({
    now,
    index,
    updateStatus,
    qualityStatus,
    monthData,
    overallSales,
    productionStatus,
  });
}

export function evaluateHealth({ now = new Date(), index, updateStatus, qualityStatus, monthData, overallSales, productionStatus }) {
  const expectedDate = previousJstDate(now);
  const expectedMonth = expectedDate.slice(0, 7);
  const issues = [];
  const meaningfulRows = (monthData?.records || []).filter(
    (record) => record.date === expectedDate && record.media === "全体" && hasRecordValue(record),
  );
  const detailProjects = new Set(meaningfulRows.map((record) => normalize(record.project)).filter(Boolean));
  const overallDay = extractOverallDay(overallSales, expectedDate);
  const detailHasData = meaningfulRows.length > 0;
  const overallHasData = [overallDay.sales, overallDay.grossProfit, overallDay.cost].some((value) => finiteNumber(value) !== 0);

  if (!index?.months?.some((item) => item.id === expectedMonth)) issues.push("expected_month_missing");
  if (!detailHasData && !overallHasData) issues.push("previous_day_missing_from_both_sources");
  if (detailHasData && !overallHasData) issues.push("overall_sales_previous_day_missing");
  if (!detailHasData && overallHasData) issues.push("detail_previous_day_missing");
  if (qualityStatus?.status === "error") issues.push("data_quality_error");

  const rawUpdatedAt = latestTimestamp(
    updateStatus?.daily?.checkedAt,
    monthData?.source?.generatedAt,
    overallSales?.source?.overallRowsSyncedAt,
    overallSales?.source?.topRowsSyncedAt,
  );
  const productionUpdatedAt = latestTimestamp(productionStatus?.daily?.checkedAt, productionStatus?.generatedAt);
  if (
    productionStatus &&
    rawUpdatedAt &&
    (!productionUpdatedAt || productionUpdatedAt + DEPLOY_STALE_TOLERANCE_MS < rawUpdatedAt)
  ) {
    issues.push("production_deploy_stale");
  }

  return {
    status: issues.length ? "error" : "ok",
    checkedAt: now.toISOString(),
    expectedDate,
    expectedMonth,
    issues,
    detail: {
      hasData: detailHasData,
      records: meaningfulRows.length,
      projects: detailProjects.size,
    },
    overallSales: {
      hasData: overallHasData,
      sales: overallDay.sales,
      grossProfit: overallDay.grossProfit,
      cost: overallDay.cost,
    },
    sourceUpdatedAt: rawUpdatedAt ? new Date(rawUpdatedAt).toISOString() : null,
    productionUpdatedAt: productionUpdatedAt ? new Date(productionUpdatedAt).toISOString() : null,
  };
}

function extractOverallDay(overallSales, targetDate) {
  const rows = overallSales?.rows || [];
  const targetMonth = targetDate.slice(0, 7);
  const header = rows
    .slice(0, 12)
    .map((row) => ({
      row,
      dates: (row.cells || [])
        .map((cell) => ({ column: columnLetters(cell.address), date: parseDateLabel(cell.text ?? cell.value, targetMonth) }))
        .filter((item) => item.column && item.date),
    }))
    .sort((a, b) => b.dates.length - a.dates.length)[0];
  const targetColumn = header?.dates?.find((item) => item.date === targetDate)?.column;
  if (!targetColumn) return emptyOverallDay();

  const values = emptyOverallDay();
  for (const [label, key] of [
    ["売上", "sales"],
    ["粗利", "grossProfit"],
    ["消化金額", "cost"],
  ]) {
    const row = rows.slice(0, 16).find((candidate) =>
      (candidate.cells || []).some((cell) => normalize(cell.text ?? cell.value) === label),
    );
    const cell = (row?.cells || []).find((candidate) => columnLetters(candidate.address) === targetColumn);
    values[key] = parseNumber(cell?.value ?? cell?.text);
  }
  return values;
}

function emptyOverallDay() {
  return { sales: 0, grossProfit: 0, cost: 0 };
}

async function sendChatworkAlert(env, health) {
  if (!env.CHATWORK_API_TOKEN) throw new Error("CHATWORK_API_TOKEN is not configured for the external monitor");
  const roomId = env.CHATWORK_ALERT_ROOM_ID || DEFAULT_CHATWORK_ROOM_ID;
  const actionsUrl = "https://github.com/haruki-matsuzaki/nahato-axad-dashboard/actions/workflows/update-data.yml";
  const message = buildExternalMonitorAlertMessage(health, { actionsUrl });
  const body = `[info][title]${message.subject}[/title]${message.body}[/info]`;
  const response = await fetch(`https://api.chatwork.com/v2/rooms/${encodeURIComponent(roomId)}/messages`, {
    method: "POST",
    headers: {
      "X-ChatWorkToken": env.CHATWORK_API_TOKEN,
      "Content-Type": "application/x-www-form-urlencoded",
    },
    body: new URLSearchParams({ body, self_unread: "1" }),
  });
  if (!response.ok) throw new Error(`Chatwork alert failed: ${response.status}`);
}

async function fetchJson(url) {
  const response = await fetch(url, {
    headers: { Accept: "application/json", "User-Agent": "nacht-axad-external-monitor/1.0" },
  });
  if (!response.ok) throw new Error(`${url}: ${response.status}`);
  const text = await response.text();
  try {
    return JSON.parse(text);
  } catch {
    throw new Error(`${url}: JSON response expected`);
  }
}

async function fetchOptionalJson(url) {
  try {
    return await fetchJson(url);
  } catch {
    return null;
  }
}

function previousJstDate(date) {
  const shifted = new Date(date.getTime() + JST_OFFSET_MS - 24 * 60 * 60 * 1000);
  return shifted.toISOString().slice(0, 10);
}

function parseDateLabel(value, month) {
  const match = normalize(value).match(/^(\d{1,2})\/(\d{1,2})(?:\D|$)/);
  if (!match) return "";
  const [year] = month.split("-");
  return `${year}-${String(Number(match[1])).padStart(2, "0")}-${String(Number(match[2])).padStart(2, "0")}`;
}

function hasRecordValue(record) {
  return [record?.sales, record?.grossProfit, record?.cost, record?.cv].some((value) => finiteNumber(value) !== 0);
}

function latestTimestamp(...values) {
  const timestamps = values.map((value) => Date.parse(value || "")).filter(Number.isFinite);
  return timestamps.length ? Math.max(...timestamps) : null;
}

function columnLetters(address) {
  return String(address || "").match(/^[A-Z]+/i)?.[0]?.toUpperCase() || "";
}

function parseNumber(value) {
  if (typeof value === "number") return Number.isFinite(value) ? value : 0;
  const text = normalize(value).replaceAll(",", "").replaceAll("¥", "");
  const number = Number(text.replace(/%$/, ""));
  return Number.isFinite(number) ? number : 0;
}

function finiteNumber(value) {
  const number = Number(value);
  return Number.isFinite(number) ? number : 0;
}

function normalize(value) {
  return String(value ?? "").replace(/\s+/g, " ").trim();
}

function trimTrailingSlash(value) {
  return String(value || "").replace(/\/+$/, "");
}

function sanitize(value) {
  return String(value || "").replace(/\s+/g, " ").slice(0, 240);
}

function jsonResponse(value, status = 200) {
  return new Response(`${JSON.stringify(value, null, 2)}\n`, {
    status,
    headers: { "Content-Type": "application/json; charset=utf-8", "Cache-Control": "no-store" },
  });
}
