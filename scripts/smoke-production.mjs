import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { writeFile } from "node:fs/promises";
import { DateTime } from "luxon";

// Explicit opt-in: this creates fictional appointments and real manager notifications.
if (!process.argv.includes("--confirm-test-bookings")) {
  console.error(
    "Run with --confirm-test-bookings to create an isolated test workspace and send demo Telegram notifications.",
  );
  process.exit(1);
}
const origin =
  process.env.SMOKE_ORIGIN || "https://booking-appointment-demo.pages.dev";
let cookie = "",
  csrf = "";
async function call(path, method = "GET", body, expected = 200) {
  const response = await fetch(origin + "/api" + path, {
    method,
    headers: {
      origin,
      cookie,
      "content-type": "application/json",
      "x-csrf-token": csrf,
    },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    signal: AbortSignal.timeout(20000),
  });
  const setCookie = response.headers.getSetCookie();
  if (setCookie.length)
    cookie = setCookie.map((c) => c.split(";")[0]).join("; ");
  const data = await response.json();
  if (expected !== null)
    assert.equal(response.status, expected, data.error?.message);
  return { data, status: response.status };
}
csrf = (await call("/session")).data.csrf;
const catalog = (await call("/catalog")).data;
const service = catalog.services.find(
  (s) => s.name === "Discovery consultation",
);
assert.ok(service);
let date, slots;
for (let offset = 0; offset < 8; offset++) {
  date = DateTime.now()
    .setZone("Europe/London")
    .plus({ days: offset })
    .toISODate();
  slots = (await call(`/availability?date=${date}&serviceId=${service.id}`))
    .data.slots;
  if (slots.length >= 4) break;
}
assert.ok(slots.length >= 4);
const first = slots[0];
const availability = async () =>
  (await call(`/availability?date=${date}&serviceId=${service.id}`)).data.slots;
const includes = (list, slot) =>
  list.some((s) => s.staffId === slot.staffId && s.startsAt === slot.startsAt);
const payload = (slot, name) => ({
  serviceId: service.id,
  staffId: slot.staffId,
  startsAt: slot.startsAt,
  name,
  email: "booking.qa@example.com",
  phone: "+44 7700 900123",
  note: "Fictional portfolio verification",
  consent: true,
  idempotencyKey: randomUUID(),
});
const intents = [
  payload(first, "Concurrency Test A"),
  payload(first, "Concurrency Test B"),
];
const race = await Promise.all(
  intents.map((b) => call("/appointments", "POST", b, null)),
);
assert.deepEqual(race.map((r) => r.status).sort(), [201, 409]);
const winner = race.findIndex((r) => r.status === 201);
let appointment = race[winner].data;
const replay = (await call("/appointments", "POST", intents[winner])).data;
assert.equal(replay.id, appointment.id);
assert.equal(includes(await availability(), first), false);
const history = (await call("/appointments")).data.appointments;
assert.ok(history.some((a) => a.id === appointment.id));
await call("/admin/login", "POST", { acknowledge: true });
const receipts = [];
async function delivered(id, kind) {
  for (let i = 0; i < 20; i++) {
    const detail = (await call("/appointments/" + id)).data;
    const notification = detail.notifications.find(
      (n) => n.kind === kind && n.state === "delivered" && n.message_id,
    );
    if (notification) {
      receipts.push({
        reference: detail.reference,
        kind,
        state: notification.state,
        messageId: notification.message_id,
      });
      return;
    }
    assert.ok(
      !detail.notifications.some(
        (n) => n.kind === kind && ["review", "failed"].includes(n.state),
      ),
      kind + " requires delivery review",
    );
    await new Promise((resolve) => setTimeout(resolve, 3000));
  }
  throw new Error("No confirmed Telegram receipt for " + kind);
}
await delivered(appointment.id, "booking");
const next = (await availability()).find(
  (s) =>
    s.staffId === first.staffId &&
    Date.parse(s.startsAt) >= Date.parse(first.endsAt),
);
assert.ok(next);
appointment = (
  await call(`/appointments/${appointment.id}/reschedule`, "PUT", {
    staffId: next.staffId,
    startsAt: next.startsAt,
    version: appointment.version,
  })
).data;
let available = await availability();
assert.equal(includes(available, first), true);
assert.equal(includes(available, next), false);
await delivered(appointment.id, "reschedule");
appointment = (
  await call(`/admin/appointments/${appointment.id}/status`, "PUT", {
    status: "confirmed",
    version: appointment.version,
  })
).data;
assert.equal(appointment.status, "confirmed");
assert.equal(
  (await call(`/admin/appointments/${appointment.id}/reminder`, "POST", {}))
    .data.queued,
  true,
);
assert.equal(
  (await call(`/admin/appointments/${appointment.id}/reminder`, "POST", {}))
    .data.queued,
  false,
);
await delivered(appointment.id, "test-reminder");
appointment = (
  await call(`/appointments/${appointment.id}/cancel`, "POST", {
    version: appointment.version,
  })
).data;
assert.equal(appointment.status, "cancelled");
assert.equal(includes(await availability(), next), true);
await delivered(appointment.id, "cancellation");
// Leave one upcoming appointment so the real minute scheduler can deliver its due reminder.
const scheduled = (
  await call(
    "/appointments",
    "POST",
    payload(first, "Scheduled Reminder Test"),
    201,
  )
).data;
await delivered(scheduled.id, "booking");
const report = {
  verifiedAt: new Date().toISOString(),
  origin,
  checks: [
    "public session and catalog",
    "concurrent race: 201 + 409",
    "same-key replay: one saved appointment",
    "database-backed history",
    "reserved slot excluded",
    "atomic reschedule; old slot released",
    "scoped admin status update",
    "test reminder deduplicated",
    "cancelled slot released",
    "real Telegram receipts",
  ],
  raceStatuses: race.map((r) => r.status).sort(),
  cancelledReference: appointment.reference,
  scheduledReminder: {
    id: scheduled.id,
    reference: scheduled.reference,
    startsAt: scheduled.startsAt,
    reminderAt: scheduled.reminderAt,
  },
  receipts,
};
await writeFile(
  "artifacts/production-smoke.json",
  JSON.stringify(report, null, 2) + "\n",
);
console.log(JSON.stringify(report, null, 2));
