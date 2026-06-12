import Groq from "groq-sdk";
import { logger } from "../lib/logger.js";
import {
  getUserAnalytics,
  getMemories,
  getGlobalStats,
  getWeeklyComparison,
  type Memory,
  type UserAnalytics,
  type WeeklyComparison,
} from "./db.js";

const groq = new Groq({ apiKey: process.env["GROQ_API_KEY"]! });

// ─── Constants ─────────────────────────────────────────────────────────────────

const DAY_NAMES_RU = ["вс", "пн", "вт", "ср", "чт", "пт", "сб"];
const DAY_NAMES_FULL = ["воскресенье", "понедельник", "вторник", "среда", "четверг", "пятница", "суббота"];

// ─── Pure data computations (no LLM) ──────────────────────────────────────────

interface ActivityPatterns {
  peakHour: number | null;
  peakHourShare: number;
  peakDay: string | null;
  isEarlyBird: boolean;       // peak 6-11
  isNightOwl: boolean;        // peak 21-4
  isAfternoonUser: boolean;   // peak 12-17
  consistencyScore: number;   // 0-100: how many of last 7 days were active
  avgMsgLength: number;
  usesSearch: boolean;
}

function computeActivityPatterns(analytics: UserAnalytics): ActivityPatterns {
  const peakHourEntry = analytics.hourlyActivity[0];
  const peakHour = peakHourEntry?.hour ?? null;
  const totalHourlyMsgs = analytics.hourlyActivity.reduce((s, h) => s + h.count, 0);
  const peakHourShare = totalHourlyMsgs > 0 && peakHourEntry
    ? Math.round((peakHourEntry.count / totalHourlyMsgs) * 100)
    : 0;

  const peakDayEntry = [...analytics.dailyActivity].sort((a, b) => b.count - a.count)[0];
  const peakDay = peakDayEntry
    ? (DAY_NAMES_FULL[new Date(peakDayEntry.date).getDay()] ?? null)
    : null;

  const isEarlyBird = peakHour !== null && peakHour >= 6 && peakHour <= 11;
  const isNightOwl = peakHour !== null && (peakHour >= 21 || peakHour <= 4);
  const isAfternoonUser = peakHour !== null && peakHour >= 12 && peakHour <= 17;

  const activeDays = analytics.dailyActivity.filter((d) => d.count > 0).length;
  const consistencyScore = Math.round((activeDays / 7) * 100);

  const avgMsgLength = analytics.recentMessages.length > 0
    ? Math.round(analytics.recentMessages.join(" ").length / analytics.recentMessages.length)
    : 0;

  return {
    peakHour,
    peakHourShare,
    peakDay,
    isEarlyBird,
    isNightOwl,
    isAfternoonUser,
    consistencyScore,
    avgMsgLength,
    usesSearch: analytics.searchCount > 0,
  };
}

// ─── Hardcoded insight templates (always reliable, no LLM needed) ───────────
// These are the 3 example insights for the portfolio — pattern-based, data-driven

