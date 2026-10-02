import { z } from 'zod';

/**
 * Values pasted into a dashboard often carry stray whitespace, newlines or quotes;
 * strip them before validating so a copy-paste slip doesn't stop the bot from booting.
 */
function cleaned(): z.ZodType<string> {
  return z.preprocess(
    (v) => (typeof v === 'string' ? v.trim().replace(/^(['"])([\s\S]*)\1$/, '$2').trim() : v),
    z.string(),
  ) as z.ZodType<string>;
}

const schema = z.object({
  BOT_TOKEN: cleaned().refine((v) => v.length >= 20, 'BOT_TOKEN is missing or too short'),
  GEMINI_API_KEY: cleaned().refine((v) => v.length >= 10, 'GEMINI_API_KEY is missing or too short'),
  // The error never echoes the value: it contains the password.
  DATABASE_URL: cleaned().refine(
    (v) => /^postgres(ql)?:\/\//.test(v),
    'DATABASE_URL must start with postgresql:// — paste the Neon connection string, without quotes or spaces',
  ),
  GEMINI_MODEL: cleaned().default('gemini-3.6-flash'),
  // Profiles as JSON. Takes precedence over data/users.json, which keeps personal data out of the repo.
  USERS_JSON: cleaned().optional(),
  // Public base URL of this service. On Render it defaults to RENDER_EXTERNAL_URL.
  // When neither is set the bot runs in long-polling mode (local development).
  WEBHOOK_URL: cleaned().pipe(z.string().url()).optional(),
  RENDER_EXTERNAL_URL: cleaned().pipe(z.string().url()).optional(),
  // Render's generateValue is base64 (+ / =), which Telegram rejects; keep only the allowed characters.
  WEBHOOK_SECRET: cleaned()
    .transform((s) => s.replace(/[^A-Za-z0-9_-]/g, '').slice(0, 256))
    .refine((s) => s.length >= 16, 'WEBHOOK_SECRET must have at least 16 of A-Z a-z 0-9 _ -')
    .optional(),
  PORT: z.coerce.number().int().positive().default(3000),
  // The POC only searches in one city.
  CITY_NAME: cleaned().default('Gdańsk'),
  CITY_LAT: z.coerce.number().default(54.352),
  CITY_LNG: z.coerce.number().default(18.6466),
  TIMEZONE: cleaned().default('Europe/Warsaw'),
  WORKER_CONCURRENCY: z.coerce.number().int().min(1).max(10).default(3),
  // "false" = don't process background jobs in this process (e.g. a local run against the production DB).
  WORKER_ENABLED: z
    .enum(['true', 'false'])
    .default('true')
    .transform((v) => v === 'true'),
  // Google documents Maps grounding as English-only, but it works (with citations) in Polish etc.
  // Set to "false" to get grounded blocks in English.
  GROUNDING_IN_USER_LANGUAGE: z
    .enum(['true', 'false'])
    .default('true')
    .transform((v) => v === 'true'),
});

export type Config = z.infer<typeof schema> & { webhookBaseUrl: string | undefined };

export function loadConfig(env: NodeJS.ProcessEnv = process.env): Config {
  const parsed = schema.safeParse(env);
  if (!parsed.success) {
    const issues = parsed.error.issues.map((i) => `  - ${i.path.join('.')}: ${i.message}`).join('\n');
    throw new Error(`Invalid environment:\n${issues}`);
  }
  const cfg = parsed.data;
  const webhookBaseUrl = (cfg.WEBHOOK_URL ?? cfg.RENDER_EXTERNAL_URL)?.replace(/\/+$/, '');
  if (webhookBaseUrl && !cfg.WEBHOOK_SECRET) {
    throw new Error('WEBHOOK_SECRET is required when running with a webhook (WEBHOOK_URL / RENDER_EXTERNAL_URL set)');
  }
  return { ...cfg, webhookBaseUrl };
}
