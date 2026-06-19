# @osbp/core

The portable protocol core: every OSBP domain type and the mandate validator. Adapter authors import from this package and should not need to modify it.

What lives here:

- `OSBP_VERSION` and `OSBP_TOOL_NAMES`: the protocol version string and the eight tool names.
- The domain types: `BookingMandate`, `Service`, `Slot`, `Policy`, `Booking`, `Customer`, `VerificationChallenge`, `Receipt`, `Problem`, `AuditEvent`, and the tool input shapes. Field semantics, optionality, and formats are documented inline and normatively in [schema.md](../../docs/spec/v0.1.0/schema.md).
- `PlatformIdentity` and `UpstreamMeta`: the adapter observability shapes recorded into audit events.
- `BookingAdapter`: the seven-method interface an adapter implements, plus the optional `platform` and `upstreamMeta` members.
- `validateMandate` (`mandate.ts`): the server-side scope check that runs before every mutation. Canonical policy lives here, not in adapters; an adapter must not relax it.

The one discipline to internalize before touching any time-bearing field: wall-clock strings (no offset, interpreted in the merchant's IANA timezone) and absolute instants (RFC 3339 with offset) are separate categories, every field belongs to exactly one, and the validator rejects values that cross categories. The doc comments on each field declare its category; see [Time Discipline](../../docs/spec/v0.1.0/README.md#time-discipline) for why.

```bash
npm test --workspace=packages/osbp-core
```
