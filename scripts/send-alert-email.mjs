import fs from "node:fs/promises";
import process from "node:process";
import { spawnSync } from "node:child_process";

const DEFAULT_TO = "matsuzaki@shibuya-ad.com";

const args = parseArgs(process.argv.slice(2));
const options = {
  to: splitRecipients(args.to || process.env.ALERT_EMAIL_TO || DEFAULT_TO),
  reason: args.reason || process.env.ALERT_REASON || "update_failed",
  statusPath: args.status || process.env.UPDATE_STATUS_FILE || "data/update-status.json",
  qualityPath: args.quality || process.env.DATA_QUALITY_STATUS_FILE || "data/data-quality-status.json",
  triggerPath: args.trigger || process.env.UPDATE_TRIGGER_FILE || "data/update-trigger.json",
  smtpHost: process.env.SMTP_HOST || process.env.MAIL_HOST || "",
  smtpPort: Number(process.env.SMTP_PORT || process.env.MAIL_PORT || 465),
  smtpUsername: process.env.SMTP_USERNAME || process.env.MAIL_USERNAME || "",
  smtpPassword: process.env.SMTP_PASSWORD || process.env.MAIL_PASSWORD || "",
  smtpFrom: process.env.SMTP_FROM || process.env.MAIL_FROM || process.env.SMTP_USERNAME || process.env.MAIL_USERNAME || "",
};

const result = await sendAlertEmail(options);
console.log(JSON.stringify(result, null, 2));
if (result.status === "error") {
  process.exitCode = 1;
}

async function sendAlertEmail(options) {
  const missing = requiredSmtpKeys(options);
  if (missing.length) {
    return {
      status: "skipped",
      reason: "missing_smtp_credentials",
      missing,
      to: options.to,
      message: "SMTP secrets are required to send alert email.",
    };
  }
  if (!options.to.length) {
    return {
      status: "skipped",
      reason: "missing_recipient",
      message: "No alert recipient was configured.",
    };
  }

  const context = await buildAlertContext(options);
  const message = buildEmailMessage({
    from: options.smtpFrom,
    to: options.to,
    subject: subjectForContext(context),
    body: bodyForContext(context),
  });

  const curlArgs = [
    "--fail",
    "--silent",
    "--show-error",
    "--url",
    smtpUrl(options),
    "--ssl-reqd",
    "--mail-from",
    options.smtpFrom,
    "--user",
    `${options.smtpUsername}:${options.smtpPassword}`,
    "--upload-file",
    "-",
  ];
  for (const recipient of options.to) {
    curlArgs.push("--mail-rcpt", recipient);
  }

  const result = spawnSync("curl", curlArgs, {
    input: message,
    encoding: "utf8",
    maxBuffer: 1024 * 1024,
  });

  if (result.status !== 0) {
    return {
      status: "error",
      reason: "smtp_send_failed",
      to: options.to,
      message: sanitizeOutput(result.stderr || result.stdout || `curl exited with ${result.status}`),
    };
  }

  return {
    status: "ok",
    reason: context.reason,
    to: options.to,
    subject: subjectForContext(context),
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

function buildEmailMessage({ from, to, subject, body }) {
  const headers = [
    `Date: ${new Date().toUTCString()}`,
    `From: ${formatAddress(from)}`,
    `To: ${to.map(formatAddress).join(", ")}`,
    `Subject: ${encodeHeader(subject)}`,
    "MIME-Version: 1.0",
    "Content-Type: text/plain; charset=UTF-8",
    "Content-Transfer-Encoding: 8bit",
  ];
  return `${headers.join("\r\n")}\r\n\r\n${body.replace(/\r?\n/g, "\r\n")}\r\n`;
}

function smtpUrl(options) {
  const scheme = options.smtpPort === 465 ? "smtps" : "smtp";
  return `${scheme}://${options.smtpHost}:${options.smtpPort}`;
}

function requiredSmtpKeys(options) {
  const missing = [];
  if (!options.smtpHost) missing.push("SMTP_HOST");
  if (!options.smtpPort) missing.push("SMTP_PORT");
  if (!options.smtpUsername) missing.push("SMTP_USERNAME");
  if (!options.smtpPassword) missing.push("SMTP_PASSWORD");
  if (!options.smtpFrom) missing.push("SMTP_FROM");
  return missing;
}

function splitRecipients(value) {
  return String(value || "")
    .split(/[,\s]+/)
    .map((item) => item.trim())
    .filter(Boolean);
}

function formatAddress(value) {
  return `<${sanitizeHeader(value)}>`;
}

function encodeHeader(value) {
  return `=?UTF-8?B?${Buffer.from(String(value || ""), "utf8").toString("base64")}?=`;
}

function sanitizeHeader(value) {
  return String(value || "").replace(/[\r\n]/g, "").trim();
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
    if (!next || next.startsWith("--")) {
      parsed[key] = true;
    } else {
      parsed[key] = next;
      index += 1;
    }
  }
  return parsed;
}
