import Groq from "groq-sdk";
import { logger } from "../lib/logger.js";
import { webSearch, readPage } from "./search.js";
import { formatMemoriesForPrompt, type Memory } from "./memory.js";

const groqApiKey = process.env["GROQ_API_KEY"];
if (!groqApiKey) throw new Error("GROQ_API_KEY is required");

const groq = new Groq({ apiKey: groqApiKey });

const BASE_SYSTEM_PROMPT = `Ты умный и дружелюбный ИИ-ассистент в Telegram.
Ты отвечаешь на русском языке (или на языке пользователя).
Ты помогаешь с любыми вопросами: ответы на вопросы, написание текстов, анализ, советы, программирование и многое другое.
Будь краток и по делу, но развёрнуто когда это нужно.
Когда пользователь спрашивает о текущих событиях, ценах, погоде, новостях или любой актуальной информации — используй инструмент web_search.
Когда нужно прочитать конкретную веб-страницу — используй инструмент read_page.`;

const TOOLS: Groq.Chat.CompletionCreateParams.Tool[] = [
  {
    type: "function",
    function: {
      name: "web_search",
      description:
        "Поиск актуальной информации в интернете. Используй для текущих событий, новостей, цен, погоды, фактов которые могут устареть.",
      parameters: {
        type: "object",
        properties: {
          query: {
            type: "string",
            description: "Поисковый запрос на русском или английском языке",
          },
        },
        required: ["query"],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "read_page",
      description: "Прочитать содержимое конкретной веб-страницы по URL.",
      parameters: {
        type: "object",
        properties: {
          url: {
            type: "string",
            description: "Полный URL страницы (например https://example.com)",
          },
        },
        required: ["url"],
      },
    },
  },
];

async function executeTool(name: string, argsJson: string): Promise<string> {
  try {
    const args = JSON.parse(argsJson) as Record<string, string>;
    if (name === "web_search") {
      return await webSearch(args["query"] ?? "");
    }
    if (name === "read_page") {
      return await readPage(args["url"] ?? "");
    }
    return "Неизвестный инструмент.";
  } catch (err) {
    logger.error({ err, name }, "Tool execution error");
    return `Ошибка выполнения инструмента: ${(err as Error).message}`;
  }
}

export async function getAIResponse(
  history: { role: "user" | "assistant"; content: string }[],
  userMessage: string,
  memories: Memory[] = []
): Promise<{ text: string; usedSearch: boolean }> {
  const memoryBlock = formatMemoriesForPrompt(memories);
  const systemPrompt = BASE_SYSTEM_PROMPT + memoryBlock;

  const messages: Groq.Chat.ChatCompletionMessageParam[] = [
    { role: "system", content: systemPrompt },
    ...history.map((m) => ({ role: m.role, content: m.content })),
    { role: "user", content: userMessage },
  ];

  let usedSearch = false;

  try {
    // First pass — may call tools
    let response = await groq.chat.completions.create({
      model: "llama-3.3-70b-versatile",
      messages,
      tools: TOOLS,
      tool_choice: "auto",
      max_tokens: 1024,
      temperature: 0.7,
    });

    let choice = response.choices[0];

    // Agentic loop — handle tool calls
    while (choice?.finish_reason === "tool_calls" && choice.message.tool_calls?.length) {
      usedSearch = true;
      messages.push(choice.message);

      const toolResults: Groq.Chat.ChatCompletionToolMessageParam[] = [];
      for (const call of choice.message.tool_calls) {
        const result = await executeTool(call.function.name, call.function.arguments);
        toolResults.push({
          role: "tool",
          tool_call_id: call.id,
          content: result,
        });
      }

      messages.push(...toolResults);

      response = await groq.chat.completions.create({
        model: "llama-3.3-70b-versatile",
        messages,
        tools: TOOLS,
        tool_choice: "auto",
        max_tokens: 1024,
        temperature: 0.7,
      });

      choice = response.choices[0];
    }

    const text = choice?.message?.content ?? "Извините, не удалось получить ответ.";
    return { text, usedSearch };
  } catch (err) {
    logger.error({ err }, "Groq API error");
    throw new Error("Ошибка при обращении к ИИ");
  }
}
