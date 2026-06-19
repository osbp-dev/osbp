# AGENTS.md

Audience: developers writing OSBP adapters and AI agents generating adapters from the spec.


This is the public implementation guide for Open Service Booking Protocol (OSBP) adapters. It is intentionally thin: the spec is the normative contract, and this guide points implementers to the parts of that contract that matter most when mapping a booking platform.

Human contributor workflow, including branches, commits, pull requests, AI disclosure, and data hygiene, lives in [CONTRIBUTING.md](CONTRIBUTING.md). This file covers adapter behavior and protocol safety.

## Canonical Sources

- [Protocol spec](docs/spec/v0.1.0/README.md): tool semantics, mandate enforcement, audit, security, and the adapter contract.
- [Schema](docs/spec/v0.1.0/schema.md): field definitions, optionality, tool inputs, result envelope, `Problem`, and time formats.
- [Adapter implementation guide](docs/spec/v0.1.0/implementing-an-adapter.md): starter-kit workflow, method map, and conformance ids.

The public release tag is v0.1.0. The implementation target described by the checked-in spec remains the v0.1.0 proof of concept.

## Who This Is For

- Platform developers integrating an existing booking system by writing an OSBP adapter.
- AI agents generating a draft adapter from the OSBP spec and a platform's API docs.

Keep generated adapters boring: parse platform responses structurally, map into the OSBP schema, validate before every mutation, and fail closed when the platform does not match the contract.

## Rule Map

