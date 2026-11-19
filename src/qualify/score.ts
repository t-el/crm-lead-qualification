import type { Answers, Lead } from "../types.js";

export interface ScoreResult {
  score: number;
  tier: "hot" | "warm" | "cold" | "disqualified";
  reasons: string[];
  estValue: number;   // deal amount for the CRM
}

const VALUE = { install: 8500, repair: 450, maintenance: 240 } as const;

/** Transparent points system the client can tune; every point is explained in the CRM note. */
export function scoreLead(a: Answers, serviceZips: Set<string>): ScoreResult {
  const reasons: string[] = [];
  if (a.zip && !serviceZips.has(a.zip)) return { score: 0, tier: "disqualified", reasons: [`ZIP ${a.zip} is outside the service area`], estValue: 0 };
  if (a.service === "install" && a.owner === false) return { score: 10, tier: "disqualified", reasons: ["Renter asking for an install (needs the owner)"], estValue: 0 };
  let s = 0;
  const add = (pts: number, why: string) => { s += pts; reasons.push(`+${pts} ${why}`); };
  if (a.service === "install") add(35, "new install / replacement (high value)");
  else if (a.service === "repair") add(25, "repair (urgent need)");
  else if (a.service === "maintenance") add(15, "maintenance plan (recurring revenue)");
  if (a.timeline === "asap") add(35, "needs it this week");
  else if (a.timeline === "month") add(20, "needs it this month");
  else if (a.timeline === "researching") add(5, "just researching");
  if (a.zip) add(15, "inside the service area");
  if (a.owner) add(15, "owns the property");
  // "just researching" goes to nurture no matter how good the rest looks: don't push a booking on them
  const tier = a.timeline === "researching" ? "cold" : s >= 70 ? "hot" : s >= 45 ? "warm" : "cold";
  return { score: s, tier, reasons, estValue: a.service ? VALUE[a.service] : 0 };
}

export const summary = (l: Lead, r: ScoreResult) =>
  `Lead score ${r.score}/100 (${r.tier}). Service: ${l.answers.service ?? "?"}, timeline: ${l.answers.timeline ?? "?"}, ` +
  `ZIP: ${l.answers.zip ?? "?"}, owner: ${l.answers.owner ?? "?"}. ${r.reasons.join("; ")}.`;
