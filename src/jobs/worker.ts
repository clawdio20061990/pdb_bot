import { GrammyError } from 'grammy';
import { GeminiError } from '../ai/gemini.js';
import { lookupVenue, parseIdea, rewriteInvitation, suggestVenues, translate, writeInvitation } from '../ai/pipeline.js';
import { groundedSources, matchingOptions, placeOptions } from '../ai/places.js';
import { isTransientTelegramError } from '../bot/telegram.js';
import { choiceView, groundedBlock, proposalNotifyView, suggestionsView, venueNotFoundView, whichPlaceView } from '../bot/views.js';
import { failEvent, finishSending, groupFor, renderReview, RetryableError, sendQueued, showCard, usersById } from '../flows.js';
import { esc } from '../html.js';
import { t } from '../i18n.js';
import { errMessage, log } from '../log.js';
import type { Services } from '../services.js';
import { nowInZone } from '../time.js';
import type { EventRow, EventStatus, User, Venue, VenueFacts, VenueOption } from '../types.js';
import { mapsUrl } from '../types.js';
import type { Job, JobKind, JobPayloads } from './queue.js';

type Handler<K extends JobKind> = (s: Services, payload: JobPayloads[K]) => Promise<void>;

/**
 * Commit a status change, then show its UI. If showing fails, undo the change and rethrow, so the job retry
 * redoes the whole step (and a final failure reaches onGiveUp) instead of leaving a silent, half-done event.
 */
async function transitionThenShow(
  s: Services,
  eventId: number,
  from: EventStatus,
  to: EventStatus,
  patch: Parameters<Services['repo']['transitionEvent']>[3],
  show: (ev: EventRow) => Promise<void>,
  undo: Parameters<Services['repo']['transitionEvent']>[3] = {},
): Promise<void> {
  const ev = await s.repo.transitionEvent(eventId, [from], to, patch);
  if (!ev) return; // cancelled meanwhile
  try {
    await show(ev);
  } catch (err) {
    await s.repo.transitionEvent(eventId, [to], from, undo).catch(() => {});
    throw err;
  }
}

// ---------------------------------------------------------------------------
// Planning: understand the idea, then look the place up or suggest places
// ---------------------------------------------------------------------------

const planEvent: Handler<'plan_event'> = async (s, { eventId }) => {
  const event = await s.repo.getEvent(eventId);
  if (!event || event.status !== 'planning') return;
  const { organizer } = await groupFor(s, event.organizer_chat_id);
  if (!organizer) {
    await s.repo.transitionEvent(eventId, ['planning'], 'cancelled');
    return;
  }

  const idea = await parseIdea(s.ai, event.original_text, organizer, nowInZone(s.cfg.TIMEZONE));
  if (!idea.is_event_idea) {
    await transitionThenShow(s, eventId, 'planning', 'cancelled', {}, async () => {
      await s.tg.send(organizer.chat_id, t(organizer.language, 'not_an_idea'));
    });
    return;
  }
  const { is_event_idea: _ignored, ...plan } = idea;
  const updated = await s.repo.transitionEvent(eventId, ['planning'], 'planning', { plan });
  if (!updated) return;

  if (plan.venue_kind === 'public' && plan.venue_name) return lookupAndShow(s, updated, organizer, plan.venue_name);
  if (plan.venue_kind === 'private' && plan.venue_name) {
    // Someone's home etc.: nothing to look up on Google Maps.
    const venue: Venue = { name: plan.venue_name, place_id: null, maps_url: null };
    return transitionThenShow(s, eventId, 'planning', 'confirming', { venue }, (ev) => showCard(s, ev));
  }
  await s.tg.trySend(organizer.chat_id, t(organizer.language, 'searching_places'));
  return suggestAndShow(s, updated, organizer);
};

