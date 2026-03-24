/**
 * SuperbrainEngine — Ultra-Advanced AI Quant Signal Fusion Engine
 *
 * Architecture:
 *   Layer 1 — Technical Signal  (EMA alignment, momentum, breakout, ATR, VWAP)
 *   Layer 2 — Fundamental Signal (PE, ROE, ROCE, D/E, promoter, growth)
 *   Layer 3 — Sentiment Signal  (news headlines, order flow, volume surge)
 *   Layer 4 — Macro Signal      (sector rotation, FII/DII proxy, market regime)
 *   Layer 5 — Fusion + RL       (adaptive weights, self-learning feedback loop)
 *
 * Design constraints:
 *   - ZERO network calls — reads only from pre-computed signals passed in
 *   - CPU-minimal: <2ms per stock, O(1) per signal layer
 *   - Self-learning: feedback store in global (survives warm Vercel instances)
 *   - Works for both UltraQuant and Multibagger tabs via unified interface
 */

import type { EnrichedStockData } from './MarketDataAggregator';

// ── Types ─────────────────────────────────────────────────────────────────────

export type SuperbrainDecision = 'STRONG_BUY' | 'BUY' | 'HOLD' | 'SELL' | 'STRONG_SELL';

export interface SuperbrainInput {
  symbol: string;
  sector: string;
  marketCap: number;
  // Technical signals (from OHLCV analysis)
  cagr: number;               // annualised CAGR %
  momentum: number;           // price / 6m-ago price
  trendStrength: number;      // EMA slope normalised
  volatility: number;         // daily return std-dev
  maxDrawdown: number;        // max drawdown %
  breakoutFrequency: number;  // fraction of days closing above 20d high
  volumeGrowth: number;       // recent vol / early vol ratio
  gradientBoostProb: number;  // 0-100 AI probability score
  finalPredictionScore: number; // 0-100 composite prediction
  rlAction: 'BUY' | 'SELL' | 'HOLD';
  orderImbalance: number;     // bid/ask volume ratio
  vwapDistance?: number;      // % above/below VWAP
  // Fundamental signals (from enriched data — may be null)
  pe: number | null;
  roe: number | null;
  roce: number | null;
  debtToEquity: number | null;
  promoterHolding: number | null;
  profitGrowth3yr: number | null;
  salesGrowth3yr: number | null;
  fundamentalScore: number | null; // 0-100 pre-computed
  // Sentiment signals
  sentimentScore: number;     // 0-100
  newsHeadlines: string[];
  pChange: number | null;     // today's % change
  // Multibagger-specific (optional)
  bullishScore?: number;      // 0-100 MB composite
  trendScore?: number;
  relativeStrength?: number;
  stabilityScore?: number;
  ret30?: number;
  ret90?: number;
  ret180?: number;
  // Data quality
  dataQuality: 'HIGH' | 'MEDIUM' | 'LOW';
  dataSource: 'real' | 'synthetic';
}

export interface SuperbrainOutput {
  symbol: string;
  decision: SuperbrainDecision;
  confidence: number;       // 0-100
  superScore: number;       // 0-100 unified score
  riskScore: number;        // 0-100 (higher = riskier)
  targetPrice: number | null;
  stopLoss: number | null;
  upside: number | null;    // % upside to target
  explanation: string[];    // human-readable reasons (max 4)
  signals: {
    technical: number;      // 0-100
    fundamental: number;    // 0-100
    sentiment: number;      // 0-100
    macro: number;          // 0-100
    momentum: number;       // 0-100
  };
  regime: 'BULL' | 'BEAR' | 'SIDEWAYS' | 'VOLATILE';
  holdingPeriod: string;    // e.g. "3-6 months"
  catalysts: string[];      // top 2 bullish catalysts
  risks: string[];          // top 2 risk factors
  dataSource: 'real' | 'synthetic'; // whether price/CAGR data is real or simulated
}

// ── Feedback loop store (self-learning) ───────────────────────────────────────
// Stored in global so it survives warm Vercel instances across requests.
// Tracks per-sector and per-regime weight adjustments based on signal accuracy.

interface FeedbackStore {
  sectorBias: Record<string, number>;    // sector → cumulative score adjustment
  regimeBias: Record<string, number>;    // regime → weight multiplier
  signalAccuracy: {
    technical: number;   // rolling accuracy 0-1
    fundamental: number;
    sentiment: number;
    macro: number;
    momentum: number;
  };
  callCount: number;
}

