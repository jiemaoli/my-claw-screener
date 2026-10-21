import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { normalizeMarket, type Market } from "./types.js";

export interface ScheduleConfig {
  enabled: boolean;
  time: string;
  days: number[];
  market: Market;
  minScore: number;
  topN: number;
}

export const DEFAULT_SCHEDULE: ScheduleConfig = {
  enabled: true,
  time: "06:00",
  days: [1, 2, 3, 4, 5],
  market: "us",
  minScore: 5,
  topN: 10,
};

function integerInRange(value: unknown, fallback: number, min: number, max: number): number {
  const parsed = Number.parseInt(String(value ?? ""), 10);
  return Number.isFinite(parsed) ? Math.min(max, Math.max(min, parsed)) : fallback;
}

export function normalizeScheduleConfig(input: unknown): ScheduleConfig {
  const value = (input ?? {}) as Record<string, unknown>;
  const time = typeof value.time === "string" ? value.time : DEFAULT_SCHEDULE.time;
  if (!/^([01]\d|2[0-3]):[0-5]\d$/.test(time)) {
    throw new Error("定时任务时间必须是 HH:mm 格式");
  }

  const days = Array.isArray(value.days)
    ? [
        ...new Set(
          value.days.map(Number).filter((day) => Number.isInteger(day) && day >= 0 && day <= 6)
        ),
      ]
    : DEFAULT_SCHEDULE.days;
  if (days.length === 0) throw new Error("至少选择一个执行日");

  return {
    enabled: value.enabled === undefined ? DEFAULT_SCHEDULE.enabled : Boolean(value.enabled),
    time,
    days: days.sort((a, b) => a - b),
    market: normalizeMarket(String(value.market ?? DEFAULT_SCHEDULE.market)),
    minScore: integerInRange(value.minScore, DEFAULT_SCHEDULE.minScore, 0, 10),
    topN: integerInRange(value.topN, DEFAULT_SCHEDULE.topN, 1, 50),
  };
}

function configPath(): string {
  return process.env.SCHEDULE_CONFIG_PATH ?? join(process.cwd(), "data", "schedule.json");
}

export function loadScheduleConfig(): ScheduleConfig {
  const path = configPath();
  if (!existsSync(path)) return DEFAULT_SCHEDULE;
  try {
    return normalizeScheduleConfig(JSON.parse(readFileSync(path, "utf8")) as unknown);
  } catch (error) {
    console.error("Could not load schedule config", error);
    return DEFAULT_SCHEDULE;
  }
}

export function saveScheduleConfig(input: unknown): ScheduleConfig {
  const config = normalizeScheduleConfig(input);
  const path = configPath();
  mkdirSync(dirname(path), { recursive: true });
  const temporaryPath = `${path}.tmp`;
  writeFileSync(temporaryPath, `${JSON.stringify(config, null, 2)}\n`, { mode: 0o600 });
  renameSync(temporaryPath, path);
  return config;
}

export function isScheduleDue(config: ScheduleConfig, date: Date): boolean {
  const currentTime = `${String(date.getHours()).padStart(2, "0")}:${String(date.getMinutes()).padStart(2, "0")}`;
  return config.enabled && config.days.includes(date.getDay()) && config.time === currentTime;
}

export function scheduleRunKey(date: Date): string {
  const year = date.getFullYear();
  const month = String(date.getMonth() + 1).padStart(2, "0");
  const day = String(date.getDate()).padStart(2, "0");
  const time = `${String(date.getHours()).padStart(2, "0")}:${String(date.getMinutes()).padStart(2, "0")}`;
  return `${year}-${month}-${day}T${time}`;
}
