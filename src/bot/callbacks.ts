import type { Rsvp } from '../types.js';

/** Inline-button payloads. Telegram limits callback_data to 64 bytes, so keep codes short. */
export type Action =
  | { t: 'pick_venue'; eventId: number; index: number }
  | { t: 'more_venues'; eventId: number }
  | { t: 'own_venue'; eventId: number }
  | { t: 'use_as_is'; eventId: number }
  | { t: 'cancel_event'; eventId: number }
  | { t: 'send_now'; eventId: number }
  | { t: 'review'; eventId: number }
  | { t: 'send_all'; eventId: number }
  | { t: 'edit_draft'; invitationId: number }
  | { t: 'ai_draft'; invitationId: number }
  | { t: 'regen_draft'; invitationId: number }
  | { t: 'exclude_draft'; invitationId: number }
  | { t: 'include_draft'; invitationId: number }
  | { t: 'rsvp'; invitationId: number; answer: Rsvp }
  | { t: 'open_draft'; invitationId: number }
  | { t: 'back_to_list'; eventId: number };

const RSVP_CODES: Record<Rsvp, string> = { yes: 'y', maybe: 'm', no: 'n' };
const RSVP_BY_CODE: Record<string, Rsvp> = { y: 'yes', m: 'maybe', n: 'no' };

const EVENT_CODES = {
  more_venues: 'vm',
  own_venue: 'vo',
  use_as_is: 'vu',
  cancel_event: 'ec',
  send_now: 'sn',
  review: 'sr',
  send_all: 'sa',
  back_to_list: 'bl',
} as const;
const INVITATION_CODES = {
  edit_draft: 'de',
  ai_draft: 'da',
  regen_draft: 'dr',
  exclude_draft: 'dx',
  include_draft: 'di',
  open_draft: 'od',
} as const;

export function encode(a: Action): string {
  switch (a.t) {
    case 'pick_venue':
      return `v:${a.eventId}:${a.index}`;
    case 'rsvp':
      return `r:${a.invitationId}:${RSVP_CODES[a.answer]}`;
    case 'more_venues':
    case 'own_venue':
    case 'use_as_is':
    case 'cancel_event':
    case 'send_now':
    case 'review':
    case 'send_all':
    case 'back_to_list':
      return `${EVENT_CODES[a.t]}:${a.eventId}`;
    default:
      return `${INVITATION_CODES[a.t]}:${a.invitationId}`;
  }
}

const EVENT_BY_CODE = Object.fromEntries(Object.entries(EVENT_CODES).map(([k, v]) => [v, k])) as Record<
  string,
  keyof typeof EVENT_CODES
>;
const INVITATION_BY_CODE = Object.fromEntries(Object.entries(INVITATION_CODES).map(([k, v]) => [v, k])) as Record<
  string,
  keyof typeof INVITATION_CODES
>;

function id(s: string | undefined): number | null {
  if (!s || !/^\d{1,15}$/.test(s)) return null;
  return Number(s);
}

export function decode(data: string | undefined): Action | null {
  if (!data) return null;
  const [code, a, b, ...rest] = data.split(':');
  if (rest.length || !code) return null;
  const n = id(a);
  if (n === null) return null;

  if (code === 'v') {
    const index = id(b);
    return index === null ? null : { t: 'pick_venue', eventId: n, index };
  }
  if (code === 'r') {
    const answer = b ? RSVP_BY_CODE[b] : undefined;
    return answer ? { t: 'rsvp', invitationId: n, answer } : null;
  }
  if (b !== undefined) return null;
  const ev = EVENT_BY_CODE[code];
  if (ev) return { t: ev, eventId: n };
  const inv = INVITATION_BY_CODE[code];
  if (inv) return { t: inv, invitationId: n };
  return null;
}
