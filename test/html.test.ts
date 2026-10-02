import { describe, expect, it } from 'vitest';
import { clip, esc, link, safeUrl } from '../src/html.js';
import { directUrl } from '../src/db.js';

describe('html helpers', () => {
  it('escapes Telegram HTML special characters', () => {
    expect(esc('<b>Tom & "Jerry"</b>')).toBe('&lt;b&gt;Tom &amp; &quot;Jerry&quot;&lt;/b&gt;');
    expect(esc(null)).toBe('');
  });

  it('only links http(s) urls', () => {
    expect(safeUrl('javascript:alert(1)')).toBeNull();
    expect(safeUrl('not a url')).toBeNull();
    expect(link('Place', 'https://maps.google.com/maps?cid=1&x="y"')).toBe(
      '<a href="https://maps.google.com/maps?cid=1&amp;x=%22y%22">Place</a>',
    );
    expect(link('<Place>', null)).toBe('&lt;Place&gt;');
  });

  it('clips long text', () => {
    expect(clip('abc', 10)).toBe('abc');
    expect(clip('abcdefghijkl', 5)).toBe('abcd…');
  });
});

describe('directUrl', () => {
  it('turns the Neon pooler host into the direct host', () => {
    const out = new URL(directUrl('postgresql://u:p@ep-x-pooler.c-6.eu-central-1.aws.neon.tech/db?sslmode=require'));
    expect(out.hostname).toBe('ep-x.c-6.eu-central-1.aws.neon.tech');
    expect(out.username).toBe('u');
  });
});
