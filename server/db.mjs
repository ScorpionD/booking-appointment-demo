import pg from "pg";
import fs from "node:fs/promises";
import { randomUUID, randomBytes, createHash } from "node:crypto";
export const hash = (value) => createHash("sha256").update(value).digest("hex");
export const token = () => randomBytes(32).toString("base64url");
export const pool = new pg.Pool({
  connectionString: process.env.DATABASE_URL,
  max: 10,
  connectionTimeoutMillis: 5000,
  idleTimeoutMillis: 30000,
});
export async function migrate(db = pool) {
  await db.query(
    await fs.readFile(new URL("../db/schema.sql", import.meta.url), "utf8"),
  );
}
export async function transaction(db, fn) {
  const c = await db.connect();
  try {
    await c.query("BEGIN");
    await c.query("SET LOCAL statement_timeout='8s'");
    const out = await fn(c);
    await c.query("COMMIT");
    return out;
  } catch (e) {
    await c.query("ROLLBACK");
    throw e;
  } finally {
    c.release();
  }
}
export async function lock(c, id) {
  await c.query("SELECT pg_advisory_xact_lock(hashtextextended($1,0))", [id]);
}
export async function seed(c, id) {
  const services = [
    [
      "Discovery consultation",
      30,
      3500,
      "A focused conversation to understand your needs and map the next step.",
    ],
    [
      "Specialist consultation",
      60,
      7500,
      "Dedicated time with a specialist for practical advice and a clear action plan.",
    ],
    [
      "Assessment & diagnostics",
      45,
      5500,
      "A structured review to identify the issue and recommend the right solution.",
    ],
    [
      "Follow-up appointment",
      30,
      3000,
      "Check progress, ask questions and adjust your plan with your specialist.",
    ],
    [
      "Hands-on service session",
      90,
      11000,
      "An extended appointment for focused, practical work with the team.",
    ],
    [
      "Training & onboarding",
      60,
      6500,
      "A guided session to help you get comfortable and build confidence.",
    ],
  ];
  const serviceIds = services.map(() => randomUUID());
  async function insert(table, rows) {
    const width = rows[0].length;
    await c.query(
      `INSERT INTO ${table} VALUES ${rows.map((row, i) => "(" + row.map((_, j) => "$" + (i * width + j + 1)).join(",") + ")").join(",")}`,
      rows.flat(),
    );
  }
  await insert(
    "services",
    services.map(([name, duration, price, description], i) => [
      serviceIds[i],
      id,
      name,
      duration,
      price,
      description,
      true,
    ]),
  );
  const people = [
    ["Alex Morgan", "Consultations & planning", [0, 1, 3, 5]],
    ["Jamie Park", "Assessment & practical services", [0, 2, 3, 4]],
    ["Taylor Reed", "Consultations & training", [0, 1, 2, 5]],
    ["Casey Ellis", "Service delivery & follow-up", [0, 2, 3, 4]],
  ];
  const staffRows = [],
    serviceRows = [],
    hourRows = [];
  for (const [name, bio, indices] of people) {
    const sid = randomUUID();
    staffRows.push([sid, id, name, bio, true]);
    for (const index of indices) serviceRows.push([sid, serviceIds[index]]);
    for (let weekday = 1; weekday <= 6; weekday++)
      for (const [start, end] of weekday === 6
        ? [[600, 840]]
        : [
            [540, 780],
            [840, 1020],
          ])
        hourRows.push([randomUUID(), sid, weekday, start, end]);
  }
  await insert("staff", staffRows);
  await insert("staff_services", serviceRows);
  await insert("working_hours", hourRows);
}
