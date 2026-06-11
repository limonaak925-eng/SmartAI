import Groq from "groq-sdk";
import { logger } from "../lib/logger.js";
import { setMemory, type DbMemory } from "./db.js";

const groq = new Groq({ apiKey: process.env["GROQ_API_KEY"]! });

type MemoryCategory = DbMemory["category"];

interface ExtractedFact {
  key: string;
  value: string;
  category: MemoryCategory;
}

export async function extractAndSaveMemories(
  telegramId: number,
  userMessage: string,
  assistantReply: string
): Promise<void> {
  try {
    const prompt = `Проанализируй диалог и извлеки ТОЛЬКО новые конкретные факты о пользователе для долгосрочной памяти.

Сообщение пользователя: "${userMessage}"
Ответ ассистента: "${assistantReply}"

Категории фактов:
- "profile" — имя, возраст, город, страна, семейное положение
- "professional" — профессия, компания, навыки, образование
- "interests" — хобби, увлечения, любимые темы, спорт, музыка
- "preferences" — предпочтения (язык общения, стиль ответов, что нравится/не нравится)
- "goals" — цели, планы, текущие проекты

Если новых фактов нет — верни: {"facts": []}
Верни ТОЛЬКО JSON: {"facts": [{"key": "...", "value": "...", "category": "..."}]}`;

    const completion = await groq.chat.completions.create({
      model: "llama-3.1-8b-instant",
      messages: [{ role: "user", content: prompt }],
      max_tokens: 300,
      temperature: 0.1,
      response_format: { type: "json_object" },
    });

    const raw = completion.choices[0]?.message?.content ?? '{"facts":[]}';
    let parsed: { facts?: ExtractedFact[] };

    try {
      parsed = JSON.parse(raw) as { facts?: ExtractedFact[] };
    } catch {
      return;
    }

    const facts = parsed.facts ?? [];
    const validCategories: MemoryCategory[] = ["profile", "professional", "interests", "preferences", "goals"];

    for (const fact of facts) {
      if (
        fact.key &&
        fact.value &&
        fact.category &&
        validCategories.includes(fact.category as MemoryCategory)
      ) {
        await setMemory(telegramId, String(fact.key), String(fact.value), fact.category as MemoryCategory);
      }
    }
  } catch (err) {
    logger.error({ err }, "extractAndSaveMemories failed");
  }
}
