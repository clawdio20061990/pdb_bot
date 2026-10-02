import { z } from 'zod';
import { languageName } from '../time.js';
import type { Plan, User, VenueFacts } from '../types.js';
import { displayName } from '../types.js';
import type { Gemini, InteractionResult, MapsTool } from './gemini.js';

/**
 * All model calls of the bot.
 *
 * Google Maps is queried ONCE per event, for the organizer: either a lookup of the place they named, or a
 * suggestion round for their own profile. What that answer says about the chosen place is stored on the event
 * (`venue_facts`) with its sources. Everything after that — the personal invitations and their translations —
 * is plain generation that compares those stored facts with each recipient's profile. No further Maps calls.
 */

export interface AiContext {
  gemini: Gemini;
  city: string;
  latitude: number;
  longitude: number;
  /** Ask grounded answers in the reader's language (default) instead of English. */
  groundedInUserLanguage?: boolean;
}

function answerLanguage(ctx: AiContext, language: string): string {
  return ctx.groundedInUserLanguage === false ? 'English' : languageName(language);
}

function mapsTool(ctx: AiContext): MapsTool[] {
  return [{ type: 'google_maps', latitude: ctx.latitude, longitude: ctx.longitude }];
}

function profileLine(u: User): string {
  return `- ${displayName(u)}: likes ${u.likes || 'nothing listed'}; dislikes ${u.dislikes || 'nothing listed'}`;
}

// ---------------------------------------------------------------------------
// 1. Understand the organizer's idea (not grounded, structured output)
// ---------------------------------------------------------------------------

export interface ParsedIdea extends Plan {
  is_event_idea: boolean;
}

const parsedIdeaSchema = z.object({
  is_event_idea: z.boolean(),
  activity: z.string(),
  activity_local: z.string(),
  venue_kind: z.enum(['public', 'private', 'none']),
  venue_name: z.string().nullable(),
  venue_type: z.string(),
  when_text: z.string().nullable(),
  when_local: z.string().nullable(),
  notes: z.string().nullable(),
});

const parsedIdeaJsonSchema = {
  type: 'object',
  properties: {
    is_event_idea: {
      type: 'boolean',
      description: 'true if the message proposes meeting up / doing something together; false for greetings, questions, random text',
    },
    activity: { type: 'string', description: 'Short English description of the activity, e.g. "beers", "swimming", "board games night"' },
    activity_local: { type: 'string', description: 'The same short activity description in the organizer language' },
    venue_kind: {
      type: 'string',
      enum: ['public', 'private', 'none'],
      description:
        'public = a named public place (bar, pool, club, park...), private = someone\'s home or similar non-public place, none = no specific place given',
    },
    venue_name: {
      type: ['string', 'null'],
      description: 'The place exactly as the organizer named it (fix obvious capitalization), or null when venue_kind is none',
    },
    venue_type: {
      type: 'string',
      description:
        'English type of place that fits the activity, usable in a Google Maps search, e.g. "bar", "swimming pool", "sailing club", "board game cafe"',
    },
    when_text: {
      type: ['string', 'null'],
      description:
        'Date/time in English like "Saturday, 26 September, 19:00", or null if not given. Resolve relative days using the current date. ' +
        'Never invent a clock time: keep vague times vague, e.g. "Friday, 25 September, evening".',
    },
    when_local: {
      type: ['string', 'null'],
      description:
        'The same date/time in the organizer language, with the SAME resolved weekday, day and month as when_text ' +
        '(e.g. "piątek, 25 września, wieczór"), or null. Never vaguer than when_text.',
    },
    notes: {
      type: ['string', 'null'],
      description: 'Any other wishes from the message in short English (budget, area, atmosphere...), or null',
    },
  },
  required: ['is_event_idea', 'activity', 'activity_local', 'venue_kind', 'venue_name', 'venue_type', 'when_text', 'when_local', 'notes'],
};

export async function parseIdea(ctx: AiContext, text: string, organizer: User, now: string): Promise<ParsedIdea> {
  const lang = languageName(organizer.language);
  return ctx.gemini.json({
    label: 'parse_idea',
    thinking: 'low',
    maxOutputTokens: 2048,
    system:
      `You extract meetup plans from short chat messages written by people in ${ctx.city}, Poland. ` +
      'The message can be in any language. Never invent details that are not in the message.',
    input: `Current date and time: ${now}\nOrganizer language: ${lang}\n\nOrganizer message:\n<<<\n${text}\n>>>`,
    schema: parsedIdeaSchema,
    jsonSchema: parsedIdeaJsonSchema,
  });
}

// ---------------------------------------------------------------------------
// 2. The single Google Maps call per event (the organizer's)
// ---------------------------------------------------------------------------

const GROUNDED_SYSTEM = (city: string, language: string) =>
  `You are a local guide for ${city}, Poland. Use Google Maps to find real places located in the city of ${city} ` +
  '(not in Sopot, Gdynia, Pruszcz Gdański or other towns). ' +
  'State only what Google Maps data supports; never guess or invent details — write "unknown" instead. ' +
  `Write the answer in ${language}, in plain text: no Markdown, no asterisks, no headings.`;

