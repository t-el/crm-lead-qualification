/**
 * The lead engine: intake (form, missed call, inbound SMS/email) -> qualification Q&A -> score -> CRM -> booking ->
 * follow-up sequences that stop the moment the lead replies, books or opts out.
 */
import { createHash, randomUUID } from "node:crypto";
import { availableSlots, fmtSlot, localParts, signBookingToken, verifyBookingToken } from "./booking.js";
import type { Config } from "./config.js";
import type { CrmAdapter, CrmStage } from "./crm/types.js";
import { log } from "./logger.js";
import { maskPhone, toE164 } from "./phone.js";
import { withRetry } from "./retry.js";
import type { Extractor } from "./qualify/extract.js";
import { QUESTIONS, firstMessage, nextQuestion } from "./qualify/questions.js";
import { scoreLead, summary } from "./qualify/score.js";
import type { Job, Store } from "./store.js";
import type { EmailSender, SmsSender } from "./twilio.js";
import { isMissedCall } from "./twilio.js";
import type { Channel, Lead, Source, Stage } from "./types.js";

const H = 3_600_000;

/** Follow-up sequences. Every step re-checks the lead before sending, so a reply, booking or STOP cancels the rest. */
export const SEQUENCES: Record<string, { afterMs: number; text?: (l: Lead, e: LeadEngine) => string; channel?: "email"; close?: boolean }[]> = {
  qualify_nudge: [
    { afterMs: 2 * H, text: (l) => `Just checking in! ${nextQuestion(l.answers)?.text ?? ""}` },
    { afterMs: 24 * H, text: (l) => `Still need help with your heating or cooling? ${nextQuestion(l.answers)?.text ?? ""}` },
    { afterMs: 72 * H, channel: "email", text: (l, e) => `Hi${l.name ? " " + l.name.split(" ")[0] : ""}, we never heard back, so this is our last message. If you still need ${e.cfg.BUSINESS_NAME}, just reply any time.` },
    { afterMs: 96 * H, close: true },
  ],
  booking_followup: [
    { afterMs: 1 * H, text: (l, e) => `Here's your booking link again, it takes 30 seconds: ${e.bookingLink(l)}` },
    { afterMs: 24 * H, text: (l, e) => `Spots for this week are filling up. Grab a time here: ${e.bookingLink(l)}` },
    { afterMs: 72 * H, channel: "email", text: (l, e) => `Last reminder from ${e.cfg.BUSINESS_NAME}: book your visit at ${e.bookingLink(l)} or reply with a time that works.` },
    { afterMs: 96 * H, close: true },
  ],
  appointment_reminder: [
    { afterMs: 0, text: (l, e) => `Reminder: your ${e.cfg.BUSINESS_NAME} visit is ${l.bookingAt ? fmtSlot(new Date(l.bookingAt), e.cfg.BUSINESS_TZ) : "soon"}. Reply C to reschedule.` },
  ],
};

const ACTIVE: Stage[] = ["new", "qualifying", "qualified", "handoff"];

export interface EngineDeps {
  cfg: Config;
  store: Store;
  crm: CrmAdapter;
  sms: SmsSender;
  email: EmailSender;
  extractor: Extractor;
  clock?: () => Date;
  sleepFn?: (ms: number) => Promise<void>;
}

export interface FormInput { name?: string; phone?: string; email?: string; message?: string; submissionId?: string }

export class LeadEngine {
  readonly cfg: Config;
  readonly store: Store;
  readonly crm: CrmAdapter;
  readonly sms: SmsSender;
  readonly email: EmailSender;
  private extractor: Extractor;
  readonly now: () => Date;
  private sleepFn?: (ms: number) => Promise<void>;

  constructor(d: EngineDeps) {
    this.cfg = d.cfg; this.store = d.store; this.crm = d.crm; this.sms = d.sms; this.email = d.email; this.extractor = d.extractor;
    this.now = d.clock ?? (() => new Date());
    this.sleepFn = d.sleepFn;
  }

  private iso = () => this.now().toISOString();

