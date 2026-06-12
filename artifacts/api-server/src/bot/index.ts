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
  buildMISStatsReport,
  buildWeeklyReport,
  buildGlobalStatsMessage,
  generateDecisionSupport,
} from "./analytics.js";

const token = process.env["TELEGRAM_BOT_TOKEN"];
if (!token) throw new Error("TELEGRAM_BOT_TOKEN is required");

export const bot = new Bot(token);

// ─── Helpers ──────────────────────────────────────────────────────────────────

async function trackUser(ctx: Context): Promise<void> {
  if (!ctx.from) return;
  await upsertUser(
    ctx.from.id,
    ctx.from.username,
    ctx.from.first_name,
    ctx.from.last_name,
    ctx.from.language_code
  );
}

async function safeEdit(ctx: Context, msgId: number, text: string): Promise<void> {
  try {
    await ctx.api.editMessageText(ctx.chat!.id, msgId, text, { parse_mode: "Markdown" });
  } catch {
    try {
      await ctx.reply(text, { parse_mode: "Markdown" });
    } catch {
      await ctx.reply(text);
    }
  }
}

// ─── /start ───────────────────────────────────────────────────────────────────

bot.command("start", async (ctx) => {
  await trackUser(ctx);
  const name = ctx.from?.first_name ?? "друг";
  await ctx.reply(
    `👋 Привет, ${name}!\n\n` +
    `Я SmartAI — *Management Information System* в Telegram.\n` +
    `Анализирую твоё поведение, строю поведенческий профиль и даю рекомендации.\n\n` +
    `*Команды:*\n` +
    `/stats — MIS-отчёт: профиль, аналитика, тренды\n` +
    `/weekly — недельный отчёт + сравнение с прошлой неделей\n` +
    `/insights — Decision Support: персональные рекомендации\n` +
    `/memory — что система знает о тебе\n` +
    `/forget — сбросить профиль\n` +
    `/clear — очистить историю диалога\n` +
    `/help — подробная справка`,
    { parse_mode: "Markdown" }
  );
});

// ─── /help ────────────────────────────────────────────────────────────────────

bot.command("help", async (ctx) => {
  await ctx.reply(
    `*SmartAI — Behavioral MIS*\n\n` +
    `*Архитектура системы:*\n` +
    `Telegram → Supabase → Analytics → LLM → Insights\n\n` +
    `*Что умеет система:*\n` +
    `• 📊 Строить поведенческий профиль\n` +
    `• 📈 Отслеживать динамику активности\n` +
    `• 🧠 Запоминать факты между сессиями\n` +
    `• 💡 Давать data-driven рекомендации\n` +
    `• 🔍 Искать актуальную информацию\n` +
    `• 📋 Генерировать недельные MIS-отчёты\n\n` +
    `*Команды:*\n` +
    `/stats — полный MIS-дашборд\n` +
    `/weekly — недельный отчёт с аналитикой\n` +
    `/insights — Decision Support Layer\n` +
    `/memory — долгосрочный профиль пользователя\n` +
    `/forget — сброс профиля\n` +
    `/clear — очистка истории диалога\n` +
    `/globalstats — статистика всей системы`,
    { parse_mode: "Markdown" }
  );
});

// ─── /stats — MIS Report ──────────────────────────────────────────────────────

bot.command("stats", async (ctx) => {
  await trackUser(ctx);
  if (!ctx.from) return;
  const thinking = await ctx.reply("📊 Генерирую MIS-отчёт...");
  try {
    const memories = await getMemories(ctx.from.id);
    const text = await buildMISStatsReport(ctx.from.id, ctx.from.first_name, memories);
    await safeEdit(ctx, thinking.message_id, text);
  } catch (err) {
    logger.error({ err }, "stats command failed");
    await safeEdit(ctx, thinking.message_id, "❌ Не удалось загрузить отчёт.");
  }
});

// ─── /weekly — Weekly MIS Report ─────────────────────────────────────────────

bot.command("weekly", async (ctx) => {
  await trackUser(ctx);
  if (!ctx.from) return;
  const thinking = await ctx.reply("📋 Формирую недельный отчёт...");
  try {
    const text = await buildWeeklyReport(ctx.from.id, ctx.from.first_name);
    await safeEdit(ctx, thinking.message_id, text);
  } catch (err) {
    logger.error({ err }, "weekly command failed");
    await safeEdit(ctx, thinking.message_id, "❌ Не удалось сформировать недельный отчёт.");
  }
});

// ─── /insights — Decision Support Layer ──────────────────────────────────────

bot.command("insights", async (ctx) => {
  await trackUser(ctx);
  if (!ctx.from) return;
  const thinking = await ctx.reply("💡 Запускаю Decision Support Layer...");
  try {
    const text = await generateDecisionSupport(ctx.from.id, ctx.from.first_name);
    await safeEdit(ctx, thinking.message_id, text);
  } catch (err) {
    logger.error({ err }, "insights failed");
    await safeEdit(ctx, thinking.message_id, "❌ Не удалось запустить анализ.");
  }
});

