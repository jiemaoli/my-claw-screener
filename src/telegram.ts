import { loadTelegramConfig } from "./telegramConfig.js";

const TELEGRAM_MESSAGE_LIMIT = 4000;

interface TelegramResponse {
  ok: boolean;
  description?: string;
}

export function splitTelegramMessage(
  message: string,
  limit: number = TELEGRAM_MESSAGE_LIMIT
): string[] {
  if (message.length <= limit) return [message];

  const chunks: string[] = [];
  let current = "";

  for (const line of message.split("\n")) {
    if (line.length > limit) {
      if (current) {
        chunks.push(current);
        current = "";
      }
      for (let offset = 0; offset < line.length; offset += limit) {
        chunks.push(line.slice(offset, offset + limit));
      }
      continue;
    }

    const next = current ? `${current}\n${line}` : line;
    if (next.length > limit) {
      chunks.push(current);
      current = line;
    } else {
      current = next;
    }
  }

  if (current) chunks.push(current);
  return chunks;
}

export async function sendTelegramMessage(
  message: string,
  parseMode?: "HTML" | "Markdown"
): Promise<void> {
  const { botToken: token, chatId } = loadTelegramConfig();

  if (!token || !chatId) {
    throw new Error("TELEGRAM_BOT_TOKEN and TELEGRAM_CHAT_ID are required");
  }

  for (const text of splitTelegramMessage(message)) {
    const response = await fetch(`https://api.telegram.org/bot${token}/sendMessage`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        chat_id: chatId,
        text,
        disable_web_page_preview: true,
        ...(parseMode ? { parse_mode: parseMode } : {}),
      }),
    });
    const result = (await response.json()) as TelegramResponse;
    if (!response.ok || !result.ok) {
      throw new Error(result.description ?? `Telegram API returned HTTP ${response.status}`);
    }
  }
}
