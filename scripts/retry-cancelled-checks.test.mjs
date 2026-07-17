import assert from "node:assert/strict";
import test from "node:test";

import { executeRetryCancelledChecks } from "./retry-cancelled-checks.mjs";

const branchResponse = {
  commit: { sha: "1234567890abcdef" },
};
const runsResponse = {
  workflow_runs: [],
};

function options(fetchImpl) {
  return {
    repo: "owner/repo",
    branch: "main",
    workflows: ["Validate Nacht AXAD static data"],
    token: "test-token",
    maxAttempts: 3,
    staleQueuedMinutes: 25,
    apiMaxRetries: 3,
    apiRetryBaseDelayMs: 0,
    waitImpl: async () => {},
    fetchImpl,
    dryRun: true,
  };
}

test("retries temporary 503 responses and continues after recovery", async () => {
  let calls = 0;
  const fetchImpl = async () => {
    calls += 1;
    if (calls <= 2) return new Response("temporarily unavailable", { status: 503 });
    if (calls === 3) return jsonResponse(branchResponse);
    return jsonResponse(runsResponse);
  };

  const result = await executeRetryCancelledChecks(options(fetchImpl));

  assert.equal(result.status, "ok");
  assert.equal(calls, 4);
});

test("persistent temporary failure is deferred without failing the workflow", async () => {
  let calls = 0;
  const fetchImpl = async () => {
    calls += 1;
    return new Response("temporarily unavailable", { status: 503 });
  };

  const result = await executeRetryCancelledChecks(options(fetchImpl));

  assert.equal(result.status, "skipped");
  assert.equal(result.reason, "github_api_temporarily_unavailable");
  assert.equal(calls, 4);
});

test("network failures are retried", async () => {
  let calls = 0;
  const fetchImpl = async () => {
    calls += 1;
    if (calls === 1) throw new TypeError("socket disconnected");
    if (calls === 2) return jsonResponse(branchResponse);
    return jsonResponse(runsResponse);
  };

  const result = await executeRetryCancelledChecks(options(fetchImpl));

  assert.equal(result.status, "ok");
  assert.equal(calls, 3);
});

test("permanent authentication errors still fail immediately", async () => {
  let calls = 0;
  const fetchImpl = async () => {
    calls += 1;
    return new Response("bad credentials", { status: 401 });
  };

  const result = await executeRetryCancelledChecks(options(fetchImpl));

  assert.equal(result.status, "error");
  assert.equal(result.reason, "github_api_permanent_error");
  assert.equal(calls, 1);
});

function jsonResponse(value) {
  return new Response(JSON.stringify(value), {
    status: 200,
    headers: { "content-type": "application/json" },
  });
}
