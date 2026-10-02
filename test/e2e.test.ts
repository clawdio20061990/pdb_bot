/**
 * End-to-end: real handlers + real job worker + real SQL (PGlite over the Postgres wire protocol),
 * fake Telegram API (records calls) and fake Gemini (canned answers). No network.
 */
import { PGlite } from '@electric-sql/pglite';
import { PGLiteSocketServer } from '@electric-sql/pglite-socket';
import { Bot } from 'grammy';
import type { Update, UserFromGetMe } from 'grammy/types';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { type Gemini, GeminiError, type InteractionResult, type InteractOptions, type PlaceCitation } from '../src/ai/gemini.js';
import { type BotContext, registerHandlers } from '../src/bot/handlers.js';
import { Tg } from '../src/bot/telegram.js';
import type { Config } from '../src/config.js';
import { createPool, type Db, migrate } from '../src/db.js';
import { Queue } from '../src/jobs/queue.js';
import { Worker } from '../src/jobs/worker.js';
import { Repo } from '../src/repo.js';
import type { Services } from '../src/services.js';

const ORG = 1001; // Polish organizer
const GUEST = 1002; // English guest
const BLOCKED = 1003; // Ukrainian guest who blocked the bot
const STRANGER = 9999;
const SECRET = 'SECRET_MAPS_FACT'; // marker inside every Maps-grounded answer
const FACT_B = 'SLIDES_FACT'; // only in the block about "Pool B"

// ---------------------------------------------------------------- fake Gemini

const P1: PlaceCitation = { place_id: 'P1', name: 'Brovarnia Gdańsk - Google Maps', url: 'https://maps.google.com/?cid=1' };
const P2: PlaceCitation = { place_id: 'P2', name: 'Pool A - Google Maps', url: 'https://maps.google.com/?cid=2' };
const P2R: PlaceCitation = { place_id: 'P2', name: 'Review of Pool A - Google Maps', url: 'https://maps.google.com/reviews/2' };
const P3: PlaceCitation = { place_id: 'P3', name: 'Pool B (basen / pool) - Google Maps', url: 'https://maps.google.com/?cid=3' };
const P4: PlaceCitation = { place_id: 'P4', name: 'Broken Bar - Google Maps', url: 'https://maps.google.com/?cid=4' };

const result = (text: string, citations: PlaceCitation[] = []): InteractionResult => ({
  text,
  citations,
  mapsPlaces: citations,
  mapsQueries: citations.length ? 1 : 0,
  usage: { input: 0, output: 0, thought: 0 },
});

class FakeGemini {
  readonly model = 'fake';
  calls: { label: string; input: string; grounded: boolean }[] = [];