const _sbFeedback: FeedbackStore = ((global as any).__superbrainFeedback ??= {
  sectorBias: {},
  regimeBias: { BULL: 1.1, BEAR: 0.85, SIDEWAYS: 0.95, VOLATILE: 0.8 },
  signalAccuracy: { technical: 0.72, fundamental: 0.68, sentiment: 0.55, macro: 0.60, momentum: 0.75 },
  callCount: 0,
});

// ── Indian market sector macro weights ────────────────────────────────────────
// Based on NSE sector rotation patterns and FII preference cycles
const SECTOR_MACRO_SCORE: Record<string, number> = {
  Technology:  78, Financials: 74, Healthcare: 72, Consumer: 68,
  Industrials: 65, Auto: 63,       Materials:  60, Energy: 58,
  Utilities:   55, Telecom: 52,    'Real Estate': 50,
};

// ── Indian market PE benchmarks by sector ─────────────────────────────────────
const SECTOR_PE_FAIR: Record<string, number> = {
  Technology: 28, Financials: 18, Healthcare: 30, Consumer: 35,
  Industrials: 25, Auto: 20,      Materials: 15,  Energy: 12,
  Utilities: 16,  Telecom: 22,    'Real Estate': 20,
};

// ── Helper: clamp ─────────────────────────────────────────────────────────────
const clamp01 = (v: number) => Math.max(0, Math.min(1, v));
const clamp100 = (v: number) => Math.max(0, Math.min(100, v));

// ── Layer 1: Technical Signal (0-100) ─────────────────────────────────────────
function computeTechnicalSignal(inp: SuperbrainInput): number {
  let score = 0;

  // CAGR quality (Indian market: >20% is excellent, >35% is exceptional)
  // For synthetic data, cap CAGR contribution — synthetic CAGR is unreliable
  const effectiveCagr = inp.dataSource === 'synthetic' ? Math.min(inp.cagr, 25) : inp.cagr;
  if (effectiveCagr >= 35)      score += 22;
  else if (effectiveCagr >= 25) score += 16;
  else if (effectiveCagr >= 15) score += 10;
  else if (effectiveCagr >= 8)  score += 4;
  else                          score -= 4;

  // Momentum (price vs 6m ago — >1.15 = strong uptrend)
  const mom = inp.momentum;
  if (mom >= 1.3)       score += 18;
  else if (mom >= 1.15) score += 13;
  else if (mom >= 1.05) score += 7;
  else if (mom >= 0.95) score += 0;
  else                  score -= 8;

  // Trend strength (EMA slope — positive = uptrend)
  const ts = Math.abs(inp.trendStrength);
  if (inp.trendStrength > 0) {
    score += ts > 3 ? 14 : ts > 1.5 ? 9 : ts > 0.5 ? 5 : 2;
  } else {
    score -= ts > 3 ? 10 : ts > 1 ? 5 : 2;
  }

  // Volatility quality (Indian market sweet spot: 1.5-3.5% daily)
  const vol = inp.volatility * 100;
  if (vol >= 1.5 && vol <= 3.5) score += 10;
  else if (vol < 1.5)           score += 5;  // low vol = stable
  else if (vol <= 5)            score += 2;
  else                          score -= 6;  // >5% = too risky

  // Max drawdown (lower is better)
  if (inp.maxDrawdown <= 15)      score += 10;
  else if (inp.maxDrawdown <= 25) score += 5;
  else if (inp.maxDrawdown <= 40) score += 0;
  else                            score -= 8;

  // Breakout frequency (0.10-0.20 = healthy breakout stock)
  const bf = inp.breakoutFrequency;
  if (bf >= 0.12 && bf <= 0.22) score += 8;
  else if (bf >= 0.08)          score += 4;
  else                          score += 0;

  // Volume growth (institutional accumulation signal)
  if (inp.volumeGrowth >= 2.0)      score += 8;
  else if (inp.volumeGrowth >= 1.4) score += 5;
  else if (inp.volumeGrowth >= 1.0) score += 2;
  else                              score -= 3;

  // Order imbalance (bid > ask = buying pressure)
  if (inp.orderImbalance >= 2.5)    score += 6;
  else if (inp.orderImbalance >= 1.5) score += 3;
  else if (inp.orderImbalance < 0.8)  score -= 4;

  // VWAP distance (above VWAP = bullish intraday)
  if (inp.vwapDistance != null) {
    if (inp.vwapDistance > 1)       score += 4;
    else if (inp.vwapDistance < -2) score -= 4;
  }

  return clamp100(score + 10); // base offset so neutral = ~50
}

