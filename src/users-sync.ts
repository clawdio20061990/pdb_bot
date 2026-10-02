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

export async function loadSeedUsers(path: URL = new URL('../data/users.json', import.meta.url)): Promise<SeedUser[]> {
  const raw = JSON.parse(await readFile(path, 'utf8')) as unknown;
  return seedSchema.parse(raw);
}

export async function syncUsersFromFile(repo: Repo): Promise<{ upserted: number; deactivated: number }> {
  return repo.syncUsers(await loadSeedUsers());
}