  async interact(opts: InteractOptions): Promise<InteractionResult> {
    this.calls.push({ label: opts.label, input: opts.input, grounded: Boolean(opts.tools?.length) });
    const quoted = opts.input.match(/<<<\n([\s\S]*?)\n>>>/)?.[1] ?? '';
    if (opts.label.startsWith('translate_')) {
      if (quoted.includes('UNTRANSLATABLE')) throw new GeminiError('translation refused', 400, 'invalid_request', false);
      return result(`[${opts.label.slice(10)}] ${quoted}`);
    }
    switch (opts.label) {
      case 'lookup_venue':
        if (opts.input.includes('Nowhere')) return result('NOT_FOUND');
        if (opts.input.includes('Broken Bar')) return result(`TG_FAIL ${SECRET}`, [P4]);
        return result(`Brovarnia (Szafarnia 9)\nWhat's there: beer, burgers. ${SECRET}`, [P1]);
      case 'suggest_venues':
        return result(
          `1. Pool A (Stogi 1)\nWhat's there: quiet lanes. ${SECRET}\n\n2. Pool B (Stogi 2)\nWhat's there: big slides. ${FACT_B}`,
          [P2, P2R, P3],
        );
      case 'write_invitation': {
        const who = opts.input.match(/RECIPIENT: (.+)/)?.[1];
        const used = opts.input.match(/What's there: ([^.]+)\./)?.[1] ?? 'nothing';
        return result(`Invitation for ${who} — come for ${used}`);
      }
      case 'rewrite_invitation':
        return result('Rewritten invitation');
      default:
        throw new Error(`unexpected label ${opts.label}`);
    }
  }

  async json(opts: InteractOptions): Promise<unknown> {
    this.calls.push({ label: opts.label, input: opts.input, grounded: false });
    const base = { activity_local: 'piwo', when_text: null, when_local: null };
    if (opts.input.includes('Brovarni'))
      return { ...base, is_event_idea: true, activity: 'beers', venue_kind: 'public', venue_name: 'Brovarnia', venue_type: 'brewpub', when_text: 'Saturday 19:00', when_local: 'sobota 19:00' };
    if (opts.input.includes('Nowhere'))
      return { ...base, is_event_idea: true, activity: 'beers', venue_kind: 'public', venue_name: 'Nowhere Bar', venue_type: 'bar' };
    if (opts.input.includes('Broken'))
      return { ...base, is_event_idea: true, activity: 'beers', venue_kind: 'public', venue_name: 'Broken Bar', venue_type: 'bar' };
    if (opts.input.includes('swim'))
      return { ...base, is_event_idea: true, activity: 'swimming', activity_local: 'swimming', venue_kind: 'none', venue_name: null, venue_type: 'swimming pool' };
    return { ...base, is_event_idea: false, activity: '', venue_kind: 'none', venue_name: null, venue_type: '' };
  }
}

// ---------------------------------------------------------------- harness

let pg: PGlite;
let socket: PGLiteSocketServer;
let pool: Db;
let bot: Bot<BotContext>;
let worker: Worker;
const gemini = new FakeGemini();
const calls: { method: string; payload: Record<string, unknown> }[] = [];
let nextMessageId = 100;
let nextUpdateId = 1;

beforeAll(async () => {
  pg = await PGlite.create();
  socket = new PGLiteSocketServer({ db: pg, port: 0, host: '127.0.0.1', maxConnections: 10 });
  await socket.start();
  const port = (socket as unknown as { server: { address(): { port: number } } }).server.address().port;
  const url = `postgresql://postgres:postgres@127.0.0.1:${port}/postgres`;
  await migrate(url);
  pool = createPool(url);
  const repo = new Repo(pool);
  await repo.syncUsers([
    { chat_id: ORG, username: 'org', language: 'pl', likes: 'beer', dislikes: 'noise' },
    { chat_id: GUEST, username: 'guest', language: 'en', likes: 'sailing', dislikes: 'alcohol' },
    { chat_id: BLOCKED, username: 'blocked', language: 'uk', likes: 'food', dislikes: 'vegan food' },
  ]);

  bot = new Bot<BotContext>('123:TEST', {
    botInfo: { id: 1, is_bot: true, first_name: 'pdb', username: 'pdb_test_bot' } as UserFromGetMe,
  });
  bot.api.config.use(async (_prev, method, payload) => {
    const p = payload as Record<string, unknown>;
    calls.push({ method, payload: p });
    if (method === 'sendMessage' && String(p.text).includes('TG_FAIL')) {
      return { ok: false, error_code: 400, description: 'Bad Request: some permanent problem' } as never;
    }
    if (method === 'sendMessage' && p.chat_id === BLOCKED) {
      return { ok: false, error_code: 403, description: 'Forbidden: bot was blocked by the user' } as never;
    }
    if (method === 'sendMessage') {
      return { ok: true, result: { message_id: nextMessageId++, date: 0, chat: { id: p.chat_id, type: 'private' }, text: p.text } } as never;
    }
    return { ok: true, result: true } as never;
  });

  const services: Services = {
    cfg: { CITY_NAME: 'Gdańsk', TIMEZONE: 'Europe/Warsaw' } as Config,
    repo,
    queue: new Queue(pool),
    tg: new Tg(bot.api, async (chatId) => (await repo.getUser(chatId))?.language ?? 'en'),
    ai: { gemini: gemini as unknown as Gemini, city: 'Gdańsk', latitude: 54.352, longitude: 18.6466 },
  };
  registerHandlers(bot, services);
  worker = new Worker(services, 2);
  worker.start();
}, 60_000);

afterAll(async () => {
  await worker?.stop(2000);
  await pool?.end();
  await socket?.stop();
  await pg?.close();
});

const user = (id: number) => ({ id, is_bot: false, first_name: `U${id}`, language_code: 'en' });

async function say(from: number, text: string, updateId = nextUpdateId++): Promise<void> {
  const command = text.startsWith('/') ? [{ type: 'bot_command', offset: 0, length: text.split(' ')[0]!.length }] : undefined;
  await bot.handleUpdate({
    update_id: updateId,
    message: { message_id: updateId, date: 0, chat: { id: from, type: 'private', first_name: `U${from}` }, from: user(from), text, entities: command },
  } as unknown as Update);
}

async function sticker(from: number): Promise<void> {
  await bot.handleUpdate({
    update_id: nextUpdateId++,
    message: { message_id: 1, date: 0, chat: { id: from, type: 'private', first_name: 'x' }, from: user(from), sticker: { file_id: 'f' } },
  } as unknown as Update);
}

async function replyTo(from: number, messageId: number, text: string): Promise<void> {
  await bot.handleUpdate({
    update_id: nextUpdateId++,
    message: {
      message_id: nextUpdateId,
      date: 0,
      chat: { id: from, type: 'private', first_name: 'x' },
      from: user(from),
      text,
      reply_to_message: { message_id: messageId, date: 0, chat: { id: from, type: 'private', first_name: 'x' }, text: 'inv' },
    },
  } as unknown as Update);
}

const editsSince = (from: number, chatId: number) =>
  calls.slice(from).filter((c) => c.method === 'editMessageText' && c.payload.chat_id === chatId).map((c) => String(c.payload.text));
const lastKeyboard = (from: number, chatId: number) =>
  calls
    .slice(from)
    .filter((c) => (c.method === 'sendMessage' || c.method === 'editMessageText') && c.payload.chat_id === chatId)
    .at(-1);
const toastsSince = (from: number) =>
  calls.slice(from).filter((c) => c.method === 'answerCallbackQuery').map((c) => String(c.payload.text ?? ''));

async function tap(from: number, data: string, messageId = 1): Promise<void> {
  await bot.handleUpdate({
    update_id: nextUpdateId++,
    callback_query: {
      id: String(nextUpdateId),
      from: user(from),
      chat_instance: 'x',
      data,
      message: { message_id: messageId, date: 0, chat: { id: from, type: 'private', first_name: `U${from}` }, text: '' },
    },
  } as unknown as Update);
}

/** Wait until the job queue is empty. */
async function drain(timeoutMs = 15_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const { rows } = await pool.query<{ n: number }>(`SELECT count(*)::int AS n FROM jobs WHERE status IN ('queued','running')`);
    // a job is marked done/failed before its follow-up messages are sent, so let those settle
    if (rows[0]!.n === 0) return void (await new Promise((r) => setTimeout(r, 120)));
    if (Date.now() > deadline) throw new Error('jobs did not drain');
    await new Promise((r) => setTimeout(r, 50));
  }
}

