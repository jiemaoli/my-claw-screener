import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";

export interface TelegramConfig {
  botToken: string;
  chatId: string;
}

function configPath(): string {
  return process.env.TELEGRAM_CONFIG_PATH ?? join(process.cwd(), "data", "telegram.json");
}

function environmentConfig(): TelegramConfig {
  return {
    botToken: process.env.TELEGRAM_BOT_TOKEN?.trim() ?? "",
    chatId: process.env.TELEGRAM_CHAT_ID?.trim() ?? "",
  };
}

export function normalizeTelegramConfig(input: unknown): TelegramConfig {
  const value = (input ?? {}) as Record<string, unknown>;
  const botToken = String(value.botToken ?? "").trim();
  const chatId = String(value.chatId ?? "").trim();
  if (!botToken) throw new Error("BOT Token 不能为空");
  if (!/^\d+:[A-Za-z0-9_-]+$/.test(botToken)) throw new Error("BOT Token 格式不正确");
  if (!chatId) throw new Error("Chat ID 不能为空");
  return { botToken, chatId };
}

export function loadTelegramConfig(): TelegramConfig {
  const path = configPath();
  if (!existsSync(path)) return environmentConfig();
  try {
    return normalizeTelegramConfig(JSON.parse(readFileSync(path, "utf8")) as unknown);
  } catch (error) {
    console.error("Could not load Telegram config", error);
    return environmentConfig();
  }
}

export function saveTelegramConfig(input: unknown): TelegramConfig {
  const config = normalizeTelegramConfig(input);
  const path = configPath();
  mkdirSync(dirname(path), { recursive: true });
  const temporaryPath = `${path}.tmp`;
  writeFileSync(temporaryPath, `${JSON.stringify(config, null, 2)}\n`, { mode: 0o600 });
  renameSync(temporaryPath, path);
  return config;
}
