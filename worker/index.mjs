export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    const reply = (status, code, message) =>
      Response.json(
        { error: { code, message } },
        { status, headers: { "Cache-Control": "no-store" } },
      );
    if (
      !url.pathname.startsWith("/api/") ||
      url.pathname.startsWith("/api/automation/")
    )
      return reply(404, "NOT_FOUND", "Not found.");
    if (url.origin !== env.PUBLIC_ORIGIN)
      return reply(403, "ORIGIN_DENIED", "Access denied.");
    if (!["GET", "HEAD", "POST", "PUT", "DELETE"].includes(request.method))
      return reply(405, "METHOD_NOT_ALLOWED", "Method not allowed.");
    if (
      !["GET", "HEAD"].includes(request.method) &&
      request.headers.get("Origin") !== env.PUBLIC_ORIGIN
    )
      return reply(403, "ORIGIN_DENIED", "Access denied.");
    const ip = request.headers.get("CF-Connecting-IP") || "unknown";
    if (env.EDGE_RATE && !(await env.EDGE_RATE.limit({ key: ip })).success)
      return reply(
        429,
        "RATE_LIMITED",
        "Too many requests. Please try again shortly.",
      );
    let body;
    if (!["GET", "HEAD"].includes(request.method)) {
      if (Number(request.headers.get("content-length") || 0) > 12288)
        return reply(413, "REQUEST_TOO_LARGE", "The request is too large.");
      const reader = request.body?.getReader();
      let chunks = [],
        size = 0;
      if (reader)
        while (true) {
          const r = await reader.read();
          if (r.done) break;
          size += r.value.length;
          if (size > 12288) {
            await reader.cancel();
            return reply(413, "REQUEST_TOO_LARGE", "The request is too large.");
          }
          chunks.push(r.value);
        }
      body = new Uint8Array(size);
      let offset = 0;
      for (const chunk of chunks) {
        body.set(chunk, offset);
        offset += chunk.length;
      }
    }
    const headers = new Headers();
    for (const name of [
      "content-type",
      "cookie",
      "x-csrf-token",
      "origin",
      "idempotency-key",
      "x-booking-token",
    ]) {
      const value = request.headers.get(name);
      if (value) headers.set(name, value);
    }
    headers.set("X-Origin-Secret", env.ORIGIN_SECRET);
    headers.set("X-Forwarded-For", ip);
    try {
      const response = await env.PRIVATE_API.fetch(
        new Request("http://booking-api" + url.pathname + url.search, {
          method: request.method,
          headers,
          body,
          signal: AbortSignal.timeout(12000),
        }),
      );
      const out = new Response(response.body, response);
      out.headers.set("Cache-Control", "no-store");
      return out;
    } catch {
      return reply(
        503,
        "SERVICE_UNAVAILABLE",
        "The booking service is temporarily unavailable. Retrying the same booking is safe.",
      );
    }
  },
};
