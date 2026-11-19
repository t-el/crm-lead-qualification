/** Wires config -> adapters (real or mock) -> engine, and the HTTP server. */
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { join } from "node:path";
import type { Config } from "./config.js";
import { GoHighLevelAdapter } from "./crm/gohighlevel.js";
import { HubSpotAdapter } from "./crm/hubspot.js";
import { createMockCrm } from "./crm/mock.js";
import type { CrmAdapter } from "./crm/types.js";
import { LeadEngine } from "./engine.js";
import { log } from "./logger.js";
import { AiExtractor } from "./qualify/extract.js";
import { Store } from "./store.js";
import { MockEmail, MockSms, ResendEmail, TwilioSms, validateTwilio } from "./twilio.js";
import { bookingPage, dashboard, leadPage } from "./views.js";

export function buildEngine(cfg: Config, opts: { clock?: () => Date; dbPath?: string; sleepFn?: (ms: number) => Promise<void> } = {}) {
  const mockCrm = createMockCrm();
  const crmFetch = cfg.CRM_MOCK === "true" ? mockCrm.fetch : fetch;
  const retry = { attempts: cfg.RETRY_ATTEMPTS, baseDelayMs: cfg.RETRY_BASE_DELAY_MS, sleepFn: opts.sleepFn };
  const crm: CrmAdapter = cfg.CRM_PROVIDER === "gohighlevel"
    ? new GoHighLevelAdapter(cfg.GHL_TOKEN, cfg.GHL_LOCATION_ID, cfg.GHL_PIPELINE_ID, crmFetch, undefined, retry)
    : new HubSpotAdapter(cfg.HUBSPOT_TOKEN, crmFetch, undefined, retry, cfg.HUBSPOT_PIPELINE);
  const sms = cfg.TWILIO_ACCOUNT_SID ? new TwilioSms(cfg.TWILIO_ACCOUNT_SID, cfg.TWILIO_AUTH_TOKEN, cfg.TWILIO_FROM_NUMBER) : new MockSms();
  const email = cfg.RESEND_API_KEY ? new ResendEmail(cfg.RESEND_API_KEY, cfg.EMAIL_FROM) : new MockEmail();
  const store = new Store(opts.dbPath ?? join(cfg.DATA_DIR, "leads.db"));
  const extractor = new AiExtractor({ apiKey: cfg.OPENAI_API_KEY, baseUrl: cfg.OPENAI_BASE_URL, model: cfg.OPENAI_MODEL });
  const engine = new LeadEngine({ cfg, store, crm, sms, email, extractor, clock: opts.clock, sleepFn: opts.sleepFn });
  return { engine, mockCrm, sms, email };
}

async function readBody(req: IncomingMessage): Promise<string> {
  const chunks: Buffer[] = [];
  for await (const c of req) chunks.push(c as Buffer);
  return Buffer.concat(chunks).toString("utf8");
}

function send(res: ServerResponse, status: number, body: string, type = "application/json") {
  res.writeHead(status, { "content-type": type });
  res.end(body);
}
const json = (res: ServerResponse, status: number, data: unknown) => send(res, status, JSON.stringify(data));
const html = (res: ServerResponse, status: number, page: string) => send(res, status, page, "text/html; charset=utf-8");
const TWIML_EMPTY = '<?xml version="1.0" encoding="UTF-8"?><Response></Response>';

