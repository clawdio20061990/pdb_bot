-- Registered people. Profiles come from data/users.json (synced on every boot).
CREATE TABLE users (
  chat_id        BIGINT PRIMARY KEY,
  username       TEXT,
  name           TEXT,                          -- optional display name from users.json
  tg_first_name  TEXT,                          -- learned from Telegram on each interaction
  language       TEXT NOT NULL DEFAULT 'en',    -- ISO 639-1 code, e.g. 'pl', 'en', 'uk'
  likes          TEXT NOT NULL DEFAULT '',
  dislikes       TEXT NOT NULL DEFAULT '',
  is_active      BOOLEAN NOT NULL DEFAULT TRUE,
  created_at     TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at     TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- One organizer idea = one event.
-- status: planning -> choosing_venue -> confirming -> (drafting -> reviewing ->) sending -> sent
--         any unsent state -> cancelled | failed
CREATE TABLE events (
  id                  BIGSERIAL PRIMARY KEY,
  organizer_chat_id   BIGINT NOT NULL REFERENCES users(chat_id),
  original_text       TEXT NOT NULL,
  status              TEXT NOT NULL,
  plan                JSONB,          -- parsed idea (activity, venue name/type, when)
  venue_options       JSONB,          -- places offered to the organizer: [{name, place_id}] (purged after 30 days)
  venue               JSONB,          -- confirmed place: {name, place_id, maps_url}
  send_mode           TEXT,           -- 'now' | 'review'
  card_message_id     BIGINT,         -- organizer's event card (send now / review / cancel)
  summary_message_id  BIGINT,         -- organizer's review summary (send all / cancel)
  error               TEXT,
  created_at          TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at          TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX events_organizer_idx ON events (organizer_chat_id, id DESC);

-- One row per (event, recipient).
-- status: pending -> draft | excluded -> queued -> sending -> sent | failed
CREATE TABLE invitations (
  id                  BIGSERIAL PRIMARY KEY,
  event_id            BIGINT NOT NULL REFERENCES events(id) ON DELETE CASCADE,
  recipient_chat_id   BIGINT NOT NULL REFERENCES users(chat_id),
  language            TEXT NOT NULL,
  status              TEXT NOT NULL DEFAULT 'pending',
  base_text           TEXT,           -- English text (or the organizer's manual edit)
  final_text          TEXT,           -- text in the recipient's language (what gets sent)
  review_message_id   BIGINT,         -- draft preview message in the organizer's chat
  message_id          BIGINT,         -- invitation message in the recipient's chat
  rsvp                TEXT,           -- 'yes' | 'maybe' | 'no'
  rsvp_at             TIMESTAMPTZ,
  proposal            TEXT,           -- recipient's counter-proposal (time/place)
  attempts            INT NOT NULL DEFAULT 0,
  last_error          TEXT,
  created_at          TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at          TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (event_id, recipient_chat_id)
);

-- Background work (everything that calls Gemini or sends in bulk).
CREATE TABLE jobs (
  id            BIGSERIAL PRIMARY KEY,
  kind          TEXT NOT NULL,
  payload       JSONB NOT NULL DEFAULT '{}'::jsonb,
  status        TEXT NOT NULL DEFAULT 'queued',   -- queued | running | done | failed
  attempts      INT NOT NULL DEFAULT 0,
  max_attempts  INT NOT NULL DEFAULT 3,
  run_after     TIMESTAMPTZ NOT NULL DEFAULT now(),
  locked_at     TIMESTAMPTZ,
  last_error    TEXT,
  created_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at    TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX jobs_ready_idx ON jobs (run_after, id) WHERE status = 'queued';
CREATE INDEX jobs_running_idx ON jobs (locked_at) WHERE status = 'running';

-- "Next text message from this chat is an answer to X" (edit draft, AI tweak, own venue, proposal).
CREATE TABLE pending_inputs (
  chat_id     BIGINT PRIMARY KEY,
  kind        TEXT NOT NULL,
  ref_id      BIGINT NOT NULL,
  created_at  TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- Telegram may redeliver a webhook update; process each update_id once.
CREATE TABLE processed_updates (
  update_id   BIGINT PRIMARY KEY,
  created_at  TIMESTAMPTZ NOT NULL DEFAULT now()
);
