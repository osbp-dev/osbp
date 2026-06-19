# Governance

Audience: contributors and implementers who want to understand how OSBP decisions are made while the project is early.

OSBP is currently maintained by Andy Volk. The project is pre-1.0, so the maintainer is the final decision-maker for scope, spec wording, release timing, and compatibility calls.

## How Decisions Are Made

OSBP favors small, working proofs over broad speculative design. A change is easiest to accept when it includes:

- the booking problem it solves
- the protocol surface it changes
- the failure mode it closes or makes easier to test
- an example, trace, or implementation note that shows the behavior

Built behavior belongs in the spec. Intentions and possible future directions belong in [ROADMAP.md](ROADMAP.md) until they are implemented and verified.

## Proposing Changes

Use GitHub issues or discussions at <https://github.com/osbp-dev/osbp> to propose changes, report gaps, or ask implementation questions. Keep proposals focused on one booking behavior or spec concern at a time.

Because OSBP is pre-1.0, breaking changes are expected. The project will prefer clear corrections over compatibility with a shape that has not proved itself yet.

## Release Process

Public releases are tagged from the curated public repository. Each release should state what is built, what is intentionally not built, and which examples or traces demonstrate the behavior.

While OSBP is pre-1.0, only the latest `0.x` release is supported at a time. Additive changes can ship without advance notice because they do not break existing integrations. Deprecated surfaces are marked deprecated when their replacements ship, and are removed no sooner than the next breaking release, with at least 90 days of advance notice.
