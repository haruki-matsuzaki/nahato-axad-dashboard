import { buildExternalMonitorAlertMessage } from "../scripts/automation-alert-message.mjs";
import { isChatworkAlertEnabled } from "../scripts/chatwork-alert-policy.mjs";
import { getMonthBootstrapState } from "../scripts/jst-business-calendar.mjs";

const DEFAULT_RAW_BASE_URL = "https://raw.githubusercontent.com/haruki-matsuzaki/nahato-axad-dashboard/main";
const DEFAULT_PRODUCTION_ORIGIN = "https://nahato-axad-dashboard.pages.dev";
const DEFAULT_CHATWORK_ROOM_ID = "398449612";
const DEFAULT_GITHUB_REPOSITORY = "haruki-matsuzaki/nahato-axad-dashboard";
const DEFAULT_GITHUB_BRANCH = "main";
const DEFAULT_UPDATE_WORKFLOW = "update-data.yml";
const JST_OFFSET_MS = 9 * 60 * 60 * 1000;
const DEPLOY_STALE_TOLERANCE_MS = 15 * 60 * 1000;
const UPDATE_WINDOW_SLOP_MS = 2 * 60 * 1000;
const ACTIVE_RUN_STATUSES = new Set(["queued", "in_progress", "waiting", "requested", "pending"]);
const RECOVERABLE_ISSUES = new Set([
  "expected_month_missing",
  "previous_day_missing_from_both_sources",
  "overall_sales_previous_day_missing",
  "detail_previous_day_missing",
]);

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

  async scheduled(controller, env, context) {
    const scheduledAt = Number.isFinite(controller?.scheduledTime)
      ? new Date(controller.scheduledTime)
      : new Date();
    context.waitUntil(runScheduledMonitor(env, { enforceSchedule: true, now: scheduledAt }));
  },
};

export async function runScheduledMonitor(env, { enforceSchedule = false, now = new Date() } = {}) {
  if (enforceSchedule && !isScheduledMonitorTime(now)) {
    return {
      status: "skipped",
      checkedAt: now.toISOString(),
      expectedDate: previousJstDate(now),
      issues: [],
      reason: "outside_scheduled_monitor_time",
    };
  }

  const bootstrap = getMonthBootstrapState(now);
  if (bootstrap.active) {
    return {
      status: "pending",
      checkedAt: now.toISOString(),
      expectedDate: previousJstDate(now),
      expectedMonth: bootstrap.targetMonth,
      issues: [],
      reason: "month_source_pending",
      readyAtJst: bootstrap.readyAtJst,
    };
  }

  let health;
  try {
    health = await inspectDataHealth(env, now);
  } catch (error) {
    health = {
      status: "error",
      expectedDate: previousJstDate(now),
      issues: ["external_monitor_request_failed"],
      analysis: sanitize(error?.message || String(error)),
    };
  }

  if (health.status === "ok") return health;

  if (health.issues?.some((issue) => RECOVERABLE_ISSUES.has(issue))) {
    const recovery = await recoverMissedUpdate(env, { now });
    health = { ...health, recovery };

    if (["active", "dispatched"].includes(recovery.status)) {
      return { ...health, status: "recovering" };
    }

    if (recovery.status === "success") {
      return {
        ...health,
        status: "ok",
        issues: [],
        reason: "source_unchanged_after_successful_sync",
      };
    }

    if (recovery.status === "failed") {
      return {
        ...health,
        reason: "update_workflow_already_reported_failure",
      };
    }

    health = {
      ...health,
      issues: [...new Set([...(health.issues || []), "workflow_dispatch_failed"])],
      analysis: recovery.message,
    };
  }

  await sendChatworkAlert(env, health);
  return health;
}

