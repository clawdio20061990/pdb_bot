import { GrammyError } from 'grammy';
import { describe, expect, it } from 'vitest';
import { Tg } from '../src/bot/telegram.js';

describe('Tg.send', () => {
  it('re-sends as plain text when Telegram rejects the HTML', async () => {
    const sent: { text: string; parse_mode?: string }[] = [];
    const api = {
      async sendMessage(_chat: number, text: string, extra: { parse_mode?: string }) {
        sent.push({ text, parse_mode: extra.parse_mode });
        if (extra.parse_mode === 'HTML') {
          throw new GrammyError(
            'x',
            { ok: false, error_code: 400, description: "Bad Request: can't parse entities: unclosed tag" },
            'sendMessage',
            {},
          );
        }
        return { message_id: 7 };
      },
    };
    const id = await new Tg(api as never).send(1, '<b>Tom &amp; Jerry</b> <i>oops');
    expect(id).toBe(7);
    expect(sent[1]).toEqual({ text: 'Tom & Jerry oops\n\nText generated with AI', parse_mode: undefined });
  });
});
