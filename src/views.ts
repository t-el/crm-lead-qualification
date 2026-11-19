import { fmtSlot } from "./booking.js";
import type { Job } from "./store.js";
import type { Lead, Message } from "./types.js";

const esc = (s: unknown) => String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]!);

const CSS = `*{box-sizing:border-box}body{margin:0;font:15px/1.5 Inter,system-ui,-apple-system,Segoe UI,sans-serif;background:#f8fafc;color:#0f172a}
header{background:#0b3b5c;color:#fff;padding:14px 28px;display:flex;gap:14px;align-items:center}header b{font-size:17px}header span{color:#9cc7e4;font-size:13px}
main{max-width:1200px;margin:24px auto;padding:0 24px}.kpis{display:grid;grid-template-columns:repeat(6,1fr);gap:12px;margin-bottom:18px}
.kpi{background:#fff;border:1px solid #e2e8f0;border-radius:12px;padding:12px 14px}.kpi span{color:#64748b;font-size:12.5px}.kpi b{display:block;font-size:26px}
.card{background:#fff;border:1px solid #e2e8f0;border-radius:12px;padding:16px 18px;margin-bottom:16px}
table{width:100%;border-collapse:collapse}th,td{padding:9px 8px;border-bottom:1px solid #f1f5f9;text-align:left;font-size:13.5px;vertical-align:top}
th{font-size:11.5px;text-transform:uppercase;letter-spacing:.05em;color:#64748b}.pill{display:inline-block;white-space:nowrap;border-radius:999px;padding:2px 9px;font-size:12px;font-weight:600}
.muted{color:#64748b;font-size:12.5px}.bar{height:7px;border-radius:9px;background:#e2e8f0;width:90px;overflow:hidden;display:inline-block;vertical-align:middle;margin-right:6px}
.bar i{display:block;height:100%}.chat{display:flex;flex-direction:column;gap:6px}.b{max-width:78%;padding:7px 11px;border-radius:14px;font-size:13px}
.in{background:#f1f5f9;align-self:flex-start}.out{background:#0b3b5c;color:#fff;align-self:flex-end}h1{font-size:22px;margin:0 0 6px}a{color:#0369a1}`;

const STAGE: Record<string, [string, string]> = {
  new: ["#e0f2fe", "#0369a1"], qualifying: ["#e0f2fe", "#0369a1"], qualified: ["#dcfce7", "#15803d"], booked: ["#15803d", "#fff"],
  disqualified: ["#f1f5f9", "#64748b"], nurture: ["#fef9c3", "#a16207"], no_response: ["#fee2e2", "#b91c1c"],
  handoff: ["#ffedd5", "#c2410c"], opted_out: ["#e2e8f0", "#334155"],
};
const SRC: Record<string, string> = { web_form: "Web form", missed_call: "Missed call", inbound_sms: "Text-in" };
const pill = (stage: string) => `<span class="pill" style="background:${STAGE[stage][0]};color:${STAGE[stage][1]}">${stage.replace("_", " ")}</span>`;

function layout(title: string, body: string, business: string) {
  return `<!doctype html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>${esc(title)}</title><style>${CSS}</style></head>
<body><header><b>${esc(business)}</b><span>AI lead qualification · speed-to-lead dashboard</span></header><main>${body}</main></body></html>`;
}

