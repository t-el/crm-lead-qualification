import type { AddressInfo } from "node:net";
import { afterEach, describe, expect, it } from "vitest";
import { createHttpServer } from "../src/app.js";
import { twilioSignature } from "../src/twilio.js";
import { makeEngine } from "./helpers.js";

const servers: { close: () => void }[] = [];
afterEach(() => servers.splice(0).forEach((s) => s.close()));

async function start(overrides: Record<string, string> = {}) {
  const t = makeEngine(overrides);
  const server = createHttpServer(t.engine);
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  servers.push(server);
  const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  return { t, base };
}

const twilioPost = (base: string, path: string, params: Record<string, string>, token: string, signWith = path) =>
  fetch(base + path, {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded", "x-twilio-signature": twilioSignature(token, "https://leads.example.com" + signWith, params) },
    body: new URLSearchParams(params),
  });

describe("HTTP server", () => {
  it("accepts form webhooks (JSON or urlencoded) and checks the shared secret", async () => {
    const { base } = await start({ WEBHOOK_SECRET: "s3cret" });
    const body = JSON.stringify({ name: "Jane Doe", phone: "2125550142" });
    expect((await fetch(`${base}/webhooks/form`, { method: "POST", headers: { "content-type": "application/json" }, body })).status).toBe(401);
    const ok = await fetch(`${base}/webhooks/form`, { method: "POST", headers: { "content-type": "application/json", "x-webhook-secret": "s3cret" }, body });
    expect(ok.status).toBe(201);
    const form = await fetch(`${base}/webhooks/form`, { method: "POST", headers: { "x-webhook-secret": "s3cret", "content-type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({ name: "Al", email: "al@example.com" }) });
    expect(form.status).toBe(201);
    const bad = await fetch(`${base}/webhooks/form`, { method: "POST", headers: { "content-type": "application/json", "x-webhook-secret": "s3cret" }, body: "{}" });
    expect(bad.status).toBe(422);
  });

  it("verifies Twilio signatures and answers with empty TwiML", async () => {
    const { t, base } = await start();
    const call = { CallSid: "CA1", From: "+17185550199", To: "+15550100200", CallStatus: "no-answer" };
    const forged = await twilioPost(base, "/webhooks/twilio/voice-status", call, "wrong-token");
    expect(forged.status).toBe(403);
    const res = await twilioPost(base, "/webhooks/twilio/voice-status", call, "twilio-demo-token");
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toBe("text/xml");
    expect(await res.text()).toContain("<Response></Response>");
    const sms = await twilioPost(base, "/webhooks/twilio/sms", { MessageSid: "SM1", From: "+17185550199", To: "+15550100200", Body: "2" }, "twilio-demo-token");
    expect(sms.status).toBe(200);
    expect(t.engine.store.listLeads()[0].answers.service).toBe("repair");
  });

  it("serves the booking page and books a slot", async () => {
    const { t, base } = await start();
    await t.engine.handleForm({ name: "Jane Doe", phone: "2125550142" });
    for (const [i, a] of ["1", "asap", "10001", "yes"].entries()) await t.engine.handleInboundSms({ MessageSid: `SMx${i}`, From: "+12125550142", Body: a });
    const link = t.sms.sent.at(-1)!.body.match(/https:\/\/leads\.example\.com(\/book\/\S+)/)![1];
    const page = await fetch(base + link);
    expect(page.status).toBe(200);
    const html = await page.text();
    expect(html).toContain("Book your install visit");
    const slot = html.match(/name="slot" value="([^"]+)"/)![1];
    const booked = await fetch(base + link, { method: "POST", headers: { "content-type": "application/x-www-form-urlencoded" }, body: new URLSearchParams({ slot }) });
    expect(booked.status).toBe(200);
    expect(await booked.text()).toContain("You're booked");
    expect(t.engine.store.listLeads()[0].stage).toBe("booked");
    expect((await fetch(`${base}/book/forged.token`)).status).toBe(404);
  });

  it("renders the dashboard, lead detail and health", async () => {
    const { t, base } = await start();
    const r = await t.engine.handleForm({ name: "Jane <script>", phone: "2125550142" });
    const dash = await (await fetch(`${base}/admin`)).text();
    expect(dash).toContain("Jane &lt;script&gt;");
    expect(dash).not.toContain("<script>");
    expect((await fetch(`${base}/admin/leads/${r.leadId}`)).status).toBe(200);
    const j = await (await fetch(`${base}/admin/leads/${r.leadId}?format=json`)).json();
    expect(j.messages).toHaveLength(1);
    expect(await (await fetch(`${base}/health`)).json()).toMatchObject({ ok: true, crm: "hubspot", openDeadLetters: 0 });
    expect(await (await fetch(`${base}/admin/tick`, { method: "POST" })).json()).toMatchObject({ sent: 0 });
  });
});
