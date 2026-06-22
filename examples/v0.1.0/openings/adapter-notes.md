# OSBP v0.1.0 Openings Adapter Notes

Audience: integrators implementing or validating the Openings reference adapter.

Implementation notes specific to the Openings reference adapter for the v0.1.0 proof of concept. These are adapter detail, deliberately kept out of the [protocol spec](../../../docs/spec/v0.1.0/README.md), which defines the platform-agnostic contract.

## Openings API Baseline

Public docs:

- docs home: `https://docs.openings.link`
- OpenAPI JSON: `https://docs.openings.link/openapi/openings.json`
- base URL: `https://api.openings.link`

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
  "salonId": "salon_123",
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
  "sendNotifications": true
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
- A sandbox salon has been seeded with one schedule, one provider, one service (`paymentRequirement: "NONE"`, no deposit), and a reusable test `customerId`. Live ids belong in ignored local config or a gated CI secret, not in portable packages.
- `paymentRequirement` is per-service (`NONE` | `DEPOSIT` | `FULL`); `DEPOSIT` and `FULL` map to a payment-required handoff per service.
- Verification is risk-based. Try create first; on HTTP 428, send a code and retry create with `verificationCode`. If a flow does call `/v1/verifications/verify` first, the verification is cached server-side and `verificationCode` need not be repeated at create.
- Do not set Openings' private booking flags.
- `sendNotifications` should be `true`.
- The demo salon is safe for v0.1.0 test bookings.
- v0.1.0 auth is public/unauthenticated.
- A public by-id readback is available: `GET /v1/appointments/{id}/review` (no auth, no verification step; id-as-capability), with a salon-authenticated `GET /v1/appointments/{id}` also available. `booking.status` reads `/review` by id when an id is supplied and falls back to `GET /v1/appointments/history/{phone}` (verification-gated) only when no id is available. The `/review` 200 mapping (`mapReviewBooking`) maps a shape now documented in the Openings OpenAPI, and the public `/review` omits the opaque `metadata` field so the mapping does not read it. On create, OSBP does write an allowlisted, PII-free `metadata` map to the Openings appointment (`osbp_idempotency_key`, `osbp_mandate_id`, `osbp_source`), never customer data, surfaced only on the authenticated owner/member read path.

Live input handling:

- The seeded reusable test phone number receives real SMS, so treat it as a live SMS-capable fixture.
- Keep live fixture ids and phone numbers in `examples/v0.1.0/openings/.env.local` or explicit manual-run secrets.
- Do not commit live fixture values, raw verification codes, or unredacted customer contact details to golden traces.
