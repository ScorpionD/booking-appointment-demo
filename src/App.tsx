import { useEffect, useRef, useState } from "react";
import type { FormEvent, ReactNode } from "react";
import { DateTime } from "luxon";
import {
  ArrowRight,
  ArrowUpRight,
  Check,
  CheckCircle2,
  ChevronLeft,
  ChevronRight,
  Clock3,
  CalendarDays,
  CalendarCheck2,
  ShieldCheck,
  Users,
  Plus,
  Settings2,
  Search,
  Loader2,
  X,
  Copy,
  RefreshCw,
  Bell,
  Mail,
  CheckCheck,
  LayoutDashboard,
  CalendarClock,
  Database,
  Workflow,
  Menu,
  AlertCircle,
  LockKeyhole,
  Layers,
  ArrowLeft,
  SlidersHorizontal,
  ExternalLink,
} from "lucide-react";
import { api, startSession } from "./services/api";
import type {
  Appointment,
  Block,
  Catalog,
  Notification,
  Service,
  Session,
  Slot,
  Staff,
} from "./types";
const ZONE = "Europe/London";
const now = () => DateTime.now().setZone(ZONE);
const dayLabel = (s: string, format = "ccc, dd LLL · HH:mm") =>
  DateTime.fromISO(s).setZone(ZONE).toFormat(format);
const money = (n: number) =>
  new Intl.NumberFormat("en-GB", {
    style: "currency",
    currency: "GBP",
    maximumFractionDigits: 0,
  }).format(n / 100);
const initials = (s: string) =>
  s
    .split(" ")
    .map((x) => x[0])
    .slice(0, 2)
    .join("");
const message = (e: unknown) =>
  e instanceof Error ? e.message : "Something went wrong. Please try again.";
