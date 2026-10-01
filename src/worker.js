import Anthropic from "@anthropic-ai/sdk";

// ContentFlow's server. This project was created in Cloudflare as a "Worker" (not classic Pages),
// so unlike Pages there's no automatic routing from a functions/ folder — this one script handles
// the API routes itself and hands everything else off to the static files in public/ via ASSETS.

export default {
  // Nightly storage clean-up (see the Storage lifecycle section below; schedule is in wrangler.toml).
  async scheduled(event, env, ctx) {
    if (event.cron === "30 3 * * *") {
      ctx.waitUntil(runCleanup(env, { trigger: "nightly" }).catch((e) => console.error("cleanup failed", e)));
      // Nightly stats from Make (skipped quietly if the analytics webhook isn't set up yet).
      ctx.waitUntil(makeConfig(env).then((c) => pullPlatforms(c).length && triggerAnalyticsPull(env, { trigger: "nightly" })).catch((e) => console.error("analytics pull failed", e)));
    } else {
      ctx.waitUntil(autoPublishDue(env).catch((e) => console.error("auto-publish failed", e)));
      ctx.waitUntil(expireStuckJobs(env).catch((e) => console.error("expire jobs failed", e)));
    }
  },

  async fetch(request, env, ctx) {
    const url = new URL(request.url);

    // Who is this? With Cloudflare Access switched on, only people on the ContentFlow team list get past here.
    let viewer = { accessEnabled: false, member: null };
    // Make reports results here from its own servers; it proves itself with the one-time job token instead of a sign-in.
    if (url.pathname === "/api/make/callback") {
      try { return await makeRoute(request, env, url, viewer, ctx); } catch (e) { return json({ error: e.message || "Make error" }, e.status || 500); }
    }
    if (url.pathname.startsWith("/api/")) {
      try {
        viewer = await identify(request, env);
      } catch (e) {
        return json({ error: e.message || "Sign-in check failed", code: e.code || "auth" }, e.status || 401);
      }
      if (url.pathname === "/api/me") return json(meResponse(viewer, request));
      if (url.pathname === "/api/team") {
        try {
          if (request.method === "GET") return json(await listTeam(env));
          if (request.method === "POST") { requireAdmin(viewer); return json(await saveMember(request, env, viewer)); }
        } catch (e) {
          return json({ error: e.message || "Team error" }, e.status || 500);
        }
      }
      // Admin-only actions (only enforced once sign-in is on — before that everyone is effectively an admin).
      // (Refreshing the Drive library list is allowed for everyone — creators need new files to show up.)
      const adminOnly = (url.pathname === "/api/storage/cleanup") || (url.pathname === "/api/google/disconnect") ||
        (url.pathname === "/api/google/connect");
      if (adminOnly) {
        try { requireAdmin(viewer); } catch (e) { return json({ error: e.message }, e.status || 403); }
      }
    }

    if (url.pathname === "/api/insights") {
      try {
        if (request.method === "GET") return json({ configured: !!env.ANTHROPIC_API_KEY, latest: await kvGet(env, "insights_latest") });
        if (request.method === "POST") return await generateInsights(request, env);
      } catch (e) {
        return json({ error: e.message || "Insights error" }, e.status || 500);
      }
    }

    if (url.pathname === "/api/storage" || url.pathname === "/api/storage/cleanup") {
      try {
        if (url.pathname === "/api/storage" && request.method === "GET") return json(await storageReport(env));
        if (url.pathname === "/api/storage/cleanup" && request.method === "POST") return json(await runCleanup(env, { trigger: "manual" }));
      } catch (e) {
        return json({ error: e.message || "Storage error" }, e.status || 500);
      }
    }

    if (url.pathname === "/api/state") {
      if (request.method === "GET") return getState(env);
      if (request.method === "POST") return postState(request, env, ctx);
    }

    if (url.pathname === "/api/upload" && request.method === "POST") {
      return uploadFile(request, env);
    }

    if (url.pathname === "/api/chat/bot" && request.method === "POST") {
      try { return await handleBotQuestion(request, env, ctx); }
      catch (e) { return json({ error: e.message || "AI Dev + error" }, e.status || 500); }
    }

    if (url.pathname === "/api/chat") {
      if (request.method === "GET") return getChat(url, env);
      if (request.method === "POST") return postChat(request, env, ctx);
    }

    if (url.pathname === "/api/make" || url.pathname.startsWith("/api/make/")) {
      try {
        return await makeRoute(request, env, url, viewer, ctx);
      } catch (e) {
        return json({ error: e.message || "Make error" }, e.status || 500);
      }
    }

    if (url.pathname.startsWith("/api/push/")) {
      try {
        return await pushRoute(request, env, url, viewer);
      } catch (e) {
        return json({ error: e.message || "Push error" }, e.status || 500);
      }
    }

    if (url.pathname.startsWith("/api/google/")) {
      try {
        if (url.pathname === "/api/google/connect" && request.method === "GET") return await googleConnect(request, env);
        if (url.pathname === "/api/google/callback" && request.method === "GET") return await googleCallback(request, env);
        if (url.pathname === "/api/google/disconnect" && request.method === "POST") return await googleDisconnect(env);
      } catch (e) {
        return json({ error: e.message || "Google connection error" }, e.status || 500);
      }
    }

    if (url.pathname.startsWith("/api/library")) {
      try {
        if (url.pathname === "/api/library" && request.method === "GET") return await getLibrary(request, env);
        if (url.pathname === "/api/library/status" && request.method === "GET") return await libraryStatus(env);
        if (url.pathname === "/api/library/refresh" && request.method === "POST") return json(await refreshLibrary(env));
        if (url.pathname === "/api/library/import" && request.method === "POST") return await importFromDrive(request, env);
        const thumb = url.pathname.match(/^\/api\/library\/thumb\/([\w-]{10,})$/);
        if (thumb && request.method === "GET") return await libraryThumb(thumb[1], env, url.searchParams.get("s"));
        const stream = url.pathname.match(/^\/api\/library\/stream\/([\w-]{10,})$/);
        if (stream && request.method === "GET") return await libraryStream(stream[1], request, env);
      } catch (e) {
        return json({ error: e.message || "Library error" }, e.status || 500);
      }
    }

    const mediaMatch = url.pathname.match(/^\/api\/media\/(.+)$/);
    if (mediaMatch && request.method === "GET") {
      return serveMedia(mediaMatch[1], request, env);
    }

    // Not an API route — serve the static app (index.html, manifest.json, icons, sw.js, ...).
    return env.ASSETS.fetch(request);
  },
};

// ---------------------------------------------------------------------------
// GET/POST /api/state — the whole shared app state (content items, activity log, settings, etc.)
// as one JSON blob. Simple on purpose: a 2-3 person internal tool, not a high-concurrency system.
// See schema.sql for the note on when to graduate to real relational tables.
// ---------------------------------------------------------------------------

async function getState(env) {
  const row = await env.DB.prepare("SELECT data FROM app_state WHERE id = 1").first();
  const data = row ? JSON.parse(row.data) : {};
  return new Response(JSON.stringify(data), {
    headers: { "Content-Type": "application/json" },
  });
}

async function postState(request, env, ctx) {
  let body;
  try {
    body = await request.json();
  } catch (e) {
    return new Response(JSON.stringify({ error: "Invalid JSON" }), { status: 400 });
  }
  // After the shared workspace is reset, a tab that loaded the old copy must not write it back: every save carries
  // the resetId it loaded, and a mismatch is refused (the app then reloads fresh).
  const row = await env.DB.prepare("SELECT data FROM app_state WHERE id = 1").first();
  let stored = {};
  try { stored = row && row.data ? JSON.parse(row.data) : {}; } catch (e) {}
  const current = { resetId: stored.resetId, deletedIds: JSON.stringify(stored.deletedIds || []) };
  const liveReset = current && current.resetId ? String(current.resetId) : null;
  if (liveReset && body.resetId !== liveReset) {
    return new Response(JSON.stringify({ error: "The workspace was reset — reload to get the current posts.", code: "reset" }), { status: 409, headers: { "Content-Type": "application/json" } });
  }
  if (liveReset) body.resetId = liveReset;
  // Deleted posts stay deleted: a device that loaded before the delete would otherwise save them straight back.
  let known = [];
  try { known = JSON.parse((current && current.deletedIds) || "[]"); } catch (e) {}
  const deleted = [...new Set([...(Array.isArray(known) ? known : []), ...(Array.isArray(body.deletedIds) ? body.deletedIds : [])])].slice(-500);
  body.deletedIds = deleted;
  // Merge post by post instead of letting the whole save replace what's stored: each post keeps whichever copy
  // was changed most recently (updatedAt), posts another device added are kept, and activity entries are combined.
  // Without this, a phone or laptop that loaded an old copy could undo approvals made elsewhere when it saved.
  const gone = new Set(deleted);
  if (Array.isArray(body.contentItems)) {
    const byId = new Map();
    for (const i of Array.isArray(stored.contentItems) ? stored.contentItems : []) if (i && i.id) byId.set(i.id, i);
    for (const i of body.contentItems) {
      if (!i || !i.id) continue;
      const old = byId.get(i.id);
      if (!old || String(i.updatedAt || "") >= String(old.updatedAt || "")) byId.set(i.id, i);
    }
    body.contentItems = [...byId.values()].filter((i) => !gone.has(i.id))
      .sort((x, y) => String(y.createdAt || "").localeCompare(String(x.createdAt || "")));
  }
  if (Array.isArray(body.activityLog)) {
    const seen = new Set(body.activityLog.map((a) => a && a.id));
    const extra = (Array.isArray(stored.activityLog) ? stored.activityLog : []).filter((a) => a && !seen.has(a.id));
    body.activityLog = [...body.activityLog, ...extra].filter((a) => a && !gone.has(a.id))
      .sort((x, y) => String(y.at || "").localeCompare(String(x.at || ""))).slice(0, 3000);
  }
  if (Array.isArray(body.decisionHistory)) {
    const seen = new Set(body.decisionHistory.map((d) => d && d.id));
    const extra = (Array.isArray(stored.decisionHistory) ? stored.decisionHistory : []).filter((d) => d && !seen.has(d.id));
    body.decisionHistory = [...extra, ...body.decisionHistory].filter((d) => d && !gone.has(d.id))
      .sort((x, y) => String(x.at || "").localeCompare(String(y.at || ""))).slice(-100);
  }
  const json = JSON.stringify(body);
  await env.DB.prepare(
    `INSERT INTO app_state (id, data, updated_at) VALUES (1, ?1, datetime('now'))
     ON CONFLICT(id) DO UPDATE SET data = excluded.data, updated_at = excluded.updated_at`
  ).bind(json).run();
  // Turn new workflow events (sent for approval, approved, ...) into Team Chat updates, after replying.
  if (ctx && body.chatUpdates !== false) ctx.waitUntil(postWorkflowUpdates(env, body).catch((e) => console.error("chat updates", e)));
  return new Response(JSON.stringify({ ok: true }), {
    headers: { "Content-Type": "application/json" },
  });
}

// ---------------------------------------------------------------------------
// POST /api/upload (multipart/form-data, field name "file") — stores the real uploaded
// photo/video in R2 and hands back a URL the app can put straight into an <img>/<video> tag.
// ---------------------------------------------------------------------------

const MAX_BYTES = 500 * 1024 * 1024; // 500MB, matches the limit shown in the upload UI

async function uploadFile(request, env) {
  const contentLength = Number(request.headers.get("content-length") || 0);
  if (contentLength && contentLength > MAX_BYTES) {
    return new Response(JSON.stringify({ error: "File too large (500MB limit)" }), { status: 413 });
  }

  let form;
  try {
    form = await request.formData();
  } catch (e) {
    return new Response(JSON.stringify({ error: "Expected multipart/form-data" }), { status: 400 });
  }

  const file = form.get("file");
  if (!file || typeof file === "string") {
    return new Response(JSON.stringify({ error: "No file provided" }), { status: 400 });
  }

  const safeExt = (file.name && file.name.includes("."))
    ? file.name.split(".").pop().replace(/[^a-zA-Z0-9]/g, "").slice(0, 8)
    : "bin";
  const key = `${crypto.randomUUID()}.${safeExt || "bin"}`;

  await env.MEDIA.put(key, file.stream(), {
    httpMetadata: { contentType: file.type || "application/octet-stream" },
  });

  return new Response(JSON.stringify({ url: `/api/media/${key}`, key }), {
    headers: { "Content-Type": "application/json" },
  });
}

// ---------------------------------------------------------------------------
// GET /api/media/<key> — streams a stored photo/video back out of R2.
// Supports Range requests so video scrubbing/seeking works properly in the <video> player.
// ---------------------------------------------------------------------------

async function serveMedia(key, request, env) {
  const wantsDrive = new URL(request.url).searchParams.get("view") === "drive";
  if (wantsDrive) {
    const alt = await archivedLocation(key, env);
    if (alt) return Response.redirect(new URL(alt.view, request.url).toString(), 302);
  }
  const range = request.headers.get("range");
  const obj = range ? await env.MEDIA.get(key, { range: parseRange(range) }) : await env.MEDIA.get(key);

  if (!obj) {
    // Cleaned up after publishing — the same URL keeps working by pointing at the Google Drive copy.
    const alt = await archivedLocation(key, env);
    if (alt) return Response.redirect(new URL(alt.play, request.url).toString(), 302);
    return new Response("Not found", { status: 404 });
  }

  const headers = new Headers();
  obj.writeHttpMetadata(headers);
  headers.set("etag", obj.httpEtag);
  headers.set("Cache-Control", "public, max-age=31536000, immutable");
  headers.set("Accept-Ranges", "bytes");

  if (range && obj.range && "offset" in obj.range) {
    const end = obj.range.offset + obj.range.length - 1;
    headers.set("Content-Range", `bytes ${obj.range.offset}-${end}/${obj.size}`);
    return new Response(obj.body, { status: 206, headers });
  }

  return new Response(obj.body, { headers });
}

function parseRange(rangeHeader) {
  const match = /bytes=(\d+)-(\d*)/.exec(rangeHeader || "");
  if (!match) return undefined;
  const offset = Number(match[1]);
  const end = match[2] ? Number(match[2]) : undefined;
  return end !== undefined ? { offset, length: end - offset + 1 } : { offset };
}

// ---------------------------------------------------------------------------
// GET/POST /api/chat — team chat. Messages are their own append-only table (not part of the
// /api/state blob) so two people sending at the same moment can never overwrite each other.
// The table creates itself on first use, so no manual database step is needed.
// ---------------------------------------------------------------------------

let chatTableReady = false;
async function ensureChatTable(env) {
  if (chatTableReady) return;
  await env.DB.prepare(
    `CREATE TABLE IF NOT EXISTS chat_messages (
       id INTEGER PRIMARY KEY AUTOINCREMENT,
       author TEXT NOT NULL,
       text TEXT NOT NULL,
       mentions TEXT NOT NULL DEFAULT '[]',
       content_id TEXT,
       created_at TEXT NOT NULL
     )`
  ).run();
  // Workflow updates carry the activity id they came from, so each event is posted exactly once.
  try { await env.DB.prepare("ALTER TABLE chat_messages ADD COLUMN event_id TEXT").run(); } catch (e) { /* already there */ }
  await env.DB.prepare("CREATE UNIQUE INDEX IF NOT EXISTS chat_messages_event ON chat_messages(event_id)").run();
  chatTableReady = true;
}

