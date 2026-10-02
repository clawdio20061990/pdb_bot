import { describe, expect, it } from 'vitest';
import { type Action, decode, encode } from '../src/bot/callbacks.js';

const samples: Action[] = [
  { t: 'pick_venue', eventId: 12, index: 2 },
  { t: 'more_venues', eventId: 12 },
  { t: 'own_venue', eventId: 12 },
  { t: 'use_as_is', eventId: 12 },
  { t: 'cancel_event', eventId: 12 },
  { t: 'send_now', eventId: 12 },
  { t: 'review', eventId: 12 },
  { t: 'send_all', eventId: 12 },
  { t: 'edit_draft', invitationId: 99 },
  { t: 'ai_draft', invitationId: 99 },
  { t: 'regen_draft', invitationId: 99 },
  { t: 'exclude_draft', invitationId: 99 },
  { t: 'include_draft', invitationId: 99 },
  { t: 'rsvp', invitationId: 99, answer: 'yes' },
  { t: 'rsvp', invitationId: 99, answer: 'maybe' },
  { t: 'rsvp', invitationId: 99, answer: 'no' },
  { t: 'open_draft', invitationId: 99 },
  { t: 'back_to_list', eventId: 12 },
];

describe('callback data codec', () => {
  it.each(samples)('round-trips %o', (action) => {
    expect(decode(encode(action))).toEqual(action);
  });

  it('stays within the 64-byte Telegram limit for large ids', () => {
    for (const a of samples) {
      const big = JSON.parse(JSON.stringify(a).replace(/:(12|99)\b/g, ':999999999999999')) as Action;
      expect(Buffer.byteLength(encode(big))).toBeLessThanOrEqual(64);
    }
  });

  it.each(['', 'x', 'v:1', 'v:a:1', 'r:1:q', 'sn:1:2', 'de:', 'zz:1', 'resp:inv_1:yes', 'sn:-1', 'v:1:2:3'])(
    'rejects malformed %j',
    (data) => {
      expect(decode(data)).toBeNull();
    },
  );
});
