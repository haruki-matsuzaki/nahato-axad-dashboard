import fs from "node:fs/promises";
import path from "node:path";
import process from "node:process";

const args = parseArgs(process.argv.slice(2));
const repo = args.repo || process.env.GITHUB_REPOSITORY || "haruki-matsuzaki/nahato-axad-dashboard";
const workflow = args.workflow || "update-data.yml";
const triggerPath = args.trigger || "data/update-trigger.json";
const apply = toBoolean(args.apply);
const now = parseRunDate(args.runDate || process.env.RUN_DATE);
const monitor = buildMonitorWindow(now);

if (!monitor) {
  console.log(JSON.stringify({ status: "skipped", reason: "no_elapsed_schedule_window" }, null, 2));
  process.exit(0);
}

const runs = await fetchJson(
  `https://api.github.com/repos/${repo}/actions/workflows/${encodeURIComponent(workflow)}/runs?per_page=30`,
);
const relevantRuns = (runs.workflow_runs || []).filter((run) => {
  const createdAt = Date.parse(run.created_at || "");
  return Number.isFinite(createdAt) && createdAt >= monitor.windowStartUtc && createdAt <= now.getTime();
});

const latestRun = relevantRuns[0] || null;
const analysis = await analyzeRun(latestRun, monitor);

if (analysis.status === "ok") {
  console.log(JSON.stringify(analysis, null, 2));
  process.exit(0);
}

const trigger = {
  triggeredAt: now.toISOString(),
  expectedRunAtJst: monitor.expectedRunAtJst,
  reason: analysis.reason,
  analysis: analysis.message,
  runUrl: latestRun?.html_url || null,
  source: "codex_schedule_monitor",
};

if (apply) {
  await writeJson(triggerPath, trigger);
}

console.log(JSON.stringify({ ...analysis, triggerWritten: apply, trigger }, null, 2));

async function analyzeRun(run, monitor) {
  if (!run) {
    return {
      status: "needs_trigger",
      reason: "schedule_missing",
      expectedRunAtJst: monitor.expectedRunAtJst,
      message: `No scheduled, push, or manual update run was created after ${monitor.expectedRunAtJst} JST.`,
    };
  }

  if (["queued", "in_progress", "waiting", "requested", "pending"].includes(run.status)) {
    return {
      status: "ok",
      reason: "run_active",
      runUrl: run.html_url,
      message: `Update workflow is already ${run.status}.`,
    };
  }

  if (run.conclusion === "success") {
    return {
      status: "ok",
      reason: "run_success",
      runUrl: run.html_url,
      message: "Update workflow completed successfully.",
    };
  }

  const status = await fetchRawStatus();
  return {
    status: "needs_trigger",
    reason: classifyFailure(run, status),
    runUrl: run.html_url,
    message: buildFailureMessage(run, status),
  };
}

async function fetchRawStatus() {
  try {
    return await fetchJson(`https://raw.githubusercontent.com/${repo}/main/data/update-status.json`);
  } catch {
    return null;
  }
}

function classifyFailure(run, status) {
  const message = [
    run.conclusion,
    status?.daily?.message,
    status?.lastRun?.fatalError?.message,
  ]
    .filter(Boolean)
    .join(" ");
  if (/invalid_grant/i.test(message)) return "google_oauth_invalid_grant";
  if (/service account|GOOGLE_SERVICE_ACCOUNT_JSON|private_key/i.test(message)) return "google_service_account_error";
  if (/Google Sheets API (403|404)|permission|not found/i.test(message)) return "sheet_permission_or_missing";
  if (/data quality|データ|quality/i.test(message)) return "data_quality_error";
  if (/validate|static/i.test(message)) return "static_validation_error";
  return "workflow_run_failed";
}

function buildFailureMessage(run, status) {
  const raw = status?.daily?.message || status?.lastRun?.fatalError?.message || "";
  const summary = raw ? raw.replace(/\s+/g, " ").slice(0, 240) : "No update-status failure message was available.";
  return `Latest update workflow ended with ${run.conclusion}. ${summary}`;
}

function buildMonitorWindow(date) {
  const parts = jstParts(date);
  const schedules = [
    { hour: 12, minute: 0 },
    { hour: 15, minute: 0 },
    { hour: 18, minute: 0 },
  ];
  const candidates = schedules
    .map((schedule) => ({
      ...schedule,
      utcMs: jstDateTimeToUtcMs(parts, schedule.hour, schedule.minute),
    }))
    .filter((schedule) => date.getTime() >= schedule.utcMs + 20 * 60 * 1000);
  const latest = candidates.at(-1);
  if (!latest) return null;
  return {
    expectedRunAtJst: `${formatYmd(parts)} ${String(latest.hour).padStart(2, "0")}:${String(latest.minute).padStart(2, "0")}`,
    windowStartUtc: latest.utcMs - 2 * 60 * 1000,
  };
}

async function fetchJson(url) {
  const response = await fetch(url, {
    headers: { Accept: "application/vnd.github+json" },
  });
  if (!response.ok) {
    throw new Error(`${url}: ${response.status} ${await response.text()}`);
  }
  return response.json();
}

async function writeJson(filePath, value) {
  await fs.mkdir(path.dirname(filePath), { recursive: true });
  await fs.writeFile(filePath, `${JSON.stringify(value, null, 2)}\n`);
}

function parseRunDate(value) {
  const date = value ? new Date(value) : new Date();
  return Number.isFinite(date.getTime()) ? date : new Date();
}

function jstParts(date) {
  const parts = new Intl.DateTimeFormat("en-CA", {
    timeZone: "Asia/Tokyo",
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

function jstDateTimeToUtcMs(parts, hour, minute) {
  return Date.UTC(parts.year, parts.month - 1, parts.day, hour - 9, minute, 0, 0);
}

function formatYmd(parts) {
  return `${parts.year}-${String(parts.month).padStart(2, "0")}-${String(parts.day).padStart(2, "0")}`;
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

function toBoolean(value) {
  return ["1", "true", "yes", "on"].includes(String(value || "").toLowerCase());
}
