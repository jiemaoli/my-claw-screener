import { runCombinedScreening } from "./screening.js";
import { sendTelegramMessage } from "./telegram.js";
import { normalizeMarket } from "./types.js";
import { acquireJobLock } from "./jobLock.js";
import type { ScheduleConfig } from "./schedule.js";

function integerEnv(name: string, fallback: number): number {
  const value = Number.parseInt(process.env[name] ?? "", 10);
  return Number.isFinite(value) ? value : fallback;
}

export async function runScheduledScreening(schedule?: ScheduleConfig): Promise<void> {
  const releaseLock = acquireJobLock();
  const market = schedule?.market ?? normalizeMarket(process.env.SCREEN_MARKET ?? "us");
  const minScore = schedule?.minScore ?? integerEnv("SCREEN_MIN_SCORE", 5);
  const topN = schedule?.topN ?? integerEnv("SCREEN_TOP_N", 10);
  try {
    const result = await runCombinedScreening(market, minScore, topN, "telegram");
    await sendTelegramMessage(result.output, "HTML");
  } finally {
    releaseLock();
  }
}

if (import.meta.main) {
  runScheduledScreening().catch(async (error: unknown) => {
    const message = error instanceof Error ? error.message : String(error);
    console.error(error);
    try {
      await sendTelegramMessage(`❌ Claw Screener scheduled run failed\n${message}`);
    } catch (telegramError) {
      console.error(telegramError);
    }
    process.exit(1);
  });
}
