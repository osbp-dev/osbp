import { DEFAULT_CONFORMANCE_FIXTURES, type PartialConformanceFixtures } from "@osbp/conformance";
import { StarterBookingAdapter } from "./index.js";

export const adapter = new StarterBookingAdapter({
  apiBaseUrl: process.env.TARGET_API_BASE_URL ?? "https://vendor.example",
  organizationId: process.env.TARGET_ORGANIZATION_ID ?? "replace-me",
  credentials: {
    apiKey: process.env.TARGET_API_KEY,
    bearerToken: process.env.TARGET_BEARER_TOKEN,
    clientId: process.env.TARGET_CLIENT_ID,
    clientSecret: process.env.TARGET_CLIENT_SECRET
  },
  idempotencyStorePath: process.env.OSBP_IDEMPOTENCY_STORE_PATH
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
  organization_id: process.env.TARGET_ORGANIZATION_ID ?? "replace-me",
  schedule_id: process.env.TARGET_SCHEDULE_ID ?? "replace-me",
  provider_id: process.env.TARGET_PROVIDER_ID ?? "replace-me",
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
