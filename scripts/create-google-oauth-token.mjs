import crypto from "node:crypto";
import http from "node:http";
import process from "node:process";

const args = parseArgs(process.argv.slice(2));
const clientId = args.clientId || process.env.GOOGLE_OAUTH_CLIENT_ID;
const clientSecret = args.clientSecret || process.env.GOOGLE_OAUTH_CLIENT_SECRET;
const port = Number(args.port || process.env.GOOGLE_OAUTH_PORT || 8765);
const redirectUri = args.redirectUri || process.env.GOOGLE_OAUTH_REDIRECT_URI || `http://127.0.0.1:${port}/oauth2callback`;
const scope = args.scope || process.env.GOOGLE_OAUTH_SCOPE || "https://www.googleapis.com/auth/spreadsheets.readonly";

if (!clientId || !clientSecret) {
  console.error("GOOGLE_OAUTH_CLIENT_ID and GOOGLE_OAUTH_CLIENT_SECRET are required.");
  process.exit(1);
}

const state = crypto.randomBytes(16).toString("hex");
const authUrl = new URL("https://accounts.google.com/o/oauth2/v2/auth");
authUrl.searchParams.set("client_id", clientId);
authUrl.searchParams.set("redirect_uri", redirectUri);
authUrl.searchParams.set("response_type", "code");
authUrl.searchParams.set("scope", scope);
authUrl.searchParams.set("access_type", "offline");
authUrl.searchParams.set("prompt", "consent");
authUrl.searchParams.set("include_granted_scopes", "true");
authUrl.searchParams.set("state", state);

const server = http.createServer(async (request, response) => {
  try {
    const url = new URL(request.url || "/", redirectUri);
    if (url.pathname !== "/oauth2callback") {
      response.writeHead(404);
      response.end("Not found");
      return;
    }

    if (url.searchParams.get("state") !== state) {
      response.writeHead(400);
      response.end("Invalid state.");
      return;
    }

    const code = url.searchParams.get("code");
    const error = url.searchParams.get("error");
    if (error || !code) {
      response.writeHead(400);
      response.end(`OAuth failed: ${error || "missing code"}`);
      return;
    }

    const tokenResponse = await fetch("https://oauth2.googleapis.com/token", {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({
        code,
        client_id: clientId,
        client_secret: clientSecret,
        redirect_uri: redirectUri,
        grant_type: "authorization_code",
      }),
    });

    const payload = await tokenResponse.json();
    if (!tokenResponse.ok) {
      response.writeHead(500, { "Content-Type": "text/plain; charset=utf-8" });
      response.end(`Token exchange failed. See terminal output.`);
      console.error(JSON.stringify(payload, null, 2));
      server.close();
      return;
    }

    response.writeHead(200, { "Content-Type": "text/html; charset=utf-8" });
    response.end("<p>認証完了です。このタブは閉じて大丈夫です。</p>");

    console.log("\nGitHub Secretsに登録する値:");
    console.log(`GOOGLE_OAUTH_CLIENT_ID=${clientId}`);
    console.log("GOOGLE_OAUTH_CLIENT_SECRET=<OAuthクライアントのシークレット>");
    if (payload.refresh_token) {
      console.log(`GOOGLE_OAUTH_REFRESH_TOKEN=${payload.refresh_token}`);
    } else {
      console.log("GOOGLE_OAUTH_REFRESH_TOKEN=<取得できませんでした。Googleアカウントの連携解除後に再実行してください>");
    }
    console.log("\nアクセストークンは一時値のため表示していません。");
    server.close();
  } catch (error) {
    response.writeHead(500, { "Content-Type": "text/plain; charset=utf-8" });
    response.end("Unexpected error.");
    console.error(error);
    server.close();
  }
});

server.listen(port, "127.0.0.1", () => {
  console.log("pino.ad.kanri@shibuya-ad.com のChromeで下記URLを開いて認証してください:");
  console.log(authUrl.toString());
  console.log(`\n待受URL: ${redirectUri}`);
});

function parseArgs(argv) {
  const result = {};
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (!arg.startsWith("--")) continue;
    const key = arg.slice(2);
    result[key] = argv[i + 1] && !argv[i + 1].startsWith("--") ? argv[++i] : true;
  }
  return result;
}
