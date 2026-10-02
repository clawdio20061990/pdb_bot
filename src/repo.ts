import type { Db } from './db.js';
import type {
  EventRow,
  EventStatus,
  Invitation,
  InvitationStatus,
  PendingInput,
  PendingKind,
  Rsvp,
  User,
} from './types.js';

const JSONB_COLUMNS = new Set(['plan', 'venue_options', 'venue', 'venue_facts', 'payload']);

/** Build "col1 = $n, col2 = $n+1" for a patch object. JSONB values are stringified (pg would turn arrays into PG arrays). */
function setClause(patch: Record<string, unknown>, startIndex: number): { sql: string; values: unknown[] } {
  const cols = Object.keys(patch).filter((k) => patch[k] !== undefined);
  const values = cols.map((c) => (JSONB_COLUMNS.has(c) && patch[c] !== null ? JSON.stringify(patch[c]) : patch[c]));
  const sql = cols.map((c, i) => `${c} = $${startIndex + i}`).join(', ');
  return { sql, values };
}

export interface SeedUser {
  chat_id: number;
  username?: string | null;
  name?: string | null;
  language: string;
  likes: string;
  dislikes: string;
}

export class Repo {
  constructor(private readonly db: Db) {}

  // ---------- users ----------

  /** data/users.json is the source of truth: upsert everyone listed, deactivate everyone else. */
  async syncUsers(seeds: SeedUser[]): Promise<{ upserted: number; deactivated: number }> {
    const client = await this.db.connect();
    let broken: Error | undefined;
    try {
      await client.query('BEGIN');
      for (const s of seeds) {
        await client.query(
          `INSERT INTO users (chat_id, username, name, language, likes, dislikes, is_active)
           VALUES ($1, $2, $3, $4, $5, $6, TRUE)
           ON CONFLICT (chat_id) DO UPDATE SET
             username = EXCLUDED.username, name = EXCLUDED.name, language = EXCLUDED.language,
             likes = EXCLUDED.likes, dislikes = EXCLUDED.dislikes, is_active = TRUE, updated_at = now()`,
          [s.chat_id, s.username ?? null, s.name ?? null, s.language, s.likes, s.dislikes],
        );
      }
      const res = await client.query(
        `UPDATE users SET is_active = FALSE, updated_at = now() WHERE is_active AND NOT (chat_id = ANY($1::bigint[]))`,
        [seeds.map((s) => s.chat_id)],
      );
      await client.query('COMMIT');
      return { upserted: seeds.length, deactivated: res.rowCount ?? 0 };
    } catch (err) {
      broken = err as Error;
      await client.query('ROLLBACK').catch(() => {});
      throw err;
    } finally {
      client.release(broken); // a failed connection is destroyed instead of going back to the pool
    }
  }

  async getUser(chatId: number): Promise<User | null> {
    const { rows } = await this.db.query<User>('SELECT * FROM users WHERE chat_id = $1', [chatId]);
    return rows[0] ?? null;
  }

  async getActiveUsers(): Promise<User[]> {
    const { rows } = await this.db.query<User>('SELECT * FROM users WHERE is_active ORDER BY chat_id');
    return rows;
  }

  async rememberTelegramName(chatId: number, firstName: string | undefined): Promise<void> {
    if (!firstName) return;
    await this.db.query(
      `UPDATE users SET tg_first_name = $2, updated_at = now() WHERE chat_id = $1 AND tg_first_name IS DISTINCT FROM $2`,
      [chatId, firstName],
    );
  }

  // ---------- events ----------

  async createEvent(organizerChatId: number, originalText: string): Promise<EventRow> {
    const { rows } = await this.db.query<EventRow>(
      `INSERT INTO events (organizer_chat_id, original_text, status) VALUES ($1, $2, 'planning') RETURNING *`,
      [organizerChatId, originalText],
    );
    return rows[0]!;
  }

  async getEvent(id: number): Promise<EventRow | null> {
    const { rows } = await this.db.query<EventRow>('SELECT * FROM events WHERE id = $1', [id]);
    return rows[0] ?? null;
  }

  async updateEvent(id: number, patch: Partial<Omit<EventRow, 'id' | 'created_at'>>): Promise<EventRow | null> {
    const { sql, values } = setClause(patch, 2);
    if (!sql) return this.getEvent(id);
    const { rows } = await this.db.query<EventRow>(
      `UPDATE events SET ${sql}, updated_at = now() WHERE id = $1 RETURNING *`,
      [id, ...values],
    );
    return rows[0] ?? null;
  }