/** The per-place block both grounded prompts ask for: facts first (they feed every invitation), fit second. */
const PLACE_BLOCK = (city: string, forWhom: string, language: string) =>
  'For each place write exactly these three lines (write the two labels in ' +
  `${language} too, e.g. "What's there:" and "Fits:"):\n` +
  `<place name exactly as on Google Maps> (<street address in ${city}>)\n` +
  `What's there: food and drinks (including non-alcoholic options), atmosphere and noise level, what you can do there, ` +
  'notable features, quieter times — at most 70 words, only facts Google Maps supports, "unknown" where it has none.\n' +
  `Fits: one sentence on how it suits ${forWhom}, honestly naming anything that clashes.`;

/** Organizer-initiated: suggest places for the ORGANIZER's own taste (nobody has been invited yet). */
export async function suggestVenues(
  ctx: AiContext,
  args: { plan: Plan; organizer: User; exclude: string[]; language: string },
): Promise<InteractionResult> {
  const { plan, organizer } = args;
  const exclude = args.exclude.length ? `\nDo not suggest these places again: ${args.exclude.join('; ')}.` : '';
  return ctx.gemini.interact({
    label: 'suggest_venues',
    // 'minimal' is 2-4x faster, but non-English answers come out with agreement errors, and a grounded
    // answer is shown as written — so pay for more thinking only when we don't ask for English.
    thinking: answerLanguage(ctx, args.language) === 'English' ? 'minimal' : 'low',
    maxOutputTokens: 4096,
    tools: mapsTool(ctx),
    system: GROUNDED_SYSTEM(ctx.city, answerLanguage(ctx, args.language)),
    input:
      `Activity: ${plan.activity} (kind of place: ${plan.venue_type})\n` +
      (plan.notes ? `Wishes: ${plan.notes}\n` : '') +
      `When: ${plan.when_text ?? 'not set yet'}\n` +
      `The organizer:\n${profileLine(organizer)}\n\n` +
      `Suggest up to 3 real places in ${ctx.city} for this plan.${exclude}\n` +
      `Number them 1., 2., 3. ${PLACE_BLOCK(ctx.city, 'the organizer', answerLanguage(ctx, args.language))}\nNo intro, no outro.`,
  });
}

export const NOT_FOUND = 'NOT_FOUND';
export const OUTSIDE = 'OUTSIDE_CITY';

/** Organizer-initiated: look up the place they named. This answer is also the event's fact sheet. */
export async function lookupVenue(
  ctx: AiContext,
  args: { venueName: string; plan: Plan; organizer: User; language: string },
): Promise<InteractionResult & { outcome: 'found' | 'not_found' | 'outside' }> {
  const { plan } = args;
  const res = await ctx.gemini.interact({
    label: 'lookup_venue',
    thinking: 'low',
    maxOutputTokens: 4096,
    tools: mapsTool(ctx),
    system: GROUNDED_SYSTEM(ctx.city, answerLanguage(ctx, args.language)),
    input:
      `Find the place "${args.venueName}" in ${ctx.city}, Poland on Google Maps.\n` +
      `Plan: ${plan.activity}${plan.when_text ? `, ${plan.when_text}` : ''}.\n` +
      `The organizer:\n${profileLine(args.organizer)}\n\n` +
      `If there is no such place at all, reply with exactly ${NOT_FOUND} and nothing else. ` +
      `If it exists but is not in the city of ${ctx.city}, reply with exactly ${OUTSIDE} and nothing else.\n` +
      `If the name matches SEVERAL places in ${ctx.city} (a chain with more than one address), list them all, numbered 1., 2., 3.\n` +
      `${PLACE_BLOCK(ctx.city, 'the organizer', answerLanguage(ctx, args.language))}`,
  });
  const head = res.text.trim().toUpperCase();
  const outcome = head.startsWith(OUTSIDE) ? 'outside' : head.startsWith(NOT_FOUND) ? 'not_found' : 'found';
  return { ...res, outcome };
}

// ---------------------------------------------------------------------------
// 3. Invitations: stored facts vs. one recipient's profile (no further Maps calls)
// ---------------------------------------------------------------------------

export interface InvitationInput {
  organizer: User;
  recipient: User;
  originalText: string;
  plan: Plan;
  venueName: string | null;
  /** The event's single Google Maps answer about the place (null when there is no public venue). */
  facts: VenueFacts | null;
}

