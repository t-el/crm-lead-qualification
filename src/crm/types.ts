import type { Lead } from "../types.js";

/** Pipeline stages, mapped to each CRM's own stage ids in the adapter. */
export type CrmStage = "new_lead" | "qualified" | "appointment_booked" | "disqualified" | "nurture" | "needs_callback" | "lost";

export interface ContactInput {
  name: string;
  phone: string | null;
  email: string | null;
  source: string;
  tags: string[];
  properties?: Record<string, string | number | boolean | null>;
}

export interface CrmAdapter {
  readonly name: "hubspot" | "gohighlevel";
  /** Create or update by email/phone. Safe to call repeatedly. */
  upsertContact(c: ContactInput): Promise<string>;
  /** Create the deal/opportunity once, then move it between stages. */
  upsertDeal(lead: Lead, contactId: string, stage: CrmStage, amount: number): Promise<string>;
  addNote(contactId: string, body: string): Promise<void>;
}
