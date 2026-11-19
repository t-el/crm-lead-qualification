import { describe, expect, it } from "vitest";
import { H, T0, answerAll, makeEngine, smsParams } from "./helpers.js";

const JANE = { name: "Jane Doe", phone: "(212) 555-0142", email: "jane@example.com", message: "AC is making a loud noise" };
const PHONE = "+12125550142";
const tokenFrom = (body: string) => body.match(/\/book\/([\w.-]+)/)![1];
const pending = (t: ReturnType<typeof makeEngine>, id: string) => t.engine.store.jobs(id).filter((j) => j.status === "pending");

async function qualifiedLead(t = makeEngine()) {
  const r = await t.engine.handleForm(JANE);
  await answerAll(t.engine, PHONE, ["2", "asap", "10001", "yes"]);
  return { t, id: r.leadId! };
}

describe("intake", () => {
  it("texts a web-form lead instantly and creates the CRM contact + deal", async () => {
    const t = makeEngine();
    const r = await t.engine.handleForm(JANE);
    expect(r.status).toBe("created");
    expect(t.sms.sent[0]).toMatchObject({ to: PHONE });
    expect(t.sms.sent[0].body).toMatch(/^Hi Jane, thanks for contacting Atlas Heating & Cooling!.*Reply 1/);
    const deal = [...t.mockCrm.state.deals.values()][0];
    expect(deal.dealstage).toBe("appointmentscheduled");
    expect(t.mockCrm.state.notes[0].body).toContain("loud noise");
    expect(pending(t, r.leadId!).map((j) => j.sequence)).toEqual(["qualify_nudge", "qualify_nudge", "qualify_nudge", "qualify_nudge"]);
  });

  it("dedupes repeated form posts and rejects leads with no way to reach them", async () => {
    const t = makeEngine();
    await t.engine.handleForm(JANE);
    expect((await t.engine.handleForm(JANE)).status).toBe("duplicate");
    expect((await t.engine.handleForm({ ...JANE, message: "also the heat" })).status).toBe("existing_lead");
    expect((await t.engine.handleForm({ name: "x", phone: "123", email: "not-an-email" })).status).toBe("invalid");
    expect(t.sms.sent).toHaveLength(1);
  });

  it("texts back a missed call once, using phone search for the CRM contact", async () => {
    const t = makeEngine();
    const call = { CallSid: "CA1", From: "+17185550199", To: "+15550100200", CallStatus: "no-answer" };
    expect((await t.engine.handleVoiceStatus(call)).status).toBe("created");
    expect((await t.engine.handleVoiceStatus(call)).status).toBe("duplicate");
    expect((await t.engine.handleVoiceStatus({ ...call, CallSid: "CA2", CallStatus: "completed" })).status).toBe("ignored");
    expect(t.sms.sent).toHaveLength(1);
    expect(t.sms.sent[0].body).toContain("Sorry we missed your call");
    expect(t.mockCrm.state.requests.map((r) => r.path)).toContain("/crm/v3/objects/contacts/search");
  });

  it("ignores a duplicate inbound SMS webhook (Twilio retries)", async () => {
    const t = makeEngine();
    await t.engine.handleForm(JANE);
    const p = smsParams(PHONE, "2");
    await t.engine.handleInboundSms(p);
    expect((await t.engine.handleInboundSms(p)).status).toBe("duplicate");
    expect(t.engine.store.listLeads()[0].answers).toEqual({ service: "repair" });
  });
});

