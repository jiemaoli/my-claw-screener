import { getTickers, getMarketName, Market } from "./tickers.js";
import { WatchListManager } from "./watchList.js";
import { PriceDataFetcher } from "./priceData.js";
import { calculateWilliamsR } from "./technicalIndicators.js";
import { SECClient, extractFinancialFacts } from "./secApi.js";
import { FormulaEngine } from "./formulas.js";
import { OHLC } from "./database.js";
import { calculateCombinedScore } from "./watchListUtils.js";
import { normalizeMarket } from "./types.js";
import type { OutputFormat } from "./types.js";
export type { OutputFormat } from "./types.js";

export interface OversoldStock {
  ticker: string;
  williamsR: number;
  priceData: OHLC[];
}

export interface QualityStock {
  ticker: string;
  companyName: string;
  currentPrice: number;
  williamsR: number;
  buffettScore: number;
  techScore: number;
  fundamentalScore: number;
  combinedScore: number;
}

export interface ScreeningResult {
  totalScanned: number;
  oversoldCount: number;
  qualityCount: number;
  minBuffettScore: number;
  topStocks: QualityStock[];
  market: Market;
}

export interface ScreeningRunResult {
  output: string;
  qualityStocks: QualityStock[];
}

export async function runCombinedScreening(
  market: Market = "us",
  minBuffettScore: number = 5,
  topN: number = 10,
  format: OutputFormat = "text"
): Promise<ScreeningRunResult> {
  const marketName = getMarketName(market);
  const hasFundamentals = market === "us";

  console.log(
    `📊 Running combined screening (${marketName}, min Buffett score: ${minBuffettScore})...`
  );

  const tickers = await getTickers(market);
  console.log(`  Found ${tickers.length} tickers`);

  console.log("  Phase 1: Technical screening...");
  const fetcher = new PriceDataFetcher();
  const priceResults = await fetcher.batchFetchPrices(tickers, 90);
  fetcher.close();

  const oversoldStocks: OversoldStock[] = [];
  for (const [ticker, result] of Object.entries(priceResults)) {
    if (!result.success || !result.data) continue;

    const williamsR = calculateWilliamsR(result.data, 21);
    const latestWr = williamsR[williamsR.length - 1];

    if (latestWr && latestWr < -80) {
      oversoldStocks.push({
        ticker,
        williamsR: latestWr,
        priceData: result.data,
      });
    }
  }

  console.log(`  Found ${oversoldStocks.length} oversold stocks`);

  let qualityStocks: QualityStock[];

  if (!hasFundamentals) {
    console.log("  Phase 2: Skipping fundamental screening (Thai market - no SEC data)");
    qualityStocks = oversoldStocks.map((stock) => ({
      ticker: stock.ticker,
      companyName: stock.ticker,
      currentPrice: stock.priceData[stock.priceData.length - 1]?.Close ?? 0,
      williamsR: stock.williamsR,
      buffettScore: 0,
      techScore: Math.abs(stock.williamsR),
      fundamentalScore: 0,
      combinedScore: Math.abs(stock.williamsR),
    }));
  } else {
    console.log("  Phase 2: Fundamental screening...");
    qualityStocks = [];
    const secClient = new SECClient();

    for (const stock of oversoldStocks) {
      const ticker = stock.ticker;

      const tickerInfo = await secClient.resolveTicker(ticker);
      if (!tickerInfo) continue;

      const companyFacts = await secClient.getCompanyFacts(tickerInfo.cik);
      if (!companyFacts) continue;

      const financials = extractFinancialFacts(companyFacts);
      if (!financials || Object.keys(financials).length === 0) continue;

      const engine = new FormulaEngine(financials);
      const buffettScore = engine.getScore();

      if (buffettScore >= minBuffettScore) {
        const techScore = Math.abs(stock.williamsR);
        const fundamentalScore = (buffettScore / 10) * 100;
        const combinedScore = calculateCombinedScore(stock.williamsR, buffettScore);

        qualityStocks.push({
          ticker,
          companyName: tickerInfo.name,
          currentPrice: stock.priceData[stock.priceData.length - 1]?.Close ?? 0,
          williamsR: stock.williamsR,
          buffettScore,
          techScore,
          fundamentalScore,
          combinedScore,
        });
      }
    }

    secClient.close();
  }

  qualityStocks.sort((a, b) => b.combinedScore - a.combinedScore);

  console.log(`  Found ${qualityStocks.length} quality stocks`);

  if (format === "json") {
    return {
      output: JSON.stringify(
        {
          totalScanned: tickers.length,
          oversoldCount: oversoldStocks.length,
          qualityCount: qualityStocks.length,
          minBuffettScore,
          market,
          topStocks: qualityStocks.slice(0, topN),
        },
        null,
        2
      ),
      qualityStocks,
    };
  }

  if (format === "telegram") {
    const lines: string[] = [
      "🦞 <b>Claw Screener 推出</b>",
      `📊 <b>Combined Quality Screening (${escapeHtml(marketName)})</b>`,
      "数据源：Yahoo Finance（价格与 Williams %R）· SEC EDGAR（基本面）",
      `Scanned: ${tickers.length} stocks`,
      `Oversold: ${oversoldStocks.length}`,
      hasFundamentals
        ? `Quality (Buffett ≥${minBuffettScore}/10): ${qualityStocks.length}`
        : `Oversold candidates: ${qualityStocks.length}`,
      `🌟 Top ${Math.min(topN, qualityStocks.length)} Quality Opportunities:`,
      "",
    ];

    if (qualityStocks.length > 0) {
      for (let i = 0; i < Math.min(topN, qualityStocks.length); i++) {
        const stock = qualityStocks[i];
        const tickerUrl = `https://x.com/search?q=${encodeURIComponent(`$${stock.ticker}`)}&src=cashtag_click`;
        const label =
          stock.buffettScore >= 7
            ? `Buy candidate around $${stock.currentPrice.toFixed(2)}`
            : "Don’t buy yet";
        if (hasFundamentals) {
          lines.push(
            `<a href="${tickerUrl}">$${stock.ticker}</a> (${escapeHtml(stock.companyName)}) — ${label}`
          );
        } else {
          lines.push(`<a href="${tickerUrl}">$${stock.ticker}</a> — Oversold`);
        }
      }
    } else {
      lines.push("No stocks matched the screening criteria.");
    }

    return { output: lines.join("\n"), qualityStocks };
  }

  const lines = [
    `📊 Combined Quality Screening (${marketName})`,
    hasFundamentals
      ? "Technical: Oversold signals (Williams %R < -80)"
      : "Technical: Oversold signals (Williams %R < -80) - Thai Market",
    hasFundamentals
      ? "Fundamental: Warren Buffett's 10 formulas on SEC data"
      : "Fundamental: Not available (Thai stocks not in SEC)",
    hasFundamentals ? `Minimum Buffett Score: ${minBuffettScore}/10\n` : "\n",
    "Results:",
  ];

  lines.push(`  Total Scanned: ${tickers.length}`);
  lines.push(`  Oversold Found: ${oversoldStocks.length}`);
  lines.push(
    hasFundamentals
      ? `  Quality Stocks: ${qualityStocks.length} (Buffett ≥${minBuffettScore}/10)\n`
      : `  Oversold Stocks: ${qualityStocks.length}\n`
  );

  if (qualityStocks.length > 0) {
    lines.push(`Top ${Math.min(topN, qualityStocks.length)} Opportunities:\n`);

    for (let i = 0; i < Math.min(topN, qualityStocks.length); i++) {
      const stock = qualityStocks[i];
      if (hasFundamentals) {
        lines.push(
          `${i + 1}. ${stock.ticker.padEnd(6)} — Combined: ${stock.combinedScore.toFixed(1).padStart(5)}% ` +
            `| Buffett: ${stock.buffettScore}/10 | WR: ${stock.williamsR.toFixed(1)}`
        );
      } else {
        lines.push(
          `${i + 1}. ${stock.ticker.padEnd(10)} — Williams %R: ${stock.williamsR.toFixed(1)}`
        );
      }
    }
  } else {
    lines.push("  No quality stocks found matching criteria");
  }

  if (hasFundamentals) {
    lines.push("\nScoring: 30% technical + 70% fundamental");
  }

  return { output: lines.join("\n"), qualityStocks };
}