/** Organizer-initiated Maps lookup of a named place. The grounded answer goes only to the organizer. */
async function lookupAndShow(s: Services, event: EventRow, organizer: User, venueName: string): Promise<void> {
  const plan = event.plan!;
  const lang = organizer.language;
  const res = await lookupVenue(s.ai, { venueName, plan, organizer, language: lang });
  const matches = res.outcome === 'found' ? matchingOptions(res, venueName) : [];
  // This one answer is also the fact sheet every invitation is written from (no further Maps calls).
  const venue_facts: VenueFacts = { text: res.text, sources: groundedSources(res) };

  if (!matches.length) {
    return transitionThenShow(s, event.id, 'planning', 'choosing_venue', {}, async (ev) => {
      const view = venueNotFoundView(lang, ev, venueName, res.outcome === 'outside');
      await s.tg.send(organizer.chat_id, view.text, view.keyboard);
    });
  }

  if (matches.length > 1) {
    // The name fits several places (a chain with more than one address): let the organizer pick.
    const buttons = matches.map((option, index) => ({ index, option }));
    return transitionThenShow(
      s,
      event.id,
      'planning',
      'choosing_venue',
      { venue_options: matches, venue_facts },
      async (ev) => {
        const view = whichPlaceView(lang, ev, res, buttons, venueName);
        await s.tg.send(organizer.chat_id, view.text, view.keyboard);
      },
      { venue_options: event.venue_options ?? null, venue_facts: event.venue_facts },
    );
  }

  const place = matches[0]!;
  const venue: Venue = { name: place.name, place_id: place.place_id, maps_url: mapsUrl(place.name, place.place_id, s.cfg.CITY_NAME) };
  await transitionThenShow(s, event.id, 'planning', 'confirming', { venue, venue_facts }, async (ev) => {
    await s.tg.send(organizer.chat_id, groundedBlock(lang, t(lang, 'place_info_header', { name: esc(place.name) }), res));
    await showCard(s, ev);
  });
}

/** Organizer-initiated Maps suggestions for the whole group. Options accumulate across "More options". */
async function suggestAndShow(s: Services, event: EventRow, organizer: User): Promise<void> {
  const plan = event.plan!;
  const previous = event.venue_options ?? [];
  const res = await suggestVenues(s.ai, {
    plan,
    organizer, // no venue named yet -> match the organizer's own profile
    exclude: previous.map((o) => o.name),
    language: organizer.language,
  });
  const all: VenueOption[] = [...previous];
  const buttons: { index: number; option: VenueOption }[] = [];
  for (const option of placeOptions(res)) {
    let index = all.findIndex((o) => (option.place_id ? o.place_id === option.place_id : o.name === option.name));
    if (index < 0) index = all.push(option) - 1;
    buttons.push({ index, option: all[index]! });
  }
  const venue_facts: VenueFacts = { text: res.text, sources: groundedSources(res) };
  await transitionThenShow(
    s,
    event.id,
    'planning',
    'choosing_venue',
    { venue_options: all, venue_facts },
    async (ev) => {
      const view = suggestionsView(organizer.language, ev, res, buttons);
      await s.tg.send(organizer.chat_id, view.text, view.keyboard);
    },
    // a retry must not exclude the places it just found
    { venue_options: previous.length ? previous : null, venue_facts: event.venue_facts },
  );
}

const suggestMore: Handler<'suggest_more'> = async (s, { eventId }) => {
  const event = await s.repo.getEvent(eventId);
  if (!event || event.status !== 'planning' || !event.plan) return;
  const organizer = await s.repo.getUser(event.organizer_chat_id);
  if (organizer) await suggestAndShow(s, event, organizer);
};

const researchVenue: Handler<'research_venue'> = async (s, { eventId, venueName }) => {
  const event = await s.repo.getEvent(eventId);
  if (!event || event.status !== 'planning' || !event.plan) return;
  const organizer = await s.repo.getUser(event.organizer_chat_id);
  if (organizer) await lookupAndShow(s, event, organizer, venueName);
};

// ---------------------------------------------------------------------------
// Invitations: write (not grounded) + translate, then review or send
// ---------------------------------------------------------------------------

function invitationInput(event: EventRow, organizer: User, recipient: User) {
  return {
    organizer,
    recipient,
    originalText: event.original_text,
    plan: event.plan!,
    venueName: event.venue?.name ?? null,
    facts: event.venue ? event.venue_facts : null, // the single Maps answer for this meetup
  };
}

async function localize(s: Services, text: string, language: string): Promise<string> {
  return language === 'en' ? text : translate(s.ai, text, language);
}

/** Run `fn` over items with at most `limit` in flight; rejects if any call rejects (after all settle). */
async function mapLimit<T>(items: T[], limit: number, fn: (item: T) => Promise<void>): Promise<void> {
  const queue = [...items];
  const errors: unknown[] = [];
  await Promise.all(
    Array.from({ length: Math.min(limit, queue.length) }, async () => {
      for (let item = queue.shift(); item !== undefined; item = queue.shift()) {
        try {
          await fn(item);
        } catch (err) {
          errors.push(err);
        }
      }
    }),
  );
  if (errors.length) throw errors[0];
}

