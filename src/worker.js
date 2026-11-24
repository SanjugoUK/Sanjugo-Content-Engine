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
      ctx.waitUntil(refreshCollabs(env).catch((e) => console.error("collab refresh failed", e)));
      ctx.waitUntil(mcPrune(env).catch((e) => console.error("manychat prune failed", e)));
      ctx.waitUntil(engPrune(env).catch((e) => console.error("engage prune failed", e)));
    } else {
      ctx.waitUntil(autoPublishDue(env).catch((e) => console.error("auto-publish failed", e)));
      ctx.waitUntil(expireStuckJobs(env).catch((e) => console.error("expire jobs failed", e)));
      ctx.waitUntil(remindPendingApprovals(env).catch((e) => console.error("approval reminders failed", e)));
      ctx.waitUntil(dailyDigest(env).catch((e) => console.error("daily digest failed", e)));
      ctx.waitUntil(engageCron(env).catch((e) => console.error("engage cron failed", e)));
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
    // ManyChat's automations report here from ManyChat's servers; the hook key in the link proves it's our ManyChat.
    if (url.pathname === "/api/manychat/hook") {
      try { return await mcHook(request, env, url, ctx); } catch (e) { return json({ error: e.message || "Hook error" }, e.status || 500); }
    }
    // Instagram comments from Make's "Engage · Instagram comments" scenario; the key in the link proves it's ours.
    if (url.pathname === "/api/engage/in" && request.method === "POST") {
      try { return await engIn(request, env, url, ctx); } catch (e) { return json({ error: e.message || "Engage error" }, e.status || 500); }
    }
    // Tracked links in DMs (/go/<short name>) — guests open these, so no sign-in.
    const goLink = request.method === "GET" && url.pathname.match(/^\/go\/([A-Za-z0-9-]{2,40})\/?$/);
    if (goLink) {
      try { return await mcGo(request, env, url, goLink[1], ctx); } catch (e) { return new Response(null, { status: 302, headers: { Location: "https://sanjugo.co.uk/" } }); }
    }
    // Make, Instagram, Facebook, YouTube and Google fetch post files by link when publishing — they can't sign in.
    // These links are long random keys (R2 object / Drive file ids), so they're safe to leave unsigned.
    const publicFile = request.method === "GET" && (/^\/api\/media\/.+/.test(url.pathname) || /^\/api\/library\/thumb\/[\w-]{10,}$/.test(url.pathname));
    if (publicFile) {
      const thumb = url.pathname.match(/^\/api\/library\/thumb\/([\w-]{10,})$/);
      try { return thumb ? await libraryThumb(thumb[1], env, url.searchParams.get("s")) : await serveMedia(url.pathname.slice("/api/media/".length), request, env); }
      catch (e) { return json({ error: e.message || "File error" }, e.status || 500); }
    }
    // Changes must come from Creator Studio itself, never from another website (blocks cross-site request forgery).
    if (url.pathname.startsWith("/api/") && request.method !== "GET" && request.method !== "HEAD" && url.pathname !== "/api/make/callback") {
      const origin = request.headers.get("Origin");
      const site = request.headers.get("Sec-Fetch-Site");
      if ((origin && origin !== url.origin) || site === "cross-site") return json({ error: "Blocked: request didn't come from Creator Studio." }, 403);
    }
    if (url.pathname === "/api/auth/login" && request.method === "POST") {
      try { return await signIn(request, env); } catch (e) { return json({ error: e.message || "Sign-in failed" }, e.status || 500); }
    }
    if (url.pathname === "/api/auth/logout" && request.method === "POST") {
      try { return await signOut(request, env); } catch (e) { return json({ error: e.message || "Sign-out failed" }, e.status || 500); }
    }
    if (url.pathname.startsWith("/api/")) {
      try {
        viewer = await identify(request, env);
      } catch (e) {
        return json({ error: e.message || "Sign-in check failed", code: e.code || "auth", signin: e.signin || null }, e.status || 401);
      }
      if (url.pathname === "/api/auth/others" && request.method === "POST") {
        try { return json(await signOutOthers(request, env, viewer)); } catch (e) { return json({ error: e.message }, e.status || 500); }
      }
      if (url.pathname === "/api/auth/password" && request.method === "POST") {
        try { return json(await changeOwnPassword(request, env, viewer)); } catch (e) { return json({ error: e.message }, e.status || 500); }
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
      const adminOnly = (url.pathname === "/api/storage/cleanup") || (url.pathname === "/api/storage/rename-archive") || (url.pathname === "/api/google/disconnect") ||
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

    if (url.pathname === "/api/storage" || url.pathname === "/api/storage/cleanup" || url.pathname === "/api/storage/rename-archive") {
      try {
        if (url.pathname === "/api/storage" && request.method === "GET") return json(await storageReport(env));
        if (url.pathname === "/api/storage/cleanup" && request.method === "POST") return json(await runCleanup(env, { trigger: "manual" }));
        if (url.pathname === "/api/storage/rename-archive" && request.method === "POST") return json(await renameArchive(env, { limit: 40 }));
      } catch (e) {
        return json({ error: e.message || "Storage error" }, e.status || 500);
      }
    }

    if (url.pathname === "/api/state") {
      if (request.method === "GET") return getState(env);
      if (request.method === "POST") return postState(request, env, ctx, viewer);
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
    if ((url.pathname === "/api/chat/react" || url.pathname === "/api/chat/pin") && request.method === "POST") {
      try { return json({ message: await chatUpdate(request, env, url, viewer) }); } catch (e) { return json({ error: e.message || "Chat error" }, e.status || 500); }
    }

    if (url.pathname === "/api/make" || url.pathname.startsWith("/api/make/")) {
      try {
        return await makeRoute(request, env, url, viewer, ctx);
      } catch (e) {
        return json({ error: e.message || "Make error" }, e.status || 500);
      }
    }

    if (url.pathname === "/api/study" || url.pathname.startsWith("/api/study/")) {
      try { return await studyRoute(request, env, url, viewer); } catch (e) { return json({ error: e.message || "Study error" }, e.status || 500); }
    }

    if (url.pathname === "/api/camp" || url.pathname.startsWith("/api/camp/")) {
      try { return await campRoute(request, env, url, viewer); } catch (e) { return json({ error: e.message || "Campaigns error" }, e.status || 500); }
    }

    if (url.pathname === "/api/occasions" || url.pathname === "/api/occasions/status") {
      try { return await occasionsRoute(request, env, url, viewer); } catch (e) { return json({ error: e.message || "Occasions error" }, e.status || 500); }
    }

    if (url.pathname === "/api/notes") {
      try { return await notesRoute(request, env, url, viewer); } catch (e) { return json({ error: e.message || "Notes error" }, e.status || 500); }
    }

    if (url.pathname === "/api/workspace" || url.pathname.startsWith("/api/workspace/")) {
      try {
        return await workspaceRoute(request, env, url, viewer, ctx);
      } catch (e) {
        return json({ error: e.message || "Workspace error" }, e.status || 500);
      }
    }

    if (url.pathname === "/api/engage" || url.pathname.startsWith("/api/engage/")) {
      try { return await engageRoute(request, env, url, viewer, ctx); } catch (e) { return json({ error: e.message || "Engagement error" }, e.status || 500); }
    }
    if (url.pathname === "/api/manychat" || url.pathname.startsWith("/api/manychat/")) {
      try { return await manychatRoute(request, env, url, viewer, ctx); } catch (e) { return json({ error: e.message || "ManyChat error" }, e.status || 500); }
    }

    if (url.pathname.startsWith("/api/music/") && request.method === "GET") {
      try { return await musicRoute(url); } catch (e) { return json({ error: e.message || "Music error" }, e.status || 500); }
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
        if (url.pathname === "/api/library/used") return await libraryUsedRoute(request, env, viewer);
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

// Who must approve a post: one named approver, or (default "any") every approver/admin — Cyrus and Yan Yan.
// "either" = Cyrus or Yan Yan: both are asked, and one approval is enough.
function requiredFor(item, reviewerIds) {
  return item && item.approver && item.approver !== "any" && reviewerIds.includes(item.approver) ? [item.approver] : reviewerIds;
}
function approvalsDone(item, approvals, reviewerIds) {
  const req = requiredFor(item, reviewerIds);
  return req.length > 0 && (item && item.approver === "either" ? req.some((id) => (approvals || {})[id]) : req.every((id) => (approvals || {})[id]));
}

// Two-person approval is checked here on the server too, so it can't be faked by sending a doctored save:
// someone can only add their OWN approval, only approvers/admins can approve, and a post only becomes
// Approved once every approver has approved each platform. Anything else in that post is kept as stored.
async function guardApprovals(env, body, stored, viewer) {
  if (!viewer || !viewer.member || !Array.isArray(body.contentItems)) return 0;
  const { members } = await listTeam(env);
  const reviewers = members.filter((m) => m.active && (m.role === "approver" || m.role === "admin")).map((m) => m.id);
  const me = viewer.member.id, canApprove = reviewers.includes(me);
  const old = new Map((Array.isArray(stored.contentItems) ? stored.contentItems : []).map((i) => [i && i.id, i]));
  let fixed = 0;
  body.contentItems = body.contentItems.map((it) => {
    const prev = it && old.get(it.id);
    if (!it || !prev) return it;
    let bad = false;
    for (const [p, v] of Object.entries(it.variants || {})) {
      const was = ((prev.variants || {})[p] || {}).approvals || {};
      const added = Object.keys((v && v.approvals) || {}).filter((id) => !was[id]);
      if (added.some((id) => id !== me || !canApprove)) bad = true;
      const wasApproved = ((prev.variants || {})[p] || {}).status === "approved";
      if (v && v.status === "approved" && !wasApproved && !approvalsDone(it, v.approvals, reviewers)) bad = true;
      // An approved platform only goes back to waiting when the post is edited and resubmitted (a new version) or an
      // approver undoes it. Anything else is an old copy from another device overwriting the approval.
      if (v && wasApproved && ["submitted", "draft"].includes(v.status) && !canApprove && (+it.currentVersion || 1) <= (+prev.currentVersion || 1)) bad = true;
      if (v && ((prev.variants || {})[p] || {}).publishStatus === "published" && v.publishStatus !== "published" && !canApprove) bad = true;
    }
    if ((it.approver || "any") !== (prev.approver || "any") && !canApprove && !["draft", "changes_requested", "rejected"].includes(prev.status)) bad = true;
    if (it.status === "approved" && prev.status !== "approved" && prev.status !== "scheduled" &&
        Object.values(it.variants || {}).some((v) => v && v.status !== "approved")) bad = true;
    if (!bad) return it;
    fixed++;
    return prev;
  });
  return fixed;
}

async function postState(request, env, ctx, viewer) {
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
  const blocked = await guardApprovals(env, body, stored, viewer);
  if (blocked) console.warn("Blocked " + blocked + " post change(s) that broke the two-person approval rule", viewer && viewer.member && viewer.member.id);
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
  // Workspace drafts live under workspace/ so the post clean-up never mistakes them for unused uploads.
  const folder = form.get("folder") === "workspace" ? "workspace/" : "";
  const key = `${folder}${crypto.randomUUID()}.${safeExt || "bin"}`;

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

// ?download=<file name> makes the browser save the file (phones put it in Downloads / Files) instead of playing it.
function downloadName(request) {
  const n = new URL(request.url).searchParams.get("download");
  if (n === null) return null;
  return String(n).replace(/[^\w .()-]+/g, "_").replace(/^[ ._]+/, "").slice(0, 120) || "sanjugo-file";
}
function asDownload(res, name) {
  if (!name || !res.ok) return res;
  const h = new Headers(res.headers);
  h.set("Content-Disposition", `attachment; filename="${name}"`);
  h.set("Cache-Control", "private, no-store");
  return new Response(res.body, { status: res.status, headers: h });
}

async function serveMedia(key, request, env) {
  const dl = downloadName(request);
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
    if (alt && dl) return Response.redirect(new URL(alt.file + "?download=" + encodeURIComponent(dl), request.url).toString(), 302);
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
  if (dl) { headers.set("Content-Disposition", `attachment; filename="${dl}"`); headers.set("Cache-Control", "private, no-store"); }
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
  // Replies, reactions, pins and attached cards (a Workspace project, a post or a calendar day).
  for (const col of ["reply_to INTEGER", "reactions TEXT", "pinned_at TEXT", "pinned_by TEXT", "card TEXT", "updated_at TEXT"]) {
    try { await env.DB.prepare("ALTER TABLE chat_messages ADD COLUMN " + col).run(); } catch (e) { /* already there */ }
  }
  await env.DB.prepare("CREATE INDEX IF NOT EXISTS chat_messages_updated ON chat_messages(updated_at)").run();
  await env.DB.prepare("CREATE UNIQUE INDEX IF NOT EXISTS chat_messages_event ON chat_messages(event_id)").run();
  chatTableReady = true;
}

function rowToMessage(r) {
  const parse = (v, d) => { try { return v ? JSON.parse(v) : d; } catch (e) { return d; } };
  return { id: r.id, author: r.author, text: r.text, mentions: parse(r.mentions, []), contentId: r.content_id || null, createdAt: r.created_at,
    replyTo: r.reply_to || null, reactions: parse(r.reactions, {}), pinnedAt: r.pinned_at || null, pinnedBy: r.pinned_by || null, card: parse(r.card, null), updatedAt: r.updated_at || null };
}
const CHAT_CARD_TYPES = ["project", "post", "day"];
function chatCard(c) {
  if (!c || !CHAT_CARD_TYPES.includes(c.type)) return null;
  const id = String(c.id || "").slice(0, 64);
  if (c.type === "day" ? !/^\d{4}-\d{2}-\d{2}$/.test(id) : !/^[\w-]{3,64}$/.test(id)) return null;
  return { type: c.type, id };
}

async function getChat(url, env) {
  await ensureChatTable(env);
  const since = Number(url.searchParams.get("since") || 0);
  const changedSince = url.searchParams.get("changed") || "";
  const { results } = since > 0
    ? await env.DB.prepare("SELECT * FROM chat_messages WHERE id > ?1 ORDER BY id ASC LIMIT 500").bind(since).all()
    : await env.DB.prepare("SELECT * FROM (SELECT * FROM chat_messages ORDER BY id DESC LIMIT 300) ORDER BY id ASC").all();
  // Reactions and pins change older messages — send those again too.
  const changed = since > 0 && changedSince
    ? (await env.DB.prepare("SELECT * FROM chat_messages WHERE id <= ?1 AND updated_at > ?2 ORDER BY id ASC LIMIT 300").bind(since, changedSince).all()).results || []
    : [];
  // Pinned messages always come along, even when they're older than the last 300.
  const pinned = since > 0 ? [] : (await env.DB.prepare("SELECT * FROM chat_messages WHERE pinned_at IS NOT NULL ORDER BY pinned_at DESC LIMIT 30").all()).results || [];
  const seen = new Set((results || []).map((r) => r.id));
  const extra = [...changed, ...pinned].filter((r) => !seen.has(r.id) && seen.add(r.id));
  return new Response(JSON.stringify({ messages: [...extra, ...(results || [])].map(rowToMessage), serverTime: new Date().toISOString() }), {
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
  const card = chatCard(body.card);
  const replyTo = Number(body.replyTo) > 0 ? Number(body.replyTo) : null;
  await ensureChatTable(env);
  const row = await env.DB.prepare(
    "INSERT INTO chat_messages (author, text, mentions, content_id, created_at, reply_to, card) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7) RETURNING *"
  ).bind(author, text, JSON.stringify(mentions), contentId, new Date().toISOString(), replyTo, card ? JSON.stringify(card) : null).first();
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
  return new Response(JSON.stringify(data), { status, headers: { "Content-Type": "application/json", "Cache-Control": "no-store", "X-Content-Type-Options": "nosniff" } });
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
    canRaw: hasFullDrive(auth),
    signInConfigured: oauthConfigured(env),
    rootFolderId: env.LIBRARY_FOLDER_ID || null,
    lastRefresh: head ? (head.customMetadata && head.customMetadata.updatedAt) || head.uploaded : null,
  });
}

// The live index (from the last refresh) if there is one, otherwise the snapshot bundled with the app.
async function getLibrary(request, env) {
  const obj = await env.MEDIA.get(LIBRARY_INDEX_KEY);
  if (obj) {
    const data = await obj.json().catch(() => null);
    if (data && Array.isArray(data.files)) {
      try {
        await ensureStorageTables(env);
        const { results } = await env.DB.prepare("SELECT key, drive_id FROM media_archive").all();
        const keyOf = new Map((results || []).map((r) => [r.drive_id, r.key]));
        for (const f of data.files) { const k = keyOf.get(f.id); if (k) f.archiveKey = k; }
      } catch (e) { /* archive table not there yet */ }
      return json(data);
    }
  }
  return env.ASSETS.fetch(new Request(new URL("/library.json", request.url)));
}

// Walk the library folder level by level, asking about up to 40 folders per request, so ~90 folders
// take a handful of calls (the free plan allows 50 per request) and nothing outside the library is read.
async function refreshLibrary(env) {
  const token = await getGoogleToken(env);
  const root = env.LIBRARY_FOLDER_ID;
  if (!root) throw new HttpError(500, "LIBRARY_FOLDER_ID is not set in wrangler.toml");
  const folders = new Map([[root, { name: null, parent: null }]]);
  // Finished Workspace videos are saved to Creator Studio's own Drive folder (Drive only lets the app write
  // to folders it made), so that folder is walked as a second library root — its branch subfolders sit beside the library's.
  const wsRoot = await kvGet(env, "ws_drive_folder");
  if (wsRoot && wsRoot.id && wsRoot.id !== root) folders.set(wsRoot.id, { name: null, parent: null });
  // Published post uploads moved to Drive ("Creator Studio Archive") are part of the library too.
  // "Man Man RAW Files" (raw footage uploaded from Workspace) — its branch folders sit beside the library's too.
  const rawSaved = (await kvGet(env, "raw_drive_folder")) || {};
  const rawRootId = rawSaved.id || (rawSaved.folders && Object.keys(rawSaved.folders).length ? RAW_ROOT_DEFAULT : null);
  if (rawRootId && rawRootId !== root && !folders.has(rawRootId)) folders.set(rawRootId, { name: null, parent: null, rawRoot: true });
  const archiveRoot = await kvGet(env, "archive_folder_id");
  if (archiveRoot && archiveRoot !== root && !folders.has(archiveRoot)) folders.set(archiveRoot, { name: null, parent: null, archive: true });
  const roots = [...folders.keys()];
  const items = [];
  let frontier = roots, calls = 0;
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
    for (let id = folderId, guard = 0; id && !roots.includes(id) && guard < 25; guard++) {
      const f = folders.get(id);
      if (!f) break;
      names.unshift(f.name);
      id = f.parent;
    }
    return names;
  };
  const rootOf = (folderId) => { let id = folderId; for (let g = 0; id && !roots.includes(id) && g < 25; g++) id = (folders.get(id) || {}).parent; return id; };
  const files = items.map((it) => {
    const path = pathOf(it.parent);
    const inArchive = it.parent === archiveRoot;
    const inRaw = rawRootId && rootOf(it.parent) === rawRootId;
    const f = { id: it.id, name: it.name, mime: it.mimeType, size: it.size ? Number(it.size) : null, branch: inArchive ? "All-Branches" : path[0] || "Unsorted",
      path: inArchive ? ["Creator Studio Archive"] : inRaw ? ["Man Man RAW Files", ...path.slice(1)] : path.slice(1), modified: it.modifiedTime };
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
  return asDownload(new Response(r.body, { status: r.status, headers: out }), downloadName(request));
}

// ---------------------------------------------------------------------------
// "Connect Google Drive" — one admin signs in with Google once and approves read-only Drive access.
// The long-lived refresh token is kept server-side in D1; browsers only ever see file data, never tokens.
// ---------------------------------------------------------------------------

// drive.readonly: read the library. drive.file: create/manage only files ContentFlow itself makes (the archive).
// drive: save raw footage into a folder the team made by hand ("Man Man RAW Files"), which drive.file can't reach.
const GOOGLE_SCOPES = "openid email https://www.googleapis.com/auth/drive.readonly https://www.googleapis.com/auth/drive.file https://www.googleapis.com/auth/drive";
const hasFullDrive = (auth) => !!auth && (auth.scopes || "").split(/\s+/).includes("https://www.googleapis.com/auth/drive");
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
  try { await env.DB.prepare("ALTER TABLE media_archive ADD COLUMN name TEXT").run(); } catch (e) { /* already there */ }
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
    return { play: IMAGE_EXT.test(key) ? `/api/library/thumb/${id}?s=1200` : `/api/library/stream/${id}`, file: `/api/library/stream/${id}`, view: `https://drive.google.com/file/d/${id}/view` };
  }
  await ensureStorageTables(env);
  const row = await env.DB.prepare("SELECT drive_id FROM media_archive WHERE key = ?1").bind(key).first();
  if (!row) return null;
  return { play: `/api/library/stream/${row.drive_id}`, file: `/api/library/stream/${row.drive_id}`, view: `https://drive.google.com/file/d/${row.drive_id}/view` };
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
  if (key.startsWith("workspace/")) return "workspace";
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
    // Every file a post points at — main file, preview, every carousel photo, anything added later — counts as in use.
    // (Only checking media.fileUrl once let the nightly clean-up delete carousel photos 2–10 as "unused".)
    const keys = new Set([...JSON.stringify(it).matchAll(/\/api\/media\/([^"?#\\]+)/g)].map((m) => { try { return decodeURIComponent(m[1]); } catch (e) { return m[1]; } }));
    for (const k of keys) { if (!users.has(k)) users.set(k, []); users.get(k).push(it); }
  }
  // Receipts and sales reports saved in Campaigns are kept for good.
  const pinned = new Set();
  try {
    await ensureCampTable(env);
    const { results } = await env.DB.prepare("SELECT data FROM camp_docs").all();
    for (const r of results || []) for (const m of String(r.data).matchAll(/\/api\/media\/([^"?#\\]+)/g)) { try { pinned.add(decodeURIComponent(m[1])); } catch (e) { pinned.add(m[1]); } }
  } catch (e) { return { objects, actions: [] }; } // can't check campaign files right now: delete nothing tonight
  let libSizes = null;
  try { const li = await env.MEDIA.get(LIBRARY_INDEX_KEY); if (li) libSizes = new Map(((await li.json()).files || []).map((f) => [f.id, Number(f.size) || null])); } catch (e) { /* archive as before */ }
  // Safety: with no shared post data to compare against, never treat files as unused.
  const canJudgeOrphans = items.length > 0;
  const actions = [];
  for (const o of objects) {
    const cat = storageCategory(o.key);
    if (cat !== "uploads" && cat !== "library") continue;
    if (pinned.has(o.key)) continue;
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
    // Made from a Content Library file (e.g. an approved Workspace video) and the upload is that same file:
    // the original is already filed in Drive with its code, so the copy is just deleted — no second archive copy.
    const sameAsLibrary = us.every((u) => u.libraryRef && u.libraryRef.id && libSizes && libSizes.get(u.libraryRef.id) === o.size);
    const a = { ...base, action: cat === "library" || sameAsLibrary ? "delete" : "archive", titles: us.map((u) => u.title), item: us[0], publishedAt: Math.max(...done), reason: "Published", dueAt: new Date(dueAt).toISOString() };
    actions.push({ ...a, ready: now >= dueAt });
  }
  return { objects, actions };
}

async function storageReport(env) {
  const { objects, actions } = await planCleanup(env);
  const byCategory = { uploads: { bytes: 0, count: 0 }, library: { bytes: 0, count: 0 }, workspace: { bytes: 0, count: 0 }, thumbnails: { bytes: 0, count: 0 }, system: { bytes: 0, count: 0 } };
  let total = 0;
  for (const o of objects) { const c = byCategory[storageCategory(o.key)]; c.bytes += o.size; c.count++; total += o.size; }
  const ready = actions.filter((a) => a.ready !== false);
  const upcoming = actions.filter((a) => a.ready === false);
  await ensureStorageTables(env);
  const archived = await env.DB.prepare("SELECT COUNT(*) AS n, COALESCE(SUM(size),0) AS bytes, SUM(CASE WHEN name IS NULL THEN 1 ELSE 0 END) AS unnamed FROM media_archive").first();
  const auth = serviceAccount(env) ? null : await getGoogleAuth(env);
  return {
    totalBytes: total, limitBytes: STORAGE_LIMIT_BYTES, objectCount: objects.length, byCategory,
    readyNow: { count: ready.length, bytes: ready.reduce((s, a) => s + a.size, 0), items: ready.slice(0, 50) },
    upcoming: { count: upcoming.length, bytes: upcoming.reduce((s, a) => s + a.size, 0), items: upcoming.sort((a, b) => a.dueAt.localeCompare(b.dueAt)).slice(0, 50) },
    archivedToDrive: { count: archived.n, bytes: archived.bytes, unnamed: archived.unnamed || 0 },
    canArchive: !!(auth && (auth.scopes || "").includes("drive.file")),
    canRaw: hasFullDrive(auth),
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

async function archiveToDrive(env, token, folderId, action, name, description) {
  const obj = await env.MEDIA.get(action.key);
  if (!obj) return null;
  const type = (obj.httpMetadata && obj.httpMetadata.contentType) || "application/octet-stream";
  const init = await fetch("https://www.googleapis.com/upload/drive/v3/files?uploadType=resumable&fields=id", {
    method: "POST",
    headers: { Authorization: "Bearer " + token, "Content-Type": "application/json; charset=UTF-8", "X-Upload-Content-Type": type, "X-Upload-Content-Length": String(obj.size) },
    body: JSON.stringify({ name, parents: [folderId], description }),
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
  let token = null, folderId = null, archivesLeft = MAX_ARCHIVES_PER_RUN, used = null;
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
        if (!used) used = await wsUsedBarcodes(env, null);
        let n = archiveName(a.item, a.key, used, a.publishedAt);
        used.add(n.barcode);
        for (let g = 0; g < 20 && !(await claimThisBarcode(env, n.barcode, "archive", a.key)); g++) { n = archiveName(a.item, a.key, used, a.publishedAt); used.add(n.barcode); }
        const driveId = await archiveToDrive(env, token, folderId, a, n.name, n.description);
        if (!driveId) continue;
        await env.DB.prepare("INSERT OR REPLACE INTO media_archive (key, drive_id, size, title, archived_at, name) VALUES (?1, ?2, ?3, ?4, ?5, ?6)")
          .bind(a.key, driveId, a.size, (a.titles || [])[0] || null, new Date().toISOString(), n.name).run();
        await wsAddToLibraryIndex(env, null, { id: driveId, name: n.name, mime: a.mime || null, size: a.size, branch: n.branch, path: ["Creator Studio Archive"], modified: new Date().toISOString(), note: n.description }).catch(() => {});
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
  // Older archive files (named before the filing system was used here) get their proper name a few at a time.
  try { result.renamed = (await renameArchive(env, { limit: 15 })).renamed; } catch (e) { result.errors.push({ key: "rename", error: e.message }); }
  await kvSet(env, "last_cleanup", result);
  return result;
}

// SANJUGO filing-system name for a post's own upload once it's published:
// DATE_SOCIAL_CATEGORY_[DISH]_USD_v#_BARCODE.ext — USD = "Used" (it's been posted), date = when it went live.
const ARCHIVE_PILLAR_CAT = { Product: "FC", "Behind the Scenes": "AV", Education: "CH", UGC: "CM", Promotion: "PO", Seasonal: "PO" };
function archiveName(item, key, used, publishedAt) {
  const it = item || {};
  const platforms = Array.isArray(it.platforms) ? it.platforms : Object.keys(it.variants || {});
  const social = it.format === "story" ? "IS" : platforms.length === 1 && platforms[0] === "instagram" ? "IV"
    : platforms.length === 1 && platforms[0] === "tiktok" ? "TK" : platforms.length === 1 && platforms[0] === "youtube" ? "YT" : "AL";
  const ref = it.libraryRef || {};
  const category = WS_CATEGORIES[ref.category] ? ref.category : ARCHIVE_PILLAR_CAT[it.pillar] || "FC";
  const dish = ref.dish && WS_DISHES[ref.dish] ? ref.dish : null;
  const text = [it.title, ...Object.values(it.variants || {}).map((v) => (v && v.caption) || "")].join(" ").toLowerCase();
  const hits = ["shoreditch", "angel", "victoria"].filter((b) => text.includes(b));
  const branchKey = hits.length === 1 ? hits[0] : "all";
  const branch = WS_BRANCHES[branchKey];
  const barcode = wsNextBarcode(branch.letter, used);
  const ext = ((/\.([a-z0-9]{2,5})$/i.exec(key || "") || [])[1] || "mp4").toLowerCase();
  const name = [londonDate(new Date(publishedAt || Date.now())), social, category, ...(dish ? [dish] : []), "USD", "v" + (it.currentVersion || 1), barcode].join("_") + "." + ext;
  const description = `Published by Creator Studio: "${String(it.title || "post").slice(0, 120)}" on ${platforms.join(", ") || "social"}${publishedAt ? ", " + new Date(publishedAt).toISOString().slice(0, 10) : ""}. Original upload kept here after publishing.`;
  return { name, barcode, branch: branch.folder, description };
}

// Give archive files from before this change their proper name (Drive lets the app rename files it made).
async function renameArchive(env, { limit = 50 } = {}) {
  await ensureStorageTables(env);
  const { results } = await env.DB.prepare("SELECT * FROM media_archive WHERE name IS NULL ORDER BY archived_at ASC LIMIT ?1").bind(limit).all();
  const rows = results || [];
  const auth = await getGoogleAuth(env);
  if (!auth || !(auth.scopes || "").includes("drive.file")) return { renamed: 0, left: rows.length, needsReconnect: true };
  if (!rows.length) return { renamed: 0, left: 0, dupes: await fixArchiveDupes(env, null, limit).catch((e) => ({ error: e.message })) };
  const token = await getGoogleToken(env);
  const stateRow = await env.DB.prepare("SELECT data FROM app_state WHERE id = 1").first();
  const items = stateRow ? (JSON.parse(stateRow.data).contentItems || []) : [];
  const used = await wsUsedBarcodes(env, null);
  let renamed = 0;
  for (const r of rows) {
    const item = items.find((i) => JSON.stringify(i).includes("/api/media/" + r.key)) || { title: r.title };
    const n = archiveName(item, r.key, used, item.variants ? finishedAt(item) : Date.parse(r.archived_at));
    const res = await fetch(`https://www.googleapis.com/drive/v3/files/${r.drive_id}?fields=id,name`, {
      method: "PATCH", headers: { Authorization: "Bearer " + token, "Content-Type": "application/json" }, body: JSON.stringify({ name: n.name, description: n.description }),
    });
    if (!res.ok) { if (res.status === 404) await env.DB.prepare("UPDATE media_archive SET name = ?2 WHERE key = ?1").bind(r.key, "(missing in Drive)").run(); continue; }
    used.add(n.barcode);
    await claimThisBarcode(env, n.barcode, "archive", r.key).catch(() => {});
    await env.DB.prepare("UPDATE media_archive SET name = ?2 WHERE key = ?1").bind(r.key, n.name).run();
    await wsAddToLibraryIndex(env, null, { id: r.drive_id, name: n.name, mime: null, size: r.size, branch: n.branch, path: ["Creator Studio Archive"], modified: r.archived_at, note: n.description }).catch(() => {});
    renamed++;
  }
  const left = (await env.DB.prepare("SELECT COUNT(*) AS n FROM media_archive WHERE name IS NULL").first()).n;
  const dupes = await fixArchiveDupes(env, token, limit).catch((e) => ({ error: e.message }));
  return { renamed, left, dupes };
}

// Every archive file must have its own barcode. The first file keeps a shared code; the others get the next free one.
async function fixArchiveDupes(env, token, limit) {
  const { results } = await env.DB.prepare("SELECT key, drive_id, name, archived_at, size FROM media_archive WHERE name IS NOT NULL ORDER BY archived_at ASC, key ASC").all();
  const seen = new Set(), fix = [];
  for (const r of results || []) {
    const m = /_([A-Z]\d{3,4})\.[a-z0-9]+$/i.exec(r.name || "");
    if (!m) continue;
    if (seen.has(m[1]) || !(await claimThisBarcode(env, m[1], "archive", r.key))) fix.push({ ...r, code: m[1] });
    seen.add(m[1]);
  }
  let fixed = 0;
  if (!fix.length) return { fixed, left: 0 };
  token = token || await getGoogleToken(env);
  const used = await wsUsedBarcodes(env, null);
  for (const r of fix.slice(0, limit)) {
    const letter = r.code[0];
    const code = await claimBarcode(env, null, letter, "archive", r.key, used);
    const name = r.name.replace(new RegExp("_" + r.code + "(\\.[a-z0-9]+)$", "i"), "_" + code + "$1");
    const res = await fetch(`https://www.googleapis.com/drive/v3/files/${r.drive_id}?fields=id,name,description`, {
      method: "PATCH", headers: { Authorization: "Bearer " + token, "Content-Type": "application/json" }, body: JSON.stringify({ name }) });
    if (!res.ok) { await env.DB.prepare("DELETE FROM ws_barcodes WHERE code = ?1 AND ref = ?2").bind(code, r.key).run(); continue; }
    const d = await res.json().catch(() => ({}));
    await env.DB.prepare("UPDATE media_archive SET name = ?2 WHERE key = ?1").bind(r.key, name).run();
    await wsAddToLibraryIndex(env, null, { id: r.drive_id, name, mime: null, size: r.size, branch: "All-Branches", path: ["Creator Studio Archive"], modified: r.archived_at, ...(d.description ? { note: d.description } : {}) }).catch(() => {});
    fixed++;
  }
  return { fixed, left: fix.length - fixed };
}

// ---------------------------------------------------------------------------
// Team & access. Sign-in is Cloudflare Access (email + one-time code) in front of the whole site. Access
// proves *who* someone is; the team list below decides whether they're allowed in and with what role, so
// adding a new hire is just adding their email in Settings — no Cloudflare changes needed.
// Until ACCESS_TEAM_DOMAIN and ACCESS_AUD are set, the site stays open (demo user switcher) as before.
// ---------------------------------------------------------------------------

const ROLES = ["creator", "manager", "approver", "admin", "video"]; // video = Video Creator: Dashboard, Team Chat, Workspace, Library only
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
  for (const col of ["password_hash TEXT", "password_set_at TEXT"]) { try { await env.DB.prepare("ALTER TABLE team_members ADD COLUMN " + col).run(); } catch (e) { /* already there */ } }
  await env.DB.prepare(`CREATE TABLE IF NOT EXISTS sessions (
    token_hash TEXT PRIMARY KEY, member_id TEXT NOT NULL, created_at TEXT NOT NULL, expires_at TEXT NOT NULL, last_seen TEXT, device TEXT)`).run();
  const n = await env.DB.prepare("SELECT COUNT(*) AS n FROM team_members").first();
  if (!n.n) {
    const now = new Date().toISOString();
    for (const m of DEFAULT_TEAM) {
      await env.DB.prepare("INSERT INTO team_members (id, name, email, role, active, added_at) VALUES (?1, ?2, NULL, ?3, 1, ?4)").bind(m.id, m.name, m.role, now).run();
    }
  }
  teamTableReady = true;
}
const memberOut = (r) => ({ id: r.id, name: r.name, email: r.email || "", role: r.role, active: !!r.active, addedAt: r.added_at, lastSeen: r.last_seen || null, hasPassword: !!r.password_hash });

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
  const password = b.password == null ? null : String(b.password);
  if (password !== null && password.length < 8) throw new HttpError(400, "Passwords need at least 8 characters.");
  if (password !== null && !email) throw new HttpError(400, "Add an email first — people sign in with their email and password.");
  if (existing) {
    await env.DB.prepare("UPDATE team_members SET name = ?2, email = ?3, role = ?4, active = ?5 WHERE id = ?1").bind(id, name, email || null, role, active).run();
  } else {
    await env.DB.prepare("INSERT INTO team_members (id, name, email, role, active, added_at, added_by) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7)")
      .bind(id, name, email || null, role, active, new Date().toISOString(), viewer.member ? viewer.member.email : null).run();
  }
  if (password !== null) {
    await env.DB.prepare("UPDATE team_members SET password_hash = ?2, password_set_at = ?3 WHERE id = ?1").bind(id, await hashPassword(password), new Date().toISOString()).run();
    await env.DB.prepare("DELETE FROM sessions WHERE member_id = ?1").bind(id).run(); // a reset signs them out everywhere
    if (email) await env.DB.prepare("DELETE FROM app_kv WHERE k = ?1").bind("signin_fail_" + (await sha256hex(email)).slice(0, 24)).run(); // and lifts a too-many-tries lock
  }
  if (!active) await env.DB.prepare("DELETE FROM sessions WHERE member_id = ?1").bind(id).run();
  return { member: memberOut(await env.DB.prepare("SELECT * FROM team_members WHERE id = ?1").bind(id).first()) };
}

// ---- Built-in sign-in (SIGNIN = "password"): email + password, then a 60-day session cookie per device.
// Passwords are stored only as salted PBKDF2-SHA256 hashes; sessions are random tokens stored hashed, so a copy
// of the database can't be used to sign in. Admins set/reset passwords in Settings → Team & access.
// A session ends after 2 days without using Creator Studio, and after 30 days whatever happens.
const SESSION_COOKIE = "cs_session", SESSION_DAYS = 30, SESSION_IDLE_MS = 48 * 3600e3, PBKDF2_ITER = 100000;
const b64 = (buf) => btoa(String.fromCharCode(...new Uint8Array(buf)));
const unb64 = (s) => Uint8Array.from(atob(s), (c) => c.charCodeAt(0));
async function pbkdf2(password, salt, iter) {
  const key = await crypto.subtle.importKey("raw", new TextEncoder().encode(password), "PBKDF2", false, ["deriveBits"]);
  return crypto.subtle.deriveBits({ name: "PBKDF2", hash: "SHA-256", salt, iterations: iter }, key, 256);
}
async function hashPassword(password) {
  const salt = crypto.getRandomValues(new Uint8Array(16));
  return `pbkdf2$${PBKDF2_ITER}$${b64(salt)}$${b64(await pbkdf2(password, salt, PBKDF2_ITER))}`;
}
async function checkPassword(password, stored) {
  const [kind, iter, salt, hash] = String(stored || "").split("$");
  if (kind !== "pbkdf2" || !hash) return false;
  const got = new Uint8Array(await pbkdf2(password, unb64(salt), Number(iter)));
  const want = unb64(hash);
  if (got.length !== want.length) return false;
  let diff = 0; for (let i = 0; i < got.length; i++) diff |= got[i] ^ want[i];
  return diff === 0;
}
const sha256hex = async (s) => [...new Uint8Array(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(s)))].map((b) => b.toString(16).padStart(2, "0")).join("");
const sessionCookie = (token, maxAge) => `${SESSION_COOKIE}=${token}; Path=/; HttpOnly; Secure; SameSite=Lax; Max-Age=${maxAge}`;

async function signIn(request, env) {
  const b = await request.json().catch(() => ({}));
  const email = String(b.email || "").trim().toLowerCase();
  const password = String(b.password || "");
  if (!email || !password) throw new HttpError(400, "Enter your email and password.");
  await ensureTeamTable(env);
  // Slow down guessing: 8 wrong tries for an email locks it for 15 minutes.
  const lockKey = "signin_fail_" + (await sha256hex(email)).slice(0, 24);
  const fails = (await kvGet(env, lockKey)) || { n: 0, since: Date.now() };
  if (Date.now() - fails.since > 15 * 60e3) { fails.n = 0; fails.since = Date.now(); }
  if (fails.n >= 8) throw new HttpError(429, "Too many tries — wait 15 minutes, or ask an admin to reset your password.");
  // And from one connection: 30 wrong tries in 15 minutes (any emails) pauses sign-in from there.
  const ip = request.headers.get("CF-Connecting-IP") || "unknown";
  const ipKey = "signin_ip_" + (await sha256hex(ip)).slice(0, 24);
  const ipFails = (await kvGet(env, ipKey)) || { n: 0, since: Date.now() };
  if (Date.now() - ipFails.since > 15 * 60e3) { ipFails.n = 0; ipFails.since = Date.now(); }
  if (ipFails.n >= 30) throw new HttpError(429, "Too many sign-in attempts from this connection — wait 15 minutes.");
  const row = await env.DB.prepare("SELECT * FROM team_members WHERE email = ?1").bind(email).first();
  // Same work and the same answer whether or not the email is on the team, so nobody can probe for members.
  const ok = row && row.active && row.password_hash ? await checkPassword(password, row.password_hash) : (await hashPassword(password), false);
  if (!ok) {
    fails.n++; await kvSet(env, lockKey, fails);
    ipFails.n++; await kvSet(env, ipKey, ipFails);
    throw new HttpError(401, "That email and password don't match.");
  }
  await kvSet(env, lockKey, { n: 0, since: Date.now() });
  const token = b64(crypto.getRandomValues(new Uint8Array(32))).replace(/[+/=]/g, (c) => ({ "+": "-", "/": "_", "=": "" }[c]));
  const now = new Date();
  await env.DB.prepare("INSERT INTO sessions (token_hash, member_id, created_at, expires_at, last_seen, device) VALUES (?1, ?2, ?3, ?4, ?3, ?5)")
    .bind(await sha256hex(token), row.id, now.toISOString(), new Date(now.getTime() + SESSION_DAYS * 86400e3).toISOString(), String(request.headers.get("user-agent") || "").slice(0, 160)).run();
  return new Response(JSON.stringify({ ok: true, member: memberOut(row) }), { headers: { "Content-Type": "application/json", "Set-Cookie": sessionCookie(token, SESSION_DAYS * 86400) } });
}
async function signOut(request, env) {
  const token = cookie(request, SESSION_COOKIE);
  if (token) { await ensureTeamTable(env); await env.DB.prepare("DELETE FROM sessions WHERE token_hash = ?1").bind(await sha256hex(token)).run(); }
  return new Response(JSON.stringify({ ok: true }), { headers: { "Content-Type": "application/json", "Set-Cookie": sessionCookie("", 0) } });
}
async function signOutOthers(request, env, viewer) {
  if (!viewer.member) throw new HttpError(401, "Please sign in again.");
  const mine = cookie(request, SESSION_COOKIE);
  const r = await env.DB.prepare("DELETE FROM sessions WHERE member_id = ?1 AND token_hash != ?2").bind(viewer.member.id, mine ? await sha256hex(mine) : "").run();
  return { ok: true, signedOut: (r.meta && r.meta.changes) || 0 };
}
async function changeOwnPassword(request, env, viewer) {
  const b = await request.json().catch(() => ({}));
  if (!viewer.member) throw new HttpError(401, "Please sign in again.");
  const row = await env.DB.prepare("SELECT * FROM team_members WHERE id = ?1").bind(viewer.member.id).first();
  if (row.password_hash && !(await checkPassword(String(b.current || ""), row.password_hash))) throw new HttpError(403, "Your current password isn't right.");
  const next = String(b.next || "");
  if (next.length < 8) throw new HttpError(400, "Passwords need at least 8 characters.");
  await env.DB.prepare("UPDATE team_members SET password_hash = ?2, password_set_at = ?3 WHERE id = ?1").bind(row.id, await hashPassword(next), new Date().toISOString()).run();
  // Stay signed in here; sign out every other device.
  const mine = cookie(request, SESSION_COOKIE);
  await env.DB.prepare("DELETE FROM sessions WHERE member_id = ?1 AND token_hash != ?2").bind(row.id, mine ? await sha256hex(mine) : "").run();
  return { ok: true };
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
  if (env.SIGNIN === "password") {
    const token = cookie(request, SESSION_COOKIE);
    const signedOut = () => { const e = new HttpError(401, "Please sign in."); e.code = "signed_out"; e.signin = "password"; return e; };
    if (!token) throw signedOut();
    await ensureTeamTable(env);
    const sess = await env.DB.prepare("SELECT * FROM sessions WHERE token_hash = ?1").bind(await sha256hex(token)).first();
    if (!sess || Date.parse(sess.expires_at) < Date.now()) { if (sess) await env.DB.prepare("DELETE FROM sessions WHERE token_hash = ?1").bind(sess.token_hash).run(); throw signedOut(); }
    if (Date.now() - Date.parse(sess.last_seen || sess.created_at) > SESSION_IDLE_MS) {
      await env.DB.prepare("DELETE FROM sessions WHERE token_hash = ?1").bind(sess.token_hash).run();
      const e = signedOut(); e.message = "You were signed out because Creator Studio wasn't used for 2 days. Please sign in again."; throw e;
    }
    const row = await env.DB.prepare("SELECT * FROM team_members WHERE id = ?1").bind(sess.member_id).first();
    if (!row || !row.active) throw signedOut();
    if (!sess.last_seen || Date.now() - Date.parse(sess.last_seen) > 10 * 60e3) {
      await env.DB.prepare("UPDATE sessions SET last_seen = ?2 WHERE token_hash = ?1").bind(sess.token_hash, new Date().toISOString()).run();
      await env.DB.prepare("UPDATE team_members SET last_seen = ?2 WHERE id = ?1").bind(row.id, new Date().toISOString()).run();
    }
    return { accessEnabled: true, signin: "password", email: row.email, member: memberOut(row) };
  }
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
    signin: viewer.signin || (viewer.accessEnabled ? "access" : null),
    member: viewer.member,
    logoutUrl: viewer.signin === "password" ? null : viewer.accessEnabled ? new URL("/cdn-cgi/access/logout", request.url).toString() : null,
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
    // Two-person approval: every approver (Cyrus and Yan Yan) is asked, whoever the post was assigned to.
    const approverOrReviewers = () => { const req = requiredFor(item, reviewers.map((r) => r.id)); return req.filter((id) => id !== a.user); };
    const creator = item.creator && item.creator !== a.user ? [item.creator] : [];
    if (a.type === "created" && /submitted/i.test(a.detail || "")) {
      notify = approverOrReviewers();
      text = `🔔 ${actor} sent “${title}” for approval (${platforms}).`;
    } else if (a.type === "submitted") {
      notify = approverOrReviewers();
      text = `🔁 ${actor} resubmitted “${title}”${a.version ? " as v" + a.version : ""} after changes.${note}`;
    } else if (a.type === "approval") {
      // First of the two approvals: tell whoever still has to approve.
      const left = (Array.isArray(a.waitingFor) ? a.waitingFor : []).filter((id) => id !== a.user && byId.has(id));
      notify = left;
      text = `👍 ${actor} approved “${title}” — it still needs ${left.length ? left.map(nameOf).join(" and ") : "the other approver"} to approve before it can go out.`;
    } else if (a.type === "approved") {
      notify = creator;
      text = requiredFor(item, reviewers.map((r) => r.id)).length > 1 && item.approver !== "either" ? `✅ “${title}” is approved — ${actor} gave the final approval, so both approvals are in.` : `✅ ${actor} approved “${title}”.`;
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
      const tab = { created: "review", submitted: "review", approval: "review", changes_requested: "changes", rejected: "rejected" }[a.type];
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

// ---- Music library (royalty-free) ----
// Search comes from Openverse (openverse.org), limited to music whose licence allows business use
// (CC0, CC BY and public domain only: "non-commercial", "no-derivatives" and "share-alike" tracks can't be synced to
// a business reel). The song is mixed into the video in the browser, so the
// reel posts normally with the music in it. CC BY tracks need a credit, which the app adds to the caption.
const OPENVERSE = "https://api.openverse.org/v1/audio/";
const MUSIC_UA = { "User-Agent": "SanjugoCreatorStudio/1.0", Accept: "application/json" };
function musicTrack(r) {
  const lic = String(r.license || "").toLowerCase();
  const label = lic === "cc0" ? "CC0" : lic === "pdm" ? "Public domain" : "CC " + lic.toUpperCase() + (r.license_version ? " " + r.license_version : "");
  return { id: r.id, title: String(r.title || "Untitled").slice(0, 120), artist: String(r.creator || "Unknown artist").slice(0, 80),
    duration: r.duration ? Math.round(r.duration / 1000) : null, license: lic, licenseLabel: label, licenseUrl: r.license_url || "",
    page: r.foreign_landing_url || "", source: r.source || r.provider || "", genres: (r.genres || []).slice(0, 3),
    needsCredit: !["cc0", "pdm"].includes(lic), credit: `🎵 Music: “${String(r.title || "Untitled").slice(0, 80)}” by ${String(r.creator || "Unknown").slice(0, 60)} (${label})` };
}
async function musicRoute(url) {
  if (url.pathname === "/api/music/search") {
    const q = String(url.searchParams.get("q") || "").trim().slice(0, 80) || "upbeat";
    const page = Math.min(10, Math.max(1, Number(url.searchParams.get("page")) || 1));
    const qs = new URLSearchParams({ q, license: "cc0,by,pdm", category: "music", page_size: "20", page: String(page), mature: "false" });
    const r = await fetch(OPENVERSE + "?" + qs, { headers: MUSIC_UA, cf: { cacheTtl: 3600, cacheEverything: true } });
    if (!r.ok) throw new HttpError(502, "The music library didn't answer (" + r.status + "). Try again in a minute.");
    const d = await r.json();
    const tracks = (d.results || []).filter((x) => x.url && (!x.duration || x.duration >= 10000) && ["cc0", "by", "pdm"].includes(String(x.license))).map(musicTrack);
    return json({ tracks, total: d.result_count || tracks.length, page, pages: d.page_count || 1 });
  }
  if (url.pathname === "/api/music/preview") {
    // Instagram songs can't be played outside Instagram, so we find the same song's free 30-second preview on
    // Apple Music (iTunes Search API) — only to hear it in Creator Studio, never posted.
    const q = String(url.searchParams.get("q") || "").replace(/[—–-]+/g, " ").replace(/\s+/g, " ").trim().slice(0, 100);
    if (!q) return json({ songs: [] });
    const qs = new URLSearchParams({ term: q, media: "music", entity: "song", limit: "5", country: "GB" });
    const r = await fetch("https://itunes.apple.com/search?" + qs, { headers: { "User-Agent": MUSIC_UA["User-Agent"] }, cf: { cacheTtl: 86400, cacheEverything: true } });
    if (!r.ok) throw new HttpError(502, "Apple Music didn't answer (" + r.status + "). Try again in a minute.");
    const d = await r.json();
    const songs = (d.results || []).filter((x) => x.previewUrl && /^https:\/\/[a-z0-9.-]+\.(apple|mzstatic)\.com\//.test(x.previewUrl)).slice(0, 3).map((x) => ({
      id: String(x.trackId), name: String(x.trackName || "").slice(0, 120), artist: String(x.artistName || "").slice(0, 80),
      art: String(x.artworkUrl100 || "").replace(/^http:/, "https:"), preview: x.previewUrl, link: x.trackViewUrl || "" }));
    return json({ songs });
  }
  const m = url.pathname.match(/^\/api\/music\/audio\/([0-9a-f-]{36})$/);
  if (m) { // the song file, fetched through here so the editor can read it (only tracks from the library)
    const info = await fetch(OPENVERSE + m[1] + "/", { headers: MUSIC_UA, cf: { cacheTtl: 86400, cacheEverything: true } });
    if (!info.ok) throw new HttpError(404, "That song isn't in the library any more.");
    const t = await info.json();
    if (!t.url || !["cc0", "by", "pdm"].includes(String(t.license))) throw new HttpError(404, "That song can't be used.");
    const a = await fetch(t.url, { headers: { "User-Agent": MUSIC_UA["User-Agent"] }, cf: { cacheTtl: 86400, cacheEverything: true } });
    if (!a.ok || !a.body) throw new HttpError(502, "Couldn't load the song (" + a.status + ").");
    return new Response(a.body, { headers: { "Content-Type": a.headers.get("Content-Type") || "audio/mpeg", "Cache-Control": "private, max-age=86400", ...(a.headers.get("Content-Length") ? { "Content-Length": a.headers.get("Content-Length") } : {}) } });
  }
  throw new HttpError(404, "Not found");
}

async function pushRoute(request, env, url, viewer) {
  if (url.pathname === "/api/push/key" && request.method === "GET") {
    return json({ publicKey: (await vapidKeys(env)).publicKey });
  }
  if (url.pathname === "/api/push/status" && request.method === "GET") { // admins: who has alerts switched on, on how many devices
    if (viewer.accessEnabled && !(viewer.member && viewer.member.role === "admin")) return json({ error: "Admins only" }, 403);
    await ensurePushTable(env);
    const { results } = await env.DB.prepare("SELECT user_id, device, created_at, last_ok FROM push_subs ORDER BY created_at").all();
    const users = {};
    for (const r of results || []) (users[r.user_id] = users[r.user_id] || []).push({ device: r.device || "", since: r.created_at, lastOk: r.last_ok || null });
    return json({ users });
  }
  if (url.pathname === "/api/push/digest" && request.method === "GET") { // admins: see tonight's / tomorrow morning's messages without sending
    if (viewer.accessEnabled && !(viewer.member && viewer.member.role === "admin")) return json({ error: "Admins only" }, 403);
    const night = await dailyDigest(env, "preview");
    const all = await digestTasks(env);
    const c = londonClock();
    const morning = all.map((x) => ({ name: x.member.name, tasks: x.tasks.length, ...digestMessage(x.member, x.tasks, "morning", c.day) }));
    return json({ night: night.sent, morning, times: { night: DIGEST_NIGHT + ":00", morning: DIGEST_MORNING + ":00" } });
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
// Google Business listings (Make's "Publish · Google Business" posts to each one sent). A post's gbp variant
// picks one with variant.listing; missing or "all" = all three.
const GBP_ACCOUNT = "accounts/104977954501162337577";
const GBP_LOCATIONS = { shoreditch: "16835292729078583249", angel: "10144825567996062942", victoria: "2180749039694857931" };
// Google Business "Gallery photo" posts: photos go into the listing's Photos under one of these categories.
const GBP_PHOTO_CATEGORIES = ["FOOD_AND_DRINK", "INTERIOR", "EXTERIOR", "AT_WORK", "TEAMS", "COMMON_AREA", "MENU", "ADDITIONAL", "COVER"];
const GBP_MAX_PHOTO_BYTES = 5 * 1024 * 1024;
function gbpLocations(listing) {
  const keys = GBP_LOCATIONS[listing] ? [listing] : Object.keys(GBP_LOCATIONS);
  return keys.map((k) => `${GBP_ACCOUNT}/locations/${GBP_LOCATIONS[k]}`).join(",");
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

async function postSystemChat(env, { text, mentions = [], contentId = null, eventId, card = null }) {
  await ensureChatTable(env);
  const res = await env.DB.prepare(
    "INSERT OR IGNORE INTO chat_messages (author, text, mentions, content_id, created_at, event_id, card) VALUES ('system', ?1, ?2, ?3, ?4, ?5, ?6)"
  ).bind(text, JSON.stringify(mentions), contentId, new Date().toISOString(), eventId, card ? JSON.stringify(chatCard(card)) : null).run();
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
// Instagram/Meta don't let apps add library songs, so a post with a song is posted from the phone on these platforms.
const musicByPhone = (item, platform) => !!(item.music && item.music.title && !item.music.baked) && ["instagram", "facebook", "tiktok"].includes(platform);

async function sendPublishJobs(env, { item, platforms, origin, userId, trigger }) {
  const cfg = await makeConfig(env);
  await ensureMakeTables(env);
  const results = [];
  const mediaUrl = absoluteMediaUrl(item.media && item.media.fileUrl, origin);
  // Multi-photo (carousel) post: every photo, in order. Instagram and Facebook post them together; Google Business gets the first.
  // Carousel items can be videos too (Instagram takes them; Make's Facebook photo-post module can't).
  const galleryItems = Array.isArray(item.media && item.media.gallery) && item.media.gallery.length > 1
    ? item.media.gallery.filter((g) => g && g.fileUrl).slice(0, 10).map((g) => ({ url: absoluteMediaUrl(g.fileUrl, origin), video: g.type === "video" })) : null;
  const photos = galleryItems ? galleryItems.map((g) => g.url) : null;
  const hasVideos = !!(galleryItems && galleryItems.some((g) => g.video));
  for (const platform of platforms) {
    const v = (item.variants || {})[platform];
    const hook = publishHookFor(cfg, platform);
    if (!hook) { results.push({ platform, skipped: (PLATFORM_NAMES[platform] || platform) + " isn't connected to Make — publish it by hand, then mark it as published." }); continue; }
    if (!v) { results.push({ platform, skipped: "This post isn't set up for " + PLATFORM_NAMES[platform] + "." }); continue; }
    if (v.publishStatus === "published") { results.push({ platform, skipped: "Already published." }); continue; }
    // Make can't post stories (its Instagram app has no story module) — sending one would post it as a normal reel/post.
    if (photos && (platform === "instagram" || platform === "facebook")) {
      // Make fetches every photo by link — a missing one fails the whole post with a vague error, so say which.
      const missing = [];
      for (const [n, g] of item.media.gallery.entries()) { const k = mediaKeyOf(g && g.fileUrl); if (k && !(await env.MEDIA.head(k))) missing.push(n + 1); }
      if (missing.length) { results.push({ platform, skipped: "Photo " + missing.join(", ") + " of this post is no longer in Creator Studio — open the post, Edit & resubmit, and add the photos again." }); continue; }
    }
    if (photos && platform === "youtube") { results.push({ platform, skipped: "YouTube can't post a carousel." }); continue; }
    if (hasVideos && platform === "facebook") { results.push({ platform, skipped: "Facebook can't auto-post a carousel with videos — post it from the Facebook app, then mark it as published." }); continue; }
    if (isStory(item, v)) { results.push({ platform, skipped: "Stories can't be posted through Make — post it from the " + PLATFORM_NAMES[platform] + " app, then mark it as published." }); continue; }
    if (musicByPhone(item, platform)) { results.push({ platform, skipped: "This post has a song (" + item.music.title + "). Apps can't add Instagram music — post it from the " + PLATFORM_NAMES[platform] + " app with the song, then mark it as published." }); continue; }
    if (!mediaUrl) { results.push({ platform, skipped: "The video or photo hasn't finished uploading to Creator Studio." }); continue; }
    // Google Business "Gallery photo": every photo of the post goes into each chosen listing's Photos (a cover takes the first only).
    const gbpGallery = platform === "gbp" && v.gbpType === "photo";
    let gallery = null;
    if (gbpGallery) {
      const srcs = (photos ? item.media.gallery.filter((g) => g && g.type !== "video").map((g) => g.fileUrl) : item.media.type === "image" ? [item.media.fileUrl] : []).filter(Boolean);
      if (!srcs.length) { results.push({ platform, skipped: "Google gallery photos need a photo — this post is a video." }); continue; }
      const category = GBP_PHOTO_CATEGORIES.includes(v.category) ? v.category : "FOOD_AND_DRINK";
      const use = category === "COVER" ? srcs.slice(0, 1) : srcs;
      const missing = [], tooBig = [];
      for (const [n, u] of use.entries()) {
        const k = mediaKeyOf(u); if (!k) continue;
        const head = await env.MEDIA.head(k);
        if (!head) missing.push(n + 1); else if (head.size > GBP_MAX_PHOTO_BYTES) tooBig.push(n + 1);
      }
      const which = (list) => (use.length > 1 ? "Photo " + list.join(", ") : "The photo");
      if (missing.length) { results.push({ platform, skipped: which(missing) + " is no longer in Creator Studio — open the post, Edit & resubmit, and add it again." }); continue; }
      if (tooBig.length) { results.push({ platform, skipped: which(tooBig) + " is over Google's 5MB limit — export a smaller JPG and replace it." }); continue; }
      const urls = use.map((u) => absoluteMediaUrl(u, origin));
      gallery = { mediaCategory: category, galleryItems: gbpLocations(v.listing).split(",").flatMap((location) => urls.map((sourceUrl) => ({ location, sourceUrl }))) };
    }
    // Google Business posts take a photo: for a video, send its cover image instead.
    const gbpImage = platform === "gbp" ? (item.media.type === "image" ? mediaUrl : absoluteMediaUrl(item.media.previewUrl, origin)) : null;
    if (platform === "gbp" && !gbpGallery && !gbpImage) { results.push({ platform, skipped: "Google Business needs a photo — this video has no stored cover image." }); continue; }
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
    const carousel = photos && (platform === "instagram" || platform === "facebook");
    const payload = {
      token: job.token, jobId: job.id, contentId: item.id, platform,
      kind: gallery ? "gallery" : carousel ? "carousel" : isPhoto ? "photo" : platform === "youtube" ? "short" : platform === "gbp" ? "update" : "reel",
      // Ready-made lists for Make's "Create a carousel post" (Instagram) and "Create a Post with Photos" (Facebook).
      ...(carousel ? { photoCount: photos.length, igFiles: galleryItems.map((g) => (g.video ? { media_type: "VIDEO", video_url: g.url } : { media_type: "IMAGE", image_url: g.url })), fbPhotos: galleryItems.filter((g) => !g.video).map((g) => ({ type: "url", url: g.url })) } : {}),
      title: String(v.title || item.title || "Sanjugo").replace(/[<>]/g, "").slice(0, 100),
      caption: platform === "youtube" ? String(v.description || caption).replace(/[<>]/g, "") : platform === "gbp" ? caption.slice(0, 1500) : caption,
      mediaUrl: gbpImage || mediaUrl, fileName: key || (isPhoto ? "photo.jpg" : "video.mp4"), privacy: "public",
      mediaFormat: isPhoto || gbpImage ? "PHOTO" : "VIDEO",
      // Google Business button: needs a link unless it's "Call" (which uses the listing's phone number).
      ctaType: !v.url ? "CALL" : cta, ctaUrl: v.url || "",
      ...(platform === "gbp" ? { listing: GBP_LOCATIONS[v.listing] ? v.listing : "all", locations: gbpLocations(v.listing) } : {}),
      ...(gallery || {}),
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
  if (!platforms.length) throw new HttpError(400, "Add at least one Pull webhook in Settings → Make.com connections first.");
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

  if (job.kind === "reviews" || job.kind === "reply_ig" || job.kind === "reply_review") return await engageCallback(env, job, body);
  if (job.kind === "comp" || job.kind === "maps") return await insightsCallback(env, job, body);
  if (job.kind === "collab") {
    if (job.status !== "sent" || Date.now() - Date.parse(job.created_at) > 60 * 60e3) return json({ error: "Expired" }, 403);
    await ensureStudy(env);
    return json(await collabCallback(env, job, body));
  }
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

// Every 5 minutes: a post (or story/reel) still waiting for approval within an hour of its publish time gets one
// reminder — Team Chat @mention + phone/desktop alert — to whoever is assigned to approve it. Posts already
// approved, sent back or rejected are left alone. The event id includes the publish time, so moving the post
// to a new time earns a fresh reminder, and each time is only reminded once.
const REMIND_BEFORE_MS = 60 * 60e3;
async function remindPendingApprovals(env) {
  const state = await readState(env);
  const now = Date.now();
  let team = null;
  for (const item of state.contentItems || []) {
    if (item.status !== "submitted") continue;
    // Platforms still waiting (in per-platform review, decided platforms drop out).
    const waiting = Object.entries(item.variants || {}).filter(([, v]) => v && v.scheduledAt && (v.status === "submitted" || !v.status) && v.publishStatus !== "published");
    if (!waiting.length) continue;
    const at = Math.min(...waiting.map(([, v]) => londonTime(v.scheduledAt)).filter(Number.isFinite));
    if (!Number.isFinite(at) || now < at - REMIND_BEFORE_MS || now > at + 30 * 60e3) continue;
    if (!team) team = (await listTeam(env)).members;
    const reviewers = team.filter((m) => m.active && (m.role === "approver" || m.role === "admin"));
    // Two-person approval: remind each approver who hasn't approved the waiting platforms yet.
    const req = requiredFor(item, reviewers.map((m) => m.id));
    const who = reviewers.filter((m) => req.includes(m.id) && waiting.some(([, v]) => !(v.approvals || {})[m.id])).map((m) => m.id);
    if (!who.length) continue;
    const byId = new Map(team.map((m) => [m.id, m]));
    const when = new Date(at).toLocaleString("en-GB", { timeZone: "Europe/London", weekday: "short", hour: "2-digit", minute: "2-digit" });
    const mins = Math.round((at - now) / 60e3);
    const left = mins > 0 ? `in ${mins} min` : mins === 0 ? "now" : `${-mins} min ago`;
    const kind = item.format === "story" ? "story" : /reel|short|video/i.test(waiting.map(([, v]) => v.postType).join(" ")) ? "reel" : "post";
    const where = waiting.map(([p]) => PLATFORM_NAMES[p] || p).join(", ");
    const text = `⏰ Reminder: the ${kind} “${item.title || "Untitled"}” is due to go out ${when} (${left}) on ${where} and is still waiting for approval. ${who.map((id) => "@" + byId.get(id).name).join(" ")}`;
    const posted = await postSystemChat(env, { text, mentions: who, contentId: item.id, eventId: "remind_" + item.id + "_" + at });
    if (posted) await pushToUsers(env, who, { title: "Approval needed — " + left, body: `“${item.title || "Untitled"}” goes out ${when}. Tap to review.`, url: "/#/queue", tag: "remind-" + item.id }).catch(() => {});
  }
}

// ---- Daily reminder on everyone's phone ----
// 10am (London) "good morning, here's what's waiting" and 9pm "good night" with what's still left — for everyone.
// It's the same list as "Waiting on you" on the Dashboard.
const DIGEST_NIGHT = 21, DIGEST_MORNING = 10;
function londonClock(t = Date.now()) {
  const parts = Object.fromEntries(new Intl.DateTimeFormat("en-GB", { timeZone: "Europe/London", year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit", hourCycle: "h23" })
    .formatToParts(new Date(t)).map((p) => [p.type, p.value]));
  return { day: `${parts.year}-${parts.month}-${parts.day}`, hour: Number(parts.hour), minute: Number(parts.minute) };
}
async function digestTasks(env) {
  const [state, { members }] = await Promise.all([readState(env), listTeam(env)]);
  await ensureWsTables(env);
  const [{ results: rows }, { results: itemRows }] = await Promise.all([
    env.DB.prepare("SELECT data FROM ws_projects").all(), env.DB.prepare("SELECT data FROM ws_items").all()]);
  const byProject = new Map();
  for (const r of itemRows || []) { const it = JSON.parse(r.data); if (it.deleted) continue; if (!byProject.has(it.projectId)) byProject.set(it.projectId, []); byProject.get(it.projectId).push(it); }
  const projects = (rows || []).map((r) => JSON.parse(r.data)).filter((p) => !p.deleted);
  // Campaign tasks (Campaigns → a campaign → Plan and tasks) due by tomorrow, for whoever they're assigned to.
  let campTasks = [];
  try {
    await ensureCampTable(env);
    const { results: cr } = await env.DB.prepare("SELECT data FROM camp_docs WHERE kind = 'campaign'").all();
    const tomorrow = new Date(Date.now() + 36 * 3600e3).toISOString().slice(0, 10);
    for (const r of cr || []) { const c = JSON.parse(r.data);
      for (const t of c.tasks || []) if (t && t.who && !t.done && t.due && t.due <= tomorrow && t.text) campTasks.push({ who: t.who, title: t.text + " (" + c.name + ")", urgent: t.due < tomorrow }); }
  } catch (e) {}
  const items = state.contentItems || [];
  const active = members.filter((m) => m.active !== false);
  const reviewerIds = active.filter((m) => m.role === "approver" || m.role === "admin").map((m) => m.id);
  const soon = (it) => Object.values(it.variants || {}).some((v) => v && v.scheduledAt && londonTime(v.scheduledAt) - Date.now() < 24 * 3600e3);
  const out = [];
  for (const m of active) {
    const t = []; // {urgent, kind}
    const video = m.role === "video";
    if (!video) {
      if (reviewerIds.includes(m.id)) for (const it of items) {
        if (it.status !== "submitted" || !requiredFor(it, reviewerIds).includes(m.id)) continue;
        const pending = Object.values(it.variants || {}).filter((v) => v && (v.status === "submitted" || !v.status));
        if (pending.some((v) => !(v.approvals || {})[m.id])) t.push({ kind: "approve", urgent: soon(it), title: it.title });
      }
      for (const it of items) {
        if (it.status === "changes_requested" && it.creator === m.id) t.push({ kind: "changes", title: it.title });
        if (it.status === "failed" || Object.values(it.variants || {}).some((v) => v && v.publishStatus === "failed")) t.push({ kind: "failed", urgent: true, title: it.title });
      }
    }
    for (const p of projects) {
      const sum = wsSummary(p, byProject.get(p.id) || [], members, m.id);
      for (const r of sum.waiting) if (!video && r.author !== m.id) t.push({ kind: "draft", title: p.title + " (draft " + r.cut + ")" });
      for (const r of sum.approved) if ((r.submitted && r.submitted.by) === m.id || r.author === m.id) t.push({ kind: "name", title: p.title + " (draft " + r.cut + ")" });
      if (sum.counts.toVote > 0) t.push({ kind: "vote", title: p.title, n: sum.counts.toVote });
    }
    for (const ct of campTasks) if (ct.who === m.id) t.push({ kind: "camp", title: ct.title, urgent: ct.urgent });
    out.push({ member: m, tasks: t });
  }
  return out;
}
const DIGEST_WORDS = { failed: ["failed post", "failed posts"], approve: ["post to approve", "posts to approve"], changes: ["post to fix", "posts to fix"],
  draft: ["draft to watch", "drafts to watch"], name: ["file to name", "files to name"], vote: ["project to vote on", "projects to vote on"], camp: ["campaign task", "campaign tasks"] };
const DIGEST_ICON = { failed: "🔴", approve: "✅", changes: "✏️", draft: "🎬", name: "📁", vote: "👍", camp: "📣" };
const DIGEST_NIGHTS = ["Rest well, tomorrow's a fresh start. 🌙", "Thanks for today — sleep well. 😴", "Switch off and recharge. Good night! ✨", "Great work today. Sweet dreams. 🌙", "Enjoy your evening — it'll keep till tomorrow. 💛"];
const DIGEST_MORNINGS = ["Start your day — you've got this! 💪", "Let's make it a great one. ☀️", "Coffee first, then let's go! ☕", "Have a brilliant day! ✨"];
const DIGEST_MORNING_CLEAR = ["Nothing is waiting on you — have a great day! ☀️", "All clear this morning. Enjoy your day! ✨", "You're all caught up. Have a lovely day! 💛"];
const DIGEST_CLEAR = ["Nothing is waiting on you. Have a good night! 🌙", "All clear today — well done. Have a good night! ✨", "Inbox zero for Creator Studio. Sleep well! 😴", "You're all caught up. Enjoy your evening! 💛"];
function digestMessage(m, tasks, slot, day) {
  const first = String(m.name || "").trim() || "there";
  const pick = (list) => list[(Number(day.replace(/-/g, "")) + first.length) % list.length];
  const urgent = tasks.filter((x) => x.urgent).length;
  const counts = {};
  for (const x of tasks) counts[x.kind] = (counts[x.kind] || 0) + 1;
  const order = ["failed", "approve", "changes", "draft", "name", "vote", "camp"].filter((k) => counts[k]);
  const list = order.map((k) => `${DIGEST_ICON[k]} ${counts[k]} ${DIGEST_WORDS[k][counts[k] > 1 ? 1 : 0]}`).join(" · ");
  const n = tasks.length;
  const things = n + (n > 1 ? " things" : " thing");
  if (slot === "morning") return !n ? { title: `☀️ Good morning, ${first}`, body: pick(DIGEST_MORNING_CLEAR), url: "/#/dashboard", tag: "digest" }
    : { title: `☀️ Good morning, ${first} — ${things} waiting${urgent ? `, ${urgent} urgent` : ""}`, body: `${list}. ${urgent ? "Start with the urgent ones. " : ""}${pick(DIGEST_MORNINGS)}`, url: "/#/dashboard", tag: "digest" };
  if (!n) return { title: `🌙 Have a good night, ${first}`, body: pick(DIGEST_CLEAR), url: "/#/dashboard", tag: "digest" };
  return { title: `🌙 Good night, ${first} — ${things} left${urgent ? `, ${urgent} urgent` : ""}`, body: `${list}. Just a reminder for tomorrow. ${pick(DIGEST_NIGHTS)}`, url: "/#/dashboard", tag: "digest" };
}
// Runs with the 5-minute timer; sends once per slot per day (a claim in app_kv stops repeats).
async function dailyDigest(env, force) {
  const c = londonClock();
  const slot = force || (c.hour === DIGEST_NIGHT ? "night" : c.hour === DIGEST_MORNING ? "morning" : null);
  if (!slot || (!force && c.minute > 30)) return { skipped: true };
  if (!force) {
    await ensureStorageTables(env);
    const claim = await env.DB.prepare("INSERT OR IGNORE INTO app_kv (k, v) VALUES (?1, ?2)").bind(`digest_${slot}_${c.day}`, JSON.stringify(Date.now())).run();
    if (!claim.meta || !claim.meta.changes) return { skipped: "already sent" };
  }
  const all = await digestTasks(env);
  const sent = [];
  for (const { member, tasks } of all) {
    const msg = digestMessage(member, tasks, slot, c.day);
    sent.push({ name: member.name, tasks: tasks.length, ...msg });
    if (force !== "preview") await pushToUsers(env, [member.id], msg).catch(() => {});
  }
  return { slot, sent };
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
      if (!publishHookFor(cfg, platform) || !v || v.publishStatus === "published" || !v.scheduledAt || isStory(item, v) || musicByPhone(item, platform)) continue;
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
- Dashboard ("Sanjugo Dashboard", top of the menu): a greeting and "Waiting on you" — everything that needs this person, most urgent first (failed posts, posts to approve, Workspace cuts to approve, file names to confirm, ideas to vote on, posts sent back, and reminders for coming-up occasions with Plan / Done / Not for us); Last 7 days vs the week before (views, engagement, posts out vs the weekly goal, saves + shares); private sticky notes ("My notes", only that person sees them); This week (Mon–Sun, empty days in orange with "+ add"); a slim row with the best post ("make another" starts a Workspace project), Workspace stage counts and finished videos not posted yet.
- Approvers per post (chosen in Create Content): "Cyrus and Yan Yan (both must approve)" — the default — "Cyrus or Yan Yan (either one can approve)" — both see it and whoever approves first makes it Approved — or "Cyrus only" / "Yan Yan only". With both: every post needs BOTH Cyrus and Yan Yan to approve. The first approval is recorded ("Yan Yan ✓ · waiting for Cyrus") and the post stays in "To review" for the other approver; only the second approval makes it Approved and schedules it. Either approver can Reject or Request Edits on their own, which clears approvals; resubmitting starts approvals again.
- Approval reminders: if a post, reel or story is still waiting for approval 1 hour before its publish time, Creator Studio @mentions the assigned approver(s) in Team Chat and sends a phone/desktop alert — once per publish time. Approved, sent-back or rejected posts aren't reminded.
- Carousel posts: in Create Content pick several photos and/or videos at once (up to 10), or tap "Add photo / video" / pick more from the library under "Photos & videos in this post"; reorder with ‹ and remove with ✕. Photos are re-saved as JPEG and trimmed to Instagram's 4:5–1.91:1 shape; videos are fitted in the browser (4:5 to 16:9 — taller videos cropped to 4:5 — max 60s, 1080 wide). Make posts them as an Instagram carousel. Facebook gets a multi-photo post when it's photos only; a carousel with videos is posted from the Facebook app. Google Business gets the photos only; YouTube can't post carousels; TikTok photo posts go up from the TikTok app.
- Create Content: first pick the content style — "Post / Reel" or "Story" (full-screen 9:16, Instagram/Facebook/TikTok only, with an optional link sticker and posting notes instead of a caption; approvers see it as a real story; Make can't post stories, so after approval someone posts it from the phone app and uses "Mark as published"). Then upload a video/photo, or pick one from the Content Library by barcode (e.g. G219). Choose platforms, write a caption per platform, pick a campaign (or "No campaign"), priority, and the approvers — every post needs both Cyrus and Yan Yan to approve. Then submit for approval, or "Save as Draft" (drafts show in the Content Calendar and can be opened, finished and submitted later). To delete a post: open it (tap it in the Calendar, Approval Queue or Dashboard) and tap "Delete draft" / "Delete post" at the top, then confirm. Creators can delete their own post while it is a draft, sent back for changes, or rejected; admins (Cyrus, Yan Yan) can delete any post that is not published. Published posts can\'t be deleted in Creator Studio (delete them in the social app itself).
- Content Library: the Google Drive folder "Sanjugo Marketing Contents Final" (about 1,600 files) plus finished Workspace videos. Files posted outside Creator Studio can be marked used: open the file → "Mark as already used" (where, when, note; Undo to clear). File names end with a barcode like G219; search by barcode, dish or stage, watch videos, see where a file has already been used (post, platform, date), and start a post from it.
- Approval Queue: tabs To review / Needs changes / Rejected. Posts are previewed exactly as they'll look on each app (Reels, TikTok, Shorts, Facebook, Google Business), with full-screen playback. Decide with the two buttons under each post: ✓ Approve (one tap — "Undo" at the top takes it back) or "Needs changes" (pick feedback tags or write what to fix, optional fix-by date, then "Send back"). To refuse a post completely, tap Needs changes → "Reject it instead". "Full package" reviews the whole post; "Per platform" reviews each platform separately. Undo Last Decision exists. Creators fix posts from Needs changes / Rejected and resubmit, optionally telling the approver in chat. Approved posts are auto-placed into the next free slot of the recurring calendar template (Settings) if they have no time.
- Content Calendar (tile "Calendar"): month, week and list views; filter by platform, campaign, status; tap a date to see that day or create content for it. Shows UK bank holidays and food/marketing dates (Halloween, Christmas, Valentine's, Mother's Day, Lunar New Year, Sushi Day, Black Friday…) on the days, plus a "Coming up" list beside the calendar.
- Team Chat: @name mentions (badge, pop-up and phone alert), @everyone, @AI Dev +. Hover a message (tap on a phone) to react (👍 ✅ 👀 ❤️ 😂 🔥), reply, pin (pinned bar at the top and a Pinned tab) or 📁 make a Workspace project from it. The + button shares a Workspace project, a post or a calendar day as a live card with the next action (Approve cut, Vote, Review). Reel links play in the chat and can be added to a project's ideas. Tabs: All, Mentions of me, Updates, Pinned; plus Search. "Creator Studio" posts automatic updates for approvals, publishing and the Workspace.
- Publishing: on an approved post, "Publish…" → "Publish now with Make" posts to the platforms connected in Make (Instagram reel/photo, Facebook reel/photo, YouTube Short, Google Business update); the live link comes back to the post and Team Chat. Or switch on "Auto-publish at the scheduled time" (Settings → Make.com connections; checks every 5 minutes). TikTok can't be posted through Make — post it in the TikTok app, then use "Mark as published". Instagram reels need MP4/MOV, H.264/HEVC, max 1920 px wide, max 5 Mbps; Facebook reels 9:16, 3–90 s; best to export 1080p vertical.
- Stats: Make pulls the latest posts with likes, comments, shares, saves, reach and views every night (about 4am UK time), or any time with "Get latest" (Settings → Stats). TikTok stats come from the public @sanjugouk profile via HasData. Each platform has its own Make scenario ("Pull · Instagram", "Publish · Facebook", …) so one can be fixed without touching the others; "Clear stats" removes a platform's stats (e.g. after switching accounts).
- Analytics: Real data (from Make) or Sample data; ranges 7/30/90 days, 12 months, All time, custom; filters by platform, campaign, content pillar, post; per-platform and per-post views, reach, likes, comments, shares, saves, engagement rate; best time to post; top posts; a growth forecaster.
- Published Content: a study page for every live post (and collabs on other accounts added with "Add collab post": paste the link and who posted it, e.g. "@invited.app @daniafgx", and Instagram's views, likes and comments are fetched and refreshed nightly — Business/Creator accounts only, otherwise type the numbers in; optional cost in £). Filter by period, platform, Collabs only, search; "Compare by" Influencer / Promotion / Content type / Branch / Dish / Platform / Day / Time of day with average views or engagement (Influencer shows a scorecard: posts, avg views, × our usual, engagement, cost, £ per 1,000 views, last collab and Book again / Okay / Skip; tap a row to filter the posts); a day × time heatmap; each post shows how it did against the usual. Open a post for the caption breakdown (hook, words, emojis, hashtags, call to action), editable tags (guessed from the caption, marked "auto"; ✕ removes one; they save when you leave the box), "Explain" (AI says why it worked), team notes, and "Make another like it".
- Workspace (tile in the menu): one project per video. Create project (name, branch, category, dish, creator — or "not assigned yet", due date). Tabs: Ideas (paste reel links or write ideas; everyone except the project's creator votes Yes/No and comments on each with 💬; best first, three No's removes an idea; ⭐ Priority or 3 Yes votes = picked; ideas stay in the order they were added until they get votes; an idea can be moved to another project, and the project's creator and Video Creators only see picked ideas; cards you haven't voted on say "Your vote?"), Plan (the idea text and a shot list the creator ticks off while filming), Draft review (upload Draft 1, Draft 2…; player with −2s/+2s, 0.5× slow motion, loop and download; one "Review chat" for all drafts where a message is pinned to a second of a draft, about a whole draft — both are to-dos ticked "Fixed" — or General; "draft 1 at 0:12" in a message becomes a link; "Send draft N for approval"; "Delete draft N" removes a draft that isn't in approval — its uploader or an admin can do it, its pinned notes go with it, and a waiting draft must be taken back first; approved drafts are kept). Then the draft plays in a phone preview; anyone except the uploader taps "Approve content" or "Needs changes". Only big moments (new project, sent for approval, approved, changes requested, undone, saved to the Library, deleted) post in Team Chat — Workspace comments and votes don't. The uploader confirms the file name (SANJUGO filing system, e.g. 20261031_AL_FC_SP_FIN_v1_S465.mp4) and it is saved to Google Drive (Creator Studio Projects folder) and the Content Library. "Create post from this" then starts a normal post for the Approval Queue. This is content approval only — publishing still goes through the Approval Queue.
- Settings: Stats (Get latest), Notifications, and for admins Team workload, Recent activity, Content library (Google Drive), Storage, Campaigns, Smart insights, Weekly posting slots, Platforms, Make.com connections (webhooks, auto-publish) and Team & access (roles, passwords). Your name and password are under your name at the top right of Settings. There is no separate Team page any more.
- Roles: Creator — create, edit, submit. Approver — approve and schedule. Admin — everything including team and settings. Video Creator (for new video creators) — only the Dashboard, Team Chat, the Workspace and the Content Library: sees only the ideas the team picked, comments, uploads drafts, names finished files, but can't approve content or make posts.`;

async function botSnapshot(env, askerId) {
  const state = await readState(env);
  const { members } = await listTeam(env);
  const byId = new Map(members.map((m) => [m.id, m]));
  const name = (id) => (id === "any" ? "Cyrus and Yan Yan (both must approve)" : id === "either" ? "Cyrus or Yan Yan (either one can approve)" : (byId.get(id) || {}).name || id || "—");
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

// ---------------------------------------------------------------------------
// Workspace — one project per video. The team collects reference reels and ideas (Yes/No votes), plans the
// shot list, the creator uploads cuts, everyone leaves notes pinned to a moment in the video, and once anyone
// else approves the final cut it's named with the SANJUGO filing system, saved to Google Drive and added to the
// Content Library. This is content approval only — captions and publishing come later, in Create Content.
// Projects and their items are separate rows (not the /api/state blob) so two people editing at once never clash.
// ---------------------------------------------------------------------------

const WS_BRANCHES = {
  shoreditch: { letter: "S", folder: "Shoreditch", label: "Shoreditch" },
  angel: { letter: "A", folder: "Angel", label: "Angel" },
  victoria: { letter: "V", folder: "Victoria", label: "Victoria" },
  all: { letter: "G", folder: "All-Branches", label: "All branches" },
};
const WS_SOCIAL = ["AL", "IV", "IS", "TK", "YT"];
const WS_CATEGORIES = { FC: "Food and Craft", AV: "Atmosphere and Vibes", CH: "Culture and History", CM: "Community", PO: "Promos and Offers" };
const WS_STAGES = ["FIN", "EDT", "RAW"];
// Dish codes from SANJUGO_Video_Filing_System.docx (as used in the Content Library: Yasai Kakiage = YS, Tonkatsu Don = TN).
const WS_DISHES = { YK: "Chicken Yakitori", ED: "Edamame", FD: "Fried Dumplings", MS: "Miso Soup", PP: "Padron Pepper", SE: "Spicy Edamame", TS: "Tofu Steak",
  HS: "Hiramasa Salad", ST: "Salmon Tataki", SW: "Seaweed Salad", TT: "Tuna Tataki", WG: "Wagyu Beef Gunkan", WN: "Wagyu Beef Nigiri", WR: "Wagyu Beef Roll", WT: "Wagyu Beef Tataki",
  CK: "Chicken Karaage", EF: "Ebi Fry", CT: "Homemade Chicken Tender", IK: "Iidako Karaage", OT: "Oyster Tempura", PT: "Prawn Tempura", SC: "Soft Shell Crab Tempura", TY: "Tako Yaki", YS: "Yasai Kakiage",
  S3: "3 Sashimi Omakase", S5: "5 Sashimi Omakase", N6: "6 Nigiri Set", S7: "7 Sashimi Omakase", CR: "California Roll", GV: "Green Vege Roll", MP: "Miso Prawn Roll", RB: "Rainbow Roll",
  SA: "Salmon & Avocado Roll", SJ: "SANJUGO Roll", SS: "Soft Shell Crab Roll", SP: "Spicy Tuna Roll", UR: "Unagi Roll", HK: "Grilled Hamachi Kama", GK: "Grilled Sake Kama",
  GT: "Grilled Sake Teriyaki", SB: "Grilled Shioyaki Saba", MN: "Misoni Saba", ND: "Nasu Dengaku", PB: "Panko Prawn Bao", CB: "Spicy Chicken Bao", TB: "Teriyaki Bao", VB: "Vegetable Bao",
  KC: "Chicken Katsu Curry Don", PC: "Prawn Katsu Curry Don", CD: "Chilli Chicken Don", TN: "Tonkatsu Don", GB: "Genki Beef Don", UD: "Unagi Don", SD: "Salmon Don", BC: "Bara Chirashi Don",
  GH: "Gohan", HR: "Hijiki Rice", MC: "Marinated Chilli Chicken", VC: "Vegetable Croquette" };
const WS_NAME_RE = /^(\d{8})_([A-Z]{2})_([A-Z]{2})((?:_[A-Z0-9]{2})*)_([A-Z]{3})_v(\d{1,5})_([A-Z])(\d{3,4})\.([a-z0-9]{2,5})$/;
const WS_ITEM_KINDS = ["link", "idea", "comment", "draft", "note", "shot"];
// Ideas and reference reels get a Yes or No from everyone except the project's creator; enough No's and it's dropped.
// Video Creators don't vote: they film what the team picked.
function wsVoters(p, members) { return members.filter((m) => m.active !== false && m.id !== p.creatorId && m.role !== "video").map((m) => m.id); }
// "Picked" = marked Priority by anyone on the team, or 3 Yes votes (everyone, when fewer than 3 people vote). Only picked ideas reach the creator.
function wsPicked(it, voters) { return !!it.priority || (voters.length > 0 && (it.yes || []).filter((v) => voters.includes(v)).length >= Math.min(3, voters.length)); }
function wsRemoved(it, voters) { return (it.no || []).filter((v) => voters.includes(v)).length >= Math.max(1, Math.min(3, voters.length)); }

let wsTablesReady = false;
async function ensureWsTables(env) {
  if (wsTablesReady) return;
  await env.DB.batch([
    env.DB.prepare("CREATE TABLE IF NOT EXISTS ws_projects (id TEXT PRIMARY KEY, data TEXT NOT NULL, created_at TEXT NOT NULL, updated_at TEXT NOT NULL)"),
    env.DB.prepare("CREATE TABLE IF NOT EXISTS ws_items (id TEXT PRIMARY KEY, project_id TEXT NOT NULL, kind TEXT NOT NULL, data TEXT NOT NULL, created_at TEXT NOT NULL)"),
    env.DB.prepare("CREATE INDEX IF NOT EXISTS ws_items_project ON ws_items(project_id)"),
    env.DB.prepare("CREATE TABLE IF NOT EXISTS ws_raw (id TEXT PRIMARY KEY, data TEXT NOT NULL, created_at TEXT NOT NULL)"),
    // Every barcode Creator Studio hands out, claimed here first so two uploads at the same moment never get the same one.
    env.DB.prepare("CREATE TABLE IF NOT EXISTS ws_barcodes (code TEXT PRIMARY KEY, kind TEXT, ref TEXT, at TEXT NOT NULL)"),
  ]);
  await wsMigrateMulti(env);
  wsTablesReady = true;
}

// Nov 2026: a project can send several drafts for approval. Approval moved from the project (one draft at a time)
// onto each draft: draft.submitted / draft.approval / draft.filed. Old projects are converted once.
async function wsMigrateMulti(env) {
  if ((await kvGet(env, "ws_multi_draft_v1"))) return;
  const { results } = await env.DB.prepare("SELECT data FROM ws_projects WHERE data LIKE '%\"submitted\"%' OR data LIKE '%\"approval\"%' OR data LIKE '%\"filed\"%' OR data LIKE '%\"filing\"%'").all();
  for (const r of results || []) {
    const p = JSON.parse(r.data);
    if (p.filed && !p.filed.draftId && p.approval) p.filed.draftId = p.approval.draftId;
    const moves = [["submitted", p.submitted], ["approval", p.approval], ["filed", p.filed]].filter(([, v]) => v && v.draftId);
    for (const [k, v] of moves) {
      try {
        await wsUpdateItem(env, v.draftId, (d) => { if (!d[k]) d[k] = { ...v }; if (k !== "submitted" && !d.submitted) d.submitted = { by: d.author, at: v.at, cut: d.cut }; });
      } catch (e) { console.error("ws migrate", p.id, k, e.message); }
    }
    delete p.submitted; delete p.approval; delete p.filing;
    if (p.filed) p.legacyFiled = p.filed;
    delete p.filed;
    await wsSaveProject(env, p);
  }
  await kvSet(env, "ws_multi_draft_v1", { at: new Date().toISOString(), projects: (results || []).length });
}

const wsId = (p) => p + "_" + crypto.randomUUID().replace(/-/g, "").slice(0, 10);
const wsText = (v, n) => String(v == null ? "" : v).trim().slice(0, n);

async function wsProject(env, id) {
  const row = await env.DB.prepare("SELECT data FROM ws_projects WHERE id = ?1").bind(String(id || "")).first();
  if (!row) throw new HttpError(404, "That project doesn't exist any more.");
  const p = JSON.parse(row.data);
  if (p.deleted) throw new HttpError(404, "That project was deleted.");
  return p;
}
async function wsSaveProject(env, p) {
  p.updatedAt = new Date().toISOString();
  await env.DB.prepare("INSERT INTO ws_projects (id, data, created_at, updated_at) VALUES (?1, ?2, ?3, ?4) ON CONFLICT(id) DO UPDATE SET data = excluded.data, updated_at = excluded.updated_at")
    .bind(p.id, JSON.stringify(p), p.createdAt, p.updatedAt).run();
  return p;
}
async function wsItems(env, projectId) {
  const { results } = await env.DB.prepare("SELECT data FROM ws_items WHERE project_id = ?1 ORDER BY created_at ASC").bind(projectId).all();
  return (results || []).map((r) => JSON.parse(r.data)).filter((i) => !i.deleted);
}
async function wsItem(env, id) {
  const row = await env.DB.prepare("SELECT data FROM ws_items WHERE id = ?1").bind(String(id || "")).first();
  if (!row) throw new HttpError(404, "That item doesn't exist any more.");
  return JSON.parse(row.data);
}
// Change one item safely when several people tap at once: read it, apply the change, and only write if nobody else
// changed it in between (otherwise read again and redo the change). Stops two votes at the same moment overwriting each other.
async function wsUpdateItem(env, id, change) {
  for (let i = 0; i < 8; i++) {
    const row = await env.DB.prepare("SELECT data FROM ws_items WHERE id = ?1").bind(String(id || "")).first();
    if (!row) throw new HttpError(404, "That item doesn't exist any more.");
    const it = JSON.parse(row.data);
    await change(it);
    const res = await env.DB.prepare("UPDATE ws_items SET data = ?1, project_id = ?2, kind = ?3 WHERE id = ?4 AND data = ?5")
      .bind(JSON.stringify(it), it.projectId, it.kind, it.id, row.data).run();
    if (res.meta && res.meta.changes > 0) return it;
  }
  throw new HttpError(409, "Lots of changes at once — please try again.");
}
async function wsSaveItem(env, it) {
  await env.DB.prepare("INSERT INTO ws_items (id, project_id, kind, data, created_at) VALUES (?1, ?2, ?3, ?4, ?5) ON CONFLICT(id) DO UPDATE SET data = excluded.data, project_id = excluded.project_id, kind = excluded.kind")
    .bind(it.id, it.projectId, it.kind, JSON.stringify(it), it.createdAt).run();
  return it;
}

// A song on a project (picked in the plan) or on a draft (mixed in). Library songs keep their details so they can be
// loaded again and credited; a song typed by hand (Instagram's own library) is just a title and a link.
function wsSong(m, mixed) {
  const url = wsText(m.url || m.page, 300);
  const t = m.id && /^[0-9a-f-]{36}$/.test(String(m.id)) ? { id: String(m.id), title: wsText(m.title, 120), artist: wsText(m.artist, 80), duration: Number(m.duration) || null,
    license: wsText(m.license, 12), licenseLabel: wsText(m.licenseLabel, 30), licenseUrl: /^https:\/\//i.test(String(m.licenseUrl || "")) ? wsText(m.licenseUrl, 200) : "",
    page: /^https:\/\//i.test(url) ? url : "", needsCredit: !!m.needsCredit, credit: wsText(m.credit, 200), genres: Array.isArray(m.genres) ? m.genres.slice(0, 3).map((g) => wsText(g, 20)) : [] } : null;
  if (mixed) return t ? { ...t, start: Number(m.start) || 0, musicVol: Number(m.musicVol) || 0, origVol: Number(m.origVol) || 0, fade: !!m.fade,
    ...(/^\/api\/media\/workspace\/[\w.-]+$/.test(String(m.sourceUrl || "")) ? { sourceUrl: m.sourceUrl } : {}) } : null;
  const pv = m.preview && /^https:\/\/[a-z0-9.-]+\.(apple|mzstatic)\.com\//.test(String(m.preview.preview || "")) ? { id: wsText(m.preview.id, 30), name: wsText(m.preview.name, 120),
    artist: wsText(m.preview.artist, 80), art: /^https:\/\/[a-z0-9.-]+\.(apple|mzstatic)\.com\//.test(String(m.preview.art || "")) ? wsText(m.preview.art, 300) : "",
    preview: wsText(m.preview.preview, 400), link: /^https:\/\/music\.apple\.com\//.test(String(m.preview.link || "")) ? wsText(m.preview.link, 300) : "" } : null;
  return { title: wsText(m.title, 120), url: /^https:\/\//i.test(url) ? url : "", ...(t ? { track: t } : {}), ...(pv && !t ? { preview: pv } : {}) };
}

// Each draft goes its own way: Draft → Waiting for approval → Approved (naming) → In Library (or Changes needed).
// A project can send several drafts (different angles) for approval, one after another or at the same time.
function wsDraftState(d) {
  if (d.filed) return "filed";
  if (d.approval) return "approved";
  if (d.submitted) return "waiting";
  if (d.changes) return "changes";
  return "draft";
}
// Project status, most urgent first: something waiting → something approved (needs its name) → in library → review → ideas.
function wsStatus(p, items) {
  const drafts = items.filter((i) => i.kind === "draft" && !i.deleted);
  const st = drafts.map(wsDraftState);
  if (st.includes("waiting")) return "waiting";
  if (st.includes("approved")) return "approved";
  const filed = drafts.filter((d) => d.filed);
  if (filed.length) {
    const last = filed.reduce((t, d) => (d.filed.at > t ? d.filed.at : t), "");
    return drafts.some((d) => !d.filed && !d.submitted && d.createdAt > last) ? "review" : "filed";
  }
  if (p.legacyFiled) return "filed";
  return drafts.length ? "review" : "ideas";
}
function wsReview(d) {
  return { draftId: d.id, cut: d.cut, author: d.author, state: wsDraftState(d), createdAt: d.createdAt,
    submitted: d.submitted || null, approval: d.approval || null, filed: d.filed || null, changes: d.changes || null };
}
function wsSummary(p, items, members, me) {
  const voters = members ? wsVoters(p, members) : [];
  const ideas = items.filter((i) => (i.kind === "link" || i.kind === "idea") && !(members && wsRemoved(i, voters)));
  const shots = items.filter((i) => i.kind === "shot");
  const drafts = items.filter((i) => i.kind === "draft");
  const latest = drafts[drafts.length - 1] || null;
  const reviews = drafts.filter((d) => wsDraftState(d) !== "draft").map(wsReview);
  const waiting = reviews.filter((r) => r.state === "waiting");
  const approved = reviews.filter((r) => r.state === "approved");
  const filedList = reviews.filter((r) => r.state === "filed").map((r) => ({ ...r.filed, draftId: r.draftId, cut: r.cut, approval: r.approval }))
    .sort((a, b) => String(a.at).localeCompare(String(b.at)));
  if (!filedList.length && p.legacyFiled) filedList.push(p.legacyFiled);
  const lastFiled = filedList[filedList.length - 1] || null;
  const shownD = (waiting[0] && drafts.find((d) => d.id === waiting[0].draftId)) || latest;
  return { ...p, status: wsStatus(p, items),
    reviews, waiting, approved, filedList, filed: lastFiled,
    finishedAt: lastFiled ? lastFiled.at : null, voters,
    counts: { ideas: ideas.length, picked: ideas.filter((i) => wsPicked(i, voters)).length, toVote: me && voters.includes(me) ? ideas.filter((i) => !(i.yes || []).includes(me) && !(i.no || []).includes(me)).length : 0, shots: shots.length, shotsDone: shots.filter((i) => i.done).length,
      comments: items.filter((i) => i.kind === "comment" && !i.parentId).length, drafts: drafts.length, waiting: waiting.length, approved: approved.length, filed: filedList.length,
      openNotes: items.filter((i) => i.kind === "note" && !i.resolved && (!shownD || i.draftId === shownD.id)).length },
    cover: shownD ? { fileUrl: shownD.media && shownD.media.fileUrl, mime: shownD.media && shownD.media.mime, cut: shownD.cut } : null,
    lastActivity: items.reduce((t, i) => (i.createdAt > t ? i.createdAt : t), p.updatedAt) };
}

function wsFood(list) {
  return (Array.isArray(list) ? list : []).slice(0, 40).map((f) => ({
    dish: WS_DISHES[f && f.dish] ? f.dish : null, name: wsText(f && (f.name || WS_DISHES[f.dish]), 80),
    qty: Math.max(1, Math.min(99, Math.round(Number(f && f.qty) || 1))),
    cost: f && f.cost !== "" && f.cost != null && isFinite(Number(f.cost)) ? Math.max(0, Math.round(Number(f.cost) * 100) / 100) : null,
    note: wsText(f && f.note, 120) })).filter((f) => f.name);
}
// Who is acting: the signed-in member, or (with sign-in off, e.g. local testing) whoever the browser says it is.
async function wsActor(env, viewer, body) {
  const { members } = await listTeam(env);
  const id = viewer.accessEnabled ? viewer.member && viewer.member.id : String((body && body.userId) || "");
  const m = members.find((x) => x.id === id && x.active !== false);
  if (!m) throw new HttpError(403, "Sign in to use the Workspace.");
  return { me: m, members };
}

// Everyone else on the team hears about it: a line in Team Chat (optional) plus a phone alert.
async function wsNotify(env, ctx, { actor, members, project, text, push, eventId, chat = true, only }) {
  const others = members.filter((m) => m.active !== false && m.id !== actor.id && (!only || only.includes(m.id))).map((m) => m.id);
  const work = (async () => {
    if (chat) await postSystemChat(env, { text, mentions: others, eventId: eventId || ("ws_" + crypto.randomUUID()), card: { type: "project", id: project.id } });
    if (others.length) await pushToUsers(env, others, { title: push.title, body: push.body.slice(0, 180), url: "/#/workspace?p=" + project.id, tag: "ws-" + project.id });
  })().catch((e) => console.error("workspace notify", e));
  if (ctx) ctx.waitUntil(work); else await work;
}

async function workspaceRoute(request, env, url, viewer, ctx) {
  await ensureWsTables(env);
  const path = url.pathname.replace(/^\/api\/workspace\/?/, "");
  if (path === "raw" || path.startsWith("raw/")) return await rawRoute(request, env, url, viewer, path.slice(4));
  if (request.method === "GET") {
    if (path === "") {
      const [{ results: rows }, { results: itemRows }] = await Promise.all([
        env.DB.prepare("SELECT data FROM ws_projects ORDER BY updated_at DESC").all(),
        env.DB.prepare("SELECT data FROM ws_items").all(),
      ]);
      const byProject = new Map();
      for (const r of itemRows || []) { const it = JSON.parse(r.data); if (it.deleted) continue; if (!byProject.has(it.projectId)) byProject.set(it.projectId, []); byProject.get(it.projectId).push(it); }
      const { members } = await listTeam(env);
      const projects = (rows || []).map((r) => JSON.parse(r.data)).filter((p) => !p.deleted).map((p) => wsSummary(p, byProject.get(p.id) || [], members, url.searchParams.get("me")));
      return json({ projects }, 200);
    }
    if (path === "project") {
      const p = await wsProject(env, url.searchParams.get("id"));
      const items = await wsItems(env, p.id);
      const { members } = await listTeam(env);
      return json({ project: wsSummary(p, items, members), items });
    }
    if (path === "name") {
      const p = await wsProject(env, url.searchParams.get("id"));
      return json(await wsNameSuggestion(env, request, p, await wsItems(env, p.id), url.searchParams.get("draft")));
    }
    throw new HttpError(404, "Unknown workspace request");
  }
  if (request.method !== "POST") throw new HttpError(405, "Method not allowed");
  const body = await request.json().catch(() => ({}));
  const { me, members } = await wsActor(env, viewer, body);
  const now = new Date().toISOString();

  if (path === "project") { // create or edit a project's details
    const isNew = !body.id;
    const p = isNew ? { id: wsId("wp"), createdBy: me.id, createdAt: now } : await wsProject(env, body.id);
    if (isNew || body.title !== undefined) p.title = wsText(body.title, 120) || "Untitled project";
    if (isNew || body.branch !== undefined) p.branch = WS_BRANCHES[body.branch] ? body.branch : "all";
    if (isNew || body.category !== undefined) p.category = WS_CATEGORIES[body.category] ? body.category : "FC";
    if (isNew || body.dishes !== undefined) p.dishes = (Array.isArray(body.dishes) ? body.dishes : []).map(String).filter((d) => WS_DISHES[d]).slice(0, 3);
    // "" = not assigned yet (e.g. a project started from Team Chat) — then everyone votes on its ideas.
    if (isNew || body.creatorId !== undefined) p.creatorId = members.some((m) => m.id === body.creatorId) ? body.creatorId : body.creatorId === "" ? null : me.id;
    if (isNew || body.due !== undefined) p.due = /^\d{4}-\d{2}-\d{2}$/.test(body.due || "") ? body.due : null;
    if (isNew || body.brief !== undefined) p.brief = wsText(body.brief, 2000);
    if (body.music !== undefined) p.music = body.music && body.music.title ? wsSong(body.music) : null;
    // Which campaign the video is for (optional), and the food the shoot needs (dish, how many, cost per portion if not the menu price).
    if (isNew || body.campaignId !== undefined) p.campaignId = /^[\w-]{1,80}$/.test(String(body.campaignId || "")) ? String(body.campaignId) : null;
    if (body.food !== undefined) p.food = wsFood(body.food);
    await wsSaveProject(env, p);
    if (isNew) await wsNotify(env, ctx, { actor: me, members, project: p, text: `📁 ${me.name} started a Workspace project: "${p.title}"`, push: { title: "New Workspace project", body: `${me.name}: ${p.title}` } });
    return json({ project: wsSummary(p, await wsItems(env, p.id), members) });
  }

  if (path === "project/delete") {
    const p = await wsProject(env, body.id);
    if (me.role !== "admin" && p.createdBy !== me.id) throw new HttpError(403, "Only admins or the person who started it can delete a project.");
    if ((await wsItems(env, p.id)).some((i) => i.kind === "draft" && i.filed)) throw new HttpError(409, "This project has videos in the Content Library, so the project is kept.");
    p.deleted = { by: me.id, at: now };
    await wsSaveProject(env, p);
    await wsNotify(env, ctx, { actor: me, members, project: p, text: `🗑️ ${me.name} deleted the Workspace project "${p.title}"`, push: { title: "Project deleted", body: `${me.name} deleted "${p.title}"` } });
    return json({ ok: true });
  }

  if (path === "item") { // add a link, idea, comment, draft (a cut) or a note on a draft
    const p = await wsProject(env, body.projectId);
    const kind = String(body.kind || "");
    if (!WS_ITEM_KINDS.includes(kind)) throw new HttpError(400, "Unknown item type");
    const it = { id: wsId("wi"), projectId: p.id, kind, author: me.id, createdAt: now, text: wsText(body.text, 4000) };
    if (kind === "link") {
      const u = wsText(body.url, 600);
      if (!/^https:\/\/[^\s]+$/i.test(u)) throw new HttpError(400, "Paste a full link that starts with https://");
      it.url = u; it.yes = []; it.no = [];
    } else if (kind === "idea") {
      if (!it.text) throw new HttpError(400, "Write the idea first.");
      it.yes = []; it.no = [];
    } else if (kind === "shot") {
      if (!it.text) throw new HttpError(400, "Describe the shot first.");
    } else if (kind === "comment") {
      if (!it.text) throw new HttpError(400, "Write a comment first.");
      if (body.parentId) { // a comment on one idea or reel
        const parent = await wsItem(env, body.parentId);
        if (parent.projectId !== p.id || (parent.kind !== "idea" && parent.kind !== "link")) throw new HttpError(400, "That idea isn't part of this project.");
        it.parentId = parent.id;
      }
    } else if (kind === "draft") {
      const m = body.media || {};
      if (!/^\/api\/media\/workspace\/[\w.-]+$/.test(m.fileUrl || "")) throw new HttpError(400, "Upload the video first.");
      if (!/^video\//.test(m.mime || "")) throw new HttpError(400, "Drafts must be videos.");
      const existing = (await wsItems(env, p.id)).filter((i) => i.kind === "draft");
      // Next number after the highest draft still there, so deleting a middle draft never gives two drafts the same number.
      it.cut = existing.reduce((m, i) => Math.max(m, Number(i.cut) || 0), 0) + 1;
      it.media = { fileUrl: m.fileUrl, mime: wsText(m.mime, 60), name: wsText(m.name, 200), size: Number(m.size) || null, duration: Number(m.duration) || null, w: Number(m.w) || null, h: Number(m.h) || null,
        ...(m.music && m.music.title ? { music: wsSong(m.music, true) } : {}) };
    } else if (kind === "note") {
      const d = await wsItem(env, body.draftId);
      if (d.projectId !== p.id || d.kind !== "draft") throw new HttpError(400, "That draft isn't part of this project.");
      if (!it.text) throw new HttpError(400, "Write the note first.");
      it.draftId = d.id;
      // null = a note on the whole cut rather than one moment
      it.t = body.t === null ? null : Math.max(0, Math.round((Number(body.t) || 0) * 10) / 10);
    }
    await wsSaveItem(env, it);
    // Ideas, comments, review notes and new drafts stay inside the project — no Team Chat line or phone alert.
    // The team is told about the big moments only (new project, sent for approval, decisions, filed, deleted).
    return json({ item: it });
  }

  if (path === "item/move") { // move an idea (with its comments and votes) to another project
    const it = await wsItem(env, body.id);
    if (it.kind !== "idea" && it.kind !== "link") throw new HttpError(400, "Only ideas can be moved.");
    const from = await wsProject(env, it.projectId), to = await wsProject(env, body.projectId);
    if (to.id === from.id) throw new HttpError(400, "It's already in this project.");
    if (me.role === "video" && it.author !== me.id) throw new HttpError(403, "Only the person who added it or the team can move it.");
    const comments = (await wsItems(env, from.id)).filter((c) => c.kind === "comment" && c.parentId === it.id);
    it.projectId = to.id; it.movedFrom = { projectId: from.id, title: from.title, by: me.id, at: now }; it.priority = it.priority || null;
    await wsSaveItem(env, it);
    for (const c of comments) { c.projectId = to.id; await wsSaveItem(env, c); }
    return json({ item: it, to: { id: to.id, title: to.title } });
  }

  if (path === "item/food") { // which dishes an idea shows (anyone on the project)
    const it = await wsUpdateItem(env, body.id, (it) => {
      if (it.kind !== "idea" && it.kind !== "link") throw new HttpError(400, "Only ideas can have dishes.");
      it.food = (Array.isArray(body.food) ? body.food : []).map((d) => wsText(d, 60)).filter(Boolean).slice(0, 12);
    });
    return json({ item: it });
  }

  if (path === "item/priority") { // anyone who votes can push an idea straight to the creator
    const it0 = await wsItem(env, body.id);
    const p = await wsProject(env, it0.projectId);
    if (it0.kind !== "link" && it0.kind !== "idea") throw new HttpError(400, "Only ideas and reels can be marked priority.");
    if (me.id === p.creatorId || me.role === "video") throw new HttpError(403, "The team marks priority — the creator films what's picked.");
    const it = await wsUpdateItem(env, body.id, (it) => { it.priority = body.on === false ? null : { by: me.id, at: now }; });
    return json({ item: it });
  }

  if (path === "item/vote" || path === "item/resolve" || path === "item/delete") {
    const it0 = await wsItem(env, body.id);
    const p = await wsProject(env, it0.projectId);
    if (path === "item/vote") {
      if (it0.kind !== "link" && it0.kind !== "idea") throw new HttpError(400, "Only ideas and reels take votes.");
      if (me.id === p.creatorId || me.role === "video") throw new HttpError(403, "The project's creator doesn't vote — the rest of the team decides.");
      const v = body.vote === "yes" || body.vote === "no" ? body.vote : null;
      const saved = await wsUpdateItem(env, body.id, (it) => {
        it.yes = (it.yes || []).filter((x) => x !== me.id);
        it.no = (it.no || []).filter((x) => x !== me.id);
        if (v) it[v].push(me.id);
      });
      return json({ item: saved });
    }
    const it = it0;
    if (path === "item/resolve") {
      if (it.kind === "note") it.resolved = body.resolved === false ? null : { by: me.id, at: now };
      else if (it.kind === "shot") it.done = body.resolved === false ? null : { by: me.id, at: now };
      else throw new HttpError(400, "Only notes and shots can be ticked off.");
    } else {
      if (it.author !== me.id && me.role !== "admin") throw new HttpError(403, "You can only delete what you added.");
      if (it.kind === "draft" && (it.submitted || it.approval || it.filed)) throw new HttpError(409, it.filed || it.approval ? "This draft is approved, so it's kept." : "This draft is waiting for approval — tap \"Take it back\" first, then delete it.");
      it.deleted = { by: me.id, at: now };
      if (it.kind === "draft") { // its pinned review notes go with it
        for (const n of await wsItems(env, it.projectId)) if (n.kind === "note" && n.draftId === it.id) await wsUpdateItem(env, n.id, (x) => { x.deleted = { by: me.id, at: now, withDraft: it.id }; });
      }
    }
    await wsSaveItem(env, it);
    return json({ item: it });
  }

  // Approval is per draft: the creator can send several drafts (different angles) and each is approved, sent back
  // or filed to the library on its own. The project stays open for more drafts.
  const wsDraftOf = async (p) => {
    const d = await wsItem(env, body.draftId);
    if (d.projectId !== p.id || d.kind !== "draft" || d.deleted) throw new HttpError(400, "Pick a draft from this project.");
    return d;
  };
  const summary = async (p) => json({ project: wsSummary(p, await wsItems(env, p.id), members) });

  if (path === "submit") { // the creator says a draft is ready → it waits for anyone else to approve it
    const p = await wsProject(env, body.projectId);
    const d0 = await wsDraftOf(p);
    const d = await wsUpdateItem(env, d0.id, (d) => {
      if (d.filed || d.approval) throw new HttpError(409, `Draft ${d.cut} is already approved.`);
      if (d.submitted) throw new HttpError(409, `Draft ${d.cut} is already waiting for approval.`);
      d.submitted = { by: me.id, at: now, cut: d.cut };
      delete d.changes;
    });
    await wsNotify(env, ctx, { actor: me, members, project: p, text: `🙋 ${me.name} sent draft ${d.cut} of "${p.title}" for content approval — open it in the Workspace to approve or ask for changes.`, push: { title: `Ready for approval: ${p.title}`, body: `${me.name} sent draft ${d.cut} for content approval` }, eventId: "ws_submit_" + d.id + "_" + Date.now() });
    return summary(p);
  }

  if (path === "withdraw") {
    const p = await wsProject(env, body.projectId);
    const d0 = await wsDraftOf(p);
    const d = await wsUpdateItem(env, d0.id, (d) => {
      if (!d.submitted || d.approval || d.filed) throw new HttpError(409, `Draft ${d.cut} isn't waiting for approval.`);
      if (d.submitted.by !== me.id && me.role !== "admin") throw new HttpError(403, "Only the person who sent it can take it back.");
      delete d.submitted;
    });
    await wsNotify(env, ctx, { actor: me, members, project: p, text: `↩️ ${me.name} took draft ${d.cut} of "${p.title}" back from approval`, push: { title: p.title, body: `${me.name} took draft ${d.cut} back from approval` } });
    return summary(p);
  }

  if (path === "review") { // any one teammate other than whoever uploaded the draft decides
    const p = await wsProject(env, body.projectId);
    const d0 = await wsDraftOf(p);
    if (d0.author === me.id) throw new HttpError(403, "Someone other than the person who uploaded this draft has to approve it.");
    if (me.role === "video") throw new HttpError(403, "Video Creators upload drafts — someone else on the team approves them.");
    const note = wsText(body.note, 2000);
    if (body.decision !== "approve" && body.decision !== "changes") throw new HttpError(400, "Choose approve or changes.");
    if (body.decision === "changes" && !note) throw new HttpError(400, "Say what needs to change.");
    const d = await wsUpdateItem(env, d0.id, (d) => {
      if (!d.submitted || d.approval || d.filed) throw new HttpError(409, `Draft ${d.cut} isn't waiting for approval any more.`);
      if (body.decision === "approve") d.approval = { by: me.id, at: now, note, cut: d.cut, draftId: d.id };
      else { delete d.submitted; d.changes = { by: me.id, at: now, note }; }
    });
    if (body.decision === "approve") {
      await wsNotify(env, ctx, { actor: me, members, project: p, text: `✅ ${me.name} approved draft ${d.cut} of "${p.title}". Next: confirm the file name so it can go to Google Drive.`, push: { title: `Approved: ${p.title}`, body: `${me.name} approved draft ${d.cut} — confirm the file name next` }, eventId: "ws_approve_" + d.id });
    } else {
      await wsSaveItem(env, { id: wsId("wi"), projectId: p.id, kind: "comment", author: me.id, createdAt: now, text: `Changes needed on draft ${d.cut}: ${note}`, decision: "changes", draftId: d.id });
      await wsNotify(env, ctx, { actor: me, members, project: p, text: `✏️ ${me.name} asked for changes on draft ${d.cut} of "${p.title}": ${note}`, push: { title: `Changes needed: ${p.title}`, body: `${me.name}: ${note}` }, eventId: "ws_changes_" + d.id + "_" + Date.now() });
    }
    return summary(p);
  }

  if (path === "unapprove") { // undo an approval before the file is saved
    const p = await wsProject(env, body.projectId);
    const d0 = await wsDraftOf(p);
    const d = await wsUpdateItem(env, d0.id, (d) => {
      if (!d.approval || d.filed) throw new HttpError(409, "There's no approval to undo.");
      if (d.filing && Date.now() - Date.parse(d.filing.at) < 5 * 60e3) throw new HttpError(409, "This video is being saved to Drive right now.");
      if (d.approval.by !== me.id && me.role !== "admin") throw new HttpError(403, "Only the person who approved it can undo that.");
      delete d.approval;
    });
    await wsNotify(env, ctx, { actor: me, members, project: p, text: `↩️ ${me.name} undid the approval of draft ${d.cut} of "${p.title}" — it's waiting for approval again`, push: { title: p.title, body: `${me.name} undid the approval of draft ${d.cut}` } });
    return summary(p);
  }

  if (path === "file") return json(await wsFile(env, request, ctx, body, me, members));

  throw new HttpError(404, "Unknown workspace request");
}

// Every barcode in use: the Content Library (live index, or the bundled snapshot) plus anything Workspace has filed.
async function wsUsedBarcodes(env, request) {
  let files = [];
  const obj = await env.MEDIA.get(LIBRARY_INDEX_KEY);
  if (obj) files = (await obj.json().catch(() => ({}))).files || [];
  else {
    const r = await env.ASSETS.fetch(new Request(new URL("/library.json", request ? request.url : env.PUBLIC_URL)));
    if (r.ok) files = (await r.json().catch(() => ({}))).files || [];
  }
  const used = new Set();
  for (const f of files) { const m = /_([A-Z]\d{3,4})(?:\.[^.]+)?$/.exec(f.name || ""); if (m) used.add(m[1]); }
  const { results } = await env.DB.prepare("SELECT data FROM ws_projects").all();
  for (const r of results || []) { const p = JSON.parse(r.data); const f = p.filed || p.legacyFiled; if (f && f.barcode) used.add(f.barcode); }
  const { results: dr } = await env.DB.prepare("SELECT json_extract(data, '$.filed.barcode') AS b FROM ws_items WHERE kind = 'draft' AND json_extract(data, '$.filed.barcode') IS NOT NULL").all();
  for (const r of dr || []) used.add(r.b);
  try { const { results: bc } = await env.DB.prepare("SELECT code FROM ws_barcodes").all(); for (const r of bc || []) used.add(r.code); } catch (e) { /* table not there yet */ }
  try {
    await ensureStorageTables(env);
    const { results: arch } = await env.DB.prepare("SELECT name FROM media_archive WHERE name IS NOT NULL").all();
    for (const a of arch || []) { const m = /_([A-Z]\d{3,4})\.[^.]+$/.exec(a.name || ""); if (m) used.add(m[1]); }
  } catch (e) { /* archive table not there yet */ }
  return used;
}
// Claim the next free barcode for this branch letter (S/A/V/G + 3 digits, 4 digits after 999).
async function claimBarcode(env, request, letter, kind, ref, used) {
  await ensureWsTables(env);
  used = used || await wsUsedBarcodes(env, request);
  for (let i = 0; i < 50; i++) {
    const code = wsNextBarcode(letter, used);
    const r = await env.DB.prepare("INSERT OR IGNORE INTO ws_barcodes (code, kind, ref, at) VALUES (?1, ?2, ?3, ?4)").bind(code, kind, ref, new Date().toISOString()).run();
    used.add(code);
    if (r.meta && r.meta.changes > 0) return code;
  }
  throw new HttpError(409, "Couldn't find a free barcode — try again.");
}
// Claim one particular barcode (the one in a confirmed file name). False if someone else already has it.
async function claimThisBarcode(env, code, kind, ref) {
  await ensureWsTables(env);
  const r = await env.DB.prepare("INSERT OR IGNORE INTO ws_barcodes (code, kind, ref, at) VALUES (?1, ?2, ?3, ?4)").bind(code, kind, ref, new Date().toISOString()).run();
  if (r.meta && r.meta.changes > 0) return true;
  const row = await env.DB.prepare("SELECT ref FROM ws_barcodes WHERE code = ?1").bind(code).first();
  return !!row && row.ref === ref;
}
function wsNextBarcode(letter, used) {
  let max = 0;
  for (const c of used) if (c[0] === letter) max = Math.max(max, Number(c.slice(1)));
  return letter + String(max + 1).padStart(3, "0");
}
const wsExtOf = (fileUrl) => ((/\.([a-z0-9]{2,5})$/i.exec(fileUrl || "") || [])[1] || "mp4").toLowerCase();
function londonDate(d = new Date()) {
  const parts = new Intl.DateTimeFormat("en-GB", { timeZone: "Europe/London", year: "numeric", month: "2-digit", day: "2-digit" }).formatToParts(d);
  const v = (t) => parts.find((x) => x.type === t).value;
  return v("year") + v("month") + v("day");
}

async function wsNameSuggestion(env, request, p, items, draftId) {
  const d = items.find((i) => i.kind === "draft" && i.approval && !i.filed && (!draftId || i.id === draftId));
  if (!d) throw new HttpError(409, "Approve the draft first.");
  const used = await wsUsedBarcodes(env, request);
  const branch = WS_BRANCHES[p.branch] || WS_BRANCHES.all;
  const parts = { date: londonDate(), social: "AL", category: p.category || "FC", dishes: p.dishes || [], stage: "FIN", version: "v" + d.cut,
    barcode: wsNextBarcode(branch.letter, used), ext: wsExtOf(d.media && d.media.fileUrl) };
  const ld = londonDate();
  const folder = ["Creator Studio Projects", branch.folder, "Videos", ld.slice(0, 4) + "-" + ld.slice(4, 6) + "_" + libSlug(p.title), "Final"];
  return { draftId: d.id, cut: d.cut, approval: d.approval, folder, parts, name: wsBuildName(parts), branchLetter: branch.letter, usedBarcodes: [...used].filter((c) => c[0] === branch.letter).length,
    codes: { social: WS_SOCIAL, categories: WS_CATEGORIES, dishes: WS_DISHES, stages: WS_STAGES } };
}
function wsBuildName(x) {
  return [x.date, x.social, x.category, ...(x.dishes || []), x.stage, x.version, x.barcode].join("_") + "." + x.ext;
}
// The same checks the pop-up shows, done again here so nothing badly named ever reaches Drive.
function wsCheckName(name, used, ext) {
  const m = WS_NAME_RE.exec(name || "");
  const problems = [];
  if (!m) return { ok: false, problems: ["The name doesn't follow DATE_SOCIAL_CATEGORY_[DISH]_STAGE_v#_BARCODE.ext"] };
  const [, date, social, category, dishPart, stage, , letter, num, fileExt] = m;
  const dt = new Date(Date.UTC(+date.slice(0, 4), +date.slice(4, 6) - 1, +date.slice(6, 8)));
  if (dt.getUTCFullYear() !== +date.slice(0, 4) || dt.getUTCMonth() + 1 !== +date.slice(4, 6) || dt.getUTCDate() !== +date.slice(6, 8)) problems.push("The date isn't a real YYYYMMDD date.");
  if (!WS_SOCIAL.includes(social)) problems.push(`${social} isn't a social media code (${WS_SOCIAL.join(", ")}).`);
  if (!WS_CATEGORIES[category]) problems.push(`${category} isn't a category code.`);
  for (const dish of dishPart.split("_").filter(Boolean)) if (!WS_DISHES[dish]) problems.push(`${dish} isn't a dish code in the rule book.`);
  if (!WS_STAGES.includes(stage)) problems.push(`${stage} isn't a stage (FIN, EDT or RAW).`);
  if (!"SAVG".includes(letter)) problems.push("The barcode starts with S, A, V or G.");
  if (used.has(letter + num)) problems.push(`Barcode ${letter + num} is already used in the Content Library.`);
  if (fileExt !== ext) problems.push(`The file is a .${ext}, so the name should end in .${ext}.`);
  return { ok: !problems.length, problems, barcode: letter + num };
}

// "Christmas Content!" → "Christmas-Content" (the library's folder style).
const libSlug = (t) => String(t || "Project").normalize("NFKD").replace(/[^\w\s-]/g, "").trim().replace(/[\s_]+/g, "-").replace(/-+/g, "-").slice(0, 60) || "Project";
async function wsDriveFolder(env, token, branchKey, sub = []) {
  const branch = WS_BRANCHES[branchKey] || WS_BRANCHES.all;
  const headers = { Authorization: "Bearer " + token, "Content-Type": "application/json" };
  const alive = async (id) => {
    if (!id) return false;
    const r = await fetch(`https://www.googleapis.com/drive/v3/files/${id}?fields=id,trashed`, { headers: { Authorization: "Bearer " + token } });
    const d = await r.json().catch(() => ({}));
    return r.ok && !d.trashed;
  };
  const make = async (name, parent, description) => {
    const r = await fetch("https://www.googleapis.com/drive/v3/files?fields=id", { method: "POST", headers,
      body: JSON.stringify({ name, mimeType: DRIVE_FOLDER, description, ...(parent ? { parents: [parent] } : {}) }) });
    const d = await r.json().catch(() => ({}));
    if (!r.ok || !d.id) throw new HttpError(502, `Couldn't create the "${name}" folder in Drive: ` + ((d.error && d.error.message) || r.status));
    return d.id;
  };
  const saved = (await kvGet(env, "ws_drive_folder")) || {};
  if (!(await alive(saved.id))) {
    saved.id = await make("Creator Studio Projects", null, "Finished videos approved in Creator Studio's Workspace, named with the SANJUGO filing system. Managed by Sanjugo Creator Studio — part of the Content Library.");
    saved.branches = {};
  }
  saved.branches = saved.branches || {};
  if (!(await alive(saved.branches[branchKey]))) saved.branches[branchKey] = await make(branch.folder, saved.id, "");
  const cache = { folders: saved.folders || {} };
  let folderId = saved.branches[branchKey];
  for (const name of sub) folderId = await rawSubfolder(env, token, folderId, name, cache);
  saved.folders = cache.folders;
  await kvSet(env, "ws_drive_folder", saved);
  return { rootId: saved.id, folderId, branch, path: sub };
}

async function wsFile(env, request, ctx, body, me, members) {
  const p = await wsProject(env, body.projectId);
  const d = await wsItem(env, body.draftId);
  if (d.projectId !== p.id || d.kind !== "draft" || d.deleted) throw new HttpError(400, "Pick a draft from this project.");
  if (d.filed) return { project: wsSummary(p, await wsItems(env, p.id), members) };
  if (!d.approval) throw new HttpError(409, "Approve the draft first.");
  if (d.filing && Date.now() - Date.parse(d.filing.at) < 5 * 60e3) throw new HttpError(409, "This video is already being saved to Drive — give it a minute.");
  const key = mediaKeyOf(d.media && d.media.fileUrl);
  const obj = key && await env.MEDIA.head(key);
  if (!obj) throw new HttpError(410, "The approved video file is missing from storage — upload the draft again.");
  const used = await wsUsedBarcodes(env, request);
  const name = wsText(body.name, 200);
  const check = wsCheckName(name, used, wsExtOf(d.media.fileUrl));
  if (!check.ok) throw new HttpError(400, check.problems.join(" "));

  const auth = serviceAccount(env) ? null : await getGoogleAuth(env);
  if (!auth || !(auth.scopes || "").includes("drive.file")) throw new HttpError(409, "Creator Studio can't save to Google Drive yet — an admin needs to reconnect Google Drive in Settings.");
  // Claim the draft (and the barcode) so two people saving at once can't both write it.
  await wsUpdateItem(env, d.id, (x) => {
    if (x.filed) throw new HttpError(409, "This draft is already in the Content Library.");
    if (x.filing && Date.now() - Date.parse(x.filing.at) < 5 * 60e3) throw new HttpError(409, "This video is already being saved to Drive — give it a minute.");
    x.filing = { at: new Date().toISOString(), by: me.id, barcode: check.barcode };
  });
  if (!(await claimThisBarcode(env, check.barcode, "workspace", d.id))) { await wsUpdateItem(env, d.id, (x) => { delete x.filing; }); throw new HttpError(409, `Barcode ${check.barcode} was just given to another file — pick the next number.`); }
  let filed;
  try {
    const token = await getGoogleToken(env);
    // Same layout as the rest of the Content Library: <Branch> / Videos / YYYY-MM_Project-Name / Final
    const shoot = londonDate().slice(0, 4) + "-" + londonDate().slice(4, 6) + "_" + libSlug(p.title);
    const { rootId, folderId, branch, path } = await wsDriveFolder(env, token, p.branch, ["Videos", shoot, "Final"]);
    const approver = (members.find((m) => m.id === d.approval.by) || {}).name || "the team";
    const creator = (members.find((m) => m.id === d.author) || {}).name || "the creator";
    const song = d.media && d.media.music;
    const description = `Workspace project: ${p.title}. Filmed by ${creator}, draft ${d.cut}, approved by ${approver} on ${d.approval.at.slice(0, 10)}.` + (song ? ` Music: ${song.credit || song.title + " by " + song.artist} (mixed in).` : "") + (p.brief ? " Brief: " + p.brief.slice(0, 400) : "");
    const driveId = await driveUploadFromR2(env, token, key, name, folderId, description);
    filed = { driveId, name, barcode: check.barcode, by: me.id, at: new Date().toISOString(), folderId, rootId, folderPath: ["Creator Studio Projects", branch.folder, ...path], draftId: d.id, cut: d.cut, ...(song ? { music: song } : {}) };
    await wsUpdateItem(env, d.id, (x) => { x.filed = filed; delete x.filing; });
    await wsSaveProject(env, p); // bumps the project's "updated" time
    await wsAddToLibraryIndex(env, request, { id: driveId, name, mime: obj.httpMetadata && obj.httpMetadata.contentType || d.media.mime, size: obj.size, branch: branch.folder, path, modified: filed.at, note: description });
  } catch (e) {
    await wsUpdateItem(env, d.id, (x) => { delete x.filing; }).catch(() => {});
    if (!filed) await env.DB.prepare("DELETE FROM ws_barcodes WHERE code = ?1 AND ref = ?2").bind(check.barcode, d.id).run().catch(() => {});
    throw e;
  }
  await wsNotify(env, ctx, { actor: me, members, project: p, text: `📚 Draft ${d.cut} of "${p.title}" is in the Content Library as ${name} (barcode ${check.barcode}). Use "Create post from this" in the Workspace when you want to publish it.`, push: { title: `In the library: ${p.title}`, body: `Draft ${d.cut} saved to Drive as ${check.barcode}` }, eventId: "ws_filed_" + d.id });
  return { project: wsSummary(p, await wsItems(env, p.id), members) };
}

async function driveUploadFromR2(env, token, key, name, parentId, description) {
  const obj = await env.MEDIA.get(key);
  if (!obj) throw new HttpError(410, "The video file is missing from storage.");
  const type = (obj.httpMetadata && obj.httpMetadata.contentType) || "application/octet-stream";
  const init = await fetch("https://www.googleapis.com/upload/drive/v3/files?uploadType=resumable&fields=id", {
    method: "POST",
    headers: { Authorization: "Bearer " + token, "Content-Type": "application/json; charset=UTF-8", "X-Upload-Content-Type": type, "X-Upload-Content-Length": String(obj.size) },
    body: JSON.stringify({ name, parents: [parentId], description }),
  });
  const session = init.headers.get("location");
  if (!init.ok || !session) { obj.body.cancel(); throw new HttpError(502, "Google Drive upload couldn't start (" + init.status + ")"); }
  const { readable, writable } = new FixedLengthStream(obj.size);
  const pump = obj.body.pipeTo(writable);
  const up = await fetch(session, { method: "PUT", headers: { "Content-Type": type }, body: readable });
  await pump;
  const res = await up.json().catch(() => ({}));
  if (!up.ok || !res.id) throw new HttpError(502, "Google Drive upload failed (" + up.status + ")");
  return res.id;
}

// Add the new file to the library list straight away (the next full refresh finds it in Drive too).
async function libraryIndexRemove(env, id) {
  const obj = await env.MEDIA.get(LIBRARY_INDEX_KEY);
  if (!obj) return;
  const data = await obj.json().catch(() => null);
  if (!data || !Array.isArray(data.files)) return;
  data.files = data.files.filter((f) => f.id !== id);
  await env.MEDIA.put(LIBRARY_INDEX_KEY, JSON.stringify(data), { httpMetadata: { contentType: "application/json" }, customMetadata: { updatedAt: data.updatedAt || new Date().toISOString() } });
}

async function wsAddToLibraryIndex(env, request, file) {
  let data = null;
  const obj = await env.MEDIA.get(LIBRARY_INDEX_KEY);
  if (obj) data = await obj.json().catch(() => null);
  if (!data) {
    const r = await env.ASSETS.fetch(new Request(new URL("/library.json", request ? request.url : env.PUBLIC_URL)));
    data = r.ok ? await r.json().catch(() => null) : null;
  }
  if (!data || !Array.isArray(data.files)) data = { source: "live", files: [] };
  data.files = [file, ...data.files.filter((f) => f.id !== file.id)];
  const updatedAt = data.updatedAt || new Date().toISOString();
  await env.MEDIA.put(LIBRARY_INDEX_KEY, JSON.stringify(data), { httpMetadata: { contentType: "application/json" }, customMetadata: { updatedAt } });
}

// ---------------------------------------------------------------------------
// Sticky notes on the Dashboard — private to each person (only the signed-in member's own notes are ever
// returned). Kept as one small list per person in app_kv.
// ---------------------------------------------------------------------------

async function notesRoute(request, env, url, viewer) {
  const body = request.method === "POST" ? await request.json().catch(() => ({})) : {};
  const id = viewer.accessEnabled ? viewer.member && viewer.member.id : String(url.searchParams.get("userId") || body.userId || "");
  if (!/^[\w-]{1,64}$/.test(id || "")) throw new HttpError(403, "Sign in to use notes.");
  const key = "notes_" + id;
  if (request.method === "GET") return json({ notes: (await kvGet(env, key)) || [] });
  if (request.method !== "POST") throw new HttpError(405, "Method not allowed");
  const notes = (Array.isArray(body.notes) ? body.notes : []).slice(0, 30).map((n) => ({
    id: String(n.id || "").slice(0, 40) || "n_" + crypto.randomUUID().slice(0, 8),
    text: String(n.text || "").slice(0, 4000),
    color: ["yellow", "pink", "blue", "green"].includes(n.color) ? n.color : "yellow",
    updatedAt: String(n.updatedAt || new Date().toISOString()).slice(0, 30),
  }));
  await kvSet(env, key, notes);
  return json({ notes });
}

// ---------------------------------------------------------------------------
// Published Content study — tags (collab, promotion, content type, branch, dish), team notes and an AI
// "why it worked" for each live post, plus influencer posts added by hand (their stats can't be read by API).
// Keyed by "platform:postId" for pulled posts, "manual:<id>" for hand-added ones.
// ---------------------------------------------------------------------------

let studyReady = false;
async function ensureStudy(env) {
  if (studyReady) return;
  await env.DB.prepare("CREATE TABLE IF NOT EXISTS study_posts (key TEXT PRIMARY KEY, data TEXT NOT NULL, updated_at TEXT NOT NULL)").run();
  studyReady = true;
}
const STUDY_TAGS = ["collab", "promo", "type", "branch", "dish", "cost"];
async function studyGet(env, key) {
  const r = await env.DB.prepare("SELECT data FROM study_posts WHERE key = ?1").bind(key).first();
  return r ? JSON.parse(r.data) : { key };
}
async function studyPut(env, d) {
  d.updatedAt = new Date().toISOString();
  await env.DB.prepare("INSERT INTO study_posts (key, data, updated_at) VALUES (?1, ?2, ?3) ON CONFLICT(key) DO UPDATE SET data = excluded.data, updated_at = excluded.updated_at")
    .bind(d.key, JSON.stringify(d), d.updatedAt).run();
  return d;
}
const studyNum = (v) => Math.max(0, Math.min(1e10, Math.round(Number(v) || 0)));

// ---------------------------------------------------------------------------
// Collab numbers by link. Instagram's API only lists posts our own account owns, so a collab posted by an
// influencer is read through "business discovery": Make's "Lookup · Instagram collab" scenario lists that
// account's recent public posts (likes, comments, views) and posts them back here; we pick out the one whose
// link matches. Works for Business and Creator accounts (most influencers); personal accounts stay manual.
// The webhook address is saved in app_kv "collab_lookup_hook". Numbers refresh every night.
// ---------------------------------------------------------------------------
const COLLAB_HOOK_KEY = "collab_lookup_hook";
const igShortcode = (u) => { const m = /instagram\.com\/(?:[\w.]+\/)?(?:p|reels?|tv)\/([\w-]{5,})/i.exec(String(u || "")); return m ? m[1] : null; };
function collabHandles(text) {
  const out = [];
  for (const raw of String(text || "").split(/[\s,;]+|(?=@)/)) {
    const h = raw.replace(/^@+/, "").replace(/\.+$/, "").toLowerCase();
    if (/^[a-z0-9._]{2,30}$/.test(h) && !out.includes(h)) out.push(h);
  }
  return out.slice(0, 4);
}

async function startCollabLookup(env, entries, by) {
  const hook = await kvGet(env, COLLAB_HOOK_KEY);
  if (!hook || !MAKE_HOOK_RE.test(hook)) throw new HttpError(400, "The collab lookup isn't set up in Make yet — enter the numbers by hand for now.");
  await ensureMakeTables(env);
  // One Make run per account, carrying every post we want from that account.
  const byHandle = new Map();
  const now = new Date().toISOString();
  for (const d of entries) {
    const m = d.manual || {};
    const code = igShortcode(m.url);
    const handles = m.fetch && m.fetch.owner ? [m.fetch.owner] : collabHandles(m.account);
    if (!code || !handles.length) {
      m.fetch = { status: "error", at: now, error: !code ? "That doesn't look like an Instagram post link." : "Add the influencer's @handle so we know whose posts to look in." };
      await studyPut(env, d);
      continue;
    }
    m.fetch = { ...(m.fetch || {}), status: "pending", at: now, asked: handles, missed: [], error: null };
    await studyPut(env, d);
    for (const h of handles) { if (!byHandle.has(h)) byHandle.set(h, []); byHandle.get(h).push({ key: d.key, code }); }
  }
  let sent = 0;
  for (const [handle, items] of byHandle) {
    const id = "job_" + crypto.randomUUID().slice(0, 12), token = crypto.randomUUID().replace(/-/g, "");
    await env.DB.prepare("INSERT INTO make_jobs (id, kind, platform, token, status, requested_by, trigger, detail, created_at, updated_at) VALUES (?1, 'collab', 'instagram', ?2, 'sent', ?3, ?4, ?5, ?6, ?6)")
      .bind(id, token, by || null, by ? "manual" : "nightly", JSON.stringify({ handle, items }), now).run();
    try { await callHook(hook, { token, username: handle }); sent++; }
    catch (e) {
      await env.DB.prepare("UPDATE make_jobs SET status = 'failed', error = ?2 WHERE id = ?1").bind(id, e.message).run();
      for (const it of items) await collabMiss(env, it.key, handle, "Make didn't take the request — check the \"Lookup · Instagram collab\" scenario is switched on.");
    }
  }
  return { sent, accounts: [...byHandle.keys()] };
}

async function collabMiss(env, key, handle, error) {
  const d = await studyGet(env, key);
  const f = d.manual && d.manual.fetch;
  if (!f || f.status !== "pending") return;
  f.missed = [...new Set([...(f.missed || []), handle])];
  if (f.missed.length >= (f.asked || []).length) {
    f.status = "notfound";
    f.error = error || `This post isn't in ${f.missed.map((h) => "@" + h).join(" or ")}'s latest 60 posts. Use the account that posted it (the first name at the top of the post — not a collaborator), or type the numbers in.`;
  }
  await studyPut(env, d);
}

async function collabCallback(env, job, body) {
  let detail = {};
  try { detail = JSON.parse(job.detail || "{}"); } catch (e) {}
  const handle = detail.handle || "";
  const posts = Array.isArray(body.posts) ? body.posts : [];
  const now = new Date().toISOString();
  let found = 0;
  for (const it of detail.items || []) {
    const p = posts.find((x) => x && igShortcode(x.permalink) === it.code);
    if (!p) { await collabMiss(env, it.key, handle, posts.length ? null : `Instagram won't share @${handle}'s posts. It's probably a personal account (only Business and Creator accounts can be read), or the name is spelt differently. Check the name at the top of the post, or type the numbers in.`); continue; }
    const d = await studyGet(env, it.key);
    if (!d.manual) continue;
    const m = d.manual;
    m.views = studyNum(p.views) || m.views; m.likes = studyNum(p.likes); m.comments = studyNum(p.comments);
    if (!m.caption) m.caption = dec(p.caption).slice(0, 3000);
    const at = toIsoDate(p.at); if (at) m.publishedAt = at;
    if (/^IMAGE|CAROUSEL/i.test(String(p.mediaType || "")) && p.thumb) m.thumb = dec(p.thumb).slice(0, 1000);
    m.fetch = { status: "ok", at: now, owner: handle, asked: m.fetch && m.fetch.asked, missed: [] };
    await studyPut(env, d);
    found++;
  }
  // Keep what Instagram returned (post code + date) so a "not found" can be checked later.
  detail.seen = posts.slice(0, 80).map((x) => [igShortcode(x && x.permalink), String((x && x.at) || "").slice(0, 10)]);
  await env.DB.prepare("UPDATE make_jobs SET status = ?2, error = ?3, updated_at = ?4, detail = ?5 WHERE id = ?1")
    .bind(job.id, found ? "done" : "failed", found ? null : "post not found for @" + handle, now, JSON.stringify(detail)).run();
  return { ok: true, found, seen: posts.length };
}

// Nightly: refresh every Instagram collab added by link (one Make run per account).
async function refreshCollabs(env) {
  if (!(await kvGet(env, COLLAB_HOOK_KEY))) return;
  await ensureStudy(env);
  const { results } = await env.DB.prepare("SELECT data FROM study_posts").all();
  const list = (results || []).map((r) => JSON.parse(r.data)).filter((d) => !d.deleted && d.manual && d.manual.platform === "instagram" && igShortcode(d.manual.url)
    && collabHandles(d.manual.account).length && Date.now() - Date.parse(d.manual.publishedAt || 0) < 120 * 86400e3);
  if (list.length) await startCollabLookup(env, list.slice(0, 40), null);
}

async function studyRoute(request, env, url, viewer) {
  await ensureStudy(env);
  const path = url.pathname.replace(/^\/api\/study\/?/, "");
  if (request.method === "GET" && path === "") {
    const { results } = await env.DB.prepare("SELECT data FROM study_posts").all();
    return json({ entries: (results || []).map((r) => JSON.parse(r.data)).filter((d) => !d.deleted) });
  }
  if (request.method !== "POST") throw new HttpError(405, "Method not allowed");
  const body = await request.json().catch(() => ({}));
  const { members } = await listTeam(env);
  const meId = viewer.accessEnabled ? viewer.member && viewer.member.id : String(body.userId || "");
  const me = members.find((m) => m.id === meId && m.active !== false);
  if (!me) throw new HttpError(403, "Sign in first.");
  const key = String(body.key || "").slice(0, 120);

  if (path === "tags") {
    if (!/^[\w-]+:[\w.-]+$/.test(key)) throw new HttpError(400, "Unknown post");
    const d = await studyGet(env, key);
    d.tags = { ...(d.tags || {}) };
    for (const t of STUDY_TAGS) if (body.tags && t in body.tags) {
      const v = String(body.tags[t] == null ? "" : body.tags[t]).trim().slice(0, 80);
      if (v) d.tags[t] = v; else d.tags[t] = "-"; // "-" = cleared on purpose, so the automatic guess doesn't come back
    }
    return json({ entry: await studyPut(env, d) });
  }
  if (path === "note") {
    const text = String(body.text || "").trim().slice(0, 2000);
    if (!text) throw new HttpError(400, "Write the note first.");
    const d = await studyGet(env, key);
    d.notes = [...(d.notes || []), { id: "sn_" + crypto.randomUUID().slice(0, 8), by: me.id, text, at: new Date().toISOString() }];
    return json({ entry: await studyPut(env, d) });
  }
  if (path === "manual") { // add or edit an influencer post entered by hand
    const m = body.manual || {};
    const link = String(m.url || "").trim().slice(0, 500);
    if (!/^https:\/\/\S+$/.test(link)) throw new HttpError(400, "Paste the post's link (https://…).");
    const k = key && key.startsWith("manual:") ? key : "manual:" + crypto.randomUUID().slice(0, 10);
    const d = await studyGet(env, k);
    const when = Date.parse(m.publishedAt || "");
    d.manual = {
      platform: ["instagram", "tiktok", "facebook", "youtube"].includes(m.platform) ? m.platform : "instagram",
      url: link, account: String(m.account || "").trim().replace(/^@?/, "@").slice(0, 60),
      caption: String(m.caption || "").slice(0, 3000), publishedAt: isNaN(when) ? new Date().toISOString() : new Date(when).toISOString(),
      views: studyNum(m.views), likes: studyNum(m.likes), comments: studyNum(m.comments), shares: studyNum(m.shares), saves: studyNum(m.saves),
      addedBy: (d.manual && d.manual.addedBy) || me.id,
      thumb: (d.manual && d.manual.thumb) || "", fetch: (d.manual && d.manual.fetch) || null,
    };
    // Several accounts can share one collab ("@invited.app @daniafgx"); keep them all, tidy.
    const handles = collabHandles(m.account);
    if (handles.length) d.manual.account = handles.map((h) => "@" + h).join(" ");
    d.tags = { ...(d.tags || {}), ...(handles.length ? { collab: d.manual.account } : {}) };
    if (m.cost !== undefined) { const c = String(m.cost || "").replace(/[^\d.]/g, "").slice(0, 10); d.tags.cost = c || "-"; }
    let lookup = null;
    if (m.fetch && d.manual.platform === "instagram") {
      lookup = await startCollabLookup(env, [d], me.id).catch((e) => ({ error: e.message }));
      if (lookup && lookup.error) d.manual.fetch = { status: "error", error: lookup.error, at: new Date().toISOString() };
    }
    return json({ entry: await studyPut(env, d), lookup });
  }
  if (path === "fetch") { // refresh an Instagram collab's numbers from Instagram
    const d = await studyGet(env, key);
    if (!d.manual) throw new HttpError(400, "Only collab posts added by link can be refreshed.");
    const r = await startCollabLookup(env, [d], me.id);
    return json({ entry: await studyGet(env, key), lookup: r });
  }
  if (path === "hide") { // our own posts can't be deleted from Instagram here, but can be hidden from this page
    if (!/^[\w-]+:[\w.-]+$/.test(key) || key.startsWith("manual:")) throw new HttpError(400, "Unknown post");
    const d = await studyGet(env, key);
    d.hidden = body.hidden === false ? null : { by: me.id, at: new Date().toISOString() };
    return json({ entry: await studyPut(env, d) });
  }
  if (path === "delete") {
    if (!key.startsWith("manual:")) throw new HttpError(400, "Only posts added by hand can be removed.");
    const d = await studyGet(env, key);
    d.deleted = { by: me.id, at: new Date().toISOString() };
    await studyPut(env, d);
    return json({ ok: true });
  }
  if (path === "why") return json({ entry: await studyWhy(env, key, body.post || {}) });
  throw new HttpError(404, "Unknown request");
}

// ---- Campaigns: plans, budget, costs, influencers and monthly sales / email reports ----
// One small table of JSON documents. Everyone signed in can read; only admins can change anything.
const CAMP_KINDS = ["campaign", "budget", "cost", "influencer", "report", "menu"];
async function ensureCampTable(env) {
  await env.DB.prepare("CREATE TABLE IF NOT EXISTS camp_docs (id TEXT PRIMARY KEY, kind TEXT NOT NULL, data TEXT NOT NULL, updated_at TEXT NOT NULL)").run();
}
const CAMP_REPORT_SYSTEM = `You read monthly reports for SANJUGO, a Japanese restaurant group in London (branches: Shoreditch, Angel, Victoria). The text comes from a file exported from a POS system, Deliveroo, Uber Eats or SevenRooms (email marketing). Reply with ONLY one JSON object, no other text, in this shape (leave out anything the report doesn't contain; numbers as plain numbers, money in pounds):
{"month":"YYYY-MM","totalSales":0,"orders":0,"items":[{"name":"","qty":0,"sales":0}],"codes":[{"code":"","count":0,"discount":0}],"branches":[{"name":"","sales":0,"orders":0}],"emails":[{"name":"","subject":"","branch":"","date":"YYYY-MM-DD","sent":0,"opens":0,"openRate":0,"clicks":0,"clickRate":0,"bookings":0,"covers":0,"revenue":0,"unsubscribed":0,"bounced":0,"complaints":0}],"notes":""}
Rates are percentages (41.2 means 41.2%). For SevenRooms, "bookings" is the Reservations column and "sent" is Recipients; use the date the email was sent. List at most 40 items (best sellers first) and every promo code and email you can find. Never invent numbers that aren't in the text.`;
const CAMP_REVIEW_SYSTEM = `You are the marketing analyst for SANJUGO, a modern Japanese restaurant group in London (Shoreditch, Angel, Victoria). You get one campaign's facts: dates, budget and spend, what it sold (from monthly POS / delivery reports, before vs during vs after), influencer views and costs, email results, social post numbers and the team's own notes. Write a short review in plain words for the team. Use exactly these three headings, each followed by 2-4 bullet points starting with "- ":
What worked
What didn't
Next time
Be specific and use the numbers. Point out costs per result. Never invent numbers that aren't in the facts; if something is missing, say what to track next time.`;
async function aiText(env, system, user, maxTokens) {
  if (env.ANTHROPIC_API_KEY) {
    const client = new Anthropic({ apiKey: env.ANTHROPIC_API_KEY });
    const msg = await client.messages.create({ model: "claude-opus-5", max_tokens: maxTokens, system, messages: [{ role: "user", content: wellFormed(user) }] });
    return msg.content.filter((b) => b.type === "text").map((b) => b.text).join("");
  }
  const out = await env.AI.run(WORKERS_AI_MODEL, { messages: [{ role: "system", content: system }, { role: "user", content: wellFormed(user) }], max_tokens: maxTokens, temperature: 0.1 });
  const r = out && (out.response ?? out.result?.response);
  return typeof r === "string" ? r : JSON.stringify(r || "");
}
async function campRoute(request, env, url, viewer) {
  await ensureCampTable(env);
  const path = url.pathname.replace(/^\/api\/camp\/?/, "");
  if (viewer.accessEnabled && !viewer.member) throw new HttpError(401, "Sign in first.");
  if (request.method === "GET" && path === "") {
    const { results } = await env.DB.prepare("SELECT data FROM camp_docs").all();
    return json({ docs: (results || []).map((r) => JSON.parse(r.data)) });
  }
  if (request.method !== "POST") throw new HttpError(405, "Method not allowed");
  if (viewer.accessEnabled && viewer.member.role !== "admin") throw new HttpError(403, "Only admins can change campaigns.");
  const body = await request.json().catch(() => ({}));
  const by = viewer.member ? viewer.member.id : String(body.userId || "").slice(0, 64) || null;
  if (path === "save") {
    const doc = body.doc || {};
    if (!CAMP_KINDS.includes(doc.kind)) throw new HttpError(400, "Unknown kind");
    const id = /^[\w-]{3,80}$/.test(String(doc.id || "")) ? String(doc.id) : doc.kind + "_" + crypto.randomUUID().slice(0, 12);
    const out = { ...doc, id, updatedAt: new Date().toISOString(), updatedBy: by };
    const data = JSON.stringify(out);
    if (data.length > 400000) throw new HttpError(413, "That's too much to save in one go.");
    await env.DB.prepare("INSERT INTO camp_docs (id, kind, data, updated_at) VALUES (?1, ?2, ?3, ?4) ON CONFLICT(id) DO UPDATE SET kind = excluded.kind, data = excluded.data, updated_at = excluded.updated_at")
      .bind(id, doc.kind, data, out.updatedAt).run();
    return json({ doc: out });
  }
  if (path === "delete") {
    await env.DB.prepare("DELETE FROM camp_docs WHERE id = ?1").bind(String(body.id || "")).run();
    return json({ ok: true });
  }
  if (path === "summary") { // AI review of a finished campaign, from the numbers the page already has
    const facts = String(body.facts || "").slice(0, 8000);
    if (facts.length < 20) throw new HttpError(400, "Not enough numbers to review yet.");
    const text = tidyBotText(String(await aiText(env, CAMP_REVIEW_SYSTEM, facts, 700)).trim()).slice(0, 2500);
    if (!text) throw new HttpError(502, "Couldn't get a review — try again.");
    return json({ text });
  }
  if (path === "read-report") { // AI turns the report's text into numbers; the admin checks them before saving
    const source = ["pos", "deliveroo", "ubereats", "sevenrooms"].includes(body.source) ? body.source : "pos";
    const text = String(body.text || "").slice(0, 24000);
    if (text.trim().length < 20) throw new HttpError(400, "Couldn't find any text in that file.");
    const raw = await aiText(env, CAMP_REPORT_SYSTEM, `Source: ${source}\nFile: ${String(body.fileName || "").slice(0, 120)}\nMonth picked by the user: ${String(body.month || "").slice(0, 7)}\n\n${text}`, 3000);
    const m = String(raw).match(/\{[\s\S]*\}/);
    let summary = null;
    try { summary = m ? JSON.parse(m[0]) : null; } catch (e) {}
    if (!summary) throw new HttpError(502, "Couldn't read numbers from that report — try the CSV or Excel version.");
    return json({ summary });
  }
  throw new HttpError(404, "Unknown request");
}

const STUDY_WHY_SYSTEM = `You are the social media analyst for SANJUGO, a modern Japanese restaurant group in London (Shoreditch, Angel, Victoria). You get one published post with its numbers, its caption and how it compares with the account's usual results. Explain in plain words why it did well or badly, so the team can repeat or avoid it. Reply with 3 to 5 short bullet points starting with "- ", no intro, no headings. Be specific to this post: the hook (first line), the offer or promotion, the collaborator, the timing (day and time), caption length, and the numbers versus usual. Don't invent anything that isn't in the data.`;

async function studyWhy(env, key, post) {
  if (!/^[\w-]+:[\w.-]+$/.test(key)) throw new HttpError(400, "Unknown post");
  const lines = [
    `Platform: ${String(post.platform || "").slice(0, 20)} · type: ${String(post.type || "post").slice(0, 20)}`,
    `Posted: ${String(post.when || "").slice(0, 60)}`,
    `Views ${studyNum(post.views)}, likes ${studyNum(post.likes)}, comments ${studyNum(post.comments)}, shares ${studyNum(post.shares)}, saves ${studyNum(post.saves)}, engagement ${Number(post.engagement || 0).toFixed(1)}%.`,
    `Usual for this platform (median of recent posts): ${studyNum(post.usualViews)} views, ${Number(post.usualEngagement || 0).toFixed(1)}% engagement.`,
    post.tags ? `Tags: ${String(post.tags).slice(0, 300)}` : "",
    `Caption:\n${String(post.caption || "(no caption)").slice(0, 2000)}`,
  ].filter(Boolean).join("\n");
  let text = "";
  if (env.ANTHROPIC_API_KEY) {
    const client = new Anthropic({ apiKey: env.ANTHROPIC_API_KEY });
    const msg = await client.messages.create({ model: "claude-opus-5", max_tokens: 800, system: STUDY_WHY_SYSTEM, messages: [{ role: "user", content: wellFormed(lines) }] });
    text = msg.content.filter((b) => b.type === "text").map((b) => b.text).join("");
  } else {
    const out = await env.AI.run(WORKERS_AI_MODEL, { messages: [{ role: "system", content: STUDY_WHY_SYSTEM }, { role: "user", content: wellFormed(lines) }], max_tokens: 400, temperature: 0.3 });
    const r = out && (out.response ?? out.result?.response);
    text = typeof r === "string" ? r : JSON.stringify(r || "");
  }
  text = tidyBotText(String(text).trim()).slice(0, 1500);
  if (!text) throw new HttpError(502, "Couldn't get an answer — try again.");
  const d = await studyGet(env, key);
  d.why = { text, at: new Date().toISOString() };
  return await studyPut(env, d);
}

// Reactions (one of each emoji per person, tap again to take it back) and pins.
const CHAT_REACTIONS = ["👍", "✅", "👀", "❤️", "😂", "🔥"];
async function chatUpdate(request, env, url, viewer) {
  const body = await request.json().catch(() => ({}));
  await ensureChatTable(env);
  const who = viewer.accessEnabled ? viewer.member && viewer.member.id : String(body.author || "").slice(0, 64);
  if (!who) throw new HttpError(403, "Sign in first.");
  const row = await env.DB.prepare("SELECT * FROM chat_messages WHERE id = ?1").bind(Number(body.id) || 0).first();
  if (!row) throw new HttpError(404, "That message is gone.");
  const now = new Date().toISOString();
  if (url.pathname.endsWith("/react")) {
    if (!CHAT_REACTIONS.includes(body.emoji)) throw new HttpError(400, "Unknown reaction");
    let r = {}; try { r = JSON.parse(row.reactions || "{}"); } catch (e) {}
    const list = r[body.emoji] || [];
    r[body.emoji] = list.includes(who) ? list.filter((x) => x !== who) : [...list, who];
    if (!r[body.emoji].length) delete r[body.emoji];
    await env.DB.prepare("UPDATE chat_messages SET reactions = ?2, updated_at = ?3 WHERE id = ?1").bind(row.id, JSON.stringify(r), now).run();
  } else {
    const pin = body.pinned !== false;
    await env.DB.prepare("UPDATE chat_messages SET pinned_at = ?2, pinned_by = ?3, updated_at = ?4 WHERE id = ?1").bind(row.id, pin ? now : null, pin ? who : null, now).run();
  }
  return rowToMessage(await env.DB.prepare("SELECT * FROM chat_messages WHERE id = ?1").bind(row.id).first());
}

// ---------------------------------------------------------------------------
// Occasions for the calendar: official UK bank holidays (gov.uk, England and Wales — refreshed weekly) plus the
// team's "Done" / "Not for us" answers to the Dashboard reminders (shared, so one person answering is enough).
// The food and marketing dates themselves (Halloween, Christmas, Lunar New Year…) are worked out in the app.
// ---------------------------------------------------------------------------

async function occasionsRoute(request, env, url, viewer) {
  if (request.method === "GET") {
    let bank = await kvGet(env, "uk_bank_holidays");
    if (!bank || Date.now() - Date.parse(bank.fetchedAt || 0) > 7 * 86400e3) {
      try {
        const r = await fetch("https://www.gov.uk/bank-holidays.json", { headers: { Accept: "application/json" } });
        const d = await r.json();
        const events = ((d["england-and-wales"] || {}).events || []).map((e) => ({ date: e.date, title: e.title }));
        if (events.length) { bank = { fetchedAt: new Date().toISOString(), events }; await kvSet(env, "uk_bank_holidays", bank); }
      } catch (e) { /* keep the last copy */ }
    }
    return json({ bank: (bank && bank.events) || [], status: (await kvGet(env, "occasion_status")) || {} });
  }
  if (request.method !== "POST") throw new HttpError(405, "Method not allowed");
  const body = await request.json().catch(() => ({}));
  const who = viewer.accessEnabled ? viewer.member && viewer.member.id : String(body.userId || "").slice(0, 64);
  if (!who) throw new HttpError(403, "Sign in first.");
  const id = String(body.id || "");
  if (!/^[a-z0-9-]+-\d{4}$/.test(id)) throw new HttpError(400, "Unknown occasion");
  const status = (await kvGet(env, "occasion_status")) || {};
  if (body.status === "done" || body.status === "skip") status[id] = { status: body.status, by: who, at: new Date().toISOString() };
  else delete status[id];
  // Keep it small: drop answers older than two years.
  for (const k of Object.keys(status)) if (Number(k.slice(-4)) < new Date().getFullYear() - 1) delete status[k];
  await kvSet(env, "occasion_status", status);
  return json({ status });
}

// ---------------------------------------------------------------------------
// "Already used" marks for Content Library files that were posted outside Creator Studio (downloaded, edited and
// uploaded by hand), so the team can see them as used without making a fake post. Shared by everyone.
// ---------------------------------------------------------------------------

async function libraryUsedRoute(request, env, viewer) {
  const marks = (await kvGet(env, "library_used")) || {};
  if (request.method === "GET") return json({ marks });
  if (request.method !== "POST") throw new HttpError(405, "Method not allowed");
  const body = await request.json().catch(() => ({}));
  const who = viewer.accessEnabled ? viewer.member && viewer.member.id : String(body.userId || "").slice(0, 64);
  if (!who) throw new HttpError(403, "Sign in first.");
  const id = String(body.id || "");
  if (!/^[\w-]{10,}$/.test(id)) throw new HttpError(400, "Unknown file");
  if (body.used === false) delete marks[id];
  else {
    const when = Date.parse(body.at || "");
    marks[id] = {
      by: who, markedAt: new Date().toISOString(), at: isNaN(when) ? new Date().toISOString() : new Date(when).toISOString(),
      platforms: (Array.isArray(body.platforms) ? body.platforms : []).map(String).filter((p) => ["instagram", "facebook", "tiktok", "youtube", "gbp", "other"].includes(p)),
      note: String(body.note || "").trim().slice(0, 300),
    };
  }
  await kvSet(env, "library_used", marks);
  return json({ marks });
}


// ---------------------------------------------------------------------------
// Raw footage → Google Drive ("Man Man RAW Files"). The creator picks photos/videos on her phone and they go straight
// into Drive, sorted into a folder per month and per shoot:
//   Man Man RAW Files / 2026-11 November / 2026-11-19 Christmas Content (Shoreditch) / 20261119_S_RAW_IMG_1234.MOV
// Big videos go up in 16 MB pieces through the Worker into a Google resumable upload, so they can be any size and a
// dropped connection only repeats one piece. Every file is listed in Creator Studio (ws_raw) with who, when and why.
// ---------------------------------------------------------------------------
const RAW_ROOT_DEFAULT = "1ve6cyn5tFZn9LHZ2ex2sQc0Wg-kCmPHo"; // "Man Man RAW Files" in admin@'s Drive
const RAW_CHUNK = 16 * 1024 * 1024; // a multiple of 256 KB, as Google requires
const RAW_MONTHS = ["January", "February", "March", "April", "May", "June", "July", "August", "September", "October", "November", "December"];
const rawFolderName = (s) => wsText(s, 90).replace(/[\\/:*?"<>|#]+/g, " ").replace(/\s+/g, " ").trim();

async function rawDriveCall(token, path, init = {}) {
  const sep = path.includes("?") ? "&" : "?";
  const r = await fetch("https://www.googleapis.com/drive/v3/" + path + sep + "supportsAllDrives=true", { ...init, headers: { Authorization: "Bearer " + token, ...(init.body ? { "Content-Type": "application/json" } : {}), ...(init.headers || {}) } });
  const d = await r.json().catch(() => ({}));
  if (!r.ok) throw new HttpError(r.status === 404 ? 404 : 502, "Google Drive: " + ((d.error && d.error.message) || r.status));
  return d;
}
// Find or make a sub-folder by name (remembered, and checked again if someone deletes it in Drive).
async function rawSubfolder(env, token, parentId, name, cache) {
  const key = parentId + "/" + name;
  if (cache.folders[key]) {
    try { const f = await rawDriveCall(token, `files/${cache.folders[key]}?fields=id,trashed`); if (!f.trashed) return cache.folders[key]; } catch (e) { /* gone */ }
  }
  const q = `name = '${name.replace(/\\/g, "\\\\").replace(/'/g, "\\'")}' and '${parentId}' in parents and mimeType = '${DRIVE_FOLDER}' and trashed = false`;
  const found = await rawDriveCall(token, "files?fields=files(id)&includeItemsFromAllDrives=true&q=" + encodeURIComponent(q));
  const id = (found.files && found.files[0] && found.files[0].id) || (await rawDriveCall(token, "files?fields=id", { method: "POST", body: JSON.stringify({ name, mimeType: DRIVE_FOLDER, parents: [parentId] }) })).id;
  cache.folders[key] = id;
  return id;
}
async function rawRoot(env) {
  const saved = (await kvGet(env, "raw_drive_folder")) || {};
  return { id: saved.id || RAW_ROOT_DEFAULT, folders: saved.folders || {} };
}
const rawRow = async (env, id) => {
  const row = await env.DB.prepare("SELECT data FROM ws_raw WHERE id = ?1").bind(String(id || "")).first();
  if (!row) throw new HttpError(404, "That upload doesn't exist.");
  return JSON.parse(row.data);
};
const rawSave = (env, r) => env.DB.prepare("INSERT INTO ws_raw (id, data, created_at) VALUES (?1, ?2, ?3) ON CONFLICT(id) DO UPDATE SET data = excluded.data").bind(r.id, JSON.stringify(r), r.createdAt).run();
// What the outside world sees of an upload (never the Google upload address).
const rawPublic = (r) => { const { session, ...rest } = r; return rest; };

async function rawRoute(request, env, url, viewer, path) {
  if (request.method === "GET" && path === "") {
    const { results } = await env.DB.prepare("SELECT data FROM ws_raw ORDER BY created_at DESC LIMIT 1000").all();
    const auth = serviceAccount(env) ? null : await getGoogleAuth(env);
    const root = await rawRoot(env);
    const files = (results || []).map((r) => rawPublic(JSON.parse(r.data))).filter((r) => r.status === "done" && !r.removed);
    return json({ files, canUpload: hasFullDrive(auth), connected: !!auth, rootId: root.id });
  }

  if (request.method === "PUT" && path === "chunk") { // one piece of a file, passed on to Google
    const { me } = await wsActor(env, viewer, { userId: url.searchParams.get("userId") });
    const r = await rawRow(env, url.searchParams.get("id"));
    if (r.by !== me.id) throw new HttpError(403, "This upload belongs to someone else.");
    if (r.status === "done") return json({ file: rawPublic(r), received: r.size, done: true });
    const offset = Number(url.searchParams.get("offset"));
    const len = Number(request.headers.get("content-length") || 0);
    if (!Number.isFinite(offset) || offset < 0 || !len || len > RAW_CHUNK || offset + len > r.size) throw new HttpError(400, "That piece of the file doesn't fit.");
    const { readable, writable } = new FixedLengthStream(len);
    const pump = request.body.pipeTo(writable);
    const up = await fetch(r.session, { method: "PUT", headers: { "Content-Range": `bytes ${offset}-${offset + len - 1}/${r.size}` }, body: readable });
    await pump.catch(() => {});
    return json(await rawAfterPut(env, r, up));
  }

  if (request.method !== "POST") throw new HttpError(405, "Method not allowed");
  const body = await request.json().catch(() => ({}));
  const { me } = await wsActor(env, viewer, body);

  if (path === "start") { // make the Drive folders and open a resumable upload for one file
    await rawGuard(env, body, Math.round(Number(body.size) || 0));
    const auth = serviceAccount(env) ? null : await getGoogleAuth(env);
    if (!hasFullDrive(auth)) throw new HttpError(409, "An admin needs to reconnect Google Drive in Settings once, so Creator Studio can save into the RAW files folder.");
    const size = Math.round(Number(body.size) || 0);
    if (size <= 0) throw new HttpError(400, "That file is empty.");
    if (size > 20 * 1024 ** 3) throw new HttpError(413, "Files over 20 GB can't be uploaded here — use Google Drive directly.");
    const mime = /^(image|video)\/[\w.+-]+$/.test(String(body.mime || "")) ? body.mime : "application/octet-stream";
    const date = /^\d{4}-\d{2}-\d{2}$/.test(body.shootDate || "") ? body.shootDate : new Date().toISOString().slice(0, 10);
    const branchKey = WS_BRANCHES[body.branch] ? body.branch : "all";
    const branch = WS_BRANCHES[branchKey];
    let project = null;
    if (body.projectId) { try { project = await wsProject(env, body.projectId); } catch (e) { project = null; } }
    const label = rawFolderName(body.label || (project && project.title) || "Shoot");
    // Same layout as the Content Library: <Branch> / Videos|Photos / YYYY-MM-DD_Shoot-Name
    const kindFolder = /^image\//.test(mime) ? "Photos" : "Videos";
    const shootFolder = date + "_" + libSlug(label);
    const original = wsText(body.name, 160).replace(/[\\/:*?"<>|]+/g, "_") || "file";
    // SANJUGO filing-system name with its own barcode: DATE_AL_CATEGORY_[DISH]_RAW_v<camera number>_BARCODE.ext
    const category = WS_CATEGORIES[body.category] ? body.category : (project && project.category) || "FC";
    const dish = WS_DISHES[body.dish] ? body.dish : (project && (project.dishes || [])[0]) || null;
    const camNo = (/(\d{1,5})(?!.*\d)/.exec(original.replace(/\.[^.]+$/, "")) || [])[1];
    const ext = ((/\.([a-z0-9]{2,5})$/i.exec(original) || [])[1] || (/^image/.test(mime) ? "jpg" : "mp4")).toLowerCase();
    const rawId = wsId("raw");
    const barcode = await claimBarcode(env, request, branch.letter, "raw", rawId);
    const driveName = [date.replace(/-/g, ""), "AL", category, ...(dish ? [dish] : []), "RAW", "v" + String(Number(camNo || 1)), barcode].join("_") + "." + ext;

    const token = await getGoogleToken(env);
    const root = await rawRoot(env);
    const branchId = await rawSubfolder(env, token, root.id, branch.folder, root);
    const kindId = await rawSubfolder(env, token, branchId, kindFolder, root);
    const shootId = await rawSubfolder(env, token, kindId, shootFolder, root);
    await kvSet(env, "raw_drive_folder", { id: root.id, folders: root.folders });

    const note = wsText(body.note, 500);
    const description = `Raw ${/^video/.test(mime) ? "video" : /^image/.test(mime) ? "photo" : "file"} uploaded by ${me.name} via Creator Studio on ${new Date().toISOString().slice(0, 10)}.` +
        (project ? ` Workspace project: ${project.title}.` : "") + ` Shoot: ${label}. Branch: ${branch.folder}. Original name: ${original}.` + (note ? " Note: " + note : "");
    const init = await fetch("https://www.googleapis.com/upload/drive/v3/files?uploadType=resumable&supportsAllDrives=true&fields=id,name,webViewLink,thumbnailLink", {
      method: "POST",
      headers: { Authorization: "Bearer " + token, "Content-Type": "application/json; charset=UTF-8", "X-Upload-Content-Type": mime, "X-Upload-Content-Length": String(size) },
      body: JSON.stringify({ name: driveName, parents: [shootId], description }),
    });
    const session = init.headers.get("location");
    if (!init.ok || !session) { await env.DB.prepare("DELETE FROM ws_barcodes WHERE code = ?1 AND ref = ?2").bind(barcode, rawId).run(); throw new HttpError(502, "Google Drive upload couldn't start (" + init.status + ")"); }
    const r = { id: rawId, session, name: original, driveName, barcode, category, dish, size, mime, shootDate: date, branch: branchKey, projectId: project ? project.id : null, projectTitle: project ? project.title : null,
      label, note, folderPath: [branch.folder, kindFolder, shootFolder], folderId: shootId, by: me.id, createdAt: new Date().toISOString(), status: "uploading", received: 0 };
    await rawSave(env, r);
    return json({ upload: rawPublic(r), chunk: RAW_CHUNK });
  }

  if (path === "status") { // after a dropped connection: ask Google how much it already has
    const r = await rawRow(env, body.id);
    if (r.by !== me.id) throw new HttpError(403, "This upload belongs to someone else.");
    if (r.status === "done") return json({ file: rawPublic(r), received: r.size, done: true });
    const up = await fetch(r.session, { method: "PUT", headers: { "Content-Range": `bytes */${r.size}` } });
    return json(await rawAfterPut(env, r, up));
  }

  if (path === "remove") { // off the list, out of the Content Library, and into the Google Drive bin (restorable for 30 days)
    const r = await rawRow(env, body.id);
    if (r.by !== me.id && me.role !== "admin") throw new HttpError(403, "Only the person who uploaded it or an admin can remove it.");
    let binned = false;
    if (r.driveId) {
      try {
        const token = await getGoogleToken(env);
        const res = await fetch(`https://www.googleapis.com/drive/v3/files/${r.driveId}?supportsAllDrives=true`, {
          method: "PATCH", headers: { Authorization: "Bearer " + token, "Content-Type": "application/json" }, body: JSON.stringify({ trashed: true }) });
        binned = res.ok || res.status === 404;
      } catch (e) { /* stays in Drive; still leaves the list */ }
      await libraryIndexRemove(env, r.driveId).catch(() => {});
    }
    r.removed = { by: me.id, at: new Date().toISOString(), binned };
    await rawSave(env, r);
    return json({ ok: true, binned });
  }

  throw new HttpError(404, "Unknown raw-file request");
}

// RAW files = untouched camera footage. An edited video that is already a Workspace draft (same file size, or the
// same file name in the same project), or a file already uploaded as raw, is turned away with a clear reason.
async function rawGuard(env, body, size) {
  const name = String(body.name || "").trim().toLowerCase();
  const { results: dr } = await env.DB.prepare("SELECT data FROM ws_items WHERE kind = 'draft'").all();
  for (const r of dr || []) {
    const d = JSON.parse(r.data);
    if (d.deleted || !d.media) continue;
    const sameSize = size > 0 && Number(d.media.size) === size;
    const sameName = name && String(d.media.name || "").trim().toLowerCase() === name && body.projectId && d.projectId === body.projectId;
    if (sameSize || sameName) {
      let title = "a Workspace project";
      try { title = "“" + (await wsProject(env, d.projectId)).title + "”"; } catch (e) { /* project gone */ }
      throw new HttpError(409, `This is draft ${d.cut} of ${title} — an edited video, not raw footage. Drafts go in the project's Draft review, and the approved one is saved to Drive with its code when it's named.`);
    }
  }
  const { results: rr } = await env.DB.prepare("SELECT data FROM ws_raw").all();
  for (const r of rr || []) {
    const x = JSON.parse(r.data);
    if (x.status === "done" && !x.removed && size > 0 && Number(x.size) === size && String(x.name || "").trim().toLowerCase() === name)
      throw new HttpError(409, `Already uploaded as ${x.barcode} (${x.driveName}).`);
  }
}

async function rawAfterPut(env, r, up) {
  if (up.status === 308) { // Google has part of it: "Range: bytes=0-N"
    const m = /bytes=0-(\d+)/.exec(up.headers.get("range") || "");
    const received = m ? Number(m[1]) + 1 : 0;
    if (received !== r.received) { r.received = received; await rawSave(env, r); }
    return { received, done: false };
  }
  if (up.ok) {
    const d = await up.json().catch(() => ({}));
    r.status = "done"; r.received = r.size; r.driveId = d.id || null; r.doneAt = new Date().toISOString();
    if (d.webViewLink) r.link = d.webViewLink;
    await rawSave(env, r);
    // In the Content Library straight away (the next full refresh finds it in Drive too).
    if (r.driveId) await wsAddToLibraryIndex(env, null, { id: r.driveId, name: r.driveName, mime: r.mime, size: r.size, branch: WS_BRANCHES[r.branch].folder,
      path: ["Man Man RAW Files", ...r.folderPath.slice(1)], modified: r.doneAt, note: `Raw ${r.label}${r.note ? " — " + r.note : ""} (uploaded by Creator Studio)` }).catch((e) => console.error("raw library", e));
    return { file: rawPublic(r), received: r.size, done: true };
  }
  if (up.status === 404 || up.status === 410) { r.status = "expired"; await rawSave(env, r); throw new HttpError(410, "The upload expired — start this file again."); }
  const t = await up.text().catch(() => "");
  throw new HttpError(502, "Google Drive didn't take that piece (" + up.status + ") " + t.slice(0, 120));
}

// ---------------------------------------------------------------------------
// ManyChat — the Engagement section.
// ManyChat runs Sanjugo's Instagram DMs and comment keywords. Its API can't build automations or read the inbox, so
// ManyChat's own automations tell us what happened (an "External Request" step posting to /api/manychat/hook) and
// Creator Studio keeps the counts, the people list, the "needs a person" queue and tracked links (/go/<code>).
// The texts automations send (current offer, booking link…) are ManyChat "bot fields" that Creator Studio writes
// once every reviewer has approved the change. The API key is a Cloudflare secret (MANYCHAT_API_KEY); the hook's own
// key lives in app_kv (mc_hook_secret) and is shown to admins in Settings.
// ---------------------------------------------------------------------------
const MC_API = "https://api.manychat.com";
const MC_TYPES = ["keyword", "human", "story_mention", "story_reply", "welcome", "dm", "other"];
const MC_FIELDS_DEFAULT = [
  ["sj_offer", "Current offer"], ["sj_offer_link", "Offer link"], ["sj_booking_link", "Booking link"], ["sj_menu_link", "Menu link"],
  ["sj_hours", "Opening hours"], ["sj_branches", "Our branches"], ["sj_special", "This week's special"],
];
const MC_KEEP_DAYS = 400; // people, messages and clicks older than this are deleted in the nightly clean-up
const MC_URGENT = /allerg|anaphyla|gluten|coeliac|celiac|\bnuts?\b|peanut|sesame|shellfish|lactose|dairy.free|food poisoning|\bsick\b|ill after|complain|refund|disgusting/i;
let mcReady = false;

async function ensureMcTables(env) {
  if (mcReady) return;
  for (const sql of [
    "CREATE TABLE IF NOT EXISTS mc_events (id INTEGER PRIMARY KEY AUTOINCREMENT, type TEXT NOT NULL, sub_id TEXT, automation TEXT, keyword TEXT, text TEXT, day TEXT NOT NULL, created_at TEXT NOT NULL)",
    "CREATE INDEX IF NOT EXISTS mc_events_day ON mc_events (day)",
    "CREATE INDEX IF NOT EXISTS mc_events_sub ON mc_events (sub_id)",
    "CREATE TABLE IF NOT EXISTS mc_people (sub_id TEXT PRIMARY KEY, name TEXT, username TEXT, pic TEXT, chat_url TEXT, first_seen TEXT NOT NULL, last_seen TEXT NOT NULL, events INTEGER NOT NULL DEFAULT 0, keywords TEXT, tags TEXT)",
    "CREATE TABLE IF NOT EXISTS mc_handover (id TEXT PRIMARY KEY, sub_id TEXT, reason TEXT, text TEXT, urgent INTEGER NOT NULL DEFAULT 0, status TEXT NOT NULL, created_at TEXT NOT NULL, done_at TEXT, done_by TEXT)",
    "CREATE TABLE IF NOT EXISTS mc_links (code TEXT PRIMARY KEY, name TEXT NOT NULL, url TEXT NOT NULL, campaign TEXT, created_by TEXT, created_at TEXT NOT NULL, deleted INTEGER NOT NULL DEFAULT 0)",
    "CREATE TABLE IF NOT EXISTS mc_clicks (id INTEGER PRIMARY KEY AUTOINCREMENT, code TEXT NOT NULL, sub_id TEXT, day TEXT NOT NULL, created_at TEXT NOT NULL)",
    "CREATE INDEX IF NOT EXISTS mc_clicks_code ON mc_clicks (code, day)",
    "CREATE TABLE IF NOT EXISTS mc_fields (name TEXT PRIMARY KEY, label TEXT NOT NULL, value TEXT, draft TEXT, approvals TEXT, edited_by TEXT, updated_at TEXT, pushed_at TEXT, push_error TEXT, sort INTEGER NOT NULL DEFAULT 0, builtin INTEGER NOT NULL DEFAULT 0)",
  ]) await env.DB.prepare(sql).run();
  try { await env.DB.prepare("ALTER TABLE mc_links ADD COLUMN keyword TEXT").run(); } catch (e) { /* already there */ }
  const n = await env.DB.prepare("SELECT COUNT(*) AS n FROM mc_fields").first();
  if (!n.n) {
    for (const [i, [name, label]] of MC_FIELDS_DEFAULT.entries())
      await env.DB.prepare("INSERT OR IGNORE INTO mc_fields (name, label, value, sort, builtin) VALUES (?1, ?2, '', ?3, 1)").bind(name, label, i).run();
  }
  mcReady = true;
}

async function mcCall(env, method, path, body) {
  if (!env.MANYCHAT_API_KEY) throw new HttpError(400, "ManyChat isn't connected yet — the API key hasn't been added.");
  const res = await fetch(MC_API + path, {
    method, headers: { Authorization: "Bearer " + env.MANYCHAT_API_KEY, Accept: "application/json", ...(body ? { "Content-Type": "application/json" } : {}) },
    body: body ? JSON.stringify(body) : undefined,
  });
  const d = await res.json().catch(() => ({}));
  if (!res.ok || d.status !== "success") {
    const msgs = d.details && Array.isArray(d.details.messages) ? d.details.messages.map((m) => m && m.message).filter(Boolean).join("; ") : "";
    const why = String(d.message || msgs || "error " + res.status).slice(0, 200);
    if (res.status === 401 || res.status === 403) throw new HttpError(400, "ManyChat didn't accept the API key (" + why + ").");
    throw new HttpError(502, "ManyChat: " + why);
  }
  return d.data;
}

function mcSame(a, b) {
  a = String(a || ""); b = String(b || "");
  if (!a || a.length !== b.length) return false;
  let x = 0;
  for (let i = 0; i < a.length; i++) x |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return x === 0;
}
async function mcHookSecret(env, rotate) {
  let s = rotate ? null : await kvGet(env, "mc_hook_secret");
  if (!s) {
    const b = new Uint8Array(18); crypto.getRandomValues(b);
    s = [...b].map((x) => x.toString(16).padStart(2, "0")).join("");
    await kvSet(env, "mc_hook_secret", s);
  }
  return s;
}
function mcBase(env, url) {
  return /^(localhost|127\.0\.0\.1)$/.test(url.hostname) ? url.origin : String(env.PUBLIC_URL || url.origin).replace(/\/$/, "");
}

// What an automation sent. Works with ManyChat's "full contact data" body, a hand-made body, or just ?key=…&type=… in the link.
function mcPick(body, url) {
  body = body && typeof body === "object" && !Array.isArray(body) ? body : {};
  const q = (k) => (url ? url.searchParams.get(k) : null);
  const c = (typeof body.contact === "object" && body.contact) || (typeof body.subscriber === "object" && body.subscriber) || body;
  const s = (v, n) => (v == null || typeof v === "object" ? "" : String(v)).trim().slice(0, n);
  const id = s(c.id ?? body.subscriber_id ?? body.contact_id ?? body.user_id ?? q("id"), 30);
  const keyword = s(body.keyword || q("keyword"), 40).toUpperCase();
  let type = s(body.type || q("type"), 30).toLowerCase().replace(/[\s-]+/g, "_");
  if (!type) type = keyword ? "keyword" : "dm";
  if (!MC_TYPES.includes(type)) type = "other";
  const tags = Array.isArray(c.tags) ? c.tags.map((t) => s(t && typeof t === "object" ? t.name : t, 40)).filter(Boolean).slice(0, 30) : [];
  return {
    subId: /^\d{1,30}$/.test(id) ? id : null, type, keyword,
    automation: s(body.automation || q("automation"), 80),
    reason: s(body.reason || q("reason"), 120),
    text: s(body.text || body.message || c.last_input_text, 600),
    name: s(c.name || [c.first_name, c.last_name].filter(Boolean).join(" "), 80),
    username: s(c.ig_username || body.ig_username || body.username, 40).replace(/^@/, ""),
    pic: /^https:\/\//.test(String(c.profile_pic || "")) ? s(c.profile_pic, 800) : "",
    chatUrl: /^https:\/\/([a-z0-9-]+\.)*manychat\.com\//i.test(String(c.live_chat_url || "")) ? s(c.live_chat_url, 300) : "",
    tags,
  };
}

// POST /api/manychat/hook?key=… — called by ManyChat's servers (no sign-in; the key proves it's our ManyChat).
async function mcHook(request, env, url, ctx) {
  await ensureMcTables(env);
  const secret = await kvGet(env, "mc_hook_secret");
  const given = request.headers.get("X-Sanjugo-Key") || url.searchParams.get("key");
  if (!secret || !mcSame(given, secret)) return json({ error: "Wrong key" }, 401);
  let body = {};
  if (request.method === "POST") {
    const raw = await request.text();
    if (raw.length > 100000) return json({ error: "Too big" }, 413);
    try { body = raw.trim() ? JSON.parse(raw) : {}; } catch (e) { return json({ error: "Send JSON" }, 400); }
  }
  const ev = mcPick(body, url);
  const now = new Date().toISOString();
  await env.DB.prepare("INSERT INTO mc_events (type, sub_id, automation, keyword, text, day, created_at) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7)")
    .bind(ev.type, ev.subId, ev.automation || null, ev.keyword || null, ev.text || null, londonDay(), now).run();
  if (ev.subId) await mcUpsertPerson(env, ev, now);
  const handover = ev.type === "human" ? await mcOpenHandover(env, ev, now) : null;
  await kvSet(env, "mc_last_event", { at: now, type: ev.type, automation: ev.automation || ev.keyword || "" });
  // ManyChat waits at most 10 seconds, so name look-ups, Team Chat and phone alerts happen after we've answered.
  ctx.waitUntil(mcAfterEvent(env, ev, handover).catch((e) => console.error("manychat follow-up failed", e)));
  return json({ ok: true });
}

async function mcUpsertPerson(env, ev, now) {
  const row = await env.DB.prepare("SELECT keywords, tags FROM mc_people WHERE sub_id = ?1").bind(ev.subId).first();
  let kws = []; try { kws = row ? JSON.parse(row.keywords || "[]") : []; } catch (e) {}
  if (ev.keyword && !kws.includes(ev.keyword)) kws.push(ev.keyword);
  let tags = ev.tags; if (!tags.length && row) { try { tags = JSON.parse(row.tags || "[]"); } catch (e) {} }
  await env.DB.prepare(`INSERT INTO mc_people (sub_id, name, username, pic, chat_url, first_seen, last_seen, events, keywords, tags) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?6, 1, ?7, ?8)
    ON CONFLICT(sub_id) DO UPDATE SET name = COALESCE(NULLIF(excluded.name, ''), mc_people.name), username = COALESCE(NULLIF(excluded.username, ''), mc_people.username),
      pic = COALESCE(NULLIF(excluded.pic, ''), mc_people.pic), chat_url = COALESCE(NULLIF(excluded.chat_url, ''), mc_people.chat_url),
      last_seen = excluded.last_seen, events = mc_people.events + 1, keywords = excluded.keywords, tags = excluded.tags`)
    .bind(ev.subId, ev.name, ev.username, ev.pic, ev.chatUrl, now, JSON.stringify(kws.slice(-30)), JSON.stringify(tags)).run();
}

async function mcOpenHandover(env, ev, now) {
  const urgent = MC_URGENT.test(ev.text + " " + ev.reason) ? 1 : 0;
  // One open request per person: another message while it's still open updates it instead of adding a second one.
  const open = ev.subId ? await env.DB.prepare("SELECT id, urgent FROM mc_handover WHERE sub_id = ?1 AND status = 'open'").bind(ev.subId).first() : null;
  if (open) {
    await env.DB.prepare("UPDATE mc_handover SET text = COALESCE(NULLIF(?2, ''), text), reason = COALESCE(NULLIF(?3, ''), reason), urgent = MAX(urgent, ?4) WHERE id = ?1")
      .bind(open.id, ev.text, ev.reason, urgent).run();
    // Still tell the team if a repeat message turns it into an allergy / complaint.
    return { id: open.id, repeat: !(urgent && !open.urgent), urgent };
  }
  const id = "h_" + crypto.randomUUID().replace(/-/g, "").slice(0, 14);
  await env.DB.prepare("INSERT INTO mc_handover (id, sub_id, reason, text, urgent, status, created_at) VALUES (?1, ?2, ?3, ?4, ?5, 'open', ?6)")
    .bind(id, ev.subId, ev.reason || null, ev.text || null, urgent, now).run();
  return { id, repeat: false, urgent };
}

async function mcAfterEvent(env, ev, handover) {
  // Fill in the name, photo and chat link from ManyChat when the automation didn't send them.
  if (ev.subId && env.MANYCHAT_API_KEY && (!ev.name || !ev.chatUrl || (handover && !ev.text))) {
    try {
      const more = mcPick({ ...(await mcCall(env, "GET", "/fb/subscriber/getInfo?subscriber_id=" + ev.subId)), type: ev.type }, null);
      ev.name = ev.name || more.name; ev.username = ev.username || more.username; ev.pic = ev.pic || more.pic; ev.chatUrl = ev.chatUrl || more.chatUrl;
      await env.DB.prepare("UPDATE mc_people SET name = COALESCE(NULLIF(?2, ''), name), username = COALESCE(NULLIF(?3, ''), username), pic = COALESCE(NULLIF(?4, ''), pic), chat_url = COALESCE(NULLIF(?5, ''), chat_url), tags = CASE WHEN ?6 = '[]' THEN tags ELSE ?6 END WHERE sub_id = ?1")
        .bind(ev.subId, ev.name, ev.username, ev.pic, ev.chatUrl, JSON.stringify(more.tags)).run();
      if (handover && !ev.text && more.text) {
        ev.text = more.text;
        await env.DB.prepare("UPDATE mc_handover SET text = ?2 WHERE id = ?1 AND (text IS NULL OR text = '')").bind(handover.id, more.text).run();
      }
    } catch (e) { console.error("manychat getInfo failed", e.message); }
  }
  if (!handover || handover.repeat) return;
  const reviewers = await mcReviewers(env);
  const who = reviewers.map((m) => m.id);
  const person = ev.name ? ev.name + (ev.username ? " (@" + ev.username + ")" : "") : ev.username ? "@" + ev.username : "Someone";
  const said = ev.text ? ` “${ev.text.slice(0, 160)}”` : "";
  const text = `${handover.urgent ? "⚠️" : "🙋"} ${person} wants a person on Instagram${ev.reason ? " — " + ev.reason : ""}.${said} Reply in ManyChat, then tick it off in Engagement. ${reviewers.map((m) => "@" + m.name).join(" ")}`;
  const posted = await postSystemChat(env, { text, mentions: who, eventId: "mc_human_" + handover.id + (handover.urgent ? "_u" : "") });
  if (posted) await pushToUsers(env, who, { title: (handover.urgent ? "⚠️ " : "🙋 ") + "Instagram: needs a person", body: person + (ev.reason ? " — " + ev.reason : "") + (said ? ":" + said : ""), url: "/#/engagement?tab=human", tag: "mc-" + handover.id }).catch(() => {});
}

async function mcReviewers(env) {
  const { members } = await listTeam(env);
  return members.filter((m) => m.active && (m.role === "admin" || m.role === "approver")).map((m) => ({ id: m.id, name: m.name }));
}

// GET /go/<code> — tracked link. Counts the click, then sends the person on to the real page.
async function mcGo(request, env, url, code, ctx) {
  await ensureMcTables(env);
  code = code.toLowerCase();
  const link = await env.DB.prepare("SELECT url FROM mc_links WHERE code = ?1 AND deleted = 0").bind(code).first();
  if (!link) return new Response(null, { status: 302, headers: { Location: "https://sanjugo.co.uk/", "Cache-Control": "no-store" } });
  const s = url.searchParams.get("s") || "";
  // Instagram and other apps open links once to draw a preview — those aren't people.
  const ua = request.headers.get("User-Agent") || "";
  if (!/bot|crawl|spider|preview|facebookexternalhit|meta-externalagent|slurp|WhatsApp|TelegramBot/i.test(ua))
    ctx.waitUntil(env.DB.prepare("INSERT INTO mc_clicks (code, sub_id, day, created_at) VALUES (?1, ?2, ?3, ?4)")
      .bind(code, /^\d{1,30}$/.test(s) ? s : null, londonDay(), new Date().toISOString()).run().catch(() => {}));
  return new Response(null, { status: 302, headers: { Location: link.url, "Cache-Control": "no-store" } });
}

async function mcPage(env, force) {
  if (!env.MANYCHAT_API_KEY) return { connected: false };
  const cached = await kvGet(env, "mc_page");
  if (!force && cached && !cached.error && Date.now() - Date.parse(cached.at || 0) < 6 * 3600e3) return cached;
  try {
    const p = await mcCall(env, "GET", "/fb/page/getInfo");
    const out = { connected: true, at: new Date().toISOString(), id: p.id, name: p.name || "", username: p.username || "", avatar: p.avatar_link || "", isPro: !!p.is_pro };
    await kvSet(env, "mc_page", out);
    return out;
  } catch (e) {
    return { connected: true, error: e.message };
  }
}

const mcFieldOut = (r) => {
  let approvals = {}; try { approvals = r.approvals ? JSON.parse(r.approvals) : {}; } catch (e) {}
  return { name: r.name, label: r.label, value: r.value || "", draft: r.draft == null ? null : r.draft, approvals, editedBy: r.edited_by || null,
    updatedAt: r.updated_at || null, pushedAt: r.pushed_at || null, pushError: r.push_error || null, builtin: !!r.builtin };
};
async function mcFields(env) {
  const { results } = await env.DB.prepare("SELECT * FROM mc_fields ORDER BY sort, label").all();
  return (results || []).map(mcFieldOut);
}

async function mcPushField(env, name) {
  const row = await env.DB.prepare("SELECT * FROM mc_fields WHERE name = ?1").bind(name).first();
  if (!row) return;
  const mark = (ok, err) => env.DB.prepare("UPDATE mc_fields SET pushed_at = ?2, push_error = ?3 WHERE name = ?1").bind(name, ok ? new Date().toISOString() : row.pushed_at, err).run();
  if (!env.MANYCHAT_API_KEY) return mark(false, "Waiting for ManyChat to be connected");
  try {
    const existing = await mcCall(env, "GET", "/fb/page/getBotFields");
    if ((existing || []).some((f) => f && f.name === name)) await mcCall(env, "POST", "/fb/page/setBotFieldByName", { field_name: name, field_value: row.value || "" });
    else await mcCall(env, "POST", "/fb/page/createBotField", { name, type: "text", description: row.label + " (set from Sanjugo Creator Studio)", value: row.value || "" });
    await mark(true, null);
  } catch (e) {
    await mark(false, e.message);
  }
}

// A change goes live (and to ManyChat) once every reviewer has approved it. The person who made it counts as approving.
async function mcMaybeGoLive(env, name) {
  const row = await env.DB.prepare("SELECT draft, approvals FROM mc_fields WHERE name = ?1").bind(name).first();
  if (!row || row.draft == null) return false;
  let approvals = {}; try { approvals = JSON.parse(row.approvals || "{}"); } catch (e) {}
  const reviewers = await mcReviewers(env);
  if (reviewers.length && !reviewers.every((r) => approvals[r.id])) return false;
  await env.DB.prepare("UPDATE mc_fields SET value = draft, draft = NULL, approvals = NULL, updated_at = ?2 WHERE name = ?1").bind(name, new Date().toISOString()).run();
  await mcPushField(env, name);
  return true;
}

const MC_DRAFT_SYSTEM = `You write the short automatic Instagram DM text for SANJUGO, a modern Japanese comfort restaurant group in London (Shoreditch, Angel, Victoria). The text is dropped into a DM that a guest asked for (they commented a keyword or tapped a button). Rules:
- Warm, simple, human and quietly confident. 1 to 3 short sentences, at most 2 emoji. Plain words, no poetry.
- Say "guests", never customers. Never use: amazing, best ever, must try, OMG, epic, crazy, insane, cheap, discount, deal, hurry, limited time, order now, fast food, quick bite, budget, loaded, massive, monster.
- End with a soft invitation (e.g. "We'll save you a seat."). Never a hard sell.
- Lines about walk-in portions, limited availability or booking terms only as one short last line, never the main message.
- Use only facts given to you. Never invent prices, dates, dishes or links.
Reply with only the DM text, nothing else.`;

async function mcOverview(env) {
  const since = londonDay(Date.now() - 29 * 86400e3), since7 = londonDay(Date.now() - 6 * 86400e3);
  const sinceIso = new Date(Date.now() - 30 * 86400e3).toISOString();
  const all = (sql, ...b) => env.DB.prepare(sql).bind(...b).all().then((r) => r.results || []);
  const one = (sql, ...b) => env.DB.prepare(sql).bind(...b).first();
  const [byDay, byType, top, newPeople, people, clicks, open, done, page, last] = await Promise.all([
    all("SELECT day, COUNT(*) AS n FROM mc_events WHERE day >= ?1 GROUP BY day", since),
    all("SELECT type, COUNT(*) AS n FROM mc_events WHERE day >= ?1 GROUP BY type", since),
    all("SELECT COALESCE(NULLIF(keyword, ''), NULLIF(automation, ''), type) AS name, COUNT(*) AS n, COUNT(DISTINCT sub_id) AS people, SUM(day >= ?2) AS n7 FROM mc_events WHERE day >= ?1 GROUP BY name ORDER BY n DESC LIMIT 12", since, since7),
    one("SELECT COUNT(*) AS n, SUM(first_seen >= ?2) AS n7 FROM mc_people WHERE first_seen >= ?1", sinceIso, new Date(Date.now() - 7 * 86400e3).toISOString()),
    one("SELECT COUNT(*) AS n FROM mc_people"),
    one("SELECT COUNT(*) AS n, COUNT(DISTINCT sub_id) AS people FROM mc_clicks WHERE day >= ?1", since),
    one("SELECT COUNT(*) AS n, SUM(urgent) AS urgent FROM mc_handover WHERE status = 'open'"),
    all("SELECT created_at, done_at FROM mc_handover WHERE status = 'done' AND done_at >= ?1", sinceIso),
    mcPage(env, false), kvGet(env, "mc_last_event"),
  ]);
  const mins = done.map((r) => (Date.parse(r.done_at) - Date.parse(r.created_at)) / 60e3).filter((m) => m >= 0).sort((a, b) => a - b);
  return {
    page, last,
    days: byDay, types: byType, top,
    newPeople: newPeople.n || 0, newPeople7: newPeople.n7 || 0, people: people.n || 0,
    clicks: clicks.n || 0, clickPeople: clicks.people || 0,
    open: open.n || 0, openUrgent: open.urgent || 0,
    replyMins: mins.length ? Math.round(mins[Math.floor(mins.length / 2)]) : null, replied: mins.length,
  };
}

async function manychatRoute(request, env, url, viewer, ctx) {
  await ensureMcTables(env);
  if (viewer.accessEnabled && !viewer.member) throw new HttpError(401, "Sign in first.");
  if (viewer.member && viewer.member.role === "video") throw new HttpError(403, "Engagement isn't part of your role.");
  const path = url.pathname.replace(/^\/api\/manychat\/?/, "");
  const body = request.method === "POST" ? await request.json().catch(() => ({})) : {};
  const by = viewer.member ? viewer.member.id : String(body.userId || url.searchParams.get("userId") || "").slice(0, 64) || null;
  const isAdmin = !viewer.accessEnabled || (viewer.member && viewer.member.role === "admin");
  const adminOnly = () => { if (!isAdmin) throw new HttpError(403, "Only admins can do that."); };
  const now = new Date().toISOString();
  const GET = request.method === "GET", POST = request.method === "POST";

  if (GET && path === "") return json(await mcOverview(env));
  if (GET && path === "count") {
    const r = await env.DB.prepare("SELECT COUNT(*) AS n, SUM(urgent) AS urgent FROM mc_handover WHERE status = 'open'").first();
    return json({ open: r.n || 0, urgent: r.urgent || 0 });
  }
  if (GET && path === "setup") {
    adminOnly();
    const base = mcBase(env, url);
    const [secret, page, last] = await Promise.all([mcHookSecret(env), mcPage(env, url.searchParams.get("refresh") === "1"), kvGet(env, "mc_last_event")]);
    return json({ hookUrl: base + "/api/manychat/hook?key=" + secret, goBase: base + "/go/", page, last, hasKey: !!env.MANYCHAT_API_KEY });
  }
  if (POST && path === "setup/rotate") {
    adminOnly();
    const secret = await mcHookSecret(env, true);
    return json({ hookUrl: mcBase(env, url) + "/api/manychat/hook?key=" + secret });
  }
  if (GET && path === "flows") {
    const d = await mcCall(env, "GET", "/fb/page/getFlows");
    return json({ flows: (d && d.flows || []).map((f) => ({ ns: f.ns, name: f.name })).sort((a, b) => String(a.name).localeCompare(String(b.name))) });
  }

  // ---- Needs a person ----
  if (GET && path === "human") {
    const status = url.searchParams.get("status") === "done" ? "done" : "open";
    const { results } = await env.DB.prepare(`SELECT h.*, p.name, p.username, p.pic, p.chat_url FROM mc_handover h LEFT JOIN mc_people p ON p.sub_id = h.sub_id
      WHERE h.status = ?1 ORDER BY ${status === "open" ? "h.urgent DESC, h.created_at ASC" : "h.done_at DESC"} LIMIT 100`).bind(status).all();
    const page = await mcPage(env, false);
    return json({ pageId: page && page.id || null, items: (results || []).map((r) => ({ id: r.id, subId: r.sub_id, reason: r.reason || "", text: r.text || "", urgent: !!r.urgent, status: r.status,
      createdAt: r.created_at, doneAt: r.done_at, doneBy: r.done_by, name: r.name || "", username: r.username || "", pic: r.pic || "", chatUrl: r.chat_url || "" })) });
  }
  if (POST && (path === "human/done" || path === "human/reopen")) {
    const id = String(body.id || "");
    if (path === "human/done") await env.DB.prepare("UPDATE mc_handover SET status = 'done', done_at = ?2, done_by = ?3 WHERE id = ?1 AND status = 'open'").bind(id, now, by).run();
    else await env.DB.prepare("UPDATE mc_handover SET status = 'open', done_at = NULL, done_by = NULL WHERE id = ?1").bind(id).run();
    return json({ ok: true });
  }

  // ---- People ----
  if (GET && path === "people") {
    const q = String(url.searchParams.get("q") || "").trim().slice(0, 60);
    const like = "%" + q.replace(/[%_]/g, "") + "%";
    const { results } = await env.DB.prepare(`SELECT * FROM mc_people WHERE (?1 = '' OR name LIKE ?2 OR username LIKE ?2 OR keywords LIKE ?2) ORDER BY last_seen DESC LIMIT 300`).bind(q, like).all();
    const total = await env.DB.prepare("SELECT COUNT(*) AS n FROM mc_people").first();
    const parse = (s) => { try { return JSON.parse(s || "[]"); } catch (e) { return []; } };
    return json({ total: total.n || 0, people: (results || []).map((r) => ({ subId: r.sub_id, name: r.name || "", username: r.username || "", pic: r.pic || "", chatUrl: r.chat_url || "",
      firstSeen: r.first_seen, lastSeen: r.last_seen, events: r.events, keywords: parse(r.keywords), tags: parse(r.tags) })) });
  }
  if (GET && path === "person") {
    const id = String(url.searchParams.get("id") || "");
    const [events, clicks, handovers] = await Promise.all([
      env.DB.prepare("SELECT type, automation, keyword, text, created_at FROM mc_events WHERE sub_id = ?1 ORDER BY id DESC LIMIT 60").bind(id).all(),
      env.DB.prepare("SELECT c.code, l.name, c.created_at FROM mc_clicks c LEFT JOIN mc_links l ON l.code = c.code WHERE c.sub_id = ?1 ORDER BY c.id DESC LIMIT 40").bind(id).all(),
      env.DB.prepare("SELECT id, reason, status, created_at, done_at, done_by FROM mc_handover WHERE sub_id = ?1 ORDER BY created_at DESC LIMIT 20").bind(id).all(),
    ]);
    return json({ events: events.results || [], clicks: clicks.results || [], handovers: handovers.results || [] });
  }
  if (POST && path === "people/delete") {
    adminOnly();
    const id = String(body.subId || "");
    if (!/^\d{1,30}$/.test(id)) throw new HttpError(400, "Unknown person");
    await env.DB.batch(["mc_people", "mc_events", "mc_clicks", "mc_handover"].map((t) => env.DB.prepare(`DELETE FROM ${t} WHERE sub_id = ?1`).bind(id)));
    return json({ ok: true });
  }

  // ---- DM texts (ManyChat bot fields) ----
  if (GET && path === "fields") {
    const [fields, reviewers] = await Promise.all([mcFields(env), mcReviewers(env)]);
    return json({ fields, reviewers, connected: !!env.MANYCHAT_API_KEY });
  }
  if (POST && path === "fields/save") {
    adminOnly();
    const value = String(body.value ?? "").replace(/\r\n/g, "\n").slice(0, 1000);
    const label = String(body.label || "").trim().slice(0, 60);
    let name = String(body.name || "");
    let row = name ? await env.DB.prepare("SELECT * FROM mc_fields WHERE name = ?1").bind(name).first() : null;
    if (!row) {
      if (!label) throw new HttpError(400, "Give the text a name.");
      name = "sj_" + label.toLowerCase().replace(/[^a-z0-9]+/g, "_").replace(/^_+|_+$/g, "").slice(0, 40);
      if (name === "sj_") throw new HttpError(400, "Use letters or numbers in the name.");
      if (await env.DB.prepare("SELECT 1 FROM mc_fields WHERE name = ?1").bind(name).first()) throw new HttpError(400, "There's already a text with that name.");
      const m = await env.DB.prepare("SELECT COALESCE(MAX(sort), 0) AS s FROM mc_fields").first();
      await env.DB.prepare("INSERT INTO mc_fields (name, label, value, sort) VALUES (?1, ?2, '', ?3)").bind(name, label, (m.s || 0) + 1).run();
      row = { value: "", draft: null };
    } else if (label && label !== row.label) {
      await env.DB.prepare("UPDATE mc_fields SET label = ?2 WHERE name = ?1").bind(name, label).run();
    }
    if (row.draft != null && value === (row.value || "")) {
      await env.DB.prepare("UPDATE mc_fields SET draft = NULL, approvals = NULL WHERE name = ?1").bind(name).run();
    } else if (value !== (row.value || "") && value !== row.draft) {
      const reviewers = await mcReviewers(env);
      const approvals = by && reviewers.some((r) => r.id === by) ? { [by]: now } : {};
      await env.DB.prepare("UPDATE mc_fields SET draft = ?2, approvals = ?3, edited_by = ?4, updated_at = ?5 WHERE name = ?1").bind(name, value, JSON.stringify(approvals), by, now).run();
      const live = await mcMaybeGoLive(env, name);
      if (!live) {
        const waiting = reviewers.filter((r) => !approvals[r.id]);
        const f = mcFieldOut(await env.DB.prepare("SELECT * FROM mc_fields WHERE name = ?1").bind(name).first());
        ctx.waitUntil(postSystemChat(env, { text: `✏️ DM text “${f.label}” was changed and needs approval before ManyChat uses it: “${value.slice(0, 200)}” ${waiting.map((r) => "@" + r.name).join(" ")}`,
          mentions: waiting.map((r) => r.id), eventId: "mc_field_" + name + "_" + now }).then((ok) => ok && pushToUsers(env, waiting.map((r) => r.id), { title: "DM text needs approval", body: f.label + ": " + value.slice(0, 120), url: "/#/engagement?tab=texts", tag: "mc-field-" + name })).catch(() => {}));
      }
    }
    return json({ fields: await mcFields(env) });
  }
  if (POST && path === "fields/approve") {
    const name = String(body.name || "");
    const reviewers = await mcReviewers(env);
    if (viewer.accessEnabled && !reviewers.some((r) => r.id === by)) throw new HttpError(403, "Only reviewers can approve DM texts.");
    const row = await env.DB.prepare("SELECT draft, approvals FROM mc_fields WHERE name = ?1").bind(name).first();
    if (!row || row.draft == null) throw new HttpError(409, "That change was already approved or dropped.");
    let approvals = {}; try { approvals = JSON.parse(row.approvals || "{}"); } catch (e) {}
    approvals[by || "someone"] = now;
    await env.DB.prepare("UPDATE mc_fields SET approvals = ?2 WHERE name = ?1").bind(name, JSON.stringify(approvals)).run();
    await mcMaybeGoLive(env, name);
    return json({ fields: await mcFields(env) });
  }
  if (POST && path === "fields/discard") {
    adminOnly();
    await env.DB.prepare("UPDATE mc_fields SET draft = NULL, approvals = NULL WHERE name = ?1").bind(String(body.name || "")).run();
    return json({ fields: await mcFields(env) });
  }
  if (POST && path === "fields/delete") {
    adminOnly();
    await env.DB.prepare("DELETE FROM mc_fields WHERE name = ?1 AND builtin = 0").bind(String(body.name || "")).run();
    return json({ fields: await mcFields(env) });
  }
  if (POST && path === "fields/push") {
    adminOnly();
    const names = body.name ? [String(body.name)] : (await mcFields(env)).filter((f) => f.value).map((f) => f.name);
    for (const n of names) await mcPushField(env, n);
    return json({ fields: await mcFields(env) });
  }
  if (POST && path === "draft") {
    const facts = String(body.facts || "").slice(0, 4000);
    if (facts.trim().length < 10) throw new HttpError(400, "Pick a campaign with some details first.");
    const user = `This DM text is "${String(body.label || "Current offer").slice(0, 60)}".\n${body.current ? "Current text: " + String(body.current).slice(0, 600) + "\n" : ""}Facts:\n${facts}`;
    const text = tidyBotText(String(await aiText(env, MC_DRAFT_SYSTEM, user, 300)).trim()).replace(/^["“]|["”]$/g, "").slice(0, 1000);
    if (!text) throw new HttpError(502, "Couldn't get a draft — try again.");
    return json({ text });
  }

  // ---- Tracked links ----
  if (GET && path === "links") {
    const since7 = londonDay(Date.now() - 6 * 86400e3);
    const [{ results: links }, { results: counts }] = await Promise.all([
      env.DB.prepare("SELECT * FROM mc_links WHERE deleted = 0 ORDER BY created_at DESC").all(),
      env.DB.prepare("SELECT code, COUNT(*) AS n, SUM(day >= ?1) AS n7, COUNT(DISTINCT sub_id) AS people FROM mc_clicks GROUP BY code").bind(since7).all(),
    ]);
    const byCode = new Map((counts || []).map((c) => [c.code, c]));
    return json({ goBase: mcBase(env, url) + "/go/", links: (links || []).map((l) => { const c = byCode.get(l.code) || {};
      return { code: l.code, name: l.name, url: l.url, campaign: l.campaign || "", keyword: l.keyword || "", createdBy: l.created_by, createdAt: l.created_at, clicks: c.n || 0, clicks7: c.n7 || 0, people: c.people || 0 }; }),
      keywords: (await engConfig(env)).keywords });
  }
  if (POST && path === "links/save") {
    adminOnly();
    const name = String(body.name || "").trim().slice(0, 80);
    const dest = String(body.url || "").trim().slice(0, 1000);
    const code = String(body.code || "").trim().toLowerCase();
    if (!name) throw new HttpError(400, "Give the link a name.");
    if (!/^https:\/\/[^\s]+\.[^\s]+$/.test(dest)) throw new HttpError(400, "The page address has to start with https://");
    if (!/^[a-z0-9][a-z0-9-]{1,39}$/.test(code)) throw new HttpError(400, "Short name: 2–40 letters, numbers or dashes.");
    const existing = await env.DB.prepare("SELECT deleted FROM mc_links WHERE code = ?1").bind(code).first();
    if (existing && !existing.deleted && body.editing !== code) throw new HttpError(400, "That short name is taken — pick another.");
    const keyword = String(body.keyword || "").trim().toUpperCase().slice(0, 40) || null;
    await env.DB.prepare(`INSERT INTO mc_links (code, name, url, campaign, created_by, created_at, deleted, keyword) VALUES (?1, ?2, ?3, ?4, ?5, ?6, 0, ?7)
      ON CONFLICT(code) DO UPDATE SET name = excluded.name, url = excluded.url, campaign = excluded.campaign, deleted = 0, keyword = excluded.keyword`)
      .bind(code, name, dest, String(body.campaign || "").slice(0, 80) || null, by, now, keyword).run();
    return json({ ok: true });
  }
  if (POST && path === "links/delete") {
    adminOnly();
    await env.DB.prepare("UPDATE mc_links SET deleted = 1 WHERE code = ?1").bind(String(body.code || "")).run();
    return json({ ok: true });
  }
  throw new HttpError(404, "Unknown request");
}

// Nightly: keep a little over a year of people, messages and clicks (personal data shouldn't sit here forever).
async function mcPrune(env) {
  await ensureMcTables(env);
  const day = londonDay(Date.now() - MC_KEEP_DAYS * 86400e3), iso = new Date(Date.now() - MC_KEEP_DAYS * 86400e3).toISOString();
  await env.DB.batch([
    env.DB.prepare("DELETE FROM mc_events WHERE day < ?1").bind(day),
    env.DB.prepare("DELETE FROM mc_clicks WHERE day < ?1").bind(day),
    env.DB.prepare("DELETE FROM mc_handover WHERE status = 'done' AND created_at < ?1").bind(iso),
    env.DB.prepare("DELETE FROM mc_people WHERE last_seen < ?1").bind(iso),
  ]);
}

// ---------------------------------------------------------------------------
// Engagement through Make — Instagram comments and Google reviews (Engagement → Comments / Reviews).
// In:  "Engage · Instagram comments" (Instagram "Watch events", instant) posts every comment to /api/engage/in?key=…
//      (key in app_kv engage_in_key; admins copy the link from Settings → Engagement into the scenario's HTTP step).
//      "Engage · Google reviews" is a webhook the worker calls every few hours (and on "Check now") with a one-time
//      token; Make lists each branch's reviews and answers on /api/make/callback (make_jobs kind "reviews").
// Out: replies go through "Engage · Instagram reply" / "Engage · Google review reply" (webhook → reply → callback),
//      tracked in make_jobs as kind reply_ig / reply_review, like publishing.
// The three webhook addresses and the "left to ManyChat" keywords live in app_kv engage_config.
// ---------------------------------------------------------------------------
const ENG_IG_USERNAME = "sanjugo_restaurant";
const ENG_BRANCH_BY_LOCATION = Object.fromEntries(Object.entries(GBP_LOCATIONS).map(([k, v]) => [`${GBP_ACCOUNT}/locations/${v}`, k]));
const ENG_STARS = { ONE: 1, TWO: 2, THREE: 3, FOUR: 4, FIVE: 5 };
const ENG_REVIEW_EVERY_MS = 4 * 3600e3;
const ENG_REPLY_TIMEOUT_MS = 10 * 60e3;
const ENG_REPLY_TIMEOUT_NOTE = "No answer from Make after 10 minutes — check the reply scenario is switched on.";
let engReady = false;

async function ensureEngTables(env) {
  if (engReady) return;
  for (const sql of [
    `CREATE TABLE IF NOT EXISTS eng_comments (id TEXT PRIMARY KEY, platform TEXT NOT NULL, media_id TEXT, parent_id TEXT, username TEXT, user_id TEXT, text TEXT,
      mine INTEGER NOT NULL DEFAULT 0, urgent INTEGER NOT NULL DEFAULT 0, status TEXT NOT NULL, received_at TEXT NOT NULL,
      reply_text TEXT, reply_state TEXT, reply_error TEXT, reply_id TEXT, replied_by TEXT, replied_at TEXT, done_by TEXT, done_at TEXT)`,
    "CREATE INDEX IF NOT EXISTS eng_comments_recv ON eng_comments (received_at)",
    "CREATE INDEX IF NOT EXISTS eng_comments_parent ON eng_comments (parent_id)",
    `CREATE TABLE IF NOT EXISTS eng_reviews (name TEXT PRIMARY KEY, location TEXT NOT NULL, branch TEXT, reviewer TEXT, photo TEXT, stars INTEGER, comment TEXT,
      created_at TEXT, updated_at TEXT, reply TEXT, reply_at TEXT, reply_state TEXT, reply_error TEXT, replied_by TEXT, first_seen TEXT NOT NULL, done_by TEXT, done_at TEXT)`,
    "CREATE INDEX IF NOT EXISTS eng_reviews_created ON eng_reviews (created_at)",
    `CREATE TABLE IF NOT EXISTS eng_stories (media_id TEXT PRIMARY KEY, reach INTEGER, views INTEGER, replies INTEGER, exits INTEGER, taps_forward INTEGER, taps_back INTEGER,
      posted_at TEXT, permalink TEXT, media_type TEXT, thumb TEXT, received_at TEXT NOT NULL)`,
    `CREATE TABLE IF NOT EXISTS comp_accounts (username TEXT PRIMARY KEY, label TEXT, kind TEXT, name TEXT, pic TEXT, bio TEXT, website TEXT, followers INTEGER, follows INTEGER,
      media_count INTEGER, error TEXT, checked_at TEXT, added_by TEXT, added_at TEXT NOT NULL)`,
    "CREATE TABLE IF NOT EXISTS comp_snaps (username TEXT NOT NULL, day TEXT NOT NULL, followers INTEGER, media_count INTEGER, PRIMARY KEY (username, day))",
    `CREATE TABLE IF NOT EXISTS comp_posts (username TEXT NOT NULL, post_id TEXT NOT NULL, permalink TEXT, caption TEXT, type TEXT, thumb TEXT, likes INTEGER, comments INTEGER,
      views INTEGER, posted_at TEXT, updated_at TEXT NOT NULL, PRIMARY KEY (username, post_id))`,
    "CREATE TABLE IF NOT EXISTS gbp_daily (location TEXT NOT NULL, day TEXT NOT NULL, metric TEXT NOT NULL, value INTEGER, PRIMARY KEY (location, day, metric))",
  ]) await env.DB.prepare(sql).run();
  engReady = true;
}

async function engConfig(env) {
  const c = (await kvGet(env, "engage_config")) || {};
  return { igReply: c.igReply || "", reviewsPull: c.reviewsPull || "", reviewReply: c.reviewReply || "", compPull: c.compPull || "", mapsPull: c.mapsPull || "",
    keywords: Array.isArray(c.keywords) ? c.keywords : [], updatedAt: c.updatedAt || null };
}
async function engInKey(env, rotate) {
  let s = rotate ? null : await kvGet(env, "engage_in_key");
  if (!s) {
    const b = new Uint8Array(18); crypto.getRandomValues(b);
    s = [...b].map((x) => x.toString(16).padStart(2, "0")).join("");
    await kvSet(env, "engage_in_key", s);
  }
  return s;
}
const engEscRe = (s) => String(s).replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
const engKeywordHit = (text, keywords) => keywords.find((k) => k && new RegExp("(^|[^\\p{L}\\p{N}])" + engEscRe(k) + "($|[^\\p{L}\\p{N}])", "iu").test(text));

// POST /api/engage/in?key=… — one Instagram comment from Make (no sign-in; the key proves it's our scenario).
async function engIn(request, env, url, ctx) {
  await ensureEngTables(env);
  const key = await kvGet(env, "engage_in_key");
  if (!key || !mcSame(request.headers.get("X-Sanjugo-Key") || url.searchParams.get("key"), key)) return json({ error: "Wrong key" }, 401);
  const raw = await request.text();
  if (raw.length > 60000) return json({ error: "Too big" }, 413);
  let b; try { b = JSON.parse(raw || "{}"); } catch (e) { return json({ error: "Send JSON" }, 400); }
  const now = new Date().toISOString();
  const field = String(b.field || "comments").slice(0, 30);
  if (field === "story_insights" || field === "story_media") {
    await kvSet(env, "engage_last_story", { at: now, field });
    return json(await engStoryIn(env, b, field, now));
  }
  await kvSet(env, "engage_last_in", { at: now, field });
  if (field !== "comments" && field !== "live_comments") return json({ ok: true, ignored: field });
  const id = String(b.id || "").trim();
  if (!/^\d{5,40}$/.test(id)) return json({ error: "No comment id" }, 400);
  const text = dec(b.text).slice(0, 2200);
  const username = String(b.from || "").replace(/^@/, "").trim().slice(0, 60);
  const mine = username.toLowerCase() === ENG_IG_USERNAME;
  const parent = /^\d{5,40}$/.test(String(b.parent || "")) ? String(b.parent) : null;
  const media = /^\d{5,40}$/.test(String(b.media || "")) ? String(b.media) : null;
  const cfg = await engConfig(env);
  const urgent = !mine && MC_URGENT.test(text) ? 1 : 0;
  const status = mine ? "answered" : !urgent && engKeywordHit(text, cfg.keywords) ? "manychat" : "new";
  const res = await env.DB.prepare(`INSERT OR IGNORE INTO eng_comments (id, platform, media_id, parent_id, username, user_id, text, mine, urgent, status, received_at)
    VALUES (?1, 'instagram', ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10)`)
    .bind(id, media, parent, username || null, String(b.fromId || "").slice(0, 40) || null, text, mine ? 1 : 0, urgent, status, now).run();
  // Our own reply — sent from Creator Studio or straight from the Instagram app — answers the comment it sits under.
  if (mine && parent) {
    await env.DB.prepare(`UPDATE eng_comments SET status = 'answered', reply_text = COALESCE(reply_text, ?2), reply_state = 'sent', reply_error = NULL,
      reply_id = COALESCE(reply_id, ?3), replied_at = COALESCE(replied_at, ?4) WHERE id = ?1 AND (status != 'answered' OR reply_state IS NULL OR reply_state != 'sent')`)
      .bind(parent, text, id, now).run();
  }
  if (urgent && res.meta && res.meta.changes) ctx.waitUntil(engAlert(env, {
    eventId: "eng_c_" + id, title: "⚠️ Instagram comment needs care",
    text: `⚠️ Instagram comment from @${username || "someone"} may need care: “${text.slice(0, 200)}” Reply in Engagement → Comments.`,
    body: "@" + (username || "someone") + ": " + text.slice(0, 140), url: "/#/engagement?tab=comments", tag: "eng-c-" + id,
  }).catch((e) => console.error("engage alert failed", e)));
  return json({ ok: true });
}

async function engAlert(env, { eventId, title, text, body, url, tag }) {
  const reviewers = await mcReviewers(env);
  const who = reviewers.map((r) => r.id);
  const posted = await postSystemChat(env, { text: text + " " + reviewers.map((r) => "@" + r.name).join(" "), mentions: who, eventId });
  if (posted) await pushToUsers(env, who, { title, body, url, tag }).catch(() => {});
}

async function engPullReviews(env, trigger) {
  const cfg = await engConfig(env);
  if (!cfg.reviewsPull) throw new HttpError(400, "Add the Google reviews webhook in Settings → Engagement first.");
  await ensureMakeTables(env);
  const id = "rev_" + crypto.randomUUID().slice(0, 12);
  const token = crypto.randomUUID() + crypto.randomUUID().slice(0, 8);
  const now = new Date().toISOString();
  await env.DB.prepare("INSERT INTO make_jobs (id, kind, token, status, trigger, detail, created_at, updated_at) VALUES (?1, 'reviews', ?2, 'sent', ?3, '{}', ?4, ?4)")
    .bind(id, token, trigger, now).run();
  await kvSet(env, "engage_reviews_pull", { at: now, id, trigger });
  try {
    await callHook(cfg.reviewsPull, { token, locations: Object.keys(ENG_BRANCH_BY_LOCATION).join(",") });
  } catch (e) {
    await env.DB.prepare("UPDATE make_jobs SET status = 'failed', error = ?2, updated_at = ?3 WHERE id = ?1").bind(id, e.message, now).run();
    await kvSet(env, "engage_reviews_pull", { at: now, id, trigger, error: e.message });
    throw e;
  }
  return { requestedAt: now };
}

// Every 5 minutes: fetch Google reviews every few hours (8am–10pm London) and give up on replies Make never answered.
async function engageCron(env) {
  await ensureEngTables(env);
  const cutoff = new Date(Date.now() - ENG_REPLY_TIMEOUT_MS).toISOString();
  await env.DB.batch([
    env.DB.prepare("UPDATE eng_comments SET reply_state = 'failed', reply_error = ?2 WHERE reply_state = 'sending' AND replied_at < ?1").bind(cutoff, ENG_REPLY_TIMEOUT_NOTE),
    env.DB.prepare("UPDATE eng_reviews SET reply_state = 'failed', reply_error = ?2 WHERE reply_state = 'sending' AND reply_at < ?1").bind(cutoff, ENG_REPLY_TIMEOUT_NOTE),
  ]);
  const cfg = await engConfig(env);
  await insightsCron(env, cfg).catch((e) => console.error("insights cron failed", e));
  if (!cfg.reviewsPull) return;
  const { hour } = londonClock();
  if (hour < 8 || hour >= 22) return;
  const last = await kvGet(env, "engage_reviews_pull");
  if (last && Date.now() - Date.parse(last.at || 0) < ENG_REVIEW_EVERY_MS) return;
  await engPullReviews(env, "auto");
}

// Make's answers for engagement jobs (called from handleMakeCallback).
async function engageCallback(env, job, body) {
  await ensureEngTables(env);
  const now = new Date().toISOString();
  if (job.kind === "reviews") {
    if (Date.now() - Date.parse(job.created_at) > 60 * 60e3) return json({ error: "Expired" }, 403);
    const location = String(body.location || "");
    if (!ENG_BRANCH_BY_LOCATION[location]) return json({ error: "Unknown location" }, 400);
    if (body.error) { // Google didn't answer for this branch — show it in Reviews / Settings instead of clearing anything
      const last = (await kvGet(env, "engage_reviews_pull")) || { at: now };
      const where = ENG_BRANCH_BY_LOCATION[location];
      last.error = (where.charAt(0).toUpperCase() + where.slice(1)) + ": " + dec(body.error).slice(0, 160);
      await kvSet(env, "engage_reviews_pull", last);
      return json({ ok: true });
    }
    let data = body.data;
    if (typeof data === "string") { try { data = JSON.parse(data); } catch (e) { data = null; } }
    data = data && typeof data === "object" ? data : {};
    const reviews = Array.isArray(data.reviews) ? data.reviews.slice(0, 100) : [];
    const branch = ENG_BRANCH_BY_LOCATION[location];
    const known = new Set(((await env.DB.prepare("SELECT name FROM eng_reviews WHERE location = ?1").bind(location).all()).results || []).map((r) => r.name));
    const firstTime = known.size === 0;
    const fresh = [];
    for (const r of reviews) {
      const name = String((r && r.name) || "");
      if (!name.startsWith(location + "/reviews/")) continue;
      const stars = ENG_STARS[r.starRating] || num(r.starRating) || null;
      const rr = r.reviewReply && r.reviewReply.comment ? r.reviewReply : null;
      const reviewer = r.reviewer || {};
      await env.DB.prepare(`INSERT INTO eng_reviews (name, location, branch, reviewer, photo, stars, comment, created_at, updated_at, reply, reply_at, reply_state, first_seen)
        VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?12, ?13)
        ON CONFLICT(name) DO UPDATE SET reviewer = excluded.reviewer, photo = excluded.photo, stars = excluded.stars, comment = excluded.comment,
          updated_at = excluded.updated_at,
          reply = CASE WHEN excluded.reply IS NOT NULL THEN excluded.reply ELSE eng_reviews.reply END,
          reply_at = CASE WHEN excluded.reply IS NOT NULL THEN excluded.reply_at ELSE eng_reviews.reply_at END,
          reply_state = CASE WHEN excluded.reply IS NOT NULL AND COALESCE(eng_reviews.reply_state, '') != 'sending' THEN 'sent' ELSE eng_reviews.reply_state END`)
        .bind(name, location, branch, String(reviewer.isAnonymous ? "A Google user" : reviewer.displayName || "A Google user").slice(0, 80),
          /^https:\/\//.test(String(reviewer.profilePhotoUrl || "")) ? String(reviewer.profilePhotoUrl).slice(0, 600) : null, stars,
          String(r.comment || "").slice(0, 4000) || null, toIsoDate(r.createTime), toIsoDate(r.updateTime),
          rr ? String(rr.comment).slice(0, 4096) : null, rr ? toIsoDate(rr.updateTime) : null, rr ? "sent" : null, now).run();
      if (!known.has(name)) fresh.push({ name, stars, reviewer: reviewer.displayName || "A Google user", comment: String(r.comment || ""), created: toIsoDate(r.createTime), replied: !!rr });
    }
    const summary = (await kvGet(env, "engage_review_summary")) || {};
    summary[location] = { avg: Number(data.averageRating) || null, total: num(data.totalReviewCount), at: now };
    await kvSet(env, "engage_review_summary", summary);
    let detail = {}; try { detail = JSON.parse(job.detail || "{}"); } catch (e) {}
    detail[branch] = reviews.length;
    await env.DB.prepare("UPDATE make_jobs SET status = 'done', detail = ?2, updated_at = ?3 WHERE id = ?1").bind(job.id, JSON.stringify(detail), now).run();
    // Tell Cyrus and Yan Yan about new 1–2 star reviews (not the old ones found on the very first check).
    if (!firstTime) for (const f of fresh.filter((x) => x.stars && x.stars <= 2 && !x.replied && Date.now() - Date.parse(x.created || 0) < 3 * 86400e3)) {
      const where = branch.charAt(0).toUpperCase() + branch.slice(1);
      await engAlert(env, {
        eventId: "eng_r_" + f.name.split("/").pop(), title: `⚠️ ${f.stars}★ Google review — ${where}`,
        text: `⚠️ New ${f.stars}★ Google review for ${where} from ${f.reviewer}${f.comment ? ": “" + f.comment.slice(0, 200) + "”" : "."} Reply in Engagement → Reviews.`,
        body: f.reviewer + (f.comment ? ": " + f.comment.slice(0, 140) : ""), url: "/#/engagement?tab=reviews", tag: "eng-r-" + f.name.split("/").pop(),
      }).catch(() => {});
    }
    return json({ ok: true, saved: reviews.length });
  }
  // A reply finished (or failed) in Make.
  if (job.status !== "sent") return json({ ok: true, duplicate: true });
  const ok = !body.error && body.ok !== false && body.ok !== "false";
  const error = ok ? null : dec(body.error || "Make couldn't post the reply").slice(0, 300);
  let detail = {}; try { detail = JSON.parse(job.detail || "{}"); } catch (e) {}
  await env.DB.prepare("UPDATE make_jobs SET status = ?2, post_id = ?3, error = ?4, updated_at = ?5 WHERE id = ?1")
    .bind(job.id, ok ? "done" : "failed", String(body.replyId || "").slice(0, 80) || null, error, now).run();
  if (job.kind === "reply_ig") {
    await env.DB.prepare(`UPDATE eng_comments SET reply_state = ?2, reply_error = ?3, reply_id = COALESCE(?4, reply_id), replied_at = ?5,
      status = CASE WHEN ?2 = 'sent' THEN 'answered' ELSE status END WHERE id = ?1`)
      .bind(job.content_id, ok ? "sent" : "failed", error, String(body.replyId || "").slice(0, 40) || null, now).run();
  } else if (job.kind === "reply_review") {
    if (ok) await env.DB.prepare("UPDATE eng_reviews SET reply = ?2, reply_at = ?3, reply_state = 'sent', reply_error = NULL WHERE name = ?1").bind(job.content_id, String(detail.text || "").slice(0, 4096), now).run();
    else await env.DB.prepare("UPDATE eng_reviews SET reply_state = 'failed', reply_error = ?2 WHERE name = ?1").bind(job.content_id, error).run();
  }
  return json({ ok: true });
}

const ENG_COMMENT_SYSTEM = `You reply to Instagram comments for SANJUGO, a modern Japanese comfort restaurant group in London (Shoreditch, Angel, Victoria).
Style: one short, funny line plus one or two emoji. Playful and human, never corporate, no long thank-yous. Moves that work: let the dish speak as a character ("Accepting this on behalf of the Unagi Don 🥹🥇", "The rice would like to thank its agent 🍚🥇"), or hand the praise to the chef ("Passing this straight to our chef 🥇👨‍🍳" — say "they" for the chef). Riff on the comment or the post.
Rules: You don't know the menu, prices, which branch serves what, opening times or offers. If the comment asks any question like that, don't answer the fact — keep it warm, invite them to DM us, and put the question in "check". Never say a video has no AI or isn't edited — if someone asks about AI or a prompt, say the food is real, keep it light, and set "check" so the team confirms how the video was made. Never invent prices, dates, offers, opening times or menu items. Bookings, allergies, complaints or anything serious: be kind, no jokes, ask them to send us a DM, and set "check". Don't use: amazing, best ever, must try, OMG, epic, crazy, insane, cheap, deal, platter. Reply in the comment's language.
Answer with JSON only: {"pick":"the best reply","alts":["another option","another option"],"check":"what the team should check, or empty"}`;
const ENG_REVIEW_SYSTEM = `You write replies to Google reviews for SANJUGO, a modern Japanese comfort restaurant group in London.
Voice: warm, simple, human and quietly confident ("luxury brands never panic"). 2 to 4 short sentences. Thank the guest by first name when you have it and mention one specific thing they said.
4–5 stars: grateful and warm, end with a soft invitation back ("We'll save you a seat."). 1–3 stars: thank them, apologise sincerely for what went wrong without excuses or arguing, say the team will look into it, and invite them to get in touch so we can put it right — never invent an email address or phone number. A rating with no text: one or two warm sentences.
Never offer refunds, discounts or free food. Never invent facts. Say "guests", never customers. Don't use: amazing, best ever, must try, OMG, epic, crazy, insane, cheap, discount, deal. Sign off "— The SANJUGO team". Reply in the review's language.
Answer with JSON only: {"pick":"the best reply","alts":["another option"],"check":"anything the manager should check first, or empty"}`;

function engParseDraft(raw) {
  const s = String(raw || "").trim();
  const m = s.match(/\{[\s\S]*\}/);
  let d = null;
  if (m) { try { d = JSON.parse(m[0]); } catch (e) {} }
  const clean = (t) => { t = String(t || "").trim(); return t ? tidyBotText(t).replace(/^["“]|["”]$/g, "").slice(0, 2000) : ""; };
  if (d && d.pick) return { pick: clean(d.pick), alts: (Array.isArray(d.alts) ? d.alts : []).map(clean).filter(Boolean).slice(0, 3), check: clean(d.check || "").slice(0, 300) };
  return { pick: clean(s.replace(/^\{|\}$/g, "")), alts: [], check: "" };
}

function engCommentOut(r) {
  return { id: r.id, mediaId: r.media_id, parentId: r.parent_id, username: r.username || "", text: r.text || "", mine: !!r.mine, urgent: !!r.urgent,
    status: r.status, receivedAt: r.received_at, replyText: r.reply_text || "", replyState: r.reply_state || null, replyError: r.reply_error || null,
    repliedBy: r.replied_by || null, repliedAt: r.replied_at || null, doneBy: r.done_by || null,
    post: r.sp_permalink || r.sp_caption || r.sp_thumb ? { permalink: r.sp_permalink || "", caption: r.sp_caption || "", thumb: r.sp_thumb || "", type: r.sp_type || "" } : null };
}
function engReviewOut(r) {
  return { name: r.name, branch: r.branch, reviewer: r.reviewer || "A Google user", photo: r.photo || "", stars: r.stars, comment: r.comment || "",
    createdAt: r.created_at, updatedAt: r.updated_at, reply: r.reply || "", replyAt: r.reply_at || null, replyState: r.reply_state || null,
    replyError: r.reply_error || null, repliedBy: r.replied_by || null, done: !!r.done_at, doneBy: r.done_by || null };
}

async function engageRoute(request, env, url, viewer, ctx) {
  await ensureEngTables(env);
  if (viewer.accessEnabled && !viewer.member) throw new HttpError(401, "Sign in first.");
  const role = viewer.member ? viewer.member.role : "admin";
  if (role === "video") throw new HttpError(403, "Engagement isn't part of your role.");
  const isAdmin = !viewer.accessEnabled || role === "admin";
  const isReviewer = !viewer.accessEnabled || role === "admin" || role === "approver";
  const path = url.pathname.replace(/^\/api\/engage\/?/, "");
  const GET = request.method === "GET", POST = request.method === "POST";
  const body = POST ? await request.json().catch(() => ({})) : {};
  const by = viewer.member ? viewer.member.id : String(body.userId || "").slice(0, 64) || null;
  const now = new Date().toISOString();
  const recent = new Date(Date.now() - 30 * 86400e3).toISOString();

  if (GET && (path === "" || path === "count")) {
    const [c, r, mc, cfg, lastIn, lastPull, summary] = await Promise.all([
      env.DB.prepare("SELECT SUM(status = 'new') AS todo, SUM(status = 'new' AND urgent = 1) AS urgent, SUM(status = 'manychat') AS manychat, SUM(status = 'answered' AND replied_at >= ?1) AS answered7, COUNT(*) AS total FROM eng_comments WHERE mine = 0")
        .bind(new Date(Date.now() - 7 * 86400e3).toISOString()).first(),
      env.DB.prepare("SELECT SUM(reply IS NULL AND done_at IS NULL AND created_at >= ?1) AS todo, SUM(reply IS NULL AND done_at IS NULL AND stars <= 2 AND created_at >= ?1) AS low, COUNT(*) AS total FROM eng_reviews").bind(recent).first(),
      ensureMcTables(env).then(() => env.DB.prepare("SELECT COUNT(*) AS n, SUM(urgent) AS urgent FROM mc_handover WHERE status = 'open'").first()),
      engConfig(env), kvGet(env, "engage_last_in"), kvGet(env, "engage_reviews_pull"), kvGet(env, "engage_review_summary"),
    ]);
    const out = {
      comments: { todo: c.todo || 0, urgent: c.urgent || 0, manychat: c.manychat || 0, answered7: c.answered7 || 0, total: c.total || 0 },
      reviews: { todo: r.todo || 0, low: r.low || 0, total: r.total || 0 },
      handover: { open: mc.n || 0, urgent: mc.urgent || 0 },
      badge: (c.urgent || 0) + (r.todo || 0) + (mc.n || 0), badgeUrgent: !!((c.urgent || 0) + (r.low || 0) + (mc.urgent || 0)),
    };
    if (path === "count") return json(out);
    return json({ ...out, setup: { comments: !!lastIn, igReply: !!cfg.igReply, reviews: !!cfg.reviewsPull, reviewReply: !!cfg.reviewReply },
      lastIn, lastPull, summary: Object.fromEntries(Object.entries(summary || {}).map(([loc, s]) => [ENG_BRANCH_BY_LOCATION[loc] || loc, s])) });
  }

  // ---- Settings (admins) ----
  if (GET && path === "config") {
    if (!isAdmin) throw new HttpError(403, "Only admins can see this.");
    const [cfg, key, lastIn, lastPull, lastStory, lastComp, lastMaps] = await Promise.all([engConfig(env), engInKey(env), kvGet(env, "engage_last_in"), kvGet(env, "engage_reviews_pull"),
      kvGet(env, "engage_last_story"), kvGet(env, "engage_comp_pull"), kvGet(env, "engage_maps_pull")]);
    return json({ ...cfg, inLink: mcBase(env, url) + "/api/engage/in?key=" + key, lastIn, lastPull, lastStory, lastComp, lastMaps });
  }
  if (POST && path === "config") {
    if (!isAdmin) throw new HttpError(403, "Only admins can change this.");
    const cfg = await engConfig(env);
    for (const k of ["igReply", "reviewsPull", "reviewReply", "compPull", "mapsPull"]) {
      if (body[k] === undefined) continue;
      const v = String(body[k] || "").trim();
      if (v && !MAKE_HOOK_RE.test(v)) throw new HttpError(400, "That doesn't look like a Make webhook address (https://hook.eu1.make.com/…).");
      cfg[k] = v;
    }
    if (body.keywords !== undefined) cfg.keywords = String(body.keywords || "").split(/[,\n]/).map((k) => k.trim().toUpperCase()).filter((k) => k.length >= 2).slice(0, 40);
    cfg.updatedAt = now;
    await kvSet(env, "engage_config", cfg);
    return json({ ok: true, ...cfg });
  }
  if (POST && path === "config/rotate") {
    if (!isAdmin) throw new HttpError(403, "Only admins can change this.");
    return json({ inLink: mcBase(env, url) + "/api/engage/in?key=" + (await engInKey(env, true)) });
  }

  // ---- Comments ----
  if (GET && path === "comments") {
    const filter = url.searchParams.get("filter") || "todo";
    const where = { todo: "c.status = 'new'", urgent: "c.status = 'new' AND c.urgent = 1", answered: "c.status = 'answered'", manychat: "c.status = 'manychat'", done: "c.status = 'done'", all: "1 = 1" }[filter] || "c.status = 'new'";
    const order = filter === "todo" || filter === "urgent" ? "c.urgent DESC, c.received_at DESC" : "c.received_at DESC";
    await ensureMakeTables(env);
    const { results } = await env.DB.prepare(`SELECT c.*, sp.permalink AS sp_permalink, sp.caption AS sp_caption, sp.thumb AS sp_thumb, sp.type AS sp_type
      FROM eng_comments c LEFT JOIN social_posts sp ON sp.platform = 'instagram' AND sp.post_id = c.media_id
      WHERE c.mine = 0 AND ${where} ORDER BY ${order} LIMIT 150`).all();
    const items = (results || []).map(engCommentOut);
    // Our replies under these comments (sent from here or from the Instagram app).
    const ids = items.map((i) => i.id);
    let mine = [];
    if (ids.length) {
      const q = await env.DB.prepare(`SELECT id, parent_id, text, received_at FROM eng_comments WHERE mine = 1 AND parent_id IN (${ids.map(() => "?").join(",")})`).bind(...ids).all();
      mine = q.results || [];
    }
    const byParent = {};
    for (const m of mine) (byParent[m.parent_id] = byParent[m.parent_id] || []).push({ id: m.id, text: m.text, at: m.received_at });
    return json({ items: items.map((i) => ({ ...i, ourReplies: byParent[i.id] || [] })), keywords: (await engConfig(env)).keywords });
  }
  if (POST && (path === "comments/done" || path === "comments/reopen")) {
    const id = String(body.id || "");
    if (path === "comments/done") await env.DB.prepare("UPDATE eng_comments SET status = 'done', done_by = ?2, done_at = ?3 WHERE id = ?1 AND status IN ('new', 'manychat')").bind(id, by, now).run();
    else await env.DB.prepare("UPDATE eng_comments SET status = 'new', done_by = NULL, done_at = NULL WHERE id = ?1 AND status IN ('done', 'manychat')").bind(id).run();
    return json({ ok: true });
  }
  if (POST && path === "comments/done-emoji") {
    // Emoji-only comments ("🔥🔥", "😍") rarely need an answer — clear them in one go.
    const { results } = await env.DB.prepare("SELECT id, text FROM eng_comments WHERE status = 'new' AND mine = 0 AND urgent = 0 LIMIT 500").all();
    const ids = (results || []).filter((r) => !/[\p{L}\p{N}]/u.test(r.text || "")).map((r) => r.id);
    if (ids.length) await env.DB.batch(ids.map((id) => env.DB.prepare("UPDATE eng_comments SET status = 'done', done_by = ?2, done_at = ?3 WHERE id = ?1").bind(id, by, now)));
    return json({ cleared: ids.length });
  }

  // ---- Reviews ----
  if (GET && path === "reviews") {
    const filter = url.searchParams.get("filter") || "todo";
    const branch = url.searchParams.get("branch") || "";
    const where = { todo: "reply IS NULL AND done_at IS NULL", low: "stars <= 3", replied: "reply IS NOT NULL", all: "1 = 1" }[filter] || "reply IS NULL AND done_at IS NULL";
    const { results } = await env.DB.prepare(`SELECT * FROM eng_reviews WHERE ${where} AND (?1 = '' OR branch = ?1) ORDER BY created_at DESC LIMIT 150`).bind(branch).all();
    const summary = (await kvGet(env, "engage_review_summary")) || {};
    return json({ items: (results || []).map(engReviewOut), lastPull: await kvGet(env, "engage_reviews_pull"),
      summary: Object.fromEntries(Object.entries(summary).map(([loc, s]) => [ENG_BRANCH_BY_LOCATION[loc] || loc, s])) });
  }
  if (POST && path === "reviews/pull") return json(await engPullReviews(env, "manual"));
  if (POST && (path === "reviews/done" || path === "reviews/reopen")) {
    if (!isReviewer) throw new HttpError(403, "Only admins and approvers can do that.");
    const name = String(body.name || "");
    if (path === "reviews/done") await env.DB.prepare("UPDATE eng_reviews SET done_by = ?2, done_at = ?3 WHERE name = ?1").bind(name, by, now).run();
    else await env.DB.prepare("UPDATE eng_reviews SET done_by = NULL, done_at = NULL WHERE name = ?1").bind(name).run();
    return json({ ok: true });
  }

  // ---- Keyword DM stats, stories, competitors, Google Maps ----
  if (GET && path === "keywords") return json(await engKeywordStats(env, url));
  if (GET && path === "stories") return json(await engStories(env, url));
  if (GET && path === "comp") return json(await compList(env));
  if (POST && path === "comp/add") {
    if (!isAdmin) throw new HttpError(403, "Only admins can change the list.");
    const u = String(body.username || "").trim().replace(/^@/, "").replace(/^https?:\/\/(www\.)?instagram\.com\//i, "").replace(/[/?#].*$/, "").toLowerCase();
    if (!/^[a-z0-9._]{1,30}$/.test(u)) throw new HttpError(400, "That doesn't look like an Instagram username.");
    if (u === ENG_IG_USERNAME) throw new HttpError(400, "That's us.");
    const n = await env.DB.prepare("SELECT COUNT(*) AS n FROM comp_accounts").first();
    if (n.n >= 20) throw new HttpError(400, "Watch up to 20 accounts — remove one first.");
    const kind = body.kind === "creator" ? "creator" : "competitor";
    await env.DB.prepare("INSERT INTO comp_accounts (username, label, kind, added_by, added_at) VALUES (?1, ?2, ?3, ?4, ?5) ON CONFLICT(username) DO UPDATE SET label = excluded.label, kind = excluded.kind")
      .bind(u, String(body.label || "").trim().slice(0, 60) || null, kind, by, now).run();
    const cfg = await engConfig(env);
    if (cfg.compPull) await compPull(env, "added", [u]).catch(() => {});
    return json(await compList(env));
  }
  if (POST && path === "comp/remove") {
    if (!isAdmin) throw new HttpError(403, "Only admins can change the list.");
    const u = String(body.username || "");
    await env.DB.batch(["comp_accounts", "comp_snaps", "comp_posts"].map((t) => env.DB.prepare(`DELETE FROM ${t} WHERE username = ?1`).bind(u)));
    return json(await compList(env));
  }
  if (POST && path === "comp/pull") return json(await compPull(env, "manual"));
  if (GET && path === "maps") return json(await mapsSummary(env));
  if (POST && path === "maps/pull") return json(await mapsPull(env, "manual"));

  // ---- AI drafts + sending replies ----
  if (POST && path === "draft") {
    if (body.kind === "review") {
      const r = await env.DB.prepare("SELECT * FROM eng_reviews WHERE name = ?1").bind(String(body.id || "")).first();
      if (!r) throw new HttpError(404, "Review not found");
      const where = r.branch ? r.branch.charAt(0).toUpperCase() + r.branch.slice(1) : "one of our";
      const user = `Branch: SANJUGO ${where}\nGuest: ${r.reviewer}\nStars: ${r.stars || "?"} of 5\nReview: ${r.comment || "(no text, just the rating)"}${body.current ? "\nCurrent draft (improve it): " + String(body.current).slice(0, 800) : ""}`;
      return json(engParseDraft(await aiText(env, ENG_REVIEW_SYSTEM, user, 600)));
    }
    await ensureMakeTables(env);
    const c = await env.DB.prepare(`SELECT c.*, sp.caption AS sp_caption FROM eng_comments c LEFT JOIN social_posts sp ON sp.platform = 'instagram' AND sp.post_id = c.media_id WHERE c.id = ?1`).bind(String(body.id || "")).first();
    if (!c) throw new HttpError(404, "Comment not found");
    const user = `Post caption: ${String(c.sp_caption || "(unknown)").slice(0, 600)}\nComment from @${c.username || "someone"}: ${c.text || ""}${body.current ? "\nCurrent draft (improve it): " + String(body.current).slice(0, 400) : ""}`;
    return json(engParseDraft(await aiText(env, ENG_COMMENT_SYSTEM, user, 400)));
  }
  if (POST && path === "reply") {
    const kind = body.kind === "review" ? "review" : "comment";
    const text = String(body.text || "").replace(/\r\n/g, "\n").trim();
    if (!text) throw new HttpError(400, "Write a reply first.");
    const cfg = await engConfig(env);
    await ensureMakeTables(env);
    const jobId = "rpl_" + crypto.randomUUID().slice(0, 12);
    const token = crypto.randomUUID() + crypto.randomUUID().slice(0, 8);
    let hook, payload;
    if (kind === "comment") {
      if (text.length > 2200) throw new HttpError(400, "Instagram replies can be up to 2,200 characters.");
      const c = await env.DB.prepare("SELECT * FROM eng_comments WHERE id = ?1").bind(String(body.id || "")).first();
      if (!c || c.mine) throw new HttpError(404, "Comment not found");
      if (c.reply_state === "sending") throw new HttpError(409, "A reply is already on its way.");
      if (!cfg.igReply) throw new HttpError(400, "Add the Instagram reply webhook in Settings → Engagement first.");
      hook = cfg.igReply; payload = { token, commentId: c.id, message: text };
      await env.DB.prepare("UPDATE eng_comments SET reply_text = ?2, reply_state = 'sending', reply_error = NULL, replied_by = ?3, replied_at = ?4 WHERE id = ?1").bind(c.id, text, by, now).run();
    } else {
      if (!isReviewer) throw new HttpError(403, "Only admins and approvers can reply to Google reviews.");
      if (text.length > 4096) throw new HttpError(400, "Google replies can be up to 4,096 characters.");
      const r = await env.DB.prepare("SELECT * FROM eng_reviews WHERE name = ?1").bind(String(body.id || "")).first();
      if (!r) throw new HttpError(404, "Review not found");
      if (r.reply_state === "sending") throw new HttpError(409, "A reply is already on its way.");
      if (!cfg.reviewReply) throw new HttpError(400, "Add the Google review reply webhook in Settings → Engagement first.");
      hook = cfg.reviewReply; payload = { token, review: r.name, comment: text };
      await env.DB.prepare("UPDATE eng_reviews SET reply_state = 'sending', reply_error = NULL, replied_by = ?2, reply_at = ?3 WHERE name = ?1").bind(r.name, by, now).run();
    }
    const contentId = String(body.id || "");
    await env.DB.prepare("INSERT INTO make_jobs (id, kind, content_id, platform, token, status, requested_by, trigger, detail, created_at, updated_at) VALUES (?1, ?2, ?3, ?4, ?5, 'sent', ?6, 'manual', ?7, ?8, ?8)")
      .bind(jobId, kind === "comment" ? "reply_ig" : "reply_review", contentId, kind === "comment" ? "instagram" : "gbp", token, by, JSON.stringify({ text }), now).run();
    try {
      await callHook(hook, payload);
    } catch (e) {
      await env.DB.prepare("UPDATE make_jobs SET status = 'failed', error = ?2, updated_at = ?3 WHERE id = ?1").bind(jobId, e.message, now).run();
      if (kind === "comment") await env.DB.prepare("UPDATE eng_comments SET reply_state = 'failed', reply_error = ?2 WHERE id = ?1").bind(contentId, e.message).run();
      else await env.DB.prepare("UPDATE eng_reviews SET reply_state = 'failed', reply_error = ?2 WHERE name = ?1").bind(contentId, e.message).run();
      throw e;
    }
    return json({ ok: true, sending: true });
  }
  throw new HttpError(404, "Unknown request");
}

async function engPrune(env) {
  await ensureEngTables(env);
  const iso = new Date(Date.now() - MC_KEEP_DAYS * 86400e3).toISOString();
  await env.DB.prepare("DELETE FROM eng_comments WHERE received_at < ?1").bind(iso).run();
}

// ---------------------------------------------------------------------------
// Insights (Engagement → Keywords / Insights): keyword DM stats, Instagram story stats, competitor & creator watch
// and Google Maps actions per branch.
// - Keywords: counted from the Instagram comments we already receive (eng_comments) against the "Left to ManyChat"
//   keywords, next to clicks on tracked links that carry the same keyword (mc_links.keyword).
// - Stories: "Engage · Instagram story stats" (Instagram story_insights event, sent when a story ends) posts to the
//   same /api/engage/in link, then the story's details (field story_media).
// - Competitors: "Engage · Competitors" webhook, called every 3 days (and on Check now) with a one-time token and the
//   usernames; Make looks each up with Instagram business discovery and answers on /api/make/callback (kind comp).
// - Google Maps: "Engage · Google Maps stats" webhook, called every Monday (and on Check now); Make asks the Business
//   Profile Performance API for each branch's daily numbers and answers on /api/make/callback (kind maps).
// ---------------------------------------------------------------------------
const MAPS_METRICS = ["CALL_CLICKS", "BUSINESS_DIRECTION_REQUESTS", "WEBSITE_CLICKS", "BUSINESS_BOOKINGS", "BUSINESS_FOOD_ORDERS", "BUSINESS_FOOD_MENU_CLICKS",
  "BUSINESS_IMPRESSIONS_MOBILE_MAPS", "BUSINESS_IMPRESSIONS_MOBILE_SEARCH", "BUSINESS_IMPRESSIONS_DESKTOP_MAPS", "BUSINESS_IMPRESSIONS_DESKTOP_SEARCH"];
const MAPS_LOCATIONS = Object.fromEntries(Object.entries(GBP_LOCATIONS).map(([k, v]) => ["locations/" + v, k]));
const COMP_EVERY_MS = 3 * 86400e3 - 2 * 3600e3;

async function engKeywordStats(env, url) {
  await ensureEngTables(env); await ensureMcTables(env); await ensureMakeTables(env);
  const days = Math.min(365, Math.max(1, Number(url.searchParams.get("days")) || 30));
  const since = new Date(Date.now() - days * 86400e3).toISOString(), sinceDay = londonDay(Date.now() - (days - 1) * 86400e3);
  const cfg = await engConfig(env);
  const { results: rows } = await env.DB.prepare("SELECT media_id, username, text FROM eng_comments WHERE mine = 0 AND received_at >= ?1 ORDER BY received_at DESC LIMIT 20000").bind(since).all();
  const by = new Map();
  for (const r of rows || []) {
    const k = engKeywordHit(r.text || "", cfg.keywords);
    if (!k) continue;
    if (!by.has(k)) by.set(k, { keyword: k, comments: 0, people: new Set(), posts: new Map() });
    const e = by.get(k); e.comments++; if (r.username) e.people.add(r.username);
    e.posts.set(r.media_id || "?", (e.posts.get(r.media_id || "?") || 0) + 1);
  }
  const [{ results: links }, { results: clicks }] = await Promise.all([
    env.DB.prepare("SELECT code, name, keyword FROM mc_links WHERE deleted = 0 AND keyword IS NOT NULL AND keyword != ''").all(),
    env.DB.prepare("SELECT code, COUNT(*) AS n, COUNT(DISTINCT sub_id) AS people FROM mc_clicks WHERE day >= ?1 GROUP BY code").bind(sinceDay).all(),
  ]);
  const clickBy = new Map((clicks || []).map((c) => [c.code, c]));
  const mediaIds = [...new Set([...by.values()].flatMap((e) => [...e.posts.keys()]).filter((m) => m !== "?"))].slice(0, 90);
  const postInfo = new Map();
  if (mediaIds.length) {
    const { results } = await env.DB.prepare(`SELECT post_id, permalink, caption, thumb, published_at FROM social_posts WHERE platform = 'instagram' AND post_id IN (${mediaIds.map(() => "?").join(",")})`).bind(...mediaIds).all();
    for (const p of results || []) postInfo.set(p.post_id, p);
  }
  const all = new Set([...cfg.keywords, ...by.keys(), ...(links || []).map((l) => String(l.keyword).toUpperCase())]);
  const out = [...all].map((k) => {
    const e = by.get(k) || { comments: 0, people: new Set(), posts: new Map() };
    const ls = (links || []).filter((l) => String(l.keyword).toUpperCase() === k).map((l) => ({ code: l.code, name: l.name, clicks: (clickBy.get(l.code) || {}).n || 0, people: (clickBy.get(l.code) || {}).people || 0 }));
    const clicksN = ls.reduce((a, l) => a + l.clicks, 0);
    // Rate = people who clicked ÷ people who commented (falls back to clicks when ManyChat can't pass the contact id). Never above 100%.
    const clickers = ls.reduce((a, l) => a + l.people, 0) || clicksN;
    return { keyword: k, comments: e.comments, people: e.people.size, links: ls, clicks: clicksN, clickRate: e.people.size && ls.length ? Math.min(100, Math.round((clickers / e.people.size) * 100)) : null,
      posts: [...e.posts.entries()].sort((a, b) => b[1] - a[1]).slice(0, 8).map(([m, n]) => { const p = postInfo.get(m) || {};
        return { mediaId: m, comments: n, permalink: p.permalink || "", caption: (p.caption || "").slice(0, 120), thumb: p.thumb || "", at: p.published_at || null }; }) };
  }).sort((a, b) => b.comments - a.comments || a.keyword.localeCompare(b.keyword));
  return { days, keywords: out, configured: cfg.keywords };
}

async function engStoryIn(env, b, field, now) {
  await ensureEngTables(env);
  const id = String(b.media_id || b.id || "").trim();
  if (!/^\d{5,40}$/.test(id)) return { error: "No story id" };
  const n = (v) => (v === undefined || v === null || v === "" ? null : num(v));
  if (field === "story_insights") {
    await env.DB.prepare(`INSERT INTO eng_stories (media_id, reach, views, replies, exits, taps_forward, taps_back, received_at) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8)
      ON CONFLICT(media_id) DO UPDATE SET reach = excluded.reach, views = excluded.views, replies = excluded.replies, exits = excluded.exits,
        taps_forward = excluded.taps_forward, taps_back = excluded.taps_back, received_at = excluded.received_at`)
      .bind(id, n(b.reach), n(b.impressions ?? b.views), n(b.replies), n(b.exits), n(b.taps_forward), n(b.taps_back), now).run();
  } else {
    const thumb = dec(b.thumb || b.media_url || "");
    await env.DB.prepare(`INSERT INTO eng_stories (media_id, posted_at, permalink, media_type, thumb, received_at) VALUES (?1, ?2, ?3, ?4, ?5, ?6)
      ON CONFLICT(media_id) DO UPDATE SET posted_at = excluded.posted_at, permalink = excluded.permalink, media_type = excluded.media_type, thumb = COALESCE(NULLIF(excluded.thumb, ''), eng_stories.thumb)`)
      .bind(id, toIsoDate(b.timestamp), String(b.permalink || "").slice(0, 300) || null, String(b.media_type || "").slice(0, 20) || null, /^https:\/\//.test(thumb) ? thumb.slice(0, 1500) : null, now).run();
  }
  return { ok: true };
}

async function engStories(env, url) {
  await ensureEngTables(env);
  const days = Math.min(365, Math.max(1, Number(url.searchParams.get("days")) || 60));
  const since = new Date(Date.now() - days * 86400e3).toISOString();
  const { results } = await env.DB.prepare("SELECT * FROM eng_stories WHERE COALESCE(posted_at, received_at) >= ?1 ORDER BY COALESCE(posted_at, received_at) DESC LIMIT 200").bind(since).all();
  const stories = (results || []).map((r) => ({ id: r.media_id, reach: r.reach, views: r.views, replies: r.replies, exits: r.exits, tapsForward: r.taps_forward, tapsBack: r.taps_back,
    postedAt: r.posted_at || r.received_at, permalink: r.permalink || "", type: r.media_type || "", thumb: r.thumb || "" }));
  const withReach = stories.filter((s) => s.reach != null);
  const avg = (k) => withReach.length ? Math.round(withReach.reduce((a, s) => a + (s[k] || 0), 0) / withReach.length) : null;
  return { days, stories, last: await kvGet(env, "engage_last_story"), avg: { reach: avg("reach"), replies: avg("replies"), exits: avg("exits"), tapsForward: avg("tapsForward") } };
}

// ---- Competitor & creator watch ----
async function compPull(env, trigger, only) {
  const cfg = await engConfig(env);
  if (!cfg.compPull) throw new HttpError(400, "Add the Competitors webhook in Settings → Engagement first.");
  await ensureEngTables(env); await ensureMakeTables(env);
  const users = only || ((await env.DB.prepare("SELECT username FROM comp_accounts ORDER BY added_at").all()).results || []).map((r) => r.username);
  if (!users.length) throw new HttpError(400, "Add an account to watch first.");
  const id = "comp_" + crypto.randomUUID().slice(0, 12), token = crypto.randomUUID() + crypto.randomUUID().slice(0, 8), now = new Date().toISOString();
  await env.DB.prepare("INSERT INTO make_jobs (id, kind, token, status, trigger, detail, created_at, updated_at) VALUES (?1, 'comp', ?2, 'sent', ?3, '{}', ?4, ?4)").bind(id, token, trigger, now).run();
  if (!only) await kvSet(env, "engage_comp_pull", { at: now, trigger });
  try { await callHook(cfg.compPull, { token, usernames: users.join(",") }); }
  catch (e) { if (!only) await kvSet(env, "engage_comp_pull", { at: now, trigger, error: e.message }); throw e; }
  return { requestedAt: now, accounts: users.length };
}

async function compList(env) {
  await ensureEngTables(env);
  const { results: accts } = await env.DB.prepare("SELECT * FROM comp_accounts ORDER BY COALESCE(followers, 0) DESC").all();
  const weekAgo = londonDay(Date.now() - 7 * 86400e3), monthAgo = londonDay(Date.now() - 30 * 86400e3);
  const since30 = new Date(Date.now() - 30 * 86400e3).toISOString();
  const out = [];
  for (const a of accts || []) {
    const [w, m, posts] = await Promise.all([
      env.DB.prepare("SELECT followers FROM comp_snaps WHERE username = ?1 AND day <= ?2 ORDER BY day DESC LIMIT 1").bind(a.username, weekAgo).first(),
      env.DB.prepare("SELECT followers FROM comp_snaps WHERE username = ?1 AND day <= ?2 ORDER BY day DESC LIMIT 1").bind(a.username, monthAgo).first(),
      env.DB.prepare("SELECT * FROM comp_posts WHERE username = ?1 ORDER BY posted_at DESC LIMIT 12").bind(a.username).all(),
    ]);
    const ps = (posts.results || []).map((p) => ({ id: p.post_id, permalink: p.permalink || "", caption: p.caption || "", type: p.type || "", thumb: p.thumb || "",
      likes: p.likes || 0, comments: p.comments || 0, views: p.views || 0, at: p.posted_at }));
    const avgLikes = ps.length ? Math.round(ps.reduce((s, p) => s + p.likes, 0) / ps.length) : null;
    const avgComments = ps.length ? Math.round(ps.reduce((s, p) => s + p.comments, 0) / ps.length) : null;
    out.push({ username: a.username, label: a.label || "", kind: a.kind || "competitor", name: a.name || "", pic: a.pic || "", bio: a.bio || "", website: a.website || "",
      followers: a.followers, mediaCount: a.media_count, error: a.error || null, checkedAt: a.checked_at,
      followers7: w && a.followers != null ? a.followers - w.followers : null, followers30: m && a.followers != null ? a.followers - m.followers : null,
      posts30: ps.filter((p) => p.at && p.at >= since30).length, avgLikes, avgComments,
      engagement: a.followers && ps.length ? Math.round(((avgLikes + avgComments) / a.followers) * 10000) / 100 : null,
      top: ps.slice().sort((x, y) => (y.likes + y.comments) - (x.likes + x.comments))[0] || null, posts: ps });
  }
  return { accounts: out, last: await kvGet(env, "engage_comp_pull") };
}

// ---- Google Maps actions per branch ----
async function mapsPull(env, trigger) {
  const cfg = await engConfig(env);
  if (!cfg.mapsPull) throw new HttpError(400, "Add the Google Maps webhook in Settings → Engagement first.");
  await ensureEngTables(env); await ensureMakeTables(env);
  const id = "maps_" + crypto.randomUUID().slice(0, 12), token = crypto.randomUUID() + crypto.randomUUID().slice(0, 8), now = new Date().toISOString();
  // Google's numbers arrive a few days late, so ask for the last 60 days each time (older days get corrected too).
  const end = new Date(Date.now() - 86400e3), start = new Date(Date.now() - 60 * 86400e3);
  await env.DB.prepare("INSERT INTO make_jobs (id, kind, token, status, trigger, detail, created_at, updated_at) VALUES (?1, 'maps', ?2, 'sent', ?3, '{}', ?4, ?4)").bind(id, token, trigger, now).run();
  await kvSet(env, "engage_maps_pull", { at: now, trigger });
  try {
    await callHook(cfg.mapsPull, { token, locations: Object.keys(MAPS_LOCATIONS).join(","), metrics: MAPS_METRICS.join(","),
      sy: start.getUTCFullYear(), sm: start.getUTCMonth() + 1, sd: start.getUTCDate(), ey: end.getUTCFullYear(), em: end.getUTCMonth() + 1, ed: end.getUTCDate() });
  } catch (e) { await kvSet(env, "engage_maps_pull", { at: now, trigger, error: e.message }); throw e; }
  return { requestedAt: now };
}

async function mapsSummary(env) {
  await ensureEngTables(env);
  const from = londonDay(Date.now() - 70 * 86400e3);
  const { results } = await env.DB.prepare("SELECT location, day, metric, value FROM gbp_daily WHERE day >= ?1").bind(from).all();
  const lastDay = (results || []).reduce((m, r) => (r.day > m ? r.day : m), "");
  const dayShift = (d, n) => { const t = new Date(d + "T12:00:00Z"); t.setUTCDate(t.getUTCDate() + n); return t.toISOString().slice(0, 10); };
  const cur0 = lastDay ? dayShift(lastDay, -27) : "", prev0 = lastDay ? dayShift(lastDay, -55) : "", prev1 = lastDay ? dayShift(lastDay, -28) : "";
  const group = { calls: ["CALL_CLICKS"], directions: ["BUSINESS_DIRECTION_REQUESTS"], website: ["WEBSITE_CLICKS"], bookings: ["BUSINESS_BOOKINGS"],
    orders: ["BUSINESS_FOOD_ORDERS"], menu: ["BUSINESS_FOOD_MENU_CLICKS"], views: MAPS_METRICS.filter((m) => m.startsWith("BUSINESS_IMPRESSIONS")) };
  const branches = {};
  for (const [loc, branch] of Object.entries(MAPS_LOCATIONS)) {
    const rows = (results || []).filter((r) => r.location === loc);
    const sum = (metrics, a, b) => rows.filter((r) => metrics.includes(r.metric) && r.day >= a && r.day <= b).reduce((s, r) => s + (r.value || 0), 0);
    const totals = {}, before = {};
    for (const [k, ms] of Object.entries(group)) { totals[k] = lastDay ? sum(ms, cur0, lastDay) : 0; before[k] = lastDay ? sum(ms, prev0, prev1) : 0; }
    const actionsMetrics = [...group.calls, ...group.directions, ...group.website, ...group.bookings, ...group.orders, ...group.menu];
    const weekly = [];
    for (let i = 7; i >= 0; i--) { const b = lastDay ? dayShift(lastDay, -7 * i) : "", a = lastDay ? dayShift(b, -6) : ""; weekly.push({ end: b, actions: lastDay ? sum(actionsMetrics, a, b) : 0, views: lastDay ? sum(group.views, a, b) : 0 }); }
    branches[branch] = { totals, before, weekly, hasData: rows.length > 0 };
  }
  return { lastDay: lastDay || null, from: cur0 || null, branches, last: await kvGet(env, "engage_maps_pull") };
}

async function insightsCron(env, cfg) {
  const { hour, day } = londonClock();
  if (cfg.compPull && hour >= 7 && hour < 9) {
    const last = await kvGet(env, "engage_comp_pull");
    const n = await env.DB.prepare("SELECT COUNT(*) AS n FROM comp_accounts").first().catch(() => ({ n: 0 }));
    if (n && n.n && (!last || Date.now() - Date.parse(last.at || 0) > COMP_EVERY_MS)) await compPull(env, "auto");
  }
  if (cfg.mapsPull && hour >= 8 && hour < 10 && new Date(day + "T12:00:00Z").getUTCDay() === 1) {
    const last = await kvGet(env, "engage_maps_pull");
    if (!last || Date.now() - Date.parse(last.at || 0) > 3 * 86400e3) await mapsPull(env, "auto");
  }
}

async function insightsCallback(env, job, body) {
  await ensureEngTables(env);
  const now = new Date().toISOString();
  if (Date.now() - Date.parse(job.created_at) > 60 * 60e3) return json({ error: "Expired" }, 403);
  if (job.kind === "comp") {
    const u = String(body.username || "").toLowerCase();
    if (!/^[a-z0-9._]{1,30}$/.test(u)) return json({ error: "Unknown account" }, 400);
    const known = await env.DB.prepare("SELECT 1 FROM comp_accounts WHERE username = ?1").bind(u).first();
    if (!known) return json({ ok: true, ignored: true });
    if (body.error) {
      await env.DB.prepare("UPDATE comp_accounts SET error = ?2, checked_at = ?3 WHERE username = ?1").bind(u, dec(body.error).slice(0, 200), now).run();
      return json({ ok: true });
    }
    const p = body.profile || {};
    const followers = p.followers === "" || p.followers == null ? null : num(p.followers);
    await env.DB.prepare(`UPDATE comp_accounts SET name = ?2, pic = ?3, bio = ?4, website = ?5, followers = ?6, follows = ?7, media_count = ?8, error = NULL, checked_at = ?9 WHERE username = ?1`)
      .bind(u, dec(p.name).slice(0, 80), /^https:\/\//.test(dec(p.pic)) ? dec(p.pic).slice(0, 1500) : null, dec(p.bio).slice(0, 400), dec(p.website).slice(0, 200),
        followers, num(p.follows), num(p.media), now).run();
    if (followers != null) await env.DB.prepare("INSERT INTO comp_snaps (username, day, followers, media_count) VALUES (?1, ?2, ?3, ?4) ON CONFLICT(username, day) DO UPDATE SET followers = excluded.followers, media_count = excluded.media_count")
      .bind(u, londonDay(), followers, num(p.media)).run();
    const posts = Array.isArray(body.posts) ? body.posts.slice(0, 30) : [];
    for (const x of posts) {
      if (!x || !x.id) continue;
      await env.DB.prepare(`INSERT INTO comp_posts (username, post_id, permalink, caption, type, thumb, likes, comments, views, posted_at, updated_at) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11)
        ON CONFLICT(username, post_id) DO UPDATE SET permalink = excluded.permalink, caption = excluded.caption, type = excluded.type, thumb = COALESCE(NULLIF(excluded.thumb, ''), comp_posts.thumb),
          likes = excluded.likes, comments = excluded.comments, views = excluded.views, posted_at = excluded.posted_at, updated_at = excluded.updated_at`)
        .bind(u, String(x.id).slice(0, 40), String(x.permalink || "").slice(0, 300), dec(x.caption).slice(0, 600), String(x.mediaType || "").slice(0, 20), dec(x.thumb).slice(0, 1500),
          num(x.likes), num(x.comments), num(x.views), toIsoDate(x.at), now).run();
    }
    await env.DB.prepare("UPDATE make_jobs SET status = 'done', updated_at = ?2 WHERE id = ?1").bind(job.id, now).run();
    return json({ ok: true, posts: posts.length });
  }
  // maps
  const location = String(body.location || "");
  if (!MAPS_LOCATIONS[location]) return json({ error: "Unknown location" }, 400);
  if (body.error) {
    const last = (await kvGet(env, "engage_maps_pull")) || { at: now };
    last.error = MAPS_LOCATIONS[location].replace(/^./, (c) => c.toUpperCase()) + ": " + dec(body.error).slice(0, 160);
    await kvSet(env, "engage_maps_pull", last);
    return json({ ok: true });
  }
  let data = body.data;
  if (typeof data === "string") { try { data = JSON.parse(data); } catch (e) { data = null; } }
  const series = [];
  for (const m of (data && data.multiDailyMetricTimeSeries) || []) for (const s of m.dailyMetricTimeSeries || []) series.push(s);
  const stmts = [];
  for (const s of series) {
    if (!MAPS_METRICS.includes(s.dailyMetric)) continue;
    for (const dv of ((s.timeSeries || {}).datedValues || [])) {
      const d = dv.date || {};
      if (!d.year || !d.month || !d.day) continue;
      const day = `${d.year}-${String(d.month).padStart(2, "0")}-${String(d.day).padStart(2, "0")}`;
      stmts.push(env.DB.prepare("INSERT INTO gbp_daily (location, day, metric, value) VALUES (?1, ?2, ?3, ?4) ON CONFLICT(location, day, metric) DO UPDATE SET value = excluded.value")
        .bind(location, day, s.dailyMetric, num(dv.value)));
    }
  }
  for (let i = 0; i < stmts.length; i += 90) await env.DB.batch(stmts.slice(i, i + 90));
  await env.DB.prepare("UPDATE make_jobs SET status = 'done', updated_at = ?2 WHERE id = ?1").bind(job.id, now).run();
  return json({ ok: true, values: stmts.length });
}
