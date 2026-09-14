import { beforeAll, beforeEach, afterAll, describe, it, expect } from "vitest";
import request from "supertest";
import pg from "pg";
import fs from "node:fs";
import { randomUUID } from "node:crypto";
import { DateTime } from "luxon";
import { createApp } from "../server/app.mjs";
import { migrate } from "../server/db.mjs";
let connection = process.env.TEST_DATABASE_URL;
if (!connection && fs.existsSync(".env"))
  connection = fs
    .readFileSync(".env", "utf8")
    .match(/^TEST_DATABASE_URL=(.+)$/m)?.[1]
    .trim();
if (!connection || new URL(connection).pathname !== "/booking_test")
  throw new Error("Use a separate TEST_DATABASE_URL ending in /booking_test.");
const db = new pg.Pool({ connectionString: connection, max: 8 });
const origin = "http://localhost:5173",
  secret = "test-automation-secret-only";
const app = createApp(db, {
  production: false,
  rate: false,
  origin,
  automation: secret,
  secret: "test-only-management-secret",
});
let client: any, csrf: string, cat: any, selected: any, date: string;
async function session() {
  const agent = request.agent(app);
  const r = await agent.get("/api/session");
  expect(r.status).toBe(200);
  return { agent, csrf: r.body.csrf };
}
const send = (
  method: string,
  path: string,
  body: any,
  agent = client,
  protection = csrf,
) =>
  agent[method](path)
    .set("Origin", origin)
    .set("X-CSRF-Token", protection)
    .send(body);
const booking = (slot = selected, extra = {}) => ({
  serviceId: cat.services[0].id,
  staffId: slot.staffId,
  startsAt: slot.startsAt,
  name: "Morgan Test",
  email: "morgan@example.com",
  phone: "+44 7700 900123",
  note: "Fictional test appointment",
  idempotencyKey: randomUUID(),
  consent: true,
  ...extra,
});
const create = async (body = booking()) => {
  const r = await send("post", "/api/appointments", body);
  expect(r.status, r.body.error?.message).toBe(201);
  return r.body;
};
const admin = () => send("post", "/api/admin/login", { acknowledge: true });
const automation = (path: string, body = {}) =>
  request(app)
    .post("/api/automation/" + path)
    .set("X-Automation-Secret", secret)
    .send(body);
