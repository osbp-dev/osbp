import { spawnSync } from "node:child_process";
import { REFERENCE_ORGANIZATIONS, SyntheticBookingAdapter, runReadOnlySmoke, startSyntheticBookingServer } from "./index.js";
import { GUM_BLOCK_SEPARATOR, demoVerticalIds, renderReferenceDemo } from "./demo.js";

const args = process.argv.slice(2);

if (args.includes("--smoke")) {
  const server = await startSyntheticBookingServer();
  try {
    for (const organization of REFERENCE_ORGANIZATIONS) {
      const adapter = new SyntheticBookingAdapter({
        apiBaseUrl: server.url,
        organizationId: organization.id
      });
      const result = await runReadOnlySmoke(adapter);
      if (!result.ok) {
        console.error(`${organization.id}: ${result.problem.code}: ${result.problem.message}`);
        process.exitCode = 1;
        continue;
      }
      console.log(
        `${organization.id}: ${result.value.services.length} services, ` +
        `${result.value.locations.length} location(s), ${result.value.slots.length} smoke slot(s)`
      );
    }
  } finally {
    await server.close();
  }
} else if (args.includes("--demo")) {
  try {
    const output = await renderReferenceDemo({
      now: parseNow(args),
      launch: args.includes("--launch"),
      tape: args.includes("--tape"),
      gum: args.includes("--gum"),
      vertical: stringFlag(args, "--vertical"),
      color: Boolean(process.stdout.isTTY) && !process.env.NO_COLOR
    });
    const cardMs = numberFlag(args, "--card-ms");
    if (args.includes("--gum")) {
      await writeGumCards(output, cardMs ?? 0, numberFlag(args, "--type-ms") ?? 0);
    } else if (cardMs !== undefined) {
      await writeCards(output, cardMs, numberFlag(args, "--type-ms") ?? 0);
    } else {
      await writeOutput(output, numberFlag(args, "--pace-ms") ?? 0);
    }
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  }
} else {
  console.log([
    "Usage:",
    "  node dist/cli.js --smoke",
    "  node dist/cli.js --demo [--now 2026-07-01T09:00:00Z] [--vertical <id>] [--launch] [--tape] [--gum] [--pace-ms 550] [--card-ms 1750] [--type-ms 35]",
    `Verticals: ${demoVerticalIds().join(", ")}`
  ].join("\n"));
}

function parseNow(args: string[]): Date | undefined {
  const value = stringFlag(args, "--now");
  if (!value) {
    return undefined;
  }
  const parsed = new Date(value);
  if (!Number.isFinite(parsed.getTime())) {
    throw new Error(`Invalid --now value ${JSON.stringify(value)}`);
  }
  return parsed;
}

function stringFlag(args: string[], name: string): string | undefined {
  const index = args.indexOf(name);
  if (index === -1) {
    return undefined;
  }
  const value = args[index + 1];
  if (!value || value.startsWith("--")) {
    throw new Error(`${name} requires a value`);
  }
  return value;
}

function numberFlag(args: string[], name: string): number | undefined {
  const value = stringFlag(args, name);
  if (value === undefined) {
    return undefined;
  }
  const parsed = Number(value);
  if (!Number.isFinite(parsed) || parsed < 0) {
    throw new Error(`${name} must be a non-negative number`);
  }
  return parsed;
}

async function writeOutput(output: string, paceMs: number): Promise<void> {
  if (paceMs === 0) {
    process.stdout.write(output);
    return;
  }

  const lines = output.split("\n");
  for (const line of lines) {
    process.stdout.write(`${line}\n`);
    await sleep(paceMs);
  }
}

async function writeCards(output: string, cardMs: number, typeMs: number): Promise<void> {
  const cards = output.split("\f");
  for (const card of cards) {
    for (const line of card.trimEnd().split("\n")) {
      if (typeMs > 0 && stripAnsi(line).startsWith("osbp ")) {
        await writeTypedLine(line, typeMs);
      } else {
        process.stdout.write(`${line}\n`);
        await sleep(12);
      }
    }
    process.stdout.write("\n");
    await sleep(cardMs);
  }
}

async function writeTypedLine(line: string, typeMs: number): Promise<void> {
  for (const character of line) {
    process.stdout.write(character);
    await sleep(typeMs);
  }
  process.stdout.write("\n");
}

