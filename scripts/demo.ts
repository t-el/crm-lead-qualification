/**
 * End-to-end demo, fully offline: real HTTP webhooks (signed like Twilio), mock SMS/email, mock HubSpot + GoHighLevel,
 * and a simulated clock so four days of follow-ups run in a second.
 *
 *   npm run demo                 # prints the story (saved to docs/demo-output.txt)
 *   npm run demo -- --keep-alive # then keeps the dashboard + booking pages up on PORT for screenshots
 */
import { rmSync } from "node:fs";
import type { AddressInfo } from "node:net";
import { buildEngine, createHttpServer } from "../src/app.js";
import { fmtSlot } from "../src/booking.js";
import { loadConfig } from "../src/config.js";
import { configureLogger } from "../src/logger.js";
import { twilioSignature, type MockEmail, type MockSms } from "../src/twilio.js";

configureLogger({ silent: true });
const keepAlive = process.argv.includes("--keep-alive");
const H = 3_600_000;
let now = new Date("2026-11-17T15:00:00Z").getTime();            // Tue 17 Nov 2026, 10:00 New York
const clock = () => new Date(now);
const advanceTo = (iso: string) => { now = new Date(iso).getTime(); };

rmSync("data/demo", { recursive: true, force: true });
const cfg = loadConfig({ PUBLIC_URL: `http://localhost:${process.env.PORT ?? 8900}`, RETRY_BASE_DELAY_MS: "1", DATA_DIR: "data/demo" });
const sleeps: number[] = [];
const { engine, mockCrm, sms: smsAny, email: emailAny } = buildEngine(cfg, { clock, sleepFn: async (ms) => { sleeps.push(ms); } });
const sms = smsAny as MockSms, email = emailAny as MockEmail;
const tz = cfg.BUSINESS_TZ;
const server = createHttpServer(engine);
await new Promise<void>((r) => server.listen(keepAlive ? cfg.PORT : 0, "127.0.0.1", r));
const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;

const local = () => fmtSlot(clock(), tz);
const h = (s: string) => console.log(`\n=== ${s} ${"=".repeat(Math.max(0, 86 - s.length))}`);
let shown = 0;
function showNewMessages() {
  for (const m of sms.sent.slice(shown)) console.log(`  SMS -> ${m.to}: ${m.body}`);
  shown = sms.sent.length;
}
let shownEmail = 0;
function showNewEmails() {
  for (const m of email.sent.slice(shownEmail)) console.log(`  EMAIL -> ${m.to}: ${m.text}`);
  shownEmail = email.sent.length;
}

async function twilio(path: string, params: Record<string, string>, token = cfg.TWILIO_AUTH_TOKEN) {
  const res = await fetch(base + path, { method: "POST", body: new URLSearchParams(params),
    headers: { "content-type": "application/x-www-form-urlencoded", "x-twilio-signature": twilioSignature(token, cfg.PUBLIC_URL + path, params) } });
  return res.status;
}
let sid = 0;
async function text(from: string, body: string) {
  console.log(`  ${from} replies: "${body}"`);
  await twilio("/webhooks/twilio/sms", { MessageSid: `SMdemo${++sid}`, From: from, To: cfg.TWILIO_FROM_NUMBER, Body: body });
  showNewMessages();
}
async function form(data: Record<string, string>) {
  const res = await fetch(`${base}/webhooks/form`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(data) });
  return { status: res.status, ...(await res.json()) as { leadId: string } };
}
const lead = (id: string) => engine.store.getLead(id)!;
const deal = (id: string) => mockCrm.state.deals.get(lead(id).crmDealId!)!;
async function bookFirstSlot(id: string, pick = 0) {
  const link = sms.sent.concat().reverse().find((m) => m.to === lead(id).phone && m.body.includes("/book/"))!.body.match(/\/book\/\S+/)![0];
  const page = await (await fetch(base + link)).text();
  const slot = [...page.matchAll(/name="slot" value="([^"]+)"/g)][pick][1];
  const res = await fetch(base + link, { method: "POST", headers: { "content-type": "application/x-www-form-urlencoded" }, body: new URLSearchParams({ slot }) });
  console.log(`  Lead opens ${link.slice(0, 22)}..., picks ${fmtSlot(new Date(slot), tz)} -> HTTP ${res.status}`);
  showNewMessages();
}

console.log(`${cfg.BUSINESS_NAME} | CRM: ${engine.crm.name} (mock) | SMS: mock Twilio | business time zone ${tz}`);

