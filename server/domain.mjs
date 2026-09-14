import { DateTime } from "luxon";
export const ZONE = "Europe/London";
export const ACTIVE = ["booked", "confirmed"];
export class AppError extends Error {
  constructor(status, code, message) {
    super(message);
    this.status = status;
    this.code = code;
  }
}
export function assert(ok, status, code, message) {
  if (!ok) throw new AppError(status, code, message);
}
export const today = () => DateTime.now().setZone(ZONE).toISODate();
export function validDate(date) {
  const d = DateTime.fromISO(date, { zone: ZONE });
  return (
    /^\d{4}-\d{2}-\d{2}$/.test(date) && d.isValid && d.toISODate() === date
  );
}
export function overlap(a, b, c, d) {
  return new Date(a) < new Date(d) && new Date(c) < new Date(b);
}
// Wall-clock working hours are converted in the business timezone; persisted instants are UTC.
export function calculateSlots({
  date,
  duration,
  staff,
  hours,
  busy,
  now = Date.now(),
}) {
  const day = DateTime.fromISO(date, { zone: ZONE });
  if (!day.isValid) return [];
  const out = [];
  for (const person of staff) {
    for (const rule of hours.filter(
      (h) => h.staff_id === person.id && h.weekday === day.weekday,
    )) {
      for (
        let minute = rule.start_minute;
        minute + duration <= rule.end_minute;
        minute += 15
      ) {
        const local = day
          .startOf("day")
          .set({ hour: Math.floor(minute / 60), minute: minute % 60 });
        if (local.hour * 60 + local.minute !== minute) continue;
        const end = local.plus({ minutes: duration });
        if (
          local.toMillis() < now + 30 * 60000 ||
          end.hour * 60 + end.minute > rule.end_minute
        )
          continue;
        if (
          busy.some(
            (b) =>
              b.staff_id === person.id &&
              overlap(local.toISO(), end.toISO(), b.starts_at, b.ends_at),
          )
        )
          continue;
        out.push({
          startsAt: local.toUTC().toISO(),
          endsAt: end.toUTC().toISO(),
          label: local.toFormat("HH:mm"),
          staffId: person.id,
          staffName: person.name,
        });
      }
    }
  }
  return out.sort(
    (a, b) =>
      a.startsAt.localeCompare(b.startsAt) ||
      a.staffName.localeCompare(b.staffName),
  );
}
export function transition(from, to, startsAt, now = Date.now()) {
  assert(
    ACTIVE.includes(from),
    409,
    "STATUS_CONFLICT",
    "This appointment is already closed.",
  );
  assert(
    ["confirmed", "completed", "no-show", "cancelled"].includes(to),
    422,
    "INVALID_STATUS",
    "Choose a valid status.",
  );
  if (["completed", "no-show"].includes(to))
    assert(
      new Date(startsAt).getTime() <= now,
      422,
      "TOO_EARLY",
      "Complete or mark no-show only after the appointment starts.",
    );
}
