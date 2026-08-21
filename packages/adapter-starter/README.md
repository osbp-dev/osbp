# OSBP Adapter Starter

Audience: developers and AI coding agents building a new OSBP v0.1.0 booking adapter.

This package is a compiling but deliberately unimplemented `BookingAdapter` skeleton. Copy it for a target booking platform, fill in the seven adapter methods, and use the conformance CLI as the checklist for what remains.

```sh
npm --workspace @osbp/adapter-starter run build
node packages/adapter-starter/dist/cli.js --conformance
```

The starter returns `adapter_not_implemented` Problems until a method is mapped. That is intentional: progress is measured by conformance requirement ids flipping from fail to pass.

## Copy-Paste Config Shape

Real adapters should require the operator to provide the live API origin and
organization/account id. Do not default a copied adapter to a shared tenant,
public demo account, or live platform URL. The `https://vendor.example` value in
`src/conformance-target.ts` is a reserved, non-routable placeholder for this
unimplemented starter's synthetic conformance target, not a runtime default
pattern.

Keep the config boring and explicit:

```ts
function requireEnv(name: string): string {
  const value = process.env[name];
  if (!value) throw new Error(`${name} is required`);
  return value;
}

function intEnv(name: string, fallback: number): number {
  const value = process.env[name];
  return value ? Number.parseInt(value, 10) : fallback;
}

function boolEnv(name: string, fallback: boolean): boolean {
  const value = process.env[name];
  return value === undefined ? fallback : value === "true";
}

function configuredCustomerFromEnv() {
  const customer = {
    id: process.env.TARGET_CUSTOMER_ID,
    phone: process.env.TARGET_CUSTOMER_PHONE,
    email: process.env.TARGET_CUSTOMER_EMAIL
  };
  return Object.values(customer).some(Boolean) ? customer : undefined;
}

new StarterBookingAdapter({
  apiBaseUrl: requireEnv("TARGET_API_BASE_URL"),
  organizationId: requireEnv("TARGET_ORGANIZATION_ID"),
  httpTimeoutMs: intEnv("TARGET_HTTP_TIMEOUT_MS", 10000),
  nativeApiVersion: process.env.TARGET_NATIVE_API_VERSION,
  credentials: {
    apiKey: process.env.TARGET_API_KEY,
    bearerToken: process.env.TARGET_BEARER_TOKEN
  },
  enableConfiguredCustomerFallback: boolEnv("TARGET_ENABLE_CONFIGURED_CUSTOMER_FALLBACK", false),
  configuredCustomerFallback: configuredCustomerFromEnv(),
  notificationBehavior: "omit"
});
```

`nativeApiVersion` is only a copy-paste marker. Replace it with the platform's
real version header, media type, or path segment. Credentials are optional only
when the platform has a public read path or local synthetic target. Customer
fallback must be explicitly enabled and is not identity proof; production
identity belongs at the host/auth boundary. Omit platform notification flags by
default, or expose operator-approved notification settings for the copied
adapter. Configure request timeouts deliberately.

The `createBooking` wrapper owns the protocol safety scaffolding while the target
adapter fills in `createBookingOnPlatform`: final approval, local idempotency,
same-key in-flight dedupe, provider-scope pre-checks, and a no-throw backstop for
platform-create failures. The starter's `requestJson` helper captures upstream
metadata, redacts contact-bearing path segments, preserves `Retry-After` /
RateLimit headers, applies `httpTimeoutMs` with `AbortController` when
configured, maps HTTP 429 during create to `rate_limited`, and logs only minimal
operator diagnostics to stderr (status plus redacted path, or an error name for
unknown throws). Do deliberate platform-specific error mapping in the copied
adapter before returning production results.

The safest implementation loop is:

1. Read `docs/spec/v0.1.0/implementing-an-adapter.md`.
2. Copy `packages/adapter-starter/` for your platform.
3. Replace `StarterBookingAdapter` TODO blocks method by method.
4. Run `node packages/<your-adapter>/dist/cli.js --conformance`.
5. Repeat until the conformance report is green.
