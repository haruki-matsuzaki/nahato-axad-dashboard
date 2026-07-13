import fs from "node:fs/promises";
import process from "node:process";
import { dispatchAndConfirmWorkflow, WorkflowDispatchError } from "./workflow-dispatch-client.mjs";

const args = parseArgs(process.argv.slice(2));
const triggerPath = args.trigger || process.env.UPDATE_TRIGGER_FILE || "data/update-trigger.json";
const trigger = await readOptionalJson(triggerPath);
const options = {
  repo: args.repo || process.env.GITHUB_REPOSITORY || "haruki-matsuzaki/nahato-axad-dashboard",
  workflow: args.workflow || process.env.UPDATE_WORKFLOW || "update-data.yml",
  token: process.env.GITHUB_TOKEN || process.env.GH_TOKEN || "",
  ref: args.ref || process.env.UPDATE_WORKFLOW_REF || "main",
  inputs: {
    mode: args.mode || process.env.UPDATE_MODE || "daily",
    month: args.month || process.env.TARGET_MONTH || "",
    spreadsheet_id: args.spreadsheetId || process.env.SPREADSHEET_ID || "",
    force_monthly: args.forceMonthly || process.env.FORCE_MONTHLY || "false",
  },
  notBefore: parseExpectedRunAt(trigger?.expectedRunAtJst),
};

if (toBoolean(args.dryRun || process.env.DISPATCH_DRY_RUN)) {
  const result = {
    status: "dry_run",
    repo: options.repo,
    workflow: options.workflow,
    ref: options.ref,
    inputs: options.inputs,
    notBefore: options.notBefore?.toISOString() || null,
  };
  console.log(JSON.stringify(result, null, 2));
  process.exit(0);
}

try {
  const result = await dispatchAndConfirmWorkflow(options);
  await writeGithubOutputs(result);
  console.log(JSON.stringify(result, null, 2));
} catch (error) {
  const result = {
    status: "error",
    code: error instanceof WorkflowDispatchError ? error.code : "unexpected_dispatch_error",
    message: error?.message || String(error),
    details: error instanceof WorkflowDispatchError ? error.details : {},
  };
  await writeGithubOutputs(result);
  console.error(JSON.stringify(result, null, 2));
  process.exitCode = 1;
}

async function writeGithubOutputs(result) {
  if (!process.env.GITHUB_OUTPUT) return;
  const lines = [
    `dispatch_status=${singleLine(result.status || "unknown")}`,
    `dispatch_code=${singleLine(result.code || "")}`,
    `dispatch_message=${singleLine(result.message || "")}`,
    `run_id=${singleLine(result.runId || "")}`,
    `run_url=${singleLine(result.runUrl || "")}`,
  ];
  await fs.appendFile(process.env.GITHUB_OUTPUT, `${lines.join("\n")}\n`);
}

async function readOptionalJson(filePath) {
  try {
    return JSON.parse(await fs.readFile(filePath, "utf8"));
  } catch {
    return null;
  }
}

function parseExpectedRunAt(value) {
  const match = String(value || "").match(/^(\d{4}-\d{2}-\d{2})\s+(\d{2}:\d{2})/);
  if (!match) return null;
  const date = new Date(`${match[1]}T${match[2]}:00+09:00`);
  return Number.isFinite(date.getTime()) ? date : null;
}

function singleLine(value) {
  return String(value || "").replace(/[\r\n]+/g, " ").trim();
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
  return ["1", "true", "yes", "on"].includes(String(value || "").toLowerCase());
}