function rowToMessage(r) {
  let mentions = [];
  try { mentions = JSON.parse(r.mentions || "[]"); } catch (e) {}
  return { id: r.id, author: r.author, text: r.text, mentions, contentId: r.content_id || null, createdAt: r.created_at };
}

async function getChat(url, env) {
  await ensureChatTable(env);
  const since = Number(url.searchParams.get("since") || 0);
  const { results } = since > 0
    ? await env.DB.prepare("SELECT * FROM chat_messages WHERE id > ?1 ORDER BY id ASC LIMIT 500").bind(since).all()
    : await env.DB.prepare("SELECT * FROM (SELECT * FROM chat_messages ORDER BY id DESC LIMIT 300) ORDER BY id ASC").all();
  return new Response(JSON.stringify({ messages: (results || []).map(rowToMessage) }), {
    headers: { "Content-Type": "application/json", "Cache-Control": "no-store" },
  });
}

async function postChat(request, env, ctx) {
  let body;
  try { body = await request.json(); } catch (e) {
    return new Response(JSON.stringify({ error: "Invalid JSON" }), { status: 400 });
  }
  const author = String(body.author || "").slice(0, 64);
  const text = String(body.text || "").trim().slice(0, 4000);
  if (!author || !text) return new Response(JSON.stringify({ error: "author and text are required" }), { status: 400 });
  const mentions = Array.isArray(body.mentions) ? body.mentions.map(String).slice(0, 20) : [];
  const contentId = body.contentId ? String(body.contentId).slice(0, 64) : null;
  await ensureChatTable(env);
  const row = await env.DB.prepare(
    "INSERT INTO chat_messages (author, text, mentions, content_id, created_at) VALUES (?1, ?2, ?3, ?4, ?5) RETURNING *"
  ).bind(author, text, JSON.stringify(mentions), contentId, new Date().toISOString()).first();
  const notify = mentions.filter((id) => id !== author);
  if (ctx && notify.length) {
    ctx.waitUntil((async () => {
      const { members } = await listTeam(env);
      const who = (members.find((m) => m.id === author) || {}).name || "Someone";
      await pushToUsers(env, notify, { title: `${who} in Team Chat`, body: text.slice(0, 180), url: "/#/chat", tag: "chat-" + row.id });
    })().catch((e) => console.error("chat push", e)));
  }
  return new Response(JSON.stringify({ message: rowToMessage(row) }), {
    headers: { "Content-Type": "application/json" },
  });
}

// ---------------------------------------------------------------------------
// Content Library — the "Sanjugo Marketing Contents Final" Google Drive folder.
// ContentFlow reads it with Drive read-only access, from either:
//   1. "Connect Google Drive" in Settings (preferred): an admin signs in with Google once; we keep the
//      refresh token in D1. Needs the GOOGLE_CLIENT_ID / GOOGLE_CLIENT_SECRET secrets (an OAuth web client).
//   2. A service account key in the GOOGLE_SERVICE_ACCOUNT secret, if an organisation allows key creation.
// Files stay private in Drive and nothing is ever written back — imports are copied into R2.
// ---------------------------------------------------------------------------

class HttpError extends Error {
  constructor(status, message) { super(message); this.status = status; }
}
function json(data, status = 200) {
  return new Response(JSON.stringify(data), { status, headers: { "Content-Type": "application/json", "Cache-Control": "no-store" } });
}
const LIBRARY_INDEX_KEY = "meta/library-index.json";
const DRIVE_FOLDER = "application/vnd.google-apps.folder";

function serviceAccount(env) {
  if (!env.GOOGLE_SERVICE_ACCOUNT) return null;
  try {
    const sa = JSON.parse(env.GOOGLE_SERVICE_ACCOUNT);
    return sa.client_email && sa.private_key ? sa : null;
  } catch (e) { return null; }
}