async function availability() {
  return (
    await client
      .get("/api/availability")
      .query({ serviceId: cat.services[0].id, date })
  ).body.slots;
}
beforeAll(async () => {
  await migrate(db);
});
beforeEach(async () => {
  await db.query("TRUNCATE workspaces,usage_limits CASCADE");
  ({ agent: client, csrf } = await session());
  cat = (await client.get("/api/catalog")).body;
  let d = DateTime.now().setZone("Europe/London").plus({ days: 1 });
  if (d.weekday === 7) d = d.plus({ days: 1 });
  date = d.toISODate()!;
  selected = (await availability())[0];
  expect(selected).toBeTruthy();
});
afterAll(() => db.end());
describe("PostgreSQL booking API integration", () => {
  it("seeds six services, four specialists and working hours", () => {
    expect(cat.services).toHaveLength(6);
    expect(cat.staff).toHaveLength(4);
    expect(cat.hours.length).toBeGreaterThan(20);
  });
  it("persists booking, secure management key and initial event", async () => {
    const a = await create();
    const row = (
      await db.query("SELECT * FROM appointments WHERE id=$1", [a.id])
    ).rows[0];
    expect(row.name).toBe("Morgan Test");
    expect(row.manage_hash).not.toBe(a.managementKey);
    expect(a.reference).toMatch(/^NB-/);
    expect(a.events[0].kind).toBe("booked");
    expect(a.notifications[0].state).toBe("pending");
  });
  it("removes the newly reserved slot", async () => {
    await create();
    expect(
      (await availability()).some(
        (s: any) =>
          s.staffId === selected.staffId && s.startsAt === selected.startsAt,
      ),
    ).toBe(false);
  });
  it("prevents double booking", async () => {
    await create();
    const r = await send("post", "/api/appointments", booking());
    expect(r.status).toBe(409);
    expect(r.body.error.code).toBe("SLOT_TAKEN");
  });
  it("allows exactly one concurrent reservation of the same slot", async () => {
    const results = await Promise.all([
      send("post", "/api/appointments", booking()),
      send("post", "/api/appointments", booking()),
    ]);
    expect(results.map((r) => r.status).sort()).toEqual([201, 409]);
    expect(
      (await db.query("SELECT count(*)::int AS n FROM appointments")).rows[0].n,
    ).toBe(1);
  });
  it("replays concurrent identical requests without duplicate bookings or notifications", async () => {
    const body = booking();
    const results = await Promise.all([
      send("post", "/api/appointments", body),
      send("post", "/api/appointments", body),
    ]);
    expect(results.map((r) => r.status).sort()).toEqual([200, 201]);
    expect(results[0].body.id).toBe(results[1].body.id);
    expect(
      (await db.query("SELECT count(*)::int AS n FROM notifications")).rows[0]
        .n,
    ).toBe(1);
  });
  it("rejects reusing an idempotency key with changed details", async () => {
    const b = booking();
    await create(b);
    expect(
      (await send("post", "/api/appointments", { ...b, name: "Changed Name" }))
        .status,
    ).toBe(409);
  });
  it("enforces the overlap constraint even on a direct database write", async () => {
    const a = await create();
    await expect(
      db.query(
        "INSERT INTO appointments(id,workspace_id,reference,manage_hash,idempotency_key,request_hash,service_id,staff_id,service_name,staff_name,duration,price,starts_at,ends_at,name,email,phone) SELECT $2,workspace_id,'NB-SECOND','different-hash',$3,'different',service_id,staff_id,service_name,staff_name,duration,price,starts_at,ends_at,name,email,phone FROM appointments WHERE id=$1",
        [a.id, randomUUID(), randomUUID()],
      ),
    ).rejects.toMatchObject({ code: "23P01" });
  });
  it("reschedules atomically and releases the previous slot", async () => {
    const a = await create();
    const next = (await availability()).find(
      (s: any) => s.staffId === selected.staffId,
    );
    const r = await send("put", `/api/appointments/${a.id}/reschedule`, {
      startsAt: next.startsAt,
      staffId: next.staffId,
      version: a.version,
    });
    expect(r.status).toBe(200);
    expect(r.body.version).toBe(2);
    const available = await availability();
    expect(
      available.some(
        (s: any) =>
          s.startsAt === selected.startsAt && s.staffId === selected.staffId,
      ),
    ).toBe(true);
    expect(
      available.some(
        (s: any) => s.startsAt === next.startsAt && s.staffId === next.staffId,
      ),
    ).toBe(false);
    expect(r.body.notifications.some((n: any) => n.kind === "reschedule")).toBe(
      true,
    );
  });
  it("preserves the original booking if the target slot is taken", async () => {
    const a = await create();
    const next = (await availability()).find(
      (s: any) => s.staffId === selected.staffId,
    );
    await create(booking(next));
    const r = await send("put", `/api/appointments/${a.id}/reschedule`, {
      startsAt: next.startsAt,
      staffId: next.staffId,
      version: 1,
    });
    expect(r.status).toBe(409);
    expect((await client.get("/api/appointments/" + a.id)).body.startsAt).toBe(
      a.startsAt,
    );
  });
  it("rejects stale rescheduling versions", async () => {
    const a = await create();
    const next = (await availability())[0];
    expect(
      (
        await send("put", `/api/appointments/${a.id}/reschedule`, {
          startsAt: next.startsAt,
          staffId: next.staffId,
          version: 9,
        })
      ).status,
    ).toBe(409);
  });
  it("cancels and releases the previous slot", async () => {
    const a = await create();
    const r = await send("post", `/api/appointments/${a.id}/cancel`, {
      version: 1,
    });
    expect(r.status).toBe(200);
    expect(r.body.status).toBe("cancelled");
    expect(
      (await availability()).some(
        (s: any) =>
          s.startsAt === selected.startsAt && s.staffId === selected.staffId,
      ),
    ).toBe(true);
  });
  it("validates email, consent, contact and slot data", async () => {
    for (const extra of [
      { email: "broken" },
      { consent: false },
      { phone: "bad" },
      { name: "" },
      { startsAt: "not-a-time" },
    ])
      expect(
        (await send("post", "/api/appointments", booking(selected, extra)))
          .status,
      ).toBe(422);
  });
  it("rejects cross-site requests and missing CSRF", async () => {
    expect(
      (await client.post("/api/appointments").send(booking())).status,
    ).toBe(403);
    expect(
      (
        await client
          .post("/api/appointments")
          .set("Origin", "https://untrusted.example")
          .set("X-CSRF-Token", csrf)
          .send(booking())
      ).status,
    ).toBe(403);
  });
  it("rejects oversized bodies", async () =>
    expect(
      (
        await send(
          "post",
          "/api/appointments",
          booking(selected, { note: "x".repeat(20000) }),
        )
      ).status,
    ).toBe(413));
  it("protects admin actions until demo role selection", async () => {
    expect((await client.get("/api/admin/appointments")).status).toBe(403);
    expect((await admin()).status).toBe(200);
    expect((await client.get("/api/admin/appointments")).status).toBe(200);
  });
  it("updates admin status and rejects completion before start", async () => {
    const a = await create();
    await admin();
    const r = await send("put", `/api/admin/appointments/${a.id}/status`, {
      status: "confirmed",
      version: 1,
    });
    expect(r.body.status).toBe("confirmed");
    expect(
      (
        await send("put", `/api/admin/appointments/${a.id}/status`, {
          status: "completed",
          version: 2,
        })
      ).status,
    ).toBe(422);
  });
  it("allows completed and no-show after start with validated transitions", async () => {
    const a = await create();
    await db.query(
      "UPDATE appointments SET starts_at=now()-interval '1 hour',ends_at=now()-interval '30 minutes' WHERE id=$1",
      [a.id],
    );
    await admin();
    expect(
      (
        await send("put", `/api/admin/appointments/${a.id}/status`, {
          status: "completed",
          version: 1,
        })
      ).body.status,
    ).toBe("completed");
    expect(
      (
        await send("put", `/api/admin/appointments/${a.id}/status`, {
          status: "confirmed",
          version: 2,
        })
      ).status,
    ).toBe(409);
  });
  it("isolates sessions and permits access through a private management key", async () => {
    const a = await create();
    const other = await session();
    expect((await other.agent.get("/api/appointments/" + a.id)).status).toBe(
      404,
    );
    expect(
      (
        await other.agent
          .get("/api/appointments/" + a.id)
          .set("X-Booking-Token", a.managementKey)
      ).status,
    ).toBe(200);
    expect(
      (await other.agent.get("/api/appointments")).body.appointments,
    ).toHaveLength(0);
  });
  it("restores booking history after session refresh", async () => {
    const a = await create();
    const s = await client.get("/api/session");
    expect(s.body.csrf).toBe(csrf);
    expect(
      (await client.get("/api/appointments")).body.appointments[0].id,
    ).toBe(a.id);
  });
  it("creates and updates services without changing booked snapshots", async () => {
    const a = await create();
    await admin();
    const s = cat.services[0];
    const r = await send("put", "/api/admin/services/" + s.id, {
      name: "New consultation",
      duration: 60,
      price: 8000,
      description: "Updated future service",
      active: false,
    });
    expect(r.status).toBe(200);
    expect(
      (await client.get("/api/appointments/" + a.id)).body.serviceName,
    ).toBe(a.serviceName);
    expect(
      (await client.get("/api/availability").query({ date, serviceId: s.id }))
        .status,
    ).toBe(422);
  });
  it("updates staff specialties and validates foreign service IDs", async () => {
    await admin();
    const s = cat.staff[0];
    expect(
      (
        await send("put", "/api/admin/staff/" + s.id, {
          name: s.name,
          bio: s.bio,
          active: true,
          serviceIds: [randomUUID()],
        })
      ).status,
    ).toBe(422);
    expect(
      (
        await send("put", "/api/admin/staff/" + s.id, {
          name: "Alex Updated",
          bio: s.bio,
          active: true,
          serviceIds: s.services,
        })
      ).status,
    ).toBe(200);
  });
  it("blocks unavailable time and restores it after release", async () => {
    await admin();
    const r = await send("post", "/api/admin/blocks", {
      staffId: selected.staffId,
      startsAt: selected.startsAt,
      endsAt: selected.endsAt,
      reason: "Team meeting",
    });
    expect(r.status).toBe(201);
    expect(
      (await availability()).some(
        (s: any) =>
          s.staffId === selected.staffId && s.startsAt === selected.startsAt,
      ),
    ).toBe(false);
    expect(
      (await send("delete", "/api/admin/blocks/" + r.body.id, {})).status,
    ).toBe(200);
    expect(
      (await availability()).some(
        (s: any) =>
          s.staffId === selected.staffId && s.startsAt === selected.startsAt,
      ),
    ).toBe(true);
  });
  it("rejects blocking time occupied by an appointment", async () => {
    await create();
    await admin();
    expect(
      (
        await send("post", "/api/admin/blocks", {
          staffId: selected.staffId,
          startsAt: selected.startsAt,
          endsAt: selected.endsAt,
          reason: "Team meeting",
        })
      ).status,
    ).toBe(409);
  });
  it("rejects schedules which strand active appointments", async () => {
    await create();
    await admin();
    expect(
      (
        await send("put", `/api/admin/staff/${selected.staffId}/hours`, {
          rules: [],
        })
      ).status,
    ).toBe(409);
  });
  it("rejects overlapping work periods and accepts a valid schedule", async () => {
    await admin();
    expect(
      (
        await send("put", `/api/admin/staff/${selected.staffId}/hours`, {
          rules: [
            { weekday: 1, start: 540, end: 720 },
            { weekday: 1, start: 600, end: 780 },
          ],
        })
      ).status,
    ).toBe(422);
    expect(
      (
        await send("put", `/api/admin/staff/${selected.staffId}/hours`, {
          rules: [{ weekday: 1, start: 600, end: 840 }],
        })
      ).status,
    ).toBe(200);
  });
  it("protects internal automation endpoints", async () =>
    expect(
      (await request(app).post("/api/automation/due").send({})).status,
    ).toBe(403));
  it("allows a notification to be claimed once across concurrent workflows", async () => {
    const a = await create();
    const r = await Promise.all([
      automation("claim", { eventId: a.notifications[0].id }),
      automation("claim", { eventId: a.notifications[0].id }),
    ]);
    expect(r.map((x) => x.body.claimed).sort()).toEqual([false, true]);
  });
  it("records real delivery receipts idempotently and refuses forged claims", async () => {
    const a = await create(),
      eventId = a.notifications[0].id;
    const c = (await automation("claim", { eventId })).body;
    const body = {
      eventId,
      claim: c.claim,
      delivered: true,
      messageId: "test-42",
    };
    expect(
      (await automation("complete", { ...body, claim: "wrong" })).status,
    ).toBe(409);
    expect((await automation("complete", body)).status).toBe(200);
    expect((await automation("complete", body)).status).toBe(200);
    expect(
      (await client.get("/api/appointments/" + a.id)).body.notifications[0]
        .state,
    ).toBe("delivered");
  });
  it("quarantines ambiguous Telegram delivery without retries", async () => {
    const a = await create(),
      eventId = a.notifications[0].id;
    const c = (await automation("claim", { eventId })).body;
    await automation("complete", {
      eventId,
      claim: c.claim,
      delivered: false,
      messageId: null,
    });
    expect((await automation("claim", { eventId })).body.claimed).toBe(false);
    expect(
      (await client.get("/api/appointments/" + a.id)).body.notifications[0]
        .state,
    ).toBe("review");
  });
  it("queues a test reminder once per schedule version", async () => {
    const a = await create();
    await admin();
    expect(
      (await send("post", `/api/admin/appointments/${a.id}/reminder`, {})).body
        .queued,
    ).toBe(true);
    expect(
      (await send("post", `/api/admin/appointments/${a.id}/reminder`, {})).body
        .queued,
    ).toBe(false);
  });
  it("schedules due reminders once, even after repeated scheduler ticks", async () => {
    const a = await create();
    await db.query(
      "UPDATE appointments SET reminder_at=now()-interval '1 minute' WHERE id=$1",
      [a.id],
    );
    await automation("due");
    await automation("due");
    expect(
      (
        await db.query(
          "SELECT * FROM notifications WHERE appointment_id=$1 AND kind='reminder'",
          [a.id],
        )
      ).rowCount,
    ).toBe(1);
  });
  it("keeps a scheduled reminder valid after marking confirmed", async () => {
    const a = await create();
    await db.query(
      "UPDATE appointments SET reminder_at=now()-interval '1 minute' WHERE id=$1",
      [a.id],
    );
    await automation("due");
    await admin();
    await send("put", `/api/admin/appointments/${a.id}/status`, {
      status: "confirmed",
      version: 1,
    });
    const n = (
      await db.query(
        "SELECT id FROM notifications WHERE appointment_id=$1 AND kind='reminder'",
        [a.id],
      )
    ).rows[0];
    expect((await automation("claim", { eventId: n.id })).body.claimed).toBe(
      true,
    );
  });
  it("skips cancelled or outdated reminders", async () => {
    const a = await create();
    await admin();
    await send("post", `/api/admin/appointments/${a.id}/reminder`, {});
    const n = (
      await db.query(
        "SELECT id FROM notifications WHERE appointment_id=$1 AND kind='test-reminder'",
        [a.id],
      )
    ).rows[0];
    await send("post", `/api/appointments/${a.id}/cancel`, { version: 1 });
    expect((await automation("claim", { eventId: n.id })).body.claimed).toBe(
      false,
    );
  });
});