const mark = () => calls.length;
const sentSince = (from: number, chatId?: number) =>
  calls.slice(from).filter((c) => c.method === 'sendMessage' && (chatId === undefined || c.payload.chat_id === chatId));
const textsSince = (from: number, chatId: number) => sentSince(from, chatId).map((c) => String(c.payload.text));
const buttons = (call: { payload: Record<string, unknown> } | undefined) =>
  ((call?.payload.reply_markup as { inline_keyboard?: { text: string; callback_data?: string }[][] })?.inline_keyboard ?? []).flat();
const lastEvent = async () => (await pool.query('SELECT * FROM events ORDER BY id DESC LIMIT 1')).rows[0];
const invitationsOf = async (eventId: number) =>
  (await pool.query('SELECT * FROM invitations WHERE event_id = $1 ORDER BY recipient_chat_id', [eventId])).rows;

// ---------------------------------------------------------------- scenarios

describe('pdb_bot end to end', () => {
  it('rejects strangers and shows their chat id', async () => {
    const m = mark();
    await say(STRANGER, 'hello');
    expect(textsSince(m, STRANGER)[0]).toContain('<code>9999</code>');
  });

  it('ignores a redelivered update', async () => {
    const m = mark();
    await say(ORG, '/whoami', 5000);
    await say(ORG, '/whoami', 5000);
    expect(sentSince(m, ORG)).toHaveLength(1);
  });

  it('answers non-ideas without creating invitations', async () => {
    const m = mark();
    await say(ORG, 'hi');
    await drain();
    const texts = textsSince(m, ORG);
    expect(texts.at(-1)).toContain('To nie wygląda na plan spotkania');
    expect((await lastEvent()).status).toBe('cancelled');
  });

  it('named venue -> facts stored -> review menu -> edit -> send -> RSVP', async () => {
    let m = mark();
    await say(ORG, 'piwo w Brovarni w sobotę o 19');
    await drain();
    let event = await lastEvent();
    expect(event.status).toBe('confirming');
    expect(event.venue).toMatchObject({ name: 'Brovarnia Gdańsk', place_id: 'P1' }); // the name as Google Maps has it
    // the one Maps answer for this meetup is stored with its sources
    expect(event.venue_facts.text).toContain('beer, burgers');
    expect(event.venue_facts.sources[0]).toMatchObject({ place_id: 'P1' });
    const grounded = textsSince(m, ORG).find((t) => t.includes(SECRET))!;
    expect(grounded).not.toContain('Źródła'); // no source list any more
    expect(grounded).toContain('Tekst wygenerowany przez AI'); // EU AI Act disclosure on every message
    const card = sentSince(m, ORG).at(-1)!;
    expect(buttons(card).map((b) => b.callback_data)).toEqual([`sn:${event.id}`, `sr:${event.id}`, `ec:${event.id}`]);

    // review: ONE message listing everyone
    m = mark();
    await tap(ORG, `sr:${event.id}`);
    await drain();
    event = await lastEvent();
    expect(event.status).toBe('reviewing');
    let invs = await invitationsOf(event.id);
    expect(invs.map((i) => i.status)).toEqual(['draft', 'draft']);
    expect(invs[0].base_text).toContain('come for beer, burgers'); // the stored facts reached the invitation
    expect(invs[1].final_text).toBe('[uk] Invitation for blocked — come for beer, burgers');
    const list = lastKeyboard(m, ORG)!;
    expect(String(list.payload.text)).toContain('Zaproszenia</b>: 2 · gotowe do wysłania: 2');
    expect(buttons(list).map((b) => b.callback_data)).toEqual([
      `od:${invs[0].id}`,
      `od:${invs[1].id}`,
      `sa:${event.id}`,
      `ec:${event.id}`,
    ]);
    expect(buttons(list)[0]!.text).toContain('guest'); // you can see whose invitation you are about to open

    // open one person's draft -> the same message shows whose it is, with a Back button
    m = mark();
    await tap(ORG, `od:${invs[0].id}`);
    expect(editsSince(m, ORG).at(-1)).toContain('Szkic dla <b>guest</b>');
    expect(buttons(lastKeyboard(m, ORG)).map((b) => b.callback_data)).toEqual([
      `de:${invs[0].id}`,
      `da:${invs[0].id}`,
      `dr:${invs[0].id}`,
      `dx:${invs[0].id}`,
      `bl:${event.id}`,
    ]);
    expect((await lastEvent()).open_invitation_id).toBe(invs[0].id);

    // edit by hand -> translated for the recipient
    m = mark();
    await tap(ORG, `de:${invs[0].id}`);
    expect(textsSince(m, ORG).at(-1)).toContain('Wyślij nowy tekst dla guest');
    await say(ORG, 'Hej, wpadaj na piwo!');
    await drain();
    invs = await invitationsOf(event.id);
    expect(invs[0]).toMatchObject({ base_text: 'Hej, wpadaj na piwo!', final_text: '[en] Hej, wpadaj na piwo!', status: 'draft' });
    expect(editsSince(m, ORG).at(-1)).toContain('[en] Hej, wpadaj na piwo!');

    // back to the list, skip and restore the other one
    m = mark();
    await tap(ORG, `bl:${event.id}`);
    expect((await lastEvent()).open_invitation_id).toBeNull();
    await tap(ORG, `od:${invs[1].id}`);
    await tap(ORG, `dx:${invs[1].id}`);
    expect((await invitationsOf(event.id))[1].status).toBe('excluded');
    await tap(ORG, `di:${invs[1].id}`);
    expect((await invitationsOf(event.id))[1].status).toBe('draft');

    // send
    m = mark();
    await tap(ORG, `sa:${event.id}`);
    await drain();
    event = await lastEvent();
    expect(event.status).toBe('sent');
    invs = await invitationsOf(event.id);
    expect(invs.map((i) => i.status)).toEqual(['sent', 'failed']);
    const invitation = sentSince(m, GUEST)[0]!;
    const text = String(invitation.payload.text);
    expect(text).toContain('[en] Hej, wpadaj na piwo!');
    expect(text).toContain('query_place_id=P1">Brovarnia Gdańsk</a>');
    expect(text).toContain('Text generated with AI');
    expect(text).toContain('Reply to this message'); // no extra buttons, a plain hint instead
    expect(buttons(invitation).map((b) => b.text)).toEqual(['✅ I’m in', '🤔 Maybe', '❌ Can’t']);
    expect(textsSince(m, ORG).at(-1)).toContain('Wysłano: 1. Niedostarczone: 1.');

    // RSVP: organizer notified once, keyboard marks the answer
    m = mark();
    await tap(GUEST, `r:${invs[0].id}:y`);
    await tap(GUEST, `r:${invs[0].id}:y`);
    const notes = textsSince(m, ORG);
    expect(notes).toHaveLength(1);
    expect(notes[0]).toContain('</b> wchodzi');
    expect(notes[0]).toContain('Wchodzą: 1 · Może: 0 · Nie: 0 · Bez odpowiedzi: 0');
    expect(JSON.stringify(calls.slice(m).find((c) => c.method === 'editMessageReplyMarkup')?.payload)).toContain('» ✅ I’m in «');
    m = mark();
    await tap(GUEST, `r:${invs[0].id}:m`);
    expect(textsSince(m, ORG)[0]).toContain('(zmiana odpowiedzi)');

    // a stranger can't answer someone else's invitation
    m = mark();
    await tap(BLOCKED, `r:${invs[0].id}:n`);
    expect(textsSince(m, ORG)).toHaveLength(0);
  });

  it('no venue -> suggestions -> pick -> send now', async () => {
    let m = mark();
    await say(ORG, 'swim on Sunday');
    await drain();
    let event = await lastEvent();
    expect(event.status).toBe('choosing_venue');
    const suggestion = sentSince(m, ORG).at(-1)!;
    expect(String(suggestion.payload.text)).not.toContain('Źródła');
    const picks = buttons(suggestion).filter((b) => b.callback_data?.startsWith('v:'));
    expect(picks.map((b) => b.text)).toEqual(['📍 Pool A', '📍 Pool B']);

    m = mark();
    await tap(ORG, picks[1]!.callback_data!);
    event = await lastEvent();
    expect(event.status).toBe('confirming');
    expect(event.venue).toMatchObject({ name: 'Pool B', place_id: 'P3' });
    // only the chosen place's part of the answer is kept as the fact sheet
    expect(event.venue_facts.text).toContain(FACT_B);
    expect(event.venue_facts.text).not.toContain(SECRET);
    await tap(ORG, `sn:${event.id}`);
    await drain();
    expect((await lastEvent()).status).toBe('sent');
    expect(textsSince(m, GUEST).at(-1)).toContain('come for big slides'); // only the picked place's facts
  });

  it('unknown venue -> keep it anyway; /cancel before sending', async () => {
    const m = mark();
    await say(ORG, 'beer at Nowhere Bar');
    await drain();
    const event = await lastEvent();
    expect(event.status).toBe('choosing_venue');
    const msg = sentSince(m, ORG).at(-1)!;
    expect(String(msg.payload.text)).toContain('Nie znalazłem „Nowhere Bar”');
    await tap(ORG, `vu:${event.id}`);
    expect((await lastEvent()).status).toBe('confirming');
    await say(ORG, '/cancel');
    expect((await lastEvent()).status).toBe('cancelled');
    expect(textsSince(m, ORG).at(-1)).toContain('Spotkanie anulowane');
  });

  it('blocks Send while a draft is being rewritten and never sends an untranslated draft', async () => {
    await say(ORG, 'piwo w Brovarni w sobotę o 19');
    await drain();
    let event = await lastEvent();
    await tap(ORG, `sr:${event.id}`);
    await drain();
    let invs = await invitationsOf(event.id);
    expect(invs.map((i) => i.status)).toEqual(['draft', 'draft']);

    // a redraft job is still running for the guest's draft -> Send is refused
    await pool.query(`INSERT INTO jobs (kind, payload, status, locked_at) VALUES ('redraft', $1, 'running', now())`, [
      JSON.stringify({ invitationId: invs[0].id }),
    ]);
    let m = mark();
    await tap(ORG, `sa:${event.id}`);
    expect(toastsSince(m).at(-1)).toContain('Niektóre szkice jeszcze się aktualizują');
    expect((await lastEvent()).status).toBe('reviewing');
    await pool.query(`DELETE FROM jobs WHERE kind = 'redraft' AND status = 'running'`);

    // the organizer's edit for the Ukrainian guest can't be translated -> that draft is not sendable
    await tap(ORG, `od:${invs[1].id}`);
    await tap(ORG, `de:${invs[1].id}`);
    await say(ORG, 'UNTRANSLATABLE text');
    await drain();
    invs = await invitationsOf(event.id);
    expect(invs[1]).toMatchObject({ status: 'draft', final_text: null });
    expect(editsSince(m, ORG).some((t) => t.includes('Jeszcze nieprzetłumaczone'))).toBe(true); // re-rendered with a warning

    m = mark();
    await tap(ORG, `sa:${event.id}`);
    await drain();
    invs = await invitationsOf(event.id);
    expect(invs.map((i) => i.status)).toEqual(['sent', 'draft']);
    expect(sentSince(m, BLOCKED)).toHaveLength(0); // the untranslated text never went out
    expect(textsSince(m, ORG).at(-1)).toContain('Wysłano: 1. Niedostarczone: 0.');
    event = await lastEvent();
    expect(event.status).toBe('sent');

    // a Telegram reply to the invitation is a counter-proposal for the organizer
    m = mark();
    await replyTo(GUEST, invs[0].message_id, 'Can we do 20:00?');
    await drain();
    expect(textsSince(m, ORG).at(-1)).toContain('[pl] Can we do 20:00?');
    expect((await lastEvent()).id).toBe(event.id); // no new meetup was created
  });

  it('a failed Telegram send after a status change does not leave the event hanging', async () => {
    const m = mark();
    await say(ORG, 'Broken Bar tonight');
    await drain();
    const event = await lastEvent();
    expect(event.status).toBe('failed');
    expect(textsSince(m, ORG).at(-1)).toContain('Coś poszło nie tak');
  });

  it('another button cancels a pending "type…" prompt; stickers get a hint', async () => {
    await say(ORG, 'swim on Sunday');
    await drain();
    const event = await lastEvent();
    await tap(ORG, `vo:${event.id}`); // "Other place" -> waits for a name
    await tap(ORG, `ec:${event.id}`); // …but the organizer cancels instead
    await say(ORG, 'hi'); // must not be taken as the place name
    await drain();
    expect((await pool.query('SELECT status FROM events WHERE id = $1', [event.id])).rows[0].status).toBe('cancelled');
    expect((await lastEvent()).original_text).toBe('hi');

    const m = mark();
    await sticker(GUEST);
    expect(textsSince(m, GUEST)[0]).toContain('I only understand text messages');
  });

  it('queries Google Maps once per meetup and writes every invitation from that one answer', () => {
    const groundedPerLabel = gemini.calls.filter((c) => c.grounded).map((c) => c.label);
    expect(new Set(groundedPerLabel)).toEqual(new Set(['lookup_venue', 'suggest_venues']));
    // 6 meetups were planned in this file; none of them made a second Maps call (no per-recipient lookups)
    expect(groundedPerLabel.length).toBe(6);
    const invitationPrompts = gemini.calls.filter((c) => c.label === 'write_invitation');
    expect(invitationPrompts.length).toBeGreaterThanOrEqual(2);
    expect(invitationPrompts.some((c) => c.input.includes('PLACE FACTS'))).toBe(true);
  });
});
