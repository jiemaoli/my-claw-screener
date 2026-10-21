import type { Market } from "./types.js";

type ScreeningStock = Record<string, unknown>;

export interface ScreeningApiEnvelope {
  schema_version: "1.0";
  provider: { id: "claw-screener"; name: "Claw Screener"; version: string };
  strategy: string;
  run_id: string;
  generated_at: string;
  market: string;
  status: "completed";
  duration_ms: number;
  summary: Record<string, unknown>;
  candidates: Array<Record<string, unknown>>;
}

function numeric(value: unknown): number | null {
  const result = typeof value === "number" ? value : Number(value);
  return Number.isFinite(result) ? result : null;
}

export function buildScreeningEnvelope(
  result: Record<string, unknown>,
  options: {
    strategy: string;
    market: Market;
    runId: string;
    generatedAt: string;
    durationMs: number;
  }
): ScreeningApiEnvelope {
  const stocks = Array.isArray(result.topStocks) ? (result.topStocks as ScreeningStock[]) : [];
  const candidates = stocks.map((stock, index) => {
    const symbol = String(stock.ticker ?? "").toUpperCase();
    const williamsR = numeric(stock.williamsR);
    const buffettScore = numeric(stock.buffettScore);
    const combinedScore = numeric(stock.combinedScore);
    const score = combinedScore ?? numeric(stock.techScore) ?? Math.abs(williamsR ?? 0);
    const isRecommendation = options.strategy === "quality_oversold" && (buffettScore ?? 0) >= 7;
    const reasons = [];
    if (williamsR !== null) reasons.push(`Williams %R is ${williamsR.toFixed(1)}`);
    if (buffettScore !== null && buffettScore > 0)
      reasons.push(`Buffett quality score is ${buffettScore}/10`);
    if (combinedScore !== null)
      reasons.push(`Combined quality score is ${combinedScore.toFixed(1)}/100`);
    return {
      symbol,
      name: String(stock.companyName ?? symbol),
      classification: isRecommendation ? "buy_candidate" : "watch",
      direction: "bullish",
      setup_type:
        options.strategy === "technical_oversold" ? "oversold_reversal" : "quality_pullback",
      timeframe: "swing",
      rank: index + 1,
      score,
      score_max: 100,
      price: numeric(stock.currentPrice),
      data_as_of: options.generatedAt,
      summary:
        options.strategy === "technical_oversold"
          ? "Technically oversold stock requiring reversal confirmation."
          : "Fundamentally screened company in a technically oversold condition.",
      reasons,
      risks: [
        "Oversold conditions can persist without a confirmed reversal.",
        "The screening result is a research candidate, not an execution instruction.",
      ],
      details: {
        williams_r: williamsR,
        buffett_score: buffettScore,
        technical_score: numeric(stock.techScore),
        fundamental_score: numeric(stock.fundamentalScore),
        combined_score: combinedScore,
      },
    };
  });

  return {
    schema_version: "1.0",
    provider: { id: "claw-screener", name: "Claw Screener", version: "1.0" },
    strategy: options.strategy,
    run_id: options.runId,
    generated_at: options.generatedAt,
    market: options.market.toUpperCase(),
    status: "completed",
    duration_ms: options.durationMs,
    summary: {
      total_scanned: result.totalScanned ?? null,
      oversold_count: result.oversoldCount ?? null,
      candidate_count: candidates.length,
      minimum_buffett_score: result.minBuffettScore ?? null,
    },
    candidates,
  };
}
