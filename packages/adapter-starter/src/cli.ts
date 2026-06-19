#!/usr/bin/env node
import { buildLabel } from "@osbp/core";
import { runConformance, type ConformanceReport } from "@osbp/conformance";
import { adapter, conformanceFixtures } from "./conformance-target.js";

interface CliArgs {
  conformance: boolean;
  json: boolean;
  help: boolean;
}

async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2));
  if (args.help) {
    printUsage();
    return;
  }
  if (!args.conformance) {
    printUsage();
    process.exitCode = 1;
    return;
  }

  const report = await runConformance(adapter, { fixtures: conformanceFixtures });
  if (args.json) {
    console.log(JSON.stringify(report, null, 2));
  } else {
    printChecklist(report);
  }
  process.exitCode = report.passed ? 0 : 1;
}

function parseArgs(args: string[]): CliArgs {
  const parsed: CliArgs = { conformance: false, json: false, help: false };
  for (const arg of args) {
    if (arg === "--conformance") {
      parsed.conformance = true;
    } else if (arg === "--json") {
      parsed.json = true;
    } else if (arg === "--help" || arg === "-h") {
      parsed.help = true;
    } else {
      throw new Error(`Unknown argument ${arg}`);
    }
  }
  return parsed;
}

function printUsage(): void {
  const label = buildLabel(import.meta.url);
  console.log(`osbp-adapter-starter${label ? ` | ${label}` : ""}`);
  console.log("Usage: osbp-adapter-starter --conformance [--json]");
}

function printChecklist(report: ConformanceReport): void {
  console.log("OSBP adapter starter conformance checklist");
  console.log("");
  for (const check of report.checks) {
    if (check.status === "fail") {
      console.log(`- [ ] ${check.id}`);
      console.log(`  ${check.requirement}`);
      if (check.detail) {
        console.log(`  ${check.detail}`);
      }
    }
  }
  console.log("");
  console.log(
    `${report.passed ? "PASS" : "FAIL"} ${report.summary.passed}/${report.summary.total} checks passed` +
      ` (${report.summary.failed} failed, ${report.summary.skipped} skipped)`
  );
}

main().catch((error: unknown) => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
});
