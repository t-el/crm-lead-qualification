/** State in SQLite (built into Node 22+): leads, transcript, idempotency keys, follow-up jobs, CRM dead letters. */
import { mkdirSync } from "node:fs";
import { dirname } from "node:path";
import { DatabaseSync } from "node:sqlite";
import type { Lead, Message } from "./types.js";

export interface Job {
  id: number;
  leadId: string;
  sequence: string;
  step: number;
  dueAt: string;
  status: "pending" | "sent" | "cancelled" | "failed" | "done";
  attempts: number;
  lastError: string | null;
}

export interface CrmDeadLetter {
  id: number;
  leadId: string;
  stage: string;
  note: string | null;
  error: string;
  status: "open" | "resolved";
  createdAt: string;
}

export class Store {
  readonly db: DatabaseSync;

  constructor(path: string) {
    if (path !== ":memory:") mkdirSync(dirname(path), { recursive: true });
    this.db = new DatabaseSync(path);
    this.db.exec(`
      PRAGMA journal_mode = WAL;
      CREATE TABLE IF NOT EXISTS leads (id TEXT PRIMARY KEY, phone TEXT, email TEXT, data TEXT NOT NULL);
      CREATE INDEX IF NOT EXISTS leads_phone ON leads(phone);
      CREATE INDEX IF NOT EXISTS leads_email ON leads(email);
      CREATE TABLE IF NOT EXISTS messages (id INTEGER PRIMARY KEY AUTOINCREMENT, lead_id TEXT, direction TEXT, channel TEXT, body TEXT, at TEXT);
      CREATE TABLE IF NOT EXISTS events (key TEXT PRIMARY KEY, at TEXT);
      CREATE TABLE IF NOT EXISTS jobs (id INTEGER PRIMARY KEY AUTOINCREMENT, lead_id TEXT, sequence TEXT, step INTEGER,
        due_at TEXT, status TEXT DEFAULT 'pending', attempts INTEGER DEFAULT 0, last_error TEXT);
      CREATE INDEX IF NOT EXISTS jobs_due ON jobs(status, due_at);
      CREATE TABLE IF NOT EXISTS crm_dead_letters (id INTEGER PRIMARY KEY AUTOINCREMENT, lead_id TEXT, stage TEXT, note TEXT,
        error TEXT, status TEXT DEFAULT 'open', created_at TEXT);
      CREATE TABLE IF NOT EXISTS appointments (lead_id TEXT PRIMARY KEY, slot TEXT UNIQUE, created_at TEXT);
    `);
  }

  /** First time we see this webhook id (MessageSid, CallSid, form submission id)? */
  claim(key: string, at: string): boolean {
    return this.db.prepare("INSERT OR IGNORE INTO events (key, at) VALUES (?, ?)").run(key, at).changes === 1;
  }

  saveLead(l: Lead) {
    this.db.prepare("INSERT INTO leads (id, phone, email, data) VALUES (?, ?, ?, ?) ON CONFLICT(id) DO UPDATE SET phone=excluded.phone, email=excluded.email, data=excluded.data")
      .run(l.id, l.phone, l.email, JSON.stringify(l));
  }
  getLead(id: string): Lead | null {
    const r = this.db.prepare("SELECT data FROM leads WHERE id = ?").get(id) as { data: string } | undefined;
    return r ? JSON.parse(r.data) : null;
  }
  findLead(phone: string | null, email: string | null): Lead | null {
    const r = this.db.prepare("SELECT data FROM leads WHERE (phone IS NOT NULL AND phone = ?) OR (email IS NOT NULL AND email = ?) ORDER BY rowid DESC LIMIT 1")
      .get(phone ?? "", email ?? "") as { data: string } | undefined;
    return r ? JSON.parse(r.data) : null;
  }
  listLeads(): Lead[] {
    return (this.db.prepare("SELECT data FROM leads ORDER BY rowid").all() as { data: string }[]).map((r) => JSON.parse(r.data));
  }