h(`1. Web form lead (${local()})`);
const jane = await form({ name: "Jane Doe", phone: "(212) 555-0142", email: "jane@example.com", message: "AC is blowing warm air", submissionId: "wf_1001" });
console.log(`  POST /webhooks/form -> ${jane.status} ${jane.leadId}`);
showNewMessages();
for (const a of ["2", "today if possible", "10001", "yes we own it"]) await text("+12125550142", a);
console.log(`  score ${lead(jane.leadId).score} (${lead(jane.leadId).tier}) | HubSpot deal stages: ${deal(jane.leadId).history.join(" -> ")}`);
await bookFirstSlot(jane.leadId, 1);
console.log(`  stage=${lead(jane.leadId).stage} | deal stages: ${deal(jane.leadId).history.join(" -> ")}`);
console.log(`  duplicate form post (same submissionId): ${(await form({ name: "Jane Doe", phone: "(212) 555-0142", submissionId: "wf_1001" })).status} (no second text)`);

h("2. Missed call -> text-back -> booked");
const call = { CallSid: "CAdemo1", From: "+17185550199", To: cfg.TWILIO_FROM_NUMBER, CallStatus: "no-answer", CallerName: "Marcus Hill" };
console.log(`  forged Twilio webhook -> HTTP ${await twilio("/webhooks/twilio/voice-status", call, "wrong-token")} (rejected)`);
console.log(`  missed call webhook -> HTTP ${await twilio("/webhooks/twilio/voice-status", call)}`);
console.log(`  Twilio retries the same webhook -> HTTP ${await twilio("/webhooks/twilio/voice-status", call)} (deduped by CallSid)`);
showNewMessages();
const marcusId = engine.store.findLead("+17185550199", null)!.id;
for (const a of ["need a new furnace, ours is 20 years old", "1", "my zip is 11211", "y"]) await text("+17185550199", a);
await bookFirstSlot(marcusId, 0);
console.log(`  stage=${lead(marcusId).stage} score=${lead(marcusId).score} | deal amount $${deal(marcusId).amount}`);

h("3. Reply mid-sequence stops the follow-ups");
const tom = await form({ name: "Tom Becker", phone: "646-555-0110", message: "Furnace tune-up?" });
showNewMessages();
now += 2 * H;
console.log(`  [${local()}] tick ->`, await engine.tick());
showNewMessages();
now += 1 * H;
await text("+16465550110", "3");
const cancelled = engine.store.jobs(tom.leadId).filter((j) => j.status === "cancelled").length;
console.log(`  ${cancelled} pending nudges cancelled on reply; a fresh timer started for the next question`);
for (const a of ["couple of weeks", "10003", "yes"]) await text("+16465550110", a);
console.log(`  stage=${lead(tom.leadId).stage} (${lead(tom.leadId).tier}, ${lead(tom.leadId).score}) -> booking follow-ups queued: ${engine.store.jobs(tom.leadId).filter((j) => j.status === "pending").length}`);

h("4. STOP is honoured everywhere");
const kim = await form({ name: "Kim Park", phone: "917-555-0188" });
showNewMessages();
await text("+19175550188", "STOP");
await text("+19175550188", "actually 2");
console.log(`  stage=${lead(kim.leadId).stage} | pending jobs=${engine.store.jobs(kim.leadId).filter((j) => j.status === "pending").length} | CRM sms_opt_out=${mockCrm.state.contacts.get(lead(kim.leadId).crmContactId!)!.sms_opt_out} | no reply sent`);

h("5. Outside the service area / just researching / wants a human");
const ray = await form({ name: "Ray Ortiz", phone: "201-555-0144", message: "New AC install" });
showNewMessages();
for (const a of ["1", "asap", "07030", "yes"]) await text("+12015550144", a);
const lia = await form({ name: "Lia Chen", phone: "347-555-0161" });
showNewMessages();
for (const a of ["1", "just researching for next year", "11215", "yes"]) await text("+13475550161", a);
const ben = await form({ name: "Ben Ade", phone: "332-555-0175" });
showNewMessages();
await text("+13325550175", "can someone just call me please");
console.log(`  Ray: ${lead(ray.leadId).stage} | Lia: ${lead(lia.leadId).stage} (no booking pushes) | Ben: ${lead(ben.leadId).stage} -> HubSpot stage ${deal(ben.leadId).dealstage}`);

h("6. HubSpot rate limit burst + rejected record");
mockCrm.state.faults.status429 = 3;
const omar = await form({ name: "Omar Haddad", phone: "212-555-0193", email: "omar@example.com" });
console.log(`  3x HTTP 429 -> retried with Retry-After (waits: ${sleeps.filter((s) => s >= 1000).map((s) => s + "ms").join(", ")}) -> contact ${lead(omar.leadId).crmContactId}`);
showNewMessages();
mockCrm.state.faults.rejectEmailContaining = "bad-domain";
const zoe = await form({ name: "Zoe Ali", phone: "212-555-0166", email: "zoe@bad-domain" });
showNewMessages();
console.log(`  HubSpot 400 INVALID_EMAIL -> lead still texted, sync parked in DLQ: ${JSON.stringify(engine.store.deadLetters().map((d) => ({ id: d.id, stage: d.stage })))}`);
mockCrm.state.faults.rejectEmailContaining = undefined;
for (const d of engine.store.deadLetters()) console.log(`  replay #${d.id} after the fix -> ${await engine.replayDeadLetter(d.id) ? "synced" : "still failing"} (${lead(zoe.leadId).crmContactId})`);

