#!/usr/bin/env node
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import vm from "node:vm";
import ts from "typescript";

// Acquire one zod v4 instance via CJS and reuse it for BOTH building the tool
// schemas inside the vm and converting them here. Zod v4 keeps .describe() text
// in a per-instance global registry, so a builder and converter from different
// module instances (ESM import vs vm require) would silently drop descriptions.
const require = createRequire(import.meta.url);
const zodModule = require("zod/v4");
const { z } = zodModule;

const ROOT = dirname(dirname(fileURLToPath(import.meta.url)));
const TOOLS_PATH = join(ROOT, "packages/osbp-mcp-server/src/tools.ts");
const SCHEMA_DIR = join(ROOT, "schemas/v0.1.0");
const DRAFT_2020_12 = "https://json-schema.org/draft/2020-12/schema";
const writeMode = process.argv.includes("--write");

const artifactPaths = {
  bookingMandate: join(SCHEMA_DIR, "booking-mandate.schema.json"),
  toolInputs: join(SCHEMA_DIR, "tool-inputs.schema.json"),
  problem: join(SCHEMA_DIR, "problem.schema.json"),
  resultEnvelope: join(SCHEMA_DIR, "result-envelope.schema.json")
};

const tools = loadToolSchemas();
const expectedArtifacts = {
  [artifactPaths.bookingMandate]: withMetadata(
    z.toJSONSchema(tools.byName.get("osbp_booking_create").inputSchema.mandate),
    "https://osbp.dev/schemas/v0.1.0/booking-mandate.schema.json",
    "OSBP v0.1.0 BookingMandate"
  ),
  [artifactPaths.toolInputs]: toolInputsArtifact(tools.inOrder),
  [artifactPaths.problem]: problemArtifact(tools.moduleExports),
  [artifactPaths.resultEnvelope]: resultEnvelopeArtifact(tools.moduleExports)
};

let mismatches = 0;

for (const [path, expected] of Object.entries(expectedArtifacts)) {
  const expectedText = `${JSON.stringify(expected, null, 2)}\n`;

  if (writeMode) {
    mkdirSync(SCHEMA_DIR, { recursive: true });
    writeFileSync(path, expectedText);
    continue;
  }

  let actualText;
  try {
    actualText = readFileSync(path, "utf8");
  } catch (error) {
    mismatches += 1;
    console.error(`Missing JSON Schema artifact: ${path}`);
    continue;
  }

  if (actualText !== expectedText) {
    mismatches += 1;
    console.error(`Outdated JSON Schema artifact: ${path}`);
  }
}

if (writeMode) {
  console.log("Wrote JSON Schema artifacts.");
} else if (mismatches > 0) {
  console.error("Run `node scripts/check-json-schema-artifacts.mjs --write` and review the generated diff.");
  process.exit(1);
} else {
  console.log("JSON Schema artifacts match the Zod tool schemas.");
}

function loadToolSchemas() {
  const source = readFileSync(TOOLS_PATH, "utf8");
  const transpiled = ts.transpileModule(source, {
    compilerOptions: {
      module: ts.ModuleKind.CommonJS,
      target: ts.ScriptTarget.ES2022,
      esModuleInterop: true
    },
    fileName: TOOLS_PATH
  });
  const module = { exports: {} };
  const context = {
    console,
    exports: module.exports,
    module,
    process,
    require: (id) => (id === "zod/v4" || id === "zod" ? zodModule : require(id))
  };

  vm.runInNewContext(transpiled.outputText, context, { filename: TOOLS_PATH });

  const registeredTools = [];
  const fakeServer = {
    registerTool(name, config) {
      registeredTools.push({
        name,
        inputSchema: config.inputSchema
      });
    }
  };
  const fakeAdapter = {};

  module.exports.registerOsbpTools(fakeServer, fakeAdapter);

  return {
    inOrder: registeredTools,
    byName: new Map(registeredTools.map((tool) => [tool.name, tool])),
    moduleExports: module.exports
  };
}

function toolInputsArtifact(registeredTools) {
  const defs = {};

  for (const tool of registeredTools) {
    const schema = z.toJSONSchema(z.object(tool.inputSchema));
    delete schema.$schema;
    defs[tool.name] = schema;
  }

  return {
    $schema: DRAFT_2020_12,
    $id: "https://osbp.dev/schemas/v0.1.0/tool-inputs.schema.json",
    title: "OSBP v0.1.0 MCP Tool Inputs",
    $defs: defs
  };
}

