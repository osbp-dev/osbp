# @osbp/openings-adapter

The worked reference adapter: it implements the OSBP `BookingAdapter` contract against the Openings booking platform's public REST API. If you are integrating a different platform, this package is the example you copy from, and this README tells you which parts are protocol pattern (copy them) and which parts are Openings-specific (replace them).

The normative rules live in the spec ([Adapter Contract](../../docs/spec/v0.1.0/README.md#adapter-contract), [Platform Metadata and Versioning](../../docs/spec/v0.1.0/README.md#platform-metadata-and-versioning)) and the agent guide ([AGENTS.md](../../AGENTS.md)). This README is orientation, not a second rule source.

## Map of `src/index.ts`

One file, top to bottom:

| Section | Symbols | What it is |
|---|---|---|
| Config | `OpeningsAdapterConfig`, `loadOpeningsConfigFromEnv` | Env-driven config: base URL, org fixture ids, test customer, idempotency store path |
| Adapter class | `OpeningsAdapter` | The seven `BookingAdapter` methods plus `platform` identity and `upstreamMeta` |
| Read tools | `describeService`, `findAvailability`, `explainPolicy` | Each denormalizes human-readable context into results and exposes every field a mandate needs |
| Verification | `sendVerification`, `verifyCode` | Maps the platform's challenge flow |
| Booking | `createBooking` + `performBooking` | Mandate validation, then idempotency (cache plus in-flight dedupe), then the create POST |
| Status | `getBooking` | Local record first; fails closed when platform history is gated |
| HTTP core | `requestJson`, `captureUpstreamMeta`, `warnOnLifecycleHeaders` | One fetch path: identity headers out, response metadata captured, lifecycle headers honored |
| Conformance | `runReadOnlySmoke` | Mandate-reachability, happy-path bookability, and canary shape checks against the live platform |
| Mappers and helpers | `mapService`, `extractSlots`, `formatMoney`, `stringField`, ... | Platform JSON to OSBP shapes, with null-stripping |

## Copy, adapt, or replace

**Copy these patterns mostly verbatim. They are the protocol discipline, not Openings behavior:**

- The single `requestJson` wrapper: every upstream call goes through one function that sends the `User-Agent`, captures `UpstreamMeta` (request id, `Server`, API-version echo, `Deprecation`/`Sunset`, RateLimit headers), and warns the operator once per endpoint on lifecycle headers. Do not add a second fetch path.
- `captureUpstreamMeta` (exported) and the contact-redaction of recorded paths. If your platform embeds customer identifiers in URL paths the way Openings does for history, the audit log must never see them.
- The idempotency pair in `createBooking`: a settled-result cache keyed by `idempotency_key` (payload-hashed with `verification_code` excluded) plus the in-flight reservation map that dedupes genuinely concurrent same-key calls. Both halves matter; the cache alone misses concurrent duplicates.
- The mandate-validation call before any mutation, and every fail-closed branch shape (`requires_*` problems, `handoff` routing).
- Null-stripping (`stringField`/`numberField` dropping absent values) so optional fields are omitted, never `null`.
- The smoke structure: mandate reachability, happy-path bookability, canary shape assertions. `runReadOnlySmoke` itself is typed to `OpeningsAdapter` (it calls Openings-only helpers), so replicate the three checks for your platform rather than calling it directly, and treat the specific canary fields as this fixture's expectations, not protocol requirements. The canaries are the only drift detector you have if your platform exposes no runtime version signal.

**Adapt these to your platform:**

- `platform = { vendor, api_version }`: your slug and your exact native pin. If your platform supports request-side pinning (for example Square's `Square-Version` date header), send the pin on every request from one constant; Openings has no pin, which is why none is sent here.
- The config shape and env names; add auth credentials here if your platform requires them.
- Every endpoint path and every mapper. The mappers are the bulk of the file and all Openings-specific.
- `getBooking`: if your platform has a get-appointment-by-id endpoint, call it directly. With only a phone or email, the adapter returns a problem rather than guessing, since that lookup needs a verification step a read tool cannot complete.
- Verification: if your platform has no customer-verification step, `sendVerification`/`verifyCode` return a clear `Problem` and `createBooking` never sees a 428-style retry.

**Openings quirks to study but not cargo-cult:**

- The two-tier id schemes: per-staff service copies resolve up to the salon-level `referenceId`, while per-staff schedules resolve down to the leaf. Neither rule generalizes; trace your own platform's id semantics empirically.
- `requestId` on appointment create is not used for OSBP idempotency. The general lesson is real: never infer id semantics from field names.
- Consultation-gated services fail closed before create. Generalize the lesson (services that route to an approval queue must not pretend to book) rather than the field name.

## Running it

```bash
npm run build                       # from the repo root
npm test --workspace @osbp/openings-adapter
npm run check
```

The package tests are mocked and do not require Openings credentials. The JSON Schema artifacts under [`schemas/`](../../schemas/) are the machine-checkable contract for the mandate, tool inputs, result envelope, and `Problem`; `npm run check` verifies them.