  // ------------------------------------------------------------------------------------------ intake
  async handleForm(f: FormInput): Promise<{ status: string; leadId?: string; error?: string }> {
    const phone = toE164(f.phone, this.cfg.DEFAULT_CALLING_CODE);
    const email = f.email?.trim().toLowerCase() || null;
    if (!phone && !(email && /^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email))) return { status: "invalid", error: "a valid phone or email is required" };
    const key = `form:${f.submissionId ?? createHash("sha256").update(`${phone}|${email}|${f.name}|${f.message}`).digest("hex").slice(0, 24)}`;
    if (!this.store.claim(key, this.iso())) return { status: "duplicate" };
    const existing = this.store.findLead(phone, email);
    if (existing && ACTIVE.includes(existing.stage)) {
      await this.syncCrm(existing, this.crmStage(existing), `Submitted the web form again: "${f.message ?? ""}"`);
      return { status: "existing_lead", leadId: existing.id };
    }
    const lead = this.newLead("web_form", f.name?.trim() ?? "", phone, email);
    log.info("new lead", { leadId: lead.id, source: lead.source, phone: maskPhone(phone) });
    await this.startQualification(lead, f.message ? `Form message: "${f.message}"` : null);
    return { status: "created", leadId: lead.id };
  }

  async handleVoiceStatus(p: Record<string, string>): Promise<{ status: string; leadId?: string }> {
    if (!this.store.claim(`call:${p.CallSid}`, this.iso())) return { status: "duplicate" };
    if (!isMissedCall(p)) return { status: "ignored" };
    const phone = toE164(p.From, this.cfg.DEFAULT_CALLING_CODE);
    if (!phone) return { status: "ignored" };
    const existing = this.store.findLead(phone, null);
    if (existing && (ACTIVE.includes(existing.stage) || existing.stage === "booked" || existing.stage === "opted_out")) {
      if (existing.stage !== "opted_out") await this.syncCrm(existing, this.crmStage(existing), "Called again and missed. Call back.");
      return { status: "existing_lead", leadId: existing.id };
    }
    const lead = this.newLead("missed_call", p.CallerName ?? "", phone, null);
    log.info("missed call -> text back", { leadId: lead.id, phone: maskPhone(phone) });
    await this.startQualification(lead, "Missed call. Automatic text-back sent.");
    return { status: "created", leadId: lead.id };
  }

  async handleInboundSms(p: Record<string, string>): Promise<{ status: string; leadId?: string }> {
    if (!this.store.claim(`sms:${p.MessageSid}`, this.iso())) return { status: "duplicate" };
    const phone = toE164(p.From, this.cfg.DEFAULT_CALLING_CODE);
    let lead = this.store.findLead(phone, null);
    if (!lead) {
      lead = this.newLead("inbound_sms", "", phone, null);
      this.store.addMessage({ leadId: lead.id, direction: "in", channel: "sms", body: p.Body ?? "", at: this.iso() });
      await this.startQualification(lead, `First text: "${p.Body}"`);
      return { status: "created", leadId: lead.id };
    }
    await this.handleReply(lead, p.Body ?? "", "sms");
    return { status: "processed", leadId: lead.id };
  }

  async handleEmailReply(from: string, text: string, messageId: string) {
    if (!this.store.claim(`email:${messageId}`, this.iso())) return { status: "duplicate" };
    const lead = this.store.findLead(null, from.trim().toLowerCase());
    if (!lead) return { status: "unknown_sender" };
    await this.handleReply(lead, text, "email");
    return { status: "processed", leadId: lead.id };
  }

  // ------------------------------------------------------------------------------------------ conversation
  async handleReply(lead: Lead, text: string, channel: Channel) {
    this.store.addMessage({ leadId: lead.id, direction: "in", channel, body: text, at: this.iso() });
    lead.lastInboundAt = this.iso();
    const cancelled = this.store.cancelJobs(lead.id, ["qualify_nudge", "booking_followup"]);   // stop-on-reply
    if (cancelled) log.info("lead replied, follow-ups stopped", { leadId: lead.id, cancelled });

    const q = nextQuestion(lead.answers);
    const ex = await this.extractor.extract(q?.key ?? "service", q?.text ?? "", text);
    if (ex.intent === "stop") {
      lead.stage = "opted_out";
      this.store.cancelJobs(lead.id);
      this.save(lead);
      await this.syncCrm(lead, "lost", "Replied STOP: opted out of SMS. Do not text.", { sms_opt_out: true });
      return;
    }
    if (lead.stage === "opted_out") {
      if (ex.intent === "start") { lead.stage = "qualifying"; this.save(lead); await (nextQuestion(lead.answers) ? this.askNext(lead) : this.finishQualification(lead)); }
      return;   // never text someone who opted out
    }
    if (ex.intent === "human" || (lead.stage === "qualifying" || lead.stage === "new") && ex.intent === "unclear" && lead.clarifications >= 1) {
      lead.stage = "handoff";
      this.save(lead);
      await this.send(lead, `No problem, a team member will call you shortly (we answer 8am to 6pm).`);
      await this.syncCrm(lead, "needs_callback", `Needs a call back. Last message: "${text}"`);
      return;
    }
    if (lead.stage === "new" || lead.stage === "qualifying") {
      if (ex.intent !== "answer" || !q) {
        lead.clarifications++;
        this.save(lead);
        await this.send(lead, q?.clarify ?? "Sorry, could you rephrase that?");
        this.schedule(lead, "qualify_nudge");
        return;
      }
      (lead.answers as Record<string, unknown>)[q.key] = ex.value;
      lead.clarifications = 0;
      lead.stage = "qualifying";
      this.save(lead);
      log.info("answer captured", { leadId: lead.id, question: q.key, value: ex.value, by: ex.by });
      if (nextQuestion(lead.answers)) return this.askNext(lead);
      return this.finishQualification(lead);
    }
    // qualified / booked / nurture: a person should read it
    this.save(lead);
    await this.send(lead, "Thanks! A team member will get back to you shortly.");
    await this.syncCrm(lead, this.crmStage(lead), `Lead replied: "${text}"`);
  }

  private async startQualification(lead: Lead, note: string | null) {
    this.save(lead);
    await this.syncCrm(lead, "new_lead", note);
    await this.send(lead, firstMessage(this.cfg.BUSINESS_NAME, lead.name, lead.source));
    this.schedule(lead, "qualify_nudge");
  }

  private async askNext(lead: Lead) {
    const q = nextQuestion(lead.answers)!;
    await this.send(lead, q.text);
    this.schedule(lead, "qualify_nudge");
  }

  private async finishQualification(lead: Lead) {
    const r = scoreLead(lead.answers, this.cfg.serviceZips);
    lead.score = r.score;
    lead.tier = r.tier;
    const note = summary(lead, r);
    const props = { lead_score: r.score, lead_tier: r.tier, hvac_service: lead.answers.service ?? null,
                    hvac_timeline: lead.answers.timeline ?? null, zip: lead.answers.zip ?? null, owns_property: lead.answers.owner ?? null };
    if (r.tier === "hot" || r.tier === "warm") {
      lead.stage = "qualified";
      this.save(lead);
      await this.syncCrm(lead, "qualified", note, props, r.estValue);
      await this.send(lead, `Great news, we can help! Pick a time for your ${lead.answers.service} visit here: ${this.bookingLink(lead)}`);
      this.schedule(lead, "booking_followup");
    } else if (r.tier === "cold") {
      lead.stage = "nurture";
      this.save(lead);
      await this.syncCrm(lead, "nurture", note, props, r.estValue);
      await this.send(lead, `Thanks! No rush at all. When you're ready, book any time here: ${this.bookingLink(lead)}`);
    } else {
      lead.stage = "disqualified";
      this.save(lead);
      await this.syncCrm(lead, "disqualified", note, props, 0);
      await this.send(lead, r.reasons[0].includes("service area")
        ? `Thanks for the details! Unfortunately ${lead.answers.zip} is outside our service area, so we can't send a technician. Sorry about that.`
        : `Thanks! For installs we need to speak with the property owner. Please ask them to contact us and we'll take it from there.`);
    }
    log.info("lead qualified", { leadId: lead.id, score: r.score, tier: r.tier });
  }

  // ------------------------------------------------------------------------------------------ booking
  bookingLink(lead: Lead) {
    return `${this.cfg.PUBLIC_URL}/book/${signBookingToken(lead.id, new Date(this.now().getTime() + 14 * 24 * H), this.cfg.BOOKING_SECRET)}`;
  }

  bookingContext(token: string) {
    const v = verifyBookingToken(token, this.cfg.BOOKING_SECRET, this.now());
    const lead = v ? this.store.getLead(v.leadId) : null;
    if (!lead) return null;
    return { lead, slots: availableSlots(this.now(), this.cfg.BUSINESS_TZ, this.store.takenSlots()) };
  }

  async book(token: string, slotIso: string): Promise<{ ok: boolean; error?: string; lead?: Lead }> {
    const ctx = this.bookingContext(token);
    if (!ctx) return { ok: false, error: "This booking link is invalid or has expired." };
    const { lead, slots } = ctx;
    if (lead.stage === "booked") return { ok: true, lead };   // double submit
    if (!slots.some((s) => s.toISOString() === slotIso)) return { ok: false, error: "That time is no longer available." };
    if (!this.store.bookSlot(lead.id, slotIso, this.iso())) return { ok: false, error: "That time was just taken. Please pick another." };
    lead.stage = "booked";
    lead.bookingAt = slotIso;
    this.store.cancelJobs(lead.id);
    this.save(lead);
    const when = fmtSlot(new Date(slotIso), this.cfg.BUSINESS_TZ);
    await this.syncCrm(lead, "appointment_booked", `Booked a ${lead.answers.service ?? ""} visit for ${when} (${this.cfg.BUSINESS_TZ}).`);
    await this.send(lead, `You're booked for ${when}. We'll text you a reminder before the visit. Reply C to reschedule.`);
    // reminder the day before; for same-day bookings, 2 hours before
    const slotMs = new Date(slotIso).getTime();
    const remindAt = slotMs - 24 * H > this.now().getTime() + H ? slotMs - 24 * H : slotMs - 2 * H;
    if (remindAt > this.now().getTime()) this.store.addJob(lead.id, "appointment_reminder", 0, new Date(remindAt).toISOString());
    log.info("appointment booked", { leadId: lead.id, slot: slotIso });
    return { ok: true, lead };
  }

  // ------------------------------------------------------------------------------------------ follow-ups
  private schedule(lead: Lead, sequence: string) {
    this.store.cancelJobs(lead.id, [sequence]);
    SEQUENCES[sequence].forEach((s, i) => this.store.addJob(lead.id, sequence, i, new Date(this.now().getTime() + s.afterMs).toISOString()));
  }

  /** Quiet hours in the business time zone (TCPA-friendly). Returns the next allowed send time, or null if now is fine. */
  quietUntil(at: Date): Date | null {
    const ok = (d: Date) => { const h = localParts(d, this.cfg.BUSINESS_TZ).hour; return h >= this.cfg.QUIET_HOURS_END && h < this.cfg.QUIET_HOURS_START; };
    if (ok(at)) return null;
    let t = new Date(Math.ceil(at.getTime() / (15 * 60_000)) * 15 * 60_000);
    while (!ok(t)) t = new Date(t.getTime() + 15 * 60_000);
    return t;
  }

  /** Run due follow-ups. Call from cron every few minutes (`npm run tick`) or POST /admin/tick. */
  async tick(): Promise<Record<string, number>> {
    const out = { sent: 0, cancelled: 0, deferred: 0, closed: 0, failed: 0 };
    for (const job of this.store.dueJobs(this.iso())) {
      const lead = this.store.getLead(job.leadId);
      const step = SEQUENCES[job.sequence]?.[job.step];
      if (!lead || !step || !this.stillRelevant(lead, job)) {
        this.store.updateJob(job.id, { status: "cancelled" });
        out.cancelled++;
        continue;
      }
      if (step.close) {
        this.store.updateJob(job.id, { status: "done" });
        lead.stage = lead.stage === "qualified" ? "qualified" : "no_response";
        this.save(lead);
        await this.syncCrm(lead, lead.stage === "qualified" ? "qualified" : "lost",
          job.sequence === "booking_followup" ? "No booking after 3 follow-ups. Call manually." : "No reply after 3 follow-ups. Marked no response.");
        out.closed++;
        continue;
      }
      const quiet = this.quietUntil(this.now());
      if (quiet) {
        this.store.updateJob(job.id, { dueAt: quiet.toISOString() });
        out.deferred++;
        continue;
      }
      try {
        await this.send(lead, step.text!(lead, this), step.channel, `job:${job.id}`, true);
        this.store.updateJob(job.id, { status: "sent", attempts: job.attempts + 1 });
        out.sent++;
      } catch (err) {
        const attempts = job.attempts + 1;
        this.store.updateJob(job.id, attempts >= 3 ? { status: "failed", attempts, lastError: String(err) }
          : { attempts, lastError: String(err), dueAt: new Date(this.now().getTime() + 15 * 60_000).toISOString() });
        log.warn("follow-up send failed", { jobId: job.id, attempts, error: String(err) });
        out.failed++;
      }
    }
    return out;
  }

  private stillRelevant(lead: Lead, job: Job): boolean {
    if (lead.stage === "opted_out") return false;
    if (job.sequence === "qualify_nudge") return lead.stage === "new" || lead.stage === "qualifying";
    if (job.sequence === "booking_followup") return lead.stage === "qualified";
    if (job.sequence === "appointment_reminder") return lead.stage === "booked" && !!lead.bookingAt && new Date(lead.bookingAt) > this.now();
    return true;
  }

  // ------------------------------------------------------------------------------------------ plumbing
  private newLead(source: Source, name: string, phone: string | null, email: string | null): Lead {
    const t = this.iso();
    return { id: `lead_${randomUUID().slice(0, 8)}`, name, phone, email, source, channel: phone ? "sms" : "email",
      stage: "new", step: 0, clarifications: 0, answers: {}, score: null, tier: null, crmContactId: null, crmDealId: null,
      bookingAt: null, lastInboundAt: null, createdAt: t, updatedAt: t };
  }

  private save(lead: Lead) {
    lead.updatedAt = this.iso();
    this.store.saveLead(lead);
  }

  /** Send with retries. Conversation messages never throw (the follow-up sequence will reach the lead later);
   *  follow-up jobs pass `throwOnFail` so tick() can reschedule them. */
  private async send(lead: Lead, body: string, prefer?: "email", key = `msg:${lead.id}:${randomUUID()}`, throwOnFail = false) {
    const channel: Channel = prefer === "email" && lead.email ? "email" : lead.phone ? "sms" : "email";
    try {
      await withRetry(() => channel === "sms" ? this.sms.send(lead.phone!, body, key)
        : this.email.send(lead.email!, `${this.cfg.BUSINESS_NAME}`, body, key),
        { attempts: this.cfg.RETRY_ATTEMPTS, baseDelayMs: this.cfg.RETRY_BASE_DELAY_MS, step: `${channel}_send`, sleepFn: this.sleepFn });
      this.store.addMessage({ leadId: lead.id, direction: "out", channel, body, at: this.iso() });
    } catch (err) {
      this.store.addMessage({ leadId: lead.id, direction: "out", channel, body: `[NOT DELIVERED: ${String(err)}] ${body}`, at: this.iso() });
      log.error("message not delivered", { leadId: lead.id, channel, error: String(err) });
      if (throwOnFail) throw err;
    }
  }

  crmStage(l: Lead): CrmStage {
    return ({ new: "new_lead", qualifying: "new_lead", qualified: "qualified", booked: "appointment_booked", disqualified: "disqualified",
      nurture: "nurture", no_response: "lost", handoff: "needs_callback", opted_out: "lost" } as const)[l.stage];
  }

  /** Contact upsert + deal stage + note. Idempotent; on failure the lead keeps moving and the sync goes to the DLQ. */
  async syncCrm(lead: Lead, stage: CrmStage, note: string | null, props: Record<string, string | number | boolean | null> = {},
                amount?: number, queueOnFail = true) {
    try {
      const contactId = await this.crm.upsertContact({ name: lead.name, phone: lead.phone, email: lead.email,
        source: lead.source, tags: ["ai-qualified", lead.source], properties: props });
      lead.crmContactId = contactId;
      lead.crmDealId = await this.crm.upsertDeal(lead, contactId, stage, amount ?? (lead.answers.service ? { install: 8500, repair: 450, maintenance: 240 }[lead.answers.service] : 0));
      if (note) await this.crm.addNote(contactId, note);
      this.save(lead);
      return true;
    } catch (err) {
      if (!queueOnFail) return false;
      const id = this.store.addDeadLetter(lead.id, stage, note, String(err), this.iso());
      log.error("CRM sync failed, queued for replay", { leadId: lead.id, stage, dlqId: id, error: String(err) });
      return false;
    }
  }

  async replayDeadLetter(id: number) {
    const dl = this.store.deadLetters().find((d) => d.id === id);
    if (!dl) throw new Error(`dead letter ${id} not open`);
    const lead = this.store.getLead(dl.leadId)!;
    const ok = await this.syncCrm(lead, dl.stage as CrmStage, dl.note, {}, undefined, false);
    if (ok) this.store.resolveDeadLetter(id);
    return ok;
  }
}

export const questionCount = QUESTIONS.length;
