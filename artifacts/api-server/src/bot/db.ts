import { createClient } from "@supabase/supabase-js";
import { logger } from "../lib/logger.js";

const supabaseUrl = process.env["SUPABASE_URL"];
const supabaseKey = process.env["SUPABASE_SERVICE_ROLE_KEY"];
if (!supabaseUrl || !supabaseKey) throw new Error("SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY are required");

export const supabase = createClient(supabaseUrl, supabaseKey);

// ─── Types ────────────────────────────────────────────────────────────────────

export interface DbUser {
  telegram_id: number;
  username?: string | null;
  first_name: string;
  last_name?: string | null;
  language_code?: string | null;
  message_count: number;
  session_count: number;
  last_seen: string;
  created_at: string;
}

export interface DbSession {
  id: number;
  telegram_id: number;
  started_at: string;
  last_activity: string;
  message_count: number;
}

export interface DbMessage {
  id: number;
  telegram_id: number;
  session_id: number | null;
  role: "user" | "assistant";
  content: string;
  word_count: number;
  has_search: boolean;
  created_at: string;
}

export interface DbMemory {
  telegram_id: number;
  category: "profile" | "professional" | "interests" | "preferences" | "goals";
  key: string;
  value: string;
  updated_at: string;
}

export interface Memory {
  key: string;
  value: string;
  category: string;
}

// ─── Health check ─────────────────────────────────────────────────────────────

export async function checkTablesExist(): Promise<boolean> {
  const { error } = await supabase.from("bot_users").select("telegram_id").limit(1);
  if (error) {
    logger.warn({ err: error }, "Tables not ready yet — bot will work without DB");
    return false;
  }
  return true;
}

// ─── Users ────────────────────────────────────────────────────────────────────

export async function upsertUser(
  telegramId: number,
  username: string | undefined,
  firstName: string,
  lastName: string | undefined,
  _languageCode: string | undefined
): Promise<void> {
  const { error } = await supabase.from("bot_users").upsert(
    {
      telegram_id: telegramId,
      username: username ?? null,
      first_name: firstName,
      last_name: lastName ?? null,
      last_seen: new Date().toISOString(),
    },
    { onConflict: "telegram_id" }
  );
  if (error) logger.warn({ err: error }, "upsertUser failed (non-fatal)");
}

export async function getUser(telegramId: number): Promise<DbUser | null> {
  const { data, error } = await supabase
    .from("bot_users")
    .select("*")
    .eq("telegram_id", telegramId)
    .single();
  if (error) return null;
  return data as DbUser;
}

// ─── Sessions ─────────────────────────────────────────────────────────────────

const SESSION_TIMEOUT_MS = 30 * 60 * 1000;

export async function getOrCreateSession(telegramId: number): Promise<number> {
  try {
    const { data: sessions } = await supabase
      .from("bot_sessions")
      .select("id, last_activity, message_count")
      .eq("telegram_id", telegramId)
      .order("last_activity", { ascending: false })
      .limit(1);

    const lastSession = sessions?.[0] as { id: number; last_activity: string; message_count: number } | undefined;

    if (lastSession) {
      const age = Date.now() - new Date(lastSession.last_activity).getTime();
      if (age < SESSION_TIMEOUT_MS) {
        await supabase
          .from("bot_sessions")
          .update({
            last_activity: new Date().toISOString(),
            message_count: (lastSession.message_count ?? 0) + 1,
          })
          .eq("id", lastSession.id);
        return lastSession.id;
      }
    }

    const { data: newSession, error } = await supabase
      .from("bot_sessions")
      .insert({
        telegram_id: telegramId,
        started_at: new Date().toISOString(),
        last_activity: new Date().toISOString(),
        message_count: 1,
      })
      .select("id")
      .single();

    if (error) {
      logger.warn({ err: error }, "Failed to create session (non-fatal)");
      return 0;
    }

    return (newSession as { id: number }).id;
  } catch (err) {
    logger.warn({ err }, "getOrCreateSession failed (non-fatal)");
    return 0;
  }
}

// ─── Messages ─────────────────────────────────────────────────────────────────

export async function saveMessage(
  telegramId: number,
  role: "user" | "assistant",
  content: string,
  sessionId: number,
  hasSearch = false
): Promise<void> {
  const wordCount = content.trim().split(/\s+/).length;
  // Try full insert first; if schema cache is stale, fall back to basic columns
  const { error } = await supabase.from("bot_messages").insert({
    telegram_id: telegramId,
    session_id: sessionId || null,
    role,
    content,
    word_count: wordCount,
    has_search: hasSearch,
    created_at: new Date().toISOString(),
  });
  if (error) {
    logger.warn({ code: error.code }, "saveMessage full insert failed, trying basic");
    const { error: e2 } = await supabase.from("bot_messages").insert({
      telegram_id: telegramId,
      role,
      content,
      created_at: new Date().toISOString(),
    });
    if (e2) logger.warn({ err: e2 }, "saveMessage basic insert also failed");
  }
}

