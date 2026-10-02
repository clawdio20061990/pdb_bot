import { InlineKeyboard } from 'grammy';
import type { InteractionResult } from '../ai/gemini.js';
import { clip, esc, link } from '../html.js';
import { t, uiLang } from '../i18n.js';
import { languageName } from '../time.js';
import type { EventRow, Invitation, Rsvp, User, VenueOption } from '../types.js';
import { displayName } from '../types.js';
import { encode } from './callbacks.js';

// ---------------------------------------------------------------------------
// Google Maps blocks: the answer as written, sources immediately after, in one message.
// ---------------------------------------------------------------------------

/** Render the model's plain text for Telegram HTML. Only formatting markup is converted; wording is untouched. */
export function renderGroundedText(text: string): string {
  return esc(text.trim())
    .replace(/\*\*(.+?)\*\*/g, '<b>$1</b>')
    .replace(/^\s*[*-]\s+/gm, '• ')
    .replace(/^#{1,6}\s*/gm, '');
}

export function groundedBlock(_lang: string, header: string, res: InteractionResult): string {
  return `${header}\n\n${renderGroundedText(clip(res.text, Math.max(800, 3300 - header.length)))}`;
}

/** Button labels are truncated by code points: a split surrogate pair breaks the whole message. */
function short(label: string, max = 32): string {
  return clip(label, max);
}

// ---------------------------------------------------------------------------
// Organizer: choosing the place
// ---------------------------------------------------------------------------

/** `buttons` carry absolute indexes into event.venue_options (options accumulate over "More options"). */
export function suggestionsView(
  lang: string,
  event: EventRow,
  res: InteractionResult,
  buttons: { index: number; option: VenueOption }[],
) {
  const header = t(lang, 'options_header', { activity: esc(event.plan?.activity_local ?? '') });
  const text = buttons.length ? groundedBlock(lang, header, res) : t(lang, 'no_options');
  const kb = new InlineKeyboard();
  // Labels are place names, not numbers: citation order can differ from the numbering in the text.
  for (const { index, option } of buttons) {
    kb.text(`📍 ${short(option.name, 40)}`, encode({ t: 'pick_venue', eventId: event.id, index })).row();
  }
  kb.text(t(lang, 'btn_more'), encode({ t: 'more_venues', eventId: event.id }))
    .text(t(lang, 'btn_own_place'), encode({ t: 'own_venue', eventId: event.id }))
    .row()
    .text(t(lang, 'btn_cancel'), encode({ t: 'cancel_event', eventId: event.id }));
  return { text, keyboard: kb };
}

/** The organizer's name matched several places: show them and ask which one. */
export function whichPlaceView(
  lang: string,
  event: EventRow,
  res: InteractionResult,
  buttons: { index: number; option: VenueOption }[],
  typedName: string,
) {
  const text = groundedBlock(lang, t(lang, 'which_place', { name: esc(typedName) }), res);
  const kb = new InlineKeyboard();
  for (const { index, option } of buttons) {
    kb.text(`📍 ${short(option.name, 40)}`, encode({ t: 'pick_venue', eventId: event.id, index })).row();
  }
  kb.text(t(lang, 'btn_own_place'), encode({ t: 'own_venue', eventId: event.id }))
    .text(t(lang, 'btn_cancel'), encode({ t: 'cancel_event', eventId: event.id }));
  return { text, keyboard: kb };
}

/** Back to choosing a place after a failed search: previous options + More / Other place / Cancel. */
export function choiceView(lang: string, event: EventRow, text: string) {
  const kb = new InlineKeyboard();
  (event.venue_options ?? []).forEach((option, index) => {
    kb.text(`📍 ${short(option.name, 40)}`, encode({ t: 'pick_venue', eventId: event.id, index })).row();
  });
  kb.text(t(lang, 'btn_more'), encode({ t: 'more_venues', eventId: event.id }))
    .text(t(lang, 'btn_own_place'), encode({ t: 'own_venue', eventId: event.id }))
    .row()
    .text(t(lang, 'btn_cancel'), encode({ t: 'cancel_event', eventId: event.id }));
  return { text, keyboard: kb };
}

export function venueNotFoundView(lang: string, event: EventRow, name: string, outsideCity = false) {
  const kb = new InlineKeyboard()
    .text(t(lang, 'btn_suggest'), encode({ t: 'more_venues', eventId: event.id }))
    .row()
    .text(t(lang, 'btn_use_anyway', { name: short(name, 24) }), encode({ t: 'use_as_is', eventId: event.id }))
    .row()
    .text(t(lang, 'btn_own_place'), encode({ t: 'own_venue', eventId: event.id }))
    .text(t(lang, 'btn_cancel'), encode({ t: 'cancel_event', eventId: event.id }));
  return { text: t(lang, outsideCity ? 'venue_outside' : 'venue_not_found', { name: esc(name) }), keyboard: kb };
}

// ---------------------------------------------------------------------------
// Organizer: event card
// ---------------------------------------------------------------------------

export function cardView(lang: string, event: EventRow, recipients: User[], footer?: string) {
  const plan = event.plan;
  const where = event.venue ? link(event.venue.name, event.venue.maps_url) : esc(t(lang, 'card_where_none'));
  const lines = [
    t(lang, 'card_title'),
    `${t(lang, 'card_what')}: ${esc(plan?.activity_local ?? event.original_text)}`,
    `${t(lang, 'card_where')}: ${where}`,
    `${t(lang, 'card_when')}: ${plan?.when_local ? esc(plan.when_local) : t(lang, 'when_not_set')}`,
    `${t(lang, 'card_who')}: ${recipients.map((r) => esc(displayName(r))).join(', ')}`,
  ];
  const text = `${lines.join('\n')}\n\n${footer ?? t(lang, 'card_question')}`;
  if (footer !== undefined) return { text, keyboard: undefined };
  const kb = new InlineKeyboard()
    .text(t(lang, 'btn_send_now'), encode({ t: 'send_now', eventId: event.id }))
    .text(t(lang, 'btn_review'), encode({ t: 'review', eventId: event.id }))
    .row()
    .text(t(lang, 'btn_cancel'), encode({ t: 'cancel_event', eventId: event.id }));
  return { text, keyboard: kb };
}

// ---------------------------------------------------------------------------
// Organizer: reviewing the invitations (ONE message: a list of people, or one open draft)
// ---------------------------------------------------------------------------

/** Drafts that can go out as they are: in 'draft' state and translated. */
export function sendableDrafts(invitations: Invitation[]): Invitation[] {
  return invitations.filter((i) => i.status === 'draft' && Boolean(i.final_text));
}

function draftIcon(inv: Invitation, updating: boolean): string {
  if (updating) return '⏳';
  if (inv.status === 'excluded') return '🚫';
  if (inv.status === 'sent') return '📨';
  if (inv.status === 'failed') return '⚠️';
  return inv.final_text ? '✅' : '⚠️';
}

export interface ReviewState {
  event: EventRow;
  invitations: Invitation[];
  people: Map<number, User>;
  /** Invitation ids whose text is currently being rewritten/translated. */
  updating?: Set<number>;
}

/** The whole review UI. Which view is shown depends on event.open_invitation_id. */
export function reviewView(lang: string, state: ReviewState) {
  const { event, invitations, people } = state;
  const updating = state.updating ?? new Set<number>();
  const open = invitations.find((i) => i.id === event.open_invitation_id);
  return open ? draftView(lang, state, open, updating.has(open.id)) : listView(lang, state, updating);
}

function listView(lang: string, { event, invitations, people }: ReviewState, updating: Set<number>) {
  const count = sendableDrafts(invitations).length;
  const kb = new InlineKeyboard();
  for (const inv of invitations) {
    const name = people.get(inv.recipient_chat_id);
    kb.text(
      `${draftIcon(inv, updating.has(inv.id))} ${short(name ? displayName(name) : String(inv.recipient_chat_id), 28)}`,
      encode({ t: 'open_draft', invitationId: inv.id }),
    ).row();
  }
  if (count > 0) kb.text(t(lang, 'btn_send_all', { count }), encode({ t: 'send_all', eventId: event.id })).row();
  kb.text(t(lang, 'btn_cancel'), encode({ t: 'cancel_event', eventId: event.id }));
  const text = count
    ? `${t(lang, 'review_title', { total: invitations.length, count })}\n\n${t(lang, 'review_pick')}`
    : `${t(lang, 'review_title', { total: invitations.length, count })}\n\n${t(lang, 'nothing_to_send')}`;
  return { text, keyboard: kb };
}

function draftView(lang: string, { event, people }: ReviewState, inv: Invitation, updating: boolean) {
  const recipient = people.get(inv.recipient_chat_id);
  const title = t(lang, 'draft_title', {
    name: esc(recipient ? displayName(recipient) : String(inv.recipient_chat_id)),
    language: esc(languageName(inv.language, uiLang(lang))),
  });
  const body = esc(clip(inv.final_text ?? inv.base_text ?? '', 1500));
  const showOriginal = inv.base_text && inv.final_text && inv.base_text.trim() !== inv.final_text.trim();
  const original = showOriginal
    ? `\n\n<i>${t(lang, 'draft_original')}</i>\n<blockquote expandable>${esc(clip(inv.base_text!, 1500))}</blockquote>`
    : '';
  const status = updating
    ? `\n\n${t(lang, 'draft_updating')}`
    : inv.status === 'excluded'
      ? `\n\n${t(lang, 'draft_excluded')}`
      : !inv.final_text
        ? `\n\n${t(lang, 'draft_untranslated')}`
        : '';
  const kb = new InlineKeyboard();
  if (!updating && (inv.status === 'draft' || inv.status === 'excluded')) {
    if (inv.status === 'excluded') {
      kb.text(t(lang, 'btn_include'), encode({ t: 'include_draft', invitationId: inv.id })).row();
    } else {
      kb.text(t(lang, 'btn_edit'), encode({ t: 'edit_draft', invitationId: inv.id }))
        .text(t(lang, 'btn_ai'), encode({ t: 'ai_draft', invitationId: inv.id }))
        .row()
        .text(t(lang, 'btn_regen'), encode({ t: 'regen_draft', invitationId: inv.id }))
        .text(t(lang, 'btn_exclude'), encode({ t: 'exclude_draft', invitationId: inv.id }))
        .row();
    }
  }
  kb.text(t(lang, 'btn_back'), encode({ t: 'back_to_list', eventId: event.id }));
  return { text: `${title}\n\n${body}${original}${status}`, keyboard: kb };
}

export function sentReportView(lang: string, sent: number, failed: { name: string; blocked: boolean }[], notSent: string[] = []) {
  const lines = [t(lang, 'sent_report', { sent, failed: failed.length })];
  for (const f of failed) {
    lines.push(t(lang, 'failed_line', { name: esc(f.name), reason: t(lang, f.blocked ? 'reason_blocked' : 'reason_other') }));
  }
  for (const name of notSent) lines.push(t(lang, 'not_sent_line', { name: esc(name) }));
  return lines.join('\n');
}

// ---------------------------------------------------------------------------
// Recipient: the invitation
// ---------------------------------------------------------------------------

export function invitationKeyboard(lang: string, inv: Invitation, selected: Rsvp | null) {
  const mark = (answer: Rsvp, label: string) => (selected === answer ? `» ${label} «` : label);
  return new InlineKeyboard()
    .text(mark('yes', t(lang, 'btn_yes')), encode({ t: 'rsvp', invitationId: inv.id, answer: 'yes' }))
    .text(mark('maybe', t(lang, 'btn_maybe')), encode({ t: 'rsvp', invitationId: inv.id, answer: 'maybe' }))
    .text(mark('no', t(lang, 'btn_no')), encode({ t: 'rsvp', invitationId: inv.id, answer: 'no' }));
}

export function invitationView(inv: Invitation, event: EventRow) {
  const lang = inv.language;
  const venue = event.venue ? `\n\n📍 ${link(event.venue.name, event.venue.maps_url)}` : '';
  const hint = `\n\n<i>${t(lang, 'reply_hint')}</i>`;
  return {
    text: `${esc(clip(inv.final_text ?? '', 2500))}${venue}${hint}`,
    keyboard: invitationKeyboard(lang, inv, inv.rsvp),
  };
}

// ---------------------------------------------------------------------------
// Organizer notifications
// ---------------------------------------------------------------------------

export function rsvpNotifyView(
  lang: string,
  recipient: User,
  event: EventRow,
  answer: Rsvp,
  changed: boolean,
  tally: { yes: number; maybe: number; no: number; none: number },
) {
  const key = answer === 'yes' ? 'rsvp_yes' : answer === 'maybe' ? 'rsvp_maybe' : 'rsvp_no';
  const head = `${t(lang, key, { name: esc(displayName(recipient)) })}${changed ? ` ${t(lang, 'rsvp_changed')}` : ''}`;
  const re = t(lang, 'rsvp_re', { activity: esc(event.plan?.activity_local ?? event.original_text) });
  return `${head}\n<i>${re}</i>\n${t(lang, 'tally', tally)}`;
}

export function proposalNotifyView(lang: string, recipient: User, event: EventRow, translated: string, original: string | null) {
  const head = t(lang, 'proposal_notify', {
    name: esc(displayName(recipient)),
    activity: esc(event.plan?.activity_local ?? event.original_text),
  });
  const orig = original ? `\n\n<i>${t(lang, 'proposal_original')}</i> ${esc(clip(original, 1000))}` : '';
  return `${head}\n${esc(clip(translated, 1500))}${orig}`;
}

export function statusView(lang: string, events: { event: EventRow; tally: { yes: number; maybe: number; no: number; none: number } }[]) {
  if (!events.length) return t(lang, 'status_empty');
  const lines = events.map(({ event, tally }) => {
    const state = t(lang, `state_${event.status}`);
    const base = `#${event.id} · ${esc(event.plan?.activity_local ?? event.original_text)} · ${state}`;
    return event.status === 'sent' ? `${base}\n   ${t(lang, 'tally', tally)}` : base;
  });
  return `${t(lang, 'status_title')}\n${lines.join('\n')}`;
}
