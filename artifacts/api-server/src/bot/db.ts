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

// ─── Health check ─────────────────────────────────────────────────────────────

export async function checkTablesExist(): Promise<boolean> {
  const { error } = await supabase.from("bot_users").select("telegram_id").limit(1);
  if (error) {
    logger.error({ err: error }, "Tables missing — run supabase-setup.sql");
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
  languageCode: string | undefined
): Promise<void> {
  const { error } = await supabase.from("bot_users").upsert(
    {
      telegram_id: telegramId,
      username: username ?? null,
      first_name: firstName,
      last_name: lastName ?? null,
      language_code: languageCode ?? null,
      last_seen: new Date().toISOString(),
    },
    { onConflict: "telegram_id" }
  );
  if (error) logger.error({ err: error }, "upsertUser failed");
}

export async function incrementUserMessageCount(telegramId: number): Promise<void> {
  const { error } = await supabase.rpc("increment_user_message_count", { uid: telegramId });
  if (error) {
    // Fallback if RPC doesn't exist yet
    logger.warn({ err: error }, "increment_user_message_count RPC failed, using fallback");
    const { data } = await supabase
      .from("bot_users")
      .select("message_count")
      .eq("telegram_id", telegramId)
      .single();
    if (data) {
      await supabase
        .from("bot_users")
        .update({ message_count: (data.message_count ?? 0) + 1 })
        .eq("telegram_id", telegramId);
    }
  }
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

const SESSION_TIMEOUT_MS = 30 * 60 * 1000; // 30 minutes

export async function getOrCreateSession(telegramId: number): Promise<number> {
  // Find the most recent session
  const { data: sessions } = await supabase
    .from("bot_sessions")
    .select("id, last_activity")
    .eq("telegram_id", telegramId)
    .order("last_activity", { ascending: false })
    .limit(1);

  const lastSession = sessions?.[0] as { id: number; last_activity: string } | undefined;

  if (lastSession) {
    const age = Date.now() - new Date(lastSession.last_activity).getTime();
    if (age < SESSION_TIMEOUT_MS) {
      // Read current count then increment
      const { data: sess } = await supabase
        .from("bot_sessions")
        .select("message_count")
        .eq("id", lastSession.id)
        .single();
      await supabase
        .from("bot_sessions")
        .update({
          last_activity: new Date().toISOString(),
          message_count: ((sess as { message_count: number } | null)?.message_count ?? 0) + 1,
        })
        .eq("id", lastSession.id);

      return lastSession.id;
    }
  }

  // Create new session
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
    logger.error({ err: error }, "Failed to create session");
    return 0;
  }

  // Increment session count on user
  const { data: usr } = await supabase
    .from("bot_users")
    .select("session_count")
    .eq("telegram_id", telegramId)
    .single();
  await supabase
    .from("bot_users")
    .update({ session_count: ((usr as { session_count: number } | null)?.session_count ?? 0) + 1 })
    .eq("telegram_id", telegramId);

  return (newSession as { id: number }).id;
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
  const { error } = await supabase.from("bot_messages").insert({
    telegram_id: telegramId,
    session_id: sessionId || null,
    role,
    content,
    word_count: wordCount,
    has_search: hasSearch,
    created_at: new Date().toISOString(),
  });
  if (error) logger.error({ err: error }, "saveMessage failed");
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
  if (error) { logger.error({ err: error }, "getHistory failed"); return []; }
  return ((data ?? []) as { role: "user" | "assistant"; content: string }[]).reverse();
}

export async function clearHistory(telegramId: number): Promise<void> {
  const { error } = await supabase.from("bot_messages").delete().eq("telegram_id", telegramId);
  if (error) logger.error({ err: error }, "clearHistory failed");
}

// ─── Memories ─────────────────────────────────────────────────────────────────

export interface Memory {
  key: string;
  value: string;
  category: string;
}

export async function getMemories(telegramId: number): Promise<Memory[]> {
  const { data, error } = await supabase
    .from("bot_memories")
    .select("key, value, category")
    .eq("telegram_id", telegramId)
    .order("category")
    .order("updated_at", { ascending: false });
  if (error) { logger.error({ err: error }, "getMemories failed"); return []; }
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
  if (error) logger.error({ err: error }, "setMemory failed");
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

// ─── Analytics ────────────────────────────────────────────────────────────────

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

export async function getUserAnalytics(telegramId: number): Promise<{
  messageCount: number;
  sessionCount: number;
  firstSeen: string | null;
  lastSeen: string | null;
  dailyActivity: { date: string; count: number }[];
  hourlyActivity: { hour: number; count: number }[];
  recentMessages: string[];
}> {
  const thirtyDaysAgo = new Date(Date.now() - 30 * 24 * 60 * 60 * 1000).toISOString();

  const [user, recentMsgs, allMsgs] = await Promise.all([
    getUser(telegramId),
    supabase
      .from("bot_messages")
      .select("content, created_at")
      .eq("telegram_id", telegramId)
      .eq("role", "user")
      .order("created_at", { ascending: false })
      .limit(50),
    supabase
      .from("bot_messages")
      .select("created_at")
      .eq("telegram_id", telegramId)
      .eq("role", "user")
      .gte("created_at", thirtyDaysAgo),
  ]);

  // Build daily activity
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
    .slice(0, 3);

  const recentMessages = ((recentMsgs.data ?? []) as { content: string }[])
    .map((m) => m.content)
    .slice(0, 20);

  return {
    messageCount: user?.message_count ?? 0,
    sessionCount: user?.session_count ?? 0,
    firstSeen: user?.created_at ?? null,
    lastSeen: user?.last_seen ?? null,
    dailyActivity,
    hourlyActivity,
    recentMessages,
  };
}