function problemArtifact(moduleExports) {
  const sampleProblem = moduleExports.problem("schema_check", "Schema check").problem;
  assertRecordShape(sampleProblem, ["code", "message", "retryable"], "problem()");
  assertType(sampleProblem.code, "string", "problem().problem.code");
  assertType(sampleProblem.message, "string", "problem().problem.message");
  assertType(sampleProblem.retryable, "boolean", "problem().problem.retryable");

  return {
    $schema: DRAFT_2020_12,
    $id: "https://osbp.dev/schemas/v0.1.0/problem.schema.json",
    title: "OSBP v0.1.0 Problem",
    type: "object",
    properties: {
      code: { type: "string" },
      message: { type: "string" },
      retryable: { type: "boolean" }
    },
    required: ["code", "message"],
    additionalProperties: false
  };
}

function resultEnvelopeArtifact(moduleExports) {
  const auditEvent = {
    id: "audit_schema_check",
    tool_name: "service.describe",
    created_at: "2030-01-01T00:00:00.000Z"
  };
  const success = moduleExports.toToolResult({ ok: true, value: { id: "value" } }, auditEvent).structuredContent;
  const failure = moduleExports.toToolResult(moduleExports.problem("schema_check", "Schema check"), auditEvent).structuredContent;
  const successWithoutAudit = moduleExports.toToolResult({ ok: true, value: { id: "value" } }).structuredContent;
  const successWithRuntime = moduleExports.toToolResult({
    ok: true,
    value: { id: "value" },
    osbp_runtime: {
      idempotency: "local_cache_replay",
      message: "No platform create call was made; this result was replayed from local OSBP idempotency state."
    }
  }).structuredContent;

  assertRecordShape(success, ["ok", "value", "audit_event_id"], "toToolResult success");
  assertRecordShape(failure, ["ok", "problem", "audit_event_id"], "toToolResult failure");
  assertRecordShape(successWithoutAudit, ["ok", "value"], "toToolResult success without audit");
  assertRecordShape(successWithRuntime, ["ok", "value", "osbp_runtime"], "toToolResult success with runtime diagnostics");

  return {
    $schema: DRAFT_2020_12,
    $id: "https://osbp.dev/schemas/v0.1.0/result-envelope.schema.json",
    title: "OSBP v0.1.0 Result Envelope",
    oneOf: [
      {
        type: "object",
        properties: {
          ok: { const: true },
          value: true,
          osbp_runtime: runtimeDiagnosticsSchema(),
          audit_event_id: { type: "string" }
        },
        required: ["ok", "value"],
        additionalProperties: false
      },
      {
        type: "object",
        properties: {
          ok: { const: false },
          problem: { $ref: "problem.schema.json" },
          osbp_runtime: runtimeDiagnosticsSchema(),
          audit_event_id: { type: "string" }
        },
        required: ["ok", "problem"],
        additionalProperties: false
      }
    ]
  };
}

function runtimeDiagnosticsSchema() {
  return {
    type: "object",
    properties: {
      idempotency: { enum: ["local_cache_replay"] },
      message: { type: "string" }
    },
    additionalProperties: false
  };
}

function withMetadata(schema, id, title) {
  return {
    $schema: schema.$schema ?? DRAFT_2020_12,
    $id: id,
    title,
    ...withoutKey(schema, "$schema")
  };
}

function withoutKey(object, key) {
  const copy = { ...object };
  delete copy[key];
  return copy;
}

function assertRecordShape(record, expectedKeys, label) {
  const actualKeys = Object.keys(record).sort();
  const sortedExpectedKeys = [...expectedKeys].sort();

  if (JSON.stringify(actualKeys) !== JSON.stringify(sortedExpectedKeys)) {
    throw new Error(`${label} shape changed: expected keys ${sortedExpectedKeys.join(", ")}, got ${actualKeys.join(", ")}`);
  }
}

function assertType(value, type, label) {
  if (typeof value !== type) {
    throw new Error(`${label} should be ${type}, got ${typeof value}`);
  }
}