  /** Atomic status change; returns null when the event wasn't in one of `from` (double taps, races). */
  async transitionEvent(
    id: number,
    from: EventStatus[],
    to: EventStatus,
    patch: Partial<Omit<EventRow, 'id' | 'created_at' | 'status'>> = {},
  ): Promise<EventRow | null> {
    const { sql, values } = setClause(patch, 4);
    const { rows } = await this.db.query<EventRow>(
      `UPDATE events SET status = $3${sql ? `, ${sql}` : ''}, updated_at = now()
       WHERE id = $1 AND status = ANY($2::text[]) RETURNING *`,
      [id, from, to, ...values],
    );
    return rows[0] ?? null;
  }

  async recentEvents(organizerChatId: number, limit = 5): Promise<EventRow[]> {
    const { rows } = await this.db.query<EventRow>(
      'SELECT * FROM events WHERE organizer_chat_id = $1 ORDER BY id DESC LIMIT $2',
      [organizerChatId, limit],
    );
    return rows;
  }

  async latestOpenEvent(organizerChatId: number): Promise<EventRow | null> {
    const { rows } = await this.db.query<EventRow>(
      `SELECT * FROM events WHERE organizer_chat_id = $1
         AND status IN ('planning','choosing_venue','confirming','drafting','reviewing')
       ORDER BY id DESC LIMIT 1`,
      [organizerChatId],
    );
    return rows[0] ?? null;
  }

  /**
   * Review -> sending in ONE statement (atomic even through PgBouncer): the event and its translated drafts move
   * together, so a crash can't leave an event 'sending' with its invitations still in 'draft'.
   */
  async startSending(eventId: number): Promise<EventRow | null> {
    const { rows } = await this.db.query<EventRow>(
      `WITH ev AS (
         UPDATE events SET status = 'sending', updated_at = now() WHERE id = $1 AND status = 'reviewing' RETURNING *
       ), q AS (
         UPDATE invitations SET status = 'queued', updated_at = now()
         WHERE event_id IN (SELECT id FROM ev) AND status = 'draft' AND final_text IS NOT NULL
         RETURNING id
       )
       SELECT * FROM ev`, // data-modifying CTEs always run, even when not referenced
      [eventId],
    );
    return rows[0] ?? null;
  }

  /** Events stuck in a working state with no job to move them on (crash between two steps). */
  async orphanedEvents(olderThanMinutes = 5): Promise<EventRow[]> {
    const { rows } = await this.db.query<EventRow>(
      `SELECT * FROM events e
       WHERE e.status IN ('planning','drafting','sending')
         AND e.updated_at < now() - make_interval(mins => $1)
         AND NOT EXISTS (
           SELECT 1 FROM jobs j WHERE j.status IN ('queued','running') AND (j.payload->>'eventId')::bigint = e.id
         )`,
      [olderThanMinutes],
    );
    return rows;
  }

  /** Maps terms: place labels offered to the organizer are not kept longer than needed. */
  async purgeVenueOptions(days = 30): Promise<void> {
    await this.db.query(
      `UPDATE events SET venue_options = NULL, venue_facts = NULL
       WHERE (venue_options IS NOT NULL OR venue_facts IS NOT NULL) AND created_at < now() - make_interval(days => $1)`,
      [days],
    );
  }

  // ---------- invitations ----------

  async createInvitations(eventId: number, recipients: User[]): Promise<Invitation[]> {
    for (const r of recipients) {
      await this.db.query(
        `INSERT INTO invitations (event_id, recipient_chat_id, language) VALUES ($1, $2, $3)
         ON CONFLICT (event_id, recipient_chat_id) DO NOTHING`,
        [eventId, r.chat_id, r.language],
      );
    }
    return this.listInvitations(eventId);
  }

  async getInvitation(id: number): Promise<Invitation | null> {
    const { rows } = await this.db.query<Invitation>('SELECT * FROM invitations WHERE id = $1', [id]);
    return rows[0] ?? null;
  }

  /** The sent invitation a recipient is replying to (Telegram "reply" on the invitation message). */
  async sentInvitationByMessage(recipientChatId: number, messageId: number): Promise<Invitation | null> {
    const { rows } = await this.db.query<Invitation>(
      `SELECT * FROM invitations WHERE recipient_chat_id = $1 AND message_id = $2 AND status = 'sent'`,
      [recipientChatId, messageId],
    );
    return rows[0] ?? null;
  }

  async listInvitations(eventId: number): Promise<Invitation[]> {
    const { rows } = await this.db.query<Invitation>('SELECT * FROM invitations WHERE event_id = $1 ORDER BY id', [
      eventId,
    ]);
    return rows;
  }

