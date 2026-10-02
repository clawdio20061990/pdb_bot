import { readFile } from 'node:fs/promises';
import { z } from 'zod';
import type { Repo, SeedUser } from './repo.js';

const seedSchema = z
  .array(
    z.object({
      chat_id: z.number().int(),
      username: z.string().nullish(),
      name: z.string().nullish(),
      language: z
        .string()
        .regex(/^[a-z]{2,3}$/, 'language must be an ISO 639-1 code like "pl" or "en"'),
      likes: z.string().default(''),
      dislikes: z.string().default(''),
    }),
  )
  .refine((list) => new Set(list.map((u) => u.chat_id)).size === list.length, 'duplicate chat_id in users.json');

const DEFAULT_PATH = new URL('../data/users.json', import.meta.url);

/** Profiles from USERS_JSON, or from data/users.json when that env var is not set. */
export async function loadSeedUsers(json?: string, path: URL = DEFAULT_PATH): Promise<SeedUser[] | null> {
  let raw: unknown;
  if (json?.trim()) {
    raw = JSON.parse(json);
  } else {
    try {
      raw = JSON.parse(await readFile(path, 'utf8'));
    } catch {
      return null; // no source of profiles at all
    }
  }
  return seedSchema.parse(raw);
}

export async function syncUsers(repo: Repo, json?: string): Promise<{ upserted: number; deactivated: number } | null> {
  const seeds = await loadSeedUsers(json);
  // Without a source, leave the database alone instead of deactivating everybody.
  return seeds ? repo.syncUsers(seeds) : null;
}