  addMessage(m: Message) {
    this.db.prepare("INSERT INTO messages (lead_id, direction, channel, body, at) VALUES (?, ?, ?, ?, ?)").run(m.leadId, m.direction, m.channel, m.body, m.at);
  }
  messages(leadId: string): Message[] {
    return (this.db.prepare("SELECT lead_id, direction, channel, body, at FROM messages WHERE lead_id = ? ORDER BY id").all(leadId) as any[])
      .map((r) => ({ leadId: r.lead_id, direction: r.direction, channel: r.channel, body: r.body, at: r.at }));
  }

  addJob(leadId: string, sequence: string, step: number, dueAt: string) {
    this.db.prepare("INSERT INTO jobs (lead_id, sequence, step, due_at) VALUES (?, ?, ?, ?)").run(leadId, sequence, step, dueAt);
  }
  dueJobs(nowIso: string): Job[] {
    return (this.db.prepare("SELECT * FROM jobs WHERE status = 'pending' AND due_at <= ? ORDER BY due_at, id").all(nowIso) as any[]).map(rowToJob);
  }
  jobs(leadId?: string): Job[] {
    const rows = leadId ? this.db.prepare("SELECT * FROM jobs WHERE lead_id = ? ORDER BY id").all(leadId) : this.db.prepare("SELECT * FROM jobs ORDER BY id").all();
    return (rows as any[]).map(rowToJob);
  }
  updateJob(id: number, fields: Partial<Pick<Job, "status" | "dueAt" | "attempts" | "lastError">>) {
    const map: Record<string, string> = { status: "status", dueAt: "due_at", attempts: "attempts", lastError: "last_error" };
    const keys = Object.keys(fields);
    this.db.prepare(`UPDATE jobs SET ${keys.map((k) => `${map[k]} = ?`).join(", ")} WHERE id = ?`).run(...keys.map((k) => (fields as any)[k]), id);
  }
  /** Stop-on-reply: cancel everything still pending for this lead. */
  cancelJobs(leadId: string, sequences?: string[]): number {
    const jobs = this.jobs(leadId).filter((j) => j.status === "pending" && (!sequences || sequences.includes(j.sequence)));
    for (const j of jobs) this.updateJob(j.id, { status: "cancelled" });
    return jobs.length;
  }

  addDeadLetter(leadId: string, stage: string, note: string | null, error: string, at: string): number {
    return Number(this.db.prepare("INSERT INTO crm_dead_letters (lead_id, stage, note, error, created_at) VALUES (?, ?, ?, ?, ?)").run(leadId, stage, note, error, at).lastInsertRowid);
  }
  deadLetters(status = "open"): CrmDeadLetter[] {
    return (this.db.prepare("SELECT * FROM crm_dead_letters WHERE status = ? ORDER BY id").all(status) as any[])
      .map((r) => ({ id: r.id, leadId: r.lead_id, stage: r.stage, note: r.note, error: r.error, status: r.status, createdAt: r.created_at }));
  }
  resolveDeadLetter(id: number) {
    this.db.prepare("UPDATE crm_dead_letters SET status = 'resolved' WHERE id = ?").run(id);
  }

  bookSlot(leadId: string, slot: string, at: string): boolean {
    try {
      this.db.prepare("INSERT INTO appointments (lead_id, slot, created_at) VALUES (?, ?, ?)").run(leadId, slot, at);
      return true;
    } catch {
      return false;   // slot taken, or this lead already booked
    }
  }
  takenSlots(): Set<string> {
    return new Set((this.db.prepare("SELECT slot FROM appointments").all() as { slot: string }[]).map((r) => r.slot));
  }
}

function rowToJob(r: any): Job {
  return { id: r.id, leadId: r.lead_id, sequence: r.sequence, step: r.step, dueAt: r.due_at, status: r.status, attempts: r.attempts, lastError: r.last_error };
}
