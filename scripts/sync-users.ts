/** Sync data/users.json into the database: `npm run users:sync`. */
import { createPool } from '../src/db.js';
import { Repo } from '../src/repo.js';
import { syncUsers } from '../src/users-sync.js';

const url = process.env.DATABASE_URL;
if (!url) throw new Error('DATABASE_URL is not set (put it in .env and run with --env-file=.env)');

const pool = createPool(url);
try {
  console.log('users synced', (await syncUsers(new Repo(pool), process.env.USERS_JSON)) ?? '(no profile source)');
} finally {
  await pool.end();
}
