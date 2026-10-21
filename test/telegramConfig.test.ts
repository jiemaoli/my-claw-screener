import assert from "node:assert/strict";
import { afterEach, describe, it } from "node:test";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import {
  loadTelegramConfig,
  normalizeTelegramConfig,
  saveTelegramConfig,
} from "../src/telegramConfig.js";

const originalPath = process.env.TELEGRAM_CONFIG_PATH;
const directories: string[] = [];

afterEach(() => {
  if (originalPath === undefined) delete process.env.TELEGRAM_CONFIG_PATH;
  else process.env.TELEGRAM_CONFIG_PATH = originalPath;
  for (const directory of directories.splice(0)) rmSync(directory, { recursive: true });
});

describe("telegram config", () => {
  it("normalizes and validates input", () => {
    assert.deepEqual(normalizeTelegramConfig({ botToken: " 123:abc_DEF-1 ", chatId: " -1001 " }), {
      botToken: "123:abc_DEF-1",
      chatId: "-1001",
    });
    assert.throws(() => normalizeTelegramConfig({ botToken: "hidden", chatId: "-1001" }), /格式/);
  });

  it("persists and reloads config", () => {
    const directory = mkdtempSync(join(tmpdir(), "claw-telegram-"));
    directories.push(directory);
    const path = join(directory, "telegram.json");
    process.env.TELEGRAM_CONFIG_PATH = path;
    const config = saveTelegramConfig({ botToken: "123:secret", chatId: "-1001" });
    assert.deepEqual(loadTelegramConfig(), config);
    assert.deepEqual(JSON.parse(readFileSync(path, "utf8")), config);
  });
});
