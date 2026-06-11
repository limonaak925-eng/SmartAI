import Groq from "groq-sdk";
import { logger } from "../lib/logger.js";
import { webSearch } from "./search.js";
import { formatMemoriesForPrompt, type Memory } from "./db.js";

const groqApiKey = process.env["GROQ_API_KEY"];
if (!groqApiKey) throw new Error("GROQ_API_KEY is required");

const groq = new Groq({ apiKey: groqApiKey });

const BASE_SYSTEM_PROMPT = `Ты умный и дружелюбный ИИ-ассистент в Telegram.
Ты отвечаешь на русском языке (или на языке пользователя).
Ты помогаешь с любыми вопросами: ответы на вопросы, написание текстов, анализ, советы, программирование и многое другое.
Будь краток и по делу, но развёрнуто когда это нужно.
Форматируй ответы для Telegram: используй *жирный* и _курсив_ когда уместно.`;

const SEARCH_KEYWORDS = [
  "новост", "сейчас", "сегодня", "вчера", "курс", "цена", "погода",
  "актуальн", "последн", "недавно", "только что", "в данный момент",
  "прямо сейчас", "текущ", "свежи", "обновлени",
  "news", "today", "yesterday", "current", "latest", "price", "weather",
  "rate", "stock", "crypto", "биткоин", "bitcoin", "доллар", "евро", "тенге",
  "рубл", "нефть", "золото", "матч", "счёт", "результат",
];

function needsSearch(message: string): boolean {
  const lower = message.toLowerCase();
  return SEARCH_KEYWORDS.some((kw) => lower.includes(kw));
}

export async function getAIResponse(
  history: { role: "user" | "assistant"; content: string }[],
  userMessage: string,
  memories: Memory[] = []
): Promise<{ text: string; usedSearch: boolean }> {
  const memoryBlock = formatMemoriesForPrompt(memories);
  let systemPrompt = BASE_SYSTEM_PROMPT + memoryBlock;
  let usedSearch = false;

  if (needsSearch(userMessage)) {
    try {
      logger.info({ query: userMessage }, "Running web search");
      const searchResult = await webSearch(userMessage);
      if (searchResult && !searchResult.startsWith("Ошибка")) {
        usedSearch = true;
        systemPrompt +=
          `\n\n🔍 РЕЗУЛЬТАТЫ ПОИСКА (используй эти данные для ответа, они актуальны):\n${searchResult}`;
      }
    } catch (err) {
      logger.warn({ err }, "Web search failed, continuing without it");
    }
  }

  const messages: Groq.Chat.ChatCompletionMessageParam[] = [
    { role: "system", content: systemPrompt },
    ...history.map((m) => ({ role: m.role, content: m.content })),
    { role: "user", content: userMessage },
  ];

  try {
    const response = await groq.chat.completions.create({
      model: "llama-3.3-70b-versatile",
      messages,
      max_tokens: 1024,
      temperature: 0.7,
    });

    const text = response.choices[0]?.message?.content?.trim()
      ?? "Извините, не удалось получить ответ.";

    return { text, usedSearch };
  } catch (err) {
    logger.error({ err }, "Groq API error");
    throw new Error("Ошибка при обращении к ИИ");
  }
}