export async function getHistory(
  telegramId: number,
  limit = 20
): Promise<{ role: "user" | "assistant"; content: string }[]> {
  const { data, error } = await supabase
    .from("bot_messages")
    .select("role, content")
    .eq("telegram_id", telegramId)
    .order("created_at", { ascending: false })
    .limit(limit);
  if (error) { logger.warn({ err: error }, "getHistory failed"); return []; }
  return ((data ?? []) as { role: "user" | "assistant"; content: string }[]).reverse();
}

export async function clearHistory(telegramId: number): Promise<void> {
  await supabase.from("bot_messages").delete().eq("telegram_id", telegramId);
}

// ─── Memories ─────────────────────────────────────────────────────────────────

export async function getMemories(telegramId: number): Promise<Memory[]> {
  const { data, error } = await supabase
    .from("bot_memories")
    .select("key, value, category")
    .eq("telegram_id", telegramId)
    .order("category")
    .order("updated_at", { ascending: false });
  if (error) { logger.warn({ err: error }, "getMemories failed"); return []; }
  return (data ?? []) as Memory[];
}

export async function setMemory(
  telegramId: number,
  key: string,
  value: string,
  category: DbMemory["category"] = "profile"
): Promise<void> {
  const { error } = await supabase.from("bot_memories").upsert(
    { telegram_id: telegramId, key, value, category, updated_at: new Date().toISOString() },
    { onConflict: "telegram_id,key" }
  );
  if (error) logger.warn({ err: error }, "setMemory failed (non-fatal)");
}

export async function clearMemories(telegramId: number): Promise<void> {
  await supabase.from("bot_memories").delete().eq("telegram_id", telegramId);
}

export function formatMemoriesForPrompt(memories: Memory[]): string {
  if (memories.length === 0) return "";
  const grouped: Record<string, string[]> = {};
  for (const m of memories) {
    (grouped[m.category] ??= []).push(`${m.key}: ${m.value}`);
  }
  const lines = Object.entries(grouped)
    .map(([cat, items]) => `[${cat}] ${items.join(", ")}`)
    .join("\n");
  return `\nДолгосрочная память о пользователе:\n${lines}\n`;
}

// ─── Analytics: User ──────────────────────────────────────────────────────────

export interface UserAnalytics {
  messageCount: number;
  sessionCount: number;
  firstSeen: string | null;
  lastSeen: string | null;
  dailyActivity: { date: string; count: number }[];
  hourlyActivity: { hour: number; count: number }[];
  recentMessages: string[];
  totalWords: number;
  searchCount: number;
}

export async function getUserAnalytics(telegramId: number): Promise<UserAnalytics> {
  const thirtyDaysAgo = new Date(Date.now() - 30 * 24 * 60 * 60 * 1000).toISOString();

  const [user, recentMsgs, allMsgs, totalCountRes, sessionCountRes] = await Promise.all([
    getUser(telegramId),
    // Basic columns only — works even with stale schema cache
    supabase
      .from("bot_messages")
      .select("content, created_at")
      .eq("telegram_id", telegramId)
      .eq("role", "user")
      .order("created_at", { ascending: false })
      .limit(100),
    supabase
      .from("bot_messages")
      .select("created_at")
      .eq("telegram_id", telegramId)
      .eq("role", "user")
      .gte("created_at", thirtyDaysAgo),
    // Count ALL user messages directly — not relying on user.message_count
    supabase
      .from("bot_messages")
      .select("*", { count: "exact", head: true })
      .eq("telegram_id", telegramId)
      .eq("role", "user"),
    // Count sessions directly
    supabase
      .from("bot_sessions")
      .select("*", { count: "exact", head: true })
      .eq("telegram_id", telegramId),
  ]);

  const dailyMap: Record<string, number> = {};
  const hourlyMap: Record<number, number> = {};
  for (const msg of (allMsgs.data ?? []) as { created_at: string }[]) {
    const d = new Date(msg.created_at);
    const date = d.toISOString().split("T")[0]!;
    dailyMap[date] = (dailyMap[date] ?? 0) + 1;
    const h = d.getHours();
    hourlyMap[h] = (hourlyMap[h] ?? 0) + 1;
  }

  const dailyActivity = Object.entries(dailyMap)
    .map(([date, count]) => ({ date, count }))
    .sort((a, b) => a.date.localeCompare(b.date))
    .slice(-7);

  const hourlyActivity = Object.entries(hourlyMap)
    .map(([h, count]) => ({ hour: Number(h), count }))
    .sort((a, b) => b.count - a.count)
    .slice(0, 5);

  type MsgRow = { content: string; created_at: string };
  const msgs = (recentMsgs.data ?? []) as MsgRow[];
  const recentMessages = msgs.map((m) => m.content).slice(0, 30);
  // Estimate word count from content
  const totalWords = msgs.reduce((sum, m) => sum + m.content.trim().split(/\s+/).length, 0);
  // Count directly from DB, fall back to local count
  const messageCount = totalCountRes.count ?? msgs.length;
  const sessionCount = sessionCountRes.count ?? user?.session_count ?? 0;

  return {
    messageCount,
    sessionCount,
    firstSeen: user?.created_at ?? null,
    lastSeen: user?.last_seen ?? null,
    dailyActivity,
    hourlyActivity,
    recentMessages,
    totalWords,
    searchCount: 0, // will be 0 until has_search column is in cache
  };
}

