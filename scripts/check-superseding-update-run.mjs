import fs from "node:fs/promises";
import process from "node:process";
import { pathToFileURL } from "node:url";

if (isMainModule()) {
  const result = await checkSupersedingUpdateRun({
    repo: process.env.GITHUB_REPOSITORY || "haruki-matsuzaki/nahato-axad-dashboard",
    workflow: process.env.UPDATE_WORKFLOW_FILE || "update-data.yml",
    token: process.env.GITHUB_TOKEN || process.env.GH_TOKEN || "",
    currentRunId: process.env.CURRENT_RUN_ID || process.env.GITHUB_RUN_ID || "",
  });
  await writeOutputs(result);
  console.log(JSON.stringify(result, null, 2));
}

export async function checkSupersedingUpdateRun({ repo, workflow, token, currentRunId, fetchImpl = fetch }) {
  if (!repo || !workflow || !token || !currentRunId) {
    return { sendAlert: true, reason: "guard_not_configured" };
  }

  try {
    const url = new URL(
      `https://api.github.com/repos/${repo}/actions/workflows/${encodeURIComponent(workflow)}/runs`,
    );
    url.searchParams.set("branch", "main");
    url.searchParams.set("per_page", "30");
    const response = await fetchImpl(url, {
      headers: {
        Accept: "application/vnd.github+json",
        Authorization: `Bearer ${token}`,
        "X-GitHub-Api-Version": "2022-11-28",
      },
    });
    if (!response.ok) {
      return {
        sendAlert: true,
        reason: "guard_api_error",
        detail: `GitHub API ${response.status}`,
      };
    }

    const currentId = Number(currentRunId);
    const runs = (await response.json()).workflow_runs || [];
    const newerRuns = runs.filter((run) => Number(run.id) > currentId);
    const active = newerRuns.find((run) =>
      ["queued", "in_progress", "waiting", "requested", "pending"].includes(run.status),
    );
    if (active) {
      return {
        sendAlert: false,
        reason: "superseded_by_active_run",
        newerRunId: active.id,
        newerRunUrl: active.html_url,
      };
    }

    const success = newerRuns.find((run) => run.status === "completed" && run.conclusion === "success");
    if (success) {
      return {
        sendAlert: false,
        reason: "superseded_by_successful_run",
        newerRunId: success.id,
        newerRunUrl: success.html_url,
      };
    }

    return { sendAlert: true, reason: "no_superseding_run" };
  } catch (error) {
    return {
      sendAlert: true,
      reason: "guard_request_failed",
      detail: error?.message || String(error),
    };
  }
}

async function writeOutputs(result) {
  if (!process.env.GITHUB_OUTPUT) return;
  const lines = [
    `send_alert=${result.sendAlert ? "true" : "false"}`,
    `guard_reason=${result.reason}`,
  ];
  await fs.appendFile(process.env.GITHUB_OUTPUT, `${lines.join("\n")}\n`);
}

function isMainModule() {
  return Boolean(process.argv[1]) && import.meta.url === pathToFileURL(process.argv[1]).href;
}
