export async function onRequest({ request, env }) {
  if (!env.BOOKING_API)
    return Response.json(
      {
        error: {
          code: "SERVICE_UNAVAILABLE",
          message: "The booking service is temporarily unavailable.",
        },
      },
      { status: 503 },
    );
  try {
    return await env.BOOKING_API.fetch(request);
  } catch {
    return Response.json(
      {
        error: {
          code: "SERVICE_UNAVAILABLE",
          message:
            "The booking service is temporarily unavailable. Please retry shortly.",
        },
      },
      { status: 503, headers: { "Cache-Control": "no-store" } },
    );
  }
}
