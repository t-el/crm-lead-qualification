import { createHmac, timingSafeEqual } from "node:crypto";
import { checkResponse, withRetry } from "./retry.js";

/**
 * Twilio request validation: base64(HMAC-SHA1(authToken, fullUrl + each POST param name+value sorted by name)).
 * https://www.twilio.com/docs/usage/security#validating-requests
 */
export function twilioSignature(authToken: string, url: string, params: Record<string, string>): string {
  const data = Object.keys(params).sort().reduce((acc, k) => acc + k + params[k], url);
  return createHmac("sha1", authToken).update(Buffer.from(data, "utf8")).digest("base64");
}

export function validateTwilio(authToken: string, url: string, params: Record<string, string>, signature: string | undefined) {
  if (!signature) return false;
  const expected = Buffer.from(twilioSignature(authToken, url, params));
  const given = Buffer.from(signature);
  return expected.length === given.length && timingSafeEqual(expected, given);
}

/** Missed call = the call ended without anyone answering. Works for the call or the <Dial> status callback. */
export function isMissedCall(p: Record<string, string>): boolean {
  const status = (p.DialCallStatus || p.CallStatus || "").toLowerCase();
  return ["no-answer", "busy", "failed", "canceled"].includes(status);
}

export interface SmsSender {
  send(to: string, body: string, idempotencyKey: string): Promise<string>;
}

export class TwilioSms implements SmsSender {
  constructor(private sid: string, private token: string, private from: string, private fetchFn: typeof fetch = fetch,
              private retry = { attempts: 4, baseDelayMs: 500 }) {}

  async send(to: string, body: string): Promise<string> {
    const url = `https://api.twilio.com/2010-04-01/Accounts/${this.sid}/Messages.json`;
    const auth = Buffer.from(`${this.sid}:${this.token}`).toString("base64");
    return withRetry(async () => {
      const res = await checkResponse(await this.fetchFn(url, {
        method: "POST", headers: { Authorization: `Basic ${auth}`, "Content-Type": "application/x-www-form-urlencoded" },
        body: new URLSearchParams({ To: to, From: this.from, Body: body }),
      }), "twilio messages");
      return ((await res.json()) as { sid: string }).sid;
    }, { ...this.retry, step: "sms_send" });
  }
}

/** Mock: records messages instead of texting anyone. `failTimes` simulates a Twilio outage. */
export class MockSms implements SmsSender {
  sent: { to: string; body: string; sid: string; key: string }[] = [];
  constructor(public failTimes = 0) {}
  async send(to: string, body: string, key: string): Promise<string> {
    if (this.failTimes > 0) {
      this.failTimes--;
      throw Object.assign(new Error("Twilio 503"), { code: "ECONNRESET" });
    }
    const sid = `SM${(this.sent.length + 1).toString().padStart(32, "0")}`;
    this.sent.push({ to, body, sid, key });
    return sid;
  }
}

export interface EmailSender {
  send(to: string, subject: string, text: string, idempotencyKey: string): Promise<string>;
}

/** Resend HTTP API (any provider with an HTTP API works the same way). */
export class ResendEmail implements EmailSender {
  constructor(private key: string, private from: string, private fetchFn: typeof fetch = fetch) {}
  async send(to: string, subject: string, text: string, idempotencyKey: string): Promise<string> {
    return withRetry(async () => {
      const res = await checkResponse(await this.fetchFn("https://api.resend.com/emails", {
        method: "POST",
        headers: { Authorization: `Bearer ${this.key}`, "Content-Type": "application/json", "Idempotency-Key": idempotencyKey },
        body: JSON.stringify({ from: this.from, to, subject, text }),
      }), "resend");
      return ((await res.json()) as { id: string }).id;
    }, { attempts: 4, baseDelayMs: 500, step: "email_send" });
  }
}

export class MockEmail implements EmailSender {
  sent: { to: string; subject: string; text: string; key: string }[] = [];
  async send(to: string, subject: string, text: string, key: string): Promise<string> {
    this.sent.push({ to, subject, text, key });
    return `email_${this.sent.length}`;
  }
}
