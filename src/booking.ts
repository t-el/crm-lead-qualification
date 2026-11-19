/** Signed, expiring booking links and available slots in the business time zone (no calendar SaaS needed for the demo;
 *  swap `availableSlots` for Google Calendar free/busy, Calendly or the GoHighLevel calendar API in production). */
import { createHmac, timingSafeEqual } from "node:crypto";

export function signBookingToken(leadId: string, expiresAt: Date, secret: string): string {
  const payload = Buffer.from(`${leadId}.${Math.floor(expiresAt.getTime() / 1000)}`).toString("base64url");
  const sig = createHmac("sha256", secret).update(payload).digest("base64url").slice(0, 22);
  return `${payload}.${sig}`;
}

export function verifyBookingToken(token: string, secret: string, now: Date): { leadId: string } | null {
  const [payload, sig] = token.split(".");
  if (!payload || !sig) return null;
  const expected = createHmac("sha256", secret).update(payload).digest("base64url").slice(0, 22);
  if (expected.length !== sig.length || !timingSafeEqual(Buffer.from(expected), Buffer.from(sig))) return null;
  const [leadId, exp] = Buffer.from(payload, "base64url").toString().split(".");
  return Number(exp) * 1000 > now.getTime() ? { leadId } : null;
}

/** Local wall-clock parts for an instant in a time zone. */
export function localParts(d: Date, tz: string) {
  const p = Object.fromEntries(new Intl.DateTimeFormat("en-US", { timeZone: tz, hourCycle: "h23", year: "numeric", month: "2-digit",
    day: "2-digit", hour: "2-digit", minute: "2-digit", weekday: "short" }).formatToParts(d).map((x) => [x.type, x.value]));
  return { hour: Number(p.hour), minute: Number(p.minute), weekday: p.weekday as string, date: `${p.year}-${p.month}-${p.day}` };
}

/** Next 3 business days, 9:00-16:00 local, 2-hour windows, minus taken slots. */
export function availableSlots(now: Date, tz: string, taken: Set<string>, days = 3): Date[] {
  const out: Date[] = [];
  let t = new Date(Math.ceil(now.getTime() / 3_600_000) * 3_600_000 + 3_600_000 * 2);   // at least 2h notice
  let daysSeen = new Set<string>();
  for (let i = 0; i < 24 * 10 && daysSeen.size <= days; i++, t = new Date(t.getTime() + 3_600_000)) {
    const lp = localParts(t, tz);
    if (lp.weekday === "Sat" || lp.weekday === "Sun" || lp.minute !== 0) continue;
    if (![9, 11, 13, 15].includes(lp.hour)) continue;
    daysSeen.add(lp.date);
    if (daysSeen.size > days) break;
    if (!taken.has(t.toISOString())) out.push(t);
  }
  return out;
}

export const fmtSlot = (d: Date, tz: string) =>
  new Intl.DateTimeFormat("en-US", { timeZone: tz, weekday: "short", month: "short", day: "numeric", hour: "numeric", minute: "2-digit" }).format(d);
