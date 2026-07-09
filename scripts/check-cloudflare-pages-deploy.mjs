import process from "node:process";
import { setTimeout as wait } from "node:timers/promises";

const DEFAULT_PROJECT_NAME = "nahato-axad-dashboard";
const DEFAULT_BRANCH = "main";
const FETCH_TIMEOUT_MS = Number(process.env.FETCH_TIMEOUT_MS || 45_000);

const args = parseArgs(process.argv.slice(2));
const options = {
  accountId: args.accountId || process.env.CLOUDFLARE_ACCOUNT_ID || process.env.CF_ACCOUNT_ID || "",
  apiToken: args.apiToken || process.env.CLOUDFLARE_API_TOKEN || process.env.CF_API_TOKEN || "",
  projectName: args.project || process.env.CLOUDFLARE_PAGES_PROJECT_NAME || DEFAULT_PROJECT_NAME,
  branch: args.branch || process.env.CLOUDFLARE_BRANCH || DEFAULT_BRANCH,
  expectedSha: normalizeSha(args.sha || process.env.CLOUDFLARE_EXPECTED_SHA || ""),
  waitSeconds: toNumber(args.waitSeconds || process.env.CLOUDFLARE_DEPLOY_WAIT_SECONDS, 0),
  intervalSeconds: toNumber(args.intervalSeconds || process.env.CLOUDFLARE_DEPLOY_INTERVAL_SECONDS, 30),
};

const result = await monitorDeployment(options);
console.log(JSON.stringify(result, null, 2));
if (result.status === "error") {
  process.exitCode = 1;
}

async function monitorDeployment(options) {
  if (!options.accountId || !options.apiToken) {
    return {
      status: "skipped",
      reason: "missing_cloudflare_credentials",
      message: "CLOUDFLARE_ACCOUNT_ID and CLOUDFLARE_API_TOKEN are required for deploy status checks.",
      projectName: options.projectName,
      branch: options.branch,
      expectedSha: options.expectedSha || null,
    };
  }

  const deadline = Date.now() + options.waitSeconds * 1000;
  let latest = null;

  do {
    latest = await checkDeployment(options);
    if (latest.status === "ok" || latest.status === "error") return latest;
    if (Date.now() >= deadline) break;
    await wait(Math.max(1, options.intervalSeconds) * 1000);
  } while (true);

  return {
    ...latest,
    status: "error",
    reason: "deployment_not_ready",
    message: latest?.message || "Cloudflare Pages deployment did not become successful within the wait window.",
  };
}

async function checkDeployment(options) {
  const deployments = await fetchDeployments(options);
  const branchDeployments = deployments.filter((deployment) => deploymentBranch(deployment) === options.branch);
  const candidates = options.expectedSha
    ? branchDeployments.filter((deployment) => shaMatches(deploymentCommitHash(deployment), options.expectedSha))
    : branchDeployments;
  const deployment = candidates[0] || null;

  if (!deployment) {
    return {
      status: "pending",
      reason: options.expectedSha ? "expected_commit_not_deployed_yet" : "no_branch_deployment",
      message: options.expectedSha
        ? `No Cloudflare Pages deployment found yet for ${options.branch} ${options.expectedSha}.`
        : `No Cloudflare Pages deployment found yet for ${options.branch}.`,
      projectName: options.projectName,
      branch: options.branch,
      expectedSha: options.expectedSha || null,
      latestBranchCommit: deploymentCommitHash(branchDeployments[0]) || null,
      latestBranchStatus: deploymentStatus(branchDeployments[0]) || null,
      latestBranchUrl: deploymentUrl(branchDeployments[0]) || null,
    };
  }

  const status = deploymentStatus(deployment);
  const payload = {
    status: status === "success" ? "ok" : failureStatus(status),
    reason: status === "success" ? "deployment_success" : `deployment_${status || "unknown"}`,
    message:
      status === "success"
        ? "Cloudflare Pages deployment completed successfully."
        : `Cloudflare Pages deployment is ${status || "unknown"}.`,
    projectName: options.projectName,
    branch: options.branch,
    expectedSha: options.expectedSha || null,
    commit: deploymentCommitHash(deployment) || null,
    deploymentId: deployment.id || null,
    deploymentUrl: deploymentUrl(deployment) || null,
    createdOn: deployment.created_on || null,
    modifiedOn: deployment.modified_on || null,
  };

  return payload;
}

function failureStatus(status) {
  if (["failure", "failed", "canceled", "cancelled"].includes(String(status || "").toLowerCase())) return "error";
  return "pending";
}

async function fetchDeployments(options) {
  const url = new URL(
    `https://api.cloudflare.com/client/v4/accounts/${encodeURIComponent(options.accountId)}/pages/projects/${encodeURIComponent(
      options.projectName,
    )}/deployments`,
  );
  url.searchParams.set("per_page", "10");

  const response = await fetchWithTimeout(url, {
    headers: {
      Authorization: `Bearer ${options.apiToken}`,
      Accept: "application/json",
    },
  });
  const payload = await response.json().catch(() => ({}));
  if (!response.ok || payload.success === false) {
    const message = Array.isArray(payload.errors) && payload.errors.length ? JSON.stringify(payload.errors) : response.statusText;
    throw new Error(`Cloudflare Pages deployments API failed: ${response.status} ${message}`);
  }

  return Array.isArray(payload.result) ? payload.result : [];
}

function deploymentBranch(deployment) {
  return String(deployment?.deployment_trigger?.metadata?.branch || deployment?.source?.config?.branch || "");
}

function deploymentCommitHash(deployment) {
  return normalizeSha(deployment?.deployment_trigger?.metadata?.commit_hash || deployment?.source?.config?.commit_hash || "");
}

function deploymentStatus(deployment) {
  if (!deployment) return "";
  return String(deployment.latest_stage?.status || deployment.stage?.status || deployment.status || "").toLowerCase();
}

function deploymentUrl(deployment) {
  if (!deployment) return "";
  return deployment.url || deployment.aliases?.[0] || "";
}

function shaMatches(actual, expected) {
  if (!actual || !expected) return false;
  return actual.startsWith(expected) || expected.startsWith(actual);
}

function normalizeSha(value) {
  return String(value || "").trim().toLowerCase();
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

function toNumber(value, fallback) {
  const number = Number(value);
  return Number.isFinite(number) ? number : fallback;
}
