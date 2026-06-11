import Groq from "groq-sdk";
import { supabase } from "./supabase.js";
import { logger } from "../lib/logger.js";

const groq = new Groq({ apiKey: process.env["GROQ_API_KEY"]! });

export interface Memory {
  key: string;
  value: string;
}

export async function getMemories(telegramId: number): Promise<Memory[]> {
  const { data, error } = await supabase
    .from("bot_memories")
    .select("key, value")
    .eq("telegram_id", telegramId)
    .order("updated_at", { ascending: false });

  if (error) {
    logger.error({ err: error }, "Failed to get memories");
    return [];
  }

  return (data ?? []) as Memory[];
}

export async function setMemory(telegramId: number, key: string, value: string) {
  const { error } = await supabase.from("bot_memories").upsert(
    {
      telegram_id: telegramId,
      key,
      value,
      updated_at: new Date().toISOString(),
    },
    { onConflict: "telegram_id,key" }
  );

  if (error) {
    logger.error({ err: error }, "Failed to set memory");
  }
}

export async function deleteMemory(telegramId: number, key: string) {
  await supabase
    .from("bot_memories")
    .delete()
    .eq("telegram_id", telegramId)
    .eq("key", key);
}

export async function clearMemories(telegramId: number) {
  await supabase.from("bot_memories").delete().eq("telegram_id", telegramId);
}

export function formatMemoriesForPrompt(memories: Memory[]): string {
  if (memories.length === 0) return "";
  const lines = memories.map((m) => `- ${m.key}: ${m.value}`).join("\n");
  return `\nЧто ты знаешь об этом пользователе (долгосрочная память):\n${lines}\n`;
}

export async function extractAndSaveMemories(
  telegramId: number,
  userMessage: string,
  assistantReply: string
): Promise<void> {
  try {
    const prompt = `Проанализируй этот фрагмент диалога и извлеки ТОЛЬКО новые важные факты о пользователе, которые стоит запомнить долгосрочно (имя, профессия, интересы, предпочтения, важные жизненные детали, цели).

Сообщение пользователя: "${userMessage}"
Ответ ассистента: "${assistantReply}"

Если новых фактов нет — верни пустой массив.
Верни ТОЛЬКО JSON массив объектов формата {"key": "...", "value": "..."}, без пояснений.
Пример: [{"key": "имя", "value": "Алексей"}, {"key": "профессия", "value": "программист"}]`;

    const completion = await groq.chat.completions.create({
      model: "llama-3.1-8b-instant",
      messages: [{ role: "user", content: prompt }],
      max_tokens: 256,
      temperature: 0.1,
      response_format: { type: "json_object" },
    });

    const raw = completion.choices[0]?.message?.content ?? "[]";

    let parsed: unknown;
    try {
      parsed = JSON.parse(raw);
    } catch {
      return;
    }

    const items: Memory[] = Array.isArray(parsed)
      ? (parsed as Memory[])
      : Array.isArray((parsed as Record<string, unknown>)["memories"])
      ? ((parsed as Record<string, unknown>)["memories"] as Memory[])
      : [];

    for (const item of items) {
      if (item.key && item.value) {
        await setMemory(telegramId, String(item.key), String(item.value));
      }
    }
  } catch (err) {
    logger.error({ err }, "Failed to extract memories");
  }
}
