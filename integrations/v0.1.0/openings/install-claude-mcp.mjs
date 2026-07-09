#!/usr/bin/env node
// SPDX-License-Identifier: Apache-2.0
//
// Small, dependency-free Claude Desktop MCP config installer.
//
// Maintainer quick edit guide:
// - Change MCP_SERVER below to reuse this script for another local MCP server.
// - Keep the installer generic code below MCP_SERVER boring: read JSON, show the
//   before/after MCP entry, ask before writing, optionally create a backup, and
//   preserve every unrelated Claude setting and MCP server.
// - The script edits Claude's config file, not OSBP code or package metadata.

import { copyFileSync, existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { execFileSync } from "node:child_process";
import { createInterface } from "node:readline/promises";
import { stdin as input, stdout as output } from "node:process";
import { fileURLToPath } from "node:url";

process.on("uncaughtException", (error) => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exit(1);
});

const SCRIPT_NAME = "Andy's really simple \"Add this local MCP to Claude\" script, v1.0";
const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "../../..");
const serverPath = resolve(repoRoot, "packages/osbp-mcp-server/dist/server.js");

// This is the only OSBP-specific block.
//
// To adapt the script for another repo/server, change:
// - name: the stable host-visible MCP key in Claude's config. Keep it
//   unversioned so upgrades repair the same entry instead of adding new ones.
// - legacyNamePattern: old keys this script may remove, but only when their
//   args also look like this local MCP server. This avoids deleting unrelated
//   user servers that merely share a similar name.
// - command/args/cwd: the exact process Claude should launch.
const MCP_SERVER = {
  name: "osbp-openings",
  legacyNamePattern: /^osbp-openings-v\d+\.\d+\.\d+(?:[-\w.]*)?$/,
  command: process.env.OSBP_CLAUDE_NODE ?? findNode(),
  args: [serverPath],
  cwd: repoRoot
};

const options = parseArgs(process.argv.slice(2));
if (options.help) {
  printHelp();
  process.exit(0);
}
// Tests pipe answers into stdin. Real users answer through readline below.
// Reading scripted answers once avoids readline's awkward multi-prompt behavior
// with non-TTY stdin.
const scriptedAnswers = input.isTTY ? undefined : readFileSync(0, "utf8").split(/\r?\n/);

const configPath = resolveConfigPath(options.configPath);
const existingConfig = readConfig(configPath);
const { nextConfig, legacyNames } = buildNextConfig(existingConfig, MCP_SERVER);
const changed = JSON.stringify(existingConfig) !== JSON.stringify(nextConfig);

console.log(SCRIPT_NAME);
console.log("");
console.log(`This script updates Claude Desktop's MCP config to add/update the MCP server "${MCP_SERVER.name}" only after you approve it.`);
console.log("");
console.log("Target Claude config:");
console.log(`  ${configPath}`);
console.log("");
printProposal(existingConfig, nextConfig, MCP_SERVER, legacyNames);

if (!changed) {
  console.log("");
  console.log(`No change needed: ${MCP_SERVER.name} is already configured in Claude Desktop's MCP config.`);
  console.log("");
  printMcpSource(MCP_SERVER);
  process.exit(0);
}

if (options.dryRun) {
  console.log("");
  console.log("Dry run only; no changes written.");
  process.exit(0);
}

let createBackup = options.yes;
if (!options.yes) {
  console.log("");
  console.log("About to edit Claude Desktop's MCP config file:");
  console.log(`  ${configPath}`);
  console.log("");
  const rl = scriptedAnswers ? undefined : createInterface({ input, output });
  try {
    if (!(await confirmWrite(rl))) {
      console.log("");
      console.log("No changes written.");
      process.exit(0);
    }
    createBackup = existsSync(configPath) && await confirmBackup(rl, configPath);
  } finally {
    rl?.close();
  }
}

