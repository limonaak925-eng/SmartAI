import { Bot, Context } from "grammy";
import { logger } from "../lib/logger.js";
import { getAIResponse } from "./groq.js";
import {
  upsertUser,
  saveMessage,
  getHistory,
  clearHistory,
  getStats,
  checkTablesExist,
} from "./supabase.js";
import {
  getMemories,
  clearMemories,
  extractAndSaveMemories,
} from "./memory.js";

const token = process.env["TELEGRAM_BOT_TOKEN"];
if (!token) throw new Error("TELEGRAM_BOT_TOKEN is required");

const bot = new Bot(token);

async function trackUser(ctx: Context) {
  if (!ctx.from) return;
  await upsertUser(
    ctx.from.id,
    ctx.from.username,
    ctx.from.first_name,
    ctx.from.last_name
  );
}

bot.command("start", async (ctx) => {
  await trackUser(ctx);
  const name = ctx.from?.first_name ?? "друг";
  await ctx.reply(
    `👋 Привет, ${name}!\n\n` +
      `Я ИИ-ассистент на базе Llama 3.3 с памятью и поиском в интернете.\n\n` +
      `Команды:\n` +
      `/help — справка\n` +
      `/memory — посмотреть что я о тебе помню\n` +
      `/forget — стереть память о тебе\n` +
      `/clear — очистить историю диалога\n` +
      `/stats — статистика бота`
  );
});

bot.command("help", async (ctx) => {
  await ctx.reply(
    `Как пользоваться ботом:\n\n` +
      `Просто напишите любой вопрос — я отвечу!\n\n` +
      `Я умею:\n` +
      `• 🔍 Искать актуальную информацию в интернете\n` +
      `• 🧠 Запоминать факты о тебе между сессиями\n` +
      `• 💬 Помнить контекст текущего разговора\n` +
      `• ✍️ Писать тексты, помогать с кодом\n` +
      `• 🌐 Читать веб-страницы по ссылке\n` +
      `• 🔤 Переводить с любых языков\n\n` +
      `Команды:\n` +
      `/memory — посмотреть долгосрочную память\n` +
      `/forget — стереть всю память о тебе\n` +
      `/clear — очистить историю текущего диалога\n` +
      `/stats — статистика использования`
  );
});

bot.command("memory", async (ctx) => {
  await trackUser(ctx);
  if (!ctx.from) return;
  const memories = await getMemories(ctx.from.id);
  if (memories.length === 0) {
    await ctx.reply(
      "🧠 Моя долгосрочная память о тебе пуста.\n\nПросто пообщайся со мной — я сам запомню важное!"
    );
    return;
  }
  const lines = memories.map((m) => `• ${m.key}: ${m.value}`).join("\n");
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
  await ctx.reply("✅ История текущего диалога очищена. Начинаем заново!\n\n(Долгосрочная память сохранена. Для её очистки используй /forget)");
});

bot.command("stats", async (ctx) => {
  const stats = await getStats();
  await ctx.reply(
    `📊 Статистика бота:\n\n` +
      `👥 Пользователей: ${stats.users}\n` +
      `💬 Сообщений: ${stats.messages}`
  );
});

bot.on("message:text", async (ctx) => {
  await trackUser(ctx);
  const userText = ctx.message.text;
  const userId = ctx.from.id;

  const thinking = await ctx.reply("⏳ Думаю...");

  try {
    const [history, memories] = await Promise.all([
      getHistory(userId),
      getMemories(userId),
    ]);

    const { text: response, usedSearch } = await getAIResponse(
      history,
      userText,
      memories
    );

    const prefix = usedSearch ? "🔍 " : "";

    await Promise.all([
      saveMessage(userId, "user", userText),
      saveMessage(userId, "assistant", response),
    ]);

    // Extract and save new memories in background (don't await)
    extractAndSaveMemories(userId, userText, response).catch((err) =>
      logger.error({ err }, "Background memory extraction failed")
    );

    const finalText = prefix + response;
    try {
      await ctx.api.editMessageText(ctx.chat.id, thinking.message_id, finalText);
    } catch {
      // Edit failed (e.g. message too old or special chars) — send as new message
      await ctx.reply(finalText);
    }
  } catch (err) {
    logger.error({ err }, "Error handling message");
    try {
      await ctx.api.editMessageText(ctx.chat.id, thinking.message_id, "❌ Произошла ошибка. Попробуйте ещё раз.");
    } catch {
      await ctx.reply("❌ Произошла ошибка. Попробуйте ещё раз.");
    }
  }
});

bot.catch((err) => {
  logger.error({ err: err.error }, "Bot error");
});

export async function startBot() {
  const tablesOk = await checkTablesExist();
  if (!tablesOk) {
    logger.warn(
      "Supabase tables missing. Run supabase-setup.sql in Supabase SQL Editor."
    );
  }

  bot.start({
    allowed_updates: ["message", "callback_query"],
    onStart: () => logger.info("Telegram bot started (polling)"),
  });
}

export default bot;
