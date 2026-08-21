import { DEFAULT_CONFORMANCE_FIXTURES, type PartialConformanceFixtures } from "@osbp/conformance";
import { StarterBookingAdapter } from "./index.js";

// Reserved, non-routable placeholders for the deliberately unimplemented
// starter/conformance target. Real adapters should require operator-supplied
// API origins, organization ids, and timeout policy instead of defaulting to a
// shared or live platform tenant.
const SYNTHETIC_CONFORMANCE_API_BASE_URL = "https://vendor.example";
const SYNTHETIC_CONFORMANCE_ORGANIZATION_ID = "org_synthetic_conformance";

export const adapter = new StarterBookingAdapter({
  apiBaseUrl: process.env.TARGET_API_BASE_URL ?? SYNTHETIC_CONFORMANCE_API_BASE_URL,
  organizationId: process.env.TARGET_ORGANIZATION_ID ?? SYNTHETIC_CONFORMANCE_ORGANIZATION_ID,
  httpTimeoutMs: intEnv("TARGET_HTTP_TIMEOUT_MS", 10000),
  nativeApiVersion: process.env.TARGET_NATIVE_API_VERSION,
  enableConfiguredCustomerFallback: boolEnv("TARGET_ENABLE_CONFIGURED_CUSTOMER_FALLBACK", false),
  configuredCustomerFallback: configuredCustomerFallback(),
  notificationBehavior: notificationBehaviorEnv("TARGET_NOTIFICATION_BEHAVIOR"),
  credentials: {
    apiKey: process.env.TARGET_API_KEY,
    bearerToken: process.env.TARGET_BEARER_TOKEN,
    clientId: process.env.TARGET_CLIENT_ID,
    clientSecret: process.env.TARGET_CLIENT_SECRET
  }
});

const services = {
  fixed_usd: process.env.TARGET_SERVICE_FIXED_USD ?? DEFAULT_CONFORMANCE_FIXTURES.services.fixed_usd,
  fixed_eur: process.env.TARGET_SERVICE_FIXED_EUR ?? DEFAULT_CONFORMANCE_FIXTURES.services.fixed_eur,
  fixed_gbp: process.env.TARGET_SERVICE_FIXED_GBP ?? DEFAULT_CONFORMANCE_FIXTURES.services.fixed_gbp,
  fixed_jpy: process.env.TARGET_SERVICE_FIXED_JPY ?? DEFAULT_CONFORMANCE_FIXTURES.services.fixed_jpy,
  fixed_kwd: process.env.TARGET_SERVICE_FIXED_KWD ?? DEFAULT_CONFORMANCE_FIXTURES.services.fixed_kwd,
  insurance_dependent: process.env.TARGET_SERVICE_INSURANCE ?? DEFAULT_CONFORMANCE_FIXTURES.services.insurance_dependent,
  quote_required: process.env.TARGET_SERVICE_QUOTE ?? DEFAULT_CONFORMANCE_FIXTURES.services.quote_required,
  consultation: process.env.TARGET_SERVICE_CONSULTATION ?? DEFAULT_CONFORMANCE_FIXTURES.services.consultation,
  deposit: process.env.TARGET_SERVICE_DEPOSIT ?? DEFAULT_CONFORMANCE_FIXTURES.services.deposit,
  full_prepay: process.env.TARGET_SERVICE_FULL_PREPAY ?? DEFAULT_CONFORMANCE_FIXTURES.services.full_prepay,
  unknown_payment: process.env.TARGET_SERVICE_UNKNOWN_PAYMENT ?? DEFAULT_CONFORMANCE_FIXTURES.services.unknown_payment,
  verification: process.env.TARGET_SERVICE_VERIFICATION ?? DEFAULT_CONFORMANCE_FIXTURES.services.verification
};

export const conformanceFixtures: PartialConformanceFixtures = {
  organization_id: process.env.TARGET_ORGANIZATION_ID ?? SYNTHETIC_CONFORMANCE_ORGANIZATION_ID,
  schedule_id: process.env.TARGET_SCHEDULE_ID ?? "sched_synthetic_conformance",
  provider_id: process.env.TARGET_PROVIDER_ID ?? "prov_synthetic_conformance",
  date: process.env.TARGET_DATE ?? "2030-05-02",
  time: process.env.TARGET_TIME ?? "10:00",
  customer: {
    id: process.env.TARGET_CUSTOMER_ID,
    phone: process.env.TARGET_CUSTOMER_PHONE,
    email: process.env.TARGET_CUSTOMER_EMAIL,
    display_name: process.env.TARGET_CUSTOMER_NAME ?? "OSBP Conformance Customer"
  },
  services,
  expected_prices: {
    [services.fixed_usd]: {
      amount_minor: intEnv("TARGET_PRICE_FIXED_USD_MINOR", 9500),
      currency: "USD"
    },
    [services.fixed_eur]: {
      amount_minor: intEnv("TARGET_PRICE_FIXED_EUR_MINOR", 9000),
      currency: "EUR"
    },
    [services.fixed_gbp]: {
      amount_minor: intEnv("TARGET_PRICE_FIXED_GBP_MINOR", 8000),
      currency: "GBP"
    },
    [services.fixed_jpy]: {
      amount_minor: intEnv("TARGET_PRICE_FIXED_JPY_MINOR", 12000),
      currency: "JPY"
    },
    [services.fixed_kwd]: {
      amount_minor: intEnv("TARGET_PRICE_FIXED_KWD_MINOR", 12500),
      currency: "KWD"
    }
  }
};

function intEnv(name: string, fallback: number): number {
  const value = process.env[name];
  if (value === undefined) {
    return fallback;
  }
  const parsed = Number.parseInt(value, 10);
  if (!Number.isSafeInteger(parsed)) {
    throw new Error(`${name} must be an integer minor-unit amount`);
  }
  return parsed;
}

function boolEnv(name: string, fallback: boolean): boolean {
  const value = process.env[name];
  if (value === undefined) {
    return fallback;
  }
  if (value === "true") {
    return true;
  }
  if (value === "false") {
    return false;
  }
  throw new Error(`${name} must be true or false`);
}

function configuredCustomerFallback() {
  const customer = {
    id: process.env.TARGET_CONFIGURED_CUSTOMER_ID,
    phone: process.env.TARGET_CONFIGURED_CUSTOMER_PHONE,
    email: process.env.TARGET_CONFIGURED_CUSTOMER_EMAIL,
    given_name: process.env.TARGET_CONFIGURED_CUSTOMER_GIVEN_NAME,
    family_name: process.env.TARGET_CONFIGURED_CUSTOMER_FAMILY_NAME,
    display_name: process.env.TARGET_CONFIGURED_CUSTOMER_NAME
  };
  return Object.values(customer).some((value) => value !== undefined) ? customer : undefined;
}

function notificationBehaviorEnv(name: string): "omit" | "operator_configured" {
  const value = process.env[name];
  if (value === undefined || value === "omit") {
    return "omit";
  }
  if (value === "operator_configured") {
    return value;
  }
  throw new Error(`${name} must be omit or operator_configured`);
}
