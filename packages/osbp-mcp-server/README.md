# @osbp/mcp-server

The local MCP transport host for the v0.1.0 proof: the reusable module can wrap any `BookingAdapter`, while the shipped `server.ts` entrypoint wires the local Openings adapter and exposes the eight OSBP tools over stdio with a redacted JSONL audit log. Protocol behavior lives in `@osbp/core` and the adapter; this package carries transport, tool registration, the audit wrapper, and the local proof wiring.

What lives here:

- `createMcpServer(adapter, { auditLog })`: builds the MCP server around any adapter, deriving the server name from `adapter.platform.vendor`. This is the seam for hosting a different platform: construct your own adapter and pass it here. Wiring a new adapter package also means adding it to the root `package.json` build/check scripts and `tsconfig.json` references, and giving it its own config env names and idempotency store path so two adapters never share one store.
- `registerOsbpTools(server, adapter, options)` (`tools.ts`): registers the eight tools, validates inputs with Zod (the same schemas the published JSON Schema artifacts are derived from), and wraps every call in audit recording. The audit wrapper snapshots the adapter's `upstreamMeta` around each call so an event only records metadata that call produced.
- `audit.ts`: `JsonlAuditLog` appends one redacted event per tool call to `.osbp/audit/events.jsonl` (override with `OSBP_AUDIT_LOG_PATH`). Customer contact fields, verification codes, and approval tokens are redacted before writing; `platform` and `upstream` provenance ride along when the adapter provides them.
- `server.ts`: the v0.1.0 stdio entrypoint and the `--smoke-read` flag, currently wired to the local Openings adapter. It runs the read-only smoke and prints platform, upstream metadata, and configured-business counts.

Two operational rules worth knowing before editing:

- Paths resolve against the binary's own location, not `process.cwd()`, because MCP hosts spawn the server without honoring `cwd`. Verify any path change with `cd / && node packages/osbp-mcp-server/dist/server.js --smoke-read`.
- stdout is the MCP transport channel. Anything human-facing (startup banners, lifecycle warnings) goes to stderr.

```bash
npm run build
node packages/osbp-mcp-server/dist/server.js --smoke-read   # read-only conformance
node packages/osbp-mcp-server/dist/server.js                # stdio server for an MCP host
```

Host configuration for Claude Desktop is worked through in [getting-started.md](../../integrations/v0.1.0/openings/getting-started.md).