h("7. Evening missed call, nobody replies: quiet hours + full sequence");
advanceTo("2026-11-18T00:30:00Z");
const priyaCall = { CallSid: "CAdemo2", From: "+19175550123", To: cfg.TWILIO_FROM_NUMBER, DialCallStatus: "no-answer", CallStatus: "completed" };
console.log(`  [${local()}] missed call -> HTTP ${await twilio("/webhooks/twilio/voice-status", priyaCall)}`);
showNewMessages();
const priyaId = engine.store.findLead("+19175550123", null)!.id;
for (const t of ["2026-11-18T02:30:00Z", "2026-11-18T13:00:00Z", "2026-11-18T16:00:00Z", "2026-11-19T00:30:00Z", "2026-11-19T13:00:00Z",
                 "2026-11-20T15:00:00Z", "2026-11-21T00:30:00Z", "2026-11-21T13:00:00Z", "2026-11-22T00:45:00Z", "2026-11-22T13:00:00Z"]) {
  advanceTo(t);
  const r = await engine.tick();
  console.log(`  [${local().padEnd(22)}] tick -> sent ${r.sent}, deferred ${r.deferred}, cancelled ${r.cancelled}, closed ${r.closed}`);
  showNewMessages(); showNewEmails();
}
console.log(`  Priya: stage=${lead(priyaId).stage} | HubSpot stage ${deal(priyaId).dealstage}`);
console.log(`  Tom (qualified, never booked): stage=${lead(tom.leadId).stage}, ${mockCrm.state.notes.filter((n) => n.contactId === lead(tom.leadId).crmContactId).at(-1)!.body}`);

h("8. A brand-new lead right now (for the dashboard)");
const dana = await form({ name: "Dana Wright", phone: "929-555-0102", message: "Heat pump making noise" });
showNewMessages();
await text("+19295550102", "repair");

h("9. Same engine against GoHighLevel");
const ghlCfg = loadConfig({ CRM_PROVIDER: "gohighlevel", PUBLIC_URL: cfg.PUBLIC_URL, RETRY_BASE_DELAY_MS: "1" });
const ghl = buildEngine(ghlCfg, { clock, dbPath: ":memory:", sleepFn: async () => {} });
ghl.mockCrm.state.faults.status500 = 1;
const g = await ghl.engine.handleForm({ name: "Ana Silva", phone: "212-555-0150", email: "ana@example.com" });
for (const [i, a] of ["2", "1", "10011", "yes"].entries()) await ghl.engine.handleInboundSms({ MessageSid: `SMg${i}`, From: "+12125550150", Body: a });
const gl = ghl.engine.store.getLead(g.leadId!)!;
const opp = ghl.mockCrm.state.deals.get(gl.crmDealId!)!;
console.log(`  one 502 retried | contact ${gl.crmContactId} tags=${JSON.stringify(ghl.mockCrm.state.contacts.get(gl.crmContactId!)!.tags)}`);
console.log(`  opportunity ${opp.id}: ${opp.history.join(" -> ")} | $${opp.monetaryValue} | status ${opp.status}`);

h("Summary");
const leads = engine.store.listLeads();
const by = leads.reduce<Record<string, number>>((a, l) => ({ ...a, [l.stage]: (a[l.stage] ?? 0) + 1 }), {});
console.log(`  leads: ${leads.length} ${JSON.stringify(by)}`);
console.log(`  SMS sent: ${sms.sent.length}, emails: ${email.sent.length}, HubSpot contacts: ${mockCrm.state.contacts.size}, deals: ${mockCrm.state.deals.size}, notes: ${mockCrm.state.notes.length}, open DLQ: ${engine.store.deadLetters().length}`);
console.log(`  dashboard: ${base}/admin   (Dana: ${dana.leadId})`);

if (keepAlive) {
  const tok = sms.sent.concat().reverse().find((m) => m.to === "+16465550110" && m.body.includes("/book/"))!.body.match(/\/book\/(\S+)/)![1];
  console.log(`  booking page: ${base}/book/${tok}\n  lead detail: ${base}/admin/leads/${marcusId}\nKEEP_ALIVE_READY`);
} else {
  server.close();
}
