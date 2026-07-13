import process from "node:process";

const args = parseArgs(process.argv.slice(2));
const profile = args.profile || process.env.SECRETS_CHECK_PROFILE || "update";
const failOnError = toBoolean(args.failOnError || process.env.SECRETS_CHECK_FAIL_ON_ERROR || true);

const result = checkSecrets(profile);
emitAnnotations(result);
console.log(JSON.stringify(result, null, 2));
if (failOnError && result.status === "error") {
  process.exitCode = 1;
}

function checkSecrets(profile) {
  const errors = [];
  const warnings = [];
  const ok = [];

  if (["update", "all"].includes(profile)) {
    const oauthKeys = ["GOOGLE_OAUTH_CLIENT_ID", "GOOGLE_OAUTH_CLIENT_SECRET", "GOOGLE_OAUTH_REFRESH_TOKEN"];
    const oauthMissing = missingKeys(oauthKeys);
    const hasCompleteOauth = oauthMissing.length === 0;
    const hasServiceAccount = Boolean(process.env.GOOGLE_SERVICE_ACCOUNT_JSON);
    if (!hasCompleteOauth && !hasServiceAccount) {
      errors.push({
        key: "google_auth",
        message:
          "Google auth is not configured. Set all GOOGLE_OAUTH_* secrets or GOOGLE_SERVICE_ACCOUNT_JSON.",
        missing: oauthMissing,
      });
    } else if (!hasCompleteOauth) {
      warnings.push({
        key: "google_oauth",
        message: "GOOGLE_OAUTH_* is incomplete; falling back to GOOGLE_SERVICE_ACCOUNT_JSON if sheet permissions allow it.",
        missing: oauthMissing,
      });
    } else {
      ok.push("GOOGLE_OAUTH_*");
    }

  }

  if (["deploy", "update", "all"].includes(profile)) {
    const cloudflareMissing = missingKeys(["CLOUDFLARE_ACCOUNT_ID", "CLOUDFLARE_API_TOKEN"]);
    if (cloudflareMissing.length) {
      warnings.push({
        key: "cloudflare",
        message: "Cloudflare deploy status check will be warning/skipped because Cloudflare API secrets are missing.",
        missing: cloudflareMissing,
      });
    } else {
      ok.push("CLOUDFLARE_ACCOUNT_ID/CLOUDFLARE_API_TOKEN");
    }
  }

  if (["notify", "deploy", "update", "all"].includes(profile)) {
    if (!process.env.CHATWORK_API_TOKEN) {
      errors.push({
        key: "CHATWORK_API_TOKEN",
        message: "CHATWORK_API_TOKEN is required because automation alerts use Chatwork only.",
        missing: ["CHATWORK_API_TOKEN"],
      });
    } else {
      ok.push("CHATWORK_API_TOKEN");
    }
  }

  return {
    status: errors.length ? "error" : warnings.length ? "warning" : "ok",
    profile,
    ok,
    errors,
    warnings,
  };
}

function emitAnnotations(result) {
  for (const warning of result.warnings) {
    console.log(`::warning title=${warning.key}::${warning.message}`);
  }
  for (const error of result.errors) {
    console.log(`::error title=${error.key}::${error.message}`);
  }
}

function missingKeys(keys) {
  return keys.filter((key) => !process.env[key]);
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
