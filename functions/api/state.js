// GET  /api/state  -> the whole shared app state (content items, activity log, settings, etc.)
// POST /api/state  -> replaces it wholesale with whatever the browser sends
//
// This is intentionally simple: one row, whole-document read/write. Fine for a small team;
// see schema.sql for the note on when to graduate to real relational tables.

export async function onRequestGet({ env }) {
  const row = await env.DB.prepare("SELECT data FROM app_state WHERE id = 1").first();
  const data = row ? JSON.parse(row.data) : {};
  return new Response(JSON.stringify(data), {
    headers: { "Content-Type": "application/json" },
  });
}

export async function onRequestPost({ request, env }) {
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