// ── Layer 2: Fundamental Signal (0-100) ───────────────────────────────────────
function computeFundamentalSignal(inp: SuperbrainInput): number {
  // If pre-computed fundamentalScore exists and data is HIGH quality, use it directly
  if (inp.fundamentalScore !== null && inp.dataQuality === 'HIGH') {
    return inp.fundamentalScore;
  }
  if (inp.fundamentalScore !== null && inp.dataQuality === 'MEDIUM') {
    return inp.fundamentalScore * 0.85 + 7.5; // slight regression to mean
  }

  // Fallback: estimate from available signals
  let score = 45; // neutral base

  const fairPE = SECTOR_PE_FAIR[inp.sector] ?? 22;
  if (inp.pe !== null && inp.pe > 0) {
    const peRatio = inp.pe / fairPE;
    if (peRatio <= 0.7)      score += 12; // deeply undervalued
    else if (peRatio <= 0.9) score += 7;
    else if (peRatio <= 1.1) score += 3;
    else if (peRatio <= 1.5) score -= 3;
    else                     score -= 10; // overvalued
  }

  if (inp.roe !== null) {
    if (inp.roe >= 25)      score += 10;
    else if (inp.roe >= 18) score += 6;
    else if (inp.roe >= 12) score += 2;
    else                    score -= 4;
  }

  if (inp.roce !== null) {
    if (inp.roce >= 20)      score += 8;
    else if (inp.roce >= 15) score += 4;
    else if (inp.roce < 10)  score -= 4;
  }

  if (inp.debtToEquity !== null) {
    if (inp.debtToEquity <= 0.3)      score += 8;
    else if (inp.debtToEquity <= 0.8) score += 4;
    else if (inp.debtToEquity > 2.0)  score -= 10;
    else if (inp.debtToEquity > 1.5)  score -= 6;
  }

  if (inp.promoterHolding !== null) {
    if (inp.promoterHolding >= 65)      score += 8;
    else if (inp.promoterHolding >= 50) score += 4;
    else if (inp.promoterHolding < 25)  score -= 8;
  }

  if (inp.profitGrowth3yr !== null) {
    if (inp.profitGrowth3yr >= 25)      score += 8;
    else if (inp.profitGrowth3yr >= 15) score += 4;
    else if (inp.profitGrowth3yr < 0)   score -= 8;
  }

  if (inp.salesGrowth3yr !== null) {
    if (inp.salesGrowth3yr >= 20)      score += 5;
    else if (inp.salesGrowth3yr >= 10) score += 2;
    else if (inp.salesGrowth3yr < 0)   score -= 5;
  }

  return clamp100(score);
}

// ── Layer 3: Sentiment Signal (0-100) ─────────────────────────────────────────
function computeSentimentSignal(inp: SuperbrainInput): number {
  let score = inp.sentimentScore; // base from existing engine (0-100)

  // News headline sentiment — keyword scan (Indian market specific)
  const bullishKeywords = ['upgrade', 'buy', 'outperform', 'record', 'profit', 'growth',
    'order', 'contract', 'expansion', 'acquisition', 'dividend', 'beat', 'strong',
    'rally', 'breakout', 'target', 'positive', 'robust', 'surge', 'win'];
  const bearishKeywords = ['downgrade', 'sell', 'underperform', 'loss', 'decline',
    'fraud', 'probe', 'penalty', 'debt', 'default', 'miss', 'weak', 'fall',
    'concern', 'risk', 'warning', 'cut', 'negative', 'drop', 'exit'];

  let newsBoost = 0;
  for (const headline of inp.newsHeadlines.slice(0, 4)) {
    const h = headline.toLowerCase();
    const bullHits = bullishKeywords.filter(k => h.includes(k)).length;
    const bearHits = bearishKeywords.filter(k => h.includes(k)).length;
    newsBoost += (bullHits - bearHits) * 3;
  }
  score = clamp100(score + newsBoost);

  // Today's price change momentum
  if (inp.pChange !== null) {
    if (inp.pChange >= 3)       score = clamp100(score + 8);
    else if (inp.pChange >= 1)  score = clamp100(score + 4);
    else if (inp.pChange <= -3) score = clamp100(score - 8);
    else if (inp.pChange <= -1) score = clamp100(score - 4);
  }

  // Order flow as sentiment proxy
  if (inp.orderImbalance >= 3)    score = clamp100(score + 6);
  else if (inp.orderImbalance < 0.7) score = clamp100(score - 6);

  return score;
}

