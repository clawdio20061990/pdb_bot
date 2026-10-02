import type { Bot, Context } from 'grammy';
import { freezeCard, groupFor, renderReview, showCard } from '../flows.js';
import { cut, esc } from '../html.js';
import { t, uiLang } from '../i18n.js';
import { errMessage, log } from '../log.js';
import type { Services } from '../services.js';
import { languageName } from '../time.js';
import { blockAbout } from '../ai/places.js';
import type { EventRow, EventStatus, Invitation, PendingInput, User, Venue, VenueFacts, VenueOption } from '../types.js';
import { displayName, mapsUrl, OPEN_EVENT_STATUSES } from '../types.js';
import { type Action, decode } from './callbacks.js';
import { invitationKeyboard, rsvpNotifyView, sendableDrafts, statusView } from './views.js';

export type BotContext = Context & { user: User | null };

const MAX_IDEA_LENGTH = 1000;
/** Actions that ask the user to type something next; every other action cancels a pending prompt. */
const PROMPTING_ACTIONS = new Set<Action['t']>(['own_venue', 'edit_draft', 'ai_draft']);

export function registerHandlers(bot: Bot<BotContext>, s: Services): void {
  // Error boundary first: in webhook mode grammY hands errors to the HTTP layer (-> 500 -> Telegram redelivery).
  bot.use(async (ctx, next) => {
    try {
      await next();
    } catch (err) {
      log.error('bot', 'update failed', { update_id: ctx.update.update_id, error: errMessage(err) });
      if (ctx.callbackQuery) await ctx.answerCallbackQuery().catch(() => {});
      if (ctx.chat) await s.tg.trySend(ctx.chat.id, t(ctx.user?.language ?? ctx.from?.language_code, 'error_generic'));
    }
  });

  // Private chats only; each update once (Telegram redelivers when the webhook is slow).
  bot.use(async (ctx, next) => {
    if (ctx.chat?.type !== 'private' || !ctx.from) return;
    if (!(await s.repo.markUpdateProcessed(ctx.update.update_id))) return;
    ctx.user = await s.repo.getUser(ctx.from.id);
    if (ctx.user && !ctx.user.is_active) ctx.user = null;
    if (ctx.user) await s.repo.rememberTelegramName(ctx.from.id, ctx.from.first_name);
    await next();
  });

  // ---------------- commands ----------------

  bot.command(['start', 'help'], async (ctx) => {
    const u = ctx.user;
    if (!u) return void (await notRegistered(s, ctx));
    await s.tg.send(ctx.chat!.id, t(u.language, 'start_registered', { name: esc(displayName(u)) }));
  });

  // /whoami answers everyone — that's how a new person gets the chat id to send to the admin.
  bot.command('whoami', async (ctx) => {
    const u = ctx.user;
    const from = ctx.from!; // the second middleware already rejected updates without a sender
    const lang = u?.language ?? from.language_code;
    const status = u
      ? t(lang, 'whoami_registered', { name: esc(displayName(u)), language: esc(languageName(u.language, uiLang(lang))) })
      : t(lang, 'whoami_unregistered');
    await s.tg.send(ctx.chat!.id, t(lang, 'whoami', { chatId: from.id, status }));
  });

  bot.command('profile', async (ctx) => {
    const u = ctx.user;
    if (!u) return void (await notRegistered(s, ctx));
    await s.tg.send(ctx.chat!.id, t(u.language, 'profile', {
        name: esc(displayName(u)),
        language: esc(languageName(u.language, uiLang(u.language))),
        likes: esc(u.likes || '—'),
        dislikes: esc(u.dislikes || '—'),
      }));
  });

  bot.command('status', async (ctx) => {
    const u = ctx.user;
    if (!u) return void (await notRegistered(s, ctx));
    const events = await s.repo.recentEvents(u.chat_id, 5);
    const rows = await Promise.all(events.map(async (event) => ({ event, tally: await s.repo.tally(event.id) })));
    await s.tg.send(ctx.chat!.id, statusView(u.language, rows));
  });

  bot.command('cancel', async (ctx) => {
    const u = ctx.user;
    if (!u) return void (await notRegistered(s, ctx));
    if (await s.repo.clearPending(u.chat_id)) return void (await s.tg.send(ctx.chat!.id, t(u.language, 'input_cancelled')));
    const open = await s.repo.latestOpenEvent(u.chat_id);
    if (open && (await cancelEvent(s, open, u))) return;
    await s.tg.send(ctx.chat!.id, t(u.language, 'nothing_to_cancel'));
  });

  // ---------------- text messages ----------------

  bot.on('message:text', async (ctx) => {
    const u = ctx.user;
    if (!u) return void (await notRegistered(s, ctx));
    const text = ctx.message.text.trim();
    if (!text || text.startsWith('/')) return;

    // 1) an answer to a "type …" prompt
    const pending = await s.repo.takePending(u.chat_id);
    if (pending && (await handlePendingInput(s, ctx, u, pending, text))) return;

    // 2) a Telegram "reply" to an invitation = a counter-proposal for its organizer
    const replyTo = ctx.message.reply_to_message?.message_id;
    const replied = replyTo ? await s.repo.sentInvitationByMessage(u.chat_id, replyTo) : null;
    if (replied) return void (await forwardProposal(s, ctx, u, replied, text));

    // 3) anything else is a new meetup idea
    const { recipients } = await groupFor(s, u.chat_id);
    if (!recipients.length) return void (await s.tg.send(ctx.chat!.id, t(u.language, 'no_recipients')));
    const event = await s.repo.createEvent(u.chat_id, cut(text, MAX_IDEA_LENGTH));
    await s.queue.enqueue('plan_event', { eventId: event.id });
    await s.tg.send(ctx.chat!.id, t(u.language, 'analyzing'));
  });

  bot.on('message', async (ctx) => {
    if (!ctx.user) return void (await notRegistered(s, ctx));
    await s.tg.send(ctx.chat!.id, t(ctx.user.language, 'text_only'));
  });

  // ---------------- buttons ----------------

  bot.on('callback_query:data', async (ctx) => {
    const action = decode(ctx.callbackQuery.data);
    const u = ctx.user;
    if (!action || !u) {
      const text = u ? undefined : t(ctx.from.language_code, 'not_registered', { chatId: ctx.from.id }).replace(/<[^>]+>/g, '');
      await ctx.answerCallbackQuery(text ? { text: text.slice(0, 200), show_alert: true } : undefined);
      return;
    }
    // Tapping anything else abandons a "type …" prompt, so the next message isn't swallowed by it.
    if (!PROMPTING_ACTIONS.has(action.t)) await s.repo.clearPending(u.chat_id);
    const toast = await handleAction(s, ctx, u, action);
    await ctx.answerCallbackQuery(toast ? { text: toast.replace(/<[^>]+>/g, '').slice(0, 200) } : undefined).catch(() => {});
  });
}

