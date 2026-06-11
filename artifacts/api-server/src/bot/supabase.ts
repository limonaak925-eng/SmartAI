import { createClient } from "@supabase/supabase-js";
import { logger } from "../lib/logger.js";

const supabaseUrl = process.env["SUPABASE_URL"];
const supabaseKey = process.env["SUPABASE_SERVICE_ROLE_KEY"];

if (!supabaseUrl || !supabaseKey) {
  throw new Error("SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY are required");
}

export const supabase = createClient(supabaseUrl, supabaseKey);

export async function checkTablesExist(): Promise<boolean> {
  const { error } = await supabase.from("bot_users").select("id").limit(1);
  if (error) {
    logger.error(
      { err: error },
      "Table bot_users not found. Please run supabase-setup.sql in your Supabase SQL Editor."
    );
    return false;
  }
  return true;
}

export async function upsertUser(
  telegramId: number,
  username: string | undefined,
  firstName: string,
  lastName: string | undefined
) {
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

  if (error) {
    logger.error({ err: error }, "Failed to upsert user");
  }
}

export async function saveMessage(
  telegramId: number,
  role: "user" | "assistant",
  content: string
) {
  const { error } = await supabase.from("bot_messages").insert({
    telegram_id: telegramId,
    role,
    content,
    created_at: new Date().toISOString(),
  });

  if (error) {
    logger.error({ err: error }, "Failed to save message");
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

  if (error) {
    logger.error({ err: error }, "Failed to get history");
    return [];
  }

  return (data ?? []).reverse() as { role: "user" | "assistant"; content: string }[];
}

export async function clearHistory(telegramId: number) {
  const { error } = await supabase
    .from("bot_messages")
    .delete()
    .eq("telegram_id", telegramId);

  if (error) {
    logger.error({ err: error }, "Failed to clear history");
  }
}

export async function getStats(): Promise<{ users: number; messages: number }> {
  const [usersResult, messagesResult] = await Promise.all([
    supabase.from("bot_users").select("*", { count: "exact", head: true }),
    supabase.from("bot_messages").select("*", { count: "exact", head: true }),
  ]);

  return {
    users: usersResult.count ?? 0,
    messages: messagesResult.count ?? 0,
  };
}
