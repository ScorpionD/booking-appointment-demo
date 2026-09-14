# Production verification — 14 September 2026

Verified against **https://booking-appointment-demo.pages.dev/** with fictional contact information. This is a deployed application with real PostgreSQL persistence and real n8n/Telegram delivery.

## Automated checks

**58 tests passed:** 36 PostgreSQL API integration tests, 12 scheduling/domain tests, four frontend tests and six gateway/workflow tests.

- `npm run lint`: passed.
- `npm test`: passed, using an isolated `booking_test` PostgreSQL database.
- `npm run build`: passed.
- [GitHub Actions verification](https://github.com/ScorpionD/booking-appointment-demo/actions/runs/34817617809): successful lint, all tests and production build on code release `aac1a26`.
- GitHub → Cloudflare Pages automatic deployment: successful. Production branch `main`, build `npm run build`, output `dist`.

The suite includes concurrent reservations, direct database exclusion enforcement, idempotency, stale revisions, failed-reschedule rollback, cancelled-slot release, workspace isolation, management links, admin restrictions, service/staff/hours/blocked-period validation, notification claims, receipt deduplication, the delivery allowance and scheduled reminders. A private management link cannot expand admin access into another workspace.

## Public end-to-end evidence

| Scenario                 | Observed result                                                                                 |
| ------------------------ | ----------------------------------------------------------------------------------------------- |
| Desktop browser booking  | `NB-98AF8CA8` saved; discovery consultation with Alex Morgan                                    |
| Browser reschedule       | Moved from 10:00 to 11:00 London, 15 September                                                  |
| Refresh persistence      | “My appointments” restored the same reference and updated time after a full page reload         |
| Demo admin               | Day/list views loaded persisted bookings; status changed to confirmed                           |
| Mobile booking           | `NB-B2A40AF2` created from a 320 px booking form                                                |
| Mobile cancellation      | Cancelled successfully through the 390 px management dialog                                     |
| Public concurrent race   | Two requests for one staff/time returned **201 and 409**, exactly one saved appointment         |
| Public duplicate retry   | Replaying the successful request key returned the original appointment                          |
| Public reschedule/cancel | Previous slot became available, replacement became reserved, cancellation released replacement  |
| Test reminder            | Real Telegram receipt; requesting the same test reminder twice queued it only once              |
| Real scheduled reminder  | n8n's minute trigger delivered the due reminder without browser activity or a test-button click |

The repeatable public API run is in [production-smoke.json](../artifacts/production-smoke.json). Independent database evidence is in [database-receipts.json](../artifacts/database-receipts.json).

## Telegram receipts

These are Telegram message references returned by successful sends, not synthetic statuses. The manager destination and credentials are private.

| Reference     | Event                         | Receipt     |
| ------------- | ----------------------------- | ----------- |
| `NB-98AF8CA8` | Browser booking               | `39`        |
| `NB-98AF8CA8` | Browser reschedule            | `40`        |
| `NB-98AF8CA8` | Admin test reminder           | `46`        |
| `NB-3C78C042` | Concurrent race winner        | `41`        |
| `NB-3C78C042` | Reschedule                    | `42`        |
| `NB-3C78C042` | Deduplicated test reminder    | `43`        |
| `NB-3C78C042` | Cancellation                  | `44`        |
| `NB-B2A40AF2` | Mobile booking / cancellation | `47` / `48` |
| `NB-5DF01396` | Scheduled reminder            | `49`        |

The scheduled test appointment was created at approximately 07:19:50 UTC, with a reminder due at **07:24:50 UTC**. The independent n8n minute scheduler delivered it at **07:25:30 UTC**. No database timestamp manipulation or manual scheduler invocation was used. Timing reflects a minute-based scheduler and is not a delivery-time guarantee.

## Responsive and visual verification

Chrome was checked at **320 × 780, 390 × 844, 768 × 1024 and 1440 × 1000**.

- Public hero, service selection, date picker, real time slots, booking form and summary.
- Loading dialog and saved confirmation on 320 px.
- Management and cancellation dialogs on 390 px.
- Tablet booking/calendar and admin schedule.
- Admin list, automation and working-hours editor on 320 px.
- Desktop confirmation, secure management, schedule and delivery receipts.
- No page-level horizontal overflow at the four required widths. Admin tables retain contained horizontal scrolling on narrow screens.
- Fixed a decorative card layer that overlapped text on small screens, then rechecked the deployed fix.

[Responsive screenshots](../artifacts/qa/) accompany the [eight portfolio screenshots and original cover](../artifacts/README.md). No unresolved application regression was observed in these checks; this is bounded MVP verification, not a claim of exhaustive production certification.

## Scope and operational limits

The database and API are private, in dedicated Docker services and networks. The public frontend reaches a protected Cloudflare gateway. n8n has a separate workflow and credential store. Existing portfolio projects were not modified.

Anonymous workspaces expire after 48 hours, so the sample records above will not remain in the public demo indefinitely. Saved screenshots and verification evidence retain the demonstration. Demo admin is an intentionally scoped role, not a commercial identity system. Google Calendar, Outlook, email, SMS, WhatsApp, payments and CRM are not connected. AI was intentionally omitted. No paid service was enabled.
