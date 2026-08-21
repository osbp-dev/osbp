import assert from "node:assert/strict";
import { describe, it } from "node:test";
import type {
  AdapterResult,
  AvailabilityFindInput,
  Booking,
  BookingAdapter,
  BookingCreateInput,
  BookingStatusInput,
  PolicyExplainInput,
  Receipt,
  Service,
  ServiceDescribeInput,
  Slot,
  Policy,
  VerificationChallenge,
  VerificationSendInput,
  VerificationVerifyInput
} from "@osbp/core";
import { OSBP_VERSION } from "@osbp/core";
import { isAbsolute } from "node:path";
import { pathToFileURL } from "node:url";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import type { AuditLog, AuditToolCallInput } from "./audit.js";
import { createLocalOpeningsAdapter, createMcpServer, describeServer, isInvokedAsScript } from "./server.js";

describe("OSBP MCP server", () => {
  it("lists and calls registered tools over MCP", async () => {
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    const auditLog = new FakeAuditLog();
    const server = createMcpServer(new FakeAdapter(), { auditLog });
    const client = new Client({
      name: "osbp-test-client",
      version: "0.1.0"
    });

    await server.connect(serverTransport);
    await client.connect(clientTransport);

    try {
      const tools = await client.listTools();
      const toolNames = tools.tools.map((tool) => tool.name).sort();

      assert.deepEqual(toolNames, [
        "osbp_availability_find",
        "osbp_booking_create",
        "osbp_booking_status",
        "osbp_handoff_request",
        "osbp_policy_explain",
        "osbp_service_describe",
        "osbp_verification_send",
        "osbp_verification_verify"
      ].sort());

      const result = await client.callTool({
        name: "osbp_service_describe",
        arguments: {
          service_id: "service_1"
        }
      });

      assert.equal(result.isError, false);
      assert.deepEqual(result.structuredContent, {
        ok: true,
        audit_event_id: "aud_1",
        value: {
          id: "service_1",
          name: "Haircut",
          price: { amount_minor: 8000, currency: "USD" }
        }
      });
      assert.equal(auditLog.events.length, 1);
      assert.equal(auditLog.events[0]?.tool_name, "service.describe");
    } finally {
      await client.close();
      await server.close();
    }
  });

  it("reports server identity including version and build label", () => {
    const description = describeServer();
    assert.ok(
      description.startsWith(`OSBP MCP server v${OSBP_VERSION}`),
      `expected version banner, got: ${description}`
    );
    assert.match(description, /built \d{4}-\d{2}-\d{2} \d{2}:\d{2} UTC \| git:[0-9a-f]{7,}/);
  });

  it("detects direct invocation when the script path contains spaces", () => {
    // Regression: import.meta.url percent-encodes the space, process.argv[1]
    // does not, so the old `import.meta.url === ` + "`file://${argv1}`" + `
    // comparison failed and the server never started from a spaced checkout.
    const scriptPath = "/Volumes/Crucial Blue/app/dist/server.js";
    const metaUrl = pathToFileURL(scriptPath).href;
    assert.ok(metaUrl.includes("%20"), "precondition: import.meta.url encodes the space");
    assert.equal(isInvokedAsScript(metaUrl, scriptPath), true);
  });

  it("does not treat an importing module as the invoked script", () => {
    const metaUrl = pathToFileURL("/app/dist/lib.js").href;
    assert.equal(isInvokedAsScript(metaUrl, "/app/dist/server.js"), false);
    assert.equal(isInvokedAsScript(metaUrl, undefined), false);
  });

  it("wires a local Openings adapter and resolves a relative idempotency store path to absolute", () => {
    const adapter = createLocalOpeningsAdapter({
      OPENINGS_API_BASE_URL: "https://api.openings.test",
      OPENINGS_SALON_SLUG: "cedar-house-salon",
      OPENINGS_SALON_ID: "org_01jw3z8x9k2m4n6p8r0s1t3v5w",
      OPENINGS_ENABLE_CUSTOMER_FALLBACK: "true",
      OPENINGS_SEND_NOTIFICATIONS: "false",
      OPENINGS_HTTP_TIMEOUT_MS: "2500",
      OPENINGS_BEARER_TOKEN: "bearer-token",
      OPENINGS_API_VERSION: "2026-06-15",
      OSBP_IDEMPOTENCY_STORE_PATH: ".osbp/idempotency/server-test.json"
    });

    assert.equal(adapter.platform.vendor, "openings");
    const runtimeConfig = adapter.config as unknown as Record<string, unknown>;
    assert.equal(runtimeConfig.enableCustomerFallback, true);
    assert.equal(runtimeConfig.sendNotifications, false);
    assert.equal(runtimeConfig.httpTimeoutMs, 2500);
    assert.equal(runtimeConfig.bearerToken, "bearer-token");
    assert.equal(runtimeConfig.openingsVersion, "2026-06-15");
    assert.ok(adapter.config.idempotencyStorePath, "store path should be set");
    // The server resolves a relative store path against the repo root so it
    // does not depend on the host's process.cwd() (Claude Desktop spawns the
    // server without honoring the cwd field).
    assert.ok(isAbsolute(adapter.config.idempotencyStorePath ?? ""), "relative store path should resolve to absolute");
  });

  it("routes every registered tool, records adapter calls, and audits each call", async () => {
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    const auditLog = new FakeAuditLog();
    const adapter = new FakeAdapter();
    const server = createMcpServer(adapter, { auditLog });
    const client = new Client({ name: "osbp-test-client", version: "0.1.0" });

    await server.connect(serverTransport);
    await client.connect(clientTransport);

    const mandate = {
      id: "mandate_1",
      expires_at: "2030-01-01T00:00:00Z",
      allowed_actions: ["booking.create"],
      organization_id: "org_01jw3z8x9k2m4n6p8r0s1t3v5w",
      service_ids: ["service_1"],
      provider_ids: ["provider_1"],
      schedule_ids: ["schedule_1"],
      max_price: { amount_minor: 10000, currency: "USD" }
    };

    const toolCalls: Array<{
      name: string;
      arguments: Record<string, unknown>;
      audit: string;
      adapterMethod: string | null;
    }> = [
      { name: "osbp_service_describe", arguments: { service_id: "service_1" }, audit: "service.describe", adapterMethod: "describeService" },
      { name: "osbp_availability_find", arguments: { date: "2030-01-02" }, audit: "availability.find", adapterMethod: "findAvailability" },
      { name: "osbp_policy_explain", arguments: {}, audit: "policy.explain", adapterMethod: "explainPolicy" },
      { name: "osbp_verification_send", arguments: { purpose: "booking:org_01jw3z8x9k2m4n6p8r0s1t3v5w" }, audit: "verification.send", adapterMethod: "sendVerification" },
      { name: "osbp_verification_verify", arguments: { code: "123456", purpose: "booking:org_01jw3z8x9k2m4n6p8r0s1t3v5w" }, audit: "verification.verify", adapterMethod: "verifyCode" },
      {
        name: "osbp_booking_create",
        arguments: {
          mandate,
          idempotency_key: "idem_1",
          service_id: "service_1",
          schedule_id: "schedule_1",
          provider_id: "provider_1",
          date: "2030-01-02",
          time: "09:00"
        },
        audit: "booking.create",
        adapterMethod: "createBooking"
      },
      { name: "osbp_booking_status", arguments: { booking_id: "booking_1" }, audit: "booking.status", adapterMethod: "getBooking" },
      { name: "osbp_handoff_request", arguments: { reason: "needs_human", message: "Call the salon." }, audit: "handoff.request", adapterMethod: null }
    ];

    try {
      let handoffContent: unknown;
      for (const call of toolCalls) {
        const result = await client.callTool({ name: call.name, arguments: call.arguments });
        assert.equal(result.isError, false, `${call.name} returned an error`);
        assert.equal((result.structuredContent as { ok: boolean }).ok, true, `${call.name} was not ok`);
        if (call.name === "osbp_handoff_request") {
          handoffContent = result.structuredContent;
        }
      }

      // Every tool wrote exactly one audit event, in call order.
      assert.deepEqual(
        auditLog.events.map((event) => event.tool_name),
        toolCalls.map((call) => call.audit)
      );

      // Adapter-backed tools each invoked their adapter method in order; the
      // handoff.request tool answered locally and never touched the adapter.
      assert.deepEqual(
        adapter.calls.map((recorded) => recorded.method),
        toolCalls.filter((call) => call.adapterMethod).map((call) => call.adapterMethod)
      );

      // The verification.send body carries the booking purpose through unchanged.
      const sendCall = adapter.calls.find((recorded) => recorded.method === "sendVerification");
      assert.equal((sendCall?.input as { purpose?: string }).purpose, "booking:org_01jw3z8x9k2m4n6p8r0s1t3v5w");

      // handoff.request returns the structured local human-handoff value.
      const handoffValue = (handoffContent as { value: { status: string; reason: string } }).value;
      assert.equal(handoffValue.status, "requires_human");
      assert.equal(handoffValue.reason, "needs_human");
    } finally {
      await client.close();
      await server.close();
    }
  });

  it("copies adapter runtime diagnostics into the MCP structured result", async () => {
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    const server = createMcpServer(new RuntimeDiagnosticsAdapter());
    const client = new Client({ name: "osbp-test-client", version: "0.1.0" });

    await server.connect(serverTransport);
    await client.connect(clientTransport);

    try {
      const result = await client.callTool({
        name: "osbp_booking_create",
        arguments: {
          mandate: {
            id: "mandate_1",
            expires_at: "2030-01-01T00:00:00Z",
            allowed_actions: ["booking.create"],
            organization_id: "org_01jw3z8x9k2m4n6p8r0s1t3v5w",
            max_price: { amount_minor: 10000, currency: "USD" }
          },
          idempotency_key: "idem_1",
          service_id: "service_1",
          schedule_id: "schedule_1",
          provider_id: "provider_1",
          date: "2030-01-02",
          time: "09:00"
        }
      });

      assert.equal(result.isError, false);
      assert.deepEqual(result.structuredContent, {
        ok: true,
        value: {
          id: "receipt_1",
          booking_id: "booking_1",
          text: "Booked."
        },
        osbp_runtime: {
          idempotency: "local_cache_replay",
          message: "No Openings create call was made; this result was replayed from local OSBP idempotency state."
        }
      });
    } finally {
      await client.close();
      await server.close();
    }
  });

  it("turns a thrown adapter error into internal_adapter_error without leaking the raw message", async () => {
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    const auditLog = new FakeAuditLog();
    const server = createMcpServer(new ThrowingAdapter(), { auditLog });
    const client = new Client({ name: "osbp-test-client", version: "0.1.0" });

    await server.connect(serverTransport);
    await client.connect(clientTransport);

    try {
      const result = await client.callTool({
        name: "osbp_service_describe",
        arguments: { service_id: "service_1" }
      });

      assert.equal(result.isError, true);
      const structured = result.structuredContent as { ok: boolean; problem: { code: string; message: string } };
      assert.equal(structured.ok, false);
      assert.equal(structured.problem.code, "internal_adapter_error");
      assert.equal(structured.problem.message, "service.describe failed unexpectedly");

      // The raw thrown text may carry an unredacted upstream detail, so none of
      // it can appear anywhere in the response surfaced to the MCP client.
      const serialized = JSON.stringify(result);
      assert.ok(!serialized.includes("RAW_UPSTREAM_SECRET"), "raw error text leaked into the response");
      assert.ok(!serialized.includes("abc123"), "raw error token leaked into the response");

      // The failure is still audited.
      assert.equal(auditLog.events.length, 1);
      assert.equal(auditLog.events[0]?.tool_name, "service.describe");
      assert.equal((auditLog.events[0]?.result as { ok: boolean }).ok, false);
    } finally {
      await client.close();
      await server.close();
    }
  });
});

