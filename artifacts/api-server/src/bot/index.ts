import { Bot, Context } from "grammy";
import { logger } from "../lib/logger.js";
import { getAIResponse } from "./groq.js";
import {
  upsertUser,
  saveMessage,
  getHistory,
  clearHistory,
  clearMemories,
  getMemories,
  getOrCreateSession,
  checkTablesExist,
  formatMemoriesForPrompt,
} from "./db.js";
import { extractAndSaveMemories } from "./memory.js";
import {
  buildUserStatsMessage,
  buildGlobalStatsMessage,
  generateUserInsights,
} from "./analytics.js";

const token = process.env["TELEGRAM_BOT_TOKEN"];
if (!token) throw new Error("TELEGRAM_BOT_TOKEN is required");

export const bot = new Bot(token);

// ─── Helpers ──────────────────────────────────────────────────────────────────

async function trackUser(ctx: Context) {
  if (!ctx.from) return;
  await upsertUser(
    ctx.from.id,
    ctx.from.username,
    ctx.from.first_name,
    ctx.from.last_name,
    ctx.from.language_code
  );
}

async function safeEdit(ctx: Context, msgId: number, text: string) {
  try {
    await ctx.api.editMessageText(ctx.chat!.id, msgId, text);
  } catch {
    await ctx.reply(text);
  }
}

// ─── Commands ─────────────────────────────────────────────────────────────────

bot.command("start", async (ctx) => {
  await trackUser(ctx);
  const name = ctx.from?.first_name ?? "друг";
  await ctx.reply(
    `👋 Привет, ${name}!\n\n` +
    `Я ИИ-ассистент на базе Llama 3.3 с памятью и поиском в интернете.\n\n` +
    `Команды:\n` +
    `/help — справка\n` +
    `/stats — твоя статистика и профиль\n` +
    `/insights — персональные инсайты\n` +
    `/memory — что я о тебе помню\n` +
    `/forget — стереть память\n` +
    `/clear — очистить историю диалога`
  );
});

bot.command("help", async (ctx) => {
  await ctx.reply(
    `Как пользоваться ботом:\n\n` +
    `Просто напиши любой вопрос — я отвечу!\n\n` +
    `Я умею:\n` +
    `• 🔍 Искать актуальную информацию в интернете\n` +
    `• 🧠 Запоминать факты о тебе между сессиями\n` +
    `• 💬 Помнить контекст текущего разговора\n` +
    `• ✍️ Писать тексты, помогать с кодом\n` +
    `• 🌐 Читать веб-страницы по ссылке\n` +
    `• 📊 Показывать твою аналитику\n\n` +
    `Команды:\n` +
    `/stats — статистика, активность, профиль\n` +
    `/insights — персональные инсайты на основе истории\n` +
    `/memory — посмотреть долгосрочную память\n` +
    `/forget — стереть всю память о тебе\n` +
    `/clear — очистить историю текущего диалога`
  );
});

bot.command("stats", async (ctx) => {
  await trackUser(ctx);
  if (!ctx.from) return;
  const thinking = await ctx.reply("📊 Собираю статистику...");
  try {
    const memories = await getMemories(ctx.from.id);
    const text = await buildUserStatsMessage(ctx.from.id, ctx.from.first_name, memories);
    await safeEdit(ctx, thinking.message_id, text);
  } catch (err) {
    logger.error({ err }, "stats command failed");
    await safeEdit(ctx, thinking.message_id, "❌ Не удалось загрузить статистику.");
  }
});

bot.command("globalstats", async (ctx) => {
  const thinking = await ctx.reply("📊 Загружаю...");
  try {
    const text = await buildGlobalStatsMessage();
    await safeEdit(ctx, thinking.message_id, text);
  } catch (err) {
    logger.error({ err }, "globalstats failed");
    await safeEdit(ctx, thinking.message_id, "❌ Ошибка загрузки.");
  }
});

bot.command("insights", async (ctx) => {
  await trackUser(ctx);
  if (!ctx.from) return;
  const thinking = await ctx.reply("💡 Анализирую твою историю...");
  try {
    const insights = await generateUserInsights(ctx.from.id, ctx.from.first_name);
    await safeEdit(ctx, thinking.message_id, `💡 Персональные инсайты:\n\n${insights}`);
  } catch (err) {
    logger.error({ err }, "insights failed");
    await safeEdit(ctx, thinking.message_id, "❌ Не удалось сгенерировать инсайты.");
  }
});

