const DEFAULT_TIMEOUT_MS = 45_000;
const DEFAULT_RETRY_DELAYS_MS = [5_000, 15_000];

export function createFetchWithRetry({
  fetchImpl = globalThis.fetch,
  timeoutMs = DEFAULT_TIMEOUT_MS,
  retryDelaysMs = DEFAULT_RETRY_DELAYS_MS,
  sleepImpl = sleep,
  logger = console,
} = {}) {
  const delays = retryDelaysMs.map(Number).filter((delay) => Number.isFinite(delay) && delay >= 0);

  return async function fetchWithRetry(url, options = {}) {
    for (let attempt = 0; ; attempt += 1) {
      try {
        const response = await fetchOnce(fetchImpl, url, options, timeoutMs);
        if (!isTransientStatus(response.status) || attempt >= delays.length) return response;

        const delayMs = retryDelayMs(response.headers.get("retry-after"), delays[attempt]);
        logger.warn(
          `[fetch-retry] ${response.status} from ${safeUrl(url)}. Retrying ${attempt + 1}/${delays.length} in ${delayMs}ms.`,
        );
        await response.body?.cancel().catch(() => {});
        await sleepImpl(delayMs);
      } catch (error) {
        const transportError = normalizeTransportError(error, url, timeoutMs);
        if (attempt >= delays.length) throw transportError;

        const delayMs = delays[attempt];
        logger.warn(
          `[fetch-retry] ${transportError.message}. Retrying ${attempt + 1}/${delays.length} in ${delayMs}ms.`,
        );
        await sleepImpl(delayMs);
      }
    }
  };
}

export function isTransientStatus(status) {
  return status === 429 || status >= 500;
}

async function fetchOnce(fetchImpl, url, options, timeoutMs) {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), timeoutMs);
  try {
    return await fetchImpl(url, {
      ...options,
      signal: controller.signal,
    });
  } finally {
    clearTimeout(timeout);
  }
}

function normalizeTransportError(error, url, timeoutMs) {
  if (error?.name === "AbortError") {
    return new Error(`Fetch timed out after ${timeoutMs}ms: ${safeUrl(url)}`, { cause: error });
  }
  return new Error(`Fetch failed: ${safeUrl(url)}: ${error?.message || String(error)}`, { cause: error });
}

function retryDelayMs(retryAfter, fallback) {
  const text = String(retryAfter ?? "").trim();
  const seconds = text ? Number(text) : Number.NaN;
  if (Number.isFinite(seconds) && seconds >= 0) return Math.min(seconds * 1000, 60_000);

  const retryAt = Date.parse(text);
  if (Number.isFinite(retryAt)) return Math.max(0, Math.min(retryAt - Date.now(), 60_000));
  return fallback;
}

function safeUrl(url) {
  const value = new URL(String(url));
  value.searchParams.delete("key");
  value.searchParams.delete("access_token");
  return value.toString();
}

function sleep(delayMs) {
  return new Promise((resolve) => setTimeout(resolve, delayMs));
}
