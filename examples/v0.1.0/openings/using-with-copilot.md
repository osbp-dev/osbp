# Test with GitHub Copilot

Audience: contributors testing the v0.1.0 local MCP server with GitHub Copilot Agent Mode in VS Code.

GitHub Copilot Agent Mode can drive the OSBP MCP server the same way Claude Desktop does. The tool contract is identical; only the host differs.

## Prerequisites

1. Complete the [one-time setup](./getting-started.md#one-time-setup).
2. Build the server:

   ```sh
   npm run build
   ```

3. Confirm the read-only smoke succeeds:

   ```sh
   npm --workspace @osbp/mcp-server run smoke:read
   ```

4. Install the [GitHub Copilot extension](https://marketplace.visualstudio.com/items?itemName=GitHub.copilot) in VS Code and sign in.

## Configure VS Code

VS Code reads MCP servers from `.vscode/mcp.json`. `.vscode/` is gitignored in this repo, so create the file locally:

**`.vscode/mcp.json`** (create this file; it is not committed):

```jsonc
{
  // Build first: npm run build
  // Secrets: copy .env.example to .env.local and fill in.

  "servers": {

    // OSBP MCP server, Openings adapter (v0.1.0)
    // Exposes the eight OSBP booking tools backed by a real Openings salon.
    // Platform: https://openings.link | Setup: examples/v0.1.0/openings/getting-started.md
    "osbp-openings-v0.1.0": {
      "type": "stdio",
      "command": "node",
      "args": ["packages/osbp-mcp-server/dist/server.js"]
    }

  }
}
```

After saving, reload VS Code. The OSBP tools should appear in Copilot Agent Mode.

## Confirm Tools Are Visible

Open Copilot Chat, switch to Agent Mode, and ask: `What OSBP tools do you have access to?`

Copilot should list:

```text
osbp_service_describe
osbp_availability_find
osbp_policy_explain
osbp_verification_send
osbp_verification_verify
osbp_booking_create
osbp_booking_status
osbp_handoff_request
```

If the tools are missing, confirm that `packages/osbp-mcp-server/dist/server.js` exists (run `npm run build` if not) and that `.env.local` is populated.

## Running a Test

Once the tools are visible, use the same prompts as Claude Desktop. The [Claude Desktop guide](./using-with-claude.md) has the safe read-only prompt, the live booking prompt, and the configured-defaults table — all of which apply identically to Copilot. Follow that guide starting from the "Safe Read-Only Prompt" section.