function escapeHtml(value: string): string {
  return value.replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll(">", "&gt;");
}

async function main() {
  const args = process.argv.slice(2);
  let market: Market = "us";
  let minBuffettScore = 5;
  let topN = 10;
  let format: OutputFormat = "text";
  let addTop = 0;
  let addGroup: string | undefined;

  for (let i = 0; i < args.length; i++) {
    if (args[i] === "--market" && i + 1 < args.length) {
      try {
        market = normalizeMarket(args[i + 1]);
      } catch (e) {
        console.error((e as Error).message);
        process.exit(1);
      }
      i++;
    } else if (args[i] === "--min-score" && i + 1 < args.length) {
      minBuffettScore = parseInt(args[i + 1], 10);
      i++;
    } else if (args[i] === "--top-n" && i + 1 < args.length) {
      topN = parseInt(args[i + 1], 10);
      i++;
    } else if (args[i] === "--format" && i + 1 < args.length) {
      format = args[i + 1] as OutputFormat;
      i++;
    } else if (args[i] === "--add-top" && i + 1 < args.length) {
      addTop = parseInt(args[i + 1], 10);
      i++;
    } else if (args[i] === "--add-group" && i + 1 < args.length) {
      addGroup = args[i + 1];
      i++;
    } else if (args[i] === "--config" && i + 1 < args.length) {
      process.env.CLAW_SCREENER_CONFIG = args[i + 1];
      i++;
    }
  }

  const result = await runCombinedScreening(market, minBuffettScore, topN, format);
  console.log(result.output);

  if (addTop > 0) {
    const watchlist = new WatchListManager();
    const topStocks = result.qualityStocks.slice(0, addTop);
    const { added, skipped } = watchlist.addMany(
      topStocks.map((stock) => stock.ticker),
      market,
      "Added from screening",
      undefined,
      minBuffettScore,
      addGroup
    );

    if (added.length > 0) {
      console.log(`\n✅ Added ${added.length} screening pick(s) to watchlist: ${added.join(", ")}`);
    }
    if (skipped.length > 0) {
      console.log(`⚠️  Already in watchlist: ${skipped.join(", ")}`);
    }
    if (topStocks.length === 0) {
      console.log("\n⚠️  No screening picks available to add to watchlist");
    }
  }
}

if (import.meta.main) {
  main().catch(console.error);
}
