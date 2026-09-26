// ContentFlow's server. This project was created in Cloudflare as a "Worker" (not classic Pages),
// so unlike Pages there's no automatic routing from a functions/ folder — this one script handles
// the API routes itself and hands everything else off to the static files in public/ via ASSETS.

export default {
  async fetch(request, env, ctx) {
    const url = new URL(request.url);

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
  const range = request.headers.get("range");
  const obj = range ? await env.MEDIA.get(key, { range: parseRange(range) }) : await env.MEDIA.get(key);

  if (!obj) return new Response("Not found", { status: 404 });

  const headers = new Headers();
  obj.writeHttpMetadata(headers);
  headers.set("etag", obj.httpEtag);
  headers.set("Cache-Control", "public, max-age=31536000, immutable");
  headers.set("Accept-Ranges", "bytes");

  if (obj.range && "offset" in obj.range) {
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
// ContentFlow reads it through a Google service account: the folder is shared with the service account
// as Viewer and the account's JSON key is stored in the GOOGLE_SERVICE_ACCOUNT secret. Files stay private
// in Drive and nothing is ever written back — imports are copied into R2 so posts play like uploads.
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
  const sa = serviceAccount(env);
  if (!sa) throw new HttpError(503, "Google Drive isn't connected yet — see Settings → Google Drive.");
  const now = Math.floor(Date.now() / 1000);
  if (googleToken && googleToken.exp - 60 > now) return googleToken.token;
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
  return json({
    connected: !!sa,
    serviceEmail: sa ? sa.client_email : null,
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

// One pass over everything the service account can see (a few paged calls), then rebuild folder paths
// from `parents`. Listing folder-by-folder would take ~90 calls — over the free plan's per-request limit.
async function refreshLibrary(env) {
  const token = await getGoogleToken(env);
  const root = env.LIBRARY_FOLDER_ID;
  if (!root) throw new HttpError(500, "LIBRARY_FOLDER_ID is not set in wrangler.toml");
  const items = [];
  let pageToken = "", calls = 0;
  do {
    const u = new URL("https://www.googleapis.com/drive/v3/files");
    u.searchParams.set("q", "trashed=false");
    u.searchParams.set("fields", "nextPageToken,files(id,name,mimeType,size,parents,modifiedTime,description)");
    u.searchParams.set("pageSize", "1000");
    u.searchParams.set("supportsAllDrives", "true");
    u.searchParams.set("includeItemsFromAllDrives", "true");
    if (pageToken) u.searchParams.set("pageToken", pageToken);
    const r = await fetch(u, { headers: { Authorization: "Bearer " + token } });
    const d = await r.json().catch(() => ({}));
    if (!r.ok) throw new HttpError(502, "Drive listing failed: " + ((d.error && d.error.message) || r.status));
    items.push(...(d.files || []));
    pageToken = d.nextPageToken || "";
    calls++;
  } while (pageToken && calls < 40);

  const byId = new Map(items.map((i) => [i.id, i]));
  const pathOf = (item) => { // folder names from just under the root down to the file, or null if outside the library
    const names = [];
    let p = item.parents && item.parents[0];
    for (let guard = 0; p && guard < 25; guard++) {
      if (p === root) return names.reverse();
      const f = byId.get(p);
      if (!f) return null;
      names.push(f.name);
      p = f.parents && f.parents[0];
    }
    return null;
  };
  const files = [];
  for (const it of items) {
    if (it.mimeType === DRIVE_FOLDER) continue;
    const path = pathOf(it);
    if (!path) continue;
    const f = { id: it.id, name: it.name, mime: it.mimeType, size: it.size ? Number(it.size) : null, branch: path[0] || "Unsorted", path: path.slice(1), modified: it.modifiedTime };
    if (it.description) f.note = it.description;
    files.push(f);
  }
  const updatedAt = new Date().toISOString();
  if (files.length === 0) throw new HttpError(404, "No files found — is the library folder shared with " + serviceAccount(env).client_email + "?");
  await env.MEDIA.put(LIBRARY_INDEX_KEY, JSON.stringify({ source: "live", updatedAt, rootFolderId: root, files }), {
    httpMetadata: { contentType: "application/json" }, customMetadata: { updatedAt },
  });
  return { count: files.length, updatedAt };
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