async function notRegistered(s: Services, ctx: BotContext): Promise<void> {
  await s.tg.send(ctx.chat!.id, t(ctx.from?.language_code, 'not_registered', { chatId: ctx.from?.id ?? '?' }));
}

// ---------------------------------------------------------------------------
// Replies to "type something" prompts. Returns false when the prompt no longer applies
// (the text is then handled as a normal message).
// ---------------------------------------------------------------------------

async function handlePendingInput(s: Services, ctx: BotContext, u: User, pending: PendingInput, text: string): Promise<boolean> {
  const lang = u.language;
  switch (pending.kind) {
    case 'own_venue': {
      const event = await ownedEvent(s, pending.ref_id, u);
      if (!event?.plan || event.status !== 'choosing_venue') return false;
      const name = cut(text, 120);
      const plan = { ...event.plan, venue_kind: 'public' as const, venue_name: name };
      if (!(await s.repo.transitionEvent(event.id, ['choosing_venue'], 'planning', { plan }))) return false;
      await s.queue.enqueue('research_venue', { eventId: event.id, venueName: name });
      await s.tg.send(ctx.chat!.id, t(lang, 'checking_venue', { name: esc(name) }));
      return true;
    }
    case 'edit_draft':
    case 'ai_tweak': {
      const c = await reviewableDraft(s, pending.ref_id, u);
      if (!c) return false;
      if (await draftBusy(s, c.inv.id)) {
        await s.tg.send(ctx.chat!.id, t(lang, 'busy'));
        return true;
      }
      if (pending.kind === 'edit_draft') {
        // Guarded write: the draft may have been sent/cancelled meanwhile.
        const inv = await s.repo.transitionInvitation(c.inv.id, ['draft', 'excluded'], c.inv.status, {
          base_text: cut(text, 1500),
          final_text: null,
        });
        if (!inv) return false;
        await s.queue.enqueue('retranslate', { invitationId: inv.id });
      } else {
        await s.queue.enqueue('redraft', { invitationId: c.inv.id, instruction: cut(text, 500) });
      }
      await renderReview(s, await openDraft(s, c.event, c.inv.id), u, [c.inv.id]);
      return true;
    }
  }
}

