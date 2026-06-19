# OSBP Adapter Starter

Audience: developers and AI coding agents building a new OSBP v0.1.0 booking adapter.

This package is a compiling but deliberately unimplemented `BookingAdapter` skeleton. Copy it for a target booking platform, fill in the seven adapter methods, and use the conformance CLI as the checklist for what remains.

```sh
npm --workspace @osbp/adapter-starter run build
node packages/adapter-starter/dist/cli.js --conformance
```

The starter returns `adapter_not_implemented` Problems until a method is mapped. That is intentional: progress is measured by conformance requirement ids flipping from fail to pass.

The safest implementation loop is:

1. Read `docs/spec/v0.1.0/implementing-an-adapter.md`.
2. Copy `packages/adapter-starter/` for your platform.
3. Replace `StarterBookingAdapter` TODO blocks method by method.
4. Run `node packages/<your-adapter>/dist/cli.js --conformance`.
5. Repeat until the conformance report is green.
