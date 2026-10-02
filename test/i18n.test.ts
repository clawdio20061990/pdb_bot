import { describe, expect, it } from 'vitest';
import { _dictionaries, t, uiLang } from '../src/i18n.js';

const placeholders = (s: string) => [...s.matchAll(/\{(\w+)\}/g)].map((m) => m[1]).sort();

describe('i18n', () => {
  const en = _dictionaries.en!;

  it.each(Object.keys(_dictionaries))('%s has every key with the same placeholders as English', (lang) => {
    const dict = _dictionaries[lang]!;
    expect(Object.keys(dict).sort()).toEqual(Object.keys(en).sort());
    for (const key of Object.keys(en) as (keyof typeof en)[]) {
      expect(placeholders(dict[key]), `${lang}.${key}`).toEqual(placeholders(en[key]));
    }
  });

  it('falls back to English for languages without a dictionary', () => {
    expect(uiLang('de')).toBe('en');
    expect(uiLang(null)).toBe('en');
    expect(uiLang('PL')).toBe('pl');
    expect(t('de', 'btn_cancel')).toBe(en.btn_cancel);
  });

  it('interpolates variables and leaves unknown ones visible', () => {
    expect(t('en', 'checking_venue', { name: 'Brovarnia' })).toBe('🔎 Checking “Brovarnia”…');
    expect(t('en', 'checking_venue')).toContain('{name}');
  });

  it('never translates the Google Maps attribution text', () => {
    for (const dict of Object.values(_dictionaries)) {
      for (const value of Object.values(dict)) expect(value).not.toMatch(/Mapy Google|Google Карти/);
    }
  });
});