async function writeGumCards(output: string, cardMs: number, typeMs: number): Promise<void> {
  const textTypeMs = gumTranscriptTypeMs(typeMs);
  for (const card of output.split("\f")) {
    for (const block of card.split(GUM_BLOCK_SEPARATOR)) {
      const [role, ...lines] = block.trimEnd().split("\n");
      if (!role) {
        continue;
      }
      if (role === "OPENING") {
        await writeOpeningScreen(lines);
        process.stdout.write("\n\n");
      } else if (role === "PAUSE") {
        await sleep(parsePauseDuration(lines[0] ?? "0ms"));
      } else if (role === "OUTBOUND") {
        for (const line of lines) {
          if (isJsonLikeLine(line)) {
            await writeMaybeTypedJsonLine(line, textTypeMs);
          } else {
            await writeMaybeTypedStyledLine(`> ${line}`, ansiForRole(role), textTypeMs);
          }
        }
        process.stdout.write("\n");
      } else {
        await writeGumBlock(role, lines, textTypeMs);
        process.stdout.write("\n");
      }
    }
    await sleep(cardMs);
  }
}

async function writeOpeningScreen(lines: string[]): Promise<void> {
  const width = process.stdout.columns || 72;
  const rows = process.stdout.rows || 22;
  const topPadding = Math.max(2, Math.floor((rows - lines.length) / 2) - 1);
  process.stdout.write("\n".repeat(topPadding));
  for (const line of lines) {
    const styled = styleOpeningLine(line);
    const leftPadding = Math.max(0, Math.floor((width - stripAnsi(styled).length) / 2));
    process.stdout.write(`${" ".repeat(leftPadding)}${styled}\n`);
  }
  await sleep(1400);
}

function styleOpeningLine(line: string): string {
  if (line.startsWith("OSBP ")) {
    return `\x1b[1;96m${line}\x1b[0m`;
  }
  if (line.startsWith("max price ")) {
    return `\x1b[92m${line}\x1b[0m`;
  }
  const separator = line.indexOf(":");
  if (separator === -1) {
    return `\x1b[1;97m${line}\x1b[0m`;
  }
  const label = line.slice(0, separator + 1);
  const value = line.slice(separator + 1);
  return `\x1b[1;97m${label}\x1b[0m\x1b[92m${value}\x1b[0m`;
}

async function writeGumBlock(role: string, lines: string[], typeMs: number): Promise<void> {
  let textLines: string[] = [];
  const flushTextLines = async (): Promise<void> => {
    if (textLines.length === 0) {
      return;
    }
    await writeStyledGumText(role, textLines, typeMs);
    textLines = [];
  };
  for (const line of lines) {
    if (isJsonLikeLine(line)) {
      await flushTextLines();
      await writeMaybeTypedJsonLine(line, typeMs);
    } else {
      textLines.push(line);
    }
  }
  await flushTextLines();
}

async function writeStyledGumText(role: string, lines: string[], typeMs: number): Promise<void> {
  const input = formatGumLines(role, lines).join("\n");
  const result = spawnSync(gumBinary(), ["style", ...gumStyleArgs(role)], {
    input,
    encoding: "utf8",
    env: gumEnv()
  });
  if (result.error) {
    throw new Error(`gum is required for --gum: ${result.error.message}`);
  }
  if (result.status !== 0) {
    throw new Error(result.stderr || `gum style exited with status ${result.status}`);
  }
  if (typeMs > 0) {
    await writeTypedAnsiText(result.stdout, typeMs);
  } else {
    process.stdout.write(result.stdout);
  }
  if (!result.stdout.endsWith("\n")) {
    process.stdout.write("\n");
  }
}

function formatGumLines(role: string, lines: string[]): string[] {
  const marker = role === "INBOUND" ? "<" : "#";
  return lines.map((line) => `${marker} ${line}`);
}

function gumStyleArgs(role: string): string[] {
  const styles: Record<string, { foreground: string; bold: boolean }> = {
    "COMMENT": { foreground: "240", bold: false },
    "STATE": { foreground: "15", bold: true },
    "OUTBOUND": { foreground: "39", bold: true },
    "INBOUND": { foreground: "42", bold: true },
    "REJECT": { foreground: "203", bold: true }
  };
  const style = styles[role] ?? { foreground: "15", bold: false };
  const args = [
    "--foreground",
    style.foreground
  ];
  if (style.bold) {
    args.push("--bold");
  }
  return args;
}

