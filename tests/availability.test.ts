import { describe, it, expect } from "vitest";
import {
  calculateSlots,
  overlap,
  transition,
  validDate,
} from "../server/domain.mjs";
const staff = [{ id: "alex", name: "Alex" }],
  hours = [
    { staff_id: "alex", weekday: 1, start_minute: 540, end_minute: 720 },
    { staff_id: "alex", weekday: 1, start_minute: 780, end_minute: 1020 },
  ];
const slots = (extra = {}) =>
  calculateSlots({
    date: "2026-10-12",
    duration: 60,
    staff,
    hours,
    busy: [],
    now: 0,
    ...extra,
  });
describe("Real availability calculations", () => {
  it("honours service duration and last start time", () => {
    expect(slots().at(-1)?.label).toBe("16:00");
    expect(slots()[0].label).toBe("09:00");
  });
  it("does not offer lunch breaks or appointments crossing a break", () => {
    expect(
      slots().some((s) => s.label === "11:15" || s.label === "12:00"),
    ).toBe(false);
  });
  it("keeps adjacent appointments bookable", () => {
    const result = slots({
      busy: [
        {
          staff_id: "alex",
          starts_at: "2026-10-12T08:00:00Z",
          ends_at: "2026-10-12T09:00:00Z",
        },
      ],
    });
    expect(result[0].label).toBe("10:00");
  });
  it("removes intervals blocked by existing bookings or time away", () => {
    const result = slots({
      busy: [
        {
          staff_id: "alex",
          starts_at: "2026-10-12T12:30:00Z",
          ends_at: "2026-10-12T14:30:00Z",
        },
      ],
    });
    expect(result.some((s) => s.label === "13:00" || s.label === "15:00")).toBe(
      false,
    );
    expect(result.some((s) => s.label === "15:30")).toBe(true);
  });
  it("does not mix availability between specialists", () => {
    expect(
      slots({
        busy: [
          {
            staff_id: "jamie",
            starts_at: "2026-10-12T08:00:00Z",
            ends_at: "2026-10-12T16:00:00Z",
          },
        ],
      }).length,
    ).toBe(slots().length);
  });
  it("enforces a 30-minute notice period", () => {
    expect(
      slots({ now: new Date("2026-10-12T08:20:00Z").getTime() })[0].label,
    ).toBe("10:00");
  });
  it("uses London daylight-saving offset in summer", () =>
    expect(slots()[0].startsAt).toBe("2026-10-12T08:00:00.000Z"));
  it("uses London winter offset after DST changes", () =>
    expect(slots({ date: "2026-11-02" })[0].startsAt).toBe(
      "2026-11-02T09:00:00.000Z",
    ));
  it("rejects invalid calendar dates", () => {
    expect(validDate("2026-02-30")).toBe(false);
    expect(validDate("2026-02-28")).toBe(true);
  });
  it("uses half-open intervals", () => {
    expect(
      overlap(
        "2026-01-01T10:00Z",
        "2026-01-01T11:00Z",
        "2026-01-01T11:00Z",
        "2026-01-01T12:00Z",
      ),
    ).toBe(false);
  });
  it("rejects reopening cancelled bookings", () =>
    expect(() => transition("cancelled", "confirmed", "2026-01-01")).toThrow());
  it("rejects completing an appointment before it starts", () =>
    expect(() => transition("booked", "completed", "2099-01-01")).toThrow());
});
