const JSON_HEADERS = {
  "Content-Type": "application/json; charset=utf-8",
  "Cache-Control": "no-store",
};

export async function onRequestGet(context) {
  const auth = authorize(context.request, context.env);
  if (auth) return auth;

  return json(
    {
      success: true,
      ready: Boolean(context.env.img_r2),
      storage: context.env.img_r2 ? "r2" : "missing-binding",
    },
    context.env.img_r2 ? 200 : 503
  );
}

export async function onRequestPost(context) {
  const { request, env } = context;
  const auth = authorize(request, env);
  if (auth) return auth;
  if (!env.img_r2) {
    return json({ success: false, error: "Missing img_r2 binding." }, 503);
  }

  let body;
  try {
    body = await request.json();
  } catch {
    return json({ success: false, error: "Invalid JSON body." }, 400);
  }

  const requestUrl = new URL(request.url);
  const publicUrl = parsePublicUrl(body?.url, requestUrl.origin);
  if (!publicUrl) {
    return json({ success: false, error: "Invalid img.otfvn.com file URL." }, 400);
  }

  const id = decodeURIComponent(publicUrl.pathname.slice("/file/".length));
  if (!/^r2[_-][A-Za-z0-9][A-Za-z0-9._-]{7,240}$/.test(id)) {
    return json({ success: false, error: "Only validated R2 object ids can be deleted." }, 400);
  }
  if (body?.key && body.key !== id) {
    return json({ success: false, error: "URL and key do not match." }, 400);
  }

  const candidates = [id, id.replace(/^r2[_-]/, "")];
  let objectKey = "";
  for (const candidate of candidates) {
    if (candidate && (await env.img_r2.head(candidate))) {
      objectKey = candidate;
      break;
    }
  }

  if (!objectKey) {
    await removeIndexRecords(env, id);
    await purgeLocalEdgeCache(publicUrl);
    return json({ success: true, deleted: false, missing: true, key: id });
  }

  await env.img_r2.delete(objectKey);
  if (await env.img_r2.head(objectKey)) {
    return json({ success: false, error: "R2 object still exists after delete." }, 502);
  }

  await removeIndexRecords(env, id);
  await purgeLocalEdgeCache(publicUrl);

  return json({ success: true, deleted: true, missing: false, key: id });
}

function authorize(request, env) {
  const expectedUser = String(env.UPLOAD_BASIC_USER || "");
  const expectedPass = String(env.UPLOAD_BASIC_PASS || "");
  if (!expectedUser || !expectedPass) {
    return json(
      { success: false, error: "UPLOAD_BASIC_USER/PASS must be configured." },
      503
    );
  }

  const header = request.headers.get("Authorization") || "";
  if (!header.startsWith("Basic ")) return unauthorized();

  let decoded = "";
  try {
    decoded = atob(header.slice(6));
  } catch {
    return unauthorized();
  }

  const separator = decoded.indexOf(":");
  if (separator < 0) return unauthorized();
  const user = decoded.slice(0, separator);
  const pass = decoded.slice(separator + 1);
  if (!safeEqual(user, expectedUser) || !safeEqual(pass, expectedPass)) {
    return unauthorized();
  }
  return null;
}

function unauthorized() {
  return new Response(JSON.stringify({ success: false, error: "Unauthorized." }), {
    status: 401,
    headers: {
      ...JSON_HEADERS,
      "WWW-Authenticate": 'Basic realm="OTFVN Image Offload"',
    },
  });
}

function safeEqual(left, right) {
  const a = new TextEncoder().encode(String(left));
  const b = new TextEncoder().encode(String(right));
  let diff = a.length ^ b.length;
  const length = Math.max(a.length, b.length);
  for (let index = 0; index < length; index += 1) {
    diff |= (a[index % Math.max(1, a.length)] || 0) ^
      (b[index % Math.max(1, b.length)] || 0);
  }
  return diff === 0;
}

function parsePublicUrl(value, expectedOrigin) {
  try {
    const url = new URL(String(value || ""));
    if (
      url.protocol !== "https:" ||
      url.origin !== expectedOrigin ||
      !url.pathname.startsWith("/file/") ||
      url.search ||
      url.hash
    ) {
      return null;
    }
    return url;
  } catch {
    return null;
  }
}

async function removeIndexRecords(env, id) {
  if (!env.img_url) return;
  await env.img_url.delete(id);
}

async function purgeLocalEdgeCache(publicUrl) {
  try {
    await caches.default.delete(new Request(publicUrl.toString(), { method: "GET" }));
  } catch {
    // Object deletion remains authoritative even when a local edge cache misses.
  }
}

function json(payload, status = 200) {
  return new Response(JSON.stringify(payload), {
    status,
    headers: JSON_HEADERS,
  });
}
