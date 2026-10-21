import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { buildScreeningEnvelope } from "../src/screenerApi.js";

describe("screening API contract", () => {
  it("maps Claw quality results to the shared candidate envelope", () => {
    const result = buildScreeningEnvelope(
      {
        totalScanned: 500,
        oversoldCount: 12,
        minBuffettScore: 5,
        topStocks: [
          {
            ticker: "AAPL",
            companyName: "Apple Inc.",
            currentPrice: 220,
            williamsR: -84,
            buffettScore: 8,
            combinedScore: 81.2,
          },
        ],
      },
      {
        strategy: "quality_oversold",
        market: "us",
        runId: "run1",
        generatedAt: "2026-10-22T00:00:00Z",
        durationMs: 100,
      }
    );

    assert.equal(result.schema_version, "1.0");
    assert.equal(result.provider.id, "claw-screener");
    assert.equal(result.candidates[0]?.classification, "buy_candidate");
    assert.equal(result.candidates[0]?.setup_type, "quality_pullback");
  });
});
