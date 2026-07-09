import crypto from "node:crypto";
import process from "node:process";

const DEFAULT_SCOPE = "https://www.googleapis.com/auth/spreadsheets.readonly";

export async function getGoogleAccessToken({ fetchWithTimeout = fetch, scope = DEFAULT_SCOPE } = {}) {
  const oauthCredentials = readOAuthCredentials();
  if (oauthCredentials) {
    try {
      return await refreshOAuthAccessToken(oauthCredentials, fetchWithTimeout, scope);
    } catch (error) {
      if (!hasServiceAccountCredentials()) throw error;
      console.warn(
        `Google OAuth refresh failed; falling back to service account auth. ${summarizeAuthError(error)}`,
      );
    }
  }

  const serviceAccount = readServiceAccount();
  return getServiceAccountAccessToken(serviceAccount, fetchWithTimeout, scope);
}

function readOAuthCredentials() {
  const credentials = {
    clientId: process.env.GOOGLE_OAUTH_CLIENT_ID,
    clientSecret: process.env.GOOGLE_OAUTH_CLIENT_SECRET,
    refreshToken: process.env.GOOGLE_OAUTH_REFRESH_TOKEN,
  };
  const provided = Object.values(credentials).some(Boolean);
  if (!provided) return null;

  const missing = Object.entries(credentials)
    .filter(([, value]) => !value)
    .map(([key]) => key);
  if (missing.length) {
    throw new Error(
      `GOOGLE_OAUTH_CLIENT_ID, GOOGLE_OAUTH_CLIENT_SECRET, GOOGLE_OAUTH_REFRESH_TOKEN are required together. Missing: ${missing.join(", ")}`,
    );
  }

  return credentials;
}

async function refreshOAuthAccessToken(credentials, fetchWithTimeout, scope) {
  const response = await fetchWithTimeout("https://oauth2.googleapis.com/token", {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      client_id: credentials.clientId,
      client_secret: credentials.clientSecret,
      refresh_token: credentials.refreshToken,
      grant_type: "refresh_token",
      scope,
    }),
  });

  if (!response.ok) {
    throw new Error(`Google OAuth refresh ${response.status}: ${await response.text()}`);
  }

  const payload = await response.json();
  if (!payload?.access_token) {
    throw new Error("Google OAuth refresh succeeded but access_token was missing");
  }
  return payload.access_token;
}

function readServiceAccount() {
  if (process.env.GOOGLE_SERVICE_ACCOUNT_JSON) {
    try {
      return JSON.parse(process.env.GOOGLE_SERVICE_ACCOUNT_JSON);
    } catch {
      throw new Error("GOOGLE_SERVICE_ACCOUNT_JSON is not valid JSON");
    }
  }

  if (process.env.GOOGLE_CLIENT_EMAIL && process.env.GOOGLE_PRIVATE_KEY) {
    return {
      client_email: process.env.GOOGLE_CLIENT_EMAIL,
      private_key: process.env.GOOGLE_PRIVATE_KEY.replaceAll("\\n", "\n"),
    };
  }

  throw new Error(
    "GOOGLE_OAUTH_CLIENT_ID/GOOGLE_OAUTH_CLIENT_SECRET/GOOGLE_OAUTH_REFRESH_TOKEN or GOOGLE_SERVICE_ACCOUNT_JSON is required",
  );
}

function hasServiceAccountCredentials() {
  return Boolean(
    process.env.GOOGLE_SERVICE_ACCOUNT_JSON || (process.env.GOOGLE_CLIENT_EMAIL && process.env.GOOGLE_PRIVATE_KEY),
  );
}

function summarizeAuthError(error) {
  const message = String(error?.message || error || "");
  return message.replace(/\s+/g, " ").slice(0, 240);
}

async function getServiceAccountAccessToken(credentials, fetchWithTimeout, scope) {
  const now = Math.floor(Date.now() / 1000);
  const header = { alg: "RS256", typ: "JWT" };
  const claim = {
    iss: credentials.client_email,
    scope,
    aud: "https://oauth2.googleapis.com/token",
    exp: now + 3600,
    iat: now,
  };
  const unsigned = `${base64Url(JSON.stringify(header))}.${base64Url(JSON.stringify(claim))}`;
  const signature = crypto.createSign("RSA-SHA256").update(unsigned).sign(credentials.private_key);
  const assertion = `${unsigned}.${base64Url(signature)}`;

  const response = await fetchWithTimeout("https://oauth2.googleapis.com/token", {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      grant_type: "urn:ietf:params:oauth:grant-type:jwt-bearer",
      assertion,
    }),
  });

  if (!response.ok) {
    throw new Error(`Google OAuth ${response.status}: ${await response.text()}`);
  }

  const payload = await response.json();
  if (!payload?.access_token) {
    throw new Error("Google service account OAuth succeeded but access_token was missing");
  }
  return payload.access_token;
}

function base64Url(input) {
  return Buffer.from(input).toString("base64url");
}
