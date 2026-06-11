# SmartAI Telegram Bot

A Telegram bot powered by **Llama 3.3** (via Groq) with:
- 🧠 **Long-term memory** — remembers facts about each user across sessions
- 🔍 **Web search** — fetches real-time information via Jina AI (no API key needed)
- 💾 **Supabase database** — stores chat history and memories
- 🤖 **AI tool-calling** — bot decides when to search the web automatically

## Setup

1. Copy `.env.example` and fill in your keys
2. Run SQL in `supabase-setup.sql` in your Supabase SQL Editor
3. `pnpm install`
4. `pnpm --filter @workspace/api-server run dev`

## Environment Variables

```
TELEGRAM_BOT_TOKEN=   # From @BotFather
GROQ_API_KEY=         # From console.groq.com
SUPABASE_URL=         # From Supabase project settings
SUPABASE_SERVICE_ROLE_KEY=  # From Supabase project settings
```

## Commands

- `/start` — Welcome message
- `/help` — Help and features
- `/memory` — View what the bot remembers about you
- `/forget` — Clear long-term memory
- `/clear` — Clear current conversation history
- `/stats` — Bot usage statistics
