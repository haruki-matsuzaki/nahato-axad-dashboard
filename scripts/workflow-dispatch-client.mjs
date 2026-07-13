const ACTIVE_STATUSES = new Set(["queued", "in_progress", "waiting", "requested", "pending"]);

export class WorkflowDispatchError extends Error {
  constructor(code, message, details = {}) {
    super(message);
    this.name = "WorkflowDispatchError";
    this.code = code;
    this.details = details;
  }
}

export async function dispatchAndConfirmWorkflow(options) {
  const {
    repo,
    workflow,
    token,
    ref = "main",
    inputs = {},
    notBefore = null,
    fetchImpl = fetch,
    sleep = delay,
    now = () => new Date(),
    requestAttempts = 3,
    requestRetryMs = 10_000,
    confirmationAttempts = 10,
    confirmationIntervalMs = 6_000,
  } = options;

  if (!repo || !workflow) {
    throw new WorkflowDispatchError("invalid_dispatch_target", "GitHubリポジトリまたはワークフロー名が未設定です。");
  }
  if (!token) {
    throw new WorkflowDispatchError("missing_github_token", "GitHub Actionsを起動するGITHUB_TOKENが未設定です。");
  }

  const baseUrl = `https://api.github.com/repos/${repo}/actions/workflows/${encodeURIComponent(workflow)}`;
  const headers = githubHeaders(token);
  const existing = await findExistingRelevantRun({
    baseUrl,
    headers,
    ref,
    notBefore,
    fetchImpl,
    sleep,
    attempts: requestAttempts,
    retryMs: requestRetryMs,
  });
  if (existing) {
    return {
      status: ACTIVE_STATUSES.has(existing.status) ? "already_active" : "already_completed",
      accepted: false,
      runId: existing.id,
      runUrl: existing.html_url || null,
      runStatus: existing.status || null,
      conclusion: existing.conclusion || null,
    };
  }

  const requestedAt = now();
  await requestDispatch({
    url: `${baseUrl}/dispatches`,
    headers,
    body: { ref, inputs },
    fetchImpl,
    sleep,
    attempts: requestAttempts,
    retryMs: requestRetryMs,
  });

  const run = await confirmDispatchedRun({
    baseUrl,
    headers,
    ref,
    requestedAt,
    fetchImpl,
    sleep,
    attempts: confirmationAttempts,
    intervalMs: confirmationIntervalMs,
  });

  return {
    status: "started",
    accepted: true,
    runId: run.id,
    runUrl: run.html_url || null,
    runStatus: run.status || null,
    conclusion: run.conclusion || null,
  };
}

async function findExistingRelevantRun({ baseUrl, headers, ref, notBefore, fetchImpl, sleep, attempts, retryMs }) {
  if (!notBefore) return null;
  const cutoff = new Date(notBefore);
  if (!Number.isFinite(cutoff.getTime())) return null;

  const response = await fetchWithRetry({
    url: `${baseUrl}/runs?per_page=30`,
    init: { headers },
    fetchImpl,
    sleep,
    attempts,
    retryMs,
  });
  if (!response.ok) {
    throw await responseError("dispatch_preflight_failed", "既存の更新処理を確認できませんでした。", response);
  }
  const payload = await response.json();
  return (payload.workflow_runs || []).find((run) => {
    const createdAt = Date.parse(run.created_at || "");
    if (!Number.isFinite(createdAt) || createdAt < cutoff.getTime()) return false;
    if (run.head_branch && run.head_branch !== ref) return false;
    return ACTIVE_STATUSES.has(run.status) || run.conclusion === "success";
  }) || null;
}

async function fetchWithRetry({ url, init, fetchImpl, sleep, attempts, retryMs }) {
  let lastError = null;
  for (let attempt = 1; attempt <= attempts; attempt += 1) {
    try {
      const response = await fetchImpl(url, init);
      if (response.ok || !isRetryableStatus(response.status) || attempt === attempts) return response;
      lastError = new WorkflowDispatchError(
        "dispatch_preflight_failed",
        `既存の更新処理確認に失敗しました（HTTP ${response.status}、${attempt}/${attempts}回目）。`,
      );
      await sleep(retryDelay(response, retryMs));
    } catch (error) {
      lastError = new WorkflowDispatchError(
        "dispatch_preflight_failed",
        `既存の更新処理確認に失敗しました（${attempt}/${attempts}回目）。`,
        { originalMessage: sanitize(error?.message || String(error)) },
      );
      if (attempt < attempts) await sleep(retryMs);
    }
  }
  throw lastError || new WorkflowDispatchError("dispatch_preflight_failed", "既存の更新処理を確認できませんでした。");
}