export function dashboard(leads: Lead[], jobs: Job[], msgs: (id: string) => Message[], business: string, crm: string, tz: string, dlq: number) {
  const n = (f: (l: Lead) => boolean) => leads.filter(f).length;
  const kpis = [["Leads", leads.length], ["Missed calls recovered", n((l) => l.source === "missed_call" && ["qualified", "booked"].includes(l.stage))],
    ["Qualified", n((l) => l.stage === "qualified")], ["Booked", n((l) => l.stage === "booked")],
    ["Follow-ups queued", jobs.filter((j) => j.status === "pending").length], ["CRM sync errors", dlq]]
    .map(([k, v]) => `<div class="kpi"><span>${k}</span><b>${v}</b></div>`).join("");
  const rows = leads.slice().reverse().map((l) => {
    const next = jobs.filter((j) => j.leadId === l.id && j.status === "pending").sort((a, b) => a.dueAt.localeCompare(b.dueAt))[0];
    const last = msgs(l.id).at(-1);
    const color = ({ hot: "#16a34a", warm: "#ca8a04", cold: "#64748b", disqualified: "#dc2626" } as Record<string, string>)[l.tier ?? ""] ?? "#cbd5e1";
    return `<tr><td><b>${esc(l.name || "Unknown caller")}</b><div class="muted">${esc(l.phone ?? l.email)}</div></td>
<td>${SRC[l.source]}</td><td>${pill(l.stage)}</td>
<td style="white-space:nowrap">${l.score == null ? '<span class="muted">—</span>' : `<span class="bar"><i style="width:${l.score}%;background:${color}"></i></span>${l.score} <span class="muted">${esc(l.tier)}</span>`}</td>
<td class="muted">${esc(l.answers.service ?? "")} ${esc(l.answers.timeline ?? "")} ${esc(l.answers.zip ?? "")}</td>
<td class="muted">${l.bookingAt ? "📅 " + esc(fmtSlot(new Date(l.bookingAt), tz)) : next ? `${esc(next.sequence.replace("_", " "))} #${next.step + 1} · ${esc(fmtSlot(new Date(next.dueAt), tz))}` : "—"}</td>
<td class="muted">${l.crmContactId ? `${esc(l.crmContactId)}<br>${esc(l.crmDealId ?? "")}` : "—"}</td>
<td><div class="b ${last?.direction === "in" ? "in" : "out"}" style="max-width:260px">${esc((last?.body ?? "").slice(0, 90))}</div></td></tr>`;
  }).join("");
  return layout("Leads", `<h1>Leads</h1><p class="muted">Every form fill, missed call and text is answered in seconds, qualified by AI over SMS, scored, synced to ${esc(crm)} and booked. Times shown in ${esc(tz)}.</p>
<div class="kpis">${kpis}</div><div class="card"><table><tr><th>Lead</th><th>Source</th><th>Stage</th><th>Score</th><th>Answers</th><th>Next step</th><th>CRM ids</th><th>Last message</th></tr>${rows}</table></div>`, business);
}

export function bookingPage(lead: Lead, slots: Date[], tz: string, business: string, token: string, error = "", done?: string) {
  if (done) return layout("Booked", `<div class="card" style="max-width:560px;margin:40px auto;text-align:center"><h1>You're booked ✅</h1><p>${esc(done)}</p><p class="muted">We'll text you a reminder before the visit.</p></div>`, business);
  const byDay = new Map<string, Date[]>();
  for (const s of slots) {
    const day = new Intl.DateTimeFormat("en-US", { timeZone: tz, weekday: "long", month: "short", day: "numeric" }).format(s);
    byDay.set(day, [...(byDay.get(day) ?? []), s]);
  }
  const days = [...byDay].map(([day, ss]) => `<div style="margin-bottom:14px"><b>${esc(day)}</b><div style="display:flex;gap:8px;margin-top:6px;flex-wrap:wrap">${ss.map((s) =>
    `<button name="slot" value="${s.toISOString()}" style="border:1px solid #0b3b5c;background:#fff;color:#0b3b5c;border-radius:10px;padding:9px 14px;font:600 14px Inter,system-ui;cursor:pointer">${esc(new Intl.DateTimeFormat("en-US", { timeZone: tz, hour: "numeric", minute: "2-digit" }).format(s))} window</button>`).join("")}</div></div>`).join("");
  return layout("Book a visit", `<div class="card" style="max-width:640px;margin:20px auto">
<h1>Book your ${esc(lead.answers.service ?? "HVAC")} visit</h1><p class="muted">Hi ${esc(lead.name.split(" ")[0] || "there")}! ZIP ${esc(lead.answers.zip ?? "")} · 2-hour arrival windows · ${esc(tz)}</p>
${error ? `<p style="background:#fef2f2;color:#991b1b;padding:8px 12px;border-radius:8px">${esc(error)}</p>` : ""}
<form method="post" action="/book/${esc(token)}">${days || "<p>No open slots right now. Reply to our text and we'll fit you in.</p>"}</form></div>`, business);
}

export function leadPage(l: Lead, msgs: Message[], jobs: Job[], business: string, tz: string) {
  const chat = msgs.map((m) => `<div class="b ${m.direction}">${esc(m.body)}<div class="muted" style="color:${m.direction === "out" ? "#9cc7e4" : ""}">${m.channel} · ${esc(fmtSlot(new Date(m.at), tz))}</div></div>`).join("");
  const cancelled = jobs.filter((j) => j.status === "cancelled").length;
  const js = jobs.filter((j) => j.status !== "cancelled").map((j) => `<tr><td>${esc(j.sequence)}</td><td>#${j.step + 1}</td><td>${esc(fmtSlot(new Date(j.dueAt), tz))}</td><td>${esc(j.status)}</td></tr>`).join("");
  return layout(l.name || "Lead", `<p><a href="/admin">← Leads</a></p><h1>${esc(l.name || l.phone)} ${pill(l.stage)}</h1>
<p class="muted">${SRC[l.source]} · score ${l.score ?? "—"} · CRM ${esc(l.crmContactId ?? "—")} / ${esc(l.crmDealId ?? "—")}</p>
<div style="display:grid;grid-template-columns:1.3fr 1fr;gap:16px"><div class="card"><div class="chat">${chat}</div></div>
<div class="card"><b>Follow-up jobs</b><table><tr><th>Sequence</th><th>Step</th><th>Due</th><th>Status</th></tr>${js}</table>
<p class="muted">${cancelled} follow-ups cancelled automatically (lead replied, booked or opted out).</p></div></div>`, business);
}
