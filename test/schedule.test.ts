import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  DEFAULT_SCHEDULE,
  isScheduleDue,
  normalizeScheduleConfig,
  scheduleRunKey,
} from "../src/schedule.js";

describe("schedule", () => {
  it("normalizes schedule input", () => {
    assert.deepEqual(
      normalizeScheduleConfig({
        enabled: true,
        time: "07:30",
        days: [5, 1, 1],
        market: "bk",
        minScore: 7,
        topN: 12,
      }),
      { enabled: true, time: "07:30", days: [1, 5], market: "th", minScore: 7, topN: 12 }
    );
  });

  it("rejects an invalid time", () => {
    assert.throws(() => normalizeScheduleConfig({ time: "25:00" }), /HH:mm/);
  });

  it("detects when a schedule is due", () => {
    const monday = new Date(2026, 9, 19, 18, 15, 0);
    assert.equal(isScheduleDue(DEFAULT_SCHEDULE, monday), true);
    monday.setMinutes(1);
    assert.equal(isScheduleDue(DEFAULT_SCHEDULE, monday), false);
  });

  it("builds a minute-level run key", () => {
    assert.equal(scheduleRunKey(new Date(2026, 9, 21, 6, 5)), "2026-10-21T06:05");
  });
});
