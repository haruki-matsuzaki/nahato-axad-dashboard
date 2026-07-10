import process from "node:process";

const DEFAULT_REPO = "haruki-matsuzaki/nahato-axad-dashboard";
const DEFAULT_BRANCH = "main";
const DEFAULT_WORKFLOWS = ["Validate Nacht AXAD static data", "Check Cloudflare Pages deploy"];
const FETCH_TIMEOUT_MS = Number(process.env.FETCH_TIMEOUT_MS || 45_000);

const args = parseArgs(process.argv.slice(2));
const options = {
  repo: args.repo || process.env.GITHUB_REPOSITORY || DEFAULT_REPO,
  branch: args.branch || process.env.CHECK_RETRY_BRANCH || DEFAULT_BRANCH,
  workflows: splitList(args.workflows || process.env.CHECK_RETRY_WORKFLOWS).length
    ? splitList(args.workflows || process.env.CHECK_RETRY_WORKFLOWS)
    : DEFAULT_WORKFLOWS,
  token: process.env.GITHUB_TOKEN || process.env.GH_TOKEN || "",
  maxAttempts: Number(args.maxAttempts || process.env.CHECK_RETRY_MAX_ATTEMPTS || 3),
  staleQueuedMinutes: Number(args.staleQueuedMinutes || process.env.CHECK_RETRY_STALE_QUEUED_MINUTES || 25),
  dryRun: toBoolean(args.dryRun || process.env.DRY_RUN),
};

const result = await retryCancelledChecks(options);
console.log(JSON.stringify(result, null, 2));
if (result.status === "error") {
  process.exitCode = 1;
}

async function retryCancelledChecks(options) {
  if (!options.token) {
    return {
      status: "skipped",
      reason: "missing_github_token",
      message: "GITHUB_TOKEN or GH_TOKEN is required to retry cancelled workflow runs.",
    };
  }

  const branch = await fetchBranch(options);
  const headSha = branch?.commit?.sha || "";
  if (!headSha) {
    return {
      status: "error",
      reason: "branch_head_not_found",
      branch: options.branch,
    };
  }

  const runs = await fetchWorkflowRuns(options, headSha);
  const actions = [];

  for (const workflowName of options.workflows) {
    const run = runs.find((item) => item.name === workflowName) || null;
    if (!run) {
      actions.push({
        workflowName,
        action: "missing",
        message: `No workflow run was found for ${workflowName} on ${headSha.slice(0, 7)}.`,
      });
      continue;
    }

    if (run.status === "completed" && run.conclusion === "cancelled") {
      if (Number(run.run_attempt || 1) >= options.maxAttempts) {
        actions.push({
          workflowName,
          runId: run.id,
          action: "skip_max_attempts",
          runAttempt: run.run_attempt,
          url: run.html_url,
        });
        continue;
      }
      if (!options.dryRun) await rerunWorkflowRun(options, run.id);
      actions.push({
        workflowName,
        runId: run.id,
        action: options.dryRun ? "would_rerun" : "rerun",
        runAttempt: run.run_attempt,
        url: run.html_url,
      });
      continue;
    }

    if (["queued", "requested", "waiting", "pending"].includes(run.status) && isStaleRun(run, options.staleQueuedMinutes)) {
      if (!options.dryRun) await cancelWorkflowRun(options, run.id);
      actions.push({
        workflowName,
        runId: run.id,
        action: options.dryRun ? "would_cancel_stale_queued" : "cancel_stale_queued",
        status: run.status,
        createdAt: run.created_at,
        url: run.html_url,
      });
      continue;
    }

    actions.push({
      workflowName,
      runId: run.id,
      action: "no_action",
      status: run.status,
      conclusion: run.conclusion,
      runAttempt: run.run_attempt,
      url: run.html_url,
    });
  }

  return {
    status: "ok",
    branch: options.branch,
    headSha,
    dryRun: options.dryRun,
    actions,
  };
}

async function fetchBranch(options) {
  return fetchGithubJson(options, `/repos/${options.repo}/branches/${encodeURIComponent(options.branch)}`);
}

async function fetchWorkflowRuns(options, headSha) {
  const response = await fetchGithubJson(
    options,
    `/repos/${options.repo}/actions/runs?branch=${encodeURIComponent(options.branch)}&head_sha=${encodeURIComponent(
      headSha,
    )}&per_page=50`,
  );
  return response.workflow_runs || [];
}

async function rerunWorkflowRun(options, runId) {
  await fetchGithubJson(options, `/repos/${options.repo}/actions/runs/${runId}/rerun`, {
    method: "POST",
    expectNoContent: true,
  });
}

async function cancelWorkflowRun(options, runId) {
  await fetchGithubJson(options, `/repos/${options.repo}/actions/runs/${runId}/cancel`, {
    method: "POST",
    expectNoContent: true,
  });
}

async function fetchGithubJson(options, path, requestOptions = {}) {
  const url = new URL(`https://api.github.com${path}`);
  const response = await fetchWithTimeout(url, {
    method: requestOptions.method || "GET",
    headers: {
      Accept: "application/vnd.github+json",
      Authorization: `Bearer ${options.token}`,
      "X-GitHub-Api-Version": "2022-11-28",
    },
  });

  if (requestOptions.expectNoContent && response.status === 201) return {};
  if (requestOptions.expectNoContent && response.status === 202) return {};
  if (requestOptions.expectNoContent && response.status === 204) return {};

  const text = await response.text();
  if (!response.ok) {
    throw new Error(`${requestOptions.method || "GET"} ${url}: ${response.status} ${text}`);
  }
  return text ? JSON.parse(text) : {};
}

async function fetchWithTimeout(url, options = {}) {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS);
  try {
    return await fetch(url, {
      ...options,
      signal: controller.signal,
    });
  } catch (error) {
    if (error?.name === "AbortError") {
      throw new Error(`Fetch timed out after ${FETCH_TIMEOUT_MS}ms: ${String(url)}`);
    }
    throw error;
  } finally {
    clearTimeout(timeout);
  }
}

function isStaleRun(run, staleQueuedMinutes) {
  const createdAt = Date.parse(run.created_at || "");
  if (!Number.isFinite(createdAt)) return false;
  return Date.now() - createdAt >= staleQueuedMinutes * 60 * 1000;
}

function splitList(value) {
  return String(value || "")
    .split(",")
    .map((item) => item.trim())
    .filter(Boolean);
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
