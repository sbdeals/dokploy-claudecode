#!/usr/bin/env node
/**
 * Fake Dokploy: a tiny stand-in for the Dokploy API so the Switchyard
 * dashboard can be exercised on a machine with no Docker/Dokploy.
 *
 * Users and what they own:
 *   alice@demo.test / password-a      -> cookie better-auth.session_token=alice -> project "Alpha", service appName "alpha-db"
 *   bob@demo.test   / password-b      -> cookie better-auth.session_token=bob   -> project "Beta",  service appName "beta-db"
 *   admin@demo.test / password-admin  -> cookie better-auth.session_token=admin -> BOTH projects (the DOKPLOY_EMAIL "system" identity)
 *
 * Every request is appended to $FAKE_DOKPLOY_LOG as
 *   `ISO ts | METHOD | path | user | status`
 * so a caller can count e.g. `project.all` hits over time (collector demo).
 *
 * Demo controls (no auth; local only):
 *   POST /__demo/revoke?token=alice    -> that Dokploy session now answers 401 (simulates logout/expiry)
 *   POST /__demo/restore?token=alice   -> undo
 *
 *   PORT=3971 FAKE_DOKPLOY_LOG=/tmp/fake-dokploy.log node fake-dokploy.mjs
 */
import { createServer } from "node:http";
import { appendFileSync } from "node:fs";

const PORT = Number(process.env.PORT) || 3971;
const LOG = process.env.FAKE_DOKPLOY_LOG || "";

const USERS = {
  "alice@demo.test": { password: "password-a", token: "alice" },
  "bob@demo.test": { password: "password-b", token: "bob" },
  "admin@demo.test": { password: "password-admin", token: "admin" },
};

function postgres(id, name, db, password) {
  return {
    postgresId: id,
    name,
    appName: name,
    applicationStatus: "running",
    dockerImage: "postgres:16",
    databaseName: db,
    databaseUser: "admin",
    databasePassword: password,
    externalPort: null,
    createdAt: "2026-09-01T00:00:00.000Z",
    env: "",
    cpuLimit: null,
    memoryLimit: null,
    command: null,
    replicas: 1,
  };
}

const PROJECTS = {
  alpha: {
    project: { projectId: "proj-alpha", name: "Alpha", envId: "env-alpha", pgId: "pg-alpha" },
    postgres: postgres("pg-alpha", "alpha-db", "alpha", "alpha-secret"),
  },
  beta: {
    project: { projectId: "proj-beta", name: "Beta", envId: "env-beta", pgId: "pg-beta" },
    postgres: postgres("pg-beta", "beta-db", "beta", "beta-secret"),
  },
};

/** token -> the projects that token can see */
const OWNS = { alice: ["alpha"], bob: ["beta"], admin: ["alpha", "beta"] };
const revoked = new Set();

function userFromCookie(header) {
  const m = /(?:^|;\s*)better-auth\.session_token=([^;]+)/.exec(header || "");
  const token = m ? m[1] : null;
  return token && OWNS[token] && !revoked.has(token) ? token : null;
}

function tree(user) {
  return OWNS[user].map((key) => {
    const w = PROJECTS[key];
    return {
      projectId: w.project.projectId,
      name: w.project.name,
      environments: [
        {
          environmentId: w.project.envId,
          name: "production",
          postgres: [{ postgresId: w.project.pgId }],
          mysql: [],
          mariadb: [],
          mongo: [],
          redis: [],
          applications: [],
          compose: [],
        },
      ],
    };
  });
}

function readBody(req) {
  return new Promise((resolve) => {
    let data = "";
    req.on("data", (c) => (data += c));
    req.on("end", () => resolve(data));
  });
}

const server = createServer(async (req, res) => {
  const url = new URL(req.url, `http://127.0.0.1:${PORT}`);
  const user = userFromCookie(req.headers.cookie);

  const json = (status, body, extraHeaders = {}) => {
    if (LOG) {
      appendFileSync(
        LOG,
        `${new Date().toISOString()} | ${req.method} | ${url.pathname}${url.search} | ${user ?? "-"} | ${status}\n`,
      );
    }
    res.writeHead(status, { "Content-Type": "application/json", ...extraHeaders });
    res.end(JSON.stringify(body));
  };

  // --- demo controls ---
  if (url.pathname === "/__demo/revoke") {
    revoked.add(url.searchParams.get("token"));
    return json(200, { revoked: [...revoked] });
  }
  if (url.pathname === "/__demo/restore") {
    revoked.delete(url.searchParams.get("token"));
    return json(200, { revoked: [...revoked] });
  }

  // --- auth (better-auth) ---
  if (req.method === "POST" && url.pathname === "/api/auth/sign-in/email") {
    let body = {};
    try {
      body = JSON.parse(await readBody(req));
    } catch {
      body = {};
    }
    const u = USERS[body.email];
    if (!u || u.password !== body.password) {
      return json(401, { message: "Invalid email or password" });
    }
    revoked.delete(u.token); // a fresh sign-in re-validates the session
    return json(200, { user: { email: body.email } }, {
      "Set-Cookie": `better-auth.session_token=${u.token}; Path=/; HttpOnly; SameSite=Lax`,
    });
  }
  if (req.method === "POST" && url.pathname === "/api/auth/sign-up/email") {
    await readBody(req);
    return json(200, { ok: true });
  }

  // --- control plane (per-user) ---
  if (url.pathname.startsWith("/api/") && !user) {
    return json(401, { message: "UNAUTHORIZED" });
  }
  if (url.pathname === "/api/project.all") return json(200, tree(user));
  if (url.pathname === "/api/postgres.one") {
    const id = url.searchParams.get("postgresId");
    const owned = OWNS[user].map((k) => PROJECTS[k]).find((w) => w.project.pgId === id);
    if (!owned) return json(404, { message: "NOT_FOUND" });
    return json(200, owned.postgres);
  }
  if (url.pathname === "/api/notification.all") return json(200, []);
  if (req.method === "POST") {
    await readBody(req);
    return json(200, {});
  }
  return json(404, {});
});

server.listen(PORT, "127.0.0.1", () => {
  console.log(`fake-dokploy listening on http://127.0.0.1:${PORT}${LOG ? ` (log: ${LOG})` : ""}`);
});
