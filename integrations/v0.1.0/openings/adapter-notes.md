# OSBP v0.1.0 Openings Adapter Notes

Audience: integrators implementing or validating the Openings adapter.

Implementation notes specific to the Openings adapter for the v0.1.0 proof of concept. These are adapter detail, deliberately kept out of the [protocol spec](../../../docs/spec/v0.1.0/README.md), which defines the platform-agnostic contract.

## Openings API Baseline

Public docs:

- docs home: `https://docs.openings.link`
- OpenAPI schema: published through the Openings docs
- base URL: supplied by the operator for the provisioned Openings environment

The documented quickstart flow is:

```text
GET  /v1/salons/by-slug?slug=...
GET  /v1/services?salonId=...
GET  /v1/openings?scheduleId=...&date=...&serviceDuration=...
POST /v1/appointments/create
```

If appointment creation returns verification required, call:

```text
POST /v1/verifications/send
POST /v1/appointments/create   with the same booking payload plus raw verificationCode
```

For Openings booking verification, do not call `POST /v1/verifications/verify` before booking: `/verify` consumes the verification session. `appointments/create` verifies and consumes the code itself when `verificationCode` is supplied.

The v0.1.0 adapter returns `invalid_verification_purpose` for `verification.verify` in the booking namespace because the Openings verify endpoint consumes the booking verification session.

## Tool Source Mapping

| OSBP tool | Openings source |
|---|---|
| `service.describe` | `GET /v1/salons/{id}` or `/by-slug` or `/by-domain`; `GET /v1/services/{serviceId}`; `GET /v1/locations/{locationId}/detail` when schedule, provider, or assigned-service context is needed |
| `availability.find` | `GET /v1/openings?scheduleId=...&date=...&serviceDuration=...`; optionally `GET /v1/openings/members`; optionally `GET /v1/openings/next-availability` |
| `policy.explain` | salon cancellation fields, currency, verification method, and service payment or consultation fields |
| `verification.send` | `POST /v1/verifications/send` |
| `verification.verify` | `POST /v1/verifications/verify`, but not for the v0.1.0 booking flow |
| `booking.create` | `POST /v1/appointments/create` |
| `booking.status` | `GET /v1/appointments/{id}/review` by appointment id (documented in the Openings OpenAPI) when an id is available; otherwise `GET /v1/appointments/history/{phoneNumber}?salonId=...` or `GET /v1/appointments/history/by-email?email=...&salonId=...` (verification-gated). OSBP answers from its local idempotency record first. |

### `booking.status` cache-first limitation

For bookings created through the v0.1.0 Openings adapter, OSBP returns the local idempotency record before reading Openings `/review`. That confirms the receipt snapshot, but an out-of-band cancellation or change may not be reflected until broader by-id readback polish lands.

Openings `POST /v1/appointments/create` requires:

- `salonId`
- `userId`
- `scheduleId`
- `customerId`
- `date`
- `time`
- `services`

Openings request mapping:

```json
{
  "salonId": "salon_01jx2h9r8k6m4n3p2q1s0t9v8w",
  "userId": "provider_123",
  "scheduleId": "schedule_123",
  "customerId": "customer_123",
  "date": "2026-06-19",
  "time": "13:00",
  "services": [
    {
      "id": "service_123"
    }
  ],
  "verificationCode": "123456",
  "sendNotifications": true,
  "metadata": {
    "osbp_idempotency_key": "idem_2026_06_19_001",
    "osbp_mandate_id": "mnd_2026_06_19_001",
    "osbp_source": "openings-adapter/0.1.0"
  }
}
```

`services[].id` is the salon-level service id. OSBP collapses any per-provider service copy onto the salon-level `referenceId` and sends that on create, so `Slot.service_id` round-trips through mandate validation. Openings' create payload also accepts an optional per-item `optionId` for variants (confirmed in the published OpenAPI), which the v0.1.0 adapter does not send. The adapter omits Openings `requestId` from the wire payload. `requestId` is the FK to a `ServiceRequest` record in the consultation/quote workflow, not an idempotency key. OSBP idempotency stays in the local adapter cache.