describe("qualification", () => {
  it("asks 4 questions, scores, moves the deal and sends a booking link", async () => {
    const { t, id } = await qualifiedLead();
    const lead = t.engine.store.getLead(id)!;
    expect(lead).toMatchObject({ stage: "qualified", score: 90, tier: "hot", answers: { service: "repair", timeline: "asap", zip: "10001", owner: true } });
    expect(t.sms.sent.at(-1)!.body).toMatch(/Pick a time for your repair visit here: https:\/\/leads\.example\.com\/book\//);
    const deal = t.mockCrm.state.deals.get(lead.crmDealId!)!;
    expect(deal.history).toEqual(["appointmentscheduled", "qualifiedtobuy"]);
    expect(t.mockCrm.state.contacts.get(lead.crmContactId!)).toMatchObject({ lead_score: 90, lead_tier: "hot", hvac_service: "repair" });
    expect(t.mockCrm.state.notes.at(-1)!.body).toMatch(/Lead score 90\/100 \(hot\)/);
    expect(pending(t, id).every((j) => j.sequence === "booking_followup")).toBe(true);
  });

  it("disqualifies out-of-area leads politely without a booking link", async () => {
    const t = makeEngine();
    const r = await t.engine.handleForm(JANE);
    await answerAll(t.engine, PHONE, ["1", "this week", "90210", "yes"]);
    expect(t.engine.store.getLead(r.leadId!)!.stage).toBe("disqualified");
    expect(t.sms.sent.at(-1)!.body).toContain("outside our service area");
    expect(t.sms.sent.at(-1)!.body).not.toContain("/book/");
    expect([...t.mockCrm.state.deals.values()][0].dealstage).toBe("closedlost");
  });

  it("puts researchers in nurture with no pushy follow-ups", async () => {
    const t = makeEngine();
    const r = await t.engine.handleForm(JANE);
    await answerAll(t.engine, PHONE, ["1", "just looking for now", "11211", "yes"]);
    expect(t.engine.store.getLead(r.leadId!)!.stage).toBe("nurture");
    expect(pending(t, r.leadId!)).toHaveLength(0);
  });

  it("re-asks once, then hands an unclear lead to a human", async () => {
    const t = makeEngine();
    const r = await t.engine.handleForm(JANE);
    await t.engine.handleInboundSms(smsParams(PHONE, "hmm"));
    expect(t.sms.sent.at(-1)!.body).toContain("Sorry, I didn't catch that");
    await t.engine.handleInboundSms(smsParams(PHONE, "what?"));
    expect(t.engine.store.getLead(r.leadId!)!.stage).toBe("handoff");
    expect([...t.mockCrm.state.deals.values()][0].dealstage).toBe("decisionmakerboughtin");
  });

  it("works over email for leads without a phone", async () => {
    const t = makeEngine();
    const r = await t.engine.handleForm({ name: "Sam Lee", email: "Sam@Example.com" });
    expect(t.email.sent[0].to).toBe("sam@example.com");
    let n = 0;
    for (const a of ["3", "next week", "10001", "we own it"]) await t.engine.handleEmailReply("sam@example.com", a, `m${n++}`);
    expect(t.engine.store.getLead(r.leadId!)).toMatchObject({ stage: "qualified", tier: "warm" });
    expect(t.email.sent.at(-1)!.text).toContain("/book/");
    expect(t.sms.sent).toHaveLength(0);
  });
});

describe("follow-up sequences", () => {
  it("stops pending follow-ups the moment the lead replies", async () => {
    const t = makeEngine();
    const r = await t.engine.handleForm(JANE);
    t.advance(2 * H);
    expect(await t.engine.tick()).toMatchObject({ sent: 1 });            // nudge #1
    t.advance(1 * H);
    await t.engine.handleInboundSms(smsParams(PHONE, "repair"));       // reply mid-sequence
    const jobs = t.engine.store.jobs(r.leadId!);
    expect(jobs.filter((j) => j.status === "cancelled")).toHaveLength(3);
    expect(t.sms.sent.at(-1)!.body).toContain("How soon do you need us");   // next question, new nudge timer
    t.advance(22 * H);                                                   // old nudge #2 would be due now
    expect(await t.engine.tick()).toMatchObject({ sent: 1 });           // only the NEW sequence's nudge #1
    expect(t.sms.sent.at(-1)!.body).toMatch(/^Just checking in! How soon/);
    expect(t.sms.sent.some((m) => m.body.startsWith("Still need help"))).toBe(false);
  });

  it("runs the full no-reply sequence (SMS, SMS, email) then closes as no_response", async () => {
    const t = makeEngine();
    const r = await t.engine.handleForm(JANE);
    for (const h of [2, 22, 48, 24]) { t.advance(h * H); await t.engine.tick(); }
    expect(t.sms.sent).toHaveLength(3);
    expect(t.email.sent).toHaveLength(1);
    expect(t.email.sent[0].text).toContain("this is our last message");
    expect(t.engine.store.getLead(r.leadId!)!.stage).toBe("no_response");
    expect([...t.mockCrm.state.deals.values()][0].dealstage).toBe("closedlost");
  });

  it("never texts during quiet hours in the business time zone", async () => {
    const t = makeEngine({}, new Date("2026-11-18T00:30:00Z"));          // 19:30 New York
    await t.engine.handleVoiceStatus({ CallSid: "CA9", From: "+17185550123", CallStatus: "busy" });
    t.advance(2 * H);                                                     // 21:30 NY
    expect(await t.engine.tick()).toMatchObject({ sent: 0, deferred: 1 });
    const job = t.engine.store.jobs().find((j) => j.status === "pending" && j.step === 0)!;
    expect(job.dueAt).toBe("2026-11-18T13:00:00.000Z");                  // 08:00 NY
    t.setNow(new Date("2026-11-18T13:00:00Z"));
    expect(await t.engine.tick()).toMatchObject({ sent: 1 });
  });

  it("handles STOP: opts out, cancels everything and never texts again until START", async () => {
    const t = makeEngine();
    const r = await t.engine.handleForm(JANE);
    await t.engine.handleInboundSms(smsParams(PHONE, "STOP"));
    expect(t.engine.store.getLead(r.leadId!)!.stage).toBe("opted_out");
    expect(pending(t, r.leadId!)).toHaveLength(0);
    const before = t.sms.sent.length;
    await t.engine.handleInboundSms(smsParams(PHONE, "2"));
    await t.engine.handleVoiceStatus({ CallSid: "CA7", From: PHONE, CallStatus: "no-answer" });
    t.advance(100 * H); await t.engine.tick();
    expect(t.sms.sent.length).toBe(before);
    expect(t.mockCrm.state.contacts.get(t.engine.store.getLead(r.leadId!)!.crmContactId!)!.sms_opt_out).toBe(true);
    await t.engine.handleInboundSms(smsParams(PHONE, "START"));
    expect(t.sms.sent.at(-1)!.body).toContain("What can we help with");
  });

  it("retries a Twilio outage and still delivers", async () => {
    const t = makeEngine();
    t.sms.failTimes = 2;
    await t.engine.handleForm(JANE);
    expect(t.sms.sent).toHaveLength(1);
    expect(t.sleeps.length).toBeGreaterThanOrEqual(2);
  });
});

describe("booking", () => {
  it("books a slot, cancels follow-ups, schedules a reminder and moves the deal", async () => {
    const { t, id } = await qualifiedLead();
    const token = tokenFrom(t.sms.sent.at(-1)!.body);
    const ctx = t.engine.bookingContext(token)!;
    const slot = ctx.slots[0].toISOString();
    const r = await t.engine.book(token, slot);
    expect(r.ok).toBe(true);
    const lead = t.engine.store.getLead(id)!;
    expect(lead).toMatchObject({ stage: "booked", bookingAt: slot });
    expect(pending(t, id).map((j) => j.sequence)).toEqual(["appointment_reminder"]);
    expect(pending(t, id)[0].dueAt).toBe(new Date(ctx.slots[0].getTime() - 2 * 3_600_000).toISOString());   // same-day: 2h before
    expect(t.mockCrm.state.deals.get(lead.crmDealId!)!.history.at(-1)).toBe("presentationscheduled");
    t.advance(4 * 3_600_000);                                            // tick missed the reminder window: never remind after the visit
    expect(await t.engine.tick()).toMatchObject({ sent: 0, cancelled: 1 });
    expect((await t.engine.book(token, slot)).ok).toBe(true);           // double submit is harmless
    expect(t.engine.bookingContext(token)!.slots.map((s) => s.toISOString())).not.toContain(slot);
  });

  it("rejects a slot someone else just took, and invalid links", async () => {
    const t = makeEngine();
    const a = await qualifiedLead(t);
    await t.engine.handleForm({ name: "Bob Ray", phone: "212-555-0177" });
    await answerAll(t.engine, "+12125550177", ["2", "1", "10002", "y"]);
    const tokA = tokenFrom(t.sms.sent.find((m) => m.to === PHONE && m.body.includes("/book/"))!.body);
    const tokB = tokenFrom(t.sms.sent.at(-1)!.body);
    const slot = t.engine.bookingContext(tokA)!.slots[0].toISOString();
    expect((await t.engine.book(tokA, slot)).ok).toBe(true);
    expect(await t.engine.book(tokB, slot)).toMatchObject({ ok: false, error: "That time is no longer available." });
    expect((await t.engine.book(tokB + "x", slot)).ok).toBe(false);
    expect(a.id).toBeTruthy();
  });
});

describe("CRM reliability", () => {
  it("retries HubSpot 429s honouring Retry-After", async () => {
    const t = makeEngine();
    t.mockCrm.state.faults.status429 = 3;
    await t.engine.handleForm(JANE);
    expect(t.sleeps.filter((ms) => ms >= 1000)).toHaveLength(3);
    expect(t.engine.store.deadLetters()).toHaveLength(0);
    expect(t.mockCrm.state.contacts.size).toBe(1);
  });

  it("dead-letters a rejected sync without blocking the lead, then replays it", async () => {
    const t = makeEngine();
    t.mockCrm.state.faults.rejectEmailContaining = "jane@";
    const r = await t.engine.handleForm(JANE);
    expect(t.sms.sent).toHaveLength(1);                                  // lead still got the text
    const [dl] = t.engine.store.deadLetters();
    expect(dl).toMatchObject({ leadId: r.leadId, stage: "new_lead" });
    expect(dl.error).toContain("INVALID_EMAIL");
    expect(await t.engine.replayDeadLetter(dl.id)).toBe(false);          // still failing: stays open, no duplicate
    expect(t.engine.store.deadLetters()).toHaveLength(1);
    t.mockCrm.state.faults.rejectEmailContaining = undefined;
    expect(await t.engine.replayDeadLetter(dl.id)).toBe(true);
    expect(t.engine.store.deadLetters()).toHaveLength(0);
    expect(t.mockCrm.state.contacts.size).toBe(1);
  });

  it("runs the same flow against GoHighLevel", async () => {
    const t = makeEngine({ CRM_PROVIDER: "gohighlevel" });
    t.mockCrm.state.faults.status500 = 1;
    const { id } = await qualifiedLead(t);
    const lead = t.engine.store.getLead(id)!;
    expect(lead.crmContactId).toMatch(/^ghl_c_/);
    const opp = t.mockCrm.state.deals.get(lead.crmDealId!)!;
    expect(opp).toMatchObject({ pipelineId: "pipe_demo", status: "open", monetaryValue: 450 });
    expect(opp.history).toEqual(["stage_new", "stage_qualified"]);
    expect(t.mockCrm.state.contacts.get(lead.crmContactId!)!.tags).toEqual(["ai-qualified", "web_form"]);
    expect(t.mockCrm.state.contacts.size).toBe(1);
  });
});
