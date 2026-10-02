import { autoRetry } from '@grammyjs/auto-retry';
import { Bot } from 'grammy';
import { Gemini } from './ai/gemini.js';
import { type BotContext, registerHandlers } from './bot/handlers.js';
import { Tg } from './bot/telegram.js';
import { loadConfig } from './config.js';
import { createPool, migrate } from './db.js';
import { Queue } from './jobs/queue.js';
import { Worker } from './jobs/worker.js';
import { errMessage, log } from './log.js';
import { Repo } from './repo.js';
import { startServer, WEBHOOK_PATH, type WebServer } from './server.js';
import type { Services } from './services.js';
import { syncUsersFromFile } from './users-sync.js';

const ALLOWED_UPDATES = ['message', 'callback_query'] as const;

const COMMANDS: Record<string, { command: string; description: string }[]> = {
  en: [
    { command: 'start', description: 'How it works' },
    { command: 'status', description: 'My meetups' },
    { command: 'profile', description: 'My profile' },
    { command: 'cancel', description: 'Cancel the current action' },
    { command: 'whoami', description: 'My chat id' },
  ],
  pl: [
    { command: 'start', description: 'Jak to działa' },
    { command: 'status', description: 'Moje spotkania' },
    { command: 'profile', description: 'Mój profil' },
    { command: 'cancel', description: 'Anuluj bieżącą akcję' },
    { command: 'whoami', description: 'Mój chat id' },
  ],
  uk: [
    { command: 'start', description: 'Як це працює' },
    { command: 'status', description: 'Мої зустрічі' },
    { command: 'profile', description: 'Мій профіль' },
    { command: 'cancel', description: 'Скасувати поточну дію' },
    { command: 'whoami', description: 'Мій chat id' },
  ],
};

async function main(): Promise<void> {
  const cfg = loadConfig();

  await migrate(cfg.DATABASE_URL);
  const pool = createPool(cfg.DATABASE_URL);
  const repo = new Repo(pool);
  log.info('boot', 'users synced from data/users.json', await syncUsersFromFile(repo));

  const bot = new Bot<BotContext>(cfg.BOT_TOKEN);
  bot.api.config.use(autoRetry({ maxRetryAttempts: 3, maxDelaySeconds: 30 }));
  const languages = new Map<number, string>();
  const languageOf = async (chatId: number): Promise<string> => {
    const known = languages.get(chatId);
    if (known) return known;
    const language = (await repo.getUser(chatId))?.language ?? 'en';
    languages.set(chatId, language);
    return language;
  };
  const services: Services = {
    cfg,
    repo,
    queue: new Queue(pool),
    tg: new Tg(bot.api, languageOf),
    ai: {
      gemini: new Gemini(cfg.GEMINI_API_KEY, cfg.GEMINI_MODEL),
      city: cfg.CITY_NAME,
      latitude: cfg.CITY_LAT,
      longitude: cfg.CITY_LNG,
      groundedInUserLanguage: cfg.GROUNDING_IN_USER_LANGUAGE,
    },
  };
  registerHandlers(bot, services);
  await bot.init(); // fail fast on a bad token
  log.info('boot', `bot @${bot.botInfo.username}, model ${cfg.GEMINI_MODEL}`);

  for (const [language, commands] of Object.entries(COMMANDS)) {
    await bot.api
      .setMyCommands(commands, language === 'en' ? {} : { language_code: language as 'pl' | 'uk' })
      .catch((err) => log.warn('boot', 'setMyCommands failed', { language, error: errMessage(err) }));
  }

  await learnMissingNames(bot, repo);

  const worker = new Worker(services, cfg.WORKER_CONCURRENCY);
  if (cfg.WORKER_ENABLED) worker.start();
  else log.warn('boot', 'WORKER_ENABLED=false: background jobs are NOT processed by this instance');

  let server: WebServer | undefined;
  if (cfg.webhookBaseUrl) {
    server = startServer(bot, cfg.PORT, cfg.WEBHOOK_SECRET!);
    const url = `${cfg.webhookBaseUrl}${WEBHOOK_PATH}`;
    await bot.api.setWebhook(url, { secret_token: cfg.WEBHOOK_SECRET!, allowed_updates: [...ALLOWED_UPDATES] });
    log.info('boot', `webhook set to ${url}`);
  } else {
    log.warn('boot', 'no WEBHOOK_URL/RENDER_EXTERNAL_URL: long polling (this removes any webhook set for this bot token!)');
    bot.catch((err) => log.error('bot', 'polling error', { error: errMessage(err.error) }));
    void bot.start({ allowed_updates: [...ALLOWED_UPDATES], onStart: () => log.info('boot', 'long polling started') });
  }

  let stopping = false;
  const shutdown = async (signal: string) => {
    if (stopping) return;
    stopping = true;
    log.info('boot', `${signal}: shutting down`);
    // Render gives ~30 s after SIGTERM: finish in-flight webhook handlers and jobs, then close the pool.
    if (!cfg.webhookBaseUrl) await bot.stop().catch(() => {});
    await Promise.all([server?.close(15_000), worker.stop(20_000)]);
    await pool.end().catch(() => {});
    process.exit(0);
  };
  process.on('SIGTERM', () => void shutdown('SIGTERM'));
  process.on('SIGINT', () => void shutdown('SIGINT'));
}

/** Profiles only have usernames: use the Telegram first name of people who already started the bot. */
async function learnMissingNames(bot: Bot<BotContext>, repo: Repo): Promise<void> {
  for (const u of await repo.getActiveUsers()) {
    if (u.name || u.tg_first_name) continue;
    try {
      const chat = await bot.api.getChat(u.chat_id);
      if (chat.type === 'private') await repo.rememberTelegramName(u.chat_id, chat.first_name);
    } catch {
      // never started the bot yet — the name is learned on their first message
    }
  }
}

main().catch((err) => {
  log.error('boot', 'fatal', { error: errMessage(err), stack: (err as Error)?.stack });
  process.exit(1);
});
