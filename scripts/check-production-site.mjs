import process from "node:process";

const DEFAULT_URL = "https://nahato-axad-dashboard.pages.dev/#home";
const FETCH_TIMEOUT_MS = Number(process.env.FETCH_TIMEOUT_MS || 45_000);

const args = parseArgs(process.argv.slice(2));
const options = {
  url: args.url || process.env.PRODUCTION_URL || DEFAULT_URL,
  require200: toBoolean(args.require200 || process.env.PRODUCTION_CHECK_REQUIRE_200),
  requiredText: splitList(args.requiredText || process.env.PRODUCTION_REQUIRED_TEXT || "AXAD"),
};

const result = await checkProductionSite(options);
console.log(JSON.stringify(result, null, 2));
if (result.status === "error") {
  process.exitCode = 1;
}

async function checkProductionSite(options) {
  const pageUrl = new URL(options.url);
  pageUrl.hash = "";
  const response = await fetchWithTimeout(pageUrl, {
    redirect: "manual",
    headers: {
      Accept: "text/html,application/xhtml+xml",
      "User-Agent": "nacht-axad-production-check/1.0",
    },
  });

  const status = response.status;
  const headers = Object.fromEntries(response.headers.entries());
  if (status !== 200) {
    const reason = classifyNon200(status, headers);
    const payload = {
      status: options.require200 ? "error" : "warning",
      reason,
      url: pageUrl.toString(),
      httpStatus: status,
      message: `Production URL returned HTTP ${status}.`,
      location: summarizeLocation(headers.location),
    };
    if (!options.require200) {
      console.log(`::warning title=production_url_${status}::${payload.message}`);
    }
    return payload;
  }

  const html = await response.text();
  const missingText = options.requiredText.filter((text) => text && !html.includes(text));
  if (missingText.length) {
    return {
      status: "error",
      reason: "missing_required_text",
      url: pageUrl.toString(),
      missingText,
      message: `Production HTML is missing required text: ${missingText.join(", ")}`,
    };
  }

  const assetUrls = collectAssetUrls(html, pageUrl);
  const assetChecks = await Promise.all(assetUrls.map((assetUrl) => checkAsset(assetUrl)));
  const failedAssets = assetChecks.filter((item) => item.status !== "ok");
  if (failedAssets.length) {
    return {
      status: "error",
      reason: "asset_check_failed",
      url: pageUrl.toString(),
      failedAssets,
      message: `${failedAssets.length} production asset(s) failed to load.`,
    };
  }

  return {
    status: "ok",
    reason: "production_site_ok",
    url: pageUrl.toString(),
    httpStatus: status,
    checkedAssets: assetChecks.length,
    assets: assetChecks,
  };
}

async function checkAsset(assetUrl) {
  const response = await fetchWithTimeout(assetUrl, {
    redirect: "manual",
    headers: {
      Accept: "*/*",
      "User-Agent": "nacht-axad-production-check/1.0",
    },
  });
  return {
    status: response.status === 200 ? "ok" : "error",
    url: assetUrl.toString(),
    httpStatus: response.status,
  };
}

function collectAssetUrls(html, baseUrl) {
  const urls = new Set();
  const scriptPattern = /<script\b[^>]*\bsrc=["']([^"']+)["'][^>]*>/gi;
  const linkPattern = /<link\b[^>]*\b(?:href=["']([^"']+)["'][^>]*rel=["'][^"']*stylesheet|rel=["'][^"']*stylesheet[^>]*href=["']([^"']+)["'])[^>]*>/gi;

  for (const match of html.matchAll(scriptPattern)) {
    addAssetUrl(urls, match[1], baseUrl);
  }
  for (const match of html.matchAll(linkPattern)) {
    addAssetUrl(urls, match[1] || match[2], baseUrl);
  }

  return [...urls].map((url) => new URL(url)).filter((url) => /\/assets\/|assets\//.test(url.pathname));
}

function addAssetUrl(urls, value, baseUrl) {
  if (!value || value.startsWith("data:")) return;
  try {
    const url = new URL(value, baseUrl);
    url.hash = "";
    urls.add(url.toString());
  } catch {
    // Ignore malformed asset URLs; HTML validation catches severe cases separately.
  }
}

function classifyNon200(status, headers) {
  const location = String(headers.location || "");
  const server = String(headers.server || "");
  if ([301, 302, 303, 307, 308].includes(status) && /cloudflareaccess|cdn-cgi|login/i.test(location)) {
    return "cloudflare_access_redirect";
  }
  if ([401, 403].includes(status) && /cloudflare/i.test(server + location)) {
    return "cloudflare_access_blocked";
  }
  return "production_url_non_200";
}

function summarizeLocation(value) {
  if (!value) return null;
  try {
    const url = new URL(value);
    return `${url.origin}${url.pathname}`;
  } catch {
    return String(value).split("?")[0].slice(0, 160);
  }
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