/** Remember which draft the review message shows (so job results land on the right view). */
async function openDraft(s: Services, event: EventRow, invitationId: number | null): Promise<EventRow> {
  return (await s.repo.updateEvent(event.id, { open_invitation_id: invitationId })) ?? event;
}

async function forwardProposal(s: Services, ctx: BotContext, u: User, inv: Invitation, text: string): Promise<void> {
  const proposal = cut(text, 1000);
  const event = await s.repo.getEvent(inv.event_id);
  const organizer = event ? await s.repo.getUser(event.organizer_chat_id) : null;
  await s.repo.updateInvitation(inv.id, { proposal });
  await s.queue.enqueue('forward_proposal', { invitationId: inv.id, text: proposal });
  await s.tg.send(ctx.chat!.id, t(u.language, 'proposal_sent', { organizer: esc(organizer ? displayName(organizer) : '') }));
}

// ---------------------------------------------------------------------------
// Button actions. Returns an optional toast for answerCallbackQuery.
// ---------------------------------------------------------------------------

async function handleAction(s: Services, ctx: BotContext, u: User, a: Action): Promise<string | undefined> {
  const lang = u.language;
  const clearButtons = () => ctx.editMessageReplyMarkup().catch(() => {});

  /** Confirm a place: show the card first; if that fails, go back so the button can be tapped again. */
  const confirmVenue = async (event: EventRow, venue: Venue, venue_facts: VenueFacts | null): Promise<boolean> => {
    const ev = await s.repo.transitionEvent(event.id, ['choosing_venue'], 'confirming', { venue, venue_facts });
    if (!ev) return false;
    try {
      await showCard(s, ev);
    } catch (err) {
      await s.repo.transitionEvent(event.id, ['confirming'], 'choosing_venue');
      throw err;
    }
    await clearButtons();
    return true;
  };

  switch (a.t) {
    // ----- organizer: choosing the place -----
    case 'pick_venue': {
      const event = await ownedEvent(s, a.eventId, u);
      if (!event) return t(lang, 'not_yours');
      const option = event.venue_options?.[a.index];
      if (!option) return t(lang, 'event_locked');
      const venue: Venue = { name: option.name, place_id: option.place_id, maps_url: mapsUrl(option.name, option.place_id, s.cfg.CITY_NAME) };
      return (await confirmVenue(event, venue, factsFor(event, option))) ? `📍 ${option.name}` : t(lang, 'event_locked');
    }
    case 'use_as_is': {
      const event = await ownedEvent(s, a.eventId, u);
      if (!event) return t(lang, 'not_yours');
      const name = event.plan?.venue_name;
      if (!name) return t(lang, 'event_locked');
      // The place couldn't be confirmed on Maps, so there are no facts to write invitations from.
      const venue: Venue = { name, place_id: null, maps_url: mapsUrl(name, null, s.cfg.CITY_NAME) };
      return (await confirmVenue(event, venue, null)) ? undefined : t(lang, 'event_locked');
    }
    case 'more_venues': {
      const event = await ownedEvent(s, a.eventId, u);
      if (!event) return t(lang, 'not_yours');
      if (!(await s.repo.transitionEvent(event.id, ['choosing_venue'], 'planning'))) return t(lang, 'event_locked');
      await s.queue.enqueue('suggest_more', { eventId: event.id });
      await clearButtons();
      return t(lang, 'searching_places');
    }
    case 'own_venue': {
      const event = await ownedEvent(s, a.eventId, u);
      if (!event) return t(lang, 'not_yours');
      if (event.status !== 'choosing_venue') return t(lang, 'event_locked');
      await s.repo.setPending(u.chat_id, 'own_venue', event.id);
      await s.tg.send(ctx.chat!.id, t(lang, 'ask_own_place'));
      return undefined;
    }
    case 'cancel_event': {
      const event = await ownedEvent(s, a.eventId, u);
      if (!event) return t(lang, 'not_yours');
      await clearButtons();
      return (await cancelEvent(s, event, u)) ? undefined : t(lang, 'event_locked');
    }

    // ----- organizer: send now / review -----
    case 'send_now':
    case 'review': {
      const event = await ownedEvent(s, a.eventId, u);
      if (!event) return t(lang, 'not_yours');
      const mode = a.t === 'send_now' ? 'now' : 'review';
      const ev = await s.repo.transitionEvent(event.id, ['confirming'], 'drafting', { send_mode: mode });
      if (!ev) return t(lang, 'event_locked');
      await s.queue.enqueue('generate', { eventId: ev.id }); // the job creates the invitations
      await freezeCard(s, ev, u, t(lang, 'generating'));
      return t(lang, 'generating');
    }
    case 'send_all': {
      const event = await ownedEvent(s, a.eventId, u);
      if (!event) return t(lang, 'not_yours');
      if (event.status !== 'reviewing') return t(lang, 'event_locked');
      const invitations = await s.repo.listInvitations(event.id);
      // Don't send while a draft is being rewritten/translated: its new text would be lost or go out untranslated.
      for (const inv of invitations) {
        if (inv.status === 'draft' && (await draftBusy(s, inv.id))) return t(lang, 'drafts_not_ready');
      }
      if (!sendableDrafts(invitations).length) return t(lang, 'nothing_to_send');
      const ev = await s.repo.startSending(event.id); // event + translated drafts move together
      if (!ev) return t(lang, 'event_locked');
      await s.queue.enqueue('send', { eventId: ev.id });
      if (ev.review_message_id) await s.tg.edit(u.chat_id, ev.review_message_id, t(lang, 'sending'));
      return t(lang, 'sending');
    }

    // ----- organizer: review drafts -----
    case 'open_draft': {
      const c = await reviewableDraft(s, a.invitationId, u);
      if (!c) return t(lang, 'event_locked');
      await renderReview(s, await openDraft(s, c.event, c.inv.id), u);
      return undefined;
    }
    case 'back_to_list': {
      const event = await ownedEvent(s, a.eventId, u);
      if (!event) return t(lang, 'not_yours');
      await renderReview(s, await openDraft(s, event, null), u);
      return undefined;
    }
    case 'edit_draft':
    case 'ai_draft': {
      const c = await reviewableDraft(s, a.invitationId, u);
      if (!c) return t(lang, 'event_locked');
      if (await draftBusy(s, c.inv.id)) return t(lang, 'busy');
      await s.repo.setPending(u.chat_id, a.t === 'edit_draft' ? 'edit_draft' : 'ai_tweak', c.inv.id);
      const vars = { name: esc(displayName(c.recipient)), language: esc(languageName(c.inv.language, uiLang(lang))) };
      await s.tg.send(ctx.chat!.id, t(lang, a.t === 'edit_draft' ? 'ask_edit' : 'ask_ai', vars));
      return undefined;
    }
    case 'regen_draft': {
      const c = await reviewableDraft(s, a.invitationId, u);
      if (!c) return t(lang, 'event_locked');
      if (await draftBusy(s, c.inv.id)) return t(lang, 'busy');
      await s.queue.enqueue('redraft', { invitationId: c.inv.id });
      await renderReview(s, await openDraft(s, c.event, c.inv.id), u, [c.inv.id]);
      return t(lang, 'draft_updating');
    }
    case 'exclude_draft':
    case 'include_draft': {
      const c = await reviewableDraft(s, a.invitationId, u);
      if (!c) return t(lang, 'event_locked');
      const [from, to] = a.t === 'exclude_draft' ? (['draft', 'excluded'] as const) : (['excluded', 'draft'] as const);
      const inv = await s.repo.transitionInvitation(c.inv.id, [from], to);
      if (!inv) return undefined;
      await renderReview(s, c.event, u);
      return undefined;
    }

    // ----- recipient -----
    case 'rsvp': {
      const inv = await s.repo.getInvitation(a.invitationId);
      if (!inv || inv.recipient_chat_id !== u.chat_id) return t(lang, 'not_yours');
      const res = await s.repo.setRsvp(inv.id, a.answer);
      if (!res) return t(lang, 'invitation_inactive');
      const event = await s.repo.getEvent(inv.event_id);
      if (!event) return t(lang, 'invitation_inactive');
      await ctx.editMessageReplyMarkup({ reply_markup: invitationKeyboard(lang, res.invitation, a.answer) }).catch(() => {});
      const organizer = await s.repo.getUser(event.organizer_chat_id);
      if (!organizer) return undefined;
      if (res.previous !== a.answer) {
        const tally = await s.repo.tally(event.id);
        await s.tg.trySend(organizer.chat_id, rsvpNotifyView(organizer.language, u, event, a.answer, res.previous !== null, tally));
      }
      return t(lang, 'rsvp_ack', { organizer: displayName(organizer) });
    }
  }
}

