import { OSBP_VERSION, buildLabel, type BookingAdapter } from "@osbp/core";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { resolve, dirname, isAbsolute } from "node:path";
import { fileURLToPath } from "node:url";
import { loadOpeningsConfigFromEnv, loadOsbpEnv, OpeningsAdapter, runReadOnlySmoke } from "@osbp/openings-adapter";
import { defaultAuditLogPath, JsonlAuditLog, type AuditLog } from "./audit.js";
import { registerOsbpTools } from "./tools.js";

// Repo root derived from this file's location at <repo>/packages/osbp-mcp-server/dist/server.js.
// Works regardless of the host's process.cwd() — important because Claude Desktop spawns
// the server without reliably honoring the `cwd` field in mcpServers config.
const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..", "..", "..");

export function createLocalOpeningsAdapter(env: Record<string, string | undefined>): OpeningsAdapter {
  const config = loadOpeningsConfigFromEnv({ ...loadOsbpEnv(REPO_ROOT), ...env });
  // Resolve a relative OSBP_IDEMPOTENCY_STORE_PATH against REPO_ROOT so the
  // cache file lives at <repo>/.osbp/idempotency/... regardless of process.cwd().
  // Same reason as the audit log path: Claude Desktop spawns the server without
  // reliably honoring the cwd field in mcpServers config, so resolving against
  // process.cwd() ends up writing to /.osbp/idempotency/, which fails ENOENT.
  if (config.idempotencyStorePath && !isAbsolute(config.idempotencyStorePath)) {
    config.idempotencyStorePath = resolve(REPO_ROOT, config.idempotencyStorePath);
  }
  return new OpeningsAdapter(config);
}

// Emitted to stderr before the MCP transport connects, so it appears in Claude Desktop's
// MCP logs, Crush debug output, and the --smoke-read smoke test.
//
// Format: "OSBP MCP server v{ver} | built {YYYY-MM-DD HH:MM} UTC | git:{hash}"
//
// Debugging:
//   "built ..."  — mtime of the compiled dist/server.js. If stale, run `npm run build`.
//   "git:..."    — HEAD commit at build time. Compare with `git rev-parse --short HEAD`.
//                  A mismatch means the binary was built from a different commit.
export function describeServer(): string {
  const label = buildLabel(import.meta.url);
  return label ? `OSBP MCP server v${OSBP_VERSION} | ${label}` : `OSBP MCP server v${OSBP_VERSION}`;
}

// True when this module is the process entry point (run as `node server.js`)
// rather than imported. Node sets process.argv[1] to the invoked path with
// literal spaces, while import.meta.url percent-encodes them, so the naive
// `import.meta.url === ` + "`file://${argv1}`" + ` comparison silently fails for
// any checkout under a path containing a space and the server never starts.
// Compare decoded, resolved filesystem paths instead.
export function isInvokedAsScript(
  metaUrl: string,
  argv1: string | undefined = process.argv[1]
): boolean {
  return argv1 !== undefined && fileURLToPath(metaUrl) === resolve(argv1);
}

export interface CreateMcpServerOptions {
  auditLog?: AuditLog;
}

export function createMcpServer(adapter: BookingAdapter, options: CreateMcpServerOptions = {}): McpServer {
  // Derive the MCP server identity from the adapter's platform so a host that
  // wraps a different adapter announces itself correctly with no edit here.
  const vendor = adapter.platform?.vendor ?? "adapter";
  const server = new McpServer({
    name: `osbp-${vendor}`,
    title: `OSBP booking server (${vendor})`,
    version: OSBP_VERSION
  });

  registerOsbpTools(server, adapter, {
    auditLog: options.auditLog
  });
  return server;
}

export async function runStdioServer(
  env: Record<string, string | undefined> = process.env,
  adapter: OpeningsAdapter = createLocalOpeningsAdapter(env)
): Promise<void> {
  const server = createMcpServer(adapter, {
    auditLog: new JsonlAuditLog(defaultAuditLogPath(env, REPO_ROOT))
  });
  const transport = new StdioServerTransport();
  await server.connect(transport);
}

if (isInvokedAsScript(import.meta.url)) {
  const adapter = createLocalOpeningsAdapter(process.env);
  const config = adapter.config;

  if (process.argv.includes("--smoke-read")) {
    const result = await runReadOnlySmoke(adapter);
    if (!result.ok) {
      console.error(`${result.problem.code}: ${result.problem.message}`);
      process.exitCode = 1;
    } else {
      console.log(describeServer());
      console.log(`Platform: ${adapter.platform.vendor} (${adapter.platform.api_version})`);
      const upstream = adapter.upstreamMeta;
      console.log(`Upstream infra (Server header): ${upstream?.server ?? "unknown"}`);
      console.log(`Upstream request id: ${upstream?.request_id ?? "none"}`);
      if (upstream?.api_version) {
        console.log(`Upstream API version: ${upstream.api_version}`);
      }
      if (upstream?.ratelimit) {
        console.log(`Upstream ratelimit: ${JSON.stringify(upstream.ratelimit)}`);
      }
      if (upstream?.deprecation || upstream?.sunset) {
        console.log(`Upstream lifecycle: deprecation=${upstream.deprecation ?? "none"} sunset=${upstream.sunset ?? "none"}`);
      }
      console.log(`Organization: ${result.value.organization.name ?? result.value.organization.slug ?? result.value.organization.id}`);
      console.log(`Locations: ${result.value.locations.length}`);
      console.log(`Services: ${result.value.services.length}`);
      console.log(`Payment requirement: ${result.value.policy.payment_requirement ?? "unknown"}`);
      console.log(`Slots on ${result.value.availabilityDate}: ${result.value.slots.length}`);
    }
  } else {
    console.error(describeServer());
    console.error(`Platform: ${adapter.platform.vendor} ${adapter.platform.api_version}`);
    await runStdioServer(process.env, adapter);
  }
}
