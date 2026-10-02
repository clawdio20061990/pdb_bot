/**
 * Dry run of the AI pipeline with real Gemini calls and the profiles from data/users.json.
 * No database, no Telegram. Prints what the organizer and each recipient would see.
 *
 *   npm run try -- "beer at Brovarnia on Saturday 7pm"
 *   npm run try -- "swimming pool on Sunday" --organizer 7085470148 --pick 1
 */
import { parseArgs } from 'node:util';
import { Gemini } from '../src/ai/gemini.js';
import { type AiContext, lookupVenue, parseIdea, suggestVenues, translate, writeInvitation } from '../src/ai/pipeline.js';
import { blockAbout, groundedSources, matchingOptions, placeOptions } from '../src/ai/places.js';
import { groundedBlock } from '../src/bot/views.js';
import { t } from '../src/i18n.js';
import { nowInZone } from '../src/time.js';
import type { User, VenueFacts } from '../src/types.js';
import { loadSeedUsers } from '../src/users-sync.js';

const { values, positionals } = parseArgs({
  allowPositionals: true,
  options: {
    organizer: { type: 'string' },
    pick: { type: 'string', default: '1' },
    details: { type: 'boolean', default: true },
  },
});
const idea = positionals.join(' ').trim();
if (!idea) throw new Error('usage: npm run try -- "<meetup idea>" [--organizer <chat_id>] [--pick N]');
const key = process.env.GEMINI_API_KEY;
if (!key) throw new Error('GEMINI_API_KEY is not set');

const users: User[] = (await loadSeedUsers()).map((u) => ({
  chat_id: u.chat_id,
  username: u.username ?? null,
  name: u.name ?? null,
  tg_first_name: null,
  language: u.language,
  likes: u.likes,
  dislikes: u.dislikes,
  is_active: true,
}));
const organizer = users.find((u) => String(u.chat_id) === values.organizer) ?? users[0]!;
const recipients = users.filter((u) => u !== organizer);
const ai: AiContext = {
  gemini: new Gemini(key, process.env.GEMINI_MODEL ?? 'gemini-3.6-flash'),
  city: 'Gdańsk',
  latitude: 54.352,
  longitude: 18.6466,
};
const strip = (html: string) => html.replace(/<[^>]+>/g, '').replace(/&quot;/g, '"').replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&amp;/g, '&');
const section = (title: string) => console.log(`\n${'='.repeat(8)} ${title} ${'='.repeat(Math.max(0, 60 - title.length))}`);

section(`IDEA from ${organizer.username} (${organizer.language})`);
console.log(idea);
const parsed = await parseIdea(ai, idea, organizer, nowInZone('Europe/Warsaw'));
console.log(JSON.stringify(parsed, null, 2));
if (!parsed.is_event_idea) process.exit(0);
const { is_event_idea: _x, ...plan } = parsed;

let venueName: string | null = null;
let facts: VenueFacts | null = null;
const group = [organizer, ...recipients];
if (plan.venue_kind === 'public' && plan.venue_name) {
  section('ORGANIZER sees: lookup (Google Maps)');
  const res = await lookupVenue(ai, { venueName: plan.venue_name, plan, organizer, language: organizer.language });
  console.log(res.outcome === 'found' ? strip(groundedBlock(organizer.language, t(organizer.language, 'place_info_header', { name: plan.venue_name }), res)) : `${res.outcome} -> ${res.text}`);
  const matches = res.outcome === 'found' ? matchingOptions(res, plan.venue_name) : [];
  if (matches.length > 1) console.log(`\n(ambiguous: ${matches.map((o) => o.name).join(' | ')} -> organizer picks #${values.pick})`);
  const picked = matches[Number(values.pick) - 1] ?? matches[0];
  if (picked) {
    venueName = picked.name;
    facts = { text: blockAbout(res.text, picked), sources: groundedSources(res) };
  }
} else if (plan.venue_kind === 'private' && plan.venue_name) {
  venueName = plan.venue_name;
} else {
  section('ORGANIZER sees: suggestions (Google Maps)');
  const res = await suggestVenues(ai, { plan, organizer, exclude: [], language: organizer.language });
  console.log(strip(groundedBlock(organizer.language, t(organizer.language, 'options_header', { activity: plan.activity_local }), res)));
  const options = placeOptions(res);
  if (!res.citations.length) console.log(`(no citations; ${groundedSources(res).length} sources matched from Maps results)`);
  console.log('\nbuttons:', options.map((o, i) => `[${i + 1}] ${o.name} (${o.place_id})`).join('  '));
  venueName = options[Number(values.pick) - 1]?.name ?? null;
  if (venueName) facts = { text: blockAbout(res.text, options[Number(values.pick) - 1]!), sources: groundedSources(res) };
  console.log(`-> organizer picks: ${venueName}`);
  if (facts) console.log(`\n--- stored facts for the invitations ---\n${facts.text}`);
}

for (const recipient of recipients) {
  section(`INVITATION for ${recipient.username} (${recipient.language})`);
  const input = { organizer, recipient, originalText: idea, plan, venueName, facts };
  const base = await writeInvitation(ai, input);
  console.log(`[en] ${base}`);
  if (recipient.language !== 'en') console.log(`[${recipient.language}] ${await translate(ai, base, recipient.language)}`);
}