// ---------------------------------------------------------------------------
// helpers
// ---------------------------------------------------------------------------

/** Narrow the event's stored Maps answer down to the place the organizer picked. */
function factsFor(event: EventRow, option: VenueOption): VenueFacts | null {
  const facts = event.venue_facts;
  if (!facts) return null;
  const sources = facts.sources.filter((src) => src.place_id && src.place_id === option.place_id);
  return { text: blockAbout(facts.text, option), sources: sources.length ? sources : facts.sources };
}

async function ownedEvent(s: Services, eventId: number, u: User): Promise<EventRow | null> {
  const event = await s.repo.getEvent(eventId);
  return event && event.organizer_chat_id === u.chat_id ? event : null;
}

async function reviewableDraft(s: Services, invitationId: number, u: User) {
  const inv = await s.repo.getInvitation(invitationId);
  if (!inv || (inv.status !== 'draft' && inv.status !== 'excluded')) return null;
  const event = await ownedEvent(s, inv.event_id, u);
  if (!event || event.status !== 'reviewing') return null;
  const recipient = await s.repo.getUser(inv.recipient_chat_id);
  return recipient ? { inv, event, recipient } : null;
}

/** A redraft/retranslate for this draft is waiting or running. */
async function draftBusy(s: Services, invitationId: number): Promise<boolean> {
  return (await s.queue.hasActive('redraft', invitationId)) || (await s.queue.hasActive('retranslate', invitationId));
}

async function sentInvitation(s: Services, invitationId: number, u: User): Promise<Invitation | null> {
  const inv = await s.repo.getInvitation(invitationId);
  return inv && inv.recipient_chat_id === u.chat_id && inv.status === 'sent' ? inv : null;
}

/** Cancel an unsent event; returns false when it was already past the point of no return. */
async function cancelEvent(s: Services, event: EventRow, u: User): Promise<boolean> {
  const cancelled = await s.repo.transitionEvent(event.id, OPEN_EVENT_STATUSES as EventStatus[], 'cancelled');
  if (!cancelled) return false;
  await s.repo.clearPending(u.chat_id);
  if (cancelled.card_message_id) await s.tg.setKeyboard(u.chat_id, cancelled.card_message_id);
  if (cancelled.review_message_id) await s.tg.setKeyboard(u.chat_id, cancelled.review_message_id);
  await s.tg.send(u.chat_id, t(u.language, 'event_cancelled'));
  return true;
}