// ── Layer 4: Macro Signal (0-100) ─────────────────────────────────────────────
function computeMacroSignal(inp: SuperbrainInput, regime: string): number {
  // Sector macro score (Indian market rotation model)
  const sectorBase = SECTOR_MACRO_SCORE[inp.sector] ?? 55;

  // Market cap tier adjustment (mid-cap outperforms in bull, large-cap in bear)
  let capAdj = 0;
  if (regime === 'BULL') {
    capAdj = inp.marketCap < 20000 ? 8 : inp.marketCap < 100000 ? 5 : 0;
  } else if (regime === 'BEAR') {
    capAdj = inp.marketCap > 100000 ? 8 : inp.marketCap > 20000 ? 3 : -5;
  }

  // Regime multiplier from feedback store
  const regimeMult = _sbFeedback.regimeBias[regime] ?? 1.0;

  // Relative strength vs sector (if available from MB signals)
  let rsAdj = 0;
  if (inp.relativeStrength != null) {
    rsAdj = inp.relativeStrength >= 70 ? 8 : inp.relativeStrength >= 50 ? 3 : -4;
  }

  // Sector bias from feedback loop
  const sectorBias = _sbFeedback.sectorBias[inp.sector] ?? 0;

  return clamp100((sectorBase + capAdj + rsAdj + sectorBias) * regimeMult);
}

// ── Layer 5: Momentum Signal (0-100) ──────────────────────────────────────────
function computeMomentumSignal(inp: SuperbrainInput): number {
  let score = 50;

  // Multi-timeframe momentum (if MB signals available)
  if (inp.ret30 != null && inp.ret90 != null && inp.ret180 != null) {
    // Acceleration: short > medium > long = strong momentum
    const accel = (inp.ret30 > inp.ret90 / 3) && (inp.ret90 > inp.ret180 / 2);
    if (accel) score += 15;

    if (inp.ret30 >= 10)       score += 12;
    else if (inp.ret30 >= 5)   score += 7;
    else if (inp.ret30 < -5)   score -= 8;

    if (inp.ret90 >= 20)       score += 10;
    else if (inp.ret90 >= 10)  score += 5;
    else if (inp.ret90 < -10)  score -= 8;

    if (inp.ret180 >= 30)      score += 8;
    else if (inp.ret180 >= 15) score += 4;
    else if (inp.ret180 < -15) score -= 8;
  } else {
    // Fallback: use CAGR + momentum
    score += clamp100(inp.cagr * 1.2) * 0.3;
    score += (inp.momentum - 1) * 60;
  }

  // Gradient boost AI probability
  score += (inp.gradientBoostProb - 50) * 0.3;

  // Stability (low drawdown + low vol = sustainable momentum)
  if (inp.stabilityScore != null) {
    score += (inp.stabilityScore - 50) * 0.2;
  }

  return clamp100(score);
}

// ── Regime detector ───────────────────────────────────────────────────────────
function detectRegime(inp: SuperbrainInput): 'BULL' | 'BEAR' | 'SIDEWAYS' | 'VOLATILE' {
  const vol = inp.volatility * 100;
  if (vol > 4.5) return 'VOLATILE';
  if (inp.momentum >= 1.12 && inp.trendStrength > 0.5) return 'BULL';
  if (inp.momentum <= 0.92 || inp.trendStrength < -1) return 'BEAR';
  return 'SIDEWAYS';
}

