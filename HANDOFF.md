# Handoff: AI Lead Qualification

## What it does
Texts every new lead (web form, missed call, inbound text) within seconds, asks 4 qualifying questions, scores the lead, keeps HubSpot or GoHighLevel up to date, sends a booking link, and follows up until the lead replies, books or opts out.

## Where things live

| Thing | Location |
|---|---|
| Config | `.env` (documented in `.env.example`) |
| Database | `data/leads.db` (SQLite). Tables: `leads`, `messages`, `events` (webhook idempotency keys), `jobs`, `crm_dead_letters`, `appointments` |
| Dashboard | `https://<host>/admin` (put it behind your reverse proxy's auth or VPN) |
| Twilio Voice status callback | `https://<host>/webhooks/twilio/voice-status` (on the number, or the `<Dial action>` of your call flow) |
| Twilio Messaging webhook | `https://<host>/webhooks/twilio/sms` |
| Form webhook | `https://<host>/webhooks/form` (JSON or urlencoded: `name`, `phone`, `email`, `message`, optional `submissionId`) |
| Email replies | `https://<host>/webhooks/email-reply` (`{from, text, messageId}` from your inbound email provider) |
| Questions and wording | `src/qualify/questions.ts`, sequences in `SEQUENCES` in `src/engine.ts` |
| Scoring rules | `src/qualify/score.ts` (every point is written into the CRM note) |
| CRM stage mapping | `STAGES` in `src/crm/hubspot.ts`, `GHL_STAGES` in `src/crm/gohighlevel.ts` |

## Lead stages

| Stage | Meaning | CRM stage | Who acts |
|---|---|---|---|
| `new` / `qualifying` | Answering questions | new_lead | Nobody (nudges run automatically) |
| `qualified` | Hot or warm, booking link sent | qualified | Nobody. After 3 unanswered booking reminders the CRM note says "Call manually" |
| `booked` | Picked a slot | appointment_booked | Dispatcher confirms the visit |
| `nurture` | Just researching | nurture | Marketing (no pushy follow-ups) |
| `disqualified` | Outside the service area or renter asking for an install | disqualified | Nobody |
| `handoff` | Asked for a person, or two unclear answers | needs_callback | **Office calls back** |
| `no_response` | Sequence finished without a reply | lost | Optional manual call |
| `opted_out` | Replied STOP | lost + `sms_opt_out=true` | Nobody. Never text again unless they send START |

## Running

- `./scripts/serve.sh` runs the server and the follow-up ticker every 5 minutes. On serverless/cron hosts, run `npm run tick` every 5 minutes instead.
- One server instance at a time (SQLite). For several instances, move `store.ts` to Postgres; the interface stays the same.

## Mapping your CRM
- **HubSpot**: private app with `crm.objects.contacts.read/write`, `crm.objects.deals.read/write`. Create custom contact properties `lead_score`, `lead_tier`, `hvac_service`, `hvac_timeline`, `zip`, `owns_property`, `sms_opt_out`, `lead_source`. Put your pipeline's stage IDs in `STAGES`.
- **GoHighLevel**: private integration token with contacts + opportunities scopes. Get stage IDs from `GET /opportunities/pipelines?locationId=...` and put them in `GHL_STAGES`. Custom fields are sent as `customFields` by key.

## Failure playbook

| Symptom | Action |
|---|---|
| `CRM sync failed, queued for replay` in logs / dashboard "CRM sync errors" > 0 | `npm run dlq` to see the error. Fix the token, field or bad data, then `npm run replay -- all` |
| `retries exhausted` with `HTTP 429` | CRM rate limit. Lower traffic bursts; the sync is in the DLQ |
| `message not delivered` | Twilio/Resend down or the number is invalid. The transcript shows `[NOT DELIVERED]`; follow-ups retry 3 times |
| 403 on Twilio webhooks | `PUBLIC_URL` doesn't match the URL configured in Twilio (scheme, host and path must match exactly) |
| Leads texted at the wrong hours | Check `BUSINESS_TZ` and `QUIET_HOURS_*` |

## Security and compliance
- Only text people who contacted you (form with consent, call or text). STOP handling is built in; keep the wording "Reply STOP to opt out" in your Twilio Messaging Service if your A2P 10DLC campaign requires it.
- Lead replies are sent to the LLM provider only when the rules can't parse them, and only the reply plus the current question.
- `.env` and `data/` are git-ignored. Change `BOOKING_SECRET` before going live (it invalidates old links).
