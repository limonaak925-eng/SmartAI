import Groq from "groq-sdk";
import { logger } from "../lib/logger.js";
import { getUserAnalytics, getMemories, getGlobalStats, type Memory } from "./db.js";

const groq = new Groq({ apiKey: process.env["GROQ_API_KEY"]! });

// ─── AI insight generation ─────────────────────────────────────────────────────

export async function generateUserInsights(
  telegramId: number,
  firstName: string
): Promise<string> {
  const [analytics, memories] = await Promise.all([
    getUserAnalytics(telegramId),
    getMemories(telegramId),
  ]);

  if (analytics.recentMessages.length < 3) {
    return "💡 Пообщайся со мной немного больше — и я дам персональные инсайты о твоих привычках!";
  }

  const memoryStr = memories.length > 0
    ? memories.map((m: Memory) => `${m.key}: ${m.value}`).join(", ")
    : "нет данных";

  const prompt = `Ты аналитик данных. Проанализируй поведение пользователя ${firstName} в Telegram-боте и дай 2-3 коротких инсайта (каждый с эмодзи). Будь конкретным и интересным.

Данные пользователя:
- Всего сообщений: ${analytics.messageCount}
- Сессий: ${analytics.sessionCount}
- Зарегистрирован: ${analytics.firstSeen ? new Date(analytics.firstSeen).toLocaleDateString("ru") : "неизвестно"}
- Самые активные часы: ${analytics.hourlyActivity.map(h => `${h.hour}:00`).join(", ")}
- Активность за последние дни: ${analytics.dailyActivity.map(d => `${d.date}: ${d.count} сообщ.`).join(", ")}
- Что о нём известно: ${memoryStr}
- Последние сообщения (выборка): ${analytics.recentMessages.slice(0, 10).join(" | ")}

Напиши 2-3 инсайта на русском языке. Каждый с новой строки, начинается с эмодзи. Максимум 2 предложения каждый.`;

  try {
    const completion = await groq.chat.completions.create({
      model: "llama-3.1-8b-instant",
      messages: [{ role: "user", content: prompt }],
      max_tokens: 300,
      temperature: 0.7,
    });
    return completion.choices[0]?.message?.content ?? "Не удалось сгенерировать инсайты.";
  } catch (err) {
    logger.error({ err }, "Failed to generate insights");
    return "Не удалось сгенерировать инсайты.";
  }
}

export async function generateTopics(messages: string[]): Promise<string> {
  if (messages.length < 5) return "мало данных";
  const sample = messages.slice(0, 30).join(" | ");
  try {
    const completion = await groq.chat.completions.create({
      model: "llama-3.1-8b-instant",
      messages: [{
        role: "user",
        content: `Определи 3-5 главных тем из этих сообщений пользователя. Верни только список через запятую, без пояснений. Сообщения: ${sample}`,
      }],
      max_tokens: 60,
      temperature: 0.3,
    });
    return completion.choices[0]?.message?.content?.trim() ?? "разные темы";
  } catch {
    return "разные темы";
  }
}

// ─── Format stats for user ─────────────────────────────────────────────────────

const DAY_NAMES = ["вс", "пн", "вт", "ср", "чт", "пт", "сб"];

export async function buildUserStatsMessage(
  telegramId: number,
  firstName: string,
  memories: Memory[]
): Promise<string> {
  const analytics = await getUserAnalytics(telegramId);

  // Build profile line from memories
  const profileFacts = memories
    .filter((m) => ["profile", "professional"].includes(m.category))
    .map((m) => m.value)
    .slice(0, 3);
  const profileLine = profileFacts.length > 0 ? profileFacts.join(", ") : "пока не заполнен";

  // Daily activity bar chart (last 7 days)
  const maxCount = Math.max(...analytics.dailyActivity.map((d) => d.count), 1);
  const activityBar = analytics.dailyActivity
    .map((d) => {
      const dayName = DAY_NAMES[new Date(d.date).getDay()] ?? "?";
      const bars = Math.round((d.count / maxCount) * 5);
      return `${dayName} ${"█".repeat(bars)}${"░".repeat(5 - bars)} ${d.count}`;
    })
    .join("\n");

  // Peak hours
  const peakHours = analytics.hourlyActivity.length > 0
    ? analytics.hourlyActivity.map((h) => `${h.hour}:00`).join(", ")
    : "нет данных";

  // Topics (lightweight — from interests memories)
  const interestMemories = memories
    .filter((m) => m.category === "interests")
    .map((m) => m.value)
    .join(", ");
  const topics = interestMemories || "ещё определяются";

  // First seen
  const memberSince = analytics.firstSeen
    ? new Date(analytics.firstSeen).toLocaleDateString("ru", { day: "numeric", month: "long", year: "numeric" })
    : "неизвестно";

  const todayCount = analytics.dailyActivity.at(-1)?.count ?? 0;

  return (
    `👤 Профиль: ${firstName}\n` +
    `📝 ${profileLine}\n\n` +
    `📊 Статистика:\n` +
    `💬 Сообщений: ${analytics.messageCount} (сегодня: ${todayCount})\n` +
    `🔄 Сессий: ${analytics.sessionCount}\n` +
    `📅 В боте с: ${memberSince}\n\n` +
    `📈 Активность (последние 7 дней):\n${activityBar || "нет данных"}\n\n` +
    `⏰ Пик активности: ${peakHours}\n` +
    `🎯 Интересы: ${topics}`
  );
}

// ─── Global admin stats ────────────────────────────────────────────────────────

export async function buildGlobalStatsMessage(): Promise<string> {
  const stats = await getGlobalStats();
  return (
    `📊 Глобальная статистика бота:\n\n` +
    `👥 Пользователей: ${stats.totalUsers}\n` +
    `💬 Сообщений: ${stats.totalMessages}\n` +
    `🔄 Сессий: ${stats.totalSessions}\n\n` +
    `📅 Сегодня:\n` +
    `• Активных пользователей: ${stats.todayUsers}\n` +
    `• Сообщений: ${stats.todayMessages}`
  );
}
