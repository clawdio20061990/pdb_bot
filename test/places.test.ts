import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { extractResult } from '../src/ai/gemini.js';
import { bestMatch, blockAbout, groundedSources, normalize, placeLabel, placeOptions } from '../src/ai/places.js';

const fixture = (name: string) => extractResult(JSON.parse(readFileSync(new URL(`./fixtures/${name}`, import.meta.url), 'utf8')));

describe('places from grounded answers', () => {
  it('uses citations when the answer has them (real Polish answer)', () => {
    const res = fixture('lookup_polish_with_citations.json');
    expect(res.citations.length).toBeGreaterThan(0);
    expect(groundedSources(res)).toBe(res.citations);
    expect(bestMatch(res, 'Craft Kultura')).toEqual({ name: 'Craft Kultura', place_id: 'ChIJKSrIW1Nz_UYRhDJiZ2qrrOw' });
  });

  it('falls back to the Maps results the text mentions when citations are missing (real sailing answer)', () => {
    const res = fixture('suggest_no_citations.json');
    expect(res.citations).toHaveLength(0);
    expect(res.mapsPlaces.length).toBeGreaterThan(3);
    const names = placeOptions(res).map((o) => o.name);
    // "United Sailing Club" and "Rejsy w Sopocie…" were returned by Maps but not mentioned -> not sources
    expect(names).toEqual(['Yacht Club Premier', 'Rejsy w Gdańsku – Premium Yachting', 'Premium Yachting']);
    for (const s of groundedSources(res)) expect(s.name).not.toMatch(/^Review of/);
  });

  it('does not accept a place whose name has nothing in common with what was typed', () => {
    const res = {
      text: 'Pizza Roma (Długa 1) — great pizza.',
      citations: [{ place_id: 'ROMA', name: 'Pizza Roma - Google Maps', url: 'https://maps.google.com/?cid=9' }],
      mapsPlaces: [],
      mapsQueries: 1,
      usage: { input: 0, output: 0, thought: 0 },
    };
    expect(bestMatch(res, 'Pizzeria Napoli')).toBeNull();
    expect(bestMatch(res, 'Pizza Roma')).toMatchObject({ place_id: 'ROMA' });
    expect(bestMatch(res, 'roma')).toMatchObject({ place_id: 'ROMA' }); // a shared word is enough
  });

  it('cleans listing names without cutting real names', () => {
    expect(placeLabel('Brovarnia Gdańsk I Restauracja i Browar w Gdańsku - Google Maps')).toBe('Brovarnia Gdańsk I Restauracja i Browar w Gdańsku');
    expect(placeLabel('Rejsy w Gdańsku – Premium Yachting - Google Maps')).toBe('Rejsy w Gdańsku – Premium Yachting');
    expect(placeLabel('Review of Board Games 3city Club ( klub gier planszowych ) - Google Maps')).toBe('Board Games 3city Club');
  });

  it('matches shortened long listing names but not generic prefixes', () => {
    const base = { citations: [], mapsQueries: 1, usage: { input: 0, output: 0, thought: 0 } };
    const res = {
      ...base,
      text: '1. Brovarnia Gdańsk (Szafarnia 9) — great beer.',
      mapsPlaces: [
        { place_id: 'A', name: 'Brovarnia Gdańsk I Restauracja i Browar w Gdańsku - Google Maps', url: 'https://maps.google.com/?cid=1' },
        { place_id: 'B', name: 'Brovarnia Sopot - Google Maps', url: 'https://maps.google.com/?cid=2' },
      ],
    };
    expect(placeOptions(res).map((o) => o.place_id)).toEqual(['A']);
  });

  it('normalizes Polish diacritics', () => {
    expect(normalize('Pływalnia Chełm, Gdańsk!')).toBe(' plywalnia chelm gdansk ');
  });
});

describe('blockAbout', () => {
  const answer = (
    '1. Craft Kultura (Popiełuszki 22)\nWhat\'s there: board games, craft beer.\nFits: quiet.\n\n' +
      '2. Cybermachina (Długa 1)\nWhat\'s there: karaoke, cocktails.\nFits: loud.\n\n' +
      '3. Pool A (Stogi 2)\nWhat\'s there: lanes.\nFits: swimming.'
  );

  it('keeps only the part about the chosen place', () => {
    expect(blockAbout(answer, { name: 'Cybermachina', place_id: 'X' })).toContain('karaoke');
    expect(blockAbout(answer, { name: 'Cybermachina', place_id: 'X' })).not.toContain('board games');
  });

  it('falls back to the whole answer for a single place or an unknown name', () => {
    expect(blockAbout('Brovarnia (Szafarnia 9)\nWhat\'s there: beer.', { name: 'Brovarnia', place_id: null })).toContain('beer');
    expect(blockAbout(answer, { name: 'Somewhere else', place_id: null })).toContain('Craft Kultura');
  });
});
