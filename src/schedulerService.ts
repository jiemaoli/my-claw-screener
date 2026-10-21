import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { isScheduleDue, loadScheduleConfig, scheduleRunKey } from "./schedule.js";
import { runScheduledScreening } from "./scheduler.js";

const statePath =
  process.env.SCHEDULE_STATE_PATH ?? join(process.cwd(), "data", "schedule-state.json");
let running = false;

function lastRunKey(): string | undefined {
  if (!existsSync(statePath)) return undefined;
  try {
    return (JSON.parse(readFileSync(statePath, "utf8")) as { lastRunKey?: string }).lastRunKey;
  } catch {
    return undefined;
  }
}

function recordRun(key: string): void {
  writeFileSync(statePath, `${JSON.stringify({ lastRunKey: key })}\n`, { mode: 0o600 });
}

async function tick(): Promise<void> {
  if (running) return;
  const now = new Date();
  const config = loadScheduleConfig();
  if (!isScheduleDue(config, now)) return;
  const key = scheduleRunKey(now);
  if (lastRunKey() === key) return;

  running = true;
  recordRun(key);
  try {
    await runScheduledScreening(config);
  } catch (error) {
    console.error(error);
  } finally {
    running = false;
  }
}

console.log("Claw Screener scheduler service started");
void tick();
const timer = setInterval(() => void tick(), 20_000);

process.on("SIGTERM", () => {
  clearInterval(timer);
  process.exit(0);
});
