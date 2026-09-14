import type { Session } from "../types";
let csrf = "";
let sessionRequest: Promise<Session> | null = null;
export async function api<T>(
  path: string,
  options: {
    method?: string;
    body?: unknown;
    key?: string;
    signal?: AbortSignal;
  } = {},
): Promise<T> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 15000);
  try {
    const response = await fetch("/api" + path, {
      method: options.method || "GET",
      credentials: "same-origin",
      headers: {
        "content-type": "application/json",
        ...(csrf ? { "x-csrf-token": csrf } : {}),
        ...(options.key ? { "x-booking-token": options.key } : {}),
      },
      body:
        options.body === undefined ? undefined : JSON.stringify(options.body),
      signal: options.signal
        ? AbortSignal.any([options.signal, controller.signal])
        : controller.signal,
    });
    const json = await response.json().catch(() => null);
    if (!response.ok)
      throw new Error(
        json?.error?.message ||
          "The booking service is temporarily unavailable. Please try again.",
      );
    if (!json) throw new Error("The server returned an unexpected response.");
    return json;
  } catch (error) {
    if (error instanceof Error && error.name === "AbortError")
      throw new Error(
        "The request took too long. Refresh availability or retry the same booking safely.",
      );
    throw error;
  } finally {
    clearTimeout(timer);
  }
}
export async function startSession() {
  sessionRequest ??= api<Session>("/session")
    .then((s) => {
      csrf = s.csrf;
      return s;
    })
    .finally(() => {
      sessionRequest = null;
    });
  return sessionRequest;
}