const generate: Handler<'generate'> = async (s, { eventId }) => {
  const event = await s.repo.getEvent(eventId);
  if (!event || !event.plan || !['drafting', 'reviewing', 'sending'].includes(event.status)) return;
  const organizer = await s.repo.getUser(event.organizer_chat_id);
  if (!organizer) return;

  if (event.status === 'drafting') {
    // Created here (idempotently) rather than in the button handler, so a crash in between can't lose them.
    const { recipients } = await groupFor(s, organizer.chat_id);
    const invitations = await s.repo.createInvitations(eventId, recipients);
    const people = await usersById(s, invitations.map((i) => i.recipient_chat_id));
    const target = event.send_mode === 'review' ? 'draft' : 'queued';
    await mapLimit(
      invitations.filter((i) => i.status === 'pending'),
      3,
      async (inv) => {
        const recipient = people.get(inv.recipient_chat_id);
        if (!recipient) {
          await s.repo.transitionInvitation(inv.id, ['pending'], 'failed', { last_error: 'recipient is not registered' });
          return;
        }
        const base = await writeInvitation(s.ai, invitationInput(event, organizer, recipient));
        const final = await localize(s, base, recipient.language);
        await s.repo.transitionInvitation(inv.id, ['pending'], target, {
          base_text: base,
          final_text: final,
          language: recipient.language,
        });
      },
    );
  }

  if (event.send_mode === 'review') {
    const ev = (await s.repo.transitionEvent(eventId, ['drafting'], 'reviewing')) ?? (await s.repo.getEvent(eventId));
    if (ev?.status === 'reviewing') await renderReview(s, ev, organizer);
  } else {
    const ev = (await s.repo.transitionEvent(eventId, ['drafting'], 'sending')) ?? (await s.repo.getEvent(eventId));
    if (ev?.status === 'sending') await sendQueued(s, ev);
  }
};

const send: Handler<'send'> = async (s, { eventId }) => {
  const event = await s.repo.getEvent(eventId);
  if (event?.status === 'sending') await sendQueued(s, event);
};

async function draftContext(s: Services, invitationId: number) {
  const inv = await s.repo.getInvitation(invitationId);
  if (!inv || (inv.status !== 'draft' && inv.status !== 'excluded')) return null;
  const event = await s.repo.getEvent(inv.event_id);
  if (!event || event.status !== 'reviewing' || !event.plan) return null;
  const [organizer, recipient] = await Promise.all([s.repo.getUser(event.organizer_chat_id), s.repo.getUser(inv.recipient_chat_id)]);
  if (!organizer || !recipient) return null;
  return { inv, event, organizer, recipient };
}

const redraft: Handler<'redraft'> = async (s, { invitationId, instruction }) => {
  const c = await draftContext(s, invitationId);
  if (!c) return;
  const input = invitationInput(c.event, c.organizer, c.recipient);
  const base = instruction
    ? await rewriteInvitation(s.ai, input, c.inv.base_text ?? '', instruction)
    : await writeInvitation(s.ai, input);
  const final = await localize(s, base, c.recipient.language);
  await s.repo.transitionInvitation(invitationId, ['draft', 'excluded'], c.inv.status, { base_text: base, final_text: final });
  await renderReview(s, c.event, c.organizer);
};

const retranslate: Handler<'retranslate'> = async (s, { invitationId }) => {
  const c = await draftContext(s, invitationId);
  if (!c || !c.inv.base_text) return;
  // The organizer may have written in any language (even for English recipients), so always translate.
  const final = await translate(s.ai, c.inv.base_text, c.recipient.language);
  await s.repo.transitionInvitation(invitationId, ['draft', 'excluded'], c.inv.status, { final_text: final });
  await renderReview(s, c.event, c.organizer);
};

// ---------------------------------------------------------------------------
// Recipient-side: counter-proposals and "What's there for me?"
// ---------------------------------------------------------------------------

async function sentContext(s: Services, invitationId: number) {
  const inv = await s.repo.getInvitation(invitationId);
  if (!inv || inv.status !== 'sent') return null;
  const event = await s.repo.getEvent(inv.event_id);
  if (!event) return null;
  const [organizer, recipient] = await Promise.all([s.repo.getUser(event.organizer_chat_id), s.repo.getUser(inv.recipient_chat_id)]);
  if (!organizer || !recipient) return null;
  return { inv, event, organizer, recipient };
}

