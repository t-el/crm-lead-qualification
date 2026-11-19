/**
 * HubSpot CRM v3 adapter.
 *   contacts: POST /crm/v3/objects/contacts/batch/upsert (idProperty=email) or search by phone + create/patch
 *   deals:    POST /crm/v3/objects/deals with an association to the contact (typeId 3), PATCH to move stages
 *   notes:    POST /crm/v3/objects/notes associated to the contact (typeId 202)
 */
import { checkResponse, withRetry } from "../retry.js";
import type { Lead } from "../types.js";
import type { ContactInput, CrmAdapter, CrmStage } from "./types.js";

const STAGES: Record<CrmStage, string> = {   // default HubSpot sales pipeline ids; map yours in HANDOFF.md
  new_lead: "appointmentscheduled", qualified: "qualifiedtobuy", appointment_booked: "presentationscheduled",
  needs_callback: "decisionmakerboughtin", nurture: "contractsent", disqualified: "closedlost", lost: "closedlost",
};

export class HubSpotAdapter implements CrmAdapter {
  readonly name = "hubspot" as const;
  constructor(private token: string, private fetchFn: typeof fetch = fetch, private base = "https://api.hubapi.com",
              private retry: { attempts: number; baseDelayMs: number; sleepFn?: (ms: number) => Promise<void> } = { attempts: 4, baseDelayMs: 500 }, private pipeline = "default") {}

  private async call<T>(method: string, path: string, body: unknown, step: string): Promise<T> {
    return withRetry(async () => {
      const res = await checkResponse(await this.fetchFn(this.base + path, {
        method, headers: { Authorization: `Bearer ${this.token}`, "Content-Type": "application/json" },
        body: body === undefined ? undefined : JSON.stringify(body),
      }), `hubspot ${method} ${path.split("?")[0]}`);
      return (res.status === 204 ? {} : await res.json()) as T;
    }, { ...this.retry, step });
  }

  async upsertContact(c: ContactInput): Promise<string> {
    const [firstname, ...rest] = c.name.split(" ");
    const props = { firstname, lastname: rest.join(" "), phone: c.phone, email: c.email, lead_source: c.source,
                    hs_lead_status: "NEW", ...c.properties };
    if (c.email) {
      const r = await this.call<{ results: { id: string }[] }>("POST", "/crm/v3/objects/contacts/batch/upsert",
        { inputs: [{ idProperty: "email", id: c.email, properties: props }] }, "crm_upsert_contact");
      return r.results[0].id;
    }
    // missed calls have no email: find by phone, then create or update
    const found = await this.call<{ results: { id: string }[] }>("POST", "/crm/v3/objects/contacts/search",
      { filterGroups: [{ filters: [{ propertyName: "phone", operator: "EQ", value: c.phone }] }], limit: 1 }, "crm_search_contact");
    if (found.results[0]) {
      await this.call("PATCH", `/crm/v3/objects/contacts/${found.results[0].id}`, { properties: props }, "crm_update_contact");
      return found.results[0].id;
    }
    return (await this.call<{ id: string }>("POST", "/crm/v3/objects/contacts", { properties: props }, "crm_create_contact")).id;
  }

  async upsertDeal(lead: Lead, contactId: string, stage: CrmStage, amount: number): Promise<string> {
    const properties = { dealname: `${lead.name || lead.phone} - ${lead.answers.service ?? "HVAC"}`, pipeline: this.pipeline,
                         dealstage: STAGES[stage], amount: String(amount) };
    if (lead.crmDealId) {
      await this.call("PATCH", `/crm/v3/objects/deals/${lead.crmDealId}`, { properties }, "crm_update_deal");
      return lead.crmDealId;
    }
    const r = await this.call<{ id: string }>("POST", "/crm/v3/objects/deals", {
      properties, associations: [{ to: { id: contactId }, types: [{ associationCategory: "HUBSPOT_DEFINED", associationTypeId: 3 }] }],
    }, "crm_create_deal");
    return r.id;
  }

  async addNote(contactId: string, body: string): Promise<void> {
    await this.call("POST", "/crm/v3/objects/notes", {
      properties: { hs_note_body: body, hs_timestamp: new Date().toISOString() },
      associations: [{ to: { id: contactId }, types: [{ associationCategory: "HUBSPOT_DEFINED", associationTypeId: 202 }] }],
    }, "crm_add_note");
  }
}