function buildHardcodedInsights(
  patterns: ActivityPatterns,
  analytics: UserAnalytics,
  weekly: WeeklyComparison
): string[] {
  const insights: string[] = [];

  // INSIGHT 1 — Activity-by-time pattern
  if (patterns.peakHour !== null) {
    const period = patterns.isEarlyBird
      ? "утренние часы — признак высокой продуктивности в начале дня"
      : patterns.isAfternoonUser
      ? "послеобеденное время — типично для студентов и работников умственного труда"
      : patterns.isNightOwl
      ? "ночное время — возможно, требуется корректировка режима для лучшего результата"
      : "дневные часы";

    insights.push(
      `⏰ Пик активности: ${patterns.peakHour}:00 (${patterns.peakHourShare}% запросов). Это ${period}.`
    );
  }

  // INSIGHT 2 — Behavioral change (week-over-week)
  if (weekly.lastWeek.count > 0) {
    const arrow = weekly.trend === "up" ? "↑" : weekly.trend === "down" ? "↓" : "→";
    const desc =
      weekly.trend === "up"
        ? `рост активности на ${Math.abs(weekly.changePercent)}% — положительная динамика`
        : weekly.trend === "down"
        ? `снижение активности на ${Math.abs(weekly.changePercent)}% — стоит вернуться к регулярной работе`
        : "стабильная активность — хороший признак устойчивой привычки";
    insights.push(
      `${arrow} Динамика за неделю: ${desc}. Эта неделя: ${weekly.thisWeek.count} сообщ., прошлая: ${weekly.lastWeek.count}.`
    );
  } else if (weekly.thisWeek.count > 0) {
    insights.push(
      `📊 Это ваша первая неделя в системе: ${weekly.thisWeek.count} сообщений — отличный старт!`
    );
  }

  // INSIGHT 3 — Consistency and engagement score
  if (patterns.consistencyScore >= 70) {
    insights.push(
      `✅ Индекс регулярности: ${patterns.consistencyScore}% — вы активны большинство дней. Это ключевой показатель эффективного использования системы.`
    );
  } else if (patterns.consistencyScore >= 30) {
    insights.push(
      `📈 Индекс регулярности: ${patterns.consistencyScore}% — потенциал для роста. Ежедневное взаимодействие с системой повышает эффективность обучения.`
    );
  } else if (analytics.recentMessages.length > 0) {
    insights.push(
      `💡 Индекс регулярности: ${patterns.consistencyScore}%. Рекомендация: установите ежедневное время для работы с системой — это повысит продуктивность.`
    );
  }

  return insights;
}

// ─── LLM-powered Decision Support (uses ONLY real data, no guessing) ──────────

async function generateLLMInsights(
  firstName: string,
  analytics: UserAnalytics,
  memories: Memory[],
  patterns: ActivityPatterns,
  weekly: WeeklyComparison
): Promise<string> {
  const memoryStr = memories.length > 0
    ? memories.map((m) => `${m.key}: ${m.value}`).join("; ")
    : "нет сохранённых данных";

  const sampleMessages = analytics.recentMessages
    .slice(0, 15)
    .map((m, i) => `${i + 1}. "${m.slice(0, 80)}"`)
    .join("\n");

  const prompt = `Ты — аналитик данных MIS (Management Information System). Твоя задача — интерпретировать ТОЛЬКО предоставленные данные, никаких предположений.

ДАННЫЕ ПОЛЬЗОВАТЕЛЯ "${firstName}":
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
📊 Статистика:
- Всего сообщений: ${analytics.messageCount}
- Сессий: ${analytics.sessionCount}
- Средняя длина сообщения: ${patterns.avgMsgLength} символов
- Использует поиск: ${patterns.usesSearch ? "да" : "нет"}

⏰ Паттерны активности:
- Пиковый час: ${patterns.peakHour !== null ? `${patterns.peakHour}:00 (${patterns.peakHourShare}% запросов)` : "недостаточно данных"}
- Пиковый день: ${patterns.peakDay ?? "недостаточно данных"}
- Утренник: ${patterns.isEarlyBird ? "да" : "нет"} | Вечерник: ${patterns.isNightOwl ? "да" : "нет"}
- Индекс регулярности: ${patterns.consistencyScore}%

📅 Динамика:
- Эта неделя: ${weekly.thisWeek.count} сообщ., ${weekly.thisWeek.sessions} сессий
- Прошлая неделя: ${weekly.lastWeek.count} сообщ., ${weekly.lastWeek.sessions} сессий
- Изменение: ${weekly.changePercent > 0 ? "+" : ""}${weekly.changePercent}%

🧠 Известно о пользователе: ${memoryStr}

📝 Последние запросы (выборка):
${sampleMessages || "нет данных"}

━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
Дай 2 конкретных аналитических вывода на основе ТОЛЬКО этих данных. Каждый начинается с эмодзи. Максимум 2 предложения каждый. На русском языке.`;

  const completion = await groq.chat.completions.create({
    model: "llama-3.1-8b-instant",
    messages: [{ role: "user", content: prompt }],
    max_tokens: 250,
    temperature: 0.4,
  });

  return completion.choices[0]?.message?.content?.trim() ?? "";
}

