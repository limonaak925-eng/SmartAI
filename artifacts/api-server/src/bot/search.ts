import { logger } from "../lib/logger.js";

const JINA_SEARCH_URL = "https://s.jina.ai/";
const JINA_READER_URL = "https://r.jina.ai/";
const SEARCH_TIMEOUT_MS = 12000;

export interface SearchResult {
  title: string;
  url: string;
  snippet: string;
}

export async function webSearch(query: string): Promise<string> {
  try {
    const url = `${JINA_SEARCH_URL}${encodeURIComponent(query)}`;

    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), SEARCH_TIMEOUT_MS);

    const res = await fetch(url, {
      headers: {
        Accept: "text/plain",
        "X-Return-Format": "text",
      },
      signal: controller.signal,
    });

    clearTimeout(timer);

    if (!res.ok) {
      throw new Error(`Search failed: ${res.status}`);
    }

    const text = await res.text();

    // Truncate to keep context manageable
    const truncated = text.length > 3000 ? text.slice(0, 3000) + "\n...[обрезано]" : text;
    return truncated;
  } catch (err) {
    logger.error({ err }, "Web search error");
    if ((err as Error).name === "AbortError") {
      throw new Error("Поиск занял слишком много времени, попробуй ещё раз.");
    }
    throw new Error("Не удалось выполнить поиск. Попробуй ещё раз.");
  }
}

export async function readPage(url: string): Promise<string> {
  try {
    const readerUrl = `${JINA_READER_URL}${url}`;

    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), SEARCH_TIMEOUT_MS);

    const res = await fetch(readerUrl, {
      headers: { Accept: "text/plain" },
      signal: controller.signal,
    });

    clearTimeout(timer);

    if (!res.ok) {
      throw new Error(`Reader failed: ${res.status}`);
    }

    const text = await res.text();
    return text.length > 4000 ? text.slice(0, 4000) + "\n...[обрезано]" : text;
  } catch (err) {
    logger.error({ err }, "Page reader error");
    if ((err as Error).name === "AbortError") {
      throw new Error("Загрузка страницы заняла слишком много времени.");
    }
    throw new Error("Не удалось прочитать страницу.");
  }
}
