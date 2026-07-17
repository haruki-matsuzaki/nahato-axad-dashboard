import process from "node:process";
import { pathToFileURL } from "node:url";

const DEFAULT_REPO = "haruki-matsuzaki/nahato-axad-dashboard";
const DEFAULT_BRANCH = "main";
const DEFAULT_WORKFLOWS = ["Validate Nacht AXAD static data", "Check Cloudflare Pages deploy"];
const FETCH_TIMEOUT_MS = Number(process.env.FETCH_TIMEOUT_MS || 45_000);
const DEFAULT_API_MAX_RETRIES = 3;
const DEFAULT_API_RETRY_BASE_DELAY_MS = 5_000;

if (isMainModule()) {
  const options = buildOptions(process.argv.slice(2), process.env);
  const result = await executeRetryCancelledChecks(options);
  console.log(JSON.stringify(result, null, 2));
  if (result.status === "error") {
    process.exitCode = 1;
  }
}

export function buildOptions(argv = [], env = process.env) {
  const args = parseArgs(argv);
  const configuredWorkflows = splitList(args.workflows || env.CHECK_RETRY_WORKFLOWS);
  return {
    repo: args.repo || env.GITHUB_REPOSITORY || DEFAULT_REPO,
    branch: args.branch || env.CHECK_RETRY_BRANCH || DEFAULT_BRANCH,
    workflows: configuredWorkflows.length ? configuredWorkflows : DEFAULT_WORKFLOWS,
    token: env.GITHUB_TOKEN || env.GH_TOKEN || "",
    maxAttempts: Number(args.maxAttempts || env.CHECK_RETRY_MAX_ATTEMPTS || 3),
    staleQueuedMinutes: Number(args.staleQueuedMinutes || env.CHECK_RETRY_STALE_QUEUED_MINUTES || 25),
    apiMaxRetries: toNonNegativeNumber(
      args.apiMaxRetries || env.GITHUB_API_MAX_RETRIES,
      DEFAULT_API_MAX_RETRIES,
    ),
    apiRetryBaseDelayMs: toNonNegativeNumber(
      args.apiRetryBaseDelayMs || env.GITHUB_API_RETRY_BASE_DELAY_MS,
      DEFAULT_API_RETRY_BASE_DELAY_MS,
    ),
    dryRun: toBoolean(args.dryRun || env.DRY_RUN),
  };
}

export async function executeRetryCancelledChecks(options) {
  try {
    return await retryCancelledChecks(options);
  } catch (error) {
    if (isTransientGithubError(error)) {
      return {
        status: "skipped",
        reason: "github_api_temporarily_unavailable",
        message: "GitHub API remained temporarily unavailable. The next scheduled run will retry automatically.",
        detail: formatError(error),
      };
    }
    return {
      status: "error",
      reason: "github_api_permanent_error",
      message: formatError(error),
    };
  }
}

export async function retryCancelledChecks(options) {
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

export async function fetchGithubJson(options, path, requestOptions = {}) {
  const url = new URL(`https://api.github.com${path}`);
  const method = requestOptions.method || "GET";
  const maxRetries = toNonNegativeNumber(options.apiMaxRetries, DEFAULT_API_MAX_RETRIES);
  const baseDelayMs = toNonNegativeNumber(options.apiRetryBaseDelayMs, DEFAULT_API_RETRY_BASE_DELAY_MS);
  const wait = options.waitImpl || sleep;

  for (let attempt = 0; attempt <= maxRetries; attempt += 1) {
    try {
      const response = await fetchWithTimeout(
        url,
        {
          method,
          headers: {
            Accept: "application/vnd.github+json",
            Authorization: `Bearer ${options.token}`,
            "X-GitHub-Api-Version": "2022-11-28",
          },
        },
        options.fetchImpl,
      );

      if (requestOptions.expectNoContent && [201, 202, 204].includes(response.status)) return {};

      const text = await response.text();
      if (!response.ok) {
        throw new GithubApiError({
          method,
          url,
          status: response.status,
          responseText: text,
          retryAfter: response.headers.get("retry-after"),
        });
      }
      return text ? JSON.parse(text) : {};
    } catch (error) {
      if (!isTransientGithubError(error) || attempt >= maxRetries) throw error;
      const delayMs = retryDelayMs(error, baseDelayMs, attempt);
      console.warn(
        `[github-api] Temporary failure (${formatError(error)}). Retrying ${attempt + 1}/${maxRetries} in ${delayMs}ms.`,
      );
      await wait(delayMs);
    }
  }

  throw new Error("GitHub API retry loop ended unexpectedly.");
}

async function fetchWithTimeout(url, options = {}, fetchImpl = fetch) {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS);
  try {
    return await fetchImpl(url, {
      ...options,
      signal: controller.signal,
    });
  } catch (error) {
    if (error?.name === "AbortError") {
      throw new GithubTransportError(`Fetch timed out after ${FETCH_TIMEOUT_MS}ms: ${String(url)}`);
    }
    throw new GithubTransportError(`GitHub API request failed: ${error?.message || String(error)}`, { cause: error });
  } finally {
    clearTimeout(timeout);
  }
}

export class GithubApiError extends Error {
  constructor({ method, url, status, responseText, retryAfter }) {
    const detail = truncate(String(responseText || "").replace(/\s+/g, " ").trim(), 500);
    super(`${method} ${url}: ${status}${detail ? ` ${detail}` : ""}`);
    this.name = "GithubApiError";
    this.status = status;
    this.retryAfter = retryAfter;
  }
}

export class GithubTransportError extends Error {
  constructor(message, options = {}) {
    super(message, options);
    this.name = "GithubTransportError";
  }
}

export function isTransientGithubError(error) {
  if (error instanceof GithubTransportError) return true;
  if (!(error instanceof GithubApiError)) return false;
  return error.status === 429 || error.status >= 500;
}

function retryDelayMs(error, baseDelayMs, attempt) {
  const retryAfterSeconds = Number(error?.retryAfter);
  if (Number.isFinite(retryAfterSeconds) && retryAfterSeconds >= 0) {
    return Math.min(retryAfterSeconds * 1000, 60_000);
  }
  return Math.min(baseDelayMs * 2 ** attempt, 60_000);
}

function sleep(delayMs) {
  return new Promise((resolve) => setTimeout(resolve, delayMs));
}

function formatError(error) {
  return truncate(error?.message || String(error), 800);
}

function truncate(value, maxLength) {
  return value.length <= maxLength ? value : `${value.slice(0, maxLength)}...`;
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

function toNonNegativeNumber(value, fallback) {
  const number = Number(value);
  return Number.isFinite(number) && number >= 0 ? number : fallback;
}

function isMainModule() {
  return Boolean(process.argv[1]) && import.meta.url === pathToFileURL(process.argv[1]).href;
}