// ─── Decision Support Layer — main entry point ────────────────────────────────
// Architecture: Telegram → Supabase → Analytics → LLM → Insights

export async function generateDecisionSupport(
  telegramId: number,
  firstName: string
): Promise<string> {
  const [analytics, memories, weekly] = await Promise.all([
    getUserAnalytics(telegramId),
    getMemories(telegramId),
    getWeeklyComparison(telegramId),
  ]);

  const patterns = computeActivityPatterns(analytics);
  const hardcoded = buildHardcodedInsights(patterns, analytics, weekly);

  if (analytics.recentMessages.length < 2) {
    return (
      "💡 *Decision Support* — недостаточно данных для полного анализа.\n\n" +
      "Начни пользоваться ботом регулярно, и система построит твой поведенческий профиль.\n\n" +
      (hardcoded.length > 0 ? hardcoded.join("\n\n") : "")
    );
  }

  try {
    const llmInsights = await generateLLMInsights(firstName, analytics, memories, patterns, weekly);

    return (
      `🧠 *Decision Support Report* — ${firstName}\n` +
      `━━━━━━━━━━━━━━━━━━━━\n\n` +
      `📊 *Паттерны поведения:*\n` +
      hardcoded.join("\n\n") +
      `\n\n🤖 *AI-интерпретация данных:*\n` +
      llmInsights
    );
  } catch (err) {
    logger.error({ err }, "LLM insights failed, using hardcoded only");
    return (
      `🧠 *Decision Support Report* — ${firstName}\n\n` +
      hardcoded.join("\n\n")
    );
  }
}

// ─── MIS Stats Report ──────────────────────────────────────────────────────────
// Clean data-driven report: no numbers without context

export async function buildMISStatsReport(
  telegramId: number,
  firstName: string,
  memories: Memory[]
): Promise<string> {
  const [analytics, weekly] = await Promise.all([
    getUserAnalytics(telegramId),
    getWeeklyComparison(telegramId),
  ]);

  const patterns = computeActivityPatterns(analytics);

  // User profile block
  const profileFacts = memories
    .filter((m) => ["profile", "professional"].includes(m.category))
    .map((m) => m.value)
    .slice(0, 3);
  const profileLine = profileFacts.length > 0 ? profileFacts.join(" · ") : "профиль формируется";

  const interestFacts = memories
    .filter((m) => m.category === "interests")
    .map((m) => m.value)
    .slice(0, 4);
  const interests = interestFacts.length > 0 ? interestFacts.join(", ") : "ещё определяются";

  const goalFacts = memories
    .filter((m) => m.category === "goals")
    .map((m) => m.value)
    .slice(0, 2);

  // Activity bar chart
  const maxCount = Math.max(...analytics.dailyActivity.map((d) => d.count), 1);
  const activityChart = analytics.dailyActivity.length > 0
    ? analytics.dailyActivity
        .map((d) => {
          const dayName = DAY_NAMES_RU[new Date(d.date).getDay()] ?? "?";
          const bars = Math.round((d.count / maxCount) * 6);
          return `${dayName} ${"█".repeat(bars)}${"░".repeat(6 - bars)} ${d.count}`;
        })
        .join("\n")
    : "нет данных за последние 7 дней";

  // Peak hours
  const peakHoursStr = analytics.hourlyActivity.length > 0
    ? analytics.hourlyActivity
        .slice(0, 3)
        .map((h) => `${h.hour}:00 (${Math.round((h.count / analytics.recentMessages.length) * 100)}%)`)
        .join("  ")
    : "нет данных";

  // Trend indicator
  const trendArrow = weekly.trend === "up" ? `↑ +${weekly.changePercent}%` : weekly.trend === "down" ? `↓ ${weekly.changePercent}%` : "→ стабильно";
  const trendLabel = weekly.lastWeek.count > 0
    ? `${trendArrow} vs прошлая неделя`
    : "первая неделя";

  // Consistency badge
  const consistencyBadge =
    patterns.consistencyScore >= 70 ? "🟢 Высокая"
    : patterns.consistencyScore >= 40 ? "🟡 Средняя"
    : "🔴 Низкая";

  // Chronotype
  const chronotype = patterns.isEarlyBird
    ? "🌅 Жаворонок"
    : patterns.isNightOwl
    ? "🌙 Сова"
    : patterns.isAfternoonUser
    ? "☀️ Дневной тип"
    : "📊 Смешанный";

  const memberSince = analytics.firstSeen
    ? new Date(analytics.firstSeen).toLocaleDateString("ru", { day: "numeric", month: "long", year: "numeric" })
    : "неизвестно";

  const todayCount = analytics.dailyActivity.at(-1)?.count ?? 0;

  let report =
    `📊 MIS REPORT — ${firstName}\n` +
    `━━━━━━━━━━━━━━━━━━━━\n\n` +
    `👤 ПРОФИЛЬ ПОЛЬЗОВАТЕЛЯ\n` +
    `${profileLine}\n`;

  if (goalFacts.length > 0) {
    report += `🎯 Цели: ${goalFacts.join(", ")}\n`;
  }

  report +=
    `\n📈 ПОВЕДЕНЧЕСКАЯ АНАЛИТИКА\n` +
    `Сообщений: ${analytics.messageCount}  |  Сессий: ${analytics.sessionCount}\n` +
    `Слов написано: ${analytics.totalWords.toLocaleString("ru")}\n` +
    `Сегодня: ${todayCount} сообщ.  |  В боте с: ${memberSince}\n` +
    `Тренд: ${trendLabel}\n\n` +
    `📅 АКТИВНОСТЬ (последние 7 дней)\n` +
    `${activityChart}\n\n` +
    `⏰ ВРЕМЕННОЙ ПРОФИЛЬ\n` +
    `Хронотип: ${chronotype}\n` +
    `Пиковые часы: ${peakHoursStr}\n` +
    `Регулярность: ${consistencyBadge} (${patterns.consistencyScore}% дней)\n\n` +
    `🎯 ИНТЕРЕСЫ И ТЕМЫ\n` +
    `${interests}`;

  if (analytics.searchCount > 0) {
    report += `\n🔍 Использовал поиск: ${analytics.searchCount} раз`;
  }

  return report;
}