const forwardProposal: Handler<'forward_proposal'> = async (s, { invitationId, text: payloadText }) => {
  const c = await sentContext(s, invitationId);
  const text = payloadText ?? c?.inv.proposal; // each job forwards the proposal it was created for
  if (!c || !text) return;
  const translated = c.organizer.language === c.recipient.language ? text : await translate(s.ai, text, c.organizer.language);
  const original = translated.trim() !== text.trim() ? text : null;
  await s.tg.send(c.organizer.chat_id, proposalNotifyView(c.organizer.language, c.recipient, c.event, translated, original));
};

// ---------------------------------------------------------------------------
// Dispatch + final-failure handling
// ---------------------------------------------------------------------------

const handlers: { [K in JobKind]: Handler<K> } = {
  plan_event: planEvent,
  suggest_more: suggestMore,
  research_venue: researchVenue,
  generate,
  redraft,
  retranslate,
  send,
  forward_proposal: forwardProposal,
};

/** Called once a job has failed for good: leave nothing hanging and tell the right person. */
async function onGiveUp(s: Services, job: Job, error: string): Promise<void> {
  const p = job.payload as Partial<{ eventId: number; invitationId: number }>;
  switch (job.kind) {
    case 'plan_event':
      if (p.eventId) await failEvent(s, p.eventId, ['planning'], error);
      return;
    case 'suggest_more':
    case 'research_venue': {
      // The idea itself is fine; go back to choosing a place (keeping the options found so far).
      const ev = p.eventId ? await s.repo.transitionEvent(p.eventId, ['planning'], 'choosing_venue') : null;
      const organizer = ev ? await s.repo.getUser(ev.organizer_chat_id) : null;
      if (ev && organizer) {
        const view = choiceView(organizer.language, ev, t(organizer.language, 'search_failed'));
        await s.tg.trySend(organizer.chat_id, view.text, view.keyboard);
      }
      return;
    }
    case 'generate':
      if (p.eventId) {
        const event = await s.repo.getEvent(p.eventId);
        if (event?.status === 'sending') return finishSending(s, event, true);
        await failEvent(s, p.eventId, ['drafting', 'reviewing'], error);
      }
      return;
    case 'send':
      if (p.eventId) {
        const event = await s.repo.getEvent(p.eventId);
        if (event) await finishSending(s, event, true);
      }
      return;
    case 'redraft':
    case 'retranslate': {
      // Re-render with buttons (an edit whose translation failed shows "not translated yet" and can't be sent).
      const c = p.invitationId ? await draftContext(s, p.invitationId) : null;
      if (!c) return;
      await renderReview(s, c.event, c.organizer);
      await s.tg.trySend(c.organizer.chat_id, t(c.organizer.language, 'error_generic'));
      return;
    }
    case 'forward_proposal': {
      const c = p.invitationId ? await sentContext(s, p.invitationId) : null;
      if (c) await s.tg.trySend(c.recipient.chat_id, t(c.recipient.language, 'error_generic'));
      return;
    }
  }
}

function isRetryable(err: unknown): boolean {
  if (err instanceof GeminiError) return err.retryable;
  if (err instanceof RetryableError) return true;
  // Permanent Telegram errors (400/403) won't heal: don't repeat paid Gemini/Maps calls for them.
  if (err instanceof GrammyError) return isTransientTelegramError(err);
  return true; // DB hiccups, network errors: try again later
}

const HEARTBEAT_MS = 60_000;
const STALE_MINUTES = 5;
const MAINTENANCE_MS = 10 * 60_000;
/**
 * Jobs are enqueued in this same process, so a tick is normally triggered by onEnqueue; polling only
 * catches delayed retries and work left behind by a crashed instance. When there is nothing waiting we
 * therefore idle for minutes instead of seconds — that lets the Neon compute suspend (it costs
 * compute hours while anything queries it) and keeps the free tiers viable.
 */
const IDLE_POLL_MS = 5 * 60_000;
const BUSY_POLL_MS = 3_000;

export class Worker {
  private running = 0;
  private ticking = false;
  private stopped = false;
  private timers: NodeJS.Timeout[] = [];
  private nextTick: NodeJS.Timeout | undefined;

  constructor(
    private readonly s: Services,
    private readonly concurrency: number,
  ) {}

  start(): void {
    this.s.queue.onEnqueue(() => void this.tick());
    this.timers.push(setInterval(() => void this.maintenance(), MAINTENANCE_MS));
    void this.maintenance();
    void this.tick();
  }

