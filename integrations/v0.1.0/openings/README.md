# Openings Business

Audience: integrators and reviewers running the v0.1.0 Openings example.

This example runs the v0.1.0 proof of concept against a live booking platform:
an AI agent books a real appointment, end to end, through OSBP.
[Openings](https://docs.openings.link) is the third-party booking platform that
owns the appointment (the system of record). OSBP is independent protocol code;
Openings is the booking platform this adapter talks to. This sample
targets an operator-provisioned Openings business. New to OSBP? See the
[project README](../../../README.md) or the
[v0.1.0 spec](../../../docs/spec/v0.1.0/README.md).

It exercises the full chain:

```text
one AI agent <-> local OSBP MCP server <-> Openings adapter <-> an operator-provisioned Openings business
```

Start with [Getting Started](./getting-started.md), then pick the section for what you are doing.

## Run the example

- [Getting Started](./getting-started.md): one-time local setup (install, build, copy the env file), then the read-only smoke, a safe run that lists services and availability but never books.
- [Test with Claude](./using-with-claude.md): drive the live booking flow from Claude Desktop or Claude Code. In v0.1.0 the host launches the OSBP server as a local subprocess (MCP over stdio), so there is no network endpoint to deploy. ChatGPT needs a remote one and waits for v0.2.0.
- [install-claude-mcp.mjs](./install-claude-mcp.mjs), [claude-desktop.mcp.example.json](./claude-desktop.mcp.example.json), and [.env.example](./.env.example): the Claude Desktop config installer, the manual config template, and the environment template you copy to `.env.local`.

## Other agent hosts

- [Test with GitHub Copilot](./using-with-copilot.md): the same eight-tool contract through Copilot Agent Mode; only the host differs.

## For adapter implementers

- [Adapter notes](./adapter-notes.md): how the eight OSBP tools map onto Openings endpoints and fields.
- [Agent prompt fragment](./agent-prompt-fragment.md): system-prompt rules that keep an agent booking safely (confirm one exact slot before creating, never invent ids, relay the verification code, retry without double-booking, hand off when unverified).

## Trace evidence and maintainer tooling

- The canonical redacted booking trace ships at [traces/v0.1.0/openings-create.json](../../../traces/v0.1.0/openings-create.json).
- [Generate or replay the golden trace](./golden-trace.md): reproduce that trace. A safe mode stops before booking; an opt-in flag creates one controlled live appointment.
