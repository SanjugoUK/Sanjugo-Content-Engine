// ContentFlow's server. This project was created in Cloudflare as a "Worker" (not classic Pages),
// so unlike Pages there's no automatic routing from a functions/ folder — this one script handles
// the API routes itself and hands everything else off to the static files in public/ via ASSETS.

export default {
  // Nightly storage clean-up (see the Storage lifecycle section below; schedule is in wrangler.toml).
  async scheduled(event, env, ctx) {
    ctx.waitUntil(runCleanup(env, { trigger: "nightly" }).catch((e) => console.error("cleanup failed", e)));
  },

  async fetch(request, env, ctx) {
    const url = new URL(request.url);

    // Who is this? With Cloudflare Access switched on, only people on the ContentFlow team list get past here.
    let viewer = { accessEnabled: false, member: null };
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
      const adminOnly = (url.pathname === "/api/storage/cleanup") || (url.pathname === "/api/google/disconnect") ||
        (url.pathname === "/api/google/connect") || (url.pathname === "/api/library/refresh");
      if (adminOnly) {
        try { requireAdmin(viewer); } catch (e) { return json({ error: e.message }, e.status || 403); }
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
      if (request.method === "POST") return postState(request, env);
    }

    if (url.pathname === "/api/upload" && request.method === "POST") {
      return uploadFile(request, env);
    }

    if (url.pathname === "/api/chat") {
      if (request.method === "GET") return getChat(url, env);
      if (request.method === "POST") return postChat(request, env);
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

async function postState(request, env) {
  let body;
  try {
    body = await request.json();
  } catch (e) {
    return new Response(JSON.stringify({ error: "Invalid JSON" }), { status: 400 });
  }
  const json = JSON.stringify(body);
  await env.DB.prepare(
    `INSERT INTO app_state (id, data, updated_at) VALUES (1, ?1, datetime('now'))
     ON CONFLICT(id) DO UPDATE SET data = excluded.data, updated_at = excluded.updated_at`
  ).bind(json).run();
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

async function postChat(request, env) {
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
