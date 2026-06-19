#!/usr/bin/env node
import { buildLabel, type BookingAdapter } from "@osbp/core";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";
import {
  createSyntheticBookingAdapter,
  runConformance,
  type ConformanceCheck,
  type ConformanceOptions,
  type ConformanceReport,
  type ConformanceScenarioMode
} from "./index.js";

interface CliArgs {
  json: boolean;
  help: boolean;
  target?: string;
}

async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2));
  if (args.help) {
    printUsage();
    return;
  }
  const target = args.target ? await loadTarget(args.target) : {
    adapter: createSyntheticBookingAdapter(),
    options: {}
  };
  const report = await runConformance(target.adapter, target.options);

  if (args.json) {
    console.log(JSON.stringify(report, null, 2));
  } else {
    printHumanReport(report, args.target);
  }

  process.exitCode = report.passed ? 0 : 1;
}

function parseArgs(args: string[]): CliArgs {
  const parsed: CliArgs = { json: false, help: false };
  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index];
    if (arg === "--json") {
      parsed.json = true;
    } else if (arg === "--target") {
      const value = args[index + 1];
      if (!value) {
        throw new Error("--target requires a module path");
      }
      parsed.target = value;
      index += 1;
    } else if (arg === "--help" || arg === "-h") {
      parsed.help = true;
      return parsed;
    } else {
      throw new Error(`Unknown argument ${arg}`);
    }
  }
  return parsed;
}

function printUsage(): void {
  const label = buildLabel(import.meta.url);
  console.log(`osbp-conformance${label ? ` | ${label}` : ""}`);
  console.log("Usage: osbp-conformance [--json] [--target ./adapter-module.js]");
}

async function loadTarget(targetPath: string): Promise<{ adapter: BookingAdapter; options: ConformanceOptions }> {
  const moduleUrl = pathToFileURL(resolve(targetPath)).href;
  const target = await import(moduleUrl) as Record<string, unknown>;
  const adapter = await resolveAdapter(target);
  const options: ConformanceOptions = {};

  if (isRecord(target.conformanceFixtures)) {
    options.fixtures = target.conformanceFixtures;
  }

  const scenarioFactory = target.createConformanceAdapter ?? target.createScenarioAdapter;
  if (typeof scenarioFactory === "function") {
    options.create_scenario_adapter = (mode: ConformanceScenarioMode) => {
      const result = scenarioFactory(mode);
      return result as BookingAdapter | Promise<BookingAdapter>;
    };
  }

  return { adapter, options };
}

async function resolveAdapter(target: Record<string, unknown>): Promise<BookingAdapter> {
  const candidates = [
    target.adapter,
    target.default,
    target.createAdapter,
    target.createBookingAdapter
  ];

  for (const candidate of candidates) {
    const value = typeof candidate === "function" ? await candidate() : candidate;
    if (isBookingAdapter(value)) {
      return value;
    }
  }

  throw new Error("Target module must export a BookingAdapter, createAdapter(), or default adapter");
}

function printHumanReport(report: ConformanceReport, targetPath: string | undefined): void {
  const label = buildLabel(import.meta.url);
  const title = targetPath ? `OSBP conformance report for ${targetPath}` : "OSBP conformance report for synthetic reference target";
  console.log(label ? `${title} | ${label}` : title);
  console.log("");
  for (const check of report.checks) {
    console.log(`${statusLabel(check)} ${check.id}`);
    console.log(`  ${check.requirement}`);
    console.log(`  ${check.spec_ref}`);
    if (check.detail) {
      console.log(`  ${check.detail}`);
    }
  }
  console.log("");
  console.log(
    `${report.passed ? "PASS" : "FAIL"} ${report.summary.passed}/${report.summary.total} checks passed` +
      ` (${report.summary.failed} failed, ${report.summary.skipped} skipped)`
  );
}

function statusLabel(check: ConformanceCheck): string {
  if (check.status === "pass") {
    return "PASS";
  }
  if (check.status === "skip") {
    return "SKIP";
  }
  return "FAIL";
}

function isBookingAdapter(value: unknown): value is BookingAdapter {
  if (!isRecord(value)) {
    return false;
  }
  return [
    "describeService",
    "findAvailability",
    "explainPolicy",
    "sendVerification",
    "verifyCode",
    "createBooking",
    "getBooking"
  ].every((method) => typeof value[method] === "function");
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

main().catch((error: unknown) => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
});
