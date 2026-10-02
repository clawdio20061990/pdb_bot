/** Apply migrations and sync data/users.json without starting the bot: `npm run migrate`. */
import { createPool, migrate } from '../src/db.js';
import { Repo } from '../src/repo.js';
import { syncUsersFromFile } from '../src/users-sync.js';

const url = process.env.DATABASE_URL;
if (!url) throw new Error('DATABASE_URL is not set (put it in .env and run with --env-file=.env)');

await migrate(url);
const pool = createPool(url);
try {
  const res = await syncUsersFromFile(new Repo(pool));
  console.log('migrations applied; users synced', res);
} finally {
  await pool.end();
}
