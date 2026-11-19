/**
 * GoHighLevel (LeadConnector API v2) adapter.
 *   contacts:      POST /contacts/upsert  (dedupes on email/phone per the location's settings)
 *   opportunities: POST /opportunities/   then PUT /opportunities/{id} to move stages
 *   notes:         POST /contacts/{id}/notes
 * Every call sends `Version: 2021-07-28` and a location-scoped token.
 */
import { checkResponse, withRetry } from "../retry.js";
import type { Lead } from "../types.js";
import type { ContactInput, CrmAdapter, CrmStage } from "./types.js";

export const GHL_STAGES: Record<CrmStage, string> = {   // stage ids from your pipeline (GET /opportunities/pipelines)
  new_lead: "stage_new", qualified: "stage_qualified", appointment_booked: "stage_booked", needs_callback: "stage_callback",
  nurture: "stage_nurture", disqualified: "stage_disqualified", lost: "stage_lost",
};

export class GoHighLevelAdapter implements CrmAdapter {
  readonly name = "gohighlevel" as const;
  constructor(private token: string, private locationId: string, private pipelineId: string,
              private fetchFn: typeof fetch = fetch, private base = "https://services.leadconnectorhq.com",
              private retry: { attempts: number; baseDelayMs: number; sleepFn?: (ms: number) => Promise<void> } = { attempts: 4, baseDelayMs: 500 }) {}

  private async call<T>(method: string, path: string, body: unknown, step: string): Promise<T> {
    return withRetry(async () => {
      const res = await checkResponse(await this.fetchFn(this.base + path, {
        method, headers: { Authorization: `Bearer ${this.token}`, Version: "2021-07-28", "Content-Type": "application/json", Accept: "application/json" },
        body: JSON.stringify(body),
      }), `ghl ${method} ${path}`);
      return (await res.json()) as T;
    }, { ...this.retry, step });
  }

  async upsertContact(c: ContactInput): Promise<string> {
    const [firstName, ...rest] = c.name.split(" ");
    const customFields = Object.entries(c.properties ?? {}).map(([key, field_value]) => ({ key, field_value }));
    const r = await this.call<{ contact: { id: string }; new: boolean }>("POST", "/contacts/upsert", {
      locationId: this.locationId, firstName, lastName: rest.join(" "), phone: c.phone ?? undefined, email: c.email ?? undefined,
      source: c.source, tags: c.tags, customFields,
    }, "crm_upsert_contact");
    return r.contact.id;
  }

  async upsertDeal(lead: Lead, contactId: string, stage: CrmStage, amount: number): Promise<string> {
    const status = stage === "disqualified" || stage === "lost" ? "lost" : "open";
    const body = { pipelineId: this.pipelineId, pipelineStageId: GHL_STAGES[stage], status, monetaryValue: amount,
                   name: `${lead.name || lead.phone} - ${lead.answers.service ?? "HVAC"}` };
    if (lead.crmDealId) {
      await this.call("PUT", `/opportunities/${lead.crmDealId}`, body, "crm_update_deal");
      return lead.crmDealId;
    }
    const r = await this.call<{ opportunity: { id: string } }>("POST", "/opportunities/",
      { ...body, locationId: this.locationId, contactId }, "crm_create_deal");
    return r.opportunity.id;
  }

  async addNote(contactId: string, body: string): Promise<void> {
    await this.call("POST", `/contacts/${contactId}/notes`, { body }, "crm_add_note");
  }
}
