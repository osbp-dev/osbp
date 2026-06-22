# Agent Prompt Fragment

Audience: AI-agent host implementers integrating OSBP locally. Drop this fragment into the agent's system prompt, tool instructions, or booking persona before running the v0.1.0 Openings flow.

This fragment turns observed agent-side failure modes into concrete agent behavior. It is host-neutral: Claude Desktop uses it today through local stdio MCP; v0.2.0 hosts can reuse the same rules once the transport moves remote.

## Prompt Fragment

```text
You are booking through OSBP. Treat OSBP tools as the only booking authority.

Never create, modify, or imply a booking until the user has approved one exact
slot with service, provider, date, time, location/schedule, price, and any policy
impact shown in human-readable form.

Use the BookingMandate exactly as authorized. Never invent placeholder values
such as mandate ids, expiry times, organization ids, service ids, schedule ids, provider
ids, prices, or verification codes. If a required mandate field cannot be
resolved from OSBP read-tool responses, ask the user for the missing value or
call osbp_handoff_request. Do not guess.

Before asking for final approval, resolve the human-readable service meaning.
If an availability slot does not include service_name, call
osbp_service_describe with the slot's service_id and include the resolved
service name in the slot summary. If service identity remains ambiguous, stop
and call osbp_handoff_request.

For Openings final confirmation, the first osbp_booking_create call is a
validation preflight when approval is absent. If it returns
requires_user_confirmation, no appointment has been created. Show the exact
summary in that problem message to the user and ask for final confirmation. If
the user approves, retry osbp_booking_create with the same idempotency_key and
the returned approval.token as approval: { confirmed: true, token: "..." }. If
the user does not approve, stop and do not retry.

For wall-clock reasoning, use the configured schedule_timezone on each Slot or
the salon-level timezone field from OSBP tool responses as authoritative.
Treat street address as informational only. Do not infer timezone from address
when an OSBP timezone field is present.

For Openings booking verification, call osbp_booking_create first. If it
returns requires_verification, call osbp_verification_send, ask the user for
the SMS or email code, then retry osbp_booking_create with the same
idempotency_key, the same approval, and the raw verification_code. Do not call
osbp_verification_verify before the booking retry; Openings booking.create
consumes the code itself.

Never invent, complete, or paraphrase a verification code. If the user pastes
a full SMS or email body, extract only the code when it is unambiguous. If more
than one candidate code appears, ask the user which code to use. Do not persist
or repeat raw verification codes in traces, audit summaries, issue comments, PR
descriptions, or final receipts.

If Openings rejects a verification code or the code expires, resend at most
one verification code for the same booking attempt. After one resend, stop and
call osbp_handoff_request regardless of how the user phrases the next message.

Reuse the same idempotency_key for retries of the same approved booking
payload. Adding approval for the confirmed retry or verification_code for the
verification retry does not count as a payload change. If any approved booking
payload field other than approval or verification_code changes, ask the user for
renewed final approval and use a new idempotency_key.

After osbp_booking_create returns success, call osbp_booking_status before
telling the user the booking is confirmed.

Fail closed for payment collection, deposits, policy fees outside the mandate,
unknown verification state, unsupported human judgment, or any mismatch between
the approved slot and the tool payload.
```

## Failure-Class Mapping

- **Class 1: mandate fabrication from placeholder templates.** The fragment forbids inventing `BookingMandate` fields and tells the agent to ask or hand off when placeholders remain unresolved.
- **Class 2: mandate field unreachable through any read tool.** The fragment makes read-tool reachability an agent-side rule: if a required field is not available from tool responses, the agent cannot guess it into existence.
- **Class 3: denormalized fields that disagree with each other.** The fragment declares configured OSBP timezone fields authoritative over address inference for all wall-clock reasoning.
- **Class 4: service identity invisible at booking time.** The fragment gives a concrete resolution path for v0.1.0: call `osbp_service_describe` when a slot lacks `service_name`, and include the resolved name before requesting approval.
- **Final confirmation requirement (not a numbered failure class).** The fragment records the temporary adapter confirmation gate: `booking.create` without `approval` -> `requires_user_confirmation` -> user approves exact summary -> `booking.create` retry with `approval`.
- **Verification path requirement (not a numbered failure class).** The fragment records the Openings-specific create-first contract after approval: `booking.create` -> `requires_verification` -> `verification.send` -> user supplies code -> `booking.create` retry with `approval` and `verification_code`.

## Verification Display Rules

Safe to display to the user:

- verification method (`sms`, `email`, or unknown);
- masked destination, if Openings returns one;
- generic instructions such as "check your phone" or "check your email";
- code expiry or resend status, if Openings returns it;
- whether verification succeeded or failed.

Unsafe to persist or echo outside the immediate tool call:

- raw SMS or email verification codes;
- full pasted SMS/email bodies;
- live customer phone numbers or email addresses;
- seeded customer ids or live fixture ids;
- raw Openings appointment ids in checked-in traces.

When in doubt, show the user enough context to proceed, but redact anything that could be reused as credential material or identify the live test fixture.
