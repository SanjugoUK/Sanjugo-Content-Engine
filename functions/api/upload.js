// POST /api/upload  (multipart/form-data, field name "file")
// Stores the real uploaded photo/video in R2 and hands back a URL the app can put straight
// into an <img>/<video> tag. Served back out through /api/media/[key].js below, so nothing
// extra needs enabling on the R2 bucket itself.

const MAX_BYTES = 500 * 1024 * 1024; // 500MB, matches the limit already shown in the upload UI

export async function onRequestPost({ request, env }) {
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

  const safeExt = (file.name && file.name.includes(".")) ? file.name.split(".").pop().replace(/[^a-zA-Z0-9]/g, "").slice(0, 8) : "bin";
  const key = `${crypto.randomUUID()}.${safeExt || "bin"}`;

  await env.MEDIA.put(key, file.stream(), {
    httpMetadata: { contentType: file.type || "application/octet-stream" },
  });

  return new Response(JSON.stringify({ url: `/api/media/${key}`, key }), {
    headers: { "Content-Type": "application/json" },
  });
}