// ─── Analytics: Weekly Comparison ────────────────────────────────────────────

export interface WeeklyData {
  count: number;
  sessions: number;
  byDay: { date: string; count: number }[];
  avgPerDay: number;
}

export interface WeeklyComparison {
  thisWeek: WeeklyData;
  lastWeek: WeeklyData;
  changePercent: number;
  trend: "up" | "down" | "stable";
}

export async function getWeeklyComparison(telegramId: number): Promise<WeeklyComparison> {
  const now = new Date();
  const thisWeekStart = new Date(now);
  thisWeekStart.setDate(now.getDate() - now.getDay() + (now.getDay() === 0 ? -6 : 1));
  thisWeekStart.setHours(0, 0, 0, 0);

  const lastWeekStart = new Date(thisWeekStart);
  lastWeekStart.setDate(lastWeekStart.getDate() - 7);
  const lastWeekEnd = new Date(thisWeekStart);

  const [thisWeekMsgs, lastWeekMsgs, thisWeekSessions, lastWeekSessions] = await Promise.all([
    supabase
      .from("bot_messages")
      .select("created_at")
      .eq("telegram_id", telegramId)
      .eq("role", "user")
      .gte("created_at", thisWeekStart.toISOString()),
    supabase
      .from("bot_messages")
      .select("created_at")
      .eq("telegram_id", telegramId)
      .eq("role", "user")
      .gte("created_at", lastWeekStart.toISOString())
      .lt("created_at", lastWeekEnd.toISOString()),
    supabase
      .from("bot_sessions")
      .select("id", { count: "exact", head: true })
      .eq("telegram_id", telegramId)
      .gte("started_at", thisWeekStart.toISOString()),
    supabase
      .from("bot_sessions")
      .select("id", { count: "exact", head: true })
      .eq("telegram_id", telegramId)
      .gte("started_at", lastWeekStart.toISOString())
      .lt("started_at", lastWeekEnd.toISOString()),
  ]);

  function buildDayMap(rows: { created_at: string }[]): { date: string; count: number }[] {
    const map: Record<string, number> = {};
    for (const r of rows) {
      const d = new Date(r.created_at).toISOString().split("T")[0]!;
      map[d] = (map[d] ?? 0) + 1;
    }
    return Object.entries(map).map(([date, count]) => ({ date, count })).sort((a, b) => a.date.localeCompare(b.date));
  }

  const thisCount = (thisWeekMsgs.data ?? []).length;
  const lastCount = (lastWeekMsgs.data ?? []).length;
  const changePercent = lastCount === 0
    ? (thisCount > 0 ? 100 : 0)
    : Math.round(((thisCount - lastCount) / lastCount) * 100);

  const trend: "up" | "down" | "stable" = changePercent > 10 ? "up" : changePercent < -10 ? "down" : "stable";

  return {
    thisWeek: {
      count: thisCount,
      sessions: thisWeekSessions.count ?? 0,
      byDay: buildDayMap((thisWeekMsgs.data ?? []) as { created_at: string }[]),
      avgPerDay: Math.round((thisCount / 7) * 10) / 10,
    },
    lastWeek: {
      count: lastCount,
      sessions: lastWeekSessions.count ?? 0,
      byDay: buildDayMap((lastWeekMsgs.data ?? []) as { created_at: string }[]),
      avgPerDay: Math.round((lastCount / 7) * 10) / 10,
    },
    changePercent,
    trend,
  };
}

// ─── Analytics: Global ────────────────────────────────────────────────────────

export async function getGlobalStats(): Promise<{
  totalUsers: number;
  totalMessages: number;
  totalSessions: number;
  todayMessages: number;
  todayUsers: number;
}> {
  const todayStart = new Date();
  todayStart.setHours(0, 0, 0, 0);

  const [usersRes, messagesRes, sessionsRes, todayMsgRes, todayUsersRes] = await Promise.all([
    supabase.from("bot_users").select("*", { count: "exact", head: true }),
    supabase.from("bot_messages").select("*", { count: "exact", head: true }),
    supabase.from("bot_sessions").select("*", { count: "exact", head: true }),
    supabase.from("bot_messages").select("*", { count: "exact", head: true })
      .gte("created_at", todayStart.toISOString())
      .eq("role", "user"),
    supabase.from("bot_users").select("*", { count: "exact", head: true })
      .gte("last_seen", todayStart.toISOString()),
  ]);

  return {
    totalUsers: usersRes.count ?? 0,
    totalMessages: messagesRes.count ?? 0,
    totalSessions: sessionsRes.count ?? 0,
    todayMessages: todayMsgRes.count ?? 0,
    todayUsers: todayUsersRes.count ?? 0,
  };
}
