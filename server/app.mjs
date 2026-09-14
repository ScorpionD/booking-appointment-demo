import express from "express";
import helmet from "helmet";
import cookieParser from "cookie-parser";
import rateLimit from "express-rate-limit";
import pino from "pino";
import { z } from "zod";
import { randomUUID, createHmac, timingSafeEqual } from "node:crypto";
import { DateTime } from "luxon";
import { hash, token, transaction, lock, seed } from "./db.mjs";
import {
  AppError,
  assert,
  calculateSlots,
  validDate,
  ZONE,
  today,
  transition,
  ACTIVE,
  overlap,
} from "./domain.mjs";
const uuid = z.string().uuid();
const str = (max, min = 1) => z.string().trim().min(min).max(max);
const dateSchema = z.string().refine(validDate, "Choose a valid date.");
const contact = {
  name: str(80, 2),
  email: z.email().max(120),
  phone: z
    .string()
    .trim()
    .regex(/^[+\d ()-]{7,30}$/),
  note: str(600, 0).default(""),
};
const slotSchema = z.object({
  serviceId: uuid,
  staffId: uuid,
  startsAt: z.iso.datetime({ offset: true }),
});
const bookingSchema = slotSchema
  .extend({ ...contact, idempotencyKey: uuid, consent: z.literal(true) })
  .strict();
const serviceSchema = z
  .object({
    name: str(80, 2),
    duration: z.number().int().min(15).max(180).multipleOf(15),
    price: z.number().int().min(0).max(100000),
    description: str(300, 5),
    active: z.boolean(),
  })
  .strict();
const staffSchema = z
  .object({
    name: str(80, 2),
    bio: str(200, 2),
    active: z.boolean(),
    serviceIds: z.array(uuid).min(1).max(20),
  })
  .strict();
const versionSchema = z
  .object({ version: z.number().int().positive() })
  .strict();
const safeEqual = (a, b) =>
  typeof a === "string" &&
  typeof b === "string" &&
  a.length === b.length &&
  timingSafeEqual(Buffer.from(a), Buffer.from(b));
