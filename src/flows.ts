import { describe, isTransientTelegramError, isUnreachable } from './bot/telegram.js';
import { cardView, invitationView, reviewView, sentReportView } from './bot/views.js';
import { esc } from './html.js';
import { t } from './i18n.js';
import { log } from './log.js';
import type { Services } from './services.js';
import type { EventRow, EventStatus, Invitation, User } from './types.js';
import { displayName } from './types.js';

/**
 * Operations shared by the Telegram handlers and the background jobs.
 * All state changes go through conditional status transitions, so double taps and job retries are harmless.
 */

export class RetryableError extends Error {}

export async function groupFor(s: Services, organizerChatId: number): Promise<{ organizer: User | null; recipients: User[] }> {
  const active = await s.repo.getActiveUsers();
  return {
    organizer: active.find((u) => u.chat_id === organizerChatId) ?? null,
    recipients: active.filter((u) => u.chat_id !== organizerChatId),
  };
}

export async function usersById(s: Services, ids: number[]): Promise<Map<number, User>> {
  const map = new Map<number, User>();
  for (const id of new Set(ids)) {
    const u = await s.repo.getUser(id);
    if (u) map.set(id, u);
  }
  return map;
}

/** Post the event card (what / where / when / who + "send now or review?"). */
export async function showCard(s: Services, event: EventRow): Promise<void> {
  const { organizer, recipients } = await groupFor(s, event.organizer_chat_id);
  if (!organizer) return;
  if (!recipients.length) {
    await s.repo.transitionEvent(event.id, ['confirming'], 'cancelled');
    await s.tg.send(organizer.chat_id, t(organizer.language, 'no_recipients'));
    return;
  }
  const view = cardView(organizer.language, event, recipients);
  const messageId = await s.tg.send(organizer.chat_id, view.text, view.keyboard);
  await s.repo.updateEvent(event.id, { card_message_id: messageId });
}

/** Replace the card's buttons with a status line (e.g. "Writing personal invitations…"). */
export async function freezeCard(s: Services, event: EventRow, organizer: User, footer: string): Promise<void> {
  if (!event.card_message_id) return;
  const invitations = await s.repo.listInvitations(event.id);
  const people = await usersById(s, invitations.map((i) => i.recipient_chat_id));
  const recipients = invitations.length ? [...people.values()] : (await groupFor(s, organizer.chat_id)).recipients;
  const view = cardView(organizer.language, event, recipients, footer);
  await s.tg.edit(organizer.chat_id, event.card_message_id, view.text);
}

/** Render the single "review invitations" message (list of people, or the draft that is open). */
export async function renderReview(s: Services, event: EventRow, organizer: User, updating: number[] = []): Promise<void> {
  const invitations = await s.repo.listInvitations(event.id);
  const people = await usersById(s, invitations.map((i) => i.recipient_chat_id));
  const view = reviewView(organizer.language, { event, invitations, people, updating: new Set(updating) });
  if (event.review_message_id) {
    const ok = await s.tg.edit(organizer.chat_id, event.review_message_id, view.text, view.keyboard);
    if (ok) return;
  }
  const messageId = await s.tg.send(organizer.chat_id, view.text, view.keyboard);
  await s.repo.updateEvent(event.id, { review_message_id: messageId });
}

/**
 * Send every queued invitation of an event (status 'sending'). Unreachable recipients fail immediately;
 * other Telegram errors are retried by the job (RetryableError) up to 3 attempts per invitation.
 */