const backup = writeConfig(configPath, nextConfig, { createBackup });
console.log("");
if (backup) {
  console.log("Backup created:");
  console.log(`  ${backup}`);
  console.log("");
}
console.log(`${existingConfig.mcpServers?.[MCP_SERVER.name] ? "Updated" : "Installed"} ${MCP_SERVER.name} in Claude Desktop's MCP config.`);
console.log(`Config file: ${configPath}`);
for (const name of legacyNames) {
  console.log(`Removed legacy entry: ${name}`);
}
console.log("");
printMcpSource(MCP_SERVER);

function parseArgs(args) {
  const options = {
    configPath: undefined,
    dryRun: false,
    help: false,
    yes: false
  };

  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index];
    if (arg === "--config") {
      const value = args[index + 1];
      if (!value || value.startsWith("--")) {
        throw new Error("--config requires a path");
      }
      options.configPath = value;
      index += 1;
    } else if (arg === "--dry-run") {
      options.dryRun = true;
    } else if (arg === "--yes" || arg === "-y") {
      options.yes = true;
    } else if (arg === "--help" || arg === "-h") {
      options.help = true;
    } else {
      throw new Error(`Unknown option ${arg}`);
    }
  }

  return options;
}

function printHelp() {
  console.log(SCRIPT_NAME);
  console.log("");
  console.log("Usage:");
  console.log("  node integrations/v0.1.0/openings/install-claude-mcp.mjs [--config path] [--yes] [--dry-run]");
  console.log("");
  console.log("Without --yes, the script shows the proposed Claude MCP config change and asks before writing.");
}

function resolveConfigPath(explicit) {
  // Claude Desktop uses one JSON config file per user. The default locations
  // mirror Claude's documented platform conventions; --config exists for tests,
  // nonstandard installs, and cautious dry-runs against a throwaway file.
  if (explicit) return resolve(explicit);

  if (process.platform === "darwin") {
    return resolve(requiredEnv("HOME", "--config <path>"), "Library/Application Support/Claude/claude_desktop_config.json");
  }
  if (process.platform === "win32") {
    return resolve(requiredEnv("APPDATA", "--config <path>"), "Claude/claude_desktop_config.json");
  }
  return resolve(requiredEnv("HOME", "--config <path>"), ".config/Claude/claude_desktop_config.json");
}

function requiredEnv(name, fallback) {
  const value = process.env[name];
  if (!value) {
    throw new Error(`${name} is not set; pass ${fallback} explicitly.`);
  }
  return value;
}

function readConfig(path) {
  // Fail before writing if the file is malformed. Claude may silently ignore a
  // bad config, so this script should be stricter and clearer than Claude is.
  if (!existsSync(path)) return {};
  const raw = readFileSync(path, "utf8").trim();
  if (!raw) return {};
  let parsed;
  try {
    parsed = JSON.parse(raw);
  } catch (error) {
    if (error instanceof SyntaxError) {
      throw new Error(`${path} is not valid JSON; no changes written.`);
    }
    throw error;
  }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new Error(`${path} must contain a JSON object`);
  }
  if (parsed.mcpServers !== undefined && (!parsed.mcpServers || typeof parsed.mcpServers !== "object" || Array.isArray(parsed.mcpServers))) {
    throw new Error(`${path} has a non-object mcpServers value`);
  }
  return parsed;
}

function buildNextConfig(config, server) {
  // Preserve the whole JSON object, preserve unrelated mcpServers, remove only
  // recognized legacy OSBP entries, then upsert the stable server.name entry.
  const mcpServers = config.mcpServers ?? {};
  const legacyNames = serverLegacyNames(mcpServers, server);
  return {
    nextConfig: {
      ...config,
      mcpServers: {
        ...withoutLegacyServers(mcpServers, server),
        [server.name]: {
          command: server.command,
          args: server.args,
          cwd: server.cwd
        }
      }
    },
    legacyNames
  };
}

function withoutLegacyServers(servers, server) {
  return Object.fromEntries(
    Object.entries(servers).filter(([name, entry]) => !isLegacyServerEntry(name, entry, server))
  );
}