Adapter calls should carry:

- local idempotency state keyed by the OSBP `idempotency_key`
- an allowlisted, PII-free `metadata` map written to the Openings appointment-create payload (`osbp_idempotency_key`, `osbp_mandate_id`, `osbp_source` with value `openings-adapter/<version>`), never customer data, surfaced only on the authenticated owner/member read path
- a local audit event (`JsonlAuditLog`) recording the redacted tool call with its `mandate_id` and `source: "osbp-local-mcp"`
- Openings now also accepts a native `Idempotency-Key` request header (shipped 2026-06-15), but OSBP v0.1.0 keeps its local cache and does not send it yet

## Confirmed Openings Inputs

- Appointment create sends the salon-level `services[].id`. OSBP collapses per-provider service copies onto the salon-level `referenceId`. The payload also accepts an optional per-item `optionId` for variants, which the v0.1.0 adapter does not send.
- `requestId` is the foreign key to a `ServiceRequest` record in the consultation/quote workflow, **not** an idempotency key. The adapter must omit `requestId` from the wire payload for normal bookings. OSBP idempotency stays in the local adapter cache.
- An operator-provisioned Openings business must be configured with one schedule, one provider, one service (`paymentRequirement: "NONE"`, no deposit), and a reusable customer id. Live ids belong in ignored local config or a gated CI secret, not in portable packages.
- `paymentRequirement` is per-service (`NONE` | `DEPOSIT` | `FULL`); `DEPOSIT` and `FULL` map to a payment-required handoff per service.
- Verification is risk-based. Try create first; on HTTP 428, send a code and retry create with `verificationCode`. If create returns HTTP 410 after a code is supplied, Openings is reporting an expired or canceled verification session; OSBP surfaces that as `verification_failed` so the agent can request a fresh code. The v0.1.0 booking flow must not call `/v1/verifications/verify` first; `appointments/create` is the operation that verifies and consumes the booking code.
- `BookingCreateInput.time` accepts merchant-local `HH:MM` and whole-second `HH:MM:00`. The adapter normalizes `HH:MM:00` to `HH:MM` for Openings. Non-zero seconds return adapter-specific `invalid_booking_time` before any upstream call, because silently rounding would change the requested appointment time.
- Appointment-create error mapping keys on Openings' structured `error.code` before HTTP status. This is deliberate adapter guidance: statuses can group unrelated user actions (`429 RATE_LIMITED` is retryable, while `429 BOOKING_BLOCKED`/`CUSTOMER_BLOCKED` is not), and future native idempotency `409`s must not be misreported as `slot_taken`.
- Do not set Openings' private booking flags.
- `sendNotifications` is omitted unless `OPENINGS_SEND_NOTIFICATIONS` is configured; set it only when the provisioned Openings environment requires an explicit value.
- The operator-provisioned Openings business must be explicitly cleared for controlled v0.1.0 bookings.
- v0.1.0 auth is public/unauthenticated.
- A public by-id readback is available: `GET /v1/appointments/{id}/review` (no auth, no verification step; id-as-capability), with a salon-authenticated `GET /v1/appointments/{id}` also available. `booking.status` reads `/review` by id when an id is supplied and falls back to `GET /v1/appointments/history/{phone}` (verification-gated) only when no id is available. The `/review` 200 mapping (`mapReviewBooking`) maps a shape now documented in the Openings OpenAPI, and the public `/review` omits the opaque `metadata` field so the mapping does not read it. On create, OSBP does write an allowlisted, PII-free `metadata` map to the Openings appointment (`osbp_idempotency_key`, `osbp_mandate_id`, `osbp_source`), never customer data, surfaced only on the authenticated owner/member read path.

Live input handling:

- The configured reusable customer phone number receives real SMS, so treat it as live SMS-capable customer data.
- Keep live business ids and phone numbers in `integrations/v0.1.0/openings/.env.local` or explicit manual-run secrets.
- Do not commit live business values, raw verification codes, or unredacted customer contact details to golden traces.
