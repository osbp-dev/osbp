# Open Service Booking Protocol

Audience: integrators, agent builders, and reviewers evaluating OSBP's first public release.


- **Originator:** Andy Volk
- **Version:** 0.1.0
- **Canonical site:** <https://osbp.dev>

Open Service Booking Protocol (OSBP) is a protocol layer to enable AI-agent-driven service booking. To keep that authority bounded, OSBP lets an AI agent book an appointment only inside a user-approved authorization called a `BookingMandate`.

The challenge is broad: dentists, notaries, auto shops, spas, clinics, classes, and other appointment-based businesses all expose different APIs, policies, prices, schedules, and verification rules.

OSBP's bet is that agents do not need unchecked write access to all of them. They need a common, inspectable way to look up services, explain policies, ask for bounded permission, book only inside that permission, and fail closed when the selected appointment no longer fits. OSBP v0.1.0 proves the smallest useful version of that method.

The v0.1.0 release demonstrates the core claim: an agent-shaped flow books a synthetic appointment through OSBP, bounded by a mandate the user approved first. The agent can search, compare, and prepare freely. It can mutate only inside the mandate.

## Where OSBP Fits

OSBP is a domain protocol for service booking. It rides on the Model Context Protocol (MCP) for transport: MCP carries the bytes; OSBP defines what booking-related tool calls mean and the guardrails that wrap them.

```text
Customer <-> AI agent <-> OSBP server <-> booking platform
```

OSBP does not replace MCP, OpenAPI, or a booking platform's native API. The booking platform remains the system of record. OSBP validates authority, translates tool calls, and records an audit trail.

Payment authority is a separate layer. AP2, ACP, and UCP are converging on how agents conduct commerce and obtain authorization to spend. OSBP authorizes the booking, not the payment, and is intentionally scoped to compose with payment-authorization protocols rather than duplicate them.

One adjacent gap, named here on purpose: agents depend on service APIs that cannot yet describe their own versions, lifecycles, or limits to a machine, and no standard does this today. OSBP composes the web standards that exist (deprecation and sunset signaling, lifecycle capture, explicit version pinning) and shows the rest in practice in its reference adapter.

## Core Concepts

- **`BookingMandate`** is the user-approved authorization every mutation rides inside. It records who approved the booking, the allowed organization, service, provider, schedule, and time window, the price and policy-fee caps, the allowed actions, and an expiry. The agent may read, compare, and prepare freely; it can mutate only within these bounds.
- **Fail closed.** The server validates the mandate, idempotency, and policy before any write to the booking platform. An out-of-bounds or unverifiable request is rejected or routed to a structured handoff, never guessed past.
- **`Problem`** is the stable, platform-independent error shape returned by failed tool calls: `{ code, message, retryable? }`. Agents branch on `code` (for example `price_exceeds_mandate`, `requires_verification`, `slot_taken`), so the same handling works across every adapter.

## What v0.1.0 Proves

v0.1.0 is a usable proof and formative contract, not a stability promise. It proves this smallest useful loop:

```text
BookingMandate -> lookup -> policy readback -> user approval -> create -> verification if required -> status -> receipt
```

The boundary proves itself by refusing. The demo books a service inside a mandate's price cap, then attempts a booking above the cap under the same mandate and is rejected with `price_exceeds_mandate` before any platform write. A successful booking looks like any other API call; the visible rejection is what demonstrates the guardrail.

The synthetic reference backend includes multiple verticals so the protocol is tested against different booking shapes:

- dental: fixed-price booking, no-show fee, deposit, and consultation guardrails
- notary: in-person and remote appointments for the same service
- auto service: EUR pricing and Berlin local time
- spa: UK timezone, prepay policy branches, and non-USD examples

The reference implementation includes:

- a TypeScript protocol core with mandate validation
- a credential-free synthetic reference backend with four unrelated verticals
- a reusable conformance kit that cross-checks the reference backend 44/44
- an adapter starter kit that compiles and fails closed until implemented
- redacted audit events and a credential-free reference trace gallery

This is the **minimal public cut**: the platform-neutral spec, the protocol core, the credential-free reference backend, the conformance kit, and an adapter starter. It demonstrates protocol behavior through the reference backend and `npm run demo` (a CLI), not through a hosted MCP server. OSBP defines its tools as MCP tools (see the [spec](docs/spec/v0.1.0/README.md)), but the stdio MCP server package and a worked real-platform adapter are deferred to a later cut; what this cut proves is the authorization model, the fail-closed guardrails, and the adapter contract.

## Run the Demo

Run the credential-free demo. It needs no platform account and no secrets:

```sh
npm run demo
```

It books a synthetic appointment inside a `BookingMandate`, then attempts an over-cap booking under the same mandate and shows the gate rejecting it with `price_exceeds_mandate`.

<!-- LAUNCH_GIF: embed the recorded demo GIF here before publishing (it ends on the over-cap rejection); see the demo runbook. -->

## Tool Set

OSBP v0.1.0 keeps the surface intentionally small:

```text
service.describe
availability.find
policy.explain
verification.send
verification.verify
booking.create
booking.status
handoff.request
```

Every mutation requires a `BookingMandate` and an `idempotency_key`. If payment, verification, policy, consultation, or platform state cannot be handled safely, OSBP fails closed or returns a structured handoff.

## Start Here

- [Spec](docs/spec/v0.1.0/README.md): the protocol model, tools, mandate rules, and audit requirements.
- [Schema](docs/spec/v0.1.0/schema.md): implementation-bound field definitions for the proof of concept.
- [Reference backend](packages/reference-backend): the credential-free synthetic platform behind `npm run demo`; the recommended first run.
- [Trace gallery](traces/v0.1.0/): `npm run trace` replays the credential-free reference traces locally with no secrets.
- [Roadmap](ROADMAP.md): near-term direction while the protocol is pre-1.0.

## Boundaries

v0.1.0 does not include merchant marketplace search, slot holds, modify/cancel flows, payment collection, production mandate signing, or public conformance certification. Those are deliberately outside this first proof so the booking safety boundary stays small enough to inspect.

## License

Code is licensed under Apache-2.0. Specification prose and documentation are licensed under CC-BY-4.0 unless a file states otherwise. See [LICENSE](LICENSE) and [NOTICE](NOTICE).