async function requestDispatch({ url, headers, body, fetchImpl, sleep, attempts, retryMs }) {
  let lastError = null;
  for (let attempt = 1; attempt <= attempts; attempt += 1) {
    let response;
    try {
      response = await fetchImpl(url, {
        method: "POST",
        headers: { ...headers, "Content-Type": "application/json" },
        body: JSON.stringify(body),
      });
    } catch (error) {
      lastError = new WorkflowDispatchError(
        "dispatch_request_failed",
        `GitHub Actionsの起動リクエストに失敗しました（${attempt}/${attempts}回目）。`,
        { originalMessage: sanitize(error?.message || String(error)) },
      );
      if (attempt < attempts) await sleep(retryMs);
      continue;
    }

    if (response.status === 204) return;

    const error = await responseError(
      response.status === 401 || response.status === 403 ? "dispatch_permission_denied" : "dispatch_request_rejected",
      `GitHub Actionsの起動リクエストが拒否されました（HTTP ${response.status}）。`,
      response,
    );
    if (!isRetryableStatus(response.status) || attempt === attempts) throw error;
    lastError = error;
    await sleep(retryDelay(response, retryMs));
  }
  throw lastError || new WorkflowDispatchError("dispatch_request_failed", "GitHub Actionsの起動リクエストに失敗しました。");
}

async function confirmDispatchedRun({ baseUrl, headers, ref, requestedAt, fetchImpl, sleep, attempts, intervalMs }) {
  const earliest = requestedAt.getTime() - 10_000;
  let lastApiError = null;
  for (let attempt = 1; attempt <= attempts; attempt += 1) {
    const response = await fetchImpl(`${baseUrl}/runs?event=workflow_dispatch&per_page=20`, { headers });
    if (response.ok) {
      lastApiError = null;
      const payload = await response.json();
      const run = (payload.workflow_runs || []).find((candidate) => {
        const createdAt = Date.parse(candidate.created_at || "");
        return Number.isFinite(createdAt) && createdAt >= earliest && (!candidate.head_branch || candidate.head_branch === ref);
      });
      if (run) return run;
    } else {
      lastApiError = await responseError(
        "dispatch_confirmation_request_failed",
        `起動後の実行履歴を確認できませんでした（HTTP ${response.status}）。`,
        response,
      );
      if (!isRetryableStatus(response.status)) throw lastApiError;
    }

    if (attempt < attempts) await sleep(intervalMs);
  }

  if (lastApiError) throw lastApiError;
  throw new WorkflowDispatchError(
    "dispatch_confirmation_timeout",
    "GitHubは起動リクエストを受け付けましたが、実行履歴の作成を確認できませんでした。",
    { requestedAt: requestedAt.toISOString() },
  );
}

function githubHeaders(token) {
  return {
    Accept: "application/vnd.github+json",
    Authorization: `Bearer ${token}`,
    "X-GitHub-Api-Version": "2022-11-28",
    "User-Agent": "nacht-axad-update-monitor/1.0",
  };
}

async function responseError(code, message, response) {
  const responseText = sanitize(await response.text().catch(() => ""));
  return new WorkflowDispatchError(code, message, {
    status: response.status,
    response: responseText,
  });
}

function isRetryableStatus(status) {
  return status === 408 || status === 409 || status === 429 || status >= 500;
}

function retryDelay(response, fallbackMs) {
  const retryAfter = Number(response.headers?.get?.("retry-after"));
  return Number.isFinite(retryAfter) && retryAfter > 0 ? retryAfter * 1000 : fallbackMs;
}

function sanitize(value) {
  return String(value || "").replace(/\s+/g, " ").trim().slice(0, 500);
}

function delay(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
