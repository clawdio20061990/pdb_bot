import { describe, expect, it } from 'vitest';
import { loadConfig } from '../src/config.js';

const base = {
  BOT_TOKEN: '123456789:AAFakeTokenForTests123456',
  GEMINI_API_KEY: 'AIza-fake-key-for-tests',
  DATABASE_URL: 'postgresql://u:p@ep-x-pooler.eu-central-1.aws.neon.tech/neondb?sslmode=require',
};

describe('loadConfig', () => {
  it('survives values pasted with quotes, spaces or newlines', () => {
    const cfg = loadConfig({
      ...base,
      DATABASE_URL: `  "${base.DATABASE_URL}" \n`,
      BOT_TOKEN: `'${base.BOT_TOKEN}'`,
      CITY_NAME: ' Gdańsk ',
    } as NodeJS.ProcessEnv);
    expect(cfg.DATABASE_URL).toBe(base.DATABASE_URL);
    expect(cfg.BOT_TOKEN).toBe(base.BOT_TOKEN);
    expect(cfg.CITY_NAME).toBe('Gdańsk');
  });

  it('explains a wrong DATABASE_URL without printing it', () => {
    expect(() => loadConfig({ ...base, DATABASE_URL: 'AIzaSySecretKeyPastedByMistake' } as NodeJS.ProcessEnv)).toThrow(
      /DATABASE_URL must start with postgresql:\/\//,
    );
    try {
      loadConfig({ ...base, DATABASE_URL: 'AIzaSySecretKeyPastedByMistake' } as NodeJS.ProcessEnv);
    } catch (err) {
      expect((err as Error).message).not.toContain('AIzaSySecret');
    }
  });

  it('accepts postgres:// as well as postgresql://', () => {
    expect(loadConfig({ ...base, DATABASE_URL: 'postgres://u:p@host/db' } as NodeJS.ProcessEnv).DATABASE_URL).toBe('postgres://u:p@host/db');
  });

  it('needs a webhook secret once a public URL is set', () => {
    expect(() => loadConfig({ ...base, RENDER_EXTERNAL_URL: 'https://pdb-bot.onrender.com' } as NodeJS.ProcessEnv)).toThrow(/WEBHOOK_SECRET/);
    const cfg = loadConfig({
      ...base,
      RENDER_EXTERNAL_URL: 'https://pdb-bot.onrender.com/',
      WEBHOOK_SECRET: 'B0jr+KF/Uk=aaaaaaaaaaaaaaaaaa', // Render's generated value: not Telegram-safe as is
    } as NodeJS.ProcessEnv);
    expect(cfg.webhookBaseUrl).toBe('https://pdb-bot.onrender.com');
    expect(cfg.WEBHOOK_SECRET).toMatch(/^[A-Za-z0-9_-]+$/);
  });
});
