import { it, expect, vi } from "vitest";
import gateway from "../worker/index.mjs";
import { bookingWorkflow } from "../n8n/workflow.mjs";
const origin = "https://booking-appointment-demo.pages.dev";
const env = {
  PUBLIC_ORIGIN: origin,
  ORIGIN_SECRET: "test-only",
  PRIVATE_API: {
    fetch: vi.fn(async (_request: Request) => Response.json({ ok: true })),
  },
};
it("never exposes internal automation via the gateway", async () => {
  expect(
    (await gateway.fetch(new Request(origin + "/api/automation/claim"), env))
      .status,
  ).toBe(404);
});
it("rejects cross-origin mutations", async () =>
  expect(
    (
      await gateway.fetch(
        new Request(origin + "/api/appointments", {
          method: "POST",
          headers: { Origin: "https://other.example" },
        }),
        env,
      )
    ).status,
  ).toBe(403));
it("rejects oversized requests at the edge", async () =>
  expect(
    (
      await gateway.fetch(
        new Request(origin + "/api/appointments", {
          method: "POST",
          headers: { Origin: origin },
          body: "x".repeat(17000),
        }),
        env,
      )
    ).status,
  ).toBe(413));
it("forwards only allowed headers and installs the private origin secret", async () => {
  await gateway.fetch(
    new Request(origin + "/api/session", {
      headers: {
        Authorization: "should-not-pass",
        "X-Origin-Secret": "spoofed",
      },
    }),
    env,
  );
  const req = env.PRIVATE_API.fetch.mock.calls.at(
    -1,
  )?.[0] as unknown as Request;
  expect(req.headers.get("X-Origin-Secret")).toBe("test-only");
  expect(req.headers.has("Authorization")).toBe(false);
});
it("returns an honest error if the private backend is unavailable", async () =>
  expect(
    (
      await gateway.fetch(new Request(origin + "/api/session"), {
        ...env,
        PRIVATE_API: {
          fetch: async () => {
            throw Error("offline");
          },
        },
      })
    ).status,
  ).toBe(503));
it("workflow has an actual minute scheduler, claim gate and no Telegram retry", () => {
  const w: any = bookingWorkflow({
    headerCredential: "test-header",
    telegramCredential: "test-telegram",
    chatId: "test-chat",
  });
  expect(
    w.nodes.find((n: any) => n.type === "n8n-nodes-base.scheduleTrigger")
      ?.parameters.rule.interval[0].minutesInterval,
  ).toBe(1);
  expect(
    w.nodes.find((n: any) => n.type === "n8n-nodes-base.telegram"),
  ).not.toHaveProperty("retryOnFail", true);
  expect(w.connections["Send only claimed events"].main[1]).toEqual([]);
  expect(
    w.nodes.find((n: any) => n.name === "Record confirmed receipt")
      ?.retryOnFail,
  ).toBe(true);
});