function b64url(bytes) {
  const arr = bytes instanceof ArrayBuffer ? new Uint8Array(bytes) : bytes;
  let s = "";
  for (let i = 0; i < arr.length; i++) s += String.fromCharCode(arr[i]);
  return btoa(s).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

let googleToken = null; // { token, exp } — reused while this worker instance is warm
async function getGoogleToken(env) {
  const now = Math.floor(Date.now() / 1000);
  if (googleToken && googleToken.exp - 60 > now) return googleToken.token;
  const sa = serviceAccount(env);
  if (!sa) return await oauthAccessToken(env);
  const enc = (o) => b64url(new TextEncoder().encode(JSON.stringify(o)));
  const unsigned = enc({ alg: "RS256", typ: "JWT" }) + "." + enc({
    iss: sa.client_email, scope: "https://www.googleapis.com/auth/drive.readonly",
    aud: "https://oauth2.googleapis.com/token", iat: now, exp: now + 3600,
  });
  const pem = sa.private_key.replace(/-----[^-]+-----/g, "").replace(/\s+/g, "");
  const der = Uint8Array.from(atob(pem), (c) => c.charCodeAt(0));
  const key = await crypto.subtle.importKey("pkcs8", der, { name: "RSASSA-PKCS1-v1_5", hash: "SHA-256" }, false, ["sign"]);
  const sig = await crypto.subtle.sign("RSASSA-PKCS1-v1_5", key, new TextEncoder().encode(unsigned));
  const res = await fetch("https://oauth2.googleapis.com/token", {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: "grant_type=urn%3Aietf%3Aparams%3Aoauth%3Agrant-type%3Ajwt-bearer&assertion=" + unsigned + "." + b64url(sig),
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok || !data.access_token) throw new HttpError(502, "Google sign-in failed: " + (data.error_description || data.error || res.status));
  googleToken = { token: data.access_token, exp: now + (data.expires_in || 3600) };
  return googleToken.token;
}

async function libraryStatus(env) {
  const sa = serviceAccount(env);
  const head = await env.MEDIA.head(LIBRARY_INDEX_KEY);
  const auth = sa ? null : await getGoogleAuth(env);
  return json({
    connected: !!(sa || auth),
    method: sa ? "service_account" : auth ? "google_signin" : null,
    serviceEmail: sa ? sa.client_email : auth ? auth.email : null,
    connectedAt: auth ? auth.connected_at : null,
    canArchive: !!(auth && (auth.scopes || "").includes("drive.file")),
    signInConfigured: oauthConfigured(env),
    rootFolderId: env.LIBRARY_FOLDER_ID || null,
    lastRefresh: head ? (head.customMetadata && head.customMetadata.updatedAt) || head.uploaded : null,
  });
}

// The live index (from the last refresh) if there is one, otherwise the snapshot bundled with the app.
async function getLibrary(request, env) {
  const obj = await env.MEDIA.get(LIBRARY_INDEX_KEY);
  if (obj) return new Response(obj.body, { headers: { "Content-Type": "application/json", "Cache-Control": "no-store" } });
  return env.ASSETS.fetch(new Request(new URL("/library.json", request.url)));
}

// Walk the library folder level by level, asking about up to 40 folders per request, so ~90 folders
// take a handful of calls (the free plan allows 50 per request) and nothing outside the library is read.
async function refreshLibrary(env) {
  const token = await getGoogleToken(env);
  const root = env.LIBRARY_FOLDER_ID;
  if (!root) throw new HttpError(500, "LIBRARY_FOLDER_ID is not set in wrangler.toml");
  const folders = new Map([[root, { name: null, parent: null }]]);
  const items = [];
  let frontier = [root], calls = 0;
  while (frontier.length) {
    const next = [];
    for (let i = 0; i < frontier.length; i += 40) {
      const chunk = frontier.slice(i, i + 40);
      let pageToken = "";
      do {
        if (++calls > 45) throw new HttpError(500, "The library has too many folders to list in one go.");
        const u = new URL("https://www.googleapis.com/drive/v3/files");
        u.searchParams.set("q", "(" + chunk.map((id) => `'${id}' in parents`).join(" or ") + ") and trashed=false");
        u.searchParams.set("fields", "nextPageToken,files(id,name,mimeType,size,parents,modifiedTime,description)");
        u.searchParams.set("pageSize", "1000");
        u.searchParams.set("supportsAllDrives", "true");
        u.searchParams.set("includeItemsFromAllDrives", "true");
        if (pageToken) u.searchParams.set("pageToken", pageToken);
        const r = await fetch(u, { headers: { Authorization: "Bearer " + token } });
        const d = await r.json().catch(() => ({}));
        if (!r.ok) throw new HttpError(502, "Drive listing failed: " + ((d.error && d.error.message) || r.status));
        for (const f of d.files || []) {
          const parent = (f.parents || []).find((p) => chunk.includes(p)) || (f.parents || [])[0];
          if (f.mimeType === DRIVE_FOLDER) {
            if (!folders.has(f.id)) { folders.set(f.id, { name: f.name, parent }); next.push(f.id); }
          } else {
            items.push({ ...f, parent });
          }
        }
        pageToken = d.nextPageToken || "";
      } while (pageToken);
    }
    frontier = next;
  }
  const pathOf = (folderId) => { // folder names from just under the root down to this folder
    const names = [];
    for (let id = folderId, guard = 0; id && id !== root && guard < 25; guard++) {
      const f = folders.get(id);
      if (!f) break;
      names.unshift(f.name);
      id = f.parent;
    }
    return names;
  };
  const files = items.map((it) => {
    const path = pathOf(it.parent);
    const f = { id: it.id, name: it.name, mime: it.mimeType, size: it.size ? Number(it.size) : null, branch: path[0] || "Unsorted", path: path.slice(1), modified: it.modifiedTime };
    if (it.description) f.note = it.description;
    return f;
  });
  if (files.length === 0) {
    const sa = serviceAccount(env);
    throw new HttpError(404, sa ? "No files found — is the library folder shared with " + sa.client_email + "?" : "No files found — does the connected Google account have access to the library folder?");
  }
  const updatedAt = new Date().toISOString();
  await env.MEDIA.put(LIBRARY_INDEX_KEY, JSON.stringify({ source: "live", updatedAt, rootFolderId: root, files }), {
    httpMetadata: { contentType: "application/json" }, customMetadata: { updatedAt },
  });
  return { count: files.length, updatedAt, calls };
}

async function driveMeta(id, token) {
  const r = await fetch(`https://www.googleapis.com/drive/v3/files/${id}?fields=id,name,mimeType,size,thumbnailLink&supportsAllDrives=true`, {
    headers: { Authorization: "Bearer " + token },
  });
  const d = await r.json().catch(() => ({}));
  if (!r.ok) throw new HttpError(r.status === 404 ? 404 : 502, (d.error && d.error.message) || "Couldn't read that file from Drive");
  return d;
}

async function fetchDriveThumb(meta, size, token) {
  if (!meta.thumbnailLink) return null;
  const link = meta.thumbnailLink.replace(/=s\d+$/, "=s" + size);
  let r = await fetch(link);
  if (!r.ok) r = await fetch(link, { headers: { Authorization: "Bearer " + token } });
  return r.ok ? r : null;
}

// Copies a Drive file into R2 (once — repeat imports reuse the copy) and returns a /api/media URL.
// Camera RAW and HEIC photos can't be shown in a browser, so for those we take Drive's full-size JPEG render.
async function importFromDrive(request, env) {
  const body = await request.json().catch(() => ({}));
  const id = String(body.id || "");
  if (!/^[\w-]{10,}$/.test(id)) return json({ error: "Missing or invalid file id" }, 400);
  const token = await getGoogleToken(env);
  const meta = await driveMeta(id, token);
  const needsJpeg = /x-raw|x-sony|x-canon|x-nikon|x-adobe-dng|heic|heif/i.test(meta.mimeType) || /\.(arw|cr2|cr3|nef|dng|raf|orf|rw2|heic|heif)$/i.test(meta.name);
  if (needsJpeg) {
    const key = `library/${id}.jpg`;
    if (!(await env.MEDIA.head(key))) {
      const r = await fetchDriveThumb(meta, 2048, token);
      if (!r) return json({ error: "Drive has no preview for this photo yet — export it as a JPG and upload that instead." }, 415);
      await env.MEDIA.put(key, await r.arrayBuffer(), { httpMetadata: { contentType: "image/jpeg" } });
    }
    return json({ url: `/api/media/${key}`, key, name: meta.name, mime: "image/jpeg", converted: true });
  }
  const ext = ((meta.name.includes(".") ? meta.name.split(".").pop() : "bin").replace(/[^a-z0-9]/gi, "").slice(0, 8) || "bin").toLowerCase();
  const key = `library/${id}.${ext}`;
  if (!(await env.MEDIA.head(key))) {
    const r = await fetch(`https://www.googleapis.com/drive/v3/files/${id}?alt=media&supportsAllDrives=true`, { headers: { Authorization: "Bearer " + token } });
    if (!r.ok || !r.body) return json({ error: "Drive download failed (" + r.status + ")" }, 502);
    const size = Number(r.headers.get("content-length") || meta.size || 0);
    const httpMetadata = { contentType: meta.mimeType || "application/octet-stream" };
    if (size > 0) {
      // Stream straight through — big videos never have to fit in the worker's memory.
      const { readable, writable } = new FixedLengthStream(size);
      const pump = r.body.pipeTo(writable);
      await env.MEDIA.put(key, readable, { httpMetadata });
      await pump;
    } else {
      await env.MEDIA.put(key, await r.arrayBuffer(), { httpMetadata });
    }
  }
  return json({ url: `/api/media/${key}`, key, name: meta.name, mime: meta.mimeType, size: Number(meta.size) || null, converted: false });
}

// Cached thumbnail (Drive renders these for photos, RAW files and videos). ?s=1200 for the large detail view.
async function libraryThumb(id, env, sizeParam) {
  const size = [400, 1200].includes(Number(sizeParam)) ? Number(sizeParam) : 400;
  const key = size === 400 ? `thumbs/${id}.jpg` : `thumbs/${id}_${size}.jpg`;
  const cached = await env.MEDIA.get(key);
  const headers = { "Content-Type": "image/jpeg", "Cache-Control": "public, max-age=604800" };
  if (cached) return new Response(cached.body, { headers });
  const token = await getGoogleToken(env);
  const meta = await driveMeta(id, token);
  const r = await fetchDriveThumb(meta, size, token);
  if (!r) return new Response("No thumbnail", { status: 404 });
  const buf = await r.arrayBuffer();
  await env.MEDIA.put(key, buf, { httpMetadata: { contentType: "image/jpeg" } });
  return new Response(buf, { headers });
}

// Plays a library video straight from Drive without copying it: the browser's Range requests are passed
// through, so seeking works and only the part being watched is downloaded.
async function libraryStream(id, request, env) {
  const token = await getGoogleToken(env);
  const headers = { Authorization: "Bearer " + token };
  const range = request.headers.get("range");
  if (range) headers.Range = range;
  const r = await fetch(`https://www.googleapis.com/drive/v3/files/${id}?alt=media&supportsAllDrives=true`, { headers });
  if (!r.ok && r.status !== 206) return json({ error: "Drive couldn't stream this file (" + r.status + ")" }, r.status === 404 ? 404 : 502);
  const out = new Headers();
  for (const h of ["content-type", "content-length", "content-range", "last-modified", "etag"]) {
    const v = r.headers.get(h);
    if (v) out.set(h, v);
  }
  out.set("Accept-Ranges", "bytes");
  out.set("Cache-Control", "private, max-age=3600");
  return new Response(r.body, { status: r.status, headers: out });
}

// ---------------------------------------------------------------------------
// "Connect Google Drive" — one admin signs in with Google once and approves read-only Drive access.
// The long-lived refresh token is kept server-side in D1; browsers only ever see file data, never tokens.
// ---------------------------------------------------------------------------

// drive.readonly: read the library. drive.file: create/manage only files ContentFlow itself makes (the archive).
const GOOGLE_SCOPES = "openid email https://www.googleapis.com/auth/drive.readonly https://www.googleapis.com/auth/drive.file";
function oauthConfigured(env) { return !!(env.GOOGLE_CLIENT_ID && env.GOOGLE_CLIENT_SECRET); }
function redirectUri(request) { return new URL("/api/google/callback", request.url).toString(); }

let googleAuthTableReady = false;
async function ensureGoogleAuthTable(env) {
  if (googleAuthTableReady) return;
  await env.DB.prepare(
    `CREATE TABLE IF NOT EXISTS google_auth (id INTEGER PRIMARY KEY, email TEXT, refresh_token TEXT NOT NULL, connected_at TEXT NOT NULL)`
  ).run();
  try { await env.DB.prepare("ALTER TABLE google_auth ADD COLUMN scopes TEXT").run(); } catch (e) { /* already there */ }
  googleAuthTableReady = true;
}
async function getGoogleAuth(env) {
  if (!oauthConfigured(env)) return null;
  await ensureGoogleAuthTable(env);
  return await env.DB.prepare("SELECT email, refresh_token, connected_at, scopes FROM google_auth WHERE id = 1").first();
}

async function oauthAccessToken(env) {
  const auth = await getGoogleAuth(env);
  if (!auth) throw new HttpError(503, "Google Drive isn't connected yet — an admin can connect it in Settings → Google Drive.");
  const res = await fetch("https://oauth2.googleapis.com/token", {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({ client_id: env.GOOGLE_CLIENT_ID, client_secret: env.GOOGLE_CLIENT_SECRET, refresh_token: auth.refresh_token, grant_type: "refresh_token" }),
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok || !data.access_token) {
    if (data.error === "invalid_grant") throw new HttpError(401, "Google access was revoked or expired — reconnect Google Drive in Settings.");
    throw new HttpError(502, "Google sign-in failed: " + (data.error_description || data.error || res.status));
  }
  googleToken = { token: data.access_token, exp: Math.floor(Date.now() / 1000) + (data.expires_in || 3600) };
  return googleToken.token;
}

function randomState() {
  const b = new Uint8Array(24); crypto.getRandomValues(b);
  return b64url(b);
}
function cookie(request, name) {
  const m = (request.headers.get("cookie") || "").match(new RegExp("(?:^|;\\s*)" + name + "=([^;]+)"));
  return m ? decodeURIComponent(m[1]) : null;
}
function backToSettings(request, params) {
  return new Response(null, { status: 302, headers: {
    Location: new URL("/#/settings?" + new URLSearchParams(params), request.url).toString(),
    "Set-Cookie": "cf_google_state=; Path=/api/google; Max-Age=0; HttpOnly; Secure; SameSite=Lax",
  }});
}

async function googleConnect(request, env) {
  if (!oauthConfigured(env)) return json({ error: "Google sign-in isn't set up yet (GOOGLE_CLIENT_ID / GOOGLE_CLIENT_SECRET)." }, 503);
  const state = randomState();
  const u = new URL("https://accounts.google.com/o/oauth2/v2/auth");
  u.search = new URLSearchParams({
    client_id: env.GOOGLE_CLIENT_ID, redirect_uri: redirectUri(request), response_type: "code",
    scope: GOOGLE_SCOPES, access_type: "offline", prompt: "consent", include_granted_scopes: "true", state,
  }).toString();
  return new Response(null, { status: 302, headers: {
    Location: u.toString(),
    "Set-Cookie": `cf_google_state=${state}; Path=/api/google; Max-Age=600; HttpOnly; Secure; SameSite=Lax`,
  }});
}

async function googleCallback(request, env) {
  const url = new URL(request.url);
  if (url.searchParams.get("error")) return backToSettings(request, { drive: "error", msg: "Google sign-in was cancelled (" + url.searchParams.get("error") + ")." });
  const state = url.searchParams.get("state");
  if (!state || state !== cookie(request, "cf_google_state")) return backToSettings(request, { drive: "error", msg: "That sign-in link expired — please try Connect again." });
  const res = await fetch("https://oauth2.googleapis.com/token", {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({ code: url.searchParams.get("code") || "", client_id: env.GOOGLE_CLIENT_ID, client_secret: env.GOOGLE_CLIENT_SECRET, redirect_uri: redirectUri(request), grant_type: "authorization_code" }),
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok || !data.access_token) return backToSettings(request, { drive: "error", msg: "Google didn't accept the sign-in: " + (data.error_description || data.error || res.status) });
  if (!(data.scope || "").includes("drive.readonly")) return backToSettings(request, { drive: "error", msg: "Drive access wasn't approved — tick the Google Drive permission when you connect." });
  let email = null;
  try { email = JSON.parse(atob(data.id_token.split(".")[1].replace(/-/g, "+").replace(/_/g, "/"))).email || null; } catch (e) {}
  await ensureGoogleAuthTable(env);
  const existing = await env.DB.prepare("SELECT refresh_token FROM google_auth WHERE id = 1").first();
  const refresh = data.refresh_token || (existing && existing.refresh_token);
  if (!refresh) return backToSettings(request, { drive: "error", msg: "Google didn't return long-term access — disconnect Creator Studio in your Google account's third-party access page and connect again." });
  await env.DB.prepare(
    `INSERT INTO google_auth (id, email, refresh_token, connected_at, scopes) VALUES (1, ?1, ?2, ?3, ?4)
     ON CONFLICT(id) DO UPDATE SET email = excluded.email, refresh_token = excluded.refresh_token, connected_at = excluded.connected_at, scopes = excluded.scopes`
  ).bind(email, refresh, new Date().toISOString(), data.scope || "").run();
  googleToken = { token: data.access_token, exp: Math.floor(Date.now() / 1000) + (data.expires_in || 3600) };
  return backToSettings(request, { drive: "connected" });
}

async function googleDisconnect(env) {
  await ensureGoogleAuthTable(env);
  const row = await env.DB.prepare("SELECT refresh_token FROM google_auth WHERE id = 1").first();
  if (row) {
    await fetch("https://oauth2.googleapis.com/revoke?token=" + encodeURIComponent(row.refresh_token), { method: "POST" }).catch(() => {});
    await env.DB.prepare("DELETE FROM google_auth WHERE id = 1").run();
  }
  googleToken = null;
  return json({ ok: true });
}

// ---------------------------------------------------------------------------
// Storage lifecycle — keep R2 (10 GB on the free plan) close to empty.
//   • A post's file stays while the post is in the workflow (draft → published) or rejected.
//   • 7 days after every platform of a post is published, the file leaves R2:
//       - library files are simply deleted (the original is in the Drive library);
//       - hand uploads are first copied to the "ContentFlow Archive" folder in Google Drive.
//   • Files not used by any post (e.g. an abandoned upload) are deleted after 48 hours.
//   • /api/media/<key> keeps working afterwards — it redirects to the Drive copy.
// Thumbnails and the library index are small and stay.
// ---------------------------------------------------------------------------

const STORAGE_LIMIT_BYTES = 10e9; // R2 free tier: 10 GB
const PUBLISHED_GRACE_DAYS = 7;
const ORPHAN_GRACE_HOURS = 48;
const MAX_ARCHIVES_PER_RUN = 8; // each archive is ~3 Drive calls; stays well under the 50-subrequest limit

let storageTablesReady = false;
async function ensureStorageTables(env) {
  if (storageTablesReady) return;
  await env.DB.prepare(`CREATE TABLE IF NOT EXISTS media_archive (key TEXT PRIMARY KEY, drive_id TEXT NOT NULL, size INTEGER, title TEXT, archived_at TEXT NOT NULL)`).run();
  await env.DB.prepare(`CREATE TABLE IF NOT EXISTS app_kv (k TEXT PRIMARY KEY, v TEXT)`).run();
  storageTablesReady = true;
}
async function kvGet(env, k) { await ensureStorageTables(env); const r = await env.DB.prepare("SELECT v FROM app_kv WHERE k = ?1").bind(k).first(); return r ? JSON.parse(r.v) : null; }
async function kvSet(env, k, v) { await ensureStorageTables(env); await env.DB.prepare("INSERT INTO app_kv (k, v) VALUES (?1, ?2) ON CONFLICT(k) DO UPDATE SET v = excluded.v").bind(k, JSON.stringify(v)).run(); }

const IMAGE_EXT = /\.(jpe?g|png|webp|gif|heic|heif)$/i;
// Where a cleaned-up /api/media key lives now: { play: URL the app can load, view: Google Drive page }.
async function archivedLocation(key, env) {
  const lib = /^library\/([\w-]{10,})\.[a-z0-9]+$/i.exec(key);
  if (lib) {
    const id = lib[1];
    return { play: IMAGE_EXT.test(key) ? `/api/library/thumb/${id}?s=1200` : `/api/library/stream/${id}`, view: `https://drive.google.com/file/d/${id}/view` };
  }
  await ensureStorageTables(env);
  const row = await env.DB.prepare("SELECT drive_id FROM media_archive WHERE key = ?1").bind(key).first();
  if (!row) return null;
  return { play: `/api/library/stream/${row.drive_id}`, view: `https://drive.google.com/file/d/${row.drive_id}/view` };
}

async function listAllObjects(env) {
  const out = [];
  let cursor;
  do {
    const r = await env.MEDIA.list({ cursor, limit: 1000 });
    out.push(...r.objects);
    cursor = r.truncated ? r.cursor : undefined;
  } while (cursor);
  return out;
}
function storageCategory(key) {
  if (key.startsWith("thumbs/")) return "thumbnails";
  if (key.startsWith("library/")) return "library";
  if (key.startsWith("meta/")) return "system";
  return "uploads";
}
const mediaKeyOf = (url) => { const m = /^\/api\/media\/([^?#]+)/.exec(url || ""); return m ? decodeURIComponent(m[1]) : null; };

// When a post stopped needing its file: the latest publish time once *every* platform is published.
function finishedAt(item) {
  const vs = Object.values(item.variants || {});
  if (!vs.length || vs.some((v) => v.publishStatus !== "published")) return null;
  const t = vs.map((v) => Date.parse(v.publishedAt || v.scheduledAt || "")).filter(Number.isFinite);
  return t.length ? Math.max(...t) : Date.now();
}

async function planCleanup(env, now = Date.now()) {
  const [objects, stateRow] = await Promise.all([
    listAllObjects(env),
    env.DB.prepare("SELECT data FROM app_state WHERE id = 1").first(),
  ]);
  const items = stateRow ? (JSON.parse(stateRow.data).contentItems || []) : [];
  const users = new Map();
  for (const it of items) {
    const keys = new Set([mediaKeyOf(it.media && it.media.fileUrl), mediaKeyOf(it.media && it.media.previewUrl)].filter(Boolean));
    for (const k of keys) { if (!users.has(k)) users.set(k, []); users.get(k).push(it); }
  }
  // Safety: with no shared post data to compare against, never treat files as unused.
  const canJudgeOrphans = items.length > 0;
  const actions = [];
  for (const o of objects) {
    const cat = storageCategory(o.key);
    if (cat !== "uploads" && cat !== "library") continue;
    const us = users.get(o.key) || [];
    const base = { key: o.key, size: o.size, category: cat };
    if (!us.length) {
      if (!canJudgeOrphans) continue;
      const age = now - new Date(o.uploaded).getTime();
      if (age > ORPHAN_GRACE_HOURS * 3600e3) actions.push({ ...base, action: "delete", reason: "Not used by any post", dueAt: null });
      continue;
    }
    const done = us.map(finishedAt);
    if (done.some((t) => t === null)) continue; // still being worked on, scheduled or rejected
    const dueAt = Math.max(...done) + PUBLISHED_GRACE_DAYS * 86400e3;
    const a = { ...base, action: cat === "library" ? "delete" : "archive", titles: us.map((u) => u.title), reason: "Published", dueAt: new Date(dueAt).toISOString() };
    actions.push({ ...a, ready: now >= dueAt });
  }
  return { objects, actions };
}

async function storageReport(env) {
  const { objects, actions } = await planCleanup(env);
  const byCategory = { uploads: { bytes: 0, count: 0 }, library: { bytes: 0, count: 0 }, thumbnails: { bytes: 0, count: 0 }, system: { bytes: 0, count: 0 } };
  let total = 0;
  for (const o of objects) { const c = byCategory[storageCategory(o.key)]; c.bytes += o.size; c.count++; total += o.size; }
  const ready = actions.filter((a) => a.ready !== false);
  const upcoming = actions.filter((a) => a.ready === false);
  await ensureStorageTables(env);
  const archived = await env.DB.prepare("SELECT COUNT(*) AS n, COALESCE(SUM(size),0) AS bytes FROM media_archive").first();
  const auth = serviceAccount(env) ? null : await getGoogleAuth(env);
  return {
    totalBytes: total, limitBytes: STORAGE_LIMIT_BYTES, objectCount: objects.length, byCategory,
    readyNow: { count: ready.length, bytes: ready.reduce((s, a) => s + a.size, 0), items: ready.slice(0, 50) },
    upcoming: { count: upcoming.length, bytes: upcoming.reduce((s, a) => s + a.size, 0), items: upcoming.sort((a, b) => a.dueAt.localeCompare(b.dueAt)).slice(0, 50) },
    archivedToDrive: { count: archived.n, bytes: archived.bytes },
    canArchive: !!(auth && (auth.scopes || "").includes("drive.file")),
    lastCleanup: await kvGet(env, "last_cleanup"),
    policy: { publishedGraceDays: PUBLISHED_GRACE_DAYS, orphanGraceHours: ORPHAN_GRACE_HOURS },
  };
}

async function archiveFolderId(env, token) {
  const saved = await kvGet(env, "archive_folder_id");
  if (saved) {
    const r = await fetch(`https://www.googleapis.com/drive/v3/files/${saved}?fields=id,trashed`, { headers: { Authorization: "Bearer " + token } });
    const d = await r.json().catch(() => ({}));
    if (r.ok && !d.trashed) return saved;
  }
  const r = await fetch("https://www.googleapis.com/drive/v3/files?fields=id", {
    method: "POST",
    headers: { Authorization: "Bearer " + token, "Content-Type": "application/json" },
    body: JSON.stringify({ name: "Creator Studio Archive", mimeType: DRIVE_FOLDER, description: "Published post media moved out of Creator Studio's storage. Managed by Sanjugo Creator Studio." }),
  });
  const d = await r.json().catch(() => ({}));
  if (!r.ok || !d.id) throw new HttpError(502, "Couldn't create the Creator Studio Archive folder in Drive: " + ((d.error && d.error.message) || r.status));
  await kvSet(env, "archive_folder_id", d.id);
  return d.id;
}

async function archiveToDrive(env, token, folderId, action) {
  const obj = await env.MEDIA.get(action.key);
  if (!obj) return null;
  const type = (obj.httpMetadata && obj.httpMetadata.contentType) || "application/octet-stream";
  const ext = action.key.includes(".") ? "." + action.key.split(".").pop() : "";
  const date = new Date().toISOString().slice(0, 10);
  const title = ((action.titles && action.titles[0]) || "Creator Studio media").replace(/[\\/:*?"<>|]+/g, " ").slice(0, 80);
  const init = await fetch("https://www.googleapis.com/upload/drive/v3/files?uploadType=resumable&fields=id", {
    method: "POST",
    headers: { Authorization: "Bearer " + token, "Content-Type": "application/json; charset=UTF-8", "X-Upload-Content-Type": type, "X-Upload-Content-Length": String(obj.size) },
    body: JSON.stringify({ name: `${date} ${title}${ext}`, parents: [folderId], description: "Archived by Creator Studio from /api/media/" + action.key }),
  });
  const session = init.headers.get("location");
  if (!init.ok || !session) { obj.body.cancel(); throw new Error("Drive upload couldn't start (" + init.status + ")"); }
  const { readable, writable } = new FixedLengthStream(obj.size);
  const pump = obj.body.pipeTo(writable);
  const up = await fetch(session, { method: "PUT", headers: { "Content-Type": type }, body: readable });
  await pump;
  const d = await up.json().catch(() => ({}));
  if (!up.ok || !d.id) throw new Error("Drive upload failed (" + up.status + ")");
  return d.id;
}

async function runCleanup(env, { trigger }) {
  const { actions } = await planCleanup(env);
  const due = actions.filter((a) => a.ready !== false);
  const result = { at: new Date().toISOString(), trigger, deleted: 0, archived: 0, freedBytes: 0, skipped: 0, errors: [] };
  let token = null, folderId = null, archivesLeft = MAX_ARCHIVES_PER_RUN;
  for (const a of due) {
    try {
      if (a.action === "archive") {
        if (archivesLeft <= 0) { result.skipped++; continue; }
        if (!token) {
          const auth = await getGoogleAuth(env);
          if (!auth || !(auth.scopes || "").includes("drive.file")) { result.skipped++; result.needsReconnect = true; continue; }
          token = await getGoogleToken(env);
          folderId = await archiveFolderId(env, token);
        }
        archivesLeft--;
        const driveId = await archiveToDrive(env, token, folderId, a);
        if (!driveId) continue;
        await env.DB.prepare("INSERT OR REPLACE INTO media_archive (key, drive_id, size, title, archived_at) VALUES (?1, ?2, ?3, ?4, ?5)")
          .bind(a.key, driveId, a.size, (a.titles || [])[0] || null, new Date().toISOString()).run();
        result.archived++;
      } else {
        result.deleted++;
      }
      await env.MEDIA.delete(a.key);
      result.freedBytes += a.size;
    } catch (e) {
      result.errors.push({ key: a.key, error: e.message });
    }
  }
  await kvSet(env, "last_cleanup", result);
  return result;
}

// ---------------------------------------------------------------------------
// Team & access. Sign-in is Cloudflare Access (email + one-time code) in front of the whole site. Access
// proves *who* someone is; the team list below decides whether they're allowed in and with what role, so
// adding a new hire is just adding their email in Settings — no Cloudflare changes needed.
// Until ACCESS_TEAM_DOMAIN and ACCESS_AUD are set, the site stays open (demo user switcher) as before.
// ---------------------------------------------------------------------------

const ROLES = ["creator", "manager", "approver", "admin"];
const DEFAULT_TEAM = [
  { id: "u_cyrus", name: "Cyrus", role: "admin" },
  { id: "u_yanyan", name: "Yan Yan", role: "admin" },
  { id: "u_aidev", name: "AI Dev", role: "creator" },
];

let teamTableReady = false;
async function ensureTeamTable(env) {
  if (teamTableReady) return;
  await env.DB.prepare(`CREATE TABLE IF NOT EXISTS team_members (
    id TEXT PRIMARY KEY, name TEXT NOT NULL, email TEXT, role TEXT NOT NULL, active INTEGER NOT NULL DEFAULT 1,
    added_at TEXT NOT NULL, added_by TEXT, last_seen TEXT)`).run();
  const n = await env.DB.prepare("SELECT COUNT(*) AS n FROM team_members").first();
  if (!n.n) {
    const now = new Date().toISOString();
    for (const m of DEFAULT_TEAM) {
      await env.DB.prepare("INSERT INTO team_members (id, name, email, role, active, added_at) VALUES (?1, ?2, NULL, ?3, 1, ?4)").bind(m.id, m.name, m.role, now).run();
    }
  }
  teamTableReady = true;
}
const memberOut = (r) => ({ id: r.id, name: r.name, email: r.email || "", role: r.role, active: !!r.active, addedAt: r.added_at, lastSeen: r.last_seen || null });

async function listTeam(env) {
  await ensureTeamTable(env);
  const { results } = await env.DB.prepare("SELECT * FROM team_members ORDER BY active DESC, added_at ASC").all();
  return { members: (results || []).map(memberOut) };
}

function requireAdmin(viewer) {
  if (!viewer.accessEnabled) return; // open mode: no identities to check yet
  if (!viewer.member || viewer.member.role !== "admin") throw new HttpError(403, "Only admins can do that.");
}

async function saveMember(request, env, viewer) {
  const b = await request.json().catch(() => ({}));
  const name = String(b.name || "").trim().slice(0, 60);
  const email = String(b.email || "").trim().toLowerCase().slice(0, 120);
  const role = String(b.role || "");
  const active = b.active === false ? 0 : 1;
  if (!name) throw new HttpError(400, "Name is required.");
  if (email && !/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email)) throw new HttpError(400, "That email doesn't look right.");
  if (!ROLES.includes(role)) throw new HttpError(400, "Unknown role.");
  await ensureTeamTable(env);
  if (email) {
    const clash = await env.DB.prepare("SELECT id FROM team_members WHERE email = ?1 AND id != ?2").bind(email, b.id || "").first();
    if (clash) throw new HttpError(409, "Someone on the team already uses that email.");
  }
  const id = b.id || "u_" + crypto.randomUUID().slice(0, 8);
  const existing = await env.DB.prepare("SELECT * FROM team_members WHERE id = ?1").bind(id).first();
  // Never leave the team without an active admin who can sign in.
  if (existing && existing.role === "admin" && existing.active && (role !== "admin" || !active)) {
    const others = await env.DB.prepare("SELECT COUNT(*) AS n FROM team_members WHERE role = 'admin' AND active = 1 AND id != ?1").bind(id).first();
    if (!others.n) throw new HttpError(400, "Keep at least one active admin.");
  }
  if (existing) {
    await env.DB.prepare("UPDATE team_members SET name = ?2, email = ?3, role = ?4, active = ?5 WHERE id = ?1").bind(id, name, email || null, role, active).run();
  } else {
    await env.DB.prepare("INSERT INTO team_members (id, name, email, role, active, added_at, added_by) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7)")
      .bind(id, name, email || null, role, active, new Date().toISOString(), viewer.member ? viewer.member.email : null).run();
  }
  return { member: memberOut(await env.DB.prepare("SELECT * FROM team_members WHERE id = ?1").bind(id).first()) };
}

// ---- Cloudflare Access token check (RS256 JWT signed by the team's Access certs)
let accessKeys = null; // { at, keys: Map(kid -> CryptoKey) }
async function accessKey(env, kid) {
  const fresh = accessKeys && Date.now() - accessKeys.at < 3600e3;
  if (!fresh || !accessKeys.keys.has(kid)) {
    const r = await fetch(`https://${env.ACCESS_TEAM_DOMAIN}/cdn-cgi/access/certs`);
    const d = await r.json();
    const keys = new Map();
    for (const k of d.keys || []) {
      keys.set(k.kid, await crypto.subtle.importKey("jwk", k, { name: "RSASSA-PKCS1-v1_5", hash: "SHA-256" }, false, ["verify"]));
    }
    accessKeys = { at: Date.now(), keys };
  }
  return accessKeys.keys.get(kid);
}
function b64urlDecode(str) {
  const s = str.replace(/-/g, "+").replace(/_/g, "/");
  return Uint8Array.from(atob(s + "===".slice((s.length + 3) % 4)), (c) => c.charCodeAt(0));
}
async function verifyAccessJwt(token, env) {
  const [h, p, sig] = (token || "").split(".");
  if (!h || !p || !sig) return null;
  const header = JSON.parse(new TextDecoder().decode(b64urlDecode(h)));
  const payload = JSON.parse(new TextDecoder().decode(b64urlDecode(p)));
  const key = await accessKey(env, header.kid);
  if (!key) return null;
  const ok = await crypto.subtle.verify("RSASSA-PKCS1-v1_5", key, b64urlDecode(sig), new TextEncoder().encode(h + "." + p));
  if (!ok) return null;
  const aud = Array.isArray(payload.aud) ? payload.aud : [payload.aud];
  if (!aud.includes(env.ACCESS_AUD)) return null;
  if (payload.iss !== `https://${env.ACCESS_TEAM_DOMAIN}`) return null;
  if (!payload.exp || payload.exp * 1000 < Date.now()) return null;
  return payload;
}

async function identify(request, env) {
  if (!env.ACCESS_TEAM_DOMAIN || !env.ACCESS_AUD) return { accessEnabled: false, member: null };
  const token = request.headers.get("Cf-Access-Jwt-Assertion") || cookie(request, "CF_Authorization");
  const claims = token ? await verifyAccessJwt(token, env) : null;
  if (!claims || !claims.email) { const e = new HttpError(401, "Please sign in again."); e.code = "signed_out"; throw e; }
  const email = String(claims.email).toLowerCase();
  await ensureTeamTable(env);
  let row = await env.DB.prepare("SELECT * FROM team_members WHERE email = ?1").bind(email).first();
  // Bootstrap: emails in BOOTSTRAP_ADMINS always get in as admins (added to the list the first time).
  const bootstrap = String(env.BOOTSTRAP_ADMINS || "").toLowerCase().split(/[\s,]+/).filter(Boolean);
  if (!row && bootstrap.includes(email)) {
    await env.DB.prepare("INSERT INTO team_members (id, name, email, role, active, added_at, added_by) VALUES (?1, ?2, ?3, 'admin', 1, ?4, 'bootstrap')")
      .bind("u_" + crypto.randomUUID().slice(0, 8), email.split("@")[0], email, new Date().toISOString()).run();
    row = await env.DB.prepare("SELECT * FROM team_members WHERE email = ?1").bind(email).first();
  }
  if (!row || !row.active) { const e = new HttpError(403, email + " isn't on the Creator Studio team. Ask an admin to add you in Settings → Team & access."); e.code = "not_member"; throw e; }
  if (!row.last_seen || Date.now() - Date.parse(row.last_seen) > 3600e3) {
    await env.DB.prepare("UPDATE team_members SET last_seen = ?2 WHERE id = ?1").bind(row.id, new Date().toISOString()).run();
  }
  return { accessEnabled: true, email, member: memberOut(row) };
}

function meResponse(viewer, request) {
  return {
    accessEnabled: viewer.accessEnabled,
    member: viewer.member,
    logoutUrl: viewer.accessEnabled ? new URL("/cdn-cgi/access/logout", request.url).toString() : null,
  };
}

// ---------------------------------------------------------------------------
// Smart insights — Claude reads a compact snapshot of the pipeline and performance and suggests what to do
// next. Needs the ANTHROPIC_API_KEY secret; without it the app shows its own built-in insights instead.
// ---------------------------------------------------------------------------

const INSIGHTS_SYSTEM = `You are the social media strategist for Sanjugo, a Japanese restaurant group in London (branches: Shoreditch, Angel, Victoria). The team posts food, behind-the-scenes and offer content to Instagram, TikTok, Facebook, YouTube Shorts and Google Business, and plans it in their own tool, Sanjugo Creator Studio.

You will get a snapshot from that tool. Write for a small, busy team: be specific to the numbers in the snapshot, suggest things they can do this week, and don't give generic marketing advice or invent numbers that aren't there. If the snapshot says some figures are sample data, still work with them, and say once, briefly, that they are sample figures.

Reply with only a JSON object and nothing else, in exactly this shape:
{"headline": "one sentence, at most 20 words", "insights": [{"title": "at most 8 words", "detail": "1-2 sentences that cite the numbers", "action": "one concrete thing to do this week"}], "risk": "the single biggest bottleneck or risk right now, in one sentence"}
Give 3 or 4 insights.`;

async function generateInsights(request, env) {
  if (!env.ANTHROPIC_API_KEY) return json({ error: "not_configured" }, 503);
  const body = await request.json().catch(() => ({}));
  const snapshot = String(body.snapshot || "").slice(0, 16000);
  if (!snapshot) return json({ error: "Missing snapshot" }, 400);
  // Light throttle so repeated taps don't each cost a request: reuse anything from the last 30 seconds.
  const last = await kvGet(env, "insights_latest");
  if (last && Date.now() - Date.parse(last.generatedAt) < 30e3) return json(last);

  const client = new Anthropic({ apiKey: env.ANTHROPIC_API_KEY });
  let response;
  try {
    response = await client.beta.messages.create({
      model: "claude-opus-5",
      max_tokens: 16000,
      output_config: { effort: "medium" },
      // If a safety classifier ever declines, the API retries on its recommended fallback model instead of failing.
      betas: ["server-side-fallback-2026-07-01"],
      fallbacks: "default",
      system: INSIGHTS_SYSTEM,
      messages: [{ role: "user", content: snapshot }],
    });
  } catch (e) {
    if (e instanceof Anthropic.AuthenticationError) return json({ error: "The Claude API key was rejected — check the ANTHROPIC_API_KEY secret." }, 502);
    if (e instanceof Anthropic.PermissionDeniedError) return json({ error: "The Claude API key isn't allowed to use this model — check the Anthropic Console." }, 502);
    if (e instanceof Anthropic.RateLimitError) return json({ error: "Claude is busy right now — try again in a minute." }, 429);
    if (e instanceof Anthropic.APIError) return json({ error: "Claude API error (" + e.status + ") — try again shortly." }, 502);
    return json({ error: "Couldn't reach Claude — try again shortly." }, 502);
  }
  if (response.stop_reason === "refusal") return json({ error: "Claude declined to analyse this snapshot." }, 502);
  const text = response.content.filter((b) => b.type === "text").map((b) => b.text).join("");
  let parsed;
  try {
    parsed = JSON.parse(text.slice(text.indexOf("{"), text.lastIndexOf("}") + 1));
  } catch (e) {
    parsed = { headline: "", insights: [], risk: "", text };
  }
  const result = {
    headline: String(parsed.headline || ""),
    insights: (Array.isArray(parsed.insights) ? parsed.insights : []).slice(0, 5).map((i) => ({ title: String(i.title || ""), detail: String(i.detail || ""), action: String(i.action || "") })),
    risk: String(parsed.risk || ""),
    text: parsed.text || null,
    generatedAt: new Date().toISOString(),
    model: response.model,
    source: "claude",
  };
  await kvSet(env, "insights_latest", result);
  return json(result);
}

// ---------------------------------------------------------------------------
// Workflow updates in Team Chat. When the shared state is saved, any new activity (a post sent for approval,
// approved, sent back, rejected, resubmitted, published) becomes a message from "Creator Studio" that
// @mentions whoever needs to act. Only events from the last 15 minutes are posted (no backfill), and the
// unique event_id means the same event is never posted twice, however many devices save the state.
// ---------------------------------------------------------------------------

const UPDATE_WINDOW_MS = 15 * 60 * 1000;

async function postWorkflowUpdates(env, body) {
  const log = Array.isArray(body.activityLog) ? body.activityLog : [];
  const now = Date.now();
  const fresh = log.filter((a) => a && a.id && a.at && now - Date.parse(a.at) < UPDATE_WINDOW_MS).slice(0, 25);
  if (!fresh.length) return;
  const items = new Map((Array.isArray(body.contentItems) ? body.contentItems : []).map((i) => [i.id, i]));
  const { members } = await listTeam(env);
  const byId = new Map(members.map((m) => [m.id, m]));
  const nameOf = (id) => (byId.get(id) || {}).name || "Someone";
  const reviewers = members.filter((m) => m.active && (m.role === "approver" || m.role === "admin"));
  await ensureChatTable(env);

  for (const a of fresh) {
    if (String(a.id).startsWith("act_make_")) continue; // Make results are announced when Make reports back
    const item = items.get(a.contentId);
    if (!item) continue;
    const actor = nameOf(a.user);
    const title = item.title || a.contentTitle || "a post";
    const platforms = (item.platforms || []).map((p) => ({ instagram: "Instagram", tiktok: "TikTok", facebook: "Facebook", youtube: "YouTube Shorts", gbp: "Google Business" }[p] || p)).join(", ");
    const note = a.comment ? `\n“${String(a.comment).slice(0, 300)}”` : "";
    // Who needs to act: the approver for anything waiting on review, the creator for decisions on their post.
    let text = null, notify = [];
    const approverOrReviewers = () => {
      const ap = byId.get(item.approver);
      if (ap && ap.active && ap.id !== a.user) return [ap.id];
      return reviewers.filter((r) => r.id !== a.user).map((r) => r.id);
    };
    const creator = item.creator && item.creator !== a.user ? [item.creator] : [];
    if (a.type === "created" && /submitted/i.test(a.detail || "")) {
      notify = approverOrReviewers();
      text = `🔔 ${actor} sent “${title}” for approval (${platforms}).`;
    } else if (a.type === "submitted") {
      notify = approverOrReviewers();
      text = `🔁 ${actor} resubmitted “${title}”${a.version ? " as v" + a.version : ""} after changes.${note}`;
    } else if (a.type === "approved") {
      notify = creator;
      text = `✅ ${actor} approved “${title}”.`;
    } else if (a.type === "changes_requested") {
      notify = creator;
      text = `✏️ ${actor} asked for changes on “${title}”.${note}`;
    } else if (a.type === "rejected") {
      notify = creator;
      text = `⛔ ${actor} rejected “${title}”.${note}`;
    } else if (a.type === "published") {
      notify = creator;
      text = `🚀 “${title}” is live on ${platforms} — marked by ${actor}.`;
    }
    if (!text) continue;
    const mentions = [...new Set(notify)];
    const alert = text;
    if (mentions.length) text += " " + mentions.map((id) => "@" + nameOf(id)).join(" ");
    const res = await env.DB.prepare(
      "INSERT OR IGNORE INTO chat_messages (author, text, mentions, content_id, created_at, event_id) VALUES ('system', ?1, ?2, ?3, ?4, ?5)"
    ).bind(text, JSON.stringify(mentions), item.id, new Date().toISOString(), a.id).run();
    // Only the save that actually posted the update sends the push, so nobody gets the same alert twice.
    if (res.meta && res.meta.changes > 0 && mentions.length) {
      const tab = { created: "review", submitted: "review", changes_requested: "changes", rejected: "rejected" }[a.type];
      await pushToUsers(env, mentions, { title: "Creator Studio", body: alert.slice(0, 220), url: tab ? "/#/queue?tab=" + tab : "/#/chat", tag: "post-" + item.id });
    }
  }
}

// ---------------------------------------------------------------------------
// Push alerts — lock-screen / desktop notifications through the standard Web Push service of each browser
// (Apple, Google, Mozilla), so people hear about approvals and @mentions with Creator Studio closed.
// Each device opts in from Settings → Notifications; its subscription is kept in D1 (push_subs) against the
// team member using it. The server's VAPID signing key is created on first use and kept in app_kv, so there
// is nothing to configure. Payloads are encrypted to each device as the standard requires (RFC 8291).
// iPhone/iPad only allow this for the Home Screen app (Share → Add to Home Screen), iOS 16.4 or later.
// ---------------------------------------------------------------------------

async function ensurePushTable(env) {
  await env.DB.prepare(`CREATE TABLE IF NOT EXISTS push_subs (
    endpoint TEXT PRIMARY KEY, user_id TEXT NOT NULL, p256dh TEXT NOT NULL, auth TEXT NOT NULL,
    device TEXT, created_at TEXT NOT NULL, last_ok TEXT)`).run();
}

function concatBytes(...parts) {
  const out = new Uint8Array(parts.reduce((n, p) => n + p.length, 0));
  let o = 0;
  for (const p of parts) { out.set(p, o); o += p.length; }
  return out;
}

let vapidCache = null;
async function vapidKeys(env) {
  if (vapidCache) return vapidCache;
  await ensureStorageTables(env);
  let saved = await kvGet(env, "vapid_keys");
  if (!saved) {
    const kp = await crypto.subtle.generateKey({ name: "ECDSA", namedCurve: "P-256" }, true, ["sign", "verify"]);
    const candidate = {
      publicKey: b64url(await crypto.subtle.exportKey("raw", kp.publicKey)),
      privateJwk: await crypto.subtle.exportKey("jwk", kp.privateKey),
      createdAt: new Date().toISOString(),
    };
    // Two requests racing on first use must end up with the same key, so only the first write wins.
    await env.DB.prepare("INSERT OR IGNORE INTO app_kv (k, v) VALUES ('vapid_keys', ?1)").bind(JSON.stringify(candidate)).run();
    saved = await kvGet(env, "vapid_keys");
  }
  const privateKey = await crypto.subtle.importKey("jwk", saved.privateJwk, { name: "ECDSA", namedCurve: "P-256" }, false, ["sign"]);
  vapidCache = { publicKey: saved.publicKey, privateKey };
  return vapidCache;
}

async function vapidAuthHeader(env, endpoint) {
  const { publicKey, privateKey } = await vapidKeys(env);
  const enc = (o) => b64url(new TextEncoder().encode(JSON.stringify(o)));
  const admin = String(env.BOOTSTRAP_ADMINS || "").split(/[\s,]+/).filter(Boolean)[0];
  const unsigned = enc({ typ: "JWT", alg: "ES256" }) + "." + enc({
    aud: new URL(endpoint).origin,
    exp: Math.floor(Date.now() / 1000) + 12 * 3600,
    sub: admin ? "mailto:" + admin : "https://sanjugo.co.uk",
  });
  const sig = await crypto.subtle.sign({ name: "ECDSA", hash: "SHA-256" }, privateKey, new TextEncoder().encode(unsigned));
  return `vapid t=${unsigned}.${b64url(sig)}, k=${publicKey}`;
}

// aes128gcm content encoding for Web Push (RFC 8291 + RFC 8188), single record.
async function encryptPushPayload(sub, plaintext) {
  const uaPublic = b64urlDecode(sub.p256dh);
  const authSecret = b64urlDecode(sub.auth);
  const te = new TextEncoder();
  const hkdf = async (salt, ikm, info, bytes) => {
    const key = await crypto.subtle.importKey("raw", ikm, "HKDF", false, ["deriveBits"]);
    return new Uint8Array(await crypto.subtle.deriveBits({ name: "HKDF", hash: "SHA-256", salt, info }, key, bytes * 8));
  };
  const local = await crypto.subtle.generateKey({ name: "ECDH", namedCurve: "P-256" }, true, ["deriveBits"]);
  const asPublic = new Uint8Array(await crypto.subtle.exportKey("raw", local.publicKey));
  const uaKey = await crypto.subtle.importKey("raw", uaPublic, { name: "ECDH", namedCurve: "P-256" }, false, []);
  const ecdhSecret = new Uint8Array(await crypto.subtle.deriveBits({ name: "ECDH", public: uaKey }, local.privateKey, 256));
  const ikm = await hkdf(authSecret, ecdhSecret, concatBytes(te.encode("WebPush: info\0"), uaPublic, asPublic), 32);
  const salt = crypto.getRandomValues(new Uint8Array(16));
  const cek = await hkdf(salt, ikm, te.encode("Content-Encoding: aes128gcm\0"), 16);
  const nonce = await hkdf(salt, ikm, te.encode("Content-Encoding: nonce\0"), 12);
  const aesKey = await crypto.subtle.importKey("raw", cek, "AES-GCM", false, ["encrypt"]);
  const record = concatBytes(te.encode(plaintext), new Uint8Array([2])); // 0x02 = last (only) record, no padding
  const cipher = new Uint8Array(await crypto.subtle.encrypt({ name: "AES-GCM", iv: nonce }, aesKey, record));
  const header = new Uint8Array(21);
  header.set(salt, 0);
  new DataView(header.buffer).setUint32(16, 4096);
  header[20] = asPublic.length;
  return concatBytes(header, asPublic, cipher);
}

async function sendPushTo(env, sub, message) {
  const body = await encryptPushPayload(sub, JSON.stringify(message));
  const res = await fetch(sub.endpoint, {
    method: "POST",
    headers: {
      Authorization: await vapidAuthHeader(env, sub.endpoint),
      "Content-Encoding": "aes128gcm",
      "Content-Type": "application/octet-stream",
      TTL: String(24 * 3600),
      Urgency: "high",
      ...(message.tag ? { Topic: String(message.tag).replace(/[^A-Za-z0-9_-]/g, "").slice(0, 32) } : {}),
    },
    body,
  });
  if (res.status === 404 || res.status === 410) {
    // The device unsubscribed or the browser dropped the subscription — forget it.
    await env.DB.prepare("DELETE FROM push_subs WHERE endpoint = ?1").bind(sub.endpoint).run();
    return { ok: false, gone: true, status: res.status };
  }
  if (!res.ok) {
    const detail = (await res.text().catch(() => "")).slice(0, 200);
    console.error("push failed", res.status, new URL(sub.endpoint).host, detail);
    return { ok: false, status: res.status, detail };
  }
  await env.DB.prepare("UPDATE push_subs SET last_ok = ?2 WHERE endpoint = ?1").bind(sub.endpoint, new Date().toISOString()).run();
  return { ok: true, status: res.status };
}

// message: { title, body, url, tag } — sent to every device of each listed team member.
async function pushToUsers(env, userIds, message) {
  const ids = [...new Set((userIds || []).filter(Boolean))];
  if (!ids.length) return;
  await ensurePushTable(env);
  const { results } = await env.DB.prepare(
    `SELECT * FROM push_subs WHERE user_id IN (${ids.map((_, i) => "?" + (i + 1)).join(",")})`
  ).bind(...ids).all();
  await Promise.all((results || []).map((s) => sendPushTo(env, s, message).catch((e) => console.error("push error", e))));
}

async function pushRoute(request, env, url, viewer) {
  if (url.pathname === "/api/push/key" && request.method === "GET") {
    return json({ publicKey: (await vapidKeys(env)).publicKey });
  }
  if (request.method !== "POST") return json({ error: "Not found" }, 404);
  const body = await request.json().catch(() => ({}));
  await ensurePushTable(env);
  if (url.pathname === "/api/push/subscribe") {
    const s = body.subscription || {};
    const keys = s.keys || {};
    if (!/^https:\/\//.test(s.endpoint || "") || !keys.p256dh || !keys.auth) return json({ error: "Invalid subscription" }, 400);
    // With sign-in on, the device belongs to whoever is signed in; before that, to the name picked on the welcome page.
    const userId = viewer.member ? viewer.member.id : String(body.userId || "").slice(0, 64);
    if (!userId) return json({ error: "userId is required" }, 400);
    await env.DB.prepare(
      `INSERT INTO push_subs (endpoint, user_id, p256dh, auth, device, created_at) VALUES (?1, ?2, ?3, ?4, ?5, ?6)
       ON CONFLICT(endpoint) DO UPDATE SET user_id = excluded.user_id, p256dh = excluded.p256dh, auth = excluded.auth, device = excluded.device`
    ).bind(s.endpoint, userId, String(keys.p256dh), String(keys.auth), String(body.device || "").slice(0, 80), new Date().toISOString()).run();
    return json({ ok: true, userId });
  }
  if (url.pathname === "/api/push/unsubscribe") {
    await env.DB.prepare("DELETE FROM push_subs WHERE endpoint = ?1").bind(String(body.endpoint || "")).run();
    return json({ ok: true });
  }
  if (url.pathname === "/api/push/test") {
    const sub = await env.DB.prepare("SELECT * FROM push_subs WHERE endpoint = ?1").bind(String(body.endpoint || "")).first();
    if (!sub) return json({ error: "This device isn't signed up for alerts yet." }, 404);
    const r = await sendPushTo(env, sub, { title: "Creator Studio", body: "✅ Alerts are working on this device.", url: "/#/settings", tag: "test" });
    return r.ok ? json({ ok: true }) : json({ error: `The push service said ${r.status}${r.detail ? ": " + r.detail : ""}` }, 502);
  }
  return json({ error: "Not found" }, 404);
}

// ---------------------------------------------------------------------------
// Make.com — auto-publishing and real analytics.
// Every platform has its own pair of Make scenarios (folders "Creator Studio · Publish" and "Creator Studio · Pull"),
// each with its own webhook saved by an admin in Settings → Make.com — so one platform can be fixed, paused or
// switched to another account without touching the others:
//   • "Publish · <platform>": gets one post, publishes it and calls /api/make/callback with the live link (or error).
//   • "Pull · <platform>": sends back the latest posts with their stats.
// Every request carries a one-time random token and the callback must return it, so nothing else can report
// results. Which accounts are used is chosen inside Make. A platform without a publish webhook stays manual.
// ---------------------------------------------------------------------------

const MAKE_PLATFORMS = ["instagram", "facebook", "tiktok", "youtube", "gbp"];
const MAKE_HOOK_RE = /^https:\/\/hook\.[a-z0-9]+\.make\.com\/[A-Za-z0-9]+$/;
const DEFAULT_PUBLIC_URL = "https://sanjugo-content-engine.rapid-dust-8baf.workers.dev";
const PLATFORM_NAMES = { instagram: "Instagram", facebook: "Facebook", youtube: "YouTube Shorts", tiktok: "TikTok", gbp: "Google Business" };

async function ensureMakeTables(env) {
  await env.DB.prepare(`CREATE TABLE IF NOT EXISTS make_jobs (
    id TEXT PRIMARY KEY, kind TEXT NOT NULL, content_id TEXT, platform TEXT, token TEXT NOT NULL, status TEXT NOT NULL,
    post_id TEXT, permalink TEXT, error TEXT, requested_by TEXT, trigger TEXT, scheduled_for TEXT, detail TEXT,
    created_at TEXT NOT NULL, updated_at TEXT NOT NULL)`).run();
  await env.DB.prepare(`CREATE TABLE IF NOT EXISTS social_posts (
    platform TEXT NOT NULL, post_id TEXT NOT NULL, content_id TEXT, permalink TEXT, caption TEXT, type TEXT, thumb TEXT,
    published_at TEXT, likes INTEGER, comments INTEGER, shares INTEGER, saves INTEGER, reach INTEGER, views INTEGER,
    updated_at TEXT NOT NULL, PRIMARY KEY (platform, post_id))`).run();
  await env.DB.prepare(`CREATE TABLE IF NOT EXISTS social_snapshots (
    platform TEXT NOT NULL, post_id TEXT NOT NULL, day TEXT NOT NULL, likes INTEGER, comments INTEGER, shares INTEGER,
    saves INTEGER, reach INTEGER, views INTEGER, PRIMARY KEY (platform, post_id, day))`).run();
}

async function makeConfig(env) {
  const c = (await kvGet(env, "make_config")) || {};
  const hooks = { publish: { ...((c.hooks || {}).publish || {}) }, pull: { ...((c.hooks || {}).pull || {}) } };
  return { hooks, autoPublish: !!c.autoPublish, updatedAt: c.updatedAt || null };
}
const publishHookFor = (cfg, p) => cfg.hooks.publish[p] || "";
const pullPlatforms = (cfg) => MAKE_PLATFORMS.filter((p) => cfg.hooks.pull[p]);
function makeStatus(cfg) {
  const out = {};
  for (const p of MAKE_PLATFORMS) {
    out[p] = {
      publish: { configured: !!cfg.hooks.publish[p], hook: hookLabel(cfg.hooks.publish[p]) },
      pull: { configured: !!cfg.hooks.pull[p], hook: hookLabel(cfg.hooks.pull[p]) },
    };
  }
  return out;
}
const GBP_CTA = { "learn more": "LEARN_MORE", book: "BOOK", "order online": "ORDER", order: "ORDER", shop: "SHOP", buy: "SHOP", "sign up": "SIGN_UP", call: "CALL", "call now": "CALL" };
const hookLabel = (u) => (u ? u.replace(/^(https:\/\/hook\.[^/]+\/)(.{4}).*$/, "$1$2…") : "");

// Scheduled times are saved from the browser as London wall-clock time without a zone ("2026-09-28T18:00:00").
function tzOffsetMs(ts, tz) {
  const parts = new Intl.DateTimeFormat("en-GB", { timeZone: tz, hourCycle: "h23", year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit", second: "2-digit" }).formatToParts(new Date(ts));
  const g = (t) => Number(parts.find((p) => p.type === t).value);
  return Date.UTC(g("year"), g("month") - 1, g("day"), g("hour"), g("minute"), g("second")) - ts;
}
function londonTime(s) {
  if (!s) return NaN;
  if (/(Z|[+-]\d\d:?\d\d)$/i.test(s)) return Date.parse(s);
  const asUtc = Date.parse(s + "Z");
  return asUtc - tzOffsetMs(asUtc, "Europe/London");
}
const londonDay = (ts = Date.now()) => new Date(ts + tzOffsetMs(ts, "Europe/London")).toISOString().slice(0, 10);

async function readState(env) {
  const row = await env.DB.prepare("SELECT data FROM app_state WHERE id = 1").first();
  return row ? JSON.parse(row.data) : {};
}

async function postSystemChat(env, { text, mentions = [], contentId = null, eventId }) {
  await ensureChatTable(env);
  const res = await env.DB.prepare(
    "INSERT OR IGNORE INTO chat_messages (author, text, mentions, content_id, created_at, event_id) VALUES ('system', ?1, ?2, ?3, ?4, ?5)"
  ).bind(text, JSON.stringify(mentions), contentId, new Date().toISOString(), eventId).run();
  return !!(res.meta && res.meta.changes > 0);
}

function jobOut(r) {
  let detail = null;
  try { detail = r.detail ? JSON.parse(r.detail) : null; } catch (e) {}
  return { id: r.id, kind: r.kind, contentId: r.content_id, platform: r.platform, status: r.status, postId: r.post_id,
    permalink: r.permalink, error: r.error, requestedBy: r.requested_by, trigger: r.trigger, scheduledFor: r.scheduled_for,
    detail, createdAt: r.created_at, updatedAt: r.updated_at };
}

async function callHook(url, payload) {
  const res = await fetch(url, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(payload) });
  const text = (await res.text().catch(() => "")).slice(0, 200);
  if (!res.ok) throw new HttpError(502, `Make didn't accept the request (${res.status}${text ? ": " + text : ""}). Check the scenario is switched on.`);
}

function absoluteMediaUrl(u, origin) {
  if (!u) return null;
  if (/^https:\/\//.test(u)) return u;
  if (u.startsWith("/")) return origin + u;
  return null; // blob:, data: — a local preview that never reached storage
}

// Send one post to Make for the given platforms. Returns the jobs created (or reasons they weren't).
const isStory = (item, v) => item.format === "story" || (v && v.postType === "Story");

async function sendPublishJobs(env, { item, platforms, origin, userId, trigger }) {
  const cfg = await makeConfig(env);
  await ensureMakeTables(env);
  const results = [];
  const mediaUrl = absoluteMediaUrl(item.media && item.media.fileUrl, origin);
  for (const platform of platforms) {
    const v = (item.variants || {})[platform];
    const hook = publishHookFor(cfg, platform);
    if (!hook) { results.push({ platform, skipped: (PLATFORM_NAMES[platform] || platform) + " isn't connected to Make — publish it by hand, then mark it as published." }); continue; }
    if (!v) { results.push({ platform, skipped: "This post isn't set up for " + PLATFORM_NAMES[platform] + "." }); continue; }
    if (v.publishStatus === "published") { results.push({ platform, skipped: "Already published." }); continue; }
    // Make can't post stories (its Instagram app has no story module) — sending one would post it as a normal reel/post.
    if (isStory(item, v)) { results.push({ platform, skipped: "Stories can't be posted through Make — post it from the " + PLATFORM_NAMES[platform] + " app, then mark it as published." }); continue; }
    if (!mediaUrl) { results.push({ platform, skipped: "The video or photo hasn't finished uploading to Creator Studio." }); continue; }
    // Google Business posts take a photo: for a video, send its cover image instead.
    const gbpImage = platform === "gbp" ? (item.media.type === "image" ? mediaUrl : absoluteMediaUrl(item.media.previewUrl, origin)) : null;
    if (platform === "gbp" && !gbpImage) { results.push({ platform, skipped: "Google Business needs a photo — this video has no stored cover image." }); continue; }
    const busy = await env.DB.prepare(
      "SELECT id FROM make_jobs WHERE kind = 'publish' AND content_id = ?1 AND platform = ?2 AND (status = 'done' OR (status = 'sent' AND created_at > ?3))"
    ).bind(item.id, platform, new Date(Date.now() - 20 * 60e3).toISOString()).first();
    if (busy) { results.push({ platform, skipped: "Already sent to Make." }); continue; }
    // (Older posts may still hold typed hashtags in hashtagsText.)
    const allTags = (v.hashtags && v.hashtags.length) ? v.hashtags : String(v.hashtagsText || "").split(/[\s,]+/).filter(Boolean).map((t) => (t.startsWith("#") ? t : "#" + t));
    const tags = allTags.filter((t) => !(v.caption || "").includes(t)).join(" ");
    const caption = [v.caption || "", tags].filter(Boolean).join("\n\n").slice(0, 2200);
    const isPhoto = item.media && item.media.type === "image";
    const key = String(item.media.fileUrl).split("/").pop().split("?")[0];
    const job = {
      id: "job_" + crypto.randomUUID().slice(0, 12), token: crypto.randomUUID() + crypto.randomUUID().slice(0, 8),
      platform, contentId: item.id,
    };
    const cta = GBP_CTA[String(v.cta || "").trim().toLowerCase()] || (v.url ? "LEARN_MORE" : "CALL");
    const payload = {
      token: job.token, jobId: job.id, contentId: item.id, platform,
      kind: isPhoto ? "photo" : platform === "youtube" ? "short" : platform === "gbp" ? "update" : "reel",
      title: String(v.title || item.title || "Sanjugo").replace(/[<>]/g, "").slice(0, 100),
      caption: platform === "youtube" ? String(v.description || caption).replace(/[<>]/g, "") : platform === "gbp" ? caption.slice(0, 1500) : caption,
      mediaUrl: gbpImage || mediaUrl, fileName: key || (isPhoto ? "photo.jpg" : "video.mp4"), privacy: "public",
      mediaFormat: isPhoto || gbpImage ? "PHOTO" : "VIDEO",
      // Google Business button: needs a link unless it's "Call" (which uses the listing's phone number).
      ctaType: !v.url ? "CALL" : cta, ctaUrl: v.url || "",
    };
    const now = new Date().toISOString();
    await env.DB.prepare(
      `INSERT INTO make_jobs (id, kind, content_id, platform, token, status, requested_by, trigger, scheduled_for, detail, created_at, updated_at)
       VALUES (?1, 'publish', ?2, ?3, ?4, 'sent', ?5, ?6, ?7, ?8, ?9, ?9)`
    ).bind(job.id, item.id, platform, job.token, userId || null, trigger, v.scheduledAt || null, JSON.stringify({ title: item.title }), now).run();
    try {
      await callHook(hook, payload);
      results.push({ platform, jobId: job.id, status: "sent" });
    } catch (e) {
      await env.DB.prepare("UPDATE make_jobs SET status = 'failed', error = ?2, updated_at = ?3 WHERE id = ?1").bind(job.id, e.message, new Date().toISOString()).run();
      results.push({ platform, jobId: job.id, status: "failed", error: e.message });
    }
  }
  return results;
}

async function triggerAnalyticsPull(env, { trigger }) {
  const cfg = await makeConfig(env);
  const platforms = pullPlatforms(cfg);
  if (!platforms.length) throw new HttpError(400, "Add at least one Pull webhook in Settings → Make.com first.");
  await ensureMakeTables(env);
  const id = "pull_" + crypto.randomUUID().slice(0, 12);
  const token = crypto.randomUUID() + crypto.randomUUID().slice(0, 8);
  const now = new Date().toISOString();
  await env.DB.prepare(
    "INSERT INTO make_jobs (id, kind, token, status, trigger, detail, created_at, updated_at) VALUES (?1, 'analytics', ?2, 'sent', ?3, '{}', ?4, ?4)"
  ).bind(id, token, trigger, now).run();
  // Each platform's Pull scenario runs on its own, so one broken platform doesn't stop the others.
  const sent = [], failed = [];
  await Promise.all(platforms.map(async (p) => {
    try { await callHook(cfg.hooks.pull[p], { token, platforms: p }); sent.push(p); }
    catch (e) { failed.push({ platform: p, error: e.message }); }
  }));
  await env.DB.prepare("UPDATE make_jobs SET status = ?2, error = ?3, detail = ?4 WHERE id = ?1")
    .bind(id, sent.length ? "sent" : "failed", failed.length ? failed.map((f) => PLATFORM_NAMES[f.platform] + ": " + f.error).join(" · ") : null, JSON.stringify({ requested: sent })).run();
  if (!sent.length) throw new HttpError(502, failed.map((f) => PLATFORM_NAMES[f.platform] + ": " + f.error).join(" · "));
  return { id, requestedAt: now, requested: sent, failed };
}

const num = (v) => { const n = Number(v); return Number.isFinite(n) ? Math.round(n) : 0; };
const dec = (s) => { try { return decodeURIComponent(String(s || "").replace(/\+/g, " ")); } catch (e) { return String(s || ""); } };
const normLink = (u) => String(u || "").split("?")[0].replace(/\/+$/, "").toLowerCase();
// Dates arrive as ISO text (Instagram, Facebook, YouTube) or Unix seconds (TikTok via HasData).
function toIsoDate(v) {
  if (v === undefined || v === null || String(v).trim() === "") return null;
  const n = Number(v);
  const d = Number.isFinite(n) ? new Date(n < 1e12 ? n * 1000 : n) : new Date(v);
  return isNaN(d.getTime()) ? null : d.toISOString();
}

async function handleMakeCallback(request, env, ctx) {
  const body = await request.json().catch(() => null);
  if (!body || !body.token) return json({ error: "token required" }, 400);
  await ensureMakeTables(env);
  const job = await env.DB.prepare("SELECT * FROM make_jobs WHERE token = ?1").bind(String(body.token)).first();
  if (!job) return json({ error: "Unknown or expired token" }, 403);
  const now = new Date().toISOString();

  if (job.kind === "analytics") {
    if (Date.now() - Date.parse(job.created_at) > 60 * 60e3) return json({ error: "Expired" }, 403);
    const platform = String(body.platform || "");
    if (!MAKE_PLATFORMS.includes(platform)) return json({ error: "Unknown platform" }, 400);
    const posts = Array.isArray(body.posts) ? body.posts.slice(0, 100) : [];
    // Link stats to Creator Studio posts: by the post id Make returned when it published, or by the saved live link.
    const { results: done } = await env.DB.prepare("SELECT content_id, post_id, permalink FROM make_jobs WHERE kind = 'publish' AND status = 'done' AND platform = ?1").bind(platform).all();
    const state = await readState(env);
    const byLink = new Map();
    for (const it of state.contentItems || []) {
      const v = (it.variants || {})[platform];
      if (v && v.postUrl) byLink.set(normLink(v.postUrl), it.id);
    }
    const day = londonDay();
    for (const p of posts) {
      if (!p || !p.id) continue;
      const m = p.m || {};
      const row = {
        id: String(p.id).slice(0, 80), permalink: String(p.permalink || "").slice(0, 300), caption: dec(p.caption).slice(0, 500),
        type: String(p.type || p.mediaType || "").slice(0, 20), thumb: dec(p.thumb).slice(0, 1000), at: toIsoDate(p.at),
        likes: num(p.likes), comments: num(p.comments), shares: num(m.shares ?? p.shares), saves: num(m.saved ?? p.saves),
        reach: num(m.reach ?? p.reach), views: num(m.views ?? p.views),
      };
      const link = normLink(row.permalink);
      const match = (done || []).find((d) => d.post_id && (d.post_id === row.id || link.includes(String(d.post_id).toLowerCase()) || (d.permalink && normLink(d.permalink) === link)));
      const contentId = match ? match.content_id : byLink.get(link) || null;
      await env.DB.prepare(
        `INSERT INTO social_posts (platform, post_id, content_id, permalink, caption, type, thumb, published_at, likes, comments, shares, saves, reach, views, updated_at)
         VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?12, ?13, ?14, ?15)
         ON CONFLICT(platform, post_id) DO UPDATE SET content_id = COALESCE(excluded.content_id, social_posts.content_id), permalink = excluded.permalink,
           caption = excluded.caption, type = excluded.type, thumb = excluded.thumb, published_at = excluded.published_at, likes = excluded.likes,
           comments = excluded.comments, shares = excluded.shares, saves = excluded.saves, reach = excluded.reach, views = excluded.views, updated_at = excluded.updated_at`
      ).bind(platform, row.id, contentId, row.permalink, row.caption, row.type, row.thumb, row.at, row.likes, row.comments, row.shares, row.saves, row.reach, row.views, now).run();
      await env.DB.prepare(
        `INSERT INTO social_snapshots (platform, post_id, day, likes, comments, shares, saves, reach, views) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9)
         ON CONFLICT(platform, post_id, day) DO UPDATE SET likes = excluded.likes, comments = excluded.comments, shares = excluded.shares,
           saves = excluded.saves, reach = excluded.reach, views = excluded.views`
      ).bind(platform, row.id, day, row.likes, row.comments, row.shares, row.saves, row.reach, row.views).run();
    }
    // Re-read: other platforms report back in parallel.
    const fresh = await env.DB.prepare("SELECT detail FROM make_jobs WHERE id = ?1").bind(job.id).first();
    let detail = {};
    try { detail = JSON.parse((fresh && fresh.detail) || "{}"); } catch (e) {}
    detail.counts = { ...(detail.counts || {}), [platform]: posts.length };
    await env.DB.prepare("UPDATE make_jobs SET status = 'done', detail = ?2, updated_at = ?3 WHERE id = ?1").bind(job.id, JSON.stringify(detail), now).run();
    const prev = (await kvGet(env, "make_last_pull")) || {};
    await kvSet(env, "make_last_pull", { at: now, jobId: job.id, platforms: { ...(prev.jobId === job.id ? prev.platforms : {}), [platform]: posts.length },
      byPlatform: { ...(prev.byPlatform || {}), [platform]: { at: now, count: posts.length } } });
    return json({ ok: true, saved: posts.length });
  }

  // Publish result (a late success still counts after a 20-minute timeout, so the post isn't sent twice)
  const ok = body.ok === true || body.ok === "true";
  const timedOut = job.status === "failed" && String(job.error || "").startsWith(TIMEOUT_NOTE);
  if (job.status !== "sent" && !(timedOut && ok)) return json({ ok: true, duplicate: true });
  const permalink = String(body.permalink || "").slice(0, 300) || null;
  const postId = String(body.postId || "").slice(0, 80) || null;
  const error = ok ? null : (dec(body.error) || "Make reported an error").slice(0, 500);
  await env.DB.prepare("UPDATE make_jobs SET status = ?2, post_id = ?3, permalink = ?4, error = ?5, updated_at = ?6 WHERE id = ?1")
    .bind(job.id, ok ? "done" : "failed", postId, permalink, error, now).run();

  // Tell the team straight away (Team Chat + push), even if nobody has Creator Studio open.
  ctx.waitUntil((async () => {
    const state = await readState(env);
    const item = (state.contentItems || []).find((i) => i.id === job.content_id) || {};
    const { members } = await listTeam(env);
    const byId = new Map(members.map((m) => [m.id, m]));
    const nameOf = (id) => (byId.get(id) || {}).name || "someone";
    const title = item.title || (JSON.parse(job.detail || "{}").title) || "a post";
    const where = PLATFORM_NAMES[job.platform] || job.platform;
    const who = [...new Set([item.creator, item.approver, job.requested_by].filter((id) => id && byId.has(id)))];
    const text = ok
      ? `🚀 “${title}” is live on ${where} — published automatically via Make.${permalink ? "\n" + permalink : ""}`
      : `⚠️ Publishing “${title}” to ${where} failed: ${error}\nOpen the post to try again, or publish it by hand.`;
    const posted = await postSystemChat(env, { text: text + (who.length ? " " + who.map((id) => "@" + nameOf(id)).join(" ") : ""), mentions: who, contentId: job.content_id, eventId: "make_" + job.id });
    // (After a timeout, the earlier "didn't finish" message used this event id, so a late success gets its own.)
    const eventId = "make_" + job.id + (timedOut ? "_late" : "");
    const posted2 = posted || (timedOut && await postSystemChat(env, { text: text + (who.length ? " " + who.map((id) => "@" + nameOf(id)).join(" ") : ""), mentions: who, contentId: job.content_id, eventId }));
    if (posted2 && who.length) await pushToUsers(env, who, { title: ok ? "Published" : "Publishing failed", body: text.split("\n")[0].slice(0, 200), url: "/#/chat", tag: "make-" + job.id });
  })().catch((e) => console.error("make notify", e)));
  return json({ ok: true });
}

// A publish request Make never answers (scenario off, account disconnected, Make down) would otherwise show
// "Publishing…" forever. After 20 minutes it's marked failed so the team sees it and can try again; if Make's answer
// still turns up later, a success wins (see handleMakeCallback), so nothing gets posted twice.
const MAKE_TIMEOUT_MS = 20 * 60e3;
const TIMEOUT_NOTE = "No answer from Make after 20 minutes";
async function expireStuckJobs(env, ctx) {
  await ensureMakeTables(env);
  const cutoff = new Date(Date.now() - MAKE_TIMEOUT_MS).toISOString();
  const { results } = await env.DB.prepare("SELECT * FROM make_jobs WHERE kind = 'publish' AND status = 'sent' AND created_at < ?1 LIMIT 20").bind(cutoff).all();
  for (const job of results || []) {
    const where = PLATFORM_NAMES[job.platform] || job.platform;
    const scenario = { instagram: "Instagram", facebook: "Facebook", youtube: "YouTube", tiktok: "TikTok", gbp: "Google Business" }[job.platform] || where;
    const error = `${TIMEOUT_NOTE} — the "Publish · ${scenario}" scenario may be switched off or its account disconnected. Check it in Make, then try again.`;
    const res = await env.DB.prepare("UPDATE make_jobs SET status = 'failed', error = ?2, updated_at = ?3 WHERE id = ?1 AND status = 'sent'").bind(job.id, error, new Date().toISOString()).run();
    if (!res.meta || !res.meta.changes) continue;
    const state = await readState(env);
    const item = (state.contentItems || []).find((i) => i.id === job.content_id) || {};
    const { members } = await listTeam(env);
    const byId = new Map(members.map((m) => [m.id, m]));
    const who = [...new Set([item.creator, item.approver, job.requested_by].filter((id) => id && byId.has(id)))];
    const text = `⚠️ Publishing “${item.title || "a post"}” to ${where} didn't finish: ${error}`;
    const posted = await postSystemChat(env, { text: text + (who.length ? " " + who.map((id) => "@" + byId.get(id).name).join(" ") : ""), mentions: who, contentId: job.content_id, eventId: "make_" + job.id });
    if (posted && who.length) await pushToUsers(env, who, { title: "Publishing failed", body: text.slice(0, 200), url: "/#/chat", tag: "make-" + job.id }).catch(() => {});
  }
}

// Every 5 minutes (when switched on): send approved posts whose scheduled time has arrived.
async function autoPublishDue(env) {
  const cfg = await makeConfig(env);
  if (!cfg.autoPublish) return { sent: 0 };
  await ensureMakeTables(env);
  const state = await readState(env);
  const now = Date.now();
  let sent = 0;
  for (const item of state.contentItems || []) {
    if (!["approved", "scheduled", "publishing"].includes(item.status)) continue;
    const due = [];
    for (const platform of MAKE_PLATFORMS) {
      const v = (item.variants || {})[platform];
      if (!publishHookFor(cfg, platform) || !v || v.publishStatus === "published" || !v.scheduledAt || isStory(item, v)) continue;
      const at = londonTime(v.scheduledAt);
      if (!(at <= now) || now - at > 6 * 3600e3) continue; // not yet, or too old to post without someone checking
      // A failed attempt for this same time isn't retried automatically — someone decides from the post.
      const tried = await env.DB.prepare("SELECT id FROM make_jobs WHERE kind = 'publish' AND content_id = ?1 AND platform = ?2 AND scheduled_for = ?3").bind(item.id, platform, v.scheduledAt).first();
      if (!tried) due.push(platform);
    }
    if (!due.length) continue;
    const r = await sendPublishJobs(env, { item, platforms: due, origin: env.PUBLIC_URL || DEFAULT_PUBLIC_URL, userId: null, trigger: "schedule" });
    sent += r.filter((x) => x.status === "sent").length;
  }
  return { sent };
}

async function realAnalytics(env) {
  await ensureMakeTables(env);
  const { results: posts } = await env.DB.prepare("SELECT * FROM social_posts ORDER BY published_at DESC LIMIT 1000").all();
  const { results: snaps } = await env.DB.prepare("SELECT * FROM social_snapshots WHERE day >= ?1 ORDER BY day ASC").bind(londonDay(Date.now() - 400 * 86400e3)).all();
  const byPost = new Map();
  for (const s of snaps || []) {
    const k = s.platform + ":" + s.post_id;
    if (!byPost.has(k)) byPost.set(k, []);
    byPost.get(k).push({ day: s.day, likes: s.likes, comments: s.comments, shares: s.shares, saves: s.saves, reach: s.reach, views: s.views });
  }
  return {
    lastPull: await kvGet(env, "make_last_pull"),
    posts: (posts || []).map((p) => ({
      platform: p.platform, postId: p.post_id, contentId: p.content_id, permalink: p.permalink, caption: p.caption, type: p.type,
      thumb: p.thumb, publishedAt: p.published_at, likes: p.likes, comments: p.comments, shares: p.shares, saves: p.saves,
      reach: p.reach, views: p.views, updatedAt: p.updated_at, snapshots: byPost.get(p.platform + ":" + p.post_id) || [],
    })),
  };
}

async function makeRoute(request, env, url, viewer, ctx) {
  const origin = url.origin;
  if (url.pathname === "/api/make/callback" && request.method === "POST") return await handleMakeCallback(request, env, ctx);
  await ensureMakeTables(env);
  if (url.pathname === "/api/make" && request.method === "GET") {
    const cfg = await makeConfig(env);
    const { results } = await env.DB.prepare("SELECT * FROM make_jobs WHERE kind = 'publish' ORDER BY created_at DESC LIMIT 60").all();
    return json({
      platforms: makeStatus(cfg), autoPublish: !!cfg.autoPublish,
      lastPull: await kvGet(env, "make_last_pull"), jobs: (results || []).map(jobOut),
    });
  }
  if (url.pathname === "/api/make/jobs" && request.method === "GET") {
    await expireStuckJobs(env).catch((e) => console.error("expire jobs", e));
    const since = url.searchParams.get("since") || new Date(Date.now() - 7 * 86400e3).toISOString();
    const { results } = await env.DB.prepare("SELECT * FROM make_jobs WHERE kind = 'publish' AND updated_at > ?1 ORDER BY updated_at ASC LIMIT 200").bind(since).all();
    return json({ jobs: (results || []).map(jobOut), now: new Date().toISOString() });
  }
  if (url.pathname === "/api/make/config" && request.method === "POST") {
    requireAdmin(viewer);
    const b = await request.json().catch(() => ({}));
    const cfg = await makeConfig(env);
    // hooks: { publish: { instagram: "https://hook…" }, pull: { … } } — only the given entries change; "" removes one.
    for (const dir of ["publish", "pull"]) {
      const given = (b.hooks || {})[dir] || {};
      for (const [p, raw] of Object.entries(given)) {
        if (!MAKE_PLATFORMS.includes(p)) throw new HttpError(400, "Unknown platform: " + p);
        const v = String(raw || "").trim();
        if (v && !MAKE_HOOK_RE.test(v)) throw new HttpError(400, `The ${dir} address for ${PLATFORM_NAMES[p]} doesn't look like a Make webhook (https://hook.eu1.make.com/…).`);
        if (v) cfg.hooks[dir][p] = v; else delete cfg.hooks[dir][p];
      }
    }
    if (b.autoPublish !== undefined) cfg.autoPublish = !!b.autoPublish;
    cfg.updatedAt = new Date().toISOString();
    await kvSet(env, "make_config", cfg);
    return json({ ok: true, platforms: makeStatus(cfg), autoPublish: cfg.autoPublish });
  }
  if (url.pathname === "/api/make/publish" && request.method === "POST") {
    const b = await request.json().catch(() => ({}));
    const state = await readState(env);
    const item = (state.contentItems || []).find((i) => i.id === b.contentId);
    if (!item) throw new HttpError(404, "Post not found — wait a moment for your changes to save, then try again.");
    if (!["approved", "scheduled", "publishing", "failed"].includes(item.status)) throw new HttpError(400, "Only approved posts can be published.");
    const userId = viewer.member ? viewer.member.id : String(b.userId || "").slice(0, 64);
    const platforms = (Array.isArray(b.platforms) ? b.platforms : []).map(String);
    return json({ results: await sendPublishJobs(env, { item, platforms, origin, userId, trigger: "manual" }) });
  }
  if (url.pathname === "/api/make/stats/clear" && request.method === "POST") {
    // Remove one platform's pulled stats — e.g. after pointing its Pull scenario at a different account.
    requireAdmin(viewer);
    const b = await request.json().catch(() => ({}));
    const platform = String(b.platform || "");
    if (!MAKE_PLATFORMS.includes(platform)) throw new HttpError(400, "Unknown platform");
    const r = await env.DB.prepare("DELETE FROM social_posts WHERE platform = ?1").bind(platform).run();
    await env.DB.prepare("DELETE FROM social_snapshots WHERE platform = ?1").bind(platform).run();
    const last = await kvGet(env, "make_last_pull");
    if (last && last.byPlatform) { delete last.byPlatform[platform]; if (last.platforms) delete last.platforms[platform]; await kvSet(env, "make_last_pull", last); }
    return json({ ok: true, removed: (r.meta && r.meta.changes) || 0 });
  }
  if (url.pathname === "/api/make/pull" && request.method === "POST") {
    return json(await triggerAnalyticsPull(env, { trigger: "manual" }));
  }
  if (url.pathname === "/api/make/analytics" && request.method === "GET") {
    return json(await realAnalytics(env));
  }
  return json({ error: "Not found" }, 404);
}

// ---------------------------------------------------------------------------
// "AI Dev +" — the Team Chat assistant. Tag @AI Dev + with a question (about Creator Studio or anything else) and
// it answers in the chat, tagging whoever asked. It sees a snapshot of the live workspace (posts, approvals, schedule,
// team, Make connections, real stats) and the recent conversation. It runs on Claude (with web search) when the
// ANTHROPIC_API_KEY secret is set, otherwise on Cloudflare Workers AI (the AI binding — no key, free daily allowance).
// The asker's app calls /api/chat/bot right after sending; a claim in app_kv makes sure each question is answered once.
// ---------------------------------------------------------------------------

const BOT_ID = "ai_bot";
const BOT_NAME = "AI Dev +";
const BOT_RE = /@ai\s?dev\s?\+/i;
const WORKERS_AI_MODEL = "@cf/meta/llama-3.3-70b-instruct-fp8-fast";

const BOT_SYSTEM = `You are "AI Dev +", the AI assistant inside Sanjugo Creator Studio's Team Chat. Sanjugo is a Japanese restaurant group in London (branches: Shoreditch, Angel, Victoria). The team uses Creator Studio to plan, approve and publish social media content (Instagram, Facebook, TikTok, YouTube Shorts, Google Business). People tag you in chat with questions — about how to use Creator Studio, about their own content and results, or about anything else (marketing ideas, captions, hashtags, social trends, general knowledge).

How to answer:
- Answer the actual question directly, then add only what helps. Be specific, practical and friendly; UK English.
- Keep it chat-sized: usually under 150 words. Go longer only when they ask for detail, a plan, or several captions/ideas.
- Plain text only — this chat does not render Markdown. No **bold**, no # headings, no tables. Short paragraphs; for lists use "- " at the start of a line.
- For questions about their posts, schedule, approvals or stats, use the workspace snapshot you are given and quote real titles and numbers. Never invent posts, people or figures; if the snapshot doesn't have it, say so and say where in Creator Studio to look.
- Use web search for anything current or factual you aren't sure of (trends, platform rule changes, events, news). Mention the source briefly in words (e.g. "according to Meta's help centre"), not long URLs.
- You can't click anything or change data yourself — explain exactly which buttons to use instead.
- Only describe buttons and features listed below. If something isn't listed, say Creator Studio doesn't do that yet — never guess at a button name.
- If a question is ambiguous, make a sensible assumption, say it in a few words, and answer.

What Creator Studio can do (use this to explain how things work):
- Dashboard: counts of posts awaiting approval, changes requested, scheduled this week, published, failed; views and engagement from real stats (last 30 days); Smart insights (Claude's read of the pipeline); upcoming content; recent approvals. Tiles are clickable.
- Create Content: first pick the content style — "Post / Reel" or "Story" (full-screen 9:16, Instagram/Facebook/TikTok only, with an optional link sticker and posting notes instead of a caption; approvers see it as a real story; Make can't post stories, so after approval someone posts it from the phone app and uses "Mark as published"). Then upload a video/photo, or pick one from the Content Library by barcode (e.g. G219). Choose platforms, write a caption per platform, pick a campaign (or "No campaign"), priority, and the approver — one person, or "Cyrus or Yan Yan (either can approve)" (the default: both are notified and whoever decides first moves it on). Then submit for approval, or "Save as Draft" (drafts show in the Content Calendar and can be opened, finished and submitted later). To delete a post: open it (tap it in the Calendar, Approval Queue or Dashboard) and tap "Delete draft" / "Delete post" at the top, then confirm. Creators can delete their own post while it is a draft, sent back for changes, or rejected; admins (Cyrus, Yan Yan) can delete any post that is not published. Published posts can\'t be deleted in Creator Studio (delete them in the social app itself).
- Content Library: the Google Drive folder "Sanjugo Marketing Contents Final" (about 1,600 files). File names end with a barcode like G219; search by barcode, dish or stage, watch videos, see where a file has already been used (post, platform, date), and start a post from it.
- Approval Queue: tabs To review / Needs changes / Rejected. Posts are previewed exactly as they'll look on each app (Reels, TikTok, Shorts, Facebook, Google Business), with full-screen playback. Decide with the buttons under each post (no swiping): ✓ Approve, ✕ Reject, or Request Edits for changes (with feedback tags and a due date); each asks for confirmation. "Full package" reviews the whole post; "Per platform" reviews each platform separately. Undo Last Decision exists. Creators fix posts from Needs changes / Rejected and resubmit, optionally telling the approver in chat. Approved posts are auto-placed into the next free slot of the recurring calendar template (Settings) if they have no time.
- Content Calendar: month, week and list views; filter by platform, campaign, status; tap a date to see that day or create content for it; drag or edit times.
- Team Chat: @name mentions (with a badge, pop-up and phone/desktop alert), @everyone, attach a post, Mentions and Updates filters. "Creator Studio" posts automatic updates when something is sent for approval, resubmitted, approved, sent back, rejected, published, or fails to publish.
- Publishing: on an approved post, "Publish…" → "Publish now with Make" posts to the platforms connected in Make (Instagram reel/photo, Facebook reel/photo, YouTube Short, Google Business update); the live link comes back to the post and Team Chat. Or switch on "Auto-publish at the scheduled time" (Settings → Make.com; checks every 5 minutes). TikTok can't be posted through Make — post it in the TikTok app, then use "Mark as published". Instagram reels need MP4/MOV, H.264/HEVC, max 1920 px wide, max 5 Mbps; Facebook reels 9:16, 3–90 s; best to export 1080p vertical.
- Stats: Make pulls the latest posts with likes, comments, shares, saves, reach and views every night (about 4am UK time), or any time with "Get latest stats now" (Settings → Make.com). TikTok stats come from the public @sanjugouk profile via HasData. Each platform has its own Make scenario ("Pull · Instagram", "Publish · Facebook", …) so one can be fixed without touching the others; "Clear stats" removes a platform's stats (e.g. after switching accounts).
- Analytics: Real data (from Make) or Sample data; ranges 7/30/90 days, 12 months, All time, custom; filters by platform, campaign, content pillar, post; per-platform and per-post views, reach, likes, comments, shares, saves, engagement rate; best time to post; top posts; a growth forecaster.
- Published Content: every live post on the connected accounts with its stats and a link to it.
- Team: workload per person and real approval turnaround.
- Settings (admins — Cyrus, Yan Yan): Make.com webhooks per platform, auto-publish, stats; Platforms; Notifications (chat workflow updates, and "Turn on alerts on this device" for phone/desktop push — on iPhone this only works from the Home Screen app: Safari → Share → Add to Home Screen, iOS 16.4+); Team & access (add people by email with a role: Creator, Approver, Admin); Google Drive connection; Storage (files move to a Drive archive 7 days after publishing, keeping 10 GB of Cloudflare storage free); Smart insights; Campaigns; recurring calendar template.
- Roles: Creator — create, edit, submit. Approver — approve and schedule. Admin — everything including team and settings.`;

async function botSnapshot(env, askerId) {
  const state = await readState(env);
  const { members } = await listTeam(env);
  const byId = new Map(members.map((m) => [m.id, m]));
  const name = (id) => (id === "any" ? "Cyrus or Yan Yan (either)" : (byId.get(id) || {}).name || id || "—");
  const items = Array.isArray(state.contentItems) ? state.contentItems : [];
  const counts = {};
  for (const i of items) counts[i.status] = (counts[i.status] || 0) + 1;
  const campaigns = new Map((state.campaigns || []).map((c) => [c.id, c.name]));
  const lines = [];
  const now = Date.now();
  lines.push(`Now: ${new Date(now).toLocaleString("en-GB", { timeZone: "Europe/London", dateStyle: "full", timeStyle: "short" })} (London).`);
  lines.push(`Asked by: ${name(askerId)}${byId.get(askerId) ? " (" + byId.get(askerId).role + ")" : ""}.`);
  lines.push(`Team: ${members.filter((m) => m.active).map((m) => `${m.name} (${m.role})`).join(", ")}.`);
  lines.push(`Posts: ${items.length} total — ${Object.entries(counts).map(([k, v]) => `${v} ${k.replace("_", " ")}`).join(", ") || "none yet"}.`);
  const recent = [...items].sort((a, b) => String(b.createdAt || "").localeCompare(String(a.createdAt || ""))).slice(0, 30);
  if (recent.length) {
    lines.push("Posts (newest first):");
    for (const i of recent) {
      const sched = Object.values(i.variants || {}).filter((v) => v.scheduledAt || v.publishStatus === "published")
        .map((v) => `${v.platform} ${v.publishStatus === "published" ? "published" + (v.postUrl ? " " + v.postUrl : "") : "at " + v.scheduledAt}`).join("; ");
      const fb = (i.versions || []).map((v) => v.feedback).filter(Boolean).slice(-1)[0];
      lines.push(`- "${i.title}" — ${i.status}; ${(i.platforms || []).join(", ")}; by ${name(i.creator)}; approver ${name(i.approver)}; campaign ${campaigns.get(i.campaign) || "none"}; created ${String(i.createdAt || "").slice(0, 10)}${sched ? "; " + sched : ""}${fb ? `; last feedback: "${String(fb).slice(0, 160)}"` : ""}`);
    }
  }
  const live = (state.campaigns || []).filter((c) => !c.archived);
  if (live.length) {
    lines.push("Campaigns running (use these facts for captions and offers):");
    for (const c of live) lines.push(`- ${c.name}${c.details ? ": " + String(c.details).slice(0, 300) : ""}`);
  }
  const cfg = await makeConfig(env);
  const pub = MAKE_PLATFORMS.filter((p) => cfg.hooks.publish[p]).map((p) => PLATFORM_NAMES[p]);
  const pul = MAKE_PLATFORMS.filter((p) => cfg.hooks.pull[p]).map((p) => PLATFORM_NAMES[p]);
  lines.push(`Make: publishes to ${pub.join(", ") || "nothing yet"}; pulls stats from ${pul.join(", ") || "nothing yet"}; auto-publish ${cfg.autoPublish ? "on" : "off"}.`);
  await ensureMakeTables(env);
  const last = await kvGet(env, "make_last_pull");
  lines.push(`Stats last pulled: ${last ? last.at : "never"}.`);
  const { results: posts } = await env.DB.prepare("SELECT * FROM social_posts ORDER BY published_at DESC LIMIT 400").all();
  for (const p of MAKE_PLATFORMS) {
    const ps = (posts || []).filter((x) => x.platform === p);
    if (!ps.length) continue;
    const since30 = ps.filter((x) => x.published_at && now - Date.parse(x.published_at) < 30 * 86400e3);
    const sum = (arr, k) => arr.reduce((s, x) => s + (x[k] || 0), 0);
    lines.push(`${PLATFORM_NAMES[p]} stats — ${ps.length} recent posts tracked; last 30 days: ${since30.length} posts, ${sum(since30, "views")} views, ${sum(since30, "likes")} likes, ${sum(since30, "comments")} comments, ${sum(since30, "shares")} shares, ${sum(since30, "saves")} saves.`);
    for (const x of [...ps].sort((a, b) => (b.views || b.likes) - (a.views || a.likes)).slice(0, 5)) {
      lines.push(`  - ${String(x.published_at || "").slice(0, 10)} "${String(x.caption || "").replace(/\s+/g, " ").slice(0, 70)}" views ${x.views}, reach ${x.reach}, likes ${x.likes}, comments ${x.comments}, shares ${x.shares}, saves ${x.saves} ${x.permalink || ""}`);
    }
  }
  return lines.join("\n").slice(0, 24000);
}

async function botAnswer(env, msg) {
  const { members } = await listTeam(env);
  const byId = new Map(members.map((m) => [m.id, m.name]));
  const who = (a) => (a === "system" ? "Creator Studio (automatic update)" : a === BOT_ID ? BOT_NAME : byId.get(a) || "Someone");
  const { results } = await env.DB.prepare("SELECT * FROM chat_messages WHERE id <= ?1 ORDER BY id DESC LIMIT 25").bind(msg.id).all();
  const history = (results || []).reverse().filter((m) => m.id !== msg.id)
    .map((m) => `${who(m.author)} (${String(m.created_at).slice(0, 16).replace("T", " ")}): ${String(m.text).slice(0, 800)}`).join("\n");
  const useClaude = !!env.ANTHROPIC_API_KEY;
  // Workers AI has a smaller context window, so it gets a trimmed snapshot and conversation.
  const snapshot = (await botSnapshot(env, msg.author)).slice(0, useClaude ? 24000 : 9000);
  const question = String(msg.text).replace(BOT_RE, "").trim() || "(no question — just tagged you)";
  const chatContext = useClaude ? history : history.split("\n").slice(-12).join("\n").slice(-3000);
  const content = wellFormed(`<workspace_snapshot>\n${snapshot}\n</workspace_snapshot>\n\n<recent_team_chat>\n${chatContext || "(no earlier messages)"}\n</recent_team_chat>\n\n${who(msg.author)} asks: ${question}`);

  if (!useClaude) {
    const out = await env.AI.run(WORKERS_AI_MODEL, {
      messages: [
        { role: "system", content: BOT_SYSTEM.replace(/- Use web search[^\n]*\n/, "- You can't browse the web. For things that change often (trends, platform rules, news), give your best general knowledge and say it may be out of date.\n") },
        { role: "user", content },
      ],
      max_tokens: 900,
      temperature: 0.4,
    });
    const text = String((out && (out.response ?? out.result?.response)) || "").trim();
    return tidyBotText(text);
  }

  const client = new Anthropic({ apiKey: env.ANTHROPIC_API_KEY });
  let messages = [{ role: "user", content }];
  let final = null;
  // Web search runs on Anthropic's side; a long search turn can pause — resume it a couple of times.
  for (let turn = 0; turn < 3; turn++) {
    final = await client.beta.messages.stream({
      model: "claude-opus-5",
      max_tokens: 8000,
      output_config: { effort: "medium" },
      betas: ["server-side-fallback-2026-07-01"],
      fallbacks: "default",
      system: BOT_SYSTEM,
      tools: [{ type: "web_search_20260209", name: "web_search", max_uses: 3 }],
      messages,
    }).finalMessage();
    if (final.stop_reason !== "pause_turn") break;
    messages = [...messages, { role: "assistant", content: final.content }];
  }
  if (!final || final.stop_reason === "refusal") return "Sorry — I can't help with that one.";
  return tidyBotText(final.content.filter((b) => b.type === "text").map((b) => b.text).join("").trim());
}

// Trimming text with .slice() can cut an emoji in half; the AI APIs reject the leftover half as invalid JSON.
function wellFormed(text) {
  return String(text).replace(/[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/g, "");
}

// Strip the Markdown the chat can't show.
function tidyBotText(text) {
  return (text || "Sorry — I couldn't come up with an answer. Try asking another way.")
    .replace(/\*\*(.+?)\*\*/g, "$1").replace(/^#{1,6}\s+/gm, "").replace(/^\s*\*\s+/gm, "- ").slice(0, 3900);
}

async function handleBotQuestion(request, env, ctx) {
  const b = await request.json().catch(() => ({}));
  const id = Number(b.messageId);
  await ensureChatTable(env);
  const msg = id ? await env.DB.prepare("SELECT * FROM chat_messages WHERE id = ?1").bind(id).first() : null;
  if (!msg || msg.author === BOT_ID || msg.author === "system" || !BOT_RE.test(msg.text)) return json({ error: "That message isn't a question for AI Dev +." }, 400);
  const eventId = "bot_" + id;
  const existing = await env.DB.prepare("SELECT * FROM chat_messages WHERE event_id = ?1").bind(eventId).first();
  if (existing) return json({ message: rowToMessage(existing) });
  await ensureStorageTables(env);
  const claim = await env.DB.prepare("INSERT OR IGNORE INTO app_kv (k, v) VALUES (?1, ?2)").bind("botlock_" + id, JSON.stringify(Date.now())).run();
  if (!claim.meta || !claim.meta.changes) return json({ pending: true }, 202);

  const work = (async () => {
    let text;
    if (!env.ANTHROPIC_API_KEY && !env.AI) {
      text = "I'm not switched on yet — Creator Studio needs either Cloudflare Workers AI (the AI binding) or a Claude API key (the ANTHROPIC_API_KEY secret). Once that's done, tag me again!";
    } else {
      try { text = await botAnswer(env, msg); }
      catch (e) {
        console.error("AI Dev + error", e);
        text = e instanceof Anthropic.AuthenticationError ? "My Claude API key was rejected — an admin should check the ANTHROPIC_API_KEY secret."
          : e instanceof Anthropic.RateLimitError ? "I'm a bit busy right now — ask me again in a minute."
          : /neuron|quota|limit/i.test(String(e && e.message)) ? "I've used up today's free AI allowance on Cloudflare — ask me again tomorrow."
          : "Sorry, I couldn't answer just now (" + (e && e.status ? "error " + e.status : "connection problem") + "). Try again in a moment.";
      }
    }
    const row = await env.DB.prepare(
      "INSERT OR IGNORE INTO chat_messages (author, text, mentions, content_id, created_at, event_id) VALUES (?1, ?2, ?3, ?4, ?5, ?6) RETURNING *"
    ).bind(BOT_ID, text, JSON.stringify([msg.author]), msg.content_id || null, new Date().toISOString(), eventId).first();
    await env.DB.prepare("DELETE FROM app_kv WHERE k = ?1").bind("botlock_" + id).run();
    if (row) await pushToUsers(env, [msg.author], { title: BOT_NAME, body: text.split("\n")[0].slice(0, 180), url: "/#/chat", tag: "bot-" + id }).catch(() => {});
    return row ? rowToMessage(row) : null;
  })();
  // Keep going even if the asker closes the app before the answer is ready.
  ctx.waitUntil(work.catch(() => {}));
  const message = await work;
  return json({ message });
}