export async function sendQueued(s: Services, event: EventRow): Promise<void> {
  const invitations = await s.repo.listInvitations(event.id);
  let transient: string | null = null;
  for (const inv of invitations) {
    // 'sending' rows are left over from a run that died mid-send (the job lease makes runs exclusive):
    // re-sending may rarely duplicate, but an invitation is never silently lost.
    if (inv.status !== 'queued' && inv.status !== 'sending') continue;
    const claimed = await s.repo.transitionInvitation(inv.id, ['queued', 'sending'], 'sending', { attempts: inv.attempts + 1 });
    if (!claimed) continue;
    if (!claimed.final_text) {
      // Never send the untranslated base text.
      await s.repo.transitionInvitation(inv.id, ['sending'], 'failed', { last_error: 'no translated text' });
      continue;
    }
    let messageId: number;
    try {
      const view = invitationView(claimed, event);
      messageId = await s.tg.send(claimed.recipient_chat_id, view.text, view.keyboard);
    } catch (err) {
      const reason = describe(err);
      log.warn('send', `invitation ${inv.id} failed`, { reason, attempts: claimed.attempts });
      if (isUnreachable(err)) {
        await s.repo.transitionInvitation(inv.id, ['sending'], 'failed', { last_error: `unreachable: ${reason}` });
      } else if (claimed.attempts >= 3 || !isTransientTelegramError(err)) {
        await s.repo.transitionInvitation(inv.id, ['sending'], 'failed', { last_error: reason });
      } else {
        await s.repo.transitionInvitation(inv.id, ['sending'], 'queued', { last_error: reason });
        transient = reason;
      }
      continue;
    }
    // Outside the catch: a DB error here must not mark a delivered invitation as failed (the job retries instead).
    await s.repo.transitionInvitation(inv.id, ['sending'], 'sent', { message_id: messageId, last_error: null });
  }
  if (transient) throw new RetryableError(`some invitations could not be sent yet: ${transient}`);
  await finishSending(s, event);
}

/** Mark the event sent, lock the review messages and report to the organizer (once). */
export async function finishSending(s: Services, event: EventRow, giveUp = false): Promise<void> {
  if (giveUp) {
    for (const inv of await s.repo.listInvitations(event.id)) {
      if (inv.status === 'queued' || inv.status === 'sending') {
        await s.repo.transitionInvitation(inv.id, ['queued', 'sending'], 'failed', { last_error: inv.last_error ?? 'gave up' });
      }
    }
  }
  const done = await s.repo.transitionEvent(event.id, ['sending'], 'sent', { open_invitation_id: null });
  if (!done) return; // already reported
  const organizer = await s.repo.getUser(event.organizer_chat_id);
  if (!organizer) return;
  const invitations = await s.repo.listInvitations(event.id);
  // The review message stays as a read-only summary of who got what.
  if (done.review_message_id) await s.tg.setKeyboard(organizer.chat_id, done.review_message_id);
  const people = await usersById(s, invitations.map((i) => i.recipient_chat_id));
  const failed = invitations
    .filter((i) => i.status === 'failed')
    .map((i) => ({
      name: people.get(i.recipient_chat_id) ? displayName(people.get(i.recipient_chat_id)!) : String(i.recipient_chat_id),
      blocked: (i.last_error ?? '').startsWith('unreachable'),
    }));
  const notSent = invitations
    .filter((i) => i.status === 'draft' || i.status === 'excluded' || i.status === 'pending')
    .map((i) => {
      const u = people.get(i.recipient_chat_id);
      return u ? displayName(u) : String(i.recipient_chat_id);
    });
  const sent = invitations.filter((i) => i.status === 'sent').length;
  // The event is already 'sent'; a failed report must not fail (and retry) the job.
  await s.tg.trySend(organizer.chat_id, sentReportView(organizer.language, sent, failed, notSent));
}

/** Give up on an event (job failed for good): tell the organizer. */
export async function failEvent(s: Services, eventId: number, from: EventStatus[], error: string): Promise<void> {
  const event = await s.repo.transitionEvent(eventId, from, 'failed', { error: error.slice(0, 1000) });
  if (!event) return;
  const organizer = await s.repo.getUser(event.organizer_chat_id);
  if (!organizer) return;
  if (event.card_message_id) await s.tg.setKeyboard(organizer.chat_id, event.card_message_id);
  await s.tg.trySend(
    organizer.chat_id,
    t(organizer.language, 'error_event', { activity: esc(event.plan?.activity_local ?? event.original_text.slice(0, 60)) }),
  );
}
