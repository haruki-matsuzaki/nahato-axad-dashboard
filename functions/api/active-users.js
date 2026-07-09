const ACTIVE_USER_PREFIX = "active-user:";
const ACTIVE_USER_TTL_SECONDS = 10 * 60;
const ACTIVE_USER_WINDOW_MS = 5 * 60 * 1000;
const MAX_USERS = 500;
const ALLOWED_EMAIL_DOMAINS = ["@shibuya-ad.com", "@axis-company.jp"];

export async function onRequest(context) {
  const { request, env } = context;

  if (request.method === "OPTIONS") {
    return new Response(null, { status: 204 });
  }

  if (!env?.ACTIVE_USERS) {
    return jsonResponse(
      {
        error: "ACTIVE_USERS KV binding is not configured",
      },
      503,
    );
  }

  try {
    const identity = readAccessIdentity(request);
    if (!isAllowedEmail(identity.email)) {
      return jsonResponse({ error: "Authenticated allowed user email is required" }, 401);
    }

    if (request.method === "GET") {
      return jsonResponse({ users: await listActiveUsers(env) });
    }

    if (request.method === "POST") {
      const body = await readJson(request);
      const postIdentity = readAccessIdentity(request, body?.user);

      if (body?.action === "offline") {
        await env.ACTIVE_USERS.delete(activeUserKey(postIdentity.email));
      } else {
        await putActiveUser(env, postIdentity, body?.user);
      }

      return jsonResponse({ users: await listActiveUsers(env) });
    }

    if (request.method === "DELETE") {
      await env.ACTIVE_USERS.delete(activeUserKey(identity.email));
      return jsonResponse({ ok: true });
    }

    return jsonResponse({ error: "Method not allowed" }, 405);
  } catch (error) {
    return jsonResponse({ error: "Active users API failed" }, 500);
  }
}

async function putActiveUser(env, identity, clientUser) {
  const now = Date.now();
  const avatar = normalizeAvatar(clientUser?.avatar);
  const user = {
    name: normalizeText(identity.name || clientUser?.name || emailName(identity.email)),
    email: normalizeEmail(identity.email),
    avatar,
    lastSeen: now,
  };

  await env.ACTIVE_USERS.put(activeUserKey(user.email), JSON.stringify(user), {
    expirationTtl: ACTIVE_USER_TTL_SECONDS,
  });
}

async function listActiveUsers(env) {
  const cutoff = Date.now() - ACTIVE_USER_WINDOW_MS;
  const users = [];
  let cursor;

  do {
    const listed = await env.ACTIVE_USERS.list({
      prefix: ACTIVE_USER_PREFIX,
      cursor,
    });

    const values = await Promise.all(
      listed.keys.slice(0, Math.max(0, MAX_USERS - users.length)).map(async (key) => {
        const raw = await env.ACTIVE_USERS.get(key.name);
        if (!raw) return null;
        try {
          const user = JSON.parse(raw);
          if (!user?.email || !user?.lastSeen || user.lastSeen < cutoff) {
            await env.ACTIVE_USERS.delete(key.name);
            return null;
          }
          return {
            name: normalizeText(user.name || emailName(user.email)),
            email: normalizeEmail(user.email),
            avatar: normalizeAvatar(user.avatar),
            lastSeen: Number(user.lastSeen),
          };
        } catch {
          await env.ACTIVE_USERS.delete(key.name);
          return null;
        }
      }),
    );

    users.push(...values.filter(Boolean));
    cursor = listed.list_complete ? undefined : listed.cursor;
  } while (cursor && users.length < MAX_USERS);

  return users.sort((a, b) => b.lastSeen - a.lastSeen);
}

function readAccessIdentity(request, clientUser = {}) {
  const jwtPayload = decodeAccessJwt(request.headers.get("Cf-Access-Jwt-Assertion"));
  const email = normalizeEmail(
    request.headers.get("Cf-Access-Authenticated-User-Email") ||
      jwtPayload?.email ||
      jwtPayload?.user_email,
  );
  const name = normalizeText(
    jwtPayload?.name ||
      jwtPayload?.display_name ||
      jwtPayload?.common_name ||
      jwtPayload?.given_name ||
      clientUser?.name,
  );
  return { email, name };
}

function decodeAccessJwt(jwt) {
  const payload = normalizeText(jwt).split(".")[1];
  if (!payload) return null;

  try {
    const base64 = payload.replace(/-/g, "+").replace(/_/g, "/");
    const padded = base64.padEnd(Math.ceil(base64.length / 4) * 4, "=");
    return JSON.parse(atob(padded));
  } catch {
    return null;
  }
}

async function readJson(request) {
  const contentType = request.headers.get("content-type") || "";
  if (!contentType.includes("application/json")) return {};
  try {
    return await request.json();
  } catch {
    return {};
  }
}

function activeUserKey(email) {
  return `${ACTIVE_USER_PREFIX}${normalizeEmail(email)}`;
}

function isAllowedEmail(email) {
  const normalized = normalizeEmail(email);
  return ALLOWED_EMAIL_DOMAINS.some((domain) => normalized.endsWith(domain));
}

function normalizeText(value) {
  return String(value || "").replace(/\s+/g, " ").trim().slice(0, 120);
}

function normalizeEmail(value) {
  return normalizeText(value).toLowerCase();
}

function normalizeAvatar(value) {
  const avatar = String(value || "");
  if (!avatar.startsWith("data:image/")) return "";
  return avatar.length <= 100000 ? avatar : "";
}

function emailName(email) {
  return normalizeEmail(email).split("@")[0] || "User";
}

function jsonResponse(body, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: {
      "content-type": "application/json; charset=utf-8",
      "cache-control": "no-store",
    },
  });
}
