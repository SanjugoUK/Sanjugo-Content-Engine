// GET /api/media/<key> — streams a stored photo/video back out of R2.
// Supports Range requests so video scrubbing/seeking works properly in the <video> player.

export async function onRequestGet({ params, request, env }) {
  const key = params.key;
  const range = request.headers.get("range");

  const obj = range
    ? await env.MEDIA.get(key, { range: parseRange(range) })
    : await env.MEDIA.get(key);

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