function serverLegacyNames(servers, server) {
  return Object.entries(servers)
    .filter(([name, entry]) => isLegacyServerEntry(name, entry, server))
    .map(([name]) => name);
}

function isLegacyServerEntry(name, entry, server) {
  // Name alone is not enough evidence to delete a user's config entry. Only
  // remove legacy-looking names whose args point at the OSBP MCP server path.
  if (!server.legacyNamePattern.test(name)) return false;
  if (!entry || typeof entry !== "object" || Array.isArray(entry)) return false;
  if (!Array.isArray(entry.args)) return false;
  return entry.args.some((arg) => (
    typeof arg === "string" && arg.replaceAll("\\", "/").endsWith("packages/osbp-mcp-server/dist/server.js")
  ));
}

function printProposal(existingConfig, nextConfig, server, legacyNames) {
  console.log(`Current MCP entry for ${server.name}`);
  console.log("-----------------------------");
  printServerEntry(existingConfig.mcpServers?.[server.name]);
  if (legacyNames.length > 0) {
    console.log("");
    console.log("Legacy OSBP entries to remove");
    console.log("-----------------------------");
    for (const name of legacyNames) {
      console.log(`  ${name}`);
    }
  }
  console.log("");
  console.log(`Proposed MCP entry for ${server.name}`);
  console.log("------------------------------");
  printServerEntry(nextConfig.mcpServers[server.name]);
}

function printServerEntry(entry) {
  if (!entry) {
    console.log("  (missing)");
    return;
  }
  console.log(`  command: ${entry.command ?? "(missing)"}`);
  const args = Array.isArray(entry.args) ? entry.args : [];
  if (args.length === 0) {
    console.log("  args:    []");
  } else {
    for (const [index, arg] of args.entries()) {
      console.log(`  args[${index}]: ${arg}`);
    }
  }
  console.log(`  cwd:     ${entry.cwd ?? "(missing)"}`);
}

async function confirmWrite(rl) {
  const answer = await ask(rl, "Apply this change to Claude Desktop's MCP config? [y/N] ");
  return isYes(answer);
}

async function confirmBackup(rl, configPath) {
  const path = backupPath(configPath);
  console.log("");
  console.log("Optional backup:");
  console.log(`  ${path}`);
  const answer = await ask(rl, "Create this backup before writing? [Y/n] ");
  return answer.trim() === "" || isYes(answer);
}

async function ask(rl, prompt) {
  // In normal terminal use, readline owns prompts. In tests or scripted use,
  // echo the prompt and consume one pre-read answer per question.
  if (scriptedAnswers) {
    output.write(prompt);
    return scriptedAnswers.shift() ?? "";
  }
  return rl.question(prompt);
}

function isYes(answer) {
  return answer.trim().toLowerCase() === "y" || answer.trim().toLowerCase() === "yes";
}

function printMcpSource(server) {
  console.log(`command: ${server.command}`);
  console.log(`args[0]: ${server.args[0]}`);
  console.log(`cwd:     ${server.cwd}`);
}

function writeConfig(path, config, options = { createBackup: true }) {
  // Write via a sibling temp file and rename, so a failed write is less likely
  // to leave Claude's config half-written. Backups are explicit for humans and
  // automatic for --yes on existing files.
  mkdirSync(dirname(path), { recursive: true });
  let backup;
  if (options.createBackup && existsSync(path)) {
    backup = backupPath(path);
    copyFileSync(path, backup);
  }
  const tempPath = `${path}.tmp-${process.pid}`;
  writeFileSync(tempPath, `${JSON.stringify(config, null, 2)}\n`);
  renameSync(tempPath, path);
  return backup;
}

function backupPath(path) {
  return `${path}.backup`;
}

function findNode() {
  const command = process.platform === "win32" ? "where" : "which";
  try {
    return execFileSync(command, ["node"], { encoding: "utf8" }).split(/\r?\n/)[0].trim();
  } catch {
    return process.execPath;
  }
}