function writeStyledLine(line: string, ansiCode: string): void {
  process.stdout.write(`${ansiCode}${line}\x1b[0m\n`);
}

async function writeMaybeTypedStyledLine(line: string, ansiCode: string, typeMs: number): Promise<void> {
  if (typeMs > 0) {
    await writeTypedStyledLine(line, typeMs, ansiCode);
    return;
  }
  writeStyledLine(line, ansiCode);
  await sleep(12);
}

async function writeTypedStyledLine(line: string, typeMs: number, ansiCode: string): Promise<void> {
  process.stdout.write(ansiCode);
  for (const character of line) {
    process.stdout.write(character);
    await sleep(typeMs);
  }
  process.stdout.write("\x1b[0m\n");
}

async function writeTypedAnsiText(text: string, typeMs: number): Promise<void> {
  for (let index = 0; index < text.length; index += 1) {
    if (text[index] === "\x1b") {
      const end = text.indexOf("m", index);
      if (end !== -1) {
        process.stdout.write(text.slice(index, end + 1));
        index = end;
        continue;
      }
    }
    process.stdout.write(text[index]);
    if (text[index] !== "\n") {
      await sleep(typeMs);
    }
  }
}

function gumTranscriptTypeMs(typeMs: number): number {
  if (typeMs <= 0) {
    return 0;
  }
  return Math.max(3, Math.round(typeMs / 9));
}

function parsePauseDuration(value: string): number {
  const trimmed = value.trim();
  const match = /^(\d+(?:\.\d+)?)(ms|s)$/.exec(trimmed);
  if (!match) {
    throw new Error(`Invalid pause duration ${JSON.stringify(value)}; use values like 500ms or 1s`);
  }
  const amount = Number(match[1]);
  return match[2] === "s" ? amount * 1000 : amount;
}

function ansiForRole(role: string): string {
  if (role === "OUTBOUND") {
    return "\x1b[1;94m";
  }
  return "\x1b[0m";
}

function isJsonLikeLine(line: string): boolean {
  const trimmed = line.trimStart();
  return (
    trimmed.startsWith("{") ||
    trimmed.startsWith("}") ||
    trimmed.startsWith("[") ||
    trimmed.startsWith("]") ||
    trimmed.startsWith("\"")
  );
}

function writeJsonLine(line: string): void {
  process.stdout.write(`${colorJsonLine(line)}\n`);
}

async function writeMaybeTypedJsonLine(line: string, typeMs: number): Promise<void> {
  if (typeMs > 0) {
    await writeTypedAnsiText(`${colorJsonLine(line)}\n`, typeMs);
    return;
  }
  writeJsonLine(line);
  await sleep(12);
}

function colorJsonLine(line: string): string {
  return line.replace(
    /("(?:\\.|[^"\\])*")(\s*:)?|-?\d+(?:\.\d+)?(?:[eE][+-]?\d+)?|\b(?:true|false|null)\b|[{}\[\],:]/g,
    (token, stringToken: string | undefined, keyColon: string | undefined) => {
      if (stringToken) {
        if (keyColon) {
          return `\x1b[36m${stringToken}\x1b[2m${keyColon}\x1b[0m`;
        }
        return `\x1b[32m${stringToken}\x1b[0m`;
      }
      if (token === "true" || token === "false") {
        return `\x1b[33m${token}\x1b[0m`;
      }
      if (token === "null") {
        return `\x1b[2m${token}\x1b[0m`;
      }
      if (/^-?\d/.test(token)) {
        return `\x1b[35m${token}\x1b[0m`;
      }
      return `\x1b[2m${token}\x1b[0m`;
    }
  );
}

function gumBinary(): string {
  return process.env.OSBP_GUM_BIN || "gum";
}

function gumEnv(): NodeJS.ProcessEnv {
  const env = { ...process.env };
  delete env.NO_COLOR;
  env.TERM = env.TERM && env.TERM !== "dumb" ? env.TERM : "xterm-256color";
  env.CLICOLOR_FORCE = "1";
  env.FORCE_COLOR = "1";
  return env;
}

function stripAnsi(value: string): string {
  return value.replace(/\x1b\[[0-9;]*m/g, "");
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