class FakeAuditLog implements AuditLog {
  events: AuditToolCallInput<unknown>[] = [];

  async record(input: AuditToolCallInput<unknown>) {
    this.events.push(input);
    return {
      id: `aud_${this.events.length}`,
      tool_name: input.tool_name,
      created_at: "2030-01-01T00:00:00.000Z"
    };
  }
}

interface RecordedCall {
  method: string;
  input: unknown;
}

class FakeAdapter implements BookingAdapter {
  readonly calls: RecordedCall[] = [];

  async describeService(input: ServiceDescribeInput): Promise<AdapterResult<Service>> {
    this.calls.push({ method: "describeService", input });
    return {
      ok: true,
      value: {
        id: "service_1",
        name: "Haircut",
        price: { amount_minor: 8000, currency: "USD" }
      }
    };
  }

  async findAvailability(input: AvailabilityFindInput): Promise<AdapterResult<Slot[]>> {
    this.calls.push({ method: "findAvailability", input });
    return {
      ok: true,
      value: []
    };
  }

  async explainPolicy(input: PolicyExplainInput): Promise<AdapterResult<Policy>> {
    this.calls.push({ method: "explainPolicy", input });
    return {
      ok: true,
      value: {
        payment_requirement: "none"
      }
    };
  }

  async sendVerification(input: VerificationSendInput): Promise<AdapterResult<VerificationChallenge>> {
    this.calls.push({ method: "sendVerification", input });
    return {
      ok: true,
      value: {
        sent: true,
        method: "sms",
        purpose: input.purpose ?? "booking:org_01jw3z8x9k2m4n6p8r0s1t3v5w"
      }
    };
  }