const INVITATION_RULES = (organizer: string, recipient: string, hasFacts: boolean) => `RULES:
1. Write as the bot passing on ${organizer}'s invitation: address ${recipient} by name and mention ${organizer} in the third person.
2. Include the activity, the place name (if given) and the time (if given). If the time is not set, say it is still open and invite ${recipient} to suggest one (and a place, if there is none).
3. ${
  hasFacts
    ? `THIS IS THE POINT OF THE MESSAGE: sell the evening to ${recipient}. Pick two or three concrete things from PLACE FACTS that match their likes — a dish, a drink, a game, the view, the terrace, a quiet corner — and name them specifically. Never a vague "it'll be fun". There is always something for them, even when the activity itself is not their thing: find it in PLACE FACTS.`
    : `Sell the evening with one or two of ${recipient}'s likes connected to the activity itself.`
}
4. Write it as an upside, never as a warning. Do NOT mention, flag or apologize for anything ${recipient} dislikes, and do not raise the subject at all (no "I know you don't drink", no "it may be crowded"). ${
  hasFacts
    ? 'When a dislike is part of the plan, simply lead with the facts that work for them instead — the non-alcoholic menu, the food, the quiet room, the quieter hours. If PLACE FACTS offer nothing on that topic, stay silent about it and sell what is there.'
    : 'Stay on what they enjoy.'
}
5. Everything you say about the place must come from ${hasFacts ? 'PLACE FACTS or' : ''} the organizer's own words. Never invent or guess (menu, prices, atmosphere, amenities, opening hours); anything marked unknown stays unmentioned.
6. Keep the organizer's plan exactly as it is: never propose another time, another place or extra activities ("let's go earlier", "and afterwards we could…"). Invite them to what was proposed.
7. Friendly, natural texting style, 3-5 sentences, at most 2 emojis. Emojis must depict the activity or the place — never an unrelated hobby from RECIPIENT LIKES — and must never contradict ${recipient}'s dislikes. No hashtags, lists or headings. Never mention buttons.
8. Output only the message text, in English.`;

function invitationFacts(i: InvitationInput): string {
  return (
    `ORGANIZER: ${displayName(i.organizer)}\n` +
    `RECIPIENT: ${displayName(i.recipient)}\n` +
    `RECIPIENT LIKES: ${i.recipient.likes || '(none listed)'}\n` +
    `RECIPIENT DISLIKES: ${i.recipient.dislikes || '(none listed)'}\n` +
    `ORGANIZER'S MESSAGE: "${i.originalText}"\n` +
    `ACTIVITY: ${i.plan.activity}\n` +
    `PLACE: ${i.venueName ?? 'not decided yet'}\n` +
    `TIME: ${i.plan.when_text ?? 'not set yet'}` +
    (i.facts
      ? `\n\nPLACE FACTS (one Google Maps lookup for this meetup; it may also describe other places — use only what is about ${i.venueName}):\n<<<\n${i.facts.text}\n>>>`
      : '')
  );
}

export async function writeInvitation(ctx: AiContext, i: InvitationInput): Promise<string> {
  const res = await ctx.gemini.interact({
    label: 'write_invitation',
    thinking: 'low',
    maxOutputTokens: 2048,
    system: `You write short, warm, persuasive invitations between friends for meetups in ${ctx.city}, Poland.`,
    input: `${invitationFacts(i)}\n\n${INVITATION_RULES(displayName(i.organizer), displayName(i.recipient), Boolean(i.facts))}`,
  });
  return res.text;
}

export async function rewriteInvitation(ctx: AiContext, i: InvitationInput, draft: string, instruction: string): Promise<string> {
  const res = await ctx.gemini.interact({
    label: 'rewrite_invitation',
    thinking: 'low',
    maxOutputTokens: 2048,
    system: `You edit short invitations between friends for meetups in ${ctx.city}, Poland.`,
    input:
      `${invitationFacts(i)}\n\nCURRENT DRAFT:\n<<<\n${draft}\n>>>\n\n` +
      `THE ORGANIZER ASKS YOU TO CHANGE IT LIKE THIS (the request may be in any language): "${instruction}"\n\n` +
      'Rewrite the draft following the request. Details the organizer states in the request count as organizer-provided.\n' +
      INVITATION_RULES(displayName(i.organizer), displayName(i.recipient), Boolean(i.facts)),
  });
  return res.text;
}

/** Translate a chat message. Returns the text unchanged when it is already in the target language. */
export async function translate(ctx: AiContext, text: string, targetLanguage: string): Promise<string> {
  const lang = languageName(targetLanguage);
  const res = await ctx.gemini.interact({
    label: `translate_${targetLanguage}`,
    thinking: 'minimal',
    maxOutputTokens: 2048,
    system: 'You translate casual chat messages between friends.',
    input:
      `Translate the message below into ${lang}. Keep the meaning, tone, emojis and line breaks. ` +
      `Keep names of people and places unchanged, and never translate the words "Google Maps". Use natural, informal ${lang}. ` +
      'The sender\'s gender is unknown: use gender-neutral wording (e.g. "zaprasza cię", "ma ochotę") and never slashed forms like "chciałaby/chciałby". ' +
      `If it is already in ${lang}, return it unchanged. Output only the translation.\n\n<<<\n${text}\n>>>`,
  });
  return res.text;
}
