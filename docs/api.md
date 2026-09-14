# Booking API

All public requests use the same origin. GET `/api/session` establishes an HttpOnly cookie and returns a CSRF token. Mutations require that cookie, `Origin` and `X-CSRF-Token`. No API key is sent to the browser.

| Method     | Route                                                           | Purpose                                                           |
| ---------- | --------------------------------------------------------------- | ----------------------------------------------------------------- |
| GET        | `/api/health`                                                   | Database health                                                   |
| GET        | `/api/session`                                                  | Start or restore a workspace                                      |
| GET        | `/api/catalog`                                                  | Services, specialists and hours                                   |
| GET        | `/api/availability?date=YYYY-MM-DD&serviceId=UUID&staffId=UUID` | Available starts; staffId is optional                             |
| POST       | `/api/appointments`                                             | Atomic, idempotent booking                                        |
| GET        | `/api/appointments`                                             | Workspace appointment history                                     |
| GET        | `/api/appointments/:id`                                         | Details, events, notification receipts and private management key |
| PUT        | `/api/appointments/:id/reschedule`                              | Reserve a new slot and release the old one in one transaction     |
| POST       | `/api/appointments/:id/cancel`                                  | Cancel and release availability                                   |
| POST       | `/api/admin/login`                                              | Select the safe, workspace-scoped demo admin role                 |
| POST       | `/api/admin/logout`                                             | Remove the scoped admin role                                      |
| GET        | `/api/admin/appointments`                                       | Filter by date, status, serviceId, staffId                        |
| PUT        | `/api/admin/appointments/:id/status`                            | Validated status transition                                       |
| POST       | `/api/admin/appointments/:id/reminder`                          | Queue one test reminder per schedule version                      |
| POST / PUT | `/api/admin/services[/:id]`                                     | Create/update service configuration                               |
| POST / PUT | `/api/admin/staff[/:id]`                                        | Create/update specialist and specialties                          |
| PUT        | `/api/admin/staff/:id/hours`                                    | Replace working periods; reject schedule conflicts                |
| GET / POST | `/api/admin/blocks`                                             | Read/create unavailable periods                                   |
| DELETE     | `/api/admin/blocks/:id`                                         | Release unavailable time                                          |
| GET        | `/api/admin/automation`                                         | Notification log with confirmed receipts                          |

Creating a booking:

```json
{
  "serviceId": "<catalog service UUID>",
  "staffId": "<available slot specialist UUID>",
  "startsAt": "<available slot UTC ISO timestamp>",
  "name": "Morgan Test",
  "email": "morgan@example.com",
  "phone": "+44 7700 900123",
  "note": "Fictional portfolio test",
  "idempotencyKey": "<new UUID for this booking intent>",
  "consent": true
}
```

The price, duration, end time, status and specialist name are calculated server-side. Retry the same payload with the same key after an uncertain connection. A changed payload with that key returns `409 IDEMPOTENCY_CONFLICT`. A taken slot returns `409 SLOT_TAKEN`; it never silently selects a different time.

Reschedule sends `{ "startsAt": "...", "staffId": "...", "version": 1 }`. Cancellation sends `{ "version": 1 }`. Status updates send `{ "status": "confirmed", "version": 1 }`. Stale versions return `409`; refresh details first.

For cross-device management, `X-Booking-Token` carries the private management key. Availability can include `bookingId` to check the original booking workspace and exclude its current reservation. A reference alone never exposes customer data. The key is placed in the management URL fragment, not its query string, so the initial request does not send it to access logs.

Internal endpoints `/api/automation/due`, `/claim` and `/complete` require the private `X-Automation-Secret` and are blocked by the public gateway. Claim returns delivery data only once. Complete requires its claim token and a Telegram receipt for a successful delivery. Neither secret nor claim token is exposed in frontend responses or logs.

Errors use `{ "error": { "code": "...", "message": "...", "requestId": "..." } }`. Validation returns 422; access 401/403/404; conflict 409; request size 413; limits 429; unavailable service 503. Logs contain request ID, method, path, status and duration, without contact fields or credentials.
