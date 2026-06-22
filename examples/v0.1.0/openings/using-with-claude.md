# Test with Claude

Audience: contributors testing the v0.1.0 local MCP server with Claude Desktop or Claude Code.

Claude Desktop is the v0.1.0 agent host because it can launch the local stdio MCP server directly. Claude Code with stdio MCP also works; the steps are equivalent. ChatGPT needs a remote endpoint and is therefore deferred to v0.2.0.

For reusable booking-agent behavior rules, add the [agent prompt fragment](./agent-prompt-fragment.md) to the agent instructions before running the live booking prompt. The fragment covers verification relay, final approval, idempotency, timezone precedence, service-name ambiguity, and fail-closed handoff.

> **Where this is heading.** Editing `claude_desktop_config.json` by hand is the right move for a proof of concept but not for production. Once OSBP has a hosted remote MCP endpoint (the v0.2.0 milestone), integration shifts to Claude's Connectors UI: the user clicks "Add OSBP" in Claude Desktop or claude.ai, signs in (OAuth carries their real customer identity instead of the seeded test customer in `.env.local`), and the booking mandate is constructed by an identity/wallet layer rather than pasted into a prompt. The tool surface (`osbp_service_describe`, `osbp_booking_create`, etc.) stays the same — only the transport, auth, and customer identity move from local fixtures to real services.

## Prerequisites