| Rule | Implementation note | Canonical source |
|---|---|---|
| Keep the tool surface small | Implement the eight OSBP tools. Do not add platform-shaped tools because a convenient endpoint exists. | [Tool Set](docs/spec/v0.1.0/README.md#tool-set), [Non-Goals](docs/spec/v0.1.0/README.md#non-goals) |
| Implement the adapter contract | Translate platform behavior through the seven `BookingAdapter` methods and normalized `AdapterResult` values. | [Adapter Contract](docs/spec/v0.1.0/README.md#adapter-contract), [Adapter Interface](docs/spec/v0.1.0/schema.md#adapter-interface) |
| Treat the platform as system of record | Do not invent booking truth locally, claim a slot is held without a real platform hold, or bypass platform availability, verification, or payment checks. | [Participants](docs/spec/v0.1.0/README.md#participants), [Security and Privacy Considerations](docs/spec/v0.1.0/README.md#security-and-privacy-considerations) |
| Gate mutations with a mandate and final confirmation | Every mutation MUST stay inside a user-approved `BookingMandate`. The server validates scope before mutation, and the platform create call must not happen until final confirmation is present. | [BookingMandate](docs/spec/v0.1.0/README.md#bookingmandate), [Mandate Enforcement](docs/spec/v0.1.0/README.md#mandate-enforcement) |
| Fail closed on unknowns | Unknown payment requirements, unknown amounts, unsupported consultation or approval flows, ambiguous mutation results, and unmapped upstream states return a `Problem` or `handoff.request`. | [Result Envelope](docs/spec/v0.1.0/README.md#result-envelope), [handoff.request](docs/spec/v0.1.0/README.md#handoffrequest), [Security and Privacy Considerations](docs/spec/v0.1.0/README.md#security-and-privacy-considerations) |
| Use local idempotency | `booking.create` requires `idempotency_key`. Deduplicate through a local adapter cache; exclude transient `approval` and `verification_code` from the logical-attempt hash; reject same-key different-payload retries. | [booking.create](docs/spec/v0.1.0/README.md#bookingcreate), [Mandate Enforcement](docs/spec/v0.1.0/README.md#mandate-enforcement) |
| Do not infer upstream id semantics | Treat upstream id-like fields as opaque until their meaning is documented, visible in source, or empirically verified. Do not route OSBP idempotency through an upstream foreign key. | [booking.create](docs/spec/v0.1.0/README.md#bookingcreate), [Future-Tense Discipline](#future-tense-discipline) |
| Keep time categories separate | Concrete slot/booking times carry both an absolute RFC 3339 instant and the merchant-local wall-clock (`*_local`) with its IANA timezone. Mandate expiry and audit timestamps are RFC 3339 instants; mandate `earliest_start`/`latest_end` stay wall-clock. The validator rejects category crossings. | [Time Discipline](docs/spec/v0.1.0/README.md#time-discipline), [Schema: Time Discipline](docs/spec/v0.1.0/schema.md#time-discipline) |
| Use the shipping `Problem` shape | Branch on `Problem.code`, not message text. Current shipping shape is `{code, message, retryable?}`. `next_action` is reserved for a future error model. | [Result Envelope](docs/spec/v0.1.0/README.md#result-envelope), [Schema: Problem](docs/spec/v0.1.0/schema.md#problem) |
| Make mandate fields reachable | Read tools MUST expose the fields an agent needs to construct a valid mandate. Do not hide required mandate inputs only in private config. | [Core Objects](docs/spec/v0.1.0/README.md#core-objects), [policy.explain](docs/spec/v0.1.0/README.md#policyexplain), [BookingMandate schema](docs/spec/v0.1.0/schema.md#bookingmandate) |
| Denormalize presentation context | Return human-readable service, staff, schedule/location, organization, timezone, currency, price, and policy context when the platform provides it with the source object. | [availability.find](docs/spec/v0.1.0/README.md#availabilityfind), [policy.explain](docs/spec/v0.1.0/README.md#policyexplain), [Core Objects schema](docs/spec/v0.1.0/schema.md#core-objects) |
| Omit absent optional fields | Optional upstream fields should be absent when unknown. Do not emit explicit `null` for empty or unavailable values. | [Schema: Core Objects](docs/spec/v0.1.0/schema.md#core-objects), [Tool Inputs](docs/spec/v0.1.0/schema.md#tool-inputs) |
| Redact production observability | Audit events carry redacted snapshots and stable hashes. Production traces redact secrets, verification codes, live ids, and customer contact details. Debug-only raw upstream detail belongs in an operator audit channel, not agent-facing output. | [Audit](docs/spec/v0.1.0/README.md#audit), [Security and Privacy Considerations](docs/spec/v0.1.0/README.md#security-and-privacy-considerations), [AuditEvent](docs/spec/v0.1.0/schema.md#auditevent) |
| Name wire formats | Any wire-visible format must name its standard and any deliberate deviation from likely defaults. | [Time Discipline](docs/spec/v0.1.0/README.md#time-discipline), [Schema: Time Discipline](docs/spec/v0.1.0/schema.md#time-discipline) |
| Prove conformance | The read-only smoke should pass, mandate reachability should be provable from read tools, and a redacted trace should show the full booking loop. | [Demo Trace](docs/spec/v0.1.0/README.md#demo-trace), [Implementing OSBP](docs/spec/v0.1.0/README.md#implementing-osbp) |
| Declare platform identity and capture upstream metadata | Declare `platform { vendor, api_version }` with the exact native pin and send it on every request (never dashboard defaults). Capture the request id, `Server` (an infrastructure fingerprint, not a version), API-version echoes, `Deprecation`/`Sunset` (warn the operator loudly, never a `Problem`), and RateLimit headers into the audit channel. | [Platform Metadata and Versioning](docs/spec/v0.1.0/README.md#platform-metadata-and-versioning), [Audit](docs/spec/v0.1.0/README.md#audit) |
| Send OSBP identity headers on outbound calls | Every outbound HTTP request from an adapter must include `User-Agent: OSBP/{ver} {adapter}/{ver} node/{major}` and `X-OSBP-Source: {adapter}/{ver}`. Use RFC 9110 stacked product tokens. No URL in the User-Agent (library, not service). | [HTTP Adapter Identity](AGENTS.md#http-adapter-identity) |

## AI Adapter Checklist

When generating an adapter:

1. Start from `packages/adapter-starter` or the AI context bundle at `dist/osbp-adapter-context.md`.
2. Implement the read tools first: `service.describe`, `availability.find`, and `policy.explain`.
3. Confirm those read results expose every field needed for `BookingMandate`.
4. Map platform errors into the spec's closed `Problem.code` table where possible, and never put a raw upstream response body into `Problem.message`: it can echo customer contact, so keep it on an operator-only channel.
5. Keep mutations strict: no defaulted service, schedule, staff, mandate, or idempotency fields.
6. In `createBooking`, call `validateMandate` (from `@osbp/core`) against the resolved service, slot, and policy before the platform create call. The reference host does not validate for you, so an adapter that skips this ships no enforcement.
7. Add local idempotency and final-confirmation gating before calling the platform create endpoint.
8. Return every adapter method as an `AdapterResult`, never a thrown rejection. Convert money to integer minor units, and convert instant-native times to merchant wall-clock at the boundary.
9. Run `node packages/<your-adapter>/dist/cli.js --conformance` and iterate on the failing requirement ids until green.
10. Add redaction before producing traces or examples.
11. Run the read-only smoke (it also asserts canary response shapes, so upstream drift fails loudly) and inspect the recorded trace shape before claiming conformance. `runReadOnlySmoke` in the reference is typed to the reference adapter: replicate its three checks (mandate reachability, happy-path bookability, canary shapes) for your platform rather than calling it directly, and treat the specific canary fields as the reference fixture's expectations, not protocol requirements.

The repository publishes standalone JSON Schema artifacts for the mandate, MCP tool inputs, result envelope, and `Problem` under `schemas/v0.1.0/`. `npm run check` verifies those artifacts against the Zod tool schemas before TypeScript compilation. These artifacts are platform-neutral: a new adapter adds nothing under `schemas/`.

A few orientation notes that save a wrong guess:

- **Eight tools, seven adapter methods.** The protocol exposes eight tools; `handoff.request` is host-implemented and returns a structured handoff, so the `BookingAdapter` interface has seven methods. Do not add a `handoffRequest` adapter method.
- **Starter package.** `@osbp/adapter-starter` compiles as-is, fails conformance with `adapter_not_implemented`, and includes a `--conformance` CLI whose failing ids are the implementation checklist.
- **Hosting your adapter.** The MCP host (`@osbp/mcp-server`) wraps any `BookingAdapter`. To host a new platform: implement the adapter, add the package to the root `package.json` build/check scripts and `tsconfig.json` references, and construct your adapter where the reference constructs its adapter. The host derives its server name from `platform.vendor`. See the package READMEs.
- **Config env convention.** Adapter config is namespaced by prefix so one local env file can carry several adapters' secrets. Give your adapter a dedicated `<ADAPTER>_*` config prefix and a `load<Adapter>ConfigFromEnv` that reads only that prefix; cross-adapter runtime keys use `OSBP_*` (for example `OSBP_IDEMPOTENCY_STORE_PATH`, `OSBP_AUDIT_LOG_PATH`). Layer env resolution so a repo-root `.env.local` overrides an example's lower-precedence `.env.local`, and `process.env` overrides both; never default a missing secret.
- **Version strings.** Runtime self-identification uses `OSBP_VERSION` (currently `0.1.0`); the spec and schema directory paths stay at `v0.1.0`. They are different axes; do not reconcile them.
- **Zod and the MCP SDK: one version.** The MCP SDK bundles and peer-depends on `zod@3.25.x`, whose `./v4` subpath ships the full Zod 4 API. In any package that uses zod, pin `"zod": "^3.25.0"` and `import { z } from "zod/v4"`. Do **not** add a direct `zod@4.x` dependency: npm installs a second copy and the SDK's declarations then reject schemas from it (two module instances of a version-branded type). Do **not** add `zod` to the root `devDependencies` to "anchor" the version either: workspace packages resolve zod from their own `package.json`, not the root, so a root entry anchors nothing and is dead weight. `npm ls zod` should show a single `zod@3.25.x`; run `npm dedupe` if a nested `4.x` appears.

## Future-Tense Discipline

Document what is built as built. Document intended or planned platform behavior in future tense. Do not turn a maintainer's plan, roadmap note, or API field name into a current wire contract without verification.

Before mapping a new upstream field on the wire, confirm its actual semantics. Field names are not contracts.
