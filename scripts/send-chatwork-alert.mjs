import fs from "node:fs/promises";
import process from "node:process";

const args = parseArgs(process.argv.slice(2));
const options = {
  reason: args.reason || process.env.ALERT_REASON || "update_failed",
  statusPath: args.status || process.env.UPDATE_STATUS_FILE || "data/update-status.json",
  qualityPath: args.quality || process.env.DATA_QUALITY_STATUS_FILE || "data/data-quality-status.json",
  triggerPath: args.trigger || process.env.UPDATE_TRIGGER_FILE || "data/update-trigger.json",
  chatworkToken: process.env.CHATWORK_API_TOKEN || "",
  chatworkRoomId: process.env.CHATWORK_ALERT_ROOM_ID || process.env.CHATWORK_ROOM_ID || "398449612",
  dryRun: toBoolean(args.dryRun || process.env.ALERT_DRY_RUN),
};

const result = await sendAlert(options);
console.log(JSON.stringify(result, null, 2));
if (result.status === "error") process.exitCode = 1;

async function sendAlert(options) {
  const context = await buildAlertContext(options);
  const subject = subjectForContext(context);
  const body = bodyForContext(context);
  if (options.dryRun) {
    return {
      status: "ok",
      channel: "chatwork",
      dryRun: true,
      roomId: options.chatworkRoomId,
      subject,
      body,
    };
  }
  return sendChatworkAlert(options, subject, body);
}

async function sendChatworkAlert(options, subject, body) {
  if (!options.chatworkToken || !options.chatworkRoomId) {
    return {
      status: "error",
      channel: "chatwork",
      reason: "missing_chatwork_credentials",
      message: "CHATWORK_API_TOKEN and CHATWORK_ALERT_ROOM_ID are required.",
    };
  }

  const url = new URL(`https://api.chatwork.com/v2/rooms/${encodeURIComponent(options.chatworkRoomId)}/messages`);
  const payload = new URLSearchParams({
    body: `[info][title]${subject}[/title]${body}[/info]`,
    self_unread: "1",
  });
  let response;
  try {
    response = await fetch(url, {
      method: "POST",
      headers: {
        "X-ChatWorkToken": options.chatworkToken,
        "Content-Type": "application/x-www-form-urlencoded",
      },
      body: payload,
    });
  } catch (error) {
    return {
      status: "error",
      channel: "chatwork",
      reason: "chatwork_request_failed",
      roomId: options.chatworkRoomId,
      message: sanitizeOutput(error?.message || String(error)),
    };
  }

  if (!response.ok) {
    return {
      status: "error",
      channel: "chatwork",
      reason: "chatwork_send_failed",
      roomId: options.chatworkRoomId,
      message: sanitizeOutput(`${response.status} ${await response.text()}`),
    };
  }

  const result = await response.json().catch(() => ({}));
  return {
    status: "ok",
    channel: "chatwork",
    roomId: options.chatworkRoomId,
    messageId: result.message_id || null,
  };
}

async function buildAlertContext(options) {
  const [updateStatus, qualityStatus, trigger] = await Promise.all([
    readOptionalJson(options.statusPath),
    readOptionalJson(options.qualityPath),
    readOptionalJson(options.triggerPath),
  ]);
  return {
    reason: options.reason,
    updateStatus,
    qualityStatus,
    trigger,
    workflow: process.env.GITHUB_WORKFLOW || "",
    repository: process.env.GITHUB_REPOSITORY || "",
    runId: process.env.GITHUB_RUN_ID || "",
    runAttempt: process.env.GITHUB_RUN_ATTEMPT || "",
    sha: process.env.GITHUB_SHA || "",
    runUrl:
      process.env.GITHUB_SERVER_URL && process.env.GITHUB_REPOSITORY && process.env.GITHUB_RUN_ID
        ? `${process.env.GITHUB_SERVER_URL}/${process.env.GITHUB_REPOSITORY}/actions/runs/${process.env.GITHUB_RUN_ID}`
        : "",
  };
}

function subjectForContext(context) {
  const label = {
    update_failed: "日次更新エラー",
    schedule_monitor_triggered: "定時更新の再実行を起動",
    deploy_failed: "デプロイ確認エラー",
  }[context.reason] || "通知";
  return `[ナハト版AXAD] ${label}`;
}

function bodyForContext(context) {
  const lines = [
    "ナハト版AXADの自動化で確認が必要です。",
    "",
    `理由: ${context.reason}`,
    context.workflow ? `Workflow: ${context.workflow}` : "",
    context.repository ? `Repository: ${context.repository}` : "",
    context.sha ? `Commit: ${context.sha}` : "",
    context.runUrl ? `Actions: ${context.runUrl}` : "",
    context.runAttempt ? `Attempt: ${context.runAttempt}` : "",
    "",
    "Update status:",
    formatUpdateStatus(context.updateStatus),
    "",
    "Data quality:",
    formatQualityStatus(context.qualityStatus),
  ];

  if (context.trigger?.reason || context.trigger?.analysis) {
    lines.push("", "Monitor trigger:", `Reason: ${context.trigger.reason || ""}`, `Analysis: ${context.trigger.analysis || ""}`);
  }

  return lines.filter((line) => line !== "").join("\n");
}

function formatUpdateStatus(status) {
  if (!status) return "- data/update-status.json could not be read";
  return [
    `- generatedAt: ${status.generatedAt || ""}`,
    `- daily: ${status.daily?.status || ""} ${status.daily?.month || ""} ${status.daily?.message || ""}`.trim(),
    `- monthly: ${status.monthly?.status || ""} ${status.monthly?.month || ""} ${status.monthly?.message || ""}`.trim(),
    `- overallSales: ${status.overallSales?.status || ""} ${status.overallSales?.month || ""} ${status.overallSales?.message || ""}`.trim(),
    `- lastRun: failed=${Boolean(status.lastRun?.failed)} ${status.lastRun?.fatalError?.message || ""}`.trim(),
  ].join("\n");
}

function formatQualityStatus(status) {
  if (!status) return "- data/data-quality-status.json could not be read";
  const errors = (status.errors || []).slice(0, 5).map((item) => `  - ${item.message || item.type || JSON.stringify(item)}`);
  const warnings = (status.warnings || []).slice(0, 5).map((item) => `  - ${item.message || item.type || JSON.stringify(item)}`);
  return [
    `- status: ${status.status || ""}`,
    `- checkedMonths: ${status.summary?.checkedMonths ?? ""}`,
    `- errors: ${status.summary?.errorCount ?? 0}`,
    ...errors,
    `- warnings: ${status.summary?.warningCount ?? 0}`,
    ...warnings,
  ].join("\n");
}

function sanitizeOutput(value) {
  return String(value || "").replace(/\s+/g, " ").slice(0, 500);
}

async function readOptionalJson(filePath) {
  try {
    return JSON.parse(await fs.readFile(filePath, "utf8"));
  } catch {
    return null;
  }
}

function parseArgs(argv) {
  const parsed = {};
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (!arg.startsWith("--")) continue;
    const key = arg.slice(2);
    const next = argv[index + 1];
    if (!next || next.startsWith("--")) parsed[key] = true;
    else {
      parsed[key] = next;
      index += 1;
    }
  }
  return parsed;
}

function toBoolean(value) {
  if (typeof value === "boolean") return value;
  return ["1", "true", "yes", "on"].includes(String(value || "").toLowerCase());
}