  /** Stop claiming new jobs and wait (bounded) for running ones. */
  async stop(timeoutMs = 20_000): Promise<void> {
    this.stopped = true;
    this.timers.forEach(clearInterval);
    if (this.nextTick) clearTimeout(this.nextTick);
    const deadline = Date.now() + timeoutMs;
    while (this.running > 0 && Date.now() < deadline) await new Promise((r) => setTimeout(r, 200));
  }

  private async tick(): Promise<void> {
    if (this.ticking || this.stopped) return;
    this.ticking = true;
    let claimedSomething = false;
    try {
      while (!this.stopped && this.running < this.concurrency) {
        const job = await this.s.queue.claim();
        if (!job) break;
        if (this.stopped) {
          await this.s.queue.release(job); // shutting down: let the next instance take it
          break;
        }
        claimedSomething = true;
        this.running++;
        void this.run(job).finally(() => {
          this.running--;
          void this.tick();
        });
      }
      await this.scheduleNextTick(claimedSomething);
    } catch (err) {
      log.error('worker', 'claim failed', { error: errMessage(err) });
      this.sleepUntil(BUSY_POLL_MS);
    } finally {
      this.ticking = false;
    }
  }

  /** Sleep until the next queued job is due (or a long idle nap when the queue is empty). */
  private async scheduleNextTick(busy: boolean): Promise<void> {
    if (this.stopped) return;
    if (busy || this.running > 0) return void this.sleepUntil(BUSY_POLL_MS);
    const next = await this.s.queue.nextRunAt().catch(() => null);
    const waitForDue = next ? next.getTime() - Date.now() : Number.POSITIVE_INFINITY;
    this.sleepUntil(Math.min(IDLE_POLL_MS, Math.max(1_000, waitForDue)));
  }

  private sleepUntil(ms: number): void {
    if (this.nextTick) clearTimeout(this.nextTick);
    this.nextTick = setTimeout(() => void this.tick(), ms);
    this.nextTick.unref?.();
  }

  private async run(job: Job): Promise<void> {
    const started = Date.now();
    const heartbeat = setInterval(() => void this.s.queue.heartbeat(job).catch(() => {}), HEARTBEAT_MS);
    try {
      await (handlers[job.kind] as Handler<JobKind>)(this.s, job.payload);
      await this.s.queue.complete(job);
      log.info('worker', `${job.kind}#${job.id} done`, { ms: Date.now() - started });
    } catch (err) {
      const error = errMessage(err);
      const final = await this.s.queue.fail(job, error, isRetryable(err)).catch(() => false);
      log.error('worker', `${job.kind}#${job.id} failed${final ? ' for good' : ''}`, { attempt: job.attempts, error });
      if (final) await onGiveUp(this.s, job, error).catch((e) => log.error('worker', 'onGiveUp failed', { error: errMessage(e) }));
    } finally {
      clearInterval(heartbeat);
    }
  }

  private async maintenance(): Promise<void> {
    try {
      for (const dead of await this.s.queue.requeueStale(STALE_MINUTES)) {
        log.warn('worker', `job ${dead.kind}#${dead.id} gave up after a lost lease`);
        await onGiveUp(this.s, dead, 'lease expired').catch((e) => log.error('worker', 'onGiveUp failed', { error: errMessage(e) }));
      }
      await this.recoverOrphans();
      await this.s.queue.pruneFinished(14);
      await this.s.repo.pruneProcessedUpdates(7);
      // Maps terms: place labels shown to the organizer are kept only briefly (place ids may stay).
      await this.s.repo.purgeVenueOptions(30);
    } catch (err) {
      log.warn('worker', 'maintenance failed', { error: errMessage(err) });
    }
  }

  /** Safety net for a crash between a status change and its job: re-enqueue the step (all steps are idempotent). */
  private async recoverOrphans(): Promise<void> {
    for (const ev of await this.s.repo.orphanedEvents(STALE_MINUTES)) {
      log.warn('worker', `recovering orphaned event #${ev.id} (${ev.status})`);
      if (ev.status === 'drafting') await this.s.queue.enqueue('generate', { eventId: ev.id });
      else if (ev.status === 'sending') await this.s.queue.enqueue('send', { eventId: ev.id });
      else if (!ev.plan) await this.s.queue.enqueue('plan_event', { eventId: ev.id });
      else if (ev.plan.venue_kind === 'public' && ev.plan.venue_name)
        await this.s.queue.enqueue('research_venue', { eventId: ev.id, venueName: ev.plan.venue_name });
      else await this.s.queue.enqueue('suggest_more', { eventId: ev.id });
    }
  }
}
