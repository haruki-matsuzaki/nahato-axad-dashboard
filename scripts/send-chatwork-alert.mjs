import fs from "node:fs/promises";
import process from "node:process";
import { buildAutomationAlertMessage } from "./automation-alert-message.mjs";

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
  const { subject, body, code } = buildAutomationAlertMessage(context);
  if (options.dryRun) {
    return {
      status: "ok",
      channel: "chatwork",
      dryRun: true,
      roomId: options.chatworkRoomId,
      subject,
      body,
      code,
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
    dispatchCode: process.env.ALERT_DISPATCH_CODE || "",
    dispatchMessage: process.env.ALERT_DISPATCH_MESSAGE || "",
    stepOutcomes: {
      automationSecrets: process.env.ALERT_STEP_AUTOMATION_SECRETS || "",
      fetchData: process.env.ALERT_STEP_FETCH_DATA || "",
      validateData: process.env.ALERT_STEP_VALIDATE_DATA || "",
      cloudflareDeploy: process.env.ALERT_STEP_CLOUDFLARE_DEPLOY || "",
      productionSite: process.env.ALERT_STEP_PRODUCTION_SITE || "",
      dispatchUpdate: process.env.ALERT_STEP_DISPATCH_UPDATE || "",
    },
    runUrl:
      process.env.ALERT_RUN_URL ||
      (process.env.GITHUB_SERVER_URL && process.env.GITHUB_REPOSITORY && process.env.GITHUB_RUN_ID
        ? `${process.env.GITHUB_SERVER_URL}/${process.env.GITHUB_REPOSITORY}/actions/runs/${process.env.GITHUB_RUN_ID}`
        : ""),
  };
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