1. Complete the [one-time setup](./getting-started.md#one-time-setup).
2. Confirm the workspace builds:

```sh
npm run build
```

3. Confirm the read-only smoke succeeds:

```sh
npm --workspace @osbp/mcp-server run smoke:read
```

## Configure Claude Desktop

Claude Desktop reads its MCP server list from a single JSON file in your home directory. You will edit that file to add the OSBP server.

### Step 1 — Open Claude Desktop's config file

In Claude Desktop's menu, choose **Settings → Developer → Edit Config**. That opens the file in your default text editor. The file path is:

| Platform | Config file path |
|---|---|
| macOS | `~/Library/Application Support/Claude/claude_desktop_config.json` |
| Windows | `%APPDATA%\Claude\claude_desktop_config.json` |
| Linux | `~/.config/Claude/claude_desktop_config.json` |

If the file does not exist yet, create it with `{}` as its only contents and reopen.

### Step 2 — Get the absolute paths you'll need

The example at [claude-desktop.mcp.example.json](./claude-desktop.mcp.example.json) uses placeholders. **All three values must be absolute paths** — relative paths and `../..` traversal do not work reliably across Claude Desktop versions; the spawned Node process tends to resolve `args[0]` against `cwd` in ways that vary.

Run this from the repo root to print the three values you'll paste:

```sh
echo "command: $(which node)"
echo "args[0]: $(pwd)/packages/osbp-mcp-server/dist/server.js"
echo "cwd:     $(pwd)"
```

### Step 3 — Add the OSBP entry to `mcpServers`

Open `claude_desktop_config.json` and locate the `mcpServers` object. There are three cases:

**Case A — empty config file (`{}` or new file):** replace its contents with:

```json
{
  "mcpServers": {
    "osbp-openings-v0.1.0": {
      "command": "<paste command from Step 2>",
      "args": ["<paste args[0] from Step 2>"],
      "cwd": "<paste cwd from Step 2>"
    }
  }
}
```

**Case B — config has top-level keys but no `mcpServers`:** add the `mcpServers` key alongside whatever else is there. JSON requires a comma between sibling keys:

```json
{
  "theme": "dark",
  "mcpServers": {
    "osbp-openings-v0.1.0": {
      "command": "node",
      "args": ["<path-to-your-clone>/packages/osbp-mcp-server/dist/server.js"],
      "cwd": "<path-to-your-clone>"
    }
  }
}
```

**Case C — `mcpServers` already exists with other servers:** add `"osbp-openings-v0.1.0": { … }` as a sibling entry inside the existing `mcpServers` object. Do not nest it inside another server. Example:

```json
{
  "mcpServers": {
    "some-other-server": {
      "command": "/usr/local/bin/some-tool"
    },
    "osbp-openings-v0.1.0": {
      "command": "<paste command from Step 2>",
      "args": ["<paste args[0] from Step 2>"],
      "cwd": "<paste cwd from Step 2>"
    }
  }
}
```

Save the file.

### Step 4 — Validate the JSON before restarting

Claude Desktop will silently ignore a malformed config file and your tools just won't appear, so it's worth catching trailing-comma and bracket-mismatch mistakes up front. Pick the one-liner for your platform:

```sh
# macOS
python3 -m json.tool ~/Library/Application\ Support/Claude/claude_desktop_config.json > /dev/null && echo OK

# Linux
python3 -m json.tool ~/.config/Claude/claude_desktop_config.json > /dev/null && echo OK

# Windows (PowerShell)
Get-Content "$env:APPDATA\Claude\claude_desktop_config.json" | ConvertFrom-Json | Out-Null; if ($?) { "OK" }
```

If you see `OK`, the file parses. If you see an error, it tells you the line and column to fix.

### Step 5 — Restart Claude Desktop

Fully quit Claude Desktop (⌘Q on macOS) and reopen — Claude Desktop only reads `claude_desktop_config.json` at launch.

## Confirm Tools Are Visible

Claude should see these MCP tools:

```text
osbp_service_describe
osbp_availability_find
osbp_policy_explain
osbp_verification_send
osbp_verification_verify
osbp_booking_create
osbp_booking_status
osbp_handoff_request
```

If any are missing, check Claude Desktop's MCP logs:

```sh
tail -n 50 ~/Library/Logs/Claude/mcp*.log
```

## Configured Defaults (auto-filled from .env.local)

In v0.1.0 the local adapter substitutes fixture values from `.env.local` for omitted fields, the read tools most of all. The agent does not need to discover salons, services, schedules, or providers because they are pinned. The one strict exception is `booking.create` (see the practical-effect note below). In future versions each of these will be reached dynamically through OSBP tool calls; the table below shows what stands in for what.

| .env.local field | What it pins in v0.1.0 | Dynamic source in future versions |
|---|---|---|
| `OPENINGS_API_BASE_URL` | Openings API endpoint | Same — stable infra constant |
| `OPENINGS_SALON_SLUG` / `OPENINGS_SALON_ID` | The single sample salon | Merchant-directory search (`merchant.search` or marketplace lookup), eventually replacing the single-salon assumption |
| `OPENINGS_SERVICE_IDS[0]` | Default `service_id` for `osbp_service_describe`, `osbp_policy_explain` | Agent picks a service from a multi-result `service.describe` based on the user request |
| `OPENINGS_SCHEDULE_IDS[0]` | Default schedule used by the golden-trace generator | `osbp_availability_find` returns openings across schedules; agent or user picks one |
| `OPENINGS_STAFF_USER_IDS[0]` | Default provider used by the golden-trace generator | Availability returns provider-specific slots; provider is part of the chosen `Slot` |
| `OPENINGS_TEST_CUSTOMER_ID` | Default `customer.id` for `osbp_booking_create` | Customer identity from the agent host (signed-in user, OAuth, or per-session profile) |
| `OPENINGS_TEST_CUSTOMER_PHONE` | Default phone for `osbp_verification_send` | Pulled from the authenticated customer profile |
| `OSBP_IDEMPOTENCY_STORE_PATH` | Local idempotency cache for booking retries | Same shape; may move to a server-side store when OSBP runs remotely in v0.2.0 |

Practical effect for a v0.1.0 test: if you say "book the standard service tomorrow at 10am" without specifying ids, the read tools resolve the service from `.env.local`, and the agent threads that `service_id` into the `booking.create` payload. The mutation keeps `service_id`, `schedule_id`, `provider_id`, `date`, and `time` required (only the customer is defaulted from `.env.local`), so you only have to *type* date, time, schedule, and provider. Source of these defaults: `loadOpeningsConfigFromEnv` and the `?? this.config.*` fallbacks in [packages/openings-adapter/src/index.ts](../../../packages/openings-adapter/src/index.ts).

## Safe Read-Only Prompt

Use this first. It should not create bookings or send SMS:

```text
Use the OSBP Openings sample salon tools to describe the first configured service,
find availability for the first configured schedule on the next available date,
and explain the policy. Do not create a booking, send verification, or send SMS.
```

Expected tool sequence:

```text
osbp_service_describe
osbp_availability_find
osbp_policy_explain
```

Expected result:

```text
Claude summarizes the service, available slots, and payment/cancellation policy.
No booking is created.
```

## Live Booking Prompt

**Use this prompt for any booking attempt.** OSBP requires a `BookingMandate` on every `osbp_booking_create` call by design — it's the trust boundary that prevents the agent from booking anything you didn't authorize. Without one, Claude will (correctly) refuse to call the tool with a message like "Openings requires an authorization mandate."

The prompt below tells Claude to construct a mandate, show it to you for approval, and reuse it across retries — including verification flows. Use it from the start of any booking conversation, not as a "last step."

Skip the prompt only if you've already authored a mandate and are pasting it inline (see "Common error: missing mandate" below for the inline format).

```text
Use OSBP to book one safe test appointment at the Openings demo salon.

Step 1. Construct a BookingMandate object that you will reuse for booking.create:
  {
    "id": "mandate_<short_uuid>",
    "expires_at": "<ISO8601 about 30 minutes from now>",
    "allowed_actions": ["booking.create", "verification.send"],
    "organization_id": "<from osbp_policy_explain.organization.id or osbp_availability_find slot.organization_id>",
    "max_price": { "amount_minor": <upper bound in the currency's ISO 4217 minor unit; for USD this is cents, e.g. 15000 = $150.00>, "currency": "<salon currency, e.g. USD>" },
    "allow_policy_fee": false
  }
  Show me the mandate, AND ALSO show me the human-readable price cap
  ("$150.00 USD") so I can confirm the cap matches what I authorized.
  All money fields are Money objects: amount_minor is in the currency's
  ISO 4217 minor unit (varies by currency, not always cents) and currency
  is required. For display, use the price.display field on Service/Slot
  when available.

Step 2. Call osbp_service_describe, osbp_availability_find, osbp_policy_explain.

Step 3. Select one exact slot candidate (service, provider, date, time, price)
  and show it to me. Do not say it is booked.

Step 4. Generate one idempotency_key (a UUID) and reuse it on every retry of
  osbp_booking_create for this booking attempt. Do not generate a new one if
  Openings asks for verification.

Step 5. Call osbp_booking_create with mandate, idempotency_key, and the
  selected slot, but omit approval. Customer defaults to the seeded test
  customer from .env.local; you do not need to pass a customer object. If this
  returns requires_user_confirmation, no appointment has been created.

Step 6. If osbp_booking_create returns requires_user_confirmation, show me the
  exact summary from the problem message. Ask me to approve that exact booking.
  If I approve, retry osbp_booking_create with the same idempotency_key and
  approval: { confirmed: true, token: "<returned approval.token>" }. If I do
  not approve, stop.

Step 7. If the approved osbp_booking_create returns requires_verification, call
  osbp_verification_send, then ask me for the SMS code, then retry
  osbp_booking_create with the same idempotency_key, the same approval, and
  verification_code.
  Do not call osbp_verification_verify before osbp_booking_create — the
  Openings booking flow consumes the code through booking.create itself.

Step 8. Call osbp_booking_status to confirm the appointment.

Step 9. Do not collect payment. If a deposit, full payment, or any
  policy fee outside the mandate is required, stop and call
  osbp_handoff_request with a clear reason.
```

Expected sequence:

```text
user request
BookingMandate (constructed by Claude, shown to user)
osbp_service_describe
osbp_availability_find
osbp_policy_explain
osbp_booking_create without approval                  (validation preflight; no appointment created)
final user approval of the exact returned summary
osbp_booking_create with approval
osbp_verification_send                              (only if Openings returned requires_verification)
osbp_booking_create with same approval + verification_code
osbp_booking_status
```

Expected final answer:

```text
Claude reports the service, date, time, provider, Openings appointment id,
and OSBP receipt text. It should not include raw verification codes.
```

Expected failure modes you may hit:

- `mandate_expired` — your `expires_at` was in the past or elapsed during the flow. Construct a new mandate.
- `price_exceeds_mandate`: selected slot price is above `max_price`. Raise the cap or pick a cheaper service.
- `requires_human` from `osbp_handoff_request` — by design, when payment is required.

## Common error: missing mandate

If you ask Claude to book something without first running the Live Booking Prompt above, you will see something like:

> *I can't complete this booking automatically — Openings requires an authorization mandate (a signed token authorizing me to book on your behalf with specific parameters: salon, service, price cap, time window, etc.). I don't have one for this booking.*

This is the protocol working correctly: the agent fails closed when it lacks explicit authorization. Two ways to recover without restarting the conversation:

**Option A — paste the Live Booking Prompt** above and ask Claude to proceed. It will construct the mandate, show it to you, and continue.

**Option B — paste a mandate inline.** Replace the placeholders, send this to Claude, then ask it to retry the booking:

```text
Here is your BookingMandate. Use it for booking.create:

{
  "id": "mandate_<short_uuid_or_timestamp>",
  "expires_at": "<ISO8601 about 30 minutes from now>",
  "allowed_actions": ["booking.create", "verification.send"],
  "organization_id": "<organization_id from policy.explain or an availability.find slot>",
  "max_price": { "amount_minor": 15000, "currency": "USD" },
  "allow_policy_fee": false
}

Also generate a UUID for idempotency_key and reuse it on every retry,
including any approval or verification retry. Use the first
osbp_booking_create call as a validation preflight. If it returns
requires_user_confirmation, show me the exact returned summary and ask me to
approve before retrying with approval.confirmed=true and the returned
approval.token.
```

A concrete example you can edit:

```json
{
  "id": "mandate_2026-06-19-001",
  "expires_at": "2026-06-19T21:00:00-07:00",
  "allowed_actions": ["booking.create", "verification.send"],
  "organization_id": "<paste actual organization_id>",
  "max_price": { "amount_minor": 15000, "currency": "USD" },
  "allow_policy_fee": false
}
```

> **Note for production.** This inline-mandate dance is a v0.1.0 limitation. v0.2.0's Connectors UI will store per-salon mandate templates at connector-install time so the customer never has to think about mandate JSON — Claude's `booking.create` call gets the mandate auto-attached by the connector layer, and the customer is prompted by the system (not the agent) to confirm a slot. Same trust boundary, dramatically better UX.

## Local Evidence

After a successful tool run, inspect:

```sh
tail -n 20 .osbp/audit/events.jsonl
```

The audit log should contain redacted JSONL events with `audit_event_id` values returned to Claude. Each `booking.create` event should also carry the `mandate_id` from the mandate Claude constructed.

If you re-run the Live Booking Prompt and Claude returns the same booking without hitting Openings, that is the local idempotency cache replaying the prior result:

```sh
cat .osbp/idempotency/openings-v0.1.0.json
```

To force a fresh attempt, either delete that file or have Claude generate a new `idempotency_key`.