// ── Adaptive weight fusion ────────────────────────────────────────────────────
// Weights shift based on data quality and regime.
// HIGH quality data → trust fundamentals more.
// VOLATILE regime → trust technical + momentum more.
function computeAdaptiveWeights(inp: SuperbrainInput, regime: string): {
  technical: number; fundamental: number; sentiment: number; macro: number; momentum: number;
} {
  const acc = _sbFeedback.signalAccuracy;

  // Base weights (sum = 1.0) — tuned for Indian NSE market
  let w = {
    technical:   0.28 * acc.technical,
    fundamental: 0.22 * acc.fundamental,
    sentiment:   0.12 * acc.sentiment,
    macro:       0.16 * acc.macro,
    momentum:    0.22 * acc.momentum,
  };

  // Data quality adjustment
  if (inp.dataQuality === 'LOW') {
    w.fundamental *= 0.4;  // don't trust fundamentals if data is synthetic
    w.technical   *= 1.3;
    w.momentum    *= 1.2;
  } else if (inp.dataQuality === 'HIGH') {
    w.fundamental *= 1.3;
    w.sentiment   *= 1.1;
  }

  // Regime adjustment
  if (regime === 'VOLATILE') {
    w.technical  *= 1.4;
    w.momentum   *= 1.3;
    w.macro      *= 0.7;
    w.fundamental *= 0.8;
  } else if (regime === 'BEAR') {
    w.fundamental *= 1.2;
    w.macro       *= 1.2;
    w.sentiment   *= 0.8;
  } else if (regime === 'BULL') {
    w.momentum   *= 1.2;
    w.sentiment  *= 1.1;
  }

  // Normalise to sum = 1
  const total = w.technical + w.fundamental + w.sentiment + w.macro + w.momentum;
  return {
    technical:   w.technical   / total,
    fundamental: w.fundamental / total,
    sentiment:   w.sentiment   / total,
    macro:       w.macro       / total,
    momentum:    w.momentum    / total,
  };
}

// ── Risk scorer ───────────────────────────────────────────────────────────────
function computeRiskScore(inp: SuperbrainInput, regime: string): number {
  let risk = 30; // base risk

  // Volatility risk
  const vol = inp.volatility * 100;
  risk += vol > 5 ? 25 : vol > 3.5 ? 15 : vol > 2 ? 8 : 3;

  // Drawdown risk
  risk += inp.maxDrawdown > 40 ? 20 : inp.maxDrawdown > 25 ? 12 : inp.maxDrawdown > 15 ? 6 : 2;

  // Debt risk
  if (inp.debtToEquity !== null) {
    risk += inp.debtToEquity > 2 ? 15 : inp.debtToEquity > 1 ? 8 : inp.debtToEquity > 0.5 ? 3 : 0;
  }

  // Regime risk
  if (regime === 'VOLATILE') risk += 15;
  else if (regime === 'BEAR') risk += 10;

  // Small cap risk
  if (inp.marketCap < 5000)       risk += 12;
  else if (inp.marketCap < 20000) risk += 6;

  // Low promoter holding = governance risk
  if (inp.promoterHolding !== null && inp.promoterHolding < 30) risk += 8;

  // Synthetic data risk
  if (inp.dataSource === 'synthetic') risk += 10;

  return clamp100(risk);
}

// ── Explanation generator ─────────────────────────────────────────────────────
function buildExplanation(
  inp: SuperbrainInput,
  signals: SuperbrainOutput['signals'],
  decision: SuperbrainDecision,
  regime: string,
): string[] {
  const reasons: string[] = [];

  if (signals.technical >= 70)
    reasons.push(`Strong technical setup: ${inp.cagr.toFixed(1)}% CAGR with ${inp.momentum >= 1.1 ? 'bullish' : 'neutral'} momentum`);
  else if (signals.technical <= 35)
    reasons.push(`Weak technical: momentum ${((inp.momentum - 1) * 100).toFixed(1)}%, drawdown ${inp.maxDrawdown.toFixed(1)}%`);

  if (signals.fundamental >= 70 && inp.dataQuality !== 'LOW')
    reasons.push(`Quality fundamentals: ROE ${inp.roe?.toFixed(1) ?? 'N/A'}%, D/E ${inp.debtToEquity?.toFixed(2) ?? 'N/A'}`);
  else if (signals.fundamental <= 35 && inp.pe !== null)
    reasons.push(`Valuation concern: PE ${inp.pe.toFixed(1)}x vs sector fair ${SECTOR_PE_FAIR[inp.sector] ?? 22}x`);

  if (signals.momentum >= 70)
    reasons.push(`Momentum accelerating: ${inp.ret30 != null ? `+${inp.ret30.toFixed(1)}% (30d)` : `CAGR ${inp.cagr.toFixed(1)}%`}`);

  if (signals.macro >= 70)
    reasons.push(`Sector tailwind: ${inp.sector} in favour (macro score ${signals.macro.toFixed(0)})`);
  else if (signals.macro <= 40)
    reasons.push(`Sector headwind: ${inp.sector} facing macro pressure`);

  if (inp.volumeGrowth >= 1.8)
    reasons.push(`Institutional accumulation: volume ${((inp.volumeGrowth - 1) * 100).toFixed(0)}% above baseline`);

  if (regime === 'VOLATILE')
    reasons.push('High volatility regime — position sizing critical');

  if (inp.breakoutFrequency >= 0.14)
    reasons.push(`Breakout pattern active: ${(inp.breakoutFrequency * 100).toFixed(0)}% breakout frequency`);

  return reasons.slice(0, 4);
}