// ─── /memory — User Profile ───────────────────────────────────────────────────

bot.command("memory", async (ctx) => {
  await trackUser(ctx);
  if (!ctx.from) return;
  const memories = await getMemories(ctx.from.id);
  if (memories.length === 0) {
    await ctx.reply("🧠 Профиль пуст. Пообщайся со мной — система автоматически построит твой профиль.");
    return;
  }
  const categoryEmoji: Record<string, string> = {
    profile: "👤",
    professional: "💼",
    interests: "🎯",
    preferences: "⚙️",
    goals: "🚀",
  };
  const categoryLabel: Record<string, string> = {
    profile: "ПРОФИЛЬ",
    professional: "ПРОФЕССИЯ",
    interests: "ИНТЕРЕСЫ",
    preferences: "ПРЕДПОЧТЕНИЯ",
    goals: "ЦЕЛИ",
  };
  const grouped: Record<string, string[]> = {};
  for (const m of memories) {
    (grouped[m.category] ??= []).push(`• ${m.value}`);
  }
  const lines = Object.entries(grouped)
    .map(([cat, items]) => `${categoryEmoji[cat] ?? "•"} *${categoryLabel[cat] ?? cat}*\n${items.join("\n")}`)
    .join("\n\n");
  await ctx.reply(
    `🧠 *Поведенческий профиль*\n━━━━━━━━━━━━━━\n\n${lines}`,
    { parse_mode: "Markdown" }
  );
});

// ─── /forget ──────────────────────────────────────────────────────────────────

bot.command("forget", async (ctx) => {
  await trackUser(ctx);
  if (!ctx.from) return;
  await clearMemories(ctx.from.id);
  await ctx.reply("🗑 Долгосрочный профиль сброшен. Система начнёт строить его заново.");
});

// ─── /clear ───────────────────────────────────────────────────────────────────

bot.command("clear", async (ctx) => {
  await trackUser(ctx);
  if (!ctx.from) return;
  await clearHistory(ctx.from.id);
  await ctx.reply(
    "✅ История диалога очищена.\n_(Поведенческий профиль сохранён. Для сброса — /forget)_",
    { parse_mode: "Markdown" }
  );
});

// ─── /globalstats ─────────────────────────────────────────────────────────────

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

// ─── Main message handler ─────────────────────────────────────────────────────
// Pipeline: Telegram → Supabase (save) → Analytics (context) → LLM → Response → Supabase (save)

bot.on("message:text", async (ctx) => {
  await trackUser(ctx);
  const userText = ctx.message.text;
  const userId = ctx.from.id;

  const thinking = await ctx.reply("⏳ Обрабатываю...");

  try {
    const [history, memories, sessionId] = await Promise.all([
      getHistory(userId),
      getMemories(userId),
      getOrCreateSession(userId),
    ]);

    void formatMemoriesForPrompt(memories);

    const { text: response, usedSearch } = await getAIResponse(history, userText, memories);

    await Promise.all([
      saveMessage(userId, "user", userText, sessionId, false),
      saveMessage(userId, "assistant", response, sessionId, usedSearch),
    ]);

    // Background: extract & save facts to user profile
    extractAndSaveMemories(userId, userText, response).catch((err) =>
      logger.warn({ err }, "extractAndSaveMemories failed (non-fatal)")
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

// ─── Resilient start with auto-restart ────────────────────────────────────────

export async function startBot(): Promise<void> {
  const tablesOk = await checkTablesExist();
  if (!tablesOk) {
    logger.warn("Supabase tables not ready — bot starts without DB persistence");
  }

  process.on("uncaughtException", (err) => {
    logger.error({ err }, "Uncaught exception — bot continues");
  });
  process.on("unhandledRejection", (reason) => {
    logger.error({ reason }, "Unhandled rejection — bot continues");
  });

  async function launchWithRetry(attempt = 1): Promise<void> {
    try {
      await bot.start({
        allowed_updates: ["message", "callback_query"],
        drop_pending_updates: true,
        onStart: (info) => logger.info({ username: info.username }, "Telegram bot started"),
      });
    } catch (err) {
      const grammyErr = err as { error_code?: number; message?: string };
      // 409 = another instance is already running — don't retry, let that one win
      if (grammyErr.error_code === 409) {
        logger.warn("Bot conflict (409) — another instance is running. This instance will not poll.");
        return;
      }
      const delay = Math.min(attempt * 5000, 60000);
      logger.error({ err, attempt, delay }, "Bot crashed — restarting");
      setTimeout(() => void launchWithRetry(attempt + 1), delay);
    }
  }

  void launchWithRetry();
}
