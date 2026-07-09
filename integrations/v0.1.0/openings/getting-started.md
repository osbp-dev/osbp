# Getting Started

Audience: contributors setting up the local v0.1.0 Openings example.

Use this once before testing Claude Desktop, Crush, OpenAI/ChatGPT planning, or the golden trace.

## One-Time Setup

1. Install and build from the repository root:

```sh
npm install
npm run build
```

2. Copy the sample environment file:

```sh
cp integrations/v0.1.0/openings/.env.example integrations/v0.1.0/openings/.env.local
```

3. Fill `.env.local` with the provided Openings values.

The local Openings values live in `.env.local`, which is ignored by git. Do not commit live business ids, customer ids, SMS-capable phone numbers, or verification codes.

4. Verify the safe read-only path:

```sh
npm --workspace @osbp/mcp-server run smoke:read
```

This read-only smoke calls Openings business, location, service, policy, and availability endpoints. It should not create a booking, send SMS, or write a live appointment.

## Local Runtime State

- Local idempotency cache: `.osbp/idempotency/openings-v0.1.0.json`
- Local MCP audit log: `.osbp/audit/events.jsonl`
- Override audit path: `OSBP_AUDIT_LOG_PATH=/path/to/events.jsonl`

Both `.osbp/` and `.env.local` are ignored by git.

## Caveats

- Live booking commands create controlled live appointments in the configured Openings business.
- The booking flow should call `booking.create` first; if Openings requires verification, call `verification.send`, ask the user for the code, and retry `booking.create` with the raw `verification_code`.
- Do not call `verification.verify` before `booking.create` for the Openings booking flow. The v0.1.0 Openings adapter returns `invalid_verification_purpose` for `verification.verify` because the Openings verify endpoint consumes the booking verification session.
- `booking.status` answers from the local idempotency record first, then reads Openings `/review` by appointment id when an id is supplied. Only when no id is available does it fall back to the verification-gated appointment history, which v0.1.0 read tools cannot complete, so that path fails closed with `booking_status_requires_verification`.