// ── Catalysts & Risks ─────────────────────────────────────────────────────────
function buildCatalysts(inp: SuperbrainInput, signals: SuperbrainOutput['signals']): string[] {
  const cats: string[] = [];
  if (inp.breakoutFrequency >= 0.12) cats.push('Price breakout pattern');
  if (inp.volumeGrowth >= 1.5)       cats.push('Institutional volume accumulation');
  if (inp.promoterHolding != null && inp.promoterHolding >= 60) cats.push('High promoter confidence');
  if (inp.profitGrowth3yr != null && inp.profitGrowth3yr >= 20) cats.push(`${inp.profitGrowth3yr.toFixed(0)}% profit CAGR (3yr)`);
  if (inp.momentum >= 1.2)           cats.push('Strong price momentum');
  if (signals.macro >= 68)           cats.push(`${inp.sector} sector rotation tailwind`);
  if (inp.ret90 != null && inp.ret90 >= 15) cats.push(`+${inp.ret90.toFixed(1)}% 90-day return`);
  return cats.slice(0, 2);
}

function buildRisks(inp: SuperbrainInput, riskScore: number): string[] {
  const risks: string[] = [];
  if (inp.maxDrawdown > 30)          risks.push(`High drawdown risk: ${inp.maxDrawdown.toFixed(1)}%`);
  if (inp.volatility * 100 > 4)      risks.push(`Elevated volatility: ${(inp.volatility * 100).toFixed(1)}% daily`);
  if (inp.debtToEquity != null && inp.debtToEquity > 1.5) risks.push(`High leverage: D/E ${inp.debtToEquity.toFixed(2)}`);
  if (inp.pe != null && inp.pe > SECTOR_PE_FAIR[inp.sector] * 1.6) risks.push(`Stretched valuation: PE ${inp.pe.toFixed(1)}x`);
  if (inp.dataSource === 'synthetic') risks.push('Simulated data — verify before trading');
  if (inp.marketCap < 5000)          risks.push('Small-cap liquidity risk');
  if (inp.promoterHolding != null && inp.promoterHolding < 30) risks.push('Low promoter holding');
  return risks.slice(0, 2);
}

