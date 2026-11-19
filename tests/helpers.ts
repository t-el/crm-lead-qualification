import { buildEngine } from "../src/app.js";
import { loadConfig } from "../src/config.js";
import { configureLogger } from "../src/logger.js";
import type { MockEmail, MockSms } from "../src/twilio.js";

configureLogger({ silent: true });

/** Tue 17 Nov 2026, 10:00 in New York. */
export const T0 = new Date("2026-11-17T15:00:00Z");
export const H = 3_600_000;

export function makeEngine(overrides: Record<string, string> = {}, start = T0) {
  let now = start.getTime();
  const sleeps: number[] = [];
  const cfg = loadConfig({ RETRY_BASE_DELAY_MS: "1", PUBLIC_URL: "https://leads.example.com", ...overrides });
  const built = buildEngine(cfg, { clock: () => new Date(now), dbPath: ":memory:", sleepFn: async (ms) => { sleeps.push(ms); } });
  return {
    ...built, cfg, sleeps,
    sms: built.sms as MockSms, email: built.email as MockEmail,
    advance: (ms: number) => { now += ms; },
    setNow: (d: Date) => { now = d.getTime(); },
    now: () => new Date(now),
  };
}

let sid = 0;
export const smsParams = (from: string, body: string) => ({ MessageSid: `SM${++sid}`, From: from, To: "+15550100200", Body: body });

export async function answerAll(e: ReturnType<typeof makeEngine>["engine"], phone: string, answers: string[]) {
  for (const a of answers) await e.handleInboundSms(smsParams(phone, a));
}