bot.command("memory", async (ctx) => {
  await trackUser(ctx);
  if (!ctx.from) return;
  const memories = await getMemories(ctx.from.id);
  if (memories.length === 0) {
    await ctx.reply("🧠 Моя память о тебе пуста. Просто пообщайся — я сам запомню важное!");
    return;
  }
  const grouped: Record<string, string[]> = {};
  for (const m of memories) {
    (grouped[m.category] ??= []).push(`• ${m.key}: ${m.value}`);
  }
  const categoryEmoji: Record<string, string> = {
    profile: "👤",
    professional: "💼",
    interests: "🎯",
    preferences: "⚙️",
    goals: "🚀",
  };
  const lines = Object.entries(grouped)
    .map(([cat, items]) => `${categoryEmoji[cat] ?? "•"} ${cat.toUpperCase()}\n${items.join("\n")}`)
    .join("\n\n");
  await ctx.reply(`🧠 Что я о тебе помню:\n\n${lines}`);
});

bot.command("forget", async (ctx) => {
  await trackUser(ctx);
  if (!ctx.from) return;
  await clearMemories(ctx.from.id);
  await ctx.reply("🗑 Долгосрочная память о тебе стёрта.");
});

bot.command("clear", async (ctx) => {
  await trackUser(ctx);
  if (!ctx.from) return;
  await clearHistory(ctx.from.id);
  await ctx.reply(
    "✅ История диалога очищена. Начинаем заново!\n\n" +
    "(Долгосрочная память сохранена. Для её очистки — /forget)"
  );
});

// ─── Main message handler ─────────────────────────────────────────────────────

bot.on("message:text", async (ctx) => {
  await trackUser(ctx);
  const userText = ctx.message.text;
  const userId = ctx.from.id;

  const thinking = await ctx.reply("⏳ Думаю...");

  try {
    const [history, memories, sessionId] = await Promise.all([
      getHistory(userId),
      getMemories(userId),
      getOrCreateSession(userId),
    ]);

    const memoryPrompt = formatMemoriesForPrompt(memories);
    const { text: response, usedSearch } = await getAIResponse(history, userText, memories);
    void memoryPrompt;

    await Promise.all([
      saveMessage(userId, "user", userText, sessionId, false),
      saveMessage(userId, "assistant", response, sessionId, usedSearch),
    ]);

    // Background: extract memories & update message count
    extractAndSaveMemories(userId, userText, response).catch((err) =>
      logger.error({ err }, "extractAndSaveMemories failed")
    );

    const prefix = usedSearch ? "🔍 " : "";
    await safeEdit(ctx, thinking.message_id, prefix + response);
  } catch (err) {
    logger.error({ err }, "message handler failed");
    await safeEdit(ctx, thinking.message_id, "❌ Произошла ошибка. Попробуйте ещё раз.");
  }
});

// ─── Error handler ────────────────────────────────────────────────────────────

bot.catch((err) => {
  logger.error({ err: err.error }, "grammY bot error");
});

// ─── Resilient start with auto-restart ───────────────────────────────────────

export async function startBot(): Promise<void> {
  const tablesOk = await checkTablesExist();
  if (!tablesOk) {
    logger.warn("Supabase tables missing — run supabase-setup.sql. Bot starts without DB.");
  }

  // Catch any unhandled errors to prevent process crash
  process.on("uncaughtException", (err) => {
    logger.error({ err }, "Uncaught exception — bot continues");
  });
  process.on("unhandledRejection", (reason) => {
    logger.error({ reason }, "Unhandled rejection — bot continues");
  });

  async function launchWithRetry(attempt = 1) {
    try {
      await bot.start({
        allowed_updates: ["message", "callback_query"],
        onStart: (info) => logger.info({ username: info.username }, "Telegram bot started"),
      });
    } catch (err) {
      const delay = Math.min(attempt * 5000, 60000);
      logger.error({ err, attempt, delay }, "Bot crashed — restarting");
      setTimeout(() => launchWithRetry(attempt + 1), delay);
    }
  }

  launchWithRetry();
}