function present(a) {
  return {
    id: a.id,
    reference: a.reference,
    serviceId: a.service_id,
    staffId: a.staff_id,
    serviceName: a.service_name,
    staffName: a.staff_name,
    duration: a.duration,
    price: a.price,
    startsAt: a.starts_at,
    endsAt: a.ends_at,
    name: a.name,
    email: a.email,
    phone: a.phone,
    note: a.note,
    status: a.status,
    version: a.version,
    reminderAt: a.reminder_at,
    createdAt: a.created_at,
  };
}
const log = pino({
  level: process.env.NODE_ENV === "test" ? "silent" : "info",
  redact: ["req.headers", "email", "phone", "note", "token"],
});
export function createApp(db, config = {}) {
  const env = {
    origin: process.env.PUBLIC_ORIGIN || "http://localhost:5173",
    secret: process.env.ORIGIN_SECRET || "local-only-origin",
    automation: process.env.AUTOMATION_SECRET || "local-only-automation",
    production: process.env.NODE_ENV === "production",
    rate: process.env.RATE_LIMIT_ENABLED !== "false",
    ...config,
  };
  if (env.production)
    assert(
      env.secret.length >= 32 && env.automation.length >= 32,
      500,
      "CONFIG",
      "Production secrets must be configured.",
    );
  const management = (a) =>
    createHmac("sha256", env.secret)
      .update("booking:" + a.id)
      .digest("base64url");
  const app = express();
  app.disable("x-powered-by");
  if (env.production) app.set("trust proxy", 1);
  app.use(helmet());
  app.use(cookieParser());
  app.use((req, res, next) => {
    req.requestId = randomUUID();
    res.set("Cache-Control", "no-store");
    res.set("X-Request-ID", req.requestId);
    const start = Date.now();
    res.on("finish", () =>
      log.info(
        {
          id: req.requestId,
          method: req.method,
          path: req.path,
          status: res.statusCode,
          ms: Date.now() - start,
        },
        "request",
      ),
    );
    next();
  });
  app.use("/api/automation", (req, _res, next) => {
    assert(
      safeEqual(req.get("x-automation-secret"), env.automation),
      403,
      "DENIED",
      "Access denied.",
    );
    next();
  });
  app.use((req, _res, next) => {
    if (req.path.startsWith("/api/automation/")) return next();
    if (env.production)
      assert(
        safeEqual(req.get("x-origin-secret"), env.secret),
        403,
        "DENIED",
        "Access denied.",
      );
    next();
  });
  if (env.rate)
    app.use(
      "/api",
      rateLimit({
        windowMs: 60000,
        limit: 150,
        standardHeaders: "draft-8",
        legacyHeaders: false,
        skip: (req) => req.path.startsWith("/automation/"),
        message: {
          error: {
            code: "RATE_LIMITED",
            message: "Too many requests. Please wait a minute.",
          },
        },
      }),
    );
  app.use(express.json({ limit: "16kb", strict: true }));
  app.get("/api/health", async (_req, res) => {
    await db.query("SELECT 1");
    res.json({ ok: true, service: "northline-booking", timezone: ZONE });
  });
  app.use(async (req, _res, next) => {
    if (
      !req.path.startsWith("/api/") ||
      req.path.startsWith("/api/automation/")
    )
      return next();
    const raw = req.cookies.nb_session;
    if (raw)
      req.workspace = (
        await db.query(
          "SELECT * FROM workspaces WHERE token_hash=$1 AND expires_at>now()",
          [hash(raw)],
        )
      ).rows[0];
    next();
  });
  app.get("/api/session", async (req, res) => {
    if (!req.workspace) {
      const raw = token();
      req.workspace = await transaction(db, async (c) => {
        await c.query("DELETE FROM workspaces WHERE expires_at<now()");
        const count = await c.query(
          "INSERT INTO usage_limits VALUES('sessions:'||to_char(now(),'YYYY-MM-DD-HH24'),1,now()+interval '2 hours') ON CONFLICT(key) DO UPDATE SET count=usage_limits.count+1 RETURNING count",
        );
        assert(
          count.rows[0].count <= 120,
          429,
          "BUSY",
          "Demo capacity reached. Please try again later.",
        );
        const a = (
          await c.query(
            "INSERT INTO workspaces(id,token_hash,csrf) VALUES($1,$2,$3) RETURNING *",
            [randomUUID(), hash(raw), token()],
          )
        ).rows[0];
        await seed(c, a.id);
        return a;
      });
      res.cookie("nb_session", raw, {
        httpOnly: true,
        secure: env.production,
        sameSite: "strict",
        maxAge: 48 * 3600000,
        path: "/",
      });
    }
    res.json({
      csrf: req.workspace.csrf,
      admin: req.workspace.admin,
      expiresAt: req.workspace.expires_at,
      timezone: ZONE,
      today: today(),
    });
  });
  app.use((req, _res, next) => {
    if (req.path.startsWith("/api/automation/")) return next();
    assert(
      req.workspace,
      401,
      "SESSION_EXPIRED",
      "Your demo session expired. Refresh to start a new workspace.",
    );
    if (!["GET", "HEAD"].includes(req.method)) {
      assert(
        req.get("origin") === env.origin,
        403,
        "ORIGIN_DENIED",
        "Request origin is not allowed.",
      );
      assert(
        safeEqual(req.get("x-csrf-token"), req.workspace.csrf),
        403,
        "CSRF",
        "Session protection failed. Refresh and try again.",
      );
    }
    next();
  });
  const admin = (req, _res, next) => {
    assert(
      req.workspace.admin,
      403,
      "ADMIN_REQUIRED",
      "Open the demo admin workspace first.",
    );
    next();
  };
  async function catalog(c, workspace) {
    const services = (
      await c.query(
        "SELECT id,name,duration,price,description,active FROM services WHERE workspace_id=$1 ORDER BY price,name",
        [workspace],
      )
    ).rows;
    const staff = (
      await c.query(
        "SELECT s.*,COALESCE(array_agg(ss.service_id) FILTER(WHERE ss.service_id IS NOT NULL),ARRAY[]::uuid[]) AS services FROM staff s LEFT JOIN staff_services ss ON ss.staff_id=s.id WHERE workspace_id=$1 GROUP BY s.id ORDER BY name",
        [workspace],
      )
    ).rows;
    const hours = (
      await c.query(
        "SELECT h.* FROM working_hours h JOIN staff s ON s.id=h.staff_id WHERE s.workspace_id=$1 ORDER BY weekday,start_minute",
        [workspace],
      )
    ).rows;
    return {
      services,
      staff: staff.map(({ workspace_id: _w, ...s }) => s),
      hours,
    };
  }
  async function owned(req, c = db, id = req.params.id) {
    uuid.parse(id);
    const a = (
      await c.query(
        "SELECT a.* FROM appointments a JOIN workspaces w ON a.workspace_id=w.id WHERE a.id=$1 AND w.expires_at>now()",
        [id],
      )
    ).rows[0];
    assert(
      a &&
        (a.workspace_id === req.workspace.id ||
          safeEqual(hash(req.get("x-booking-token") || ""), a.manage_hash)),
      404,
      "NOT_FOUND",
      "Booking not found or management key is invalid.",
    );
    return a;
  }
  async function slots(c, workspace, date, serviceId, staffId, excludeId) {
    assert(validDate(date), 422, "INVALID_DATE", "Choose a valid date.");
    const day = DateTime.fromISO(date, { zone: ZONE });
    const now = DateTime.now().setZone(ZONE);
    assert(
      day.startOf("day") >= now.startOf("day") &&
        day < now.plus({ days: 31 }).startOf("day"),
      422,
      "DATE_RANGE",
      "Bookings are available for the next 30 days.",
    );
    const cat = await catalog(c, workspace);
    const service = cat.services.find((s) => s.id === serviceId && s.active);
    assert(
      service,
      422,
      "SERVICE_UNAVAILABLE",
      "This service is not currently available.",
    );
    const people = cat.staff.filter(
      (s) =>
        s.active &&
        s.services.includes(serviceId) &&
        (!staffId || s.id === staffId),
    );
    const from = day.startOf("day").toUTC().toISO(),
      to = day.plus({ days: 1 }).startOf("day").toUTC().toISO();
    const busy = (
      await c.query(
        "SELECT staff_id,starts_at,ends_at FROM appointments WHERE workspace_id=$1 AND starts_at<$3 AND ends_at>$2 AND status IN ('booked','confirmed') AND ($4::uuid IS NULL OR id<>$4) UNION ALL SELECT staff_id,starts_at,ends_at FROM blocked_times WHERE workspace_id=$1 AND starts_at<$3 AND ends_at>$2",
        [workspace, from, to, excludeId || null],
      )
    ).rows;
    return {
      date,
      timezone: ZONE,
      service,
      slots: calculateSlots({
        date,
        duration: service.duration,
        staff: people,
        hours: cat.hours,
        busy,
      }),
    };
  }
  app.get("/api/catalog", async (req, res) =>
    res.json(await catalog(db, req.workspace.id)),
  );
  app.get("/api/availability", async (req, res) => {
    const q = z
      .object({
        date: dateSchema,
        serviceId: uuid,
        staffId: uuid.optional(),
        bookingId: uuid.optional(),
      })
      .parse(req.query);
    let workspace = req.workspace.id;
    if (q.bookingId)
      workspace = (await owned(req, db, q.bookingId)).workspace_id;
    res.json(
      await slots(db, workspace, q.date, q.serviceId, q.staffId, q.bookingId),
    );
  });
  async function event(c, a, kind, actor, detail = {}) {
    await c.query(
      "INSERT INTO appointment_events VALUES($1,$2,$3,$4,$5,now())",
      [randomUUID(), a.id, kind, actor, detail],
    );
  }
  async function notify(c, a, kind) {
    const payload = {
      reference: a.reference,
      name: a.name,
      service: a.service_name,
      staff: a.staff_name,
      startsAt: a.starts_at,
      status: a.status,
      kind,
    };
    return (
      await c.query(
        "INSERT INTO notifications(id,appointment_id,kind,version,payload) VALUES($1,$2,$3,$4,$5) ON CONFLICT(appointment_id,kind,version) DO NOTHING RETURNING id",
        [
          randomUUID(),
          a.id,
          kind,
          ["reminder", "test-reminder"].includes(kind)
            ? a.schedule_version
            : a.version,
          payload,
        ],
      )
    ).rows[0]?.id;
  }
  function dispatch(id) {
    if (!id || !process.env.N8N_WEBHOOK_URL) return;
    void fetch(process.env.N8N_WEBHOOK_URL, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "x-automation-secret": env.automation,
      },
      body: JSON.stringify({ eventId: id }),
      signal: AbortSignal.timeout(4000),
    }).catch(() =>
      log.warn(
        { eventId: id },
        "Notification remains queued for scheduled retry",
      ),
    );
  }
  async function details(a) {
    const events = (
      await db.query(
        "SELECT kind,actor,detail,created_at FROM appointment_events WHERE appointment_id=$1 ORDER BY created_at DESC",
        [a.id],
      )
    ).rows;
    const notifications = (
      await db.query(
        "SELECT id,kind,state,message_id,created_at,delivered_at FROM notifications WHERE appointment_id=$1 ORDER BY created_at DESC",
        [a.id],
      )
    ).rows;
    return {
      ...present(a),
      events,
      notifications,
      managementKey: management(a),
    };
  }
  app.get("/api/appointments", async (req, res) => {
    const rows = (
      await db.query(
        "SELECT * FROM appointments WHERE workspace_id=$1 ORDER BY created_at DESC LIMIT 30",
        [req.workspace.id],
      )
    ).rows;
    res.json({ appointments: rows.map(present) });
  });
  app.get("/api/appointments/:id", async (req, res) =>
    res.json(await details(await owned(req))),
  );
  app.post("/api/appointments", async (req, res) => {
    const b = bookingSchema.parse(req.body);
    const requestHash = hash(JSON.stringify(b));
    const result = await transaction(db, async (c) => {
      await lock(c, req.workspace.id);
      const old = (
        await c.query(
          "SELECT * FROM appointments WHERE workspace_id=$1 AND idempotency_key=$2",
          [req.workspace.id, b.idempotencyKey],
        )
      ).rows[0];
      if (old) {
        assert(
          old.request_hash === requestHash,
          409,
          "IDEMPOTENCY_CONFLICT",
          "This request reference was already used for different details.",
        );
        return { a: old, replayed: true };
      }
      const count = (
        await c.query(
          "SELECT count(*)::int AS n FROM appointments WHERE workspace_id=$1",
          [req.workspace.id],
        )
      ).rows[0].n;
      assert(
        count < 20,
        429,
        "DEMO_LIMIT",
        "This workspace allows 20 demo bookings.",
      );
      const day = DateTime.fromISO(b.startsAt).setZone(ZONE).toISODate();
      const available = await slots(
        c,
        req.workspace.id,
        day,
        b.serviceId,
        b.staffId,
      );
      const selected = available.slots.find(
        (s) =>
          new Date(s.startsAt).getTime() === new Date(b.startsAt).getTime(),
      );
      assert(
        selected,
        409,
        "SLOT_TAKEN",
        "That time is no longer available. Please choose another slot.",
      );
      const id = randomUUID();
      const manage = management({ id });
      const reminder = new Date(
        Math.max(
          new Date(selected.startsAt).getTime() - 86400000,
          Date.now() + 300000,
        ),
      );
      const a = (
        await c.query(
          "INSERT INTO appointments(id,workspace_id,reference,manage_hash,idempotency_key,request_hash,service_id,staff_id,service_name,staff_name,duration,price,starts_at,ends_at,name,email,phone,note,reminder_at) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19) RETURNING *",
          [
            id,
            req.workspace.id,
            "NB-" + id.slice(0, 8).toUpperCase(),
            hash(manage),
            b.idempotencyKey,
            requestHash,
            b.serviceId,
            b.staffId,
            available.service.name,
            selected.staffName,
            available.service.duration,
            available.service.price,
            selected.startsAt,
            selected.endsAt,
            b.name,
            b.email,
            b.phone,
            b.note,
            reminder,
          ],
        )
      ).rows[0];
      await event(
        c,
        a,
        "booked",
        req.workspace.admin ? "demo admin" : "customer",
      );
      return { a, eventId: await notify(c, a, "booking"), replayed: false };
    });
    dispatch(result.eventId);
    res
      .status(result.replayed ? 200 : 201)
      .json({ ...(await details(result.a)), replayed: result.replayed });
  });
  app.put("/api/appointments/:id/reschedule", async (req, res) => {
    const b = z
      .object({
        startsAt: z.iso.datetime({ offset: true }),
        staffId: uuid,
        version: z.number().int().positive(),
      })
      .strict()
      .parse(req.body);
    const original = await owned(req);
    const result = await transaction(db, async (c) => {
      await lock(c, original.workspace_id);
      const a = await owned(req, c);
      assert(
        ACTIVE.includes(a.status) && a.version === b.version,
        409,
        "STALE_BOOKING",
        "This booking changed. Refresh its details before trying again.",
      );
      assert(
        new Date(a.starts_at) > new Date(),
        409,
        "PAST_BOOKING",
        "Past appointments cannot be rescheduled.",
      );
      const date = DateTime.fromISO(b.startsAt).setZone(ZONE).toISODate();
      const av = await slots(
        c,
        a.workspace_id,
        date,
        a.service_id,
        b.staffId,
        a.id,
      );
      const selected = av.slots.find(
        (s) =>
          new Date(s.startsAt).getTime() === new Date(b.startsAt).getTime(),
      );
      assert(
        selected,
        409,
        "SLOT_TAKEN",
        "That time is no longer available. Your existing booking is unchanged.",
      );
      assert(
        new Date(a.starts_at).getTime() !== new Date(b.startsAt).getTime() ||
          a.staff_id !== b.staffId,
        422,
        "UNCHANGED",
        "Choose a different time or specialist.",
      );
      const changed = (
        await c.query(
          "UPDATE appointments SET staff_id=$2,staff_name=$3,starts_at=$4,ends_at=$5,duration=$6,version=version+1,status='booked',reminder_at=$7 WHERE id=$1 RETURNING *",
          [
            a.id,
            b.staffId,
            selected.staffName,
            selected.startsAt,
            selected.endsAt,
            av.service.duration,
            new Date(
              Math.max(
                new Date(selected.startsAt).getTime() - 86400000,
                Date.now() + 300000,
              ),
            ),
          ],
        )
      ).rows[0];
      await c.query(
        "UPDATE notifications SET state='cancelled' WHERE appointment_id=$1 AND state='pending' AND kind IN ('reminder','test-reminder')",
        [a.id],
      );
      await event(
        c,
        changed,
        "rescheduled",
        req.workspace.admin ? "demo admin" : "customer",
        { previousStart: a.starts_at, previousStaff: a.staff_name },
      );
      return { a: changed, eventId: await notify(c, changed, "reschedule") };
    });
    dispatch(result.eventId);
    res.json(await details(result.a));
  });
  async function changeStatus(req, res, status) {
    const b = versionSchema.parse(
      status ? req.body : { version: req.body.version },
    );
    const original = await owned(req);
    const to =
      status ||
      z
        .enum(["confirmed", "completed", "no-show", "cancelled"])
        .parse(req.body.status);
    const out = await transaction(db, async (c) => {
      await lock(c, original.workspace_id);
      const a = await owned(req, c);
      assert(
        a.version === b.version,
        409,
        "STALE_BOOKING",
        "This booking changed. Refresh before trying again.",
      );
      transition(a.status, to, a.starts_at);
      if (!req.workspace.admin)
        assert(
          new Date(a.starts_at) > new Date(),
          409,
          "PAST_BOOKING",
          "Past appointments require administrator review.",
        );
      const changed = (
        await c.query(
          "UPDATE appointments SET status=$2,version=version+1,reminder_at=CASE WHEN $2='confirmed' THEN reminder_at ELSE NULL END WHERE id=$1 RETURNING *",
          [a.id, to],
        )
      ).rows[0];
      if (to !== "confirmed")
        await c.query(
          "UPDATE notifications SET state='cancelled' WHERE appointment_id=$1 AND state='pending' AND kind IN ('reminder','test-reminder')",
          [a.id],
        );
      await event(
        c,
        changed,
        to,
        req.workspace.admin ? "demo admin" : "customer",
      );
      return {
        a: changed,
        eventId:
          to === "cancelled" ? await notify(c, changed, "cancellation") : null,
      };
    });
    dispatch(out.eventId);
    res.json(await details(out.a));
  }
  app.post("/api/appointments/:id/cancel", (req, res) =>
    changeStatus(req, res, "cancelled"),
  );
  app.post("/api/admin/login", async (req, res) => {
    z.object({ acknowledge: z.literal(true) })
      .strict()
      .parse(req.body);
    await db.query("UPDATE workspaces SET admin=true WHERE id=$1", [
      req.workspace.id,
    ]);
    res.json({ admin: true });
  });
  app.use("/api/admin", admin);
  app.post("/api/admin/logout", async (req, res) => {
    await db.query("UPDATE workspaces SET admin=false WHERE id=$1", [
      req.workspace.id,
    ]);
    res.json({ admin: false });
  });
  app.get("/api/admin/appointments", async (req, res) => {
    const q = z
      .object({
        date: dateSchema.optional(),
        status: z
          .enum(["booked", "confirmed", "completed", "cancelled", "no-show"])
          .optional(),
        serviceId: uuid.optional(),
        staffId: uuid.optional(),
      })
      .parse(req.query);
    const rows = (
      await db.query(
        "SELECT * FROM appointments WHERE workspace_id=$1 AND ($2::text IS NULL OR to_char(starts_at AT TIME ZONE 'Europe/London','YYYY-MM-DD')=$2) AND ($3::text IS NULL OR status=$3) AND ($4::uuid IS NULL OR service_id=$4) AND ($5::uuid IS NULL OR staff_id=$5) ORDER BY starts_at LIMIT 100",
        [
          req.workspace.id,
          q.date || null,
          q.status || null,
          q.serviceId || null,
          q.staffId || null,
        ],
      )
    ).rows;
    res.json({ appointments: rows.map(present) });
  });
  app.put("/api/admin/appointments/:id/status", (req, res) =>
    changeStatus(req, res),
  );
  app.post("/api/admin/appointments/:id/reminder", async (req, res) => {
    const original = await owned(req);
    const id = await transaction(db, async (c) => {
      await lock(c, original.workspace_id);
      const a = await owned(req, c);
      assert(
        ACTIVE.includes(a.status) && new Date(a.starts_at) > new Date(),
        409,
        "REMINDER_UNAVAILABLE",
        "Only upcoming active appointments can receive reminders.",
      );
      const eventId = await notify(c, a, "test-reminder");
      if (eventId) await event(c, a, "test-reminder", "demo admin");
      return eventId;
    });
    dispatch(id);
    res.json({
      queued: Boolean(id),
      message: id
        ? "Test reminder queued for Telegram."
        : "A test reminder already exists for this booking version.",
    });
  });
  async function saveService(req, res) {
    const b = serviceSchema.parse(req.body);
    const id = req.params.id ? uuid.parse(req.params.id) : randomUUID();
    await transaction(db, async (c) => {
      await lock(c, req.workspace.id);
      if (req.params.id) {
        const r = await c.query(
          "UPDATE services SET name=$3,duration=$4,price=$5,description=$6,active=$7 WHERE id=$1 AND workspace_id=$2",
          [
            id,
            req.workspace.id,
            b.name,
            b.duration,
            b.price,
            b.description,
            b.active,
          ],
        );
        assert(r.rowCount, 404, "NOT_FOUND", "Service not found.");
      } else {
        const n = (
          await c.query(
            "SELECT count(*)::int AS n FROM services WHERE workspace_id=$1",
            [req.workspace.id],
          )
        ).rows[0].n;
        assert(
          n < 15,
          429,
          "DEMO_LIMIT",
          "This demo supports up to 15 services.",
        );
        await c.query("INSERT INTO services VALUES($1,$2,$3,$4,$5,$6,$7)", [
          id,
          req.workspace.id,
          b.name,
          b.duration,
          b.price,
          b.description,
          b.active,
        ]);
      }
    });
    res.json({ id });
  }
  app.post("/api/admin/services", saveService);
  app.put("/api/admin/services/:id", saveService);
  async function saveStaff(req, res) {
    const b = staffSchema.parse(req.body);
    const id = req.params.id ? uuid.parse(req.params.id) : randomUUID();
    await transaction(db, async (c) => {
      await lock(c, req.workspace.id);
      const ids = (
        await c.query(
          "SELECT id FROM services WHERE workspace_id=$1 AND id=ANY($2::uuid[])",
          [req.workspace.id, b.serviceIds],
        )
      ).rows;
      assert(
        ids.length === new Set(b.serviceIds).size,
        422,
        "INVALID_SERVICES",
        "Choose services from this workspace.",
      );
      if (req.params.id) {
        const r = await c.query(
          "UPDATE staff SET name=$3,bio=$4,active=$5 WHERE id=$1 AND workspace_id=$2",
          [id, req.workspace.id, b.name, b.bio, b.active],
        );
        assert(r.rowCount, 404, "NOT_FOUND", "Specialist not found.");
      } else {
        assert(
          (
            await c.query(
              "SELECT count(*)::int AS n FROM staff WHERE workspace_id=$1",
              [req.workspace.id],
            )
          ).rows[0].n < 8,
          429,
          "DEMO_LIMIT",
          "This demo supports up to 8 specialists.",
        );
        await c.query("INSERT INTO staff VALUES($1,$2,$3,$4,$5)", [
          id,
          req.workspace.id,
          b.name,
          b.bio,
          b.active,
        ]);
      }
      await c.query("DELETE FROM staff_services WHERE staff_id=$1", [id]);
      for (const service of new Set(b.serviceIds))
        await c.query("INSERT INTO staff_services VALUES($1,$2)", [
          id,
          service,
        ]);
    });
    res.json({ id });
  }
  app.post("/api/admin/staff", saveStaff);
  app.put("/api/admin/staff/:id", saveStaff);
  app.put("/api/admin/staff/:id/hours", async (req, res) => {
    const id = uuid.parse(req.params.id);
    const rule = z
      .object({
        weekday: z.number().int().min(1).max(7),
        start: z.number().int().min(0).max(1425).multipleOf(15),
        end: z.number().int().min(15).max(1440).multipleOf(15),
      })
      .refine((r) => r.end > r.start);
    const b = z
      .object({ rules: z.array(rule).max(21) })
      .strict()
      .parse(req.body);
    for (let i = 0; i < b.rules.length; i++)
      for (let j = i + 1; j < b.rules.length; j++) {
        const a = b.rules[i],
          d = b.rules[j];
        assert(
          a.weekday !== d.weekday || a.start >= d.end || d.start >= a.end,
          422,
          "OVERLAPPING_HOURS",
          "Working-hour periods cannot overlap.",
        );
      }
    await transaction(db, async (c) => {
      await lock(c, req.workspace.id);
      assert(
        (
          await c.query("SELECT 1 FROM staff WHERE id=$1 AND workspace_id=$2", [
            id,
            req.workspace.id,
          ])
        ).rowCount,
        404,
        "NOT_FOUND",
        "Specialist not found.",
      );
      const appointments = (
        await c.query(
          "SELECT * FROM appointments WHERE staff_id=$1 AND ends_at>now() AND status IN ('booked','confirmed')",
          [id],
        )
      ).rows;
      for (const a of appointments) {
        const start = DateTime.fromJSDate(a.starts_at).setZone(ZONE),
          end = DateTime.fromJSDate(a.ends_at).setZone(ZONE);
        assert(
          b.rules.some(
            (r) =>
              r.weekday === start.weekday &&
              r.start <= start.hour * 60 + start.minute &&
              r.end >= end.hour * 60 + end.minute,
          ),
          409,
          "SCHEDULE_CONFLICT",
          "Existing bookings fall outside these hours. Reschedule them first.",
        );
      }
      await c.query("DELETE FROM working_hours WHERE staff_id=$1", [id]);
      for (const r of b.rules)
        await c.query("INSERT INTO working_hours VALUES($1,$2,$3,$4,$5)", [
          randomUUID(),
          id,
          r.weekday,
          r.start,
          r.end,
        ]);
    });
    res.json({ ok: true });
  });
  app.get("/api/admin/blocks", async (req, res) =>
    res.json({
      blocks: (
        await db.query(
          "SELECT * FROM blocked_times WHERE workspace_id=$1 ORDER BY starts_at",
          [req.workspace.id],
        )
      ).rows,
    }),
  );
  app.post("/api/admin/blocks", async (req, res) => {
    const b = z
      .object({
        staffId: uuid,
        startsAt: z.iso.datetime({ offset: true }),
        endsAt: z.iso.datetime({ offset: true }),
        reason: str(100, 2),
      })
      .strict()
      .parse(req.body);
    assert(
      new Date(b.endsAt) > new Date(b.startsAt) &&
        new Date(b.endsAt) - new Date(b.startsAt) <= 7 * 86400000,
      422,
      "INVALID_PERIOD",
      "Choose an unavailable period of at most 7 days.",
    );
    const id = randomUUID();
    await transaction(db, async (c) => {
      await lock(c, req.workspace.id);
      assert(
        (
          await c.query("SELECT 1 FROM staff WHERE id=$1 AND workspace_id=$2", [
            b.staffId,
            req.workspace.id,
          ])
        ).rowCount,
        404,
        "NOT_FOUND",
        "Specialist not found.",
      );
      const list = (
        await c.query(
          "SELECT starts_at,ends_at FROM appointments WHERE workspace_id=$1 AND staff_id=$2 AND status IN ('booked','confirmed')",
          [req.workspace.id, b.staffId],
        )
      ).rows;
      assert(
        !list.some((a) =>
          overlap(a.starts_at, a.ends_at, b.startsAt, b.endsAt),
        ),
        409,
        "SCHEDULE_CONFLICT",
        "This period contains an active booking. Reschedule or cancel it first.",
      );
      assert(
        (
          await c.query(
            "SELECT count(*)::int AS n FROM blocked_times WHERE workspace_id=$1",
            [req.workspace.id],
          )
        ).rows[0].n < 30,
        429,
        "DEMO_LIMIT",
        "This demo supports up to 30 blocked periods.",
      );
      await c.query("INSERT INTO blocked_times VALUES($1,$2,$3,$4,$5,$6)", [
        id,
        req.workspace.id,
        b.staffId,
        b.startsAt,
        b.endsAt,
        b.reason,
      ]);
    });
    res.status(201).json({ id });
  });
  app.delete("/api/admin/blocks/:id", async (req, res) => {
    await transaction(db, async (c) => {
      await lock(c, req.workspace.id);
      assert(
        (
          await c.query(
            "DELETE FROM blocked_times WHERE id=$1 AND workspace_id=$2",
            [uuid.parse(req.params.id), req.workspace.id],
          )
        ).rowCount,
        404,
        "NOT_FOUND",
        "Unavailable period not found.",
      );
    });
    res.json({ ok: true });
  });
  app.get("/api/admin/automation", async (req, res) =>
    res.json({
      notifications: (
        await db.query(
          "SELECT n.id,a.reference,n.kind,n.state,n.message_id,n.created_at,n.delivered_at FROM notifications n JOIN appointments a ON a.id=n.appointment_id WHERE a.workspace_id=$1 ORDER BY n.created_at DESC LIMIT 80",
          [req.workspace.id],
        )
      ).rows,
    }),
  );
  // n8n alone calls these internal endpoints. They are denied by the public Worker.
  app.post("/api/automation/due", async (_req, res) => {
    const ids = await transaction(db, async (c) => {
      await c.query(
        "UPDATE notifications SET state='review' WHERE state='sending' AND claimed_at<now()-interval '2 minutes'",
      );
      const due = (
        await c.query(
          "SELECT a.* FROM appointments a JOIN workspaces w ON a.workspace_id=w.id WHERE a.status IN ('booked','confirmed') AND a.reminder_at<=now() AND a.starts_at>now() AND w.expires_at>now() LIMIT 40 FOR UPDATE OF a SKIP LOCKED",
        )
      ).rows;
      for (const a of due) {
        await notify(c, a, "reminder");
        await c.query("UPDATE appointments SET reminder_at=NULL WHERE id=$1", [
          a.id,
        ]);
      }
      await c.query(
        "UPDATE notifications SET state='failed' WHERE state='pending' AND attempts>=4",
      );
      return (
        await c.query(
          "SELECT n.id FROM notifications n JOIN appointments a ON a.id=n.appointment_id JOIN workspaces w ON w.id=a.workspace_id WHERE n.state='pending' AND n.next_attempt_at<=now() AND w.expires_at>now() ORDER BY n.created_at LIMIT 10",
        )
      ).rows;
    });
    res.json(ids.map((x) => ({ eventId: x.id })));
  });
  app.post("/api/automation/claim", async (req, res) => {
    const id = z.object({ eventId: uuid }).parse(req.body).eventId;
    const claim = token();
    const result = await transaction(db, async (c) => {
      const n = (
        await c.query(
          "SELECT n.*,a.status AS appointment_status,a.starts_at AS appointment_start,a.schedule_version AS appointment_version,w.expires_at FROM notifications n JOIN appointments a ON a.id=n.appointment_id JOIN workspaces w ON w.id=a.workspace_id WHERE n.id=$1 FOR UPDATE OF n",
          [id],
        )
      ).rows[0];
      if (
        !n ||
        n.state !== "pending" ||
        n.attempts >= 4 ||
        new Date(n.next_attempt_at) > new Date() ||
        new Date(n.expires_at) < new Date()
      )
        return { claimed: false };
      if (
        ["reminder", "test-reminder"].includes(n.kind) &&
        (!ACTIVE.includes(n.appointment_status) ||
          n.version !== n.appointment_version ||
          new Date(n.appointment_start) <= new Date())
      ) {
        await c.query(
          "UPDATE notifications SET state='cancelled' WHERE id=$1",
          [id],
        );
        return { claimed: false };
      }
      const allowance = await c.query(
        "INSERT INTO usage_limits VALUES('telegram:'||to_char(now(),'YYYY-MM-DD-HH24'),1,now()+interval '2 hours') ON CONFLICT(key) DO UPDATE SET count=usage_limits.count+1 WHERE usage_limits.count<60 RETURNING count",
      );
      if (!allowance.rowCount) {
        await c.query(
          "UPDATE notifications SET next_attempt_at=now()+interval '15 minutes' WHERE id=$1",
          [id],
        );
        return { claimed: false };
      }
      await c.query(
        "UPDATE notifications SET state='sending',claim_hash=$2,claimed_at=now(),attempts=attempts+1 WHERE id=$1",
        [id, hash(claim)],
      );
      const p = n.payload;
      const time = DateTime.fromISO(new Date(p.startsAt).toISOString())
        .setZone(ZONE)
        .toFormat("ccc dd LLL yyyy, HH:mm ZZZZ");
      return {
        claimed: true,
        eventId: id,
        claim,
        text: `NORTHLINE BOOKING · ${n.kind.toUpperCase()}\nBooking: ${p.reference}\nCustomer: ${p.name}\nService: ${p.service}\nSpecialist: ${p.staff}\nWhen: ${time} (${ZONE})\nStatus: ${p.status}\nPortfolio demo · fictional appointment. Telegram is the demo delivery channel.`,
      };
    });
    res.json(result);
  });
  app.post("/api/automation/complete", async (req, res) => {
    const b = z
      .object({
        eventId: uuid,
        claim: str(100),
        delivered: z.boolean(),
        messageId: z.string().max(40).nullable(),
      })
      .strict()
      .parse(req.body);
    assert(
      !b.delivered || b.messageId,
      422,
      "INVALID_RECEIPT",
      "A delivery receipt is required.",
    );
    const r = await db.query(
      "UPDATE notifications SET state=CASE WHEN $3 THEN 'delivered' ELSE 'review' END,message_id=$4,delivered_at=CASE WHEN $3 THEN now() ELSE NULL END WHERE id=$1 AND claim_hash=$2 AND state IN ('sending','review') RETURNING id",
      [b.eventId, hash(b.claim), b.delivered, b.messageId],
    );
    if (!r.rowCount)
      assert(
        (
          await db.query(
            "SELECT 1 FROM notifications WHERE id=$1 AND claim_hash=$2 AND state='delivered'",
            [b.eventId, hash(b.claim)],
          )
        ).rowCount,
        409,
        "CLAIM_CONFLICT",
        "Delivery claim is not valid.",
      );
    res.json({ ok: true });
  });
  app.use((_req, _res) => {
    throw new AppError(404, "NOT_FOUND", "Endpoint not found.");
  });
  app.use((err, req, res, _next) => {
    let status = err.status || 500,
      code = err.code || "INTERNAL_ERROR",
      message = err.message;
    if (err instanceof z.ZodError) {
      status = 422;
      code = "VALIDATION";
      message = err.issues
        .map((i) => `${i.path.join(".")}: ${i.message}`)
        .join(" ")
        .slice(0, 350);
    } else if (err.code === "23P01") {
      status = 409;
      code = "SLOT_TAKEN";
      message = "That time was just booked. Please choose another slot.";
    } else if (err.type === "entity.too.large") {
      status = 413;
      code = "TOO_LARGE";
      message = "The request is too large.";
    } else if (err instanceof SyntaxError && err.status === 400) {
      code = "INVALID_JSON";
      message = "Send a valid JSON request.";
    } else if (!(err instanceof AppError)) {
      status = 500;
      code = "INTERNAL_ERROR";
      message =
        "The service could not complete this request. Please try again.";
      log.error({ requestId: req.requestId, code: err.code }, "API failure");
    }
    res
      .status(status)
      .json({ error: { code, message, requestId: req.requestId } });
  });
  return app;
}
