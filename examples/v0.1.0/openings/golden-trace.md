# Generate or Replay the Golden Trace

Audience: contributors generating, reviewing, or redacting the v0.1.0 golden trace.

The checked-in v0.1.0 trace is:

```text
traces/v0.1.0/openings-create.json
```

It captures a successful redacted live booking. It uses aliases for fixture ids, booking id, customer details, and audit events. The top-level `unique_ids` summary records alias cardinality without exposing live ids.

## Safe Trace Candidate

Run this from the repository root:

```sh
node examples/v0.1.0/openings/generate-golden-trace.mjs
```

This calls live read-only Openings endpoints, writes a trace candidate, and stops before `booking.create`:

```text
status: awaiting_live_booking_approval
```

## Live Booking Trace

Only run this after approving the exact selected slot printed in the trace:

```sh
node examples/v0.1.0/openings/generate-golden-trace.mjs --approve-live-booking
```

This can create a real test appointment and may trigger Openings verification.

Expected successful status:

```text
status: booked
booking_status.status: booked
receipt.booking_id: booking_1
```

If a booked trace already exists and a later retry fails because the selected slot changed, the generator preserves the existing booked trace file.

## Verification Path

If Openings returns `requires_verification`:

1. Send the code with `osbp_verification_send` or the equivalent adapter flow.
2. Ask the user for the SMS code.
3. Retry `booking.create` with `verification_code`.
4. Do not call `verification.verify` before `booking.create` for the booking flow.

## Redaction Rules

Do not commit:

- live fixture ids;
- seeded customer id;
- SMS-capable test phone;
- raw verification codes;
- raw Openings appointment id;
- `.env.local`;
- `.osbp/` runtime state.

The checked-in trace should use aliases such as:

```text
service_primary
service_selected
schedule_primary
schedule_selected
provider_selected
test_customer
booking_1
aud_booking_create_001
```

The aliases preserve cardinality: if a live read returns a host schedule plus a different per-provider booking schedule, the redacted trace should show distinct aliases and `unique_ids.schedule_ids.count` should be greater than 1. The checked-in booked trace was updated in place for the new summary/redaction shape rather than regenerated, because generating a fresh booked trace requires an explicitly approved live booking.

## Useful Checks

Validate the trace shape:

```sh
node -e 'const fs=require("fs"); const t=JSON.parse(fs.readFileSync("traces/v0.1.0/openings-create.json","utf8")); console.log(t.status, t.receipt?.booking_id, t.booking_status?.status)'
```

Scan active files for accidental live fixture leaks before committing:

```sh
rg -n 'LIVE_FIXTURE_OR_PHONE_PATTERN' README.md docs examples traces packages
```