// ─── Weekly MIS Report ─────────────────────────────────────────────────────────

export async function buildWeeklyReport(
  telegramId: number,
  firstName: string
): Promise<string> {
  const [analytics, memories, weekly] = await Promise.all([
    getUserAnalytics(telegramId),
    getMemories(telegramId),
    getWeeklyComparison(telegramId),
  ]);

  const patterns = computeActivityPatterns(analytics);

  // Date ranges
  const now = new Date();
  const thisWeekStart = new Date(now);
  thisWeekStart.setDate(now.getDate() - now.getDay() + (now.getDay() === 0 ? -6 : 1));
  const lastWeekStart = new Date(thisWeekStart);
  lastWeekStart.setDate(lastWeekStart.getDate() - 7);

  const fmtDate = (d: Date) =>
    d.toLocaleDateString("ru", { day: "numeric", month: "short" });
  const thisWeekRange = `${fmtDate(thisWeekStart)} — ${fmtDate(now)}`;
  const lastWeekEnd = new Date(thisWeekStart);
  lastWeekEnd.setDate(lastWeekEnd.getDate() - 1);
  const lastWeekRange = `${fmtDate(lastWeekStart)} — ${fmtDate(lastWeekEnd)}`;

  // Day-by-day chart for this week
  const maxCount = Math.max(...weekly.thisWeek.byDay.map((d) => d.count), 1);
  const dayChart = weekly.thisWeek.byDay.length > 0
    ? weekly.thisWeek.byDay
        .map((d) => {
          const dayName = DAY_NAMES_RU[new Date(d.date).getDay()] ?? "?";
          const bars = Math.round((d.count / maxCount) * 6);
          return `${dayName} ${"█".repeat(bars)}${"░".repeat(6 - bars)} ${d.count}`;
        })
        .join("\n")
    : "активности не зафиксировано";

  // Change indicators
  const trendIcon = weekly.trend === "up" ? "📈" : weekly.trend === "down" ? "📉" : "📊";
  const changeStr = weekly.lastWeek.count > 0
    ? `${weekly.changePercent > 0 ? "+" : ""}${weekly.changePercent}% ${weekly.trend === "up" ? "рост" : weekly.trend === "down" ? "снижение" : "стабильно"} vs прошлая неделя`
    : "первая неделя в системе";

  // Interests from memory
  const interestStr = memories
    .filter((m) => m.category === "interests")
    .map((m) => m.value)
    .slice(0, 5)
    .join(", ") || "определяются";

  // Hardcoded insights
  const hardcoded = buildHardcodedInsights(patterns, analytics, weekly);

  let report =
    `📋 WEEKLY MIS REPORT — ${firstName}\n` +
    `━━━━━━━━━━━━━━━━━━━━━━━━━━\n\n` +
    `📅 ЭТА НЕДЕЛЯ (${thisWeekRange})\n` +
    `Сообщений: ${weekly.thisWeek.count}  |  Сессий: ${weekly.thisWeek.sessions}\n` +
    `Среднее в день: ${weekly.thisWeek.avgPerDay}\n\n` +
    `📅 ПРОШЛАЯ НЕДЕЛЯ (${lastWeekRange})\n` +
    `Сообщений: ${weekly.lastWeek.count}  |  Сессий: ${weekly.lastWeek.sessions}\n` +
    `Среднее в день: ${weekly.lastWeek.avgPerDay}\n\n` +
    `${trendIcon} СРАВНЕНИЕ\n` +
    `${changeStr}\n\n` +
    `📊 АКТИВНОСТЬ ПО ДНЯМ\n` +
    `${dayChart}\n\n` +
    `🎯 ТЕМЫ ЭТОЙ НЕДЕЛИ\n` +
    `${interestStr}\n\n` +
    `💡 DECISION SUPPORT\n`;

  if (hardcoded.length > 0) {
    report += hardcoded.join("\n\n");
  } else {
    report += "Накапливаю данные для анализа...";
  }

  // LLM summary if enough data
  if (weekly.thisWeek.count >= 3) {
    try {
      const topMessages = analytics.recentMessages.slice(0, 10).join(" | ");
      const prompt = `Дай один короткий (2-3 предложения) вывод для недельного MIS-отчёта пользователя ${firstName}.

Данные:
- Эта неделя: ${weekly.thisWeek.count} сообщений, ${weekly.thisWeek.sessions} сессий
- Прошлая неделя: ${weekly.lastWeek.count} сообщений
- Изменение: ${weekly.changePercent}%
- Хронотип: ${patterns.isEarlyBird ? "жаворонок" : patterns.isNightOwl ? "сова" : "дневной"}
- Регулярность: ${patterns.consistencyScore}%
- Темы запросов: ${topMessages.slice(0, 200)}

Только на основе этих данных. Один абзац, начни с эмодзи 🧩.`;

      const completion = await groq.chat.completions.create({
        model: "llama-3.1-8b-instant",
        messages: [{ role: "user", content: prompt }],
        max_tokens: 150,
        temperature: 0.4,
      });

      const summary = completion.choices[0]?.message?.content?.trim();
      if (summary) report += `\n\n${summary}`;
    } catch (err) {
      logger.warn({ err }, "Weekly LLM summary failed (non-fatal)");
    }
  }

  return report;
}

// ─── Global Admin Stats ────────────────────────────────────────────────────────

export async function buildGlobalStatsMessage(): Promise<string> {
  const stats = await getGlobalStats();
  return (
    `📊 GLOBAL MIS STATS\n` +
    `━━━━━━━━━━━━━━━━━\n\n` +
    `👥 Пользователей: ${stats.totalUsers}\n` +
    `💬 Всего сообщений: ${stats.totalMessages}\n` +
    `🔄 Всего сессий: ${stats.totalSessions}\n\n` +
    `📅 Сегодня:\n` +
    `• Активных: ${stats.todayUsers}\n` +
    `• Сообщений: ${stats.todayMessages}\n\n` +
    `Архитектура: Telegram → Supabase → Analytics → LLM → Insights`
  );
}
