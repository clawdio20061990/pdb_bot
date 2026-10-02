import type { Db } from '../db.js';

/**
 * Postgres-backed job queue. Everything slow (Gemini calls, bulk sends) runs here so the
 * Telegram webhook can answer immediately. Survives restarts / Render free-tier sleep.
 */
export type JobKind =
  | 'plan_event' // parse idea -> research named venue or suggest venues
  | 'suggest_more' // more venue options
  | 'research_venue' // organizer typed a place name -> grounded lookup -> event card
  | 'generate' // write + translate all invitations (then send, or show drafts)
  | 'redraft' // regenerate one draft (optionally with an organizer instruction)
  | 'retranslate' // organizer edited a draft by hand -> translate it
  | 'send' // send all queued invitations of an event
  | 'forward_proposal'; // recipient's counter-proposal -> organizer (translated)

export interface JobPayloads {
  plan_event: { eventId: number };
  suggest_more: { eventId: number };
  research_venue: { eventId: number; venueName: string };
  generate: { eventId: number };
  redraft: { invitationId: number; instruction?: string };
  retranslate: { invitationId: number };
  send: { eventId: number };
  forward_proposal: { invitationId: number; text?: string };
}

export interface Job<K extends JobKind = JobKind> {
  id: number;
  kind: K;
  payload: JobPayloads[K];
  attempts: number;
  max_attempts: number;
}

type Listener = () => void;

export class Queue {
  private listeners: Listener[] = [];

  constructor(private readonly db: Db) {}

  /** Worker subscribes to be woken up right after an enqueue (no waiting for the next poll). */
  onEnqueue(fn: Listener): void {
    this.listeners.push(fn);
  }

  async enqueue<K extends JobKind>(kind: K, payload: JobPayloads[K], opts: { maxAttempts?: number } = {}): Promise<number> {
    const { rows } = await this.db.query<{ id: number }>(
      'INSERT INTO jobs (kind, payload, max_attempts) VALUES ($1, $2, $3) RETURNING id',
      [kind, JSON.stringify(payload), opts.maxAttempts ?? 3],
    );
    for (const fn of this.listeners) fn();
    return rows[0]!.id;
  }

  /** Atomically claim the next due job (single statement: safe through Neon's PgBouncer). */
  async claim(): Promise<Job | null> {
    const { rows } = await this.db.query<Job>(
      `UPDATE jobs SET status = 'running', locked_at = now(), attempts = attempts + 1, updated_at = now()
       WHERE id = (
         SELECT id FROM jobs WHERE status = 'queued' AND run_after <= now()
         ORDER BY run_after, id FOR UPDATE SKIP LOCKED LIMIT 1
       )
       RETURNING id, kind, payload, attempts, max_attempts`,
    );
    return rows[0] ?? null;
  }

  // `attempts` is the lease token of a claim: complete/fail/heartbeat only touch the row while this run owns it,
  // so a run that was presumed dead (and requeued) can't overwrite the state of the run that replaced it.

  async complete(job: Job): Promise<void> {
    await this.db.query(
      `UPDATE jobs SET status = 'done', locked_at = NULL, updated_at = now() WHERE id = $1 AND status = 'running' AND attempts = $2`,
      [job.id, job.attempts],
    );
  }

  /** Retry with backoff, or mark failed. Returns true when the job will not be retried (and this run still owned it). */
  async fail(job: Job, error: string, retryable: boolean): Promise<boolean> {
    const final = !retryable || job.attempts >= job.max_attempts;
    const delaySec = Math.min(60, 5 * 2 ** (job.attempts - 1));
    const res = await this.db.query(
      `UPDATE jobs SET status = $3, locked_at = NULL, last_error = $4,
         run_after = now() + make_interval(secs => $5), updated_at = now()
       WHERE id = $1 AND status = 'running' AND attempts = $2`,
      [job.id, job.attempts, final ? 'failed' : 'queued', error.slice(0, 2000), final ? 0 : delaySec],
    );
    return final && (res.rowCount ?? 0) > 0;
  }

  /** Keep a long-running claim alive so requeueStale doesn't hand it to another worker. */
  async heartbeat(job: Job): Promise<void> {
    await this.db.query(`UPDATE jobs SET locked_at = now() WHERE id = $1 AND status = 'running' AND attempts = $2`, [
      job.id,
      job.attempts,
    ]);
  }

  /** Give a claim back untouched (claimed while shutting down). */
  async release(job: Job): Promise<void> {
    await this.db.query(
      `UPDATE jobs SET status = 'queued', locked_at = NULL, attempts = attempts - 1, updated_at = now()
       WHERE id = $1 AND status = 'running' AND attempts = $2`,
      [job.id, job.attempts],
    );
  }

  /** When the next queued job becomes due (null = nothing waiting). Lets the worker sleep until then. */
  async nextRunAt(): Promise<Date | null> {
    const { rows } = await this.db.query<{ at: Date | null }>(
      `SELECT min(run_after) AS at FROM jobs WHERE status = 'queued'`,
    );
    return rows[0]?.at ?? null;
  }

  /** Is a job of this kind for this invitation already waiting or running? (debounces repeated taps) */
  async hasActive(kind: JobKind, invitationId: number): Promise<boolean> {
    const { rowCount } = await this.db.query(
      `SELECT 1 FROM jobs WHERE kind = $1 AND status IN ('queued','running') AND (payload->>'invitationId')::bigint = $2 LIMIT 1`,
      [kind, invitationId],
    );
    return (rowCount ?? 0) > 0;
  }

  /** Is any job for this event waiting or running? */
  async hasActiveForEvent(eventId: number): Promise<boolean> {
    const { rowCount } = await this.db.query(
      `SELECT 1 FROM jobs WHERE status IN ('queued','running') AND (payload->>'eventId')::bigint = $1 LIMIT 1`,
      [eventId],
    );
    return (rowCount ?? 0) > 0;
  }

  /** Jobs left 'running' by a crashed/restarted process (no heartbeat for a while) go back to the queue. */
  async requeueStale(olderThanMinutes = 5): Promise<Job[]> {
    // A job whose process dies every single time (OOM, crash loop) must not be retried forever.
    const { rows } = await this.db.query<Job & { status: string }>(
      `UPDATE jobs SET status = CASE WHEN attempts >= max_attempts THEN 'failed' ELSE 'queued' END,
         locked_at = NULL, run_after = now(), last_error = COALESCE(last_error, 'lease expired'), updated_at = now()
       WHERE status = 'running' AND locked_at < now() - make_interval(mins => $1)
       RETURNING id, kind, payload, attempts, max_attempts, status`,
      [olderThanMinutes],
    );
    return rows.filter((r) => r.status === 'failed');
  }

  async pruneFinished(days = 14): Promise<void> {
    await this.db.query(
      `DELETE FROM jobs WHERE status IN ('done','failed') AND updated_at < now() - make_interval(days => $1)`,
      [days],
    );
  }
}