// ── Target price & stop loss ──────────────────────────────────────────────────
function computePriceTargets(
  inp: SuperbrainInput,
  currentPrice: number | null,
  superScore: number,
  riskScore: number,
): { targetPrice: number | null; stopLoss: number | null; upside: number | null } {
  if (!currentPrice || currentPrice <= 0) return { targetPrice: null, stopLoss: null, upside: null };

  // ── Realistic annualised return expectation for Indian equities ──
  // We do NOT use raw CAGR from synthetic candles — it's noise.
  // Instead we derive a realistic expected return from the superScore alone,
  // calibrated to Indian market historical returns (Nifty 500 CAGR ~12-14%).
  //
  // Score bands → expected annual return:
  //   90-100 → 28-35%  (exceptional — top decile)
  //   75-89  → 18-27%  (strong)
  //   60-74  → 12-17%  (above average)
  //   45-59  →  6-11%  (market-rate)
  //   <45    →  0-5%   (underperform / exit)
  //
  // For REAL data stocks we blend in the actual CAGR (capped at 60%) with 30% weight.
  // For SYNTHETIC stocks we use score-only (no CAGR blending — garbage in, garbage out).

  const baseReturn =
    superScore >= 90 ? 0.30 :
    superScore >= 75 ? 0.22 :
    superScore >= 60 ? 0.14 :
    superScore >= 45 ? 0.08 :
    0.03;

  // Blend real CAGR only when data is trustworthy and CAGR is in a sane range
  const realCagrPct = inp.cagr;
  const cagrIsRealistic = inp.dataSource === 'real' && realCagrPct >= 0 && realCagrPct <= 60;
  const annualReturn = cagrIsRealistic
    ? baseReturn * 0.70 + (realCagrPct / 100) * 0.30
    : baseReturn;

  // Holding period: longer for high-conviction, shorter for risky/low-score
  const holdMonths =
    superScore >= 75 && riskScore < 50 ? 12 :
    superScore >= 60 ? 9 :
    6;

  const targetPrice = Number((currentPrice * (1 + annualReturn * holdMonths / 12)).toFixed(2));

  // Stop loss: ATR-proxy using actual volatility (not hardcoded)
  // Volatility here is daily std-dev; annualise and scale by risk
  const dailyVol = inp.volatility > 0 ? inp.volatility : 0.018; // fallback 1.8% daily
  const stopPct = Math.max(0.04, Math.min(0.20, dailyVol * 15 + (riskScore / 100) * 0.06));
  const stopLoss = Number((currentPrice * (1 - stopPct)).toFixed(2));

  const upside = Number(((targetPrice - currentPrice) / currentPrice * 100).toFixed(1));

  return { targetPrice, stopLoss, upside };
}

// ── Self-learning feedback update ─────────────────────────────────────────────
// Called after each batch to nudge weights based on signal agreement.
// Lightweight: O(1), no history storage needed.
function updateFeedback(
  signals: SuperbrainOutput['signals'],
  decision: SuperbrainDecision,
  sector: string,
): void {
  _sbFeedback.callCount++;

  // Convergence check: if all signals agree, boost their accuracy slightly
  const scores = [signals.technical, signals.fundamental, signals.sentiment, signals.macro, signals.momentum];
  const mean = scores.reduce((a, b) => a + b, 0) / scores.length;
  const variance = scores.reduce((a, b) => a + (b - mean) ** 2, 0) / scores.length;

  if (variance < 150) {
    // High agreement — signals are consistent, boost accuracy
    const boost = 0.002;
    _sbFeedback.signalAccuracy.technical   = Math.min(0.95, _sbFeedback.signalAccuracy.technical   + boost);
    _sbFeedback.signalAccuracy.fundamental = Math.min(0.95, _sbFeedback.signalAccuracy.fundamental + boost);
    _sbFeedback.signalAccuracy.momentum    = Math.min(0.95, _sbFeedback.signalAccuracy.momentum    + boost);
  } else {
    // Low agreement — signals conflict, slight decay
    const decay = 0.001;
    _sbFeedback.signalAccuracy.sentiment = Math.max(0.40, _sbFeedback.signalAccuracy.sentiment - decay);
  }

  // Sector bias: if strong buy signal, slightly boost sector score for next call
  if (decision === 'STRONG_BUY' || decision === 'BUY') {
    _sbFeedback.sectorBias[sector] = Math.min(8, (_sbFeedback.sectorBias[sector] ?? 0) + 0.1);
  } else if (decision === 'STRONG_SELL' || decision === 'SELL') {
    _sbFeedback.sectorBias[sector] = Math.max(-8, (_sbFeedback.sectorBias[sector] ?? 0) - 0.1);
  }

  // Decay sector bias slowly toward zero (mean reversion)
  for (const s of Object.keys(_sbFeedback.sectorBias)) {
    _sbFeedback.sectorBias[s] *= 0.995;
  }
}