export async function recoverMissedUpdate(
  env,
  { now = new Date(), fetchImpl = fetch, waitImpl = sleep } = {},
) {
  const window = buildUpdateWindow(now);
  if (!window) {
    return {
      status: "unavailable",
      code: "update_window_not_found",
      message: "更新対象の定時枠を特定できませんでした。",
    };
  }

  const token = String(env.GITHUB_ACTIONS_TOKEN || "").trim();
  if (!token) {
    return {
      status: "unavailable",
      code: "github_actions_token_missing",
      message: "Cloudflare WorkerのGITHUB_ACTIONS_TOKENが未設定です。",
      expectedRunAtJst: window.expectedRunAtJst,
    };
  }

  const repository = env.GITHUB_REPOSITORY || DEFAULT_GITHUB_REPOSITORY;
  const branch = env.GITHUB_BRANCH || DEFAULT_GITHUB_BRANCH;
  const workflow = env.GITHUB_UPDATE_WORKFLOW || DEFAULT_UPDATE_WORKFLOW;
  const baseUrl = `https://api.github.com/repos/${repository}/actions/workflows/${encodeURIComponent(workflow)}`;

  try {
    const payload = await fetchGithubJson(
      `${baseUrl}/runs?branch=${encodeURIComponent(branch)}&per_page=30`,
      token,
      { fetchImpl, waitImpl },
    );
    const relevantRuns = (payload.workflow_runs || [])
      .filter((run) => {
        const createdAt = Date.parse(run.created_at || "");
        return Number.isFinite(createdAt) && createdAt >= window.windowStartUtc;
      })
      .sort((a, b) => Date.parse(b.created_at || "") - Date.parse(a.created_at || ""));

    const activeRun = relevantRuns.find((run) => ACTIVE_RUN_STATUSES.has(run.status));
    if (activeRun) {
      return {
        status: "active",
        expectedRunAtJst: window.expectedRunAtJst,
        runUrl: activeRun.html_url || null,
      };
    }

    const successfulRun = relevantRuns.find(
      (run) => run.status === "completed" && run.conclusion === "success",
    );
    if (successfulRun) {
      return {
        status: "success",
        expectedRunAtJst: window.expectedRunAtJst,
        runUrl: successfulRun.html_url || null,
      };
    }

    const failedRun = relevantRuns.find(
      (run) =>
        run.status === "completed" &&
        ["failure", "cancelled", "timed_out", "action_required", "startup_failure"].includes(run.conclusion),
    );
    if (failedRun) {
      return {
        status: "failed",
        expectedRunAtJst: window.expectedRunAtJst,
        runUrl: failedRun.html_url || null,
        conclusion: failedRun.conclusion,
      };
    }

    await fetchGithubJson(`${baseUrl}/dispatches`, token, {
      method: "POST",
      body: JSON.stringify({
        ref: branch,
        inputs: {
          mode: "daily",
          force_monthly: "false",
        },
      }),
      expectNoContent: true,
      fetchImpl,
      waitImpl,
    });

    return {
      status: "dispatched",
      expectedRunAtJst: window.expectedRunAtJst,
    };
  } catch (error) {
    return {
      status: "error",
      code: "github_workflow_dispatch_failed",
      message: sanitize(error?.message || String(error)),
      expectedRunAtJst: window.expectedRunAtJst,
    };
  }
}

export function buildUpdateWindow(now = new Date()) {
  if (!(now instanceof Date) || Number.isNaN(now.getTime())) return null;
  const jst = new Date(now.getTime() + JST_OFFSET_MS);
  const hour = jst.getUTCHours();
  const scheduledHour = hour >= 19 ? 18 : hour >= 16 ? 15 : hour >= 13 ? 12 : null;
  if (scheduledHour === null) return null;

  const year = jst.getUTCFullYear();
  const monthIndex = jst.getUTCMonth();
  const day = jst.getUTCDate();
  const scheduledUtc = Date.UTC(year, monthIndex, day, scheduledHour - 9, 0, 0, 0);
  return {
    expectedRunAtJst: `${year}-${String(monthIndex + 1).padStart(2, "0")}-${String(day).padStart(
      2,
      "0",
    )} ${String(scheduledHour).padStart(2, "0")}:00`,
    windowStartUtc: scheduledUtc - UPDATE_WINDOW_SLOP_MS,
  };
}

export async function runLocalExternalMonitor(env, { now = new Date() } = {}) {
  if (!isLocalExternalMonitorTime(now)) {
    return {
      status: "skipped",
      checkedAt: now.toISOString(),
      expectedDate: previousJstDate(now),
      issues: [],
      reason: "outside_local_monitor_time",
    };
  }
  return runScheduledMonitor(env, { now });
}

export function isScheduledMonitorTime(now = new Date()) {
  if (!(now instanceof Date) || Number.isNaN(now.getTime())) return false;
  const jst = new Date(now.getTime() + JST_OFFSET_MS);
  return jst.getUTCMinutes() === 30 && [13, 16, 19].includes(jst.getUTCHours());
}

export function isLocalExternalMonitorTime(now = new Date()) {
  if (!(now instanceof Date) || Number.isNaN(now.getTime())) return false;
  const jst = new Date(now.getTime() + JST_OFFSET_MS);
  const minutes = jst.getUTCHours() * 60 + jst.getUTCMinutes();
  return minutes >= 12 * 60 + 30 && minutes <= 20 * 60 + 30;
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
  if (!isChatworkAlertEnabled()) return;
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

async function fetchGithubJson(
  url,
  token,
  {
    method = "GET",
    body,
    expectNoContent = false,
    fetchImpl = fetch,
    waitImpl = sleep,
    maxRetries = 2,
  } = {},
) {
  for (let attempt = 0; attempt <= maxRetries; attempt += 1) {
    const response = await fetchImpl(url, {
      method,
      headers: {
        Accept: "application/vnd.github+json",
        Authorization: `Bearer ${token}`,
        "Content-Type": "application/json",
        "User-Agent": "nacht-axad-external-monitor/1.0",
        "X-GitHub-Api-Version": "2022-11-28",
      },
      body,
    });

    if (expectNoContent && [201, 202, 204].includes(response.status)) return {};

    const text = await response.text();
    if (response.ok) return text ? JSON.parse(text) : {};

    const transient = response.status === 429 || response.status >= 500;
    if (!transient || attempt >= maxRetries) {
      throw new Error(`GitHub API ${method} ${response.status}: ${sanitize(text)}`);
    }
    await waitImpl(1000 * 2 ** attempt);
  }

  throw new Error("GitHub APIの再試行が完了しませんでした。");
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

function sleep(delayMs) {
  return new Promise((resolve) => setTimeout(resolve, delayMs));
}

function jsonResponse(value, status = 200) {
  return new Response(`${JSON.stringify(value, null, 2)}\n`, {
    status,
    headers: { "Content-Type": "application/json; charset=utf-8", "Cache-Control": "no-store" },
  });
}
