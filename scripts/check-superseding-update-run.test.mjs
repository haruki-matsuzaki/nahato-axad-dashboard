import assert from "node:assert/strict";
import fs from "node:fs";
import test from "node:test";

import { checkSupersedingUpdateRun } from "./check-superseding-update-run.mjs";

const baseOptions = {
  repo: "owner/repo",
  workflow: "update-data.yml",
  token: "test-token",
  currentRunId: "100",
};

test("suppresses an old failure while a newer update is active", async () => {
  const result = await checkSupersedingUpdateRun({
    ...baseOptions,
    fetchImpl: async () => jsonResponse({ workflow_runs: [workflowRun(101, "in_progress")] }),
  });

  assert.equal(result.sendAlert, false);
  assert.equal(result.reason, "superseded_by_active_run");
});

test("suppresses an old failure after a newer update succeeded", async () => {
  const result = await checkSupersedingUpdateRun({
    ...baseOptions,
    fetchImpl: async () => jsonResponse({ workflow_runs: [workflowRun(102, "completed", "success")] }),
  });

  assert.equal(result.sendAlert, false);
  assert.equal(result.reason, "superseded_by_successful_run");
});

test("keeps the alert when there is no newer recovery run", async () => {
  const result = await checkSupersedingUpdateRun({
    ...baseOptions,
    fetchImpl: async () => jsonResponse({ workflow_runs: [workflowRun(99, "completed", "success")] }),
  });

  assert.equal(result.sendAlert, true);
  assert.equal(result.reason, "no_superseding_run");
});

test("keeps the alert when the guard API is unavailable", async () => {
  const result = await checkSupersedingUpdateRun({
    ...baseOptions,
    fetchImpl: async () => new Response("unavailable", { status: 503 }),
  });

  assert.equal(result.sendAlert, true);
  assert.equal(result.reason, "guard_api_error");
});

test("update workflow has only the three requested daily schedules", () => {
  const workflow = fs.readFileSync(".github/workflows/update-data.yml", "utf8");
  const crons = [...workflow.matchAll(/- cron: "([^"]+)"/g)].map((match) => match[1]);

  assert.deepEqual(crons, ["0 3 * * *", "0 6 * * *", "0 9 * * *"]);
  assert.match(workflow, /actions: read/);
  assert.match(workflow, /node scripts\/check-superseding-update-run\.mjs/);
  assert.match(workflow, /failure-alert-guard\.outputs\.send_alert != 'false'/);
});

function workflowRun(id, status, conclusion = null) {
  return {
    id,
    status,
    conclusion,
    html_url: `https://github.com/example/actions/runs/${id}`,
  };
}

function jsonResponse(value) {
  return new Response(JSON.stringify(value), {
    status: 200,
    headers: { "content-type": "application/json" },
  });
}