function Badge({
  children,
  tone = "",
}: {
  children: ReactNode;
  tone?: string;
}) {
  return <span className={"badge " + tone}>{children}</span>;
}
function Status({ status }: { status: string }) {
  return (
    <Badge
      tone={
        ["confirmed", "delivered", "completed"].includes(status)
          ? "success"
          : ["cancelled", "no-show", "failed", "review"].includes(status)
            ? "muted"
            : "blue"
      }
    >
      <span className="dot" />
      {status.replaceAll("-", " ")}
    </Badge>
  );
}
function ErrorBox({ text }: { text: string }) {
  return text ? (
    <div className="error-box" role="alert">
      <AlertCircle size={18} />
      <span>{text}</span>
    </div>
  ) : null;
}
function Empty({ title, children }: { title: string; children: ReactNode }) {
  return (
    <div className="empty">
      <CalendarDays size={30} />
      <h3>{title}</h3>
      <p>{children}</p>
    </div>
  );
}
function Dialog({
  title,
  children,
  onClose,
}: {
  title: string;
  children: ReactNode;
  onClose: () => void;
}) {
  const ref = useRef<HTMLDialogElement>(null);
  useEffect(() => {
    ref.current?.showModal();
    const old = document.body.style.overflow;
    document.body.style.overflow = "hidden";
    return () => {
      document.body.style.overflow = old;
    };
  }, []);
  return (
    <dialog ref={ref} onCancel={onClose} className="dialog">
      <div className="dialog-head">
        <h2>{title}</h2>
        <button
          className="icon-button"
          onClick={onClose}
          aria-label="Close dialog"
        >
          <X />
        </button>
      </div>
      {children}
    </dialog>
  );
}
function Calendar({
  date,
  onChange,
}: {
  date: string;
  onChange: (date: string) => void;
}) {
  const [month, setMonth] = useState(
    DateTime.fromISO(date, { zone: ZONE }).startOf("month"),
  );
  const start = month.minus({ days: month.weekday - 1 });
  const today = now().startOf("day");
  return (
    <div className="date-picker">
      <div className="calendar-head">
        <strong>{month.toFormat("LLLL yyyy")}</strong>
        <div>
          <button
            className="icon-button"
            aria-label="Previous month"
            disabled={month <= today.startOf("month")}
            onClick={() => setMonth(month.minus({ months: 1 }))}
          >
            <ChevronLeft size={18} />
          </button>
          <button
            className="icon-button"
            aria-label="Next month"
            disabled={month >= today.plus({ days: 30 }).startOf("month")}
            onClick={() => setMonth(month.plus({ months: 1 }))}
          >
            <ChevronRight size={18} />
          </button>
        </div>
      </div>
      <div className="calendar-grid">
        {["M", "T", "W", "T", "F", "S", "S"].map((d, i) => (
          <span className="weekday" key={i}>
            {d}
          </span>
        ))}
        {Array.from({ length: 42 }, (_, i) => start.plus({ days: i })).map(
          (d) => (
            <button
              key={d.toISODate()}
              className={
                (d.toISODate() === date ? "chosen " : "") +
                (d.month !== month.month ? "other-month" : "")
              }
              disabled={
                d.startOf("day") < today ||
                d.startOf("day") > today.plus({ days: 30 })
              }
              aria-label={d.toFormat("cccc dd LLLL yyyy")}
              aria-pressed={d.toISODate() === date}
              onClick={() => onChange(d.toISODate()!)}
            >
              {d.day}
            </button>
          ),
        )}
      </div>
      <p className="micro">
        <Clock3 size={13} /> All times in London · {now().offsetNameShort}
      </p>
    </div>
  );
}
function Booking({
  catalog,
  onBooked,
  onManage,
}: {
  catalog: Catalog;
  onBooked: (a: Appointment) => void;
  onManage: () => void;
}) {
  const services = catalog.services.filter((s) => s.active);
  const [serviceId, setServiceId] = useState(services[0]?.id || "");
  const [staffId, setStaffId] = useState("");
  const [date, setDate] = useState(now().plus({ days: 1 }).toISODate()!);
  const [slots, setSlots] = useState<Slot[]>([]);
  const [selected, setSelected] = useState<Slot | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  const [refresh, setRefresh] = useState(0);
  const [formOpen, setFormOpen] = useState(false);
  const requestKey = useRef(crypto.randomUUID());
  const formRef = useRef<HTMLDivElement>(null);
  const service = services.find((s) => s.id === serviceId);
  const staff = catalog.staff.filter(
    (s) => s.active && s.services.includes(serviceId),
  );
  useEffect(() => {
    let current = true;
    setLoading(true);
    setSelected(null);
    setError("");
    api<{ slots: Slot[] }>(
      "/availability?" +
        new URLSearchParams({
          serviceId,
          date,
          ...(staffId ? { staffId } : {}),
        }),
    )
      .then((r) => {
        if (current) setSlots(r.slots);
      })
      .catch((e) => {
        if (current) {
          setError(message(e));
          setSlots([]);
        }
      })
      .finally(() => {
        if (current) setLoading(false);
      });
    return () => {
      current = false;
    };
  }, [serviceId, staffId, date, refresh]);
  const times = staffId
    ? slots
    : slots.filter(
        (s, i, a) => a.findIndex((x) => x.startsAt === s.startsAt) === i,
      );
  async function submit(e: FormEvent<HTMLFormElement>) {
    e.preventDefault();
    if (!selected || !service) return;
    const values = Object.fromEntries(new FormData(e.currentTarget));
    setBusy(true);
    setError("");
    try {
      const a = await api<Appointment>("/appointments", {
        method: "POST",
        body: {
          serviceId,
          staffId: selected.staffId,
          startsAt: selected.startsAt,
          name: values.name,
          email: values.email,
          phone: values.phone,
          note: values.note,
          idempotencyKey: requestKey.current,
          consent: values.consent === "on",
        },
      });
      onBooked(a);
    } catch (e) {
      setError(message(e));
    } finally {
      setBusy(false);
    }
  }
  return (
    <>
      <section className="hero">
        <div>
          <p className="eyebrow">
            <span className="tiny-line" /> TIME WELL SPENT
          </p>
          <h1>
            A simpler way
            <br />
            to <em>make time.</em>
          </h1>
          <p className="hero-copy">
            Find the right specialist. Choose a time that works.
            <br className="desktop-break" /> Leave the scheduling to us.
          </p>
          <div className="hero-meta">
            <span>
              <CheckCircle2 size={16} /> Live availability
            </span>
            <span>
              <ShieldCheck size={16} /> Secure booking
            </span>
            <span>
              <CalendarClock size={16} /> Easy changes
            </span>
          </div>
        </div>
        <div className="hero-note">
          <div className="note-icon">
            <CalendarCheck2 size={28} />
          </div>
          <p className="eyebrow">YOUR DAY, LESS COMPLICATED</p>
          <h2>
            One appointment.
            <br />
            Everything in place.
          </h2>
          <p>
            From your first click to the friendly reminder. A better experience
            for you and the team.
          </p>
          <div className="avatar-row">
            {catalog.staff.slice(0, 4).map((p, i) => (
              <span key={p.id} className={"avatar color-" + i}>
                {initials(p.name)}
              </span>
            ))}
            <span>
              {catalog.staff.filter((s) => s.active).length} demo specialists
              <br />
              <strong>Ready to help</strong>
            </span>
          </div>
        </div>
      </section>
      <div className="section-heading" id="booking">
        <div>
          <p className="eyebrow">LET’S FIND YOUR TIME</p>
          <h2>Book an appointment</h2>
        </div>
        <button className="text-button" onClick={onManage}>
          Already booked? Manage your visit <ArrowUpRight size={16} />
        </button>
      </div>
      <div className="booking-layout">
        <div className="booking-main">
          <section className="panel">
            <div className="step-heading">
              <span className="step">01</span>
              <div>
                <h3>Choose your service</h3>
                <p>A little guidance or a dedicated session — start here.</p>
              </div>
            </div>
            <div className="service-grid">
              {services.map((s, i) => (
                <button
                  className={
                    "service-card " + (s.id === serviceId ? "selected" : "")
                  }
                  key={s.id}
                  onClick={() => {
                    setServiceId(s.id);
                    setStaffId("");
                    setFormOpen(false);
                    requestKey.current = crypto.randomUUID();
                  }}
                  aria-pressed={s.id === serviceId}
                >
                  <span className="service-top">
                    <span className={"service-icon color-" + (i % 4)}>
                      {i === 0 ? (
                        <Users size={20} />
                      ) : i === 1 ? (
                        <Mail size={20} />
                      ) : i === 2 ? (
                        <Search size={20} />
                      ) : i === 3 ? (
                        <RefreshCw size={20} />
                      ) : i === 4 ? (
                        <Settings2 size={20} />
                      ) : (
                        <Layers size={20} />
                      )}
                    </span>
                    <span className="radio-dot">
                      {s.id === serviceId && <Check size={11} />}
                    </span>
                  </span>
                  <strong>{s.name}</strong>
                  <p>{s.description}</p>
                  <span className="service-bottom">
                    <span>
                      <Clock3 size={13} /> {s.duration} min
                    </span>
                    <b>
                      {money(s.price)} <small>demo</small>
                    </b>
                  </span>
                </button>
              ))}
            </div>
          </section>
          <section className="panel">
            <div className="step-heading">
              <span className="step">02</span>
              <div>
                <h3>Pick a specialist & time</h3>
                <p>Availability is checked against the live schedule.</p>
              </div>
            </div>
            <label className="field specialist-select">
              Your specialist
              <select
                value={staffId}
                onChange={(e) => setStaffId(e.target.value)}
              >
                <option value="">Any available specialist</option>
                {staff.map((s) => (
                  <option value={s.id} key={s.id}>
                    {s.name} · {s.bio}
                  </option>
                ))}
              </select>
            </label>
            <div className="availability-layout">
              <Calendar date={date} onChange={setDate} />
              <div className="time-picker">
                <div className="time-heading">
                  <strong>
                    {DateTime.fromISO(date).toFormat("cccc, dd LLL")}
                  </strong>
                  <button
                    className="icon-button"
                    aria-label="Refresh available slots"
                    onClick={() => setRefresh((r) => r + 1)}
                  >
                    <RefreshCw size={15} />
                  </button>
                </div>
                {loading ? (
                  <div className="loading-inline" role="status">
                    <Loader2 className="spin" /> Checking live availability…
                  </div>
                ) : error && !times.length ? (
                  <>
                    <ErrorBox text={error} />
                    <button
                      className="button secondary"
                      onClick={() => setRefresh((r) => r + 1)}
                    >
                      Try again
                    </button>
                  </>
                ) : times.length ? (
                  <>
                    <p className="micro">
                      {times.length} available start times · {service?.duration}{" "}
                      min
                    </p>
                    <div className="time-slots">
                      {times.map((s) => (
                        <button
                          key={s.startsAt + s.staffId}
                          className={
                            selected?.startsAt === s.startsAt &&
                            selected.staffId === s.staffId
                              ? "chosen"
                              : ""
                          }
                          aria-pressed={
                            selected?.startsAt === s.startsAt &&
                            selected.staffId === s.staffId
                          }
                          onClick={() => {
                            setSelected(s);
                            requestKey.current = crypto.randomUUID();
                          }}
                        >
                          {s.label}
                        </button>
                      ))}
                    </div>
                    <p className="micro">
                      <span className="dot" /> Updated from the server. Reserved
                      on confirmation.
                    </p>
                  </>
                ) : (
                  <Empty title="A little more space on another day">
                    No slots for this selection. Try a different day or
                    specialist.
                  </Empty>
                )}
              </div>
            </div>
          </section>
          {formOpen && selected && (
            <section className="panel" ref={formRef}>
              <div className="step-heading">
                <span className="step">03</span>
                <div>
                  <h3>Your details</h3>
                  <p>One last step to put it in the calendar.</p>
                </div>
              </div>
              <form onSubmit={submit} className="form-grid">
                <label className="field">
                  Full name
                  <input
                    name="name"
                    required
                    minLength={2}
                    maxLength={80}
                    autoComplete="name"
                    placeholder="Alex Sample"
                  />
                </label>
                <label className="field">
                  Email address
                  <input
                    name="email"
                    type="email"
                    required
                    maxLength={120}
                    autoComplete="email"
                    placeholder="alex@example.com"
                  />
                </label>
                <label className="field">
                  Phone number
                  <input
                    name="phone"
                    type="tel"
                    pattern="[+0-9 ()\-]{7,30}"
                    required
                    maxLength={30}
                    autoComplete="tel"
                    placeholder="+44 7700 900123"
                  />
                </label>
                <label className="field full">
                  Anything we should know? <small>Optional</small>
                  <textarea
                    name="note"
                    maxLength={600}
                    rows={3}
                    placeholder="A little context for your appointment…"
                  />
                </label>
                <label className="consent full">
                  <input type="checkbox" name="consent" required /> I’m using
                  fictional contact details. This demo stores my test booking
                  and sends its name and appointment details to the manager’s
                  Telegram.
                </label>
                <div className="full">
                  <ErrorBox text={error} />
                  <button className="button primary wide" disabled={busy}>
                    {busy ? (
                      <>
                        <Loader2 className="spin" size={18} /> Reserving your
                        appointment…
                      </>
                    ) : (
                      <>
                        Confirm appointment <ArrowRight size={18} />
                      </>
                    )}
                  </button>
                  <p className="micro center">
                    <LockKeyhole size={13} /> No payment required. This is a
                    portfolio demo.
                  </p>
                </div>
              </form>
            </section>
          )}
        </div>
        <aside className="booking-summary">
          <div className="summary-heading">
            <CalendarDays size={20} />
            <span>YOUR APPOINTMENT</span>
          </div>
          <div className="summary-body">
            <p className="micro">SERVICE</p>
            <h3>{service?.name || "Choose a service"}</h3>
            <p className="summary-description">{service?.description}</p>
            <div className="summary-line">
              <Clock3 size={16} />
              <span>{service?.duration} minutes</span>
              <strong>{service ? money(service.price) : "—"}</strong>
            </div>
            <div className="summary-divider" />
            <p className="micro">WHEN & WHO</p>
            <div className="summary-line">
              <CalendarDays size={16} />
              <span>
                {DateTime.fromISO(date).toFormat("ccc, dd LLL yyyy")}
                <br />
                <strong>
                  {selected
                    ? selected.label + " · London time"
                    : "Choose an available time"}
                </strong>
              </span>
            </div>
            <div className="summary-line">
              <Users size={16} />
              <span>
                {selected?.staffName ||
                  staff.find((s) => s.id === staffId)?.name ||
                  "Any available specialist"}
              </span>
            </div>
            <button
              className="button primary wide"
              disabled={!selected || loading}
              onClick={() => {
                setFormOpen(true);
                setTimeout(
                  () =>
                    formRef.current?.scrollIntoView({
                      behavior: "smooth",
                      block: "center",
                    }),
                  60,
                );
              }}
            >
              Continue to details <ArrowRight size={17} />
            </button>
            <p className="micro center">
              {selected
                ? "Your slot is reserved after confirmation."
                : "Select a time to continue."}
            </p>
          </div>
          <div className="summary-footer">
            <ShieldCheck size={20} />
            <div>
              <strong>Plans change. We understand.</strong>
              <p>Reschedule or cancel securely from your booking details.</p>
            </div>
          </div>
        </aside>
      </div>
      {busy && (
        <Dialog title="Putting your time in the calendar" onClose={() => {}}>
          <div className="processing" role="status">
            <Loader2 className="spin" size={38} />
            <h3>Checking & reserving your appointment</h3>
            <p>
              We’re verifying the slot and saving your booking securely. Please
              keep this window open.
            </p>
          </div>
        </Dialog>
      )}
    </>
  );
}
function BookingDetails({
  appointment,
  onChange,
  onClose,
  isAdmin = false,
}: {
  appointment: Appointment;
  onChange: (a: Appointment) => void;
  onClose: () => void;
  isAdmin?: boolean;
}) {
  const [a, setA] = useState(appointment);
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  const [edit, setEdit] = useState(false);
  const [cancel, setCancel] = useState(false);
  const [date, setDate] = useState(
    DateTime.fromISO(a.startsAt).setZone(ZONE).toISODate()!,
  );
  const [slots, setSlots] = useState<Slot[]>([]);
  const [slot, setSlot] = useState<Slot | null>(null);
  const [loading, setLoading] = useState(false);
  const [notice, setNotice] = useState("");
  const active = ["booked", "confirmed"].includes(a.status);
  const upcoming = new Date(a.startsAt) > new Date();
  async function load() {
    try {
      const x = await api<Appointment>("/appointments/" + a.id, {
        key: a.managementKey,
      });
      setA(x);
      onChange(x);
    } catch (e) {
      setError(message(e));
    }
  }
  useEffect(() => {
    if (!edit) return;
    let current = true;
    setLoading(true);
    setSlot(null);
    api<{ slots: Slot[] }>(
      "/availability?" +
        new URLSearchParams({ date, serviceId: a.serviceId, bookingId: a.id }),
      { key: a.managementKey },
    )
      .then((r) => {
        if (current) setSlots(r.slots);
      })
      .catch((e) => {
        if (current) setError(message(e));
      })
      .finally(() => {
        if (current) setLoading(false);
      });
    return () => {
      current = false;
    };
  }, [edit, date, a.serviceId, a.id, a.managementKey]);
  async function mutate(path: string, body: unknown, method = "POST") {
    setBusy(true);
    setError("");
    try {
      const x = await api<Appointment>(path, {
        method,
        body,
        key: a.managementKey,
      });
      setA(x);
      onChange(x);
      setEdit(false);
      setCancel(false);
      setNotice("Booking updated and saved.");
    } catch (e) {
      setError(message(e));
    } finally {
      setBusy(false);
    }
  }
  const link = location.origin + "/#manage=" + a.id + "&key=" + a.managementKey;
  return (
    <Dialog title={a.reference} onClose={onClose}>
      <div className="detail-heading">
        <div className="success-icon">
          <CalendarCheck2 />
        </div>
        <div>
          <Status status={a.status} />
          <h3>{a.serviceName}</h3>
          <p>{dayLabel(a.startsAt, "cccc, dd LLLL yyyy · HH:mm")} · London</p>
        </div>
      </div>
      <div className="detail-grid">
        <div>
          <small>SPECIALIST</small>
          <strong>{a.staffName}</strong>
        </div>
        <div>
          <small>DURATION & DEMO PRICE</small>
          <strong>
            {a.duration} minutes · {money(a.price)}
          </strong>
        </div>
        <div>
          <small>CUSTOMER</small>
          <strong>{a.name}</strong>
        </div>
        <div>
          <small>CONTACT</small>
          <span>
            {a.email}
            <br />
            {a.phone}
          </span>
        </div>
      </div>
      {a.note && <p className="note">{a.note}</p>}
      <div className="saved-banner">
        <CheckCircle2 size={17} /> Saved in PostgreSQL <span>·</span> Secure
        management
      </div>
      <ErrorBox text={error} />
      {notice && (
        <p className="notice" role="status">
          {notice}
        </p>
      )}
      {edit && (
        <section className="reschedule">
          <h3>Choose a new appointment</h3>
          <label className="field">
            Date
            <input
              type="date"
              value={date}
              min={now().toISODate()!}
              max={now().plus({ days: 30 }).toISODate()!}
              onChange={(e) => setDate(e.target.value)}
            />
          </label>
          {loading ? (
            <p role="status">Checking availability…</p>
          ) : slots.length ? (
            <div className="reschedule-slots">
              {slots.map((s) => (
                <button
                  key={s.startsAt + s.staffId}
                  className={"slot-detail " + (slot === s ? "selected" : "")}
                  onClick={() => setSlot(s)}
                >
                  <strong>{s.label}</strong>
                  <span>{s.staffName}</span>
                </button>
              ))}
            </div>
          ) : (
            <p>No available slots. Choose another date.</p>
          )}
          <button
            className="button primary wide"
            disabled={!slot || busy}
            onClick={() =>
              slot &&
              mutate(
                "/appointments/" + a.id + "/reschedule",
                {
                  startsAt: slot.startsAt,
                  staffId: slot.staffId,
                  version: a.version,
                },
                "PUT",
              )
            }
          >
            Confirm new time <ArrowRight size={16} />
          </button>
          <p className="micro">
            Your original slot stays reserved until the new one is saved.
          </p>
        </section>
      )}
      {cancel && (
        <div className="cancel-confirm">
          <h3>Cancel this appointment?</h3>
          <p>
            The time will become available again. This action closes the
            booking.
          </p>
          <div className="button-row">
            <button
              className="button danger"
              disabled={busy}
              onClick={() =>
                mutate("/appointments/" + a.id + "/cancel", {
                  version: a.version,
                })
              }
            >
              Yes, cancel booking
            </button>
            <button
              className="button secondary"
              onClick={() => setCancel(false)}
            >
              Keep appointment
            </button>
          </div>
        </div>
      )}
      <div className="button-row detail-actions">
        {active && upcoming && (
          <>
            <button
              className="button primary"
              disabled={busy}
              onClick={() => {
                setEdit(!edit);
                setCancel(false);
              }}
            >
              Reschedule <CalendarClock size={16} />
            </button>
            <button
              className="button secondary"
              disabled={busy}
              onClick={() => {
                setCancel(true);
                setEdit(false);
              }}
            >
              Cancel booking
            </button>
          </>
        )}
        <button
          className="icon-button"
          aria-label="Refresh booking details"
          onClick={() => void load()}
        >
          <RefreshCw size={17} />
        </button>
        {a.managementKey && (
          <button
            className="button secondary"
            onClick={() => {
              void navigator.clipboard
                .writeText(link)
                .then(() =>
                  setNotice("Secure management link copied. Keep it private."),
                )
                .catch(() =>
                  setNotice("Copy the private link from the field below."),
                );
            }}
          >
            <Copy size={15} /> Private link
          </button>
        )}
      </div>
      {a.managementKey && (
        <details className="private-link">
          <summary>Secure booking management link</summary>
          <input readOnly value={link} aria-label="Secure management link" />
          <p className="micro">
            Anyone with this link can view and manage this test booking. Expires
            with the 48-hour demo workspace.
          </p>
        </details>
      )}
      {isAdmin && (
        <div className="admin-detail">
          <h3>Admin actions</h3>
          <div className="button-row">
            {active && a.status !== "confirmed" && (
              <button
                className="button secondary"
                disabled={busy}
                onClick={() =>
                  mutate(
                    "/admin/appointments/" + a.id + "/status",
                    { status: "confirmed", version: a.version },
                    "PUT",
                  )
                }
              >
                Mark confirmed
              </button>
            )}
            {active &&
              !upcoming &&
              ["completed", "no-show"].map((status) => (
                <button
                  className="button secondary"
                  key={status}
                  disabled={busy}
                  onClick={() =>
                    mutate(
                      "/admin/appointments/" + a.id + "/status",
                      { status, version: a.version },
                      "PUT",
                    )
                  }
                >
                  Mark {status}
                </button>
              ))}
            {active && upcoming && (
              <button
                className="button secondary"
                disabled={busy}
                onClick={async () => {
                  setBusy(true);
                  try {
                    const r = await api<{ message: string }>(
                      "/admin/appointments/" + a.id + "/reminder",
                      { method: "POST", body: {} },
                    );
                    setNotice(r.message);
                    await load();
                  } catch (e) {
                    setError(message(e));
                  } finally {
                    setBusy(false);
                  }
                }}
              >
                <Bell size={15} /> Send test reminder
              </button>
            )}
          </div>
          <p className="micro">
            Completed and no-show become available after the appointment starts.
          </p>
        </div>
      )}
      <details className="history" open>
        <summary>Notifications & event history</summary>
        <div className="events">
          {a.notifications?.map((n) => (
            <div className="event" key={n.id}>
              <Bell size={15} />
              <span>
                {n.kind.replaceAll("-", " ")}
                <small>{dayLabel(n.created_at)}</small>
              </span>
              <Status status={n.state} />
            </div>
          ))}
          {a.events?.map((e, i) => (
            <div className="event" key={i}>
              <Check size={15} />
              <span>
                {e.kind}
                <small>
                  {e.actor} · {dayLabel(e.created_at)}
                </small>
              </span>
            </div>
          ))}
        </div>
        <p className="micro">
          Telegram receipt appears only after confirmed delivery. Refresh to
          check.
        </p>
      </details>
    </Dialog>
  );
}
function Management({ onOpen }: { onOpen: (id: string) => void }) {
  const [list, setList] = useState<Appointment[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");
  useEffect(() => {
    api<{ appointments: Appointment[] }>("/appointments")
      .then((r) => setList(r.appointments))
      .catch((e) => setError(message(e)))
      .finally(() => setLoading(false));
  }, []);
  return (
    <section className="page-section">
      <p className="eyebrow">YOUR TIME, UNDER CONTROL</p>
      <h1 className="page-title">Your appointments</h1>
      <p className="page-intro">
        View your bookings, make a change or check the latest update.
      </p>
      <ErrorBox text={error} />
      {loading ? (
        <p role="status">Loading appointments…</p>
      ) : list.length ? (
        <div className="management-list">
          {list.map((a) => (
            <button
              key={a.id}
              className="management-card"
              onClick={() => onOpen(a.id)}
            >
              <div className="date-tile">
                <span>{dayLabel(a.startsAt, "LLL")}</span>
                <strong>{dayLabel(a.startsAt, "dd")}</strong>
              </div>
              <div>
                <Status status={a.status} />
                <h3>{a.serviceName}</h3>
                <p>
                  {dayLabel(a.startsAt)} · {a.staffName}
                </p>
                <small>{a.reference}</small>
              </div>
              <ArrowUpRight />
            </button>
          ))}
        </div>
      ) : (
        <Empty title="Your next appointment starts here">
          Once you book, you can return here to manage it. A private management
          link also lets you reopen a booking on another device.
        </Empty>
      )}
      <p className="micro">
        Your anonymous demo workspace lasts 48 hours. Use fictional details
        only.
      </p>
    </section>
  );
}
type Editor =
  | { type: "service"; value?: Service }
  | { type: "staff"; value?: Staff }
  | { type: "hours"; value: Staff }
  | { type: "block" };
function Admin({
  catalog,
  refreshCatalog,
  onOpen,
  onCreate,
}: {
  catalog: Catalog;
  refreshCatalog: () => Promise<void>;
  onOpen: (id: string) => void;
  onCreate: () => void;
}) {
  const [tab, setTab] = useState("schedule");
  const [layout, setLayout] = useState("day");
  const [date, setDate] = useState(now().plus({ days: 1 }).toISODate()!);
  const [status, setStatus] = useState("");
  const [service, setService] = useState("");
  const [staff, setStaff] = useState("");
  const [list, setList] = useState<Appointment[]>([]);
  const [blocks, setBlocks] = useState<Block[]>([]);
  const [notifications, setNotifications] = useState<Notification[]>([]);
  const [error, setError] = useState("");
  const [loading, setLoading] = useState(false);
  const [editor, setEditor] = useState<Editor | null>(null);
  const [tick, setTick] = useState(0);
  const [busy, setBusy] = useState(false);
  const [notice, setNotice] = useState("");
  useEffect(() => {
    let current = true;
    setLoading(true);
    setError("");
    Promise.all([
      api<{ appointments: Appointment[] }>(
        "/admin/appointments?" +
          new URLSearchParams({
            ...(layout === "day" || date ? { date } : {}),
            ...(status ? { status } : {}),
            ...(service ? { serviceId: service } : {}),
            ...(staff ? { staffId: staff } : {}),
          }),
      ),
      api<{ blocks: Block[] }>("/admin/blocks"),
      api<{ notifications: Notification[] }>("/admin/automation"),
    ])
      .then(([a, b, n]) => {
        if (current) {
          setList(a.appointments);
          setBlocks(b.blocks);
          setNotifications(n.notifications);
        }
      })
      .catch((e) => {
        if (current) setError(message(e));
      })
      .finally(() => {
        if (current) setLoading(false);
      });
    return () => {
      current = false;
    };
  }, [date, status, service, staff, tick, layout]);
  const refresh = () => setTick((x) => x + 1);
  async function save(path: string, body: unknown, method = "PUT") {
    setBusy(true);
    setError("");
    try {
      await api(path, { method, body });
      await refreshCatalog();
      refresh();
      setEditor(null);
      setNotice("Changes saved in your demo workspace.");
    } catch (e) {
      setError(message(e));
    } finally {
      setBusy(false);
    }
  }
  const tabs = [
    ["schedule", "Schedule", CalendarDays],
    ["services", "Services", Layers],
    ["team", "Team & hours", Users],
    ["automation", "Automation", Workflow],
  ] as const;
  return (
    <section className="admin-workspace">
      <div className="admin-title">
        <div>
          <p className="eyebrow">DEMO ADMIN WORKSPACE</p>
          <h1 className="page-title">A little more organised.</h1>
          <p>Appointments, people and reminders. All in one place.</p>
        </div>
        <button className="button primary" onClick={onCreate}>
          <Plus size={18} /> New appointment
        </button>
      </div>
      <div className="admin-stats">
        <div>
          <CalendarCheck2 />
          <strong>
            {
              list.filter((a) => ["booked", "confirmed"].includes(a.status))
                .length
            }
          </strong>
          <span>Active in selection</span>
        </div>
        <div>
          <Users />
          <strong>{catalog.staff.filter((s) => s.active).length}</strong>
          <span>Active specialists</span>
        </div>
        <div>
          <Layers />
          <strong>{catalog.services.filter((s) => s.active).length}</strong>
          <span>Available services</span>
        </div>
        <div>
          <Bell />
          <strong>
            {notifications.filter((n) => n.state === "delivered").length}
          </strong>
          <span>Delivered notifications</span>
        </div>
      </div>
      <div className="admin-tabs">
        {tabs.map(([id, label, Icon]) => (
          <button
            className={tab === id ? "active" : ""}
            key={id}
            onClick={() => setTab(id)}
          >
            <Icon size={17} />
            {label}
          </button>
        ))}
        <button
          className="refresh-button"
          onClick={refresh}
          aria-label="Refresh admin workspace"
        >
          <RefreshCw size={16} />
        </button>
      </div>
      <ErrorBox text={error} />
      {notice && (
        <p className="notice" role="status">
          {notice}
        </p>
      )}
      {tab === "schedule" && (
        <>
          <div className="filter-bar">
            <label className="field">
              Date
              <input
                type="date"
                value={date}
                onChange={(e) => setDate(e.target.value || now().toISODate()!)}
              />
            </label>
            <label className="field">
              Status
              <select
                value={status}
                onChange={(e) => setStatus(e.target.value)}
              >
                <option value="">All statuses</option>
                {[
                  "booked",
                  "confirmed",
                  "completed",
                  "cancelled",
                  "no-show",
                ].map((s) => (
                  <option key={s}>{s}</option>
                ))}
              </select>
            </label>
            <label className="field">
              Service
              <select
                value={service}
                onChange={(e) => setService(e.target.value)}
              >
                <option value="">All services</option>
                {catalog.services.map((s) => (
                  <option key={s.id} value={s.id}>
                    {s.name}
                  </option>
                ))}
              </select>
            </label>
            <label className="field">
              Specialist
              <select value={staff} onChange={(e) => setStaff(e.target.value)}>
                <option value="">All specialists</option>
                {catalog.staff.map((s) => (
                  <option key={s.id} value={s.id}>
                    {s.name}
                  </option>
                ))}
              </select>
            </label>
            <div className="segmented">
              <button
                className={layout === "day" ? "active" : ""}
                onClick={() => setLayout("day")}
              >
                Day
              </button>
              <button
                className={layout === "list" ? "active" : ""}
                onClick={() => setLayout("list")}
              >
                List
              </button>
            </div>
          </div>
          <div className="schedule-heading">
            <h3>{DateTime.fromISO(date).toFormat("cccc, dd LLLL yyyy")}</h3>
            <span className="micro">
              London time · {list.length} appointments
            </span>
          </div>
          {loading ? (
            <div className="loading-inline" role="status">
              <Loader2 className="spin" /> Updating schedule…
            </div>
          ) : layout === "day" ? (
            <div className="day-board">
              {catalog.staff
                .filter((s) => !staff || s.id === staff)
                .map((s, i) => (
                  <div className="day-column" key={s.id}>
                    <div className="day-person">
                      <span className={"avatar color-" + (i % 4)}>
                        {initials(s.name)}
                      </span>
                      <div>
                        <strong>{s.name}</strong>
                        <small>
                          {catalog.hours
                            .filter(
                              (h) =>
                                h.staff_id === s.id &&
                                h.weekday === DateTime.fromISO(date).weekday,
                            )
                            .map(
                              (h) =>
                                `${String(Math.floor(h.start_minute / 60)).padStart(2, "0")}:${String(h.start_minute % 60).padStart(2, "0")}–${String(Math.floor(h.end_minute / 60)).padStart(2, "0")}:${String(h.end_minute % 60).padStart(2, "0")}`,
                            )
                            .join(" · ") || "Not working"}
                        </small>
                      </div>
                    </div>
                    <div className="day-content">
                      {list
                        .filter((a) => a.staffId === s.id)
                        .map((a) => (
                          <button
                            className={"calendar-appointment " + a.status}
                            key={a.id}
                            onClick={() => onOpen(a.id)}
                          >
                            <span>
                              {dayLabel(a.startsAt, "HH:mm")} —{" "}
                              {dayLabel(a.endsAt, "HH:mm")}
                            </span>
                            <strong>{a.serviceName}</strong>
                            <small>{a.name}</small>
                            <Status status={a.status} />
                          </button>
                        ))}
                      {blocks
                        .filter(
                          (b) =>
                            b.staff_id === s.id &&
                            dayLabel(b.starts_at, "yyyy-MM-dd") <= date &&
                            dayLabel(b.ends_at, "yyyy-MM-dd") >= date,
                        )
                        .map((b) => (
                          <div className="blocked-card" key={b.id}>
                            <LockKeyhole size={14} />
                            {b.reason}
                            <small>
                              {dayLabel(b.starts_at, "HH:mm")}–
                              {dayLabel(b.ends_at, "HH:mm")}
                            </small>
                          </div>
                        ))}
                      {!list.some((a) => a.staffId === s.id) && (
                        <p className="day-empty">
                          No appointments in this view
                        </p>
                      )}
                    </div>
                  </div>
                ))}
            </div>
          ) : list.length ? (
            <div className="table-wrap">
              <table>
                <thead>
                  <tr>
                    <th>Appointment</th>
                    <th>Customer</th>
                    <th>Time</th>
                    <th>Specialist</th>
                    <th>Status</th>
                    <th />
                  </tr>
                </thead>
                <tbody>
                  {list.map((a) => (
                    <tr key={a.id}>
                      <td>
                        <strong>{a.serviceName}</strong>
                        <small>{a.reference}</small>
                      </td>
                      <td>{a.name}</td>
                      <td>
                        {dayLabel(a.startsAt, "HH:mm")}
                        <small>{a.duration} min</small>
                      </td>
                      <td>{a.staffName}</td>
                      <td>
                        <Status status={a.status} />
                      </td>
                      <td>
                        <button
                          className="text-button"
                          onClick={() => onOpen(a.id)}
                        >
                          View <ArrowUpRight size={15} />
                        </button>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          ) : (
            <Empty title="A clear calendar">
              No appointments match these filters. Create a test booking or
              choose another day.
            </Empty>
          )}
        </>
      )}
      {tab === "services" && (
        <>
          <div className="section-heading compact">
            <div>
              <h2>Services, thoughtfully defined.</h2>
              <p>
                Changes apply to future bookings. Existing booking details are
                preserved.
              </p>
            </div>
            <button
              className="button primary"
              onClick={() => setEditor({ type: "service" })}
            >
              <Plus size={17} /> Add service
            </button>
          </div>
          <div className="admin-card-grid">
            {catalog.services.map((s) => (
              <article className="admin-card" key={s.id}>
                <Status status={s.active ? "active" : "inactive"} />
                <h3>{s.name}</h3>
                <p>{s.description}</p>
                <div className="card-bottom">
                  <span>
                    {s.duration} min · {money(s.price)}
                  </span>
                  <button
                    className="text-button"
                    onClick={() => setEditor({ type: "service", value: s })}
                  >
                    Edit <ArrowUpRight size={15} />
                  </button>
                </div>
              </article>
            ))}
          </div>
        </>
      )}
      {tab === "team" && (
        <>
          <div className="section-heading compact">
            <div>
              <h2>The people behind the schedule.</h2>
              <p>Set specialties, working hours and time away.</p>
            </div>
            <button
              className="button primary"
              onClick={() => setEditor({ type: "staff" })}
            >
              <Plus size={17} /> Add specialist
            </button>
          </div>
          <div className="admin-card-grid">
            {catalog.staff.map((s, i) => (
              <article className="admin-card" key={s.id}>
                <span className={"avatar color-" + (i % 4)}>
                  {initials(s.name)}
                </span>
                <h3>{s.name}</h3>
                <p>{s.bio}</p>
                <Status status={s.active ? "active" : "inactive"} />
                <p className="micro">{s.services.length} assigned services</p>
                <div className="button-row">
                  <button
                    className="button secondary"
                    onClick={() => setEditor({ type: "staff", value: s })}
                  >
                    Edit profile
                  </button>
                  <button
                    className="button secondary"
                    onClick={() => setEditor({ type: "hours", value: s })}
                  >
                    <Clock3 size={15} /> Hours
                  </button>
                </div>
              </article>
            ))}
          </div>
          <div className="section-heading compact">
            <h3>Unavailable periods</h3>
            <button
              className="button secondary"
              onClick={() => setEditor({ type: "block" })}
            >
              <Plus size={16} /> Block time
            </button>
          </div>
          {blocks.length ? (
            <div className="block-list">
              {blocks.map((b) => (
                <div key={b.id}>
                  <div>
                    <strong>{b.reason}</strong>
                    <p>
                      {catalog.staff.find((s) => s.id === b.staff_id)?.name} ·{" "}
                      {dayLabel(b.starts_at)} → {dayLabel(b.ends_at)}
                    </p>
                  </div>
                  <button
                    className="text-button"
                    disabled={busy}
                    onClick={() =>
                      void save("/admin/blocks/" + b.id, undefined, "DELETE")
                    }
                  >
                    Release time <X size={15} />
                  </button>
                </div>
              ))}
            </div>
          ) : (
            <p className="muted-copy">
              No blocked periods. Lunch breaks are defined in working hours.
            </p>
          )}
        </>
      )}
      {tab === "automation" && (
        <>
          <div className="section-heading compact">
            <div>
              <h2>Every booking keeps the team in the loop.</h2>
              <p>
                Real delivery receipts, with a durable queue if notifications
                are interrupted.
              </p>
            </div>
          </div>
          <div className="automation-flow">
            {[
              ["Appointment saved", Database],
              ["Validated by n8n", Workflow],
              ["Telegram delivered", Bell],
            ].map(([label, Icon], i) => {
              const I = Icon as typeof Database;
              return (
                <div key={i}>
                  <span className="flow-step">0{i + 1}</span>
                  <I size={24} />
                  <strong>{label as string}</strong>
                </div>
              );
            })}
          </div>
          <div className="reminder-banner">
            <CalendarClock size={30} />
            <div>
              <h3>A reminder you can actually test.</h3>
              <p>
                n8n checks the reminder queue every minute. Scheduled reminders
                are due 24 hours before a visit, or 5 minutes after booking for
                nearer visits. Open an upcoming appointment and choose “Send
                test reminder” to verify Telegram delivery now.
              </p>
              <small>
                One test reminder per schedule version. Cancelled or outdated
                reminders are skipped.
              </small>
            </div>
          </div>
          <div className="table-wrap">
            <table>
              <thead>
                <tr>
                  <th>Booking</th>
                  <th>Event</th>
                  <th>Status</th>
                  <th>Telegram receipt</th>
                  <th>Created</th>
                </tr>
              </thead>
              <tbody>
                {notifications.map((n) => (
                  <tr key={n.id}>
                    <td>{n.reference}</td>
                    <td>{n.kind}</td>
                    <td>
                      <Status status={n.state} />
                    </td>
                    <td>
                      {n.message_id ? "#" + n.message_id : "Awaiting delivery"}
                    </td>
                    <td>{dayLabel(n.created_at)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
            {!notifications.length && (
              <Empty title="Ready for your first event">
                Create an appointment to see the real notification workflow.
              </Empty>
            )}
          </div>
          <p className="micro">
            Ambiguous Telegram delivery is marked for review instead of
            automatically sending duplicates. Email, SMS and WhatsApp are future
            integrations.
          </p>
        </>
      )}
      {editor && (
        <AdminEditor
          editor={editor}
          catalog={catalog}
          error={error}
          busy={busy}
          onClose={() => {
            setEditor(null);
            setError("");
          }}
          save={save}
        />
      )}
    </section>
  );
}
function AdminEditor({
  editor: e,
  catalog,
  error,
  busy,
  onClose,
  save,
}: {
  editor: Editor;
  catalog: Catalog;
  error: string;
  busy: boolean;
  onClose: () => void;
  save: (path: string, body: unknown, method?: string) => Promise<void>;
}) {
  const [rules, setRules] = useState(
    e.type === "hours"
      ? catalog.hours
          .filter((h) => h.staff_id === e.value.id)
          .map((h) => ({
            weekday: h.weekday,
            start: h.start_minute,
            end: h.end_minute,
          }))
      : [],
  );
  const time = (n: number) =>
    `${String(Math.floor(n / 60)).padStart(2, "0")}:${String(n % 60).padStart(2, "0")}`;
  const minutes = (s: string) =>
    Number(s.split(":")[0]) * 60 + Number(s.split(":")[1]);
  async function submit(ev: FormEvent<HTMLFormElement>) {
    ev.preventDefault();
    const data = new FormData(ev.currentTarget),
      v = Object.fromEntries(data);
    if (e.type === "service")
      await save(
        "/admin/services" + (e.value ? "/" + e.value.id : ""),
        {
          name: v.name,
          duration: Number(v.duration),
          price: Math.round(Number(v.price) * 100),
          description: v.description,
          active: v.active === "on",
        },
        e.value ? "PUT" : "POST",
      );
    if (e.type === "staff")
      await save(
        "/admin/staff" + (e.value ? "/" + e.value.id : ""),
        {
          name: v.name,
          bio: v.bio,
          active: v.active === "on",
          serviceIds: data.getAll("services"),
        },
        e.value ? "PUT" : "POST",
      );
    if (e.type === "hours")
      await save("/admin/staff/" + e.value.id + "/hours", { rules });
    if (e.type === "block")
      await save(
        "/admin/blocks",
        {
          staffId: v.staffId,
          startsAt: DateTime.fromISO(String(v.start), { zone: ZONE })
            .toUTC()
            .toISO(),
          endsAt: DateTime.fromISO(String(v.end), { zone: ZONE })
            .toUTC()
            .toISO(),
          reason: v.reason,
        },
        "POST",
      );
  }
  return (
    <Dialog
      title={
        e.type === "service"
          ? e.value
            ? "Edit service"
            : "Add service"
          : e.type === "staff"
            ? e.value
              ? "Edit specialist"
              : "Add specialist"
            : e.type === "hours"
              ? e.value.name + " · working hours"
              : "Block unavailable time"
      }
      onClose={onClose}
    >
      <form className="form-grid" onSubmit={submit}>
        {e.type === "service" && (
          <>
            <label className="field full">
              Service name
              <input
                name="name"
                defaultValue={e.value?.name}
                required
                minLength={2}
                maxLength={80}
              />
            </label>
            <label className="field">
              Duration (minutes)
              <input
                name="duration"
                type="number"
                min={15}
                max={180}
                step={15}
                defaultValue={e.value?.duration || 30}
                required
              />
            </label>
            <label className="field">
              Demo price (£)
              <input
                name="price"
                type="number"
                min={0}
                max={1000}
                step="0.01"
                defaultValue={e.value ? e.value.price / 100 : 35}
                required
              />
            </label>
            <label className="field full">
              Description
              <textarea
                name="description"
                defaultValue={e.value?.description}
                required
                minLength={5}
                maxLength={300}
              />
            </label>
            <label className="consent full">
              <input
                name="active"
                type="checkbox"
                defaultChecked={e.value?.active ?? true}
              />
              Available for new bookings
            </label>
            <p className="micro full">
              Assign a specialist to a new service in Team & hours before it can
              be booked.
            </p>
          </>
        )}
        {e.type === "staff" && (
          <>
            <label className="field full">
              Specialist name
              <input
                name="name"
                defaultValue={e.value?.name}
                required
                minLength={2}
                maxLength={80}
              />
            </label>
            <label className="field full">
              Specialty / short description
              <input
                name="bio"
                defaultValue={e.value?.bio}
                required
                minLength={2}
                maxLength={200}
              />
            </label>
            <fieldset className="full">
              <legend>Services</legend>
              {catalog.services.map((s) => (
                <label className="consent" key={s.id}>
                  <input
                    name="services"
                    type="checkbox"
                    value={s.id}
                    defaultChecked={e.value?.services.includes(s.id)}
                  />
                  {s.name}
                </label>
              ))}
            </fieldset>
            <label className="consent full">
              <input
                name="active"
                type="checkbox"
                defaultChecked={e.value?.active ?? true}
              />
              Active specialist
            </label>
            <p className="micro full">
              New specialists need working hours before slots become available.
            </p>
          </>
        )}
        {e.type === "hours" && (
          <div className="full">
            <p>
              London local time. Add two periods on a day to leave a lunch break
              between them. Existing bookings cannot be stranded outside new
              working hours.
            </p>
            <div className="hours-labels">
              <span>Day</span>
              <span>From</span>
              <span>Until</span>
            </div>
            {rules.map((r, i) => (
              <div className="hour-row" key={i}>
                <select
                  aria-label={"Day for period " + (i + 1)}
                  value={r.weekday}
                  onChange={(ev) =>
                    setRules(
                      rules.map((v, j) =>
                        j === i
                          ? { ...v, weekday: Number(ev.target.value) }
                          : v,
                      ),
                    )
                  }
                >
                  {[
                    "Monday",
                    "Tuesday",
                    "Wednesday",
                    "Thursday",
                    "Friday",
                    "Saturday",
                    "Sunday",
                  ].map((d, k) => (
                    <option value={k + 1} key={d}>
                      {d}
                    </option>
                  ))}
                </select>
                <input
                  aria-label={"Start time for period " + (i + 1)}
                  type="time"
                  step={900}
                  value={time(r.start)}
                  onChange={(ev) =>
                    setRules(
                      rules.map((v, j) =>
                        j === i ? { ...v, start: minutes(ev.target.value) } : v,
                      ),
                    )
                  }
                />
                <input
                  aria-label={"End time for period " + (i + 1)}
                  type="time"
                  step={900}
                  value={time(r.end)}
                  onChange={(ev) =>
                    setRules(
                      rules.map((v, j) =>
                        j === i ? { ...v, end: minutes(ev.target.value) } : v,
                      ),
                    )
                  }
                />
                <button
                  type="button"
                  className="icon-button"
                  aria-label={"Remove period " + (i + 1)}
                  onClick={() => setRules(rules.filter((_, j) => i !== j))}
                >
                  <X size={15} />
                </button>
              </div>
            ))}
            <button
              type="button"
              className="button secondary"
              onClick={() =>
                setRules([...rules, { weekday: 1, start: 540, end: 780 }])
              }
            >
              <Plus size={15} /> Add period
            </button>
          </div>
        )}
        {e.type === "block" && (
          <>
            <label className="field full">
              Specialist
              <select name="staffId" required>
                {catalog.staff.map((s) => (
                  <option key={s.id} value={s.id}>
                    {s.name}
                  </option>
                ))}
              </select>
            </label>
            <label className="field">
              From · London time
              <input name="start" type="datetime-local" required />
            </label>
            <label className="field">
              Until · London time
              <input name="end" type="datetime-local" required />
            </label>
            <label className="field full">
              Reason
              <input
                name="reason"
                required
                minLength={2}
                maxLength={100}
                placeholder="Team meeting / time away"
              />
            </label>
          </>
        )}
        <div className="full">
          <ErrorBox text={error} />
          <button className="button primary wide" disabled={busy}>
            {busy ? "Saving…" : "Save changes"} <Check size={16} />
          </button>
        </div>
      </form>
    </Dialog>
  );
}
function BusinessBlocks() {
  return (
    <>
      <section className="value-section">
        <div>
          <p className="eyebrow">WHAT THIS DEMO SOLVES</p>
          <h2>
            Less scheduling.
            <br />
            <em>More doing.</em>
          </h2>
        </div>
        <p>
          Online booking with real-time availability, double-booking prevention
          and easy changes. A clear admin schedule keeps your team organised,
          while automatic notifications and reminders keep everyone informed.
        </p>
      </section>
      <section className="features-section">
        <div className="section-heading">
          <div>
            <p className="eyebrow">BUILT BEYOND THE INTERFACE</p>
            <h2>Production-ready features</h2>
          </div>
          <Badge>Working portfolio demo</Badge>
        </div>
        <div className="features-grid">
          {[
            [
              "Live scheduling",
              "Server-side availability, working hours, breaks and unavailable periods.",
              CalendarClock,
            ],
            [
              "Conflict protection",
              "Atomic booking and PostgreSQL constraints prevent overlapping appointments.",
              ShieldCheck,
            ],
            [
              "Flexible management",
              "Secure rescheduling and cancellation, admin controls and event history.",
              SlidersHorizontal,
            ],
            [
              "Reliable automation",
              "n8n workflows, real Telegram notifications and testable reminders.",
              Bell,
            ],
            [
              "Persistent by design",
              "Appointments, services and staff saved in a dedicated PostgreSQL database.",
              Database,
            ],
            [
              "Care at every step",
              "Validated requests, rate protection, safe errors and a responsive interface.",
              CheckCheck,
            ],
          ].map(([title, text, Icon], i) => {
            const I = Icon as typeof Clock3;
            return (
              <article key={i}>
                <span className="feature-icon">
                  <I size={21} />
                </span>
                <h3>{title as string}</h3>
                <p>{text as string}</p>
              </article>
            );
          })}
        </div>
      </section>
      <section className="custom-section">
        <div>
          <p className="eyebrow">BUILT FOR CUSTOMIZATION</p>
          <h2>
            Your business.
            <br />
            Your way of booking.
          </h2>
          <p>
            Adaptable for clinics, salons, automotive services, consultants,
            education and repair teams.
          </p>
        </div>
        <div>
          <div className="custom-tags">
            {[
              "Clinics",
              "Salons",
              "Consultants",
              "Education",
              "Automotive",
              "Service centres",
            ].map((s) => (
              <span key={s}>{s}</span>
            ))}
          </div>
          <h4>A foundation for your existing tools</h4>
          <p>
            Google Calendar, Microsoft Outlook, email, SMS, WhatsApp, CRM and
            Calendly-like workflows can be added during commercial
            customization. These integrations are not connected in this demo.
          </p>
        </div>
      </section>
    </>
  );
}
export default function App() {
  const [session, setSession] = useState<Session | null>(null);
  const [catalog, setCatalog] = useState<Catalog | null>(null);
  const [view, setView] = useState("book");
  const [error, setError] = useState("");
  const [menu, setMenu] = useState(false);
  const [adminGate, setAdminGate] = useState(false);
  const [adminBusy, setAdminBusy] = useState(false);
  const [opened, setOpened] = useState<Appointment | null>(null);
  const [confirmation, setConfirmation] = useState<Appointment | null>(null);
  const [revision, setRevision] = useState(0);
  async function refreshCatalog() {
    setCatalog(await api<Catalog>("/catalog"));
  }
  async function openBooking(id: string, key?: string) {
    setError("");
    try {
      setOpened(await api<Appointment>("/appointments/" + id, { key }));
    } catch (e) {
      setError(message(e));
    }
  }
  async function boot() {
    setError("");
    try {
      const s = await startSession();
      setSession(s);
      await refreshCatalog();
      const fragment = new URLSearchParams(location.hash.slice(1));
      if (fragment.has("manage") && fragment.has("key")) {
        setView("manage");
        await openBooking(fragment.get("manage")!, fragment.get("key")!);
        history.replaceState(null, "", location.pathname);
      }
    } catch (e) {
      setError(message(e));
    }
  }
  useEffect(() => {
    void boot();
  }, []); // anonymous session cookie is the sole workspace boundary
  function navigate(next: string) {
    setView(next);
    setConfirmation(null);
    setMenu(false);
    window.scrollTo({ top: 0, behavior: "smooth" });
  }
  function admin() {
    if (session?.admin) navigate("admin");
    else setAdminGate(true);
  }
  return (
    <>
      <div className="demo-banner">
        <span className="dot" /> A real booking system. Fictional services.{" "}
        <span className="banner-detail">
          Your private demo workspace lasts 48 hours.
        </span>
      </div>
      <header className="site-header">
        <a
          href="#"
          className="brand"
          onClick={(e) => {
            e.preventDefault();
            navigate("book");
          }}
        >
          <span className="brand-mark">
            N<span />
          </span>
          <span>
            NORTHLINE <small>BOOKING</small>
          </span>
        </a>
        <nav className={menu ? "open" : ""} aria-label="Main navigation">
          <button
            className={view === "book" ? "active" : ""}
            onClick={() => navigate("book")}
          >
            Book a visit
          </button>
          <button
            className={view === "manage" ? "active" : ""}
            onClick={() => navigate("manage")}
          >
            My appointments
          </button>
          <button
            className={"nav-admin " + (view === "admin" ? "active" : "")}
            onClick={admin}
          >
            <LayoutDashboard size={16} /> Demo admin <ArrowUpRight size={14} />
          </button>
        </nav>
        <button
          className="menu-button icon-button"
          aria-label="Toggle navigation"
          onClick={() => setMenu(!menu)}
        >
          <Menu />
        </button>
      </header>
      <main>
        <ErrorBox text={error} />
        {!catalog || !session ? (
          <div className="app-loading">
            <CalendarDays size={36} />
            <h2>Getting your booking space ready</h2>
            {error ? (
              <button className="button primary" onClick={() => void boot()}>
                Try again
              </button>
            ) : (
              <p role="status">
                <Loader2 className="spin" size={18} /> Loading services and live
                availability…
              </p>
            )}
          </div>
        ) : confirmation ? (
          <section className="confirmation-page">
            <div className="confirmation-icon">
              <Check size={34} />
            </div>
            <p className="eyebrow">YOU’RE IN THE CALENDAR</p>
            <h1>Time, well reserved.</h1>
            <p>Your appointment is saved. Here’s everything you need.</p>
            <div className="confirmation-card">
              <div className="confirmation-top">
                <span>{confirmation.reference}</span>
                <Status status={confirmation.status} />
              </div>
              <h2>{confirmation.serviceName}</h2>
              <div className="confirm-when">
                <CalendarDays />
                <div>
                  <strong>
                    {dayLabel(confirmation.startsAt, "cccc, dd LLLL yyyy")}
                  </strong>
                  <span>
                    {dayLabel(confirmation.startsAt, "HH:mm")} · London time ·{" "}
                    {confirmation.duration} minutes
                  </span>
                </div>
              </div>
              <div className="confirm-when">
                <Users />
                <div>
                  <strong>{confirmation.staffName}</strong>
                  <span>Your dedicated specialist</span>
                </div>
              </div>
              <div className="saved-banner">
                <CheckCircle2 size={17} /> Saved in PostgreSQL · time reserved
              </div>
              <div className="confirmation-delivery">
                <Bell size={16} />
                <span>
                  Manager notification queued through n8n. Open booking details
                  to check the delivery receipt.
                </span>
              </div>
              <button
                className="button primary wide"
                onClick={() => void openBooking(confirmation.id)}
              >
                Manage appointment <ArrowRight size={16} />
              </button>
              <p className="micro center">
                Save the private management link from your booking details.
              </p>
            </div>
            <button className="text-button" onClick={() => navigate("book")}>
              <ArrowLeft size={16} /> Book another appointment
            </button>
          </section>
        ) : view === "book" ? (
          <>
            <Booking
              key={revision}
              catalog={catalog}
              onBooked={(a) => {
                setConfirmation(a);
                window.scrollTo({ top: 0, behavior: "smooth" });
              }}
              onManage={() => navigate("manage")}
            />
            <BusinessBlocks />
          </>
        ) : view === "manage" ? (
          <Management key={revision} onOpen={(id) => void openBooking(id)} />
        ) : (
          <Admin
            key={revision}
            catalog={catalog}
            refreshCatalog={refreshCatalog}
            onOpen={(id) => void openBooking(id)}
            onCreate={() => navigate("book")}
          />
        )}
      </main>
      <footer>
        <div className="footer-top">
          <span className="footer-brand">NORTHLINE BOOKING</span>
          <p>Thoughtful scheduling. From the first click.</p>
          <div>
            <a
              href="https://github.com/ScorpionD/booking-appointment-demo"
              target="_blank"
              rel="noreferrer"
            >
              View source <ExternalLink size={14} />
            </a>
            <button className="text-button" onClick={admin}>
              Explore demo admin <ArrowUpRight size={14} />
            </button>
          </div>
        </div>
        <div className="footer-bottom">
          <span>
            Portfolio demo · Fictional services & prices · No payments
          </span>
          <span>React · Express · PostgreSQL · n8n · Cloudflare</span>
        </div>
      </footer>
      {opened && (
        <BookingDetails
          key={opened.id}
          appointment={opened}
          onClose={() => {
            setOpened(null);
            setRevision((n) => n + 1);
          }}
          onChange={(a) => setOpened(a)}
          isAdmin={session?.admin && view === "admin"}
        />
      )}
      {adminGate && (
        <Dialog
          title="Explore the demo admin workspace"
          onClose={() => setAdminGate(false)}
        >
          <div className="admin-gate">
            <LayoutDashboard size={35} />
            <h3>Your own space to try everything.</h3>
            <p>
              Manage appointments, services, specialists and working hours in
              your isolated demo workspace. This role selection grants access
              only to your own test data.
            </p>
            <p className="note">
              Use fictional information. Telegram test notifications go to the
              portfolio demo manager. This is not a production account login.
            </p>
            <ErrorBox text={error} />
            <button
              className="button primary wide"
              disabled={adminBusy}
              onClick={async () => {
                setAdminBusy(true);
                try {
                  await api("/admin/login", {
                    method: "POST",
                    body: { acknowledge: true },
                  });
                  setSession((s) => (s ? { ...s, admin: true } : s));
                  setAdminGate(false);
                  navigate("admin");
                } catch (e) {
                  setError(message(e));
                } finally {
                  setAdminBusy(false);
                }
              }}
            >
              {adminBusy ? "Opening workspace…" : "Enter demo admin"}{" "}
              <ArrowRight size={17} />
            </button>
          </div>
        </Dialog>
      )}
    </>
  );
}