  async verifyCode(input: VerificationVerifyInput): Promise<AdapterResult<VerificationChallenge>> {
    this.calls.push({ method: "verifyCode", input });
    return {
      ok: true,
      value: {
        verified: true,
        method: "sms",
        purpose: input.purpose ?? "booking:org_01jw3z8x9k2m4n6p8r0s1t3v5w"
      }
    };
  }

  async createBooking(input: BookingCreateInput): Promise<AdapterResult<Receipt>> {
    this.calls.push({ method: "createBooking", input });
    return {
      ok: true,
      value: {
        id: "receipt_1",
        booking_id: "booking_1",
        text: "Booked."
      }
    };
  }

  async getBooking(input: BookingStatusInput): Promise<AdapterResult<Booking>> {
    this.calls.push({ method: "getBooking", input });
    return {
      ok: true,
      value: {
        id: "booking_1",
        status: "booked"
      }
    };
  }
}

class ThrowingAdapter extends FakeAdapter {
  override async describeService(): Promise<AdapterResult<Service>> {
    throw new Error("RAW_UPSTREAM_SECRET token=abc123");
  }
}

class RuntimeDiagnosticsAdapter extends FakeAdapter {
  override async createBooking(input: BookingCreateInput): Promise<AdapterResult<Receipt>> {
    const result = await super.createBooking(input);
    return {
      ...result,
      osbp_runtime: {
        idempotency: "local_cache_replay",
        message: "No Openings create call was made; this result was replayed from local OSBP idempotency state."
      }
    };
  }
}