export function createHttpServer(engine: LeadEngine) {
  const cfg = engine.cfg;
  return createServer(async (req, res) => {
    const url = new URL(req.url ?? "/", "http://localhost");
    const path = url.pathname;
    try {
      const raw = req.method === "POST" ? await readBody(req) : "";
      const form = () => Object.fromEntries(new URLSearchParams(raw));
      const twilioOk = (p: Record<string, string>) => cfg.VALIDATE_TWILIO_SIGNATURE === "false" ||
        validateTwilio(cfg.TWILIO_AUTH_TOKEN, cfg.PUBLIC_URL + (req.url ?? ""), p, req.headers["x-twilio-signature"] as string | undefined);

      if (req.method === "GET" && path === "/health") return json(res, 200, { ok: true, crm: engine.crm.name, openDeadLetters: engine.store.deadLetters().length });

      if (req.method === "POST" && path === "/webhooks/form") {
        if (cfg.WEBHOOK_SECRET && req.headers["x-webhook-secret"] !== cfg.WEBHOOK_SECRET) return json(res, 401, { error: "bad secret" });
        const body = (req.headers["content-type"] ?? "").includes("json") ? JSON.parse(raw || "{}") : form();
        const r = await engine.handleForm(body);
        return json(res, r.status === "invalid" ? 422 : r.status === "created" ? 201 : 200, r);
      }
      if (req.method === "POST" && path === "/webhooks/twilio/voice-status") {
        const p = form();
        if (!twilioOk(p)) return send(res, 403, "invalid Twilio signature", "text/plain");
        const r = await engine.handleVoiceStatus(p);
        log.info("voice status", { status: r.status, callStatus: p.DialCallStatus || p.CallStatus });
        return send(res, 200, TWIML_EMPTY, "text/xml");
      }
      if (req.method === "POST" && path === "/webhooks/twilio/sms") {
        const p = form();
        if (!twilioOk(p)) return send(res, 403, "invalid Twilio signature", "text/plain");
        await engine.handleInboundSms(p);
        return send(res, 200, TWIML_EMPTY, "text/xml");   // replies go out via the REST API, not TwiML
      }
      if (req.method === "POST" && path === "/webhooks/email-reply") {
        const b = JSON.parse(raw || "{}");
        return json(res, 200, await engine.handleEmailReply(b.from, b.text, b.messageId));
      }
      const book = path.match(/^\/book\/([\w.-]+)$/);
      if (book) {
        const ctx = engine.bookingContext(book[1]);
        if (!ctx) return html(res, 404, "<h1>This booking link is invalid or has expired.</h1>");
        if (req.method === "GET") return html(res, 200, bookingPage(ctx.lead, ctx.slots, cfg.BUSINESS_TZ, cfg.BUSINESS_NAME, book[1]));
        const r = await engine.book(book[1], form().slot ?? "");
        const fresh = engine.bookingContext(book[1])!;
        return r.ok
          ? html(res, 200, bookingPage(r.lead!, [], cfg.BUSINESS_TZ, cfg.BUSINESS_NAME, book[1], "",
              `See you ${new Intl.DateTimeFormat("en-US", { timeZone: cfg.BUSINESS_TZ, weekday: "long", month: "short", day: "numeric", hour: "numeric", minute: "2-digit" }).format(new Date(r.lead!.bookingAt!))}.`))
          : html(res, 409, bookingPage(fresh.lead, fresh.slots, cfg.BUSINESS_TZ, cfg.BUSINESS_NAME, book[1], r.error));
      }
      if (req.method === "GET" && path === "/admin") {
        const s = engine.store;
        return html(res, 200, dashboard(s.listLeads(), s.jobs(), (id) => s.messages(id), cfg.BUSINESS_NAME,
          engine.crm.name === "hubspot" ? "HubSpot" : "GoHighLevel", cfg.BUSINESS_TZ, s.deadLetters().length));
      }
      const lp = path.match(/^\/admin\/leads\/([\w-]+)$/);
      if (req.method === "GET" && lp) {
        const l = engine.store.getLead(lp[1]);
        if (!l) return json(res, 404, { error: "not found" });
        return url.searchParams.get("format") === "json" ? json(res, 200, { lead: l, messages: engine.store.messages(l.id), jobs: engine.store.jobs(l.id) })
          : html(res, 200, leadPage(l, engine.store.messages(l.id), engine.store.jobs(l.id), cfg.BUSINESS_NAME, cfg.BUSINESS_TZ));
      }
      if (req.method === "POST" && path === "/admin/tick") return json(res, 200, await engine.tick());
      return json(res, 404, { error: "not found" });
    } catch (err) {
      log.error("request failed", { path, error: String(err) });
      return json(res, 500, { error: "internal error" });
    }
  });
}