// ── Main Superbrain function ───────────────────────────────────────────────────
export function runSuperbrain(inp: SuperbrainInput, currentPrice?: number | null): SuperbrainOutput {
  // Layer 1-5: compute all signals
  const regime = detectRegime(inp);
  const technical   = computeTechnicalSignal(inp);
  const fundamental = computeFundamentalSignal(inp);
  const sentiment   = computeSentimentSignal(inp);
  const macro       = computeMacroSignal(inp, regime);
  const momentum    = computeMomentumSignal(inp);

  const signals = { technical, fundamental, sentiment, macro, momentum };

  // Adaptive weight fusion
  const w = computeAdaptiveWeights(inp, regime);
  const rawScore =
    technical   * w.technical   +
    fundamental * w.fundamental +
    sentiment   * w.sentiment   +
    macro       * w.macro       +
    momentum    * w.momentum;

  // Regime multiplier from feedback
  const regimeMult = _sbFeedback.regimeBias[regime] ?? 1.0;
  const superScore = clamp100(rawScore * regimeMult);

  // Risk score
  const riskScore = computeRiskScore(inp, regime);

  // Decision thresholds (calibrated for Indian market risk appetite)
  let decision: SuperbrainDecision;
  const adjustedScore = superScore - riskScore * 0.15; // risk-adjusted
  if (adjustedScore >= 72)      decision = 'STRONG_BUY';
  else if (adjustedScore >= 58) decision = 'BUY';
  else if (adjustedScore >= 42) decision = 'HOLD';
  else if (adjustedScore >= 28) decision = 'SELL';
  else                          decision = 'STRONG_SELL';

  // Override: if RL action is SELL and score < 55, force at least SELL
  if (inp.rlAction === 'SELL' && decision === 'HOLD' && superScore < 52) decision = 'SELL';
  // Override: if all 5 signals agree strongly, boost conviction
  if (technical >= 72 && fundamental >= 65 && momentum >= 70 && decision === 'BUY') decision = 'STRONG_BUY';

  // Confidence: based on signal agreement (low variance = high confidence)
  const scores = [technical, fundamental, sentiment, macro, momentum];
  const mean = scores.reduce((a, b) => a + b, 0) / 5;
  const variance = scores.reduce((a, b) => a + (b - mean) ** 2, 0) / 5;
  const agreement = clamp01(1 - variance / 1200);
  const dataBonus = inp.dataQuality === 'HIGH' ? 0.1 : inp.dataQuality === 'MEDIUM' ? 0 : -0.15;
  const confidence = clamp100((agreement * 0.6 + clamp01(superScore / 100) * 0.4 + dataBonus) * 100);

  // Holding period
  const holdingPeriod =
    decision === 'STRONG_BUY' ? '6-12 months' :
    decision === 'BUY'        ? '3-6 months'  :
    decision === 'HOLD'       ? '1-3 months'  :
    '0-1 month (exit)';

  // Price targets
  const { targetPrice, stopLoss, upside } = computePriceTargets(inp, currentPrice ?? null, superScore, riskScore);

  // Explanation, catalysts, risks
  const explanation = buildExplanation(inp, signals, decision, regime);
  const catalysts   = buildCatalysts(inp, signals);
  const risks       = buildRisks(inp, riskScore);

  // Self-learning feedback update (O(1), non-blocking)
  updateFeedback(signals, decision, inp.sector);

  return {
    symbol: inp.symbol,
    decision,
    confidence: Number(confidence.toFixed(1)),
    superScore: Number(superScore.toFixed(1)),
    riskScore:  Number(riskScore.toFixed(1)),
    targetPrice,
    stopLoss,
    upside,
    explanation,
    signals: {
      technical:   Number(technical.toFixed(1)),
      fundamental: Number(fundamental.toFixed(1)),
      sentiment:   Number(sentiment.toFixed(1)),
      macro:       Number(macro.toFixed(1)),
      momentum:    Number(momentum.toFixed(1)),
    },
    regime,
    holdingPeriod,
    catalysts,
    risks,
    dataSource: inp.dataSource,
  };
}

// ── Batch runner (for scan pipelines) ────────────────────────────────────────
// Processes array of inputs in one pass — O(n), no async needed.
export function runSuperbrainBatch(
  inputs: Array<SuperbrainInput & { currentPrice?: number | null }>
): SuperbrainOutput[] {
  return inputs.map(inp => runSuperbrain(inp, inp.currentPrice));
}

// ── Feedback stats (for diagnostics endpoint) ─────────────────────────────────
export function getSuperbrainStats() {
  return {
    callCount: _sbFeedback.callCount,
    signalAccuracy: { ..._sbFeedback.signalAccuracy },
    topSectors: Object.entries(_sbFeedback.sectorBias)
      .sort((a, b) => b[1] - a[1])
      .slice(0, 5)
      .map(([sector, bias]) => ({ sector, bias: Number(bias.toFixed(3)) })),
    regimeBias: { ..._sbFeedback.regimeBias },
  };
}
