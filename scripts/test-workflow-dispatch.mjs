import assert from "node:assert/strict";
import fs from "node:fs";
import { dispatchAndConfirmWorkflow, WorkflowDispatchError } from "./workflow-dispatch-client.mjs";

const fixedNow = new Date("2026-07-13T04:00:00.000Z");
const baseOptions = {
  repo: "haruki-matsuzaki/nahato-axad-dashboard",
  workflow: "update-data.yml",
  token: "test-token",
  ref: "main",
  inputs: { mode: "daily", force_monthly: "false" },
  notBefore: new Date("2026-07-13T03:00:00.000Z"),
  now: () => fixedNow,
  sleep: async () => {},
  requestRetryMs: 1,
  confirmationIntervalMs: 1,
};

const startedFetch = sequenceFetch([
  jsonResponse({ workflow_runs: [] }),
  new Response(null, { status: 204 }),
  jsonResponse({ workflow_runs: [workflowRun({ id: 101, status: "queued" })] }),
]);
const started = await dispatchAndConfirmWorkflow({ ...baseOptions, fetchImpl: startedFetch.fetch });
assert.equal(started.status, "started");
assert.equal(started.runId, 101);
assert.equal(started.runUrl, "https://github.com/example/actions/runs/101");
const dispatchRequest = startedFetch.calls.find((call) => call.init.method === "POST");
assert.deepEqual(JSON.parse(dispatchRequest.init.body), {
  ref: "main",
  inputs: { mode: "daily", force_monthly: "false" },
});

const duplicateFetch = sequenceFetch([
  jsonResponse({ workflow_runs: [workflowRun({ id: 102, status: "in_progress", event: "schedule" })] }),
]);
const duplicate = await dispatchAndConfirmWorkflow({ ...baseOptions, fetchImpl: duplicateFetch.fetch });
assert.equal(duplicate.status, "already_active");
assert.equal(duplicate.accepted, false);
assert.equal(duplicateFetch.calls.some((call) => call.init.method === "POST"), false);

const retrySleeps = [];
const retryFetch = sequenceFetch([
  jsonResponse({ workflow_runs: [] }),
  new Response("temporary error", { status: 500 }),
  new Response(null, { status: 204 }),
  jsonResponse({ workflow_runs: [workflowRun({ id: 103, status: "queued" })] }),
]);
const retried = await dispatchAndConfirmWorkflow({
  ...baseOptions,
  fetchImpl: retryFetch.fetch,
  sleep: async (ms) => retrySleeps.push(ms),
});
assert.equal(retried.status, "started");
assert.equal(retryFetch.calls.filter((call) => call.init.method === "POST").length, 2);
assert.deepEqual(retrySleeps, [1]);

const preflightSleeps = [];
const preflightRetryFetch = sequenceFetch([
  new Response("temporary error", { status: 502 }),
  jsonResponse({ workflow_runs: [] }),
  new Response(null, { status: 204 }),
  jsonResponse({ workflow_runs: [workflowRun({ id: 104, status: "queued" })] }),
]);
const preflightRetried = await dispatchAndConfirmWorkflow({
  ...baseOptions,
  fetchImpl: preflightRetryFetch.fetch,
  sleep: async (ms) => preflightSleeps.push(ms),
});
assert.equal(preflightRetried.status, "started");
assert.deepEqual(preflightSleeps, [1]);

const deniedFetch = sequenceFetch([
  jsonResponse({ workflow_runs: [] }),
  new Response("forbidden", { status: 403 }),
]);
await assert.rejects(
  () => dispatchAndConfirmWorkflow({ ...baseOptions, fetchImpl: deniedFetch.fetch }),
  (error) => error instanceof WorkflowDispatchError && error.code === "dispatch_permission_denied",
);
assert.equal(deniedFetch.calls.filter((call) => call.init.method === "POST").length, 1);

const timeoutFetch = sequenceFetch([
  jsonResponse({ workflow_runs: [] }),
  new Response(null, { status: 204 }),
  jsonResponse({ workflow_runs: [] }),
  jsonResponse({ workflow_runs: [] }),
]);
await assert.rejects(
  () => dispatchAndConfirmWorkflow({ ...baseOptions, fetchImpl: timeoutFetch.fetch, confirmationAttempts: 2 }),
  (error) => error instanceof WorkflowDispatchError && error.code === "dispatch_confirmation_timeout",
);

await assert.rejects(
  () => dispatchAndConfirmWorkflow({ ...baseOptions, token: "" }),
  (error) => error instanceof WorkflowDispatchError && error.code === "missing_github_token",
);

for (const workflowPath of [".github/workflows/monitor-update.yml", ".github/workflows/retry-cancelled-checks.yml"]) {
  const workflow = fs.readFileSync(workflowPath, "utf8");
  assert.match(workflow, /node scripts\/dispatch-update-workflow\.mjs/);
  assert.match(workflow, /ALERT_REASON: schedule_monitor_failed/);
  assert.match(workflow, /dispatch_status == 'started'/);
}
assert.match(fs.readFileSync(".github/workflows/monitor-update.yml", "utf8"), /actions: write/);
assert.match(fs.readFileSync(".github/workflows/retry-cancelled-checks.yml", "utf8"), /actions: write/);

console.log("workflow dispatch tests ok");

function sequenceFetch(responses) {
  const calls = [];
  return {
    calls,
    fetch: async (url, init = {}) => {
      calls.push({ url, init: { method: "GET", ...init } });
      const response = responses.shift();
      if (!response) throw new Error(`Unexpected fetch: ${url}`);
      return response;
    },
  };
}

function workflowRun({ id, status, event = "workflow_dispatch" }) {
  return {
    id,
    status,
    conclusion: status === "completed" ? "success" : null,
    event,
    head_branch: "main",
    created_at: "2026-07-13T04:00:02.000Z",
    html_url: `https://github.com/example/actions/runs/${id}`,
  };
}

function jsonResponse(value, status = 200) {
  return new Response(JSON.stringify(value), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}
