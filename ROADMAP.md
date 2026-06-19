# Roadmap

Audience: integrators, agent builders, and contributors who want to know where OSBP is heading next.

OSBP v0.1.0 is a usable proof and formative contract. It shows an agent completing a real booking through a narrow tool set, bounded by a user-approved `BookingMandate`, with local idempotency, audit, and fail-closed behavior.

The project is pre-1.0. The near-term roadmap is directional, not a compatibility promise.

## Near-Term Directions

- **Remote MCP transport.** OSBP will explore a hosted, streamable HTTP MCP endpoint so agent hosts that cannot launch local stdio servers can validate the same tool contract.
- **Verifiable agent identity and transport authorization.** OSBP will move beyond a self-declared `User-Agent` toward cryptographically verifiable agent identity (for example HTTP Message Signatures and the emerging Web Bot Auth profile, RFC 9421) and, for the remote MCP server, OAuth resource-server authorization, so the booking platform can authenticate the caller and attribute a booking to a specific user. Where a booking platform exposes an opaque metadata field on its appointment record, OSBP will also write the mandate id and audit reference into it, so a booking stays durably attributable on the platform side.
- **Broader agent-host validation.** OSBP will test the booking flow across more agent surfaces while keeping mandate enforcement server-side rather than trusting host UI alone.
- **Cancel and change surfaces.** OSBP will design cancellation and booking-change tools only after the create-booking proof is stable enough to extend without blurring the trust boundary.
- **Payment-protocol composition.** OSBP will keep payment authority separate and define how booking mandates can compose with payment-mandate protocols when a booking requires money movement.
- **Contention controls for scarce slots.** Because OSBP holds no slot and the platform is the system of record, the first completed mutation wins, which is a race when provider time is scarce and sharper when a deposit sits inside a multi-step booking. OSBP will explore an optimistic-concurrency token (an `availability_snapshot_id` carried on a mutation, so a stale attempt fails cleanly with fresh availability instead of double-booking) and, where a platform supports it, a short-lived hold with an explicit complete-by deadline (`hold_expires_at`) that lets a booking reserve, authorize payment, and confirm inside one window, releasing the hold and voiding the authorization on failure so a user is never booked-not-paid or paid-not-booked. Holds stay optional and platform-dependent; OSBP will not require a hold where a platform has none.
- **Integrator-facing conformance.** OSBP now has a first credential-free conformance kit for `BookingAdapter` implementations, and will grow examples, traces, and machine-checkable schemas so platform adapters can be generated, reviewed, and verified against the same narrow contract.
- **Host-enforced final confirmation.** v0.1.0's final-confirmation gate is adapter-side: a short-lived approval token returned by a no-write `booking.create` that still flows through the agent, so it cannot prove a human approved the summary. OSBP will explore a host or server confirmation primitive outside the agent's unilateral control, so the approval a booking rides on is one the agent cannot forge.
- **A closed `Problem.code` set.** v0.1.0 treats `Problem.code` as an open string with a recommended, spec-listed set, so an adapter can surface platform-specific failures. A later versioned change will publish a closed enum (a TypeScript union, a JSON Schema `enum`, and a conformance check) once the code set has settled across more platforms.

## What Stays Out For Now

OSBP will not become a marketplace, payment processor, identity wallet, or general agent-to-agent coordination layer. It should stay small enough that a booking platform can implement it, an AI agent can reason over it, and a user can understand exactly what authority they granted.
