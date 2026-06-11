-- ============================================================
-- SmartAI Bot — MIS Database Schema
-- Run in Supabase SQL Editor:
-- https://supabase.com/dashboard/project/gjvthuxqfsolhmdlauaw/sql/new
-- ============================================================

-- ── Users ────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS bot_users (
  id             BIGSERIAL PRIMARY KEY,
  telegram_id    BIGINT UNIQUE NOT NULL,
  username       TEXT,
  first_name     TEXT NOT NULL,
  last_name      TEXT,
  language_code  TEXT,
  message_count  INTEGER NOT NULL DEFAULT 0,
  session_count  INTEGER NOT NULL DEFAULT 0,
  last_seen      TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  created_at     TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- ── Sessions ─────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS bot_sessions (
  id             BIGSERIAL PRIMARY KEY,
  telegram_id    BIGINT NOT NULL REFERENCES bot_users(telegram_id) ON DELETE CASCADE,
  started_at     TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  last_activity  TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  message_count  INTEGER NOT NULL DEFAULT 0
);

-- ── Messages ─────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS bot_messages (
  id             BIGSERIAL PRIMARY KEY,
  telegram_id    BIGINT NOT NULL,
  session_id     BIGINT REFERENCES bot_sessions(id) ON DELETE SET NULL,
  role           TEXT NOT NULL CHECK (role IN ('user', 'assistant')),
  content        TEXT NOT NULL,
  word_count     INTEGER NOT NULL DEFAULT 0,
  has_search     BOOLEAN NOT NULL DEFAULT FALSE,
  created_at     TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- ── Memories ─────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS bot_memories (
  id             BIGSERIAL PRIMARY KEY,
  telegram_id    BIGINT NOT NULL,
  category       TEXT NOT NULL DEFAULT 'profile'
                   CHECK (category IN ('profile','professional','interests','preferences','goals')),
  key            TEXT NOT NULL,
  value          TEXT NOT NULL,
  updated_at     TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE (telegram_id, key)
);

-- ── Indexes ───────────────────────────────────────────────────
CREATE INDEX IF NOT EXISTS idx_messages_telegram_id  ON bot_messages(telegram_id);
CREATE INDEX IF NOT EXISTS idx_messages_created_at   ON bot_messages(created_at);
CREATE INDEX IF NOT EXISTS idx_messages_session_id   ON bot_messages(session_id);
CREATE INDEX IF NOT EXISTS idx_sessions_telegram_id  ON bot_sessions(telegram_id);
CREATE INDEX IF NOT EXISTS idx_sessions_last_activity ON bot_sessions(last_activity);
CREATE INDEX IF NOT EXISTS idx_memories_telegram_id  ON bot_memories(telegram_id);
CREATE INDEX IF NOT EXISTS idx_memories_category     ON bot_memories(category);
CREATE INDEX IF NOT EXISTS idx_users_last_seen       ON bot_users(last_seen);

-- ── Migrate: add columns if upgrading from old schema ─────────
ALTER TABLE bot_users ADD COLUMN IF NOT EXISTS language_code TEXT;
ALTER TABLE bot_users ADD COLUMN IF NOT EXISTS message_count INTEGER NOT NULL DEFAULT 0;
ALTER TABLE bot_users ADD COLUMN IF NOT EXISTS session_count INTEGER NOT NULL DEFAULT 0;
ALTER TABLE bot_messages ADD COLUMN IF NOT EXISTS session_id BIGINT REFERENCES bot_sessions(id) ON DELETE SET NULL;
ALTER TABLE bot_messages ADD COLUMN IF NOT EXISTS word_count INTEGER NOT NULL DEFAULT 0;
ALTER TABLE bot_messages ADD COLUMN IF NOT EXISTS has_search BOOLEAN NOT NULL DEFAULT FALSE;
ALTER TABLE bot_memories ADD COLUMN IF NOT EXISTS category TEXT NOT NULL DEFAULT 'profile'
  CHECK (category IN ('profile','professional','interests','preferences','goals'));
