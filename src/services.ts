import type { AiContext } from './ai/pipeline.js';
import type { Tg } from './bot/telegram.js';
import type { Config } from './config.js';
import type { Queue } from './jobs/queue.js';
import type { Repo } from './repo.js';

/** Everything handlers and jobs need, wired once in index.ts. */
export interface Services {
  cfg: Config;
  repo: Repo;
  queue: Queue;
  ai: AiContext;
  tg: Tg;
}
