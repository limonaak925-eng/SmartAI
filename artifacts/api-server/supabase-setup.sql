-- Run this SQL in your Supabase SQL Editor (https://supabase.com/dashboard)
-- Project: gjvthuxqfsolhmdlauaw

CREATE TABLE IF NOT EXISTS bot_users (
  id BIGSERIAL PRIMARY KEY,
  telegram_id BIGINT UNIQUE NOT NULL,
  username TEXT,
  first_name TEXT NOT NULL,
  last_name TEXT,
  last_seen TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS bot_messages (
  id BIGSERIAL PRIMARY KEY,
  telegram_id BIGINT NOT NULL,
  role TEXT NOT NULL CHECK (role IN ('user', 'assistant')),
  content TEXT NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- Long-term memory: one row per fact per user
CREATE TABLE IF NOT EXISTS bot_memories (
  id BIGSERIAL PRIMARY KEY,
  telegram_id BIGINT NOT NULL,
  key TEXT NOT NULL,
  value TEXT NOT NULL,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE (telegram_id, key)
);

CREATE INDEX IF NOT EXISTS bot_messages_telegram_id_idx ON bot_messages(telegram_id);
CREATE INDEX IF NOT EXISTS bot_messages_created_at_idx ON bot_messages(created_at);
CREATE INDEX IF NOT EXISTS bot_memories_telegram_id_idx ON bot_memories(telegram_id);
