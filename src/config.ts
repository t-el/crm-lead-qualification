import { existsSync } from "node:fs";
import { z } from "zod";

const Env = z.object({
  PORT: z.coerce.number().default(8900),
  PUBLIC_URL: z.string().default("http://localhost:8900"),
  DATA_DIR: z.string().default("data"),
  LOG_FORMAT: z.enum(["json", "pretty"]).default("json"),
  BUSINESS_NAME: z.string().default("Atlas Heating & Cooling"),
  BUSINESS_TZ: z.string().default("America/New_York"),
  DEFAULT_CALLING_CODE: z.string().default("1"),
  SERVICE_AREA_ZIPS: z.string().default("10001,10002,10003,10011,10014,11201,11211,11215"),
  QUIET_HOURS_START: z.coerce.number().default(20),
  QUIET_HOURS_END: z.coerce.number().default(8),
  WEBHOOK_SECRET: z.string().default(""),
  BOOKING_SECRET: z.string().default("dev-booking-secret-change-me"),
  // Twilio
  TWILIO_ACCOUNT_SID: z.string().default(""),
  TWILIO_AUTH_TOKEN: z.string().default("twilio-demo-token"),
  TWILIO_FROM_NUMBER: z.string().default("+15550100200"),
  VALIDATE_TWILIO_SIGNATURE: z.enum(["true", "false"]).default("true"),
  // Email
  RESEND_API_KEY: z.string().default(""),
  EMAIL_FROM: z.string().default("Atlas Heating & Cooling <hello@example.com>"),
  // CRM
  CRM_PROVIDER: z.enum(["hubspot", "gohighlevel"]).default("hubspot"),
  CRM_MOCK: z.enum(["true", "false"]).default("true"),
  HUBSPOT_TOKEN: z.string().default("pat-mock"),
  HUBSPOT_PIPELINE: z.string().default("default"),
  GHL_TOKEN: z.string().default("ghl-mock"),
  GHL_LOCATION_ID: z.string().default("loc_demo"),
  GHL_PIPELINE_ID: z.string().default("pipe_demo"),
  // AI
  OPENAI_API_KEY: z.string().default(""),
  OPENAI_BASE_URL: z.string().default("https://api.openai.com/v1"),
  OPENAI_MODEL: z.string().default("gpt-4o-mini"),
  // Reliability
  RETRY_ATTEMPTS: z.coerce.number().default(4),
  RETRY_BASE_DELAY_MS: z.coerce.number().default(500),
});

export type Config = z.infer<typeof Env> & { serviceZips: Set<string> };

export function loadConfig(overrides: Record<string, string> = {}): Config {
  if (existsSync(".env")) process.loadEnvFile(".env");
  const env = Env.parse({ ...process.env, ...overrides });
  return { ...env, serviceZips: new Set(env.SERVICE_AREA_ZIPS.split(",").map((z) => z.trim())) };
}
