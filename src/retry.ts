import { log } from "./logger.js";

export class TransientError extends Error {
  readonly transient = true;
  constructor(message: string, readonly retryAfterMs?: number) {
    super(message);
  }
}
export class PermanentError extends Error {
  constructor(message: string, readonly status?: number) {
    super(message);
  }
}

export const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

export function isTransient(err: unknown): boolean {
  if (err instanceof TransientError) return true;
  const code = (err as { code?: string; cause?: { code?: string } })?.cause?.code ?? (err as { code?: string })?.code;
  return ["ECONNRESET", "ETIMEDOUT", "ECONNREFUSED", "EAI_AGAIN", "UND_ERR_CONNECT_TIMEOUT"].includes(code ?? "");
}

/** 429 and 5xx are worth retrying; other 4xx are bugs or bad data and go to the dead-letter queue. */
export async function checkResponse(res: Response, what: string): Promise<Response> {
  if (res.ok) return res;
  const body = (await res.text()).slice(0, 300);
  if (res.status === 429 || res.status >= 500) {
    const ra = Number(res.headers.get("retry-after"));
    throw new TransientError(`${what} HTTP ${res.status}`, Number.isFinite(ra) && ra > 0 ? ra * 1000 : undefined);
  }
  throw new PermanentError(`${what} HTTP ${res.status}: ${body}`, res.status);
}

export interface RetryOpts {
  attempts: number;
  baseDelayMs: number;
  step: string;
  sleepFn?: (ms: number) => Promise<void>;
}

/** Retry transient failures with exponential backoff + jitter (Retry-After honoured). */
export async function withRetry<T>(fn: () => Promise<T>, opts: RetryOpts): Promise<T> {
  const doSleep = opts.sleepFn ?? sleep;
  for (let attempt = 1; ; attempt++) {
    try {
      return await fn();
    } catch (err) {
      if (!isTransient(err) || attempt >= opts.attempts) {
        if (isTransient(err)) log.error("retries exhausted", { step: opts.step, attempt, error: String(err) });
        throw err;
      }
      let delay = Math.min(30_000, opts.baseDelayMs * 2 ** (attempt - 1)) * (0.5 + Math.random() / 2);
      const ra = (err as TransientError).retryAfterMs;
      if (ra) delay = Math.max(delay, ra);
      log.warn("transient failure, retrying", { step: opts.step, attempt, delayMs: Math.round(delay), error: String(err) });
      await doSleep(delay);
    }
  }
}
