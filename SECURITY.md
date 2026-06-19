# Security Policy

Audience: anyone reporting a security issue in OSBP.

## Reporting a vulnerability

Report suspected vulnerabilities privately to **security@osbp.dev**. Please do not open a public issue for a security report.

Where you can, include:

- a description of the issue and its impact;
- steps to reproduce, or a proof of concept;
- the affected version, commit, or package.

We aim to acknowledge a report within a few business days and will keep you updated as we investigate. Please allow a reasonable window to address the issue before any public disclosure.

## Scope

OSBP is a pre-1.0 proof of concept. It authorizes bookings under a user-approved `BookingMandate`, fails closed on unknown or unauthorized states, and does not move money. Reports about the mandate trust boundary, local idempotency, audit and trace redaction, or adapter safety are especially welcome.

## Supported versions

While OSBP is pre-1.0, only the latest `0.x` release line is supported for security fixes.