  async updateInvitation(id: number, patch: Partial<Omit<Invitation, 'id' | 'event_id'>>): Promise<Invitation | null> {
    const { sql, values } = setClause(patch, 2);
    if (!sql) return this.getInvitation(id);
    const { rows } = await this.db.query<Invitation>(
      `UPDATE invitations SET ${sql}, updated_at = now() WHERE id = $1 RETURNING *`,
      [id, ...values],
    );
    return rows[0] ?? null;
  }

  async transitionInvitation(
    id: number,
    from: InvitationStatus[],
    to: InvitationStatus,
    patch: Partial<Omit<Invitation, 'id' | 'event_id' | 'status'>> = {},
  ): Promise<Invitation | null> {
    const { sql, values } = setClause(patch, 4);
    const { rows } = await this.db.query<Invitation>(
      `UPDATE invitations SET status = $3${sql ? `, ${sql}` : ''}, updated_at = now()
       WHERE id = $1 AND status = ANY($2::text[]) RETURNING *`,
      [id, from, to, ...values],
    );
    return rows[0] ?? null;
  }

  /** Move every invitation of an event from one status to another; returns the moved rows. */
  async transitionAllInvitations(eventId: number, from: InvitationStatus[], to: InvitationStatus): Promise<Invitation[]> {
    const { rows } = await this.db.query<Invitation>(
      `UPDATE invitations SET status = $3, updated_at = now()
       WHERE event_id = $1 AND status = ANY($2::text[]) RETURNING *`,
      [eventId, from, to],
    );
    return rows;
  }

  /** Records an RSVP only on a sent invitation; returns the previous answer so we can skip duplicate notifications. */
  async setRsvp(id: number, rsvp: Rsvp): Promise<{ previous: Rsvp | null; invitation: Invitation } | null> {
    const { rows } = await this.db.query<Invitation & { previous: Rsvp | null }>(
      `WITH old AS (SELECT id, rsvp AS previous FROM invitations WHERE id = $1 AND status = 'sent' FOR UPDATE)
       UPDATE invitations i SET rsvp = $2, rsvp_at = now(), updated_at = now()
       FROM old WHERE i.id = old.id
       RETURNING i.*, old.previous`,
      [id, rsvp],
    );
    const row = rows[0];
    if (!row) return null;
    const { previous, ...invitation } = row;
    return { previous, invitation };
  }

  async tally(eventId: number): Promise<{ yes: number; maybe: number; no: number; none: number }> {
    const { rows } = await this.db.query<{ rsvp: Rsvp | null; n: number }>(
      `SELECT rsvp, count(*)::int AS n FROM invitations WHERE event_id = $1 AND status = 'sent' GROUP BY rsvp`,
      [eventId],
    );
    const out = { yes: 0, maybe: 0, no: 0, none: 0 };
    for (const r of rows) out[r.rsvp ?? 'none'] += r.n;
    return out;
  }

  // ---------- pending inputs ----------

  async setPending(chatId: number, kind: PendingKind, refId: number): Promise<void> {
    await this.db.query(
      `INSERT INTO pending_inputs (chat_id, kind, ref_id) VALUES ($1, $2, $3)
       ON CONFLICT (chat_id) DO UPDATE SET kind = EXCLUDED.kind, ref_id = EXCLUDED.ref_id, created_at = now()`,
      [chatId, kind, refId],
    );
  }

  /** Consume the pending input if it is still fresh; stale ones are dropped. */
  async takePending(chatId: number, maxAgeMinutes = 30): Promise<PendingInput | null> {
    const { rows } = await this.db.query<PendingInput & { fresh: boolean }>(
      `DELETE FROM pending_inputs WHERE chat_id = $1
       RETURNING *, created_at > now() - make_interval(mins => $2) AS fresh`,
      [chatId, maxAgeMinutes],
    );
    const row = rows[0];
    if (!row || !row.fresh) return null;
    const { fresh: _fresh, ...pending } = row;
    return pending;
  }

  async clearPending(chatId: number): Promise<boolean> {
    const res = await this.db.query('DELETE FROM pending_inputs WHERE chat_id = $1', [chatId]);
    return (res.rowCount ?? 0) > 0;
  }

  // ---------- webhook de-duplication ----------

  /** true the first time an update_id is seen. */
  async markUpdateProcessed(updateId: number): Promise<boolean> {
    const res = await this.db.query(
      'INSERT INTO processed_updates (update_id) VALUES ($1) ON CONFLICT DO NOTHING',
      [updateId],
    );
    return (res.rowCount ?? 0) > 0;
  }

  async pruneProcessedUpdates(days = 7): Promise<void> {
    await this.db.query(`DELETE FROM processed_updates WHERE created_at < now() - make_interval(days => $1)`, [days]);
  }
}
