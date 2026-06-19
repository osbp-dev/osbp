# Contributing to OSBP

Audience: contributors and their AI coding agents working on OSBP. Project scope, domain rules, and trust requirements live in [AGENTS.md](AGENTS.md); this file covers the shared engineering conventions every contributor follows.

These conventions bind everyone working in the repo, human or agent. They live here, in the repo, rather than in any one developer's personal config, so a collaborator's agent inherits them from the project instead of from the maintainer's machine.

## Development setup

This is an npm workspace. Build before testing: the test scripts run against compiled `dist/`, so a cold `npm test` with nothing built reports zero tests.

```bash
npm install
npm run build
npm test
npm run check      # build plus shared-doc hygiene
npm run coverage   # build, then run the suite with line/branch/function coverage
npm run spell      # cspell spell-check (same gate CI enforces)
```

`npm run coverage` builds first, then runs every compiled test under Node's
built-in coverage so contributors get one repeatable command and the same
numbers locally. It measures `dist/` (excluding `*.test.js`), matching what
`npm test` runs.

Read-only path-resolution smoke (must work from any directory, see the Path Resolution rule in AGENTS.md):

```bash
cd / && node <path-to-your-clone>/packages/reference-backend/dist/cli.js --smoke
```

Live booking and SMS verification are gated and require local fixtures in a gitignored `.env.local`. Default tests use redacted fixtures and never hit the live merchant.

## Branches

Use a conventional-commit prefix as the rightmost segment, lowercase and hyphen-separated, describing what the branch accomplishes:

- `fix/` bug fixes, including security fixes
- `chore/` maintenance, dependency bumps, dead-code removal
- `build/` build configuration, manifests, CI
- `refactor/` restructuring with no behavior change
- `perf/` performance work
- `feat/` new user-facing features
- `docs/` documentation only

No bot prefixes (`claude/`, `codex/`, `bot/`) and no internal item numbers.

## Commits

One focused commit per logical change, each revertable and reviewable on its own. Do not squash unrelated changes together.

```text
<area>: <one-line summary, imperative mood, no period>

<optional body: explain the why, not the what>
```

Do not reference a private tracker, plan item, or bundle name in the message. Keep the doc-sync rule in AGENTS.md in mind: update related active docs in the same commit when behavior or plans change.

### AI attribution

When an AI agent made a meaningful contribution to the diff, add one trailer, after any human `Co-authored-by:` trailers, using the canonical model id:

```text
Assisted-by: Claude Code (claude-opus-4-8)
```

Do not use `Co-Authored-By:` for AI; that trailer is reserved for human collaborators. Do not add vendor bot accounts (for example `<noreply@anthropic.com>`) or generated-by boilerplate.

### AI disclosure

OSBP uses AI assistance for drafting, implementation, review, and maintenance. Human maintainers remain responsible for accepted changes. The commit trailer rule above records AI-assisted commits; this note is the project-level transparency statement for readers.

## Pull requests

Each PR covers a single theme, usually one to four commits. Avoid omnibus PRs. PR titles follow the commit summary conventions. A useful description states what changed, why, the files touched, and how it was verified.

## Writing conventions

- Avoid em-dashes (U+2014) in new shared writing: commit messages, PR titles and descriptions, and new docs. Use commas, colons, periods, or parentheses. Do not rewrite existing text solely to remove them.
- No emojis in code, comments, commit messages, or PR titles.
- A shared doc whose audience is not obvious from its path declares its audience in the first three lines (enforced by `scripts/check-shared-docs.mjs`).
- Match the surrounding file's brace, indentation, and naming style.

## Data hygiene

Nothing committed to the repo, embedded in code or comments, written into a commit message, or posted in a PR may contain:

- absolute filesystem paths under a user-specific home directory; use repo-relative or a placeholder;
- machine names, hostnames, IP or MAC addresses, or network names;
- API tokens, keys, secrets, or session cookies, even if they look like test data;
- live merchant fixtures: real merchant, customer, schedule, or provider IDs, or the test phone number;
- personal data or contact details of any party.

Live fixtures belong only in a gitignored `.env.local`. Traces and examples use redacted or aliased values; see the trace-redaction rules in AGENTS.md.

## Comments

Default to no comments. Add one only when the why is non-obvious: a hidden constraint, a workaround, or a subtle invariant. Do not write comments that restate what the code does, and do not leave `TODO` or `FIXME` for things you choose not to fix.

A comment or user-facing string that ships in the public repo describes current behavior in a neutral voice and leaves out the history of how that behavior was learned. Keep these out of shipping source:

- Dated provenance and live-probe notes ("verified live 2026-06-12", "retrieved <date>", "as of <date>").
- Evolution narrative ("used to do X, now does Y", "since <date>").
- An upstream API's internals found by reverse engineering: its gating or auth mechanism, internal purpose-string or id formats, access observations, references to a private file or repo, or "the maintainer confirmed" attribution.

That history belongs in `AGENTS.md` and the project's internal notes, not in shipping source. Stay descriptive, not judgmental: say what the code does ("tries several key names"), not what it lacks ("deliberately defensive because the response shape is unconfirmed").

## Agent guidance

[AGENTS.md](AGENTS.md) is the canonical project-guidance source; [CLAUDE.md](CLAUDE.md) is a thin pointer to it. If a contribution changes project purpose, scope, core tools, adapter API assumptions, or trust requirements, update the agent guidance in the same change.

## Licensing

By contributing, you agree that code contributions are provided under Apache-2.0 and that specification and documentation contributions are provided under CC-BY-4.0 unless a file states otherwise. See [LICENSE](LICENSE) and [NOTICE](NOTICE).
