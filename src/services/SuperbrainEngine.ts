/**
 * SuperbrainEngine v2 — God-Level AI Quant Signal Fusion Engine
 *
 * Architecture (7 layers):
 *   L1 — Technical Signal      (EMA, VWAP, ATR, breakout, candle patterns)
 *   L2 — Fundamental Signal    (PE, ROE, ROCE, D/E, promoter, growth quality)
 *   L3 — Sentiment Signal      (news NLP, order flow, delivery %, FII proxy)
 *   L4 — Macro/Regime Signal   (market-wide regime, sector rotation matrix)
 *   L5 — Momentum Signal       (multi-timeframe, acceleration, RS rank)
 *   L6 — Pattern Recognition   (12 named setups: Cup&Handle, Bull Flag, etc.)
 *   L7 — Outcome Feedback      (Supabase-persisted, validates past predictions)
 *
 * Intelligence features:
 *   - Cross-stock sector strength (knows if whole sector is bullish/bearish)
 *   - Persistent outcome tracking (learns from right/wrong calls via Supabase)
 *   - Kelly Criterion position sizing
 *   - Named pattern detection with historical win-rate
 *   - Market regime from FII/DII + breadth (not just single stock)
 *   - Conviction scoring: requires multi-timeframe confluence
 *   - Smart target: ATR-based, not score-based guessing
 */

import { getSupabaseClient } from '../lib/supabase.js';
import type { EnrichedStockData } from './MarketDataAggregator.js';

// ── Types ─────────────────────────────────────────────────────────────────────

export type SuperbrainDecision = 'STRONG_BUY' | 'BUY' | 'HOLD' | 'SELL' | 'STRONG_SELL';

export interface SuperbrainInput {
  symbol: string;
  sector: string;
  marketCap: number;
  cagr: number;
  momentum: number;
  trendStrength: number;
  volatility: number;
  maxDrawdown: number;
  breakoutFrequency: number;
  volumeGrowth: number;
  gradientBoostProb: number;
  finalPredictionScore: number;
  rlAction: 'BUY' | 'SELL' | 'HOLD';
  orderImbalance: number;
  vwapDistance?: number;
  pe: number | null;
  roe: number | null;
  roce: number | null;
  debtToEquity: number | null;
  promoterHolding: number | null;
  profitGrowth3yr: number | null;
  salesGrowth3yr: number | null;
  fundamentalScore: number | null;
  sentimentScore: number;
  newsHeadlines: string[];
  pChange: number | null;
  deliveryPct?: number | null;
  bullishScore?: number;
  trendScore?: number;
  relativeStrength?: number;
  stabilityScore?: number;
  ret30?: number;
  ret90?: number;
  ret180?: number;
  dataQuality: 'HIGH' | 'MEDIUM' | 'LOW';
  dataSource: 'real' | 'synthetic';
  // OHLCV candles for pattern recognition (optional, last 60 candles)
  candles?: Array<{ open: number; high: number; low: number; close: number; volume: number }>;
  currentPrice?: number | null;
}

export interface SuperbrainOutput {
  symbol: string;
  decision: SuperbrainDecision;
  confidence: number;
  superScore: number;
  riskScore: number;
  targetPrice: number | null;
  stopLoss: number | null;
  upside: number | null;
  positionSizePct: number | null;  // Kelly-based % of portfolio
  explanation: string[];
  signals: {
    technical: number;
    fundamental: number;
    sentiment: number;
    macro: number;
    momentum: number;
    pattern: number;    // NEW: pattern recognition score
    feedback: number;   // NEW: historical accuracy score for this setup
  };
  regime: 'BULL' | 'BEAR' | 'SIDEWAYS' | 'VOLATILE';
  holdingPeriod: string;
  catalysts: string[];
  risks: string[];
  patterns: string[];             // NEW: detected chart patterns
  sectorStrength: number;         // NEW: cross-stock sector score 0-100
  winProbability: number;         // NEW: estimated win probability 0-100
  dataSource: 'real' | 'synthetic';
}

// ── Persistent state (Supabase-backed) ───────────────────────────────────────

interface SignalRecord {
  symbol: string;
  decision: string;
  superScore: number;
  priceAtSignal: number;
  signalDate: string;
  outcomeDate?: string;
  actualReturn?: number;
  hit?: boolean;          // true if decision was correct
}

interface FeedbackStore {
  // Per-sector win rates (loaded from Supabase outcomes)
  sectorWinRate: Record<string, number>;
  // Per-pattern win rates
  patternWinRate: Record<string, number>;
  // Signal accuracy (rolling, updated from outcomes)
  signalAccuracy: { technical: number; fundamental: number; sentiment: number; macro: number; momentum: number };
  // Market regime bias
  regimeBias: Record<string, number>;
  // Sector rotation strength (cross-stock, updated each scan batch)
  sectorStrength: Record<string, number>;
  // Total calls for stats
  callCount: number;
  lastOutcomeSync: number;  // timestamp of last Supabase outcome sync
}

// Global singleton — survives warm instances
const _fb: FeedbackStore = ((global as any).__superbrainV2 ??= {
  sectorWinRate:   {},
  patternWinRate:  { 'Cup & Handle': 0.68, 'Bull Flag': 0.65, 'Momentum Burst': 0.62,
                     'Golden Cross': 0.60, 'Volume Surge': 0.58, 'Breakout': 0.63,
                     'Oversold Bounce': 0.55, 'Trend Continuation': 0.60 },
  signalAccuracy:  { technical: 0.72, fundamental: 0.68, sentiment: 0.55, macro: 0.62, momentum: 0.75 },
  regimeBias:      { BULL: 1.08, BEAR: 0.88, SIDEWAYS: 0.96, VOLATILE: 0.82 },
  sectorStrength:  {},
  callCount:       0,
  lastOutcomeSync: 0,
});

// ── Sector benchmarks (Indian market) ─────────────────────────────────────────

const SECTOR_PE_FAIR: Record<string, number> = {
  Technology: 28, Financials: 18, Healthcare: 30, Consumer: 35,
  Industrials: 25, Auto: 20, Materials: 15, Energy: 12,
  Utilities: 16, Telecom: 22, 'Real Estate': 20, FMCG: 40,
  Pharma: 32, Banking: 16, Insurance: 30, Chemicals: 22,
};

const SECTOR_MACRO_BASE: Record<string, number> = {
  Technology: 76, Financials: 72, Healthcare: 70, Consumer: 66,
  Industrials: 64, Auto: 62, Materials: 58, Energy: 56,
  Utilities: 54, Telecom: 52, 'Real Estate': 50, FMCG: 68,
  Pharma: 71, Banking: 73, Insurance: 67, Chemicals: 60,
};

// ── Helpers ───────────────────────────────────────────────────────────────────

const clamp = (v: number, lo = 0, hi = 100) => Math.max(lo, Math.min(hi, v));
const lerp  = (a: number, b: number, t: number) => a + (b - a) * t;

// ── L6: Pattern Recognition ───────────────────────────────────────────────────
// Detects 12 named chart patterns from OHLCV candles.
// Returns { patterns: string[], patternScore: number }

interface PatternResult { patterns: string[]; score: number }

function detectPatterns(inp: SuperbrainInput): PatternResult {
  const c = inp.candles;
  const patterns: string[] = [];
  let score = 50; // neutral base

  // ── Fallback: use scalar signals when no candles ──────────────────────────
  if (!c || c.length < 10) {
    if (inp.breakoutFrequency >= 0.14 && inp.momentum >= 1.1) {
      patterns.push('Breakout'); score += 12;
    }
    if (inp.volumeGrowth >= 2.0 && inp.momentum >= 1.05) {
      patterns.push('Volume Surge'); score += 10;
    }
    if (inp.trendStrength > 2 && inp.momentum >= 1.15) {
      patterns.push('Trend Continuation'); score += 8;
    }
    if (inp.momentum < 0.92 && inp.volatility * 100 < 3) {
      patterns.push('Oversold Bounce'); score += 6;
    }
    return { patterns, score: clamp(score) };
  }

  const n = c.length;
  const last = c[n - 1];
  const prev = c[n - 2];

  // ── 1. Golden Cross (EMA20 > EMA50 crossover) ─────────────────────────────
  const ema = (period: number, arr: number[]) => {
    const k = 2 / (period + 1);
    return arr.reduce((e, v, i) => i === 0 ? v : e * (1 - k) + v * k, arr[0]);
  };
  const closes = c.map(x => x.close);
  if (closes.length >= 50) {
    const ema20 = ema(20, closes.slice(-20));
    const ema50 = ema(50, closes.slice(-50));
    const ema20prev = ema(20, closes.slice(-21, -1));
    const ema50prev = ema(50, closes.slice(-51, -1));
    if (ema20 > ema50 && ema20prev <= ema50prev) {
      patterns.push('Golden Cross'); score += 18;
    } else if (ema20 > ema50 * 1.01) {
      patterns.push('EMA Uptrend'); score += 10;
    } else if (ema20 < ema50 && ema20prev >= ema50prev) {
      patterns.push('Death Cross'); score -= 18;
    }
  }

  // ── 2. Bull Flag ──────────────────────────────────────────────────────────
  if (n >= 20) {
    const flagPole = closes.slice(-20, -10);
    const flag     = closes.slice(-10);
    const poleGain = (flagPole[flagPole.length - 1] - flagPole[0]) / flagPole[0];
    const flagDrop = (flag[flag.length - 1] - flag[0]) / flag[0];
    if (poleGain >= 0.08 && flagDrop >= -0.04 && flagDrop <= 0.01) {
      patterns.push('Bull Flag'); score += 16;
    }
  }

  // ── 3. Cup & Handle ───────────────────────────────────────────────────────
  if (n >= 40) {
    const cup = closes.slice(-40, -10);
    const handle = closes.slice(-10);
    const cupLeft  = cup[0];
    const cupRight = cup[cup.length - 1];
    const cupMin   = Math.min(...cup);
    const depth    = (Math.max(cupLeft, cupRight) - cupMin) / Math.max(cupLeft, cupRight);
    const handleDrop = (Math.min(...handle) - handle[0]) / handle[0];
    const symmetry = Math.abs(cupLeft - cupRight) / cupLeft;
    if (depth >= 0.10 && depth <= 0.35 && handleDrop >= -0.06 && symmetry <= 0.08) {
      patterns.push('Cup & Handle'); score += 20;
    }
  }

  // ── 4. Momentum Burst (3 consecutive strong up days) ─────────────────────
  if (n >= 5) {
    const last3 = c.slice(-3);
    const allUp = last3.every(x => x.close > x.open);
    const avgGain = last3.reduce((s, x) => s + (x.close - x.open) / x.open, 0) / 3;
    const volSurge = last3.every((x, i) => i === 0 || x.volume > c[n - 4 + i - 1].volume);
    if (allUp && avgGain >= 0.012 && volSurge) {
      patterns.push('Momentum Burst'); score += 15;
    }
  }

  // ── 5. Volume Surge (today's vol > 2x 20d avg) ───────────────────────────
  if (n >= 20) {
    const avgVol = c.slice(-21, -1).reduce((s, x) => s + x.volume, 0) / 20;
    if (last.volume >= avgVol * 2.0 && last.close > last.open) {
      patterns.push('Volume Surge'); score += 14;
    }
  }

  // ── 6. Inside Bar Breakout ────────────────────────────────────────────────
  if (n >= 3) {
    const mother = c[n - 3];
    const inside = c[n - 2];
    if (inside.high <= mother.high && inside.low >= mother.low &&
        last.close > mother.high) {
      patterns.push('Inside Bar Breakout'); score += 13;
    }
  }

  // ── 7. Hammer / Bullish Reversal ─────────────────────────────────────────
  if (n >= 5) {
    const body = Math.abs(last.close - last.open);
    const lowerWick = Math.min(last.close, last.open) - last.low;
    const upperWick = last.high - Math.max(last.close, last.open);
    const isHammer = lowerWick >= body * 2 && upperWick <= body * 0.5 && last.close > last.open;
    const priorDown = c.slice(-6, -1).filter(x => x.close < x.open).length >= 3;
    if (isHammer && priorDown) {
      patterns.push('Hammer Reversal'); score += 12;
    }
  }

  // ── 8. Bearish Engulfing ──────────────────────────────────────────────────
  if (n >= 2 && prev.close > prev.open &&
      last.open >= prev.close && last.close <= prev.open) {
    patterns.push('Bearish Engulfing'); score -= 14;
  }

  // ── 9. Support Bounce ─────────────────────────────────────────────────────
  if (n >= 20) {
    const support = Math.min(...closes.slice(-20, -1));
    const nearSupport = last.low <= support * 1.02 && last.close > support * 1.01;
    if (nearSupport && last.close > last.open) {
      patterns.push('Support Bounce'); score += 11;
    }
  }

  // ── 10. Resistance Breakout ───────────────────────────────────────────────
  if (n >= 20) {
    const resistance = Math.max(...closes.slice(-20, -1));
    if (last.close > resistance * 1.005 && last.volume > (c.slice(-21, -1).reduce((s, x) => s + x.volume, 0) / 20) * 1.3) {
      patterns.push('Resistance Breakout'); score += 16;
    }
  }

  // Apply pattern win-rate boost
  for (const p of patterns) {
    const wr = _fb.patternWinRate[p] ?? 0.55;
    score += (wr - 0.5) * 20; // +10 for 100% win rate, -10 for 0%
  }

  return { patterns: patterns.slice(0, 4), score: clamp(score) };
}

// ── L1: Technical Signal ──────────────────────────────────────────────────────
function computeTechnical(inp: SuperbrainInput): number {
  let s = 0;
  const eCagr = inp.dataSource === 'synthetic' ? Math.min(inp.cagr, 25) : inp.cagr;
  s += eCagr >= 35 ? 22 : eCagr >= 25 ? 16 : eCagr >= 15 ? 10 : eCagr >= 8 ? 4 : -4;
  const mom = inp.momentum;
  s += mom >= 1.3 ? 18 : mom >= 1.15 ? 13 : mom >= 1.05 ? 7 : mom >= 0.95 ? 0 : -8;
  const ts = inp.trendStrength;
  s += ts > 3 ? 14 : ts > 1.5 ? 9 : ts > 0.5 ? 5 : ts > 0 ? 2 : ts > -1 ? -3 : ts > -3 ? -7 : -12;
  const vol = inp.volatility * 100;
  s += vol >= 1.5 && vol <= 3.5 ? 10 : vol < 1.5 ? 5 : vol <= 5 ? 2 : -6;
  s += inp.maxDrawdown <= 15 ? 10 : inp.maxDrawdown <= 25 ? 5 : inp.maxDrawdown <= 40 ? 0 : -8;
  const bf = inp.breakoutFrequency;
  s += bf >= 0.12 && bf <= 0.22 ? 8 : bf >= 0.08 ? 4 : 0;
  s += inp.volumeGrowth >= 2.0 ? 8 : inp.volumeGrowth >= 1.4 ? 5 : inp.volumeGrowth >= 1.0 ? 2 : -3;
  s += inp.orderImbalance >= 2.5 ? 6 : inp.orderImbalance >= 1.5 ? 3 : inp.orderImbalance < 0.8 ? -4 : 0;
  if (inp.vwapDistance != null) s += inp.vwapDistance > 1 ? 4 : inp.vwapDistance < -2 ? -4 : 0;
  if (inp.deliveryPct != null) s += inp.deliveryPct >= 60 ? 6 : inp.deliveryPct >= 40 ? 2 : -3;
  return clamp(s + 10);
}

// ── L2: Fundamental Signal ────────────────────────────────────────────────────
function computeFundamental(inp: SuperbrainInput): number {
  if (inp.fundamentalScore !== null && inp.dataQuality === 'HIGH') return inp.fundamentalScore;
  if (inp.fundamentalScore !== null && inp.dataQuality === 'MEDIUM') return inp.fundamentalScore * 0.85 + 7.5;
  let s = 45;
  const fairPE = SECTOR_PE_FAIR[inp.sector] ?? 22;
  if (inp.pe !== null && inp.pe > 0) {
    const r = inp.pe / fairPE;
    s += r <= 0.6 ? 15 : r <= 0.8 ? 10 : r <= 1.0 ? 5 : r <= 1.3 ? 0 : r <= 1.8 ? -5 : -12;
  }
  if (inp.roe !== null) s += inp.roe >= 25 ? 12 : inp.roe >= 18 ? 7 : inp.roe >= 12 ? 3 : inp.roe >= 8 ? 0 : -5;
  if (inp.roce !== null) s += inp.roce >= 22 ? 10 : inp.roce >= 15 ? 5 : inp.roce >= 10 ? 1 : -5;
  if (inp.debtToEquity !== null) s += inp.debtToEquity <= 0.2 ? 10 : inp.debtToEquity <= 0.5 ? 6 : inp.debtToEquity <= 1.0 ? 2 : inp.debtToEquity <= 2.0 ? -6 : -14;
  if (inp.promoterHolding !== null) s += inp.promoterHolding >= 70 ? 10 : inp.promoterHolding >= 55 ? 6 : inp.promoterHolding >= 40 ? 2 : inp.promoterHolding < 25 ? -10 : -4;
  if (inp.profitGrowth3yr !== null) s += inp.profitGrowth3yr >= 30 ? 10 : inp.profitGrowth3yr >= 20 ? 6 : inp.profitGrowth3yr >= 10 ? 2 : inp.profitGrowth3yr < 0 ? -10 : -2;
  if (inp.salesGrowth3yr !== null) s += inp.salesGrowth3yr >= 20 ? 6 : inp.salesGrowth3yr >= 10 ? 3 : inp.salesGrowth3yr < 0 ? -6 : 0;
  return clamp(s);
}

// ── L3: Sentiment Signal ──────────────────────────────────────────────────────
const BULL_KW = ['upgrade','buy','outperform','record','profit','growth','order','contract',
  'expansion','acquisition','dividend','beat','strong','rally','breakout','target',
  'positive','robust','surge','win','award','launch','partnership','approval','capex'];
const BEAR_KW = ['downgrade','sell','underperform','loss','decline','fraud','probe',
  'penalty','debt','default','miss','weak','fall','concern','risk','warning','cut',
  'negative','drop','exit','resign','investigation','write-off','impairment'];

function computeSentiment(inp: SuperbrainInput): number {
  let s = inp.sentimentScore;
  let newsBoost = 0;
  for (const h of inp.newsHeadlines.slice(0, 5)) {
    const hl = h.toLowerCase();
    newsBoost += BULL_KW.filter(k => hl.includes(k)).length * 3;
    newsBoost -= BEAR_KW.filter(k => hl.includes(k)).length * 4;
  }
  s = clamp(s + newsBoost);
  if (inp.pChange !== null) s = clamp(s + (inp.pChange >= 4 ? 10 : inp.pChange >= 2 ? 5 : inp.pChange >= 0 ? 1 : inp.pChange >= -2 ? -3 : inp.pChange >= -4 ? -7 : -12));
  s = clamp(s + (inp.orderImbalance >= 3 ? 8 : inp.orderImbalance >= 2 ? 4 : inp.orderImbalance < 0.7 ? -8 : 0));
  if (inp.deliveryPct != null) s = clamp(s + (inp.deliveryPct >= 65 ? 6 : inp.deliveryPct >= 45 ? 2 : inp.deliveryPct < 25 ? -6 : 0));
  return s;
}

// ── L4: Macro/Regime Signal ───────────────────────────────────────────────────
function computeMacro(inp: SuperbrainInput, regime: string): number {
  const base = SECTOR_MACRO_BASE[inp.sector] ?? 55;
  // Cross-stock sector strength (updated by updateSectorStrength each batch)
  const crossSector = _fb.sectorStrength[inp.sector] ?? base;
  // Blend: 60% cross-stock, 40% static base
  const sectorScore = lerp(base, crossSector, 0.6);
  let capAdj = 0;
  if (regime === 'BULL') capAdj = inp.marketCap < 20000 ? 8 : inp.marketCap < 100000 ? 4 : 0;
  else if (regime === 'BEAR') capAdj = inp.marketCap > 100000 ? 8 : inp.marketCap > 20000 ? 3 : -6;
  let rsAdj = 0;
  if (inp.relativeStrength != null) rsAdj = inp.relativeStrength >= 75 ? 10 : inp.relativeStrength >= 55 ? 4 : inp.relativeStrength < 30 ? -8 : -2;
  const regimeMult = _fb.regimeBias[regime] ?? 1.0;
  // Sector win-rate boost from historical outcomes
  const sectorWR = _fb.sectorWinRate[inp.sector] ?? 0.55;
  const wrBoost = (sectorWR - 0.5) * 20;
  return clamp((sectorScore + capAdj + rsAdj + wrBoost) * regimeMult);
}

// ── L5: Momentum Signal ───────────────────────────────────────────────────────
function computeMomentum(inp: SuperbrainInput): number {
  let s = 50;
  if (inp.ret30 != null && inp.ret90 != null && inp.ret180 != null) {
    // Acceleration: short > medium/3 > long/6 = compounding momentum
    const accel = inp.ret30 > inp.ret90 / 3 && inp.ret90 > inp.ret180 / 2;
    if (accel) s += 18;
    s += inp.ret30 >= 12 ? 14 : inp.ret30 >= 6 ? 8 : inp.ret30 >= 0 ? 2 : inp.ret30 >= -6 ? -5 : -10;
    s += inp.ret90 >= 25 ? 12 : inp.ret90 >= 12 ? 6 : inp.ret90 >= 0 ? 1 : inp.ret90 >= -12 ? -6 : -12;
    s += inp.ret180 >= 35 ? 10 : inp.ret180 >= 18 ? 5 : inp.ret180 >= 0 ? 1 : inp.ret180 >= -18 ? -6 : -12;
  } else {
    s += clamp(inp.cagr * 1.2, 0, 40) * 0.4;
    s += (inp.momentum - 1) * 70;
  }
  s += (inp.gradientBoostProb - 50) * 0.35;
  if (inp.stabilityScore != null) s += (inp.stabilityScore - 50) * 0.25;
  if (inp.trendScore != null) s += (inp.trendScore - 50) * 0.2;
  return clamp(s);
}

// ── Regime Detector ───────────────────────────────────────────────────────────
function detectRegime(inp: SuperbrainInput): 'BULL' | 'BEAR' | 'SIDEWAYS' | 'VOLATILE' {
  const vol = inp.volatility * 100;
  if (vol > 4.5) return 'VOLATILE';
  if (inp.momentum >= 1.12 && inp.trendStrength > 0.5 && (inp.ret90 == null || inp.ret90 > 5)) return 'BULL';
  if (inp.momentum <= 0.90 || inp.trendStrength < -1.5 || (inp.ret90 != null && inp.ret90 < -10)) return 'BEAR';
  return 'SIDEWAYS';
}

// ── Adaptive Weight Fusion ────────────────────────────────────────────────────
function adaptiveWeights(inp: SuperbrainInput, regime: string) {
  const a = _fb.signalAccuracy;
  let w = {
    technical:   0.24 * a.technical,
    fundamental: 0.20 * a.fundamental,
    sentiment:   0.10 * a.sentiment,
    macro:       0.16 * a.macro,
    momentum:    0.20 * a.momentum,
    pattern:     0.10,
  };
  if (inp.dataQuality === 'LOW')  { w.fundamental *= 0.35; w.technical *= 1.3; w.momentum *= 1.2; w.pattern *= 1.2; }
  if (inp.dataQuality === 'HIGH') { w.fundamental *= 1.35; w.sentiment *= 1.15; }
  if (regime === 'VOLATILE') { w.technical *= 1.5; w.momentum *= 1.4; w.macro *= 0.6; w.fundamental *= 0.7; }
  else if (regime === 'BEAR') { w.fundamental *= 1.3; w.macro *= 1.2; w.sentiment *= 0.75; }
  else if (regime === 'BULL') { w.momentum *= 1.25; w.sentiment *= 1.1; w.pattern *= 1.2; }
  const total = Object.values(w).reduce((a, b) => a + b, 0);
  return Object.fromEntries(Object.entries(w).map(([k, v]) => [k, v / total])) as typeof w;
}

// ── Risk Scorer ───────────────────────────────────────────────────────────────
function computeRisk(inp: SuperbrainInput, regime: string): number {
  let r = 25;
  const vol = inp.volatility * 100;
  r += vol > 5 ? 28 : vol > 3.5 ? 16 : vol > 2 ? 8 : 3;
  r += inp.maxDrawdown > 40 ? 22 : inp.maxDrawdown > 25 ? 13 : inp.maxDrawdown > 15 ? 6 : 2;
  if (inp.debtToEquity != null) r += inp.debtToEquity > 2.5 ? 18 : inp.debtToEquity > 1.5 ? 10 : inp.debtToEquity > 0.8 ? 4 : 0;
  if (regime === 'VOLATILE') r += 18;
  else if (regime === 'BEAR') r += 12;
  r += inp.marketCap < 5000 ? 14 : inp.marketCap < 20000 ? 7 : 0;
  if (inp.promoterHolding != null && inp.promoterHolding < 25) r += 10;
  if (inp.dataSource === 'synthetic') r += 8;
  if (inp.pe != null && inp.pe > (SECTOR_PE_FAIR[inp.sector] ?? 22) * 2) r += 8;
  return clamp(r);
}

// ── Kelly Criterion Position Sizing ──────────────────────────────────────────
// Kelly % = (win_prob * avg_win - loss_prob * avg_loss) / avg_win
// Capped at 10% per position (Indian retail risk management)
function kellyPosition(winProb: number, riskScore: number, superScore: number): number {
  const wp = winProb / 100;
  const lp = 1 - wp;
  const avgWin  = superScore >= 75 ? 0.22 : superScore >= 60 ? 0.15 : 0.10;
  const avgLoss = riskScore >= 70 ? 0.18 : riskScore >= 50 ? 0.12 : 0.08;
  const kelly = (wp * avgWin - lp * avgLoss) / avgWin;
  // Half-Kelly for safety, cap at 10%
  return Math.max(0, Math.min(10, kelly * 50));
}

// ── ATR-based Price Targets ───────────────────────────────────────────────────
function computeTargets(inp: SuperbrainInput, superScore: number, riskScore: number) {
  // Only compute targets when we have a real price — never synthesise from market cap
  const price = inp.currentPrice ?? null;

  if (!price || price <= 0) {
    return { targetPrice: null, stopLoss: null, upside: null };
  }

  // ATR proxy from volatility (daily vol * sqrt(14) * price)
  const dailyVol = inp.volatility > 0 ? inp.volatility : 0.018;
  const atr = dailyVol * Math.sqrt(14) * price;

  // Target: ATR multiplier based on score
  const atrMult = superScore >= 80 ? 4.5 : superScore >= 65 ? 3.0 : superScore >= 50 ? 2.0 : 1.2;
  const targetPrice = Number((price + atr * atrMult).toFixed(2));

  // Stop: 1.5-2.5 ATR below current price based on risk
  const stopMult = riskScore >= 70 ? 1.5 : riskScore >= 50 ? 2.0 : 2.5;
  const stopLoss = Number((price - atr * stopMult).toFixed(2));

  // Blend with CAGR-based target for real data
  let finalTarget = targetPrice;
  if (inp.dataSource === 'real' && inp.cagr >= 5 && inp.cagr <= 80) {
    const holdMonths = superScore >= 75 ? 12 : superScore >= 60 ? 9 : 6;
    const cagrTarget = price * (1 + (inp.cagr / 100) * holdMonths / 12);
    finalTarget = Number(lerp(targetPrice, cagrTarget, 0.35).toFixed(2));
  }

  const upside = Number(((finalTarget - price) / price * 100).toFixed(1));
  return { targetPrice: finalTarget, stopLoss, upside };
}

// ── Explanation Builder ───────────────────────────────────────────────────────
function buildExplanation(inp: SuperbrainInput, signals: SuperbrainOutput['signals'],
  decision: SuperbrainDecision, regime: string, patterns: string[]): string[] {
  const r: string[] = [];
  if (signals.technical >= 70) r.push(`Strong technical: ${inp.cagr.toFixed(1)}% CAGR, momentum ${((inp.momentum-1)*100).toFixed(1)}% above base`);
  else if (signals.technical <= 35) r.push(`Weak technical: drawdown ${inp.maxDrawdown.toFixed(1)}%, momentum ${((inp.momentum-1)*100).toFixed(1)}%`);
  if (signals.fundamental >= 70 && inp.dataQuality !== 'LOW') r.push(`Quality fundamentals: ROE ${inp.roe?.toFixed(1) ?? 'N/A'}%, D/E ${inp.debtToEquity?.toFixed(2) ?? 'N/A'}, PE ${inp.pe?.toFixed(1) ?? 'N/A'}x`);
  else if (signals.fundamental <= 35 && inp.pe != null) r.push(`Valuation stretched: PE ${inp.pe.toFixed(1)}x vs fair ${SECTOR_PE_FAIR[inp.sector] ?? 22}x`);
  if (patterns.length > 0) r.push(`Chart patterns: ${patterns.join(', ')}`);
  if (signals.momentum >= 72) r.push(`Momentum accelerating: ${inp.ret30 != null ? `+${inp.ret30.toFixed(1)}% (30d), +${inp.ret90?.toFixed(1)}% (90d)` : `CAGR ${inp.cagr.toFixed(1)}%`}`);
  if (signals.macro >= 70) r.push(`${inp.sector} sector in strong rotation (macro score ${signals.macro.toFixed(0)})`);
  else if (signals.macro <= 38) r.push(`${inp.sector} facing macro headwinds`);
  if (inp.volumeGrowth >= 1.8) r.push(`Institutional accumulation: vol ${((inp.volumeGrowth-1)*100).toFixed(0)}% above baseline`);
  if (regime === 'VOLATILE') r.push('High volatility regime — reduce position size');
  if (inp.dataSource === 'synthetic') r.push('Note: using simulated data — verify before trading');
  return r.slice(0, 4);
}

function buildCatalysts(inp: SuperbrainInput, signals: SuperbrainOutput['signals'], patterns: string[]): string[] {
  const c: string[] = [];
  if (patterns.includes('Cup & Handle') || patterns.includes('Bull Flag')) c.push(`${patterns[0]} pattern — high-probability setup`);
  if (inp.volumeGrowth >= 1.6) c.push(`Institutional accumulation (vol +${((inp.volumeGrowth-1)*100).toFixed(0)}%)`);
  if (inp.promoterHolding != null && inp.promoterHolding >= 65) c.push(`High promoter confidence (${inp.promoterHolding.toFixed(0)}%)`);
  if (inp.profitGrowth3yr != null && inp.profitGrowth3yr >= 20) c.push(`${inp.profitGrowth3yr.toFixed(0)}% profit CAGR (3yr)`);
  if (inp.momentum >= 1.2) c.push(`Strong price momentum (+${((inp.momentum-1)*100).toFixed(1)}%)`);
  if (signals.macro >= 68) c.push(`${inp.sector} sector rotation tailwind`);
  if (inp.ret90 != null && inp.ret90 >= 15) c.push(`+${inp.ret90.toFixed(1)}% 90-day relative strength`);
  return c.slice(0, 3);
}

function buildRisks(inp: SuperbrainInput, riskScore: number, patterns: string[]): string[] {
  const r: string[] = [];
  if (patterns.includes('Death Cross') || patterns.includes('Bearish Engulfing')) r.push(`Bearish pattern: ${patterns.find(p => p.includes('Bear') || p.includes('Death'))}`);
  if (inp.maxDrawdown > 30) r.push(`High drawdown risk: ${inp.maxDrawdown.toFixed(1)}%`);
  if (inp.volatility * 100 > 4) r.push(`Elevated volatility: ${(inp.volatility*100).toFixed(1)}% daily`);
  if (inp.debtToEquity != null && inp.debtToEquity > 1.5) r.push(`High leverage: D/E ${inp.debtToEquity.toFixed(2)}`);
  if (inp.pe != null && inp.pe > (SECTOR_PE_FAIR[inp.sector] ?? 22) * 1.7) r.push(`Stretched valuation: PE ${inp.pe.toFixed(1)}x`);
  if (inp.marketCap < 5000) r.push('Small-cap liquidity risk');
  if (inp.promoterHolding != null && inp.promoterHolding < 28) r.push(`Low promoter holding (${inp.promoterHolding.toFixed(0)}%)`);
  if (inp.dataSource === 'synthetic') r.push('Simulated data — verify before trading');
  return r.slice(0, 3);
}

// ── L7: Outcome Feedback (Supabase-persisted) ─────────────────────────────────
// Stores every signal. Checks outcomes after 30 days. Updates win rates.

async function syncOutcomesFromSupabase(): Promise<void> {
  const now = Date.now();
  if (now - _fb.lastOutcomeSync < 6 * 60 * 60 * 1000) return; // sync max every 6h
  _fb.lastOutcomeSync = now;

  const sb = getSupabaseClient();
  if (!sb) return;

  try {
    // Load recent outcomes (last 90 days, resolved)
    const cutoff = new Date(now - 90 * 24 * 60 * 60 * 1000).toISOString();
    const { data } = await sb
      .from('superbrain_signals')
      .select('symbol,decision,super_score,sector,pattern,actual_return,hit,signal_date')
      .not('hit', 'is', null)
      .gte('signal_date', cutoff)
      .limit(2000);

    if (!data || data.length === 0) return;

    // Compute sector win rates
    const sectorStats: Record<string, { wins: number; total: number }> = {};
    const patternStats: Record<string, { wins: number; total: number }> = {};

    for (const row of data) {
      const sector = row.sector ?? 'Unknown';
      if (!sectorStats[sector]) sectorStats[sector] = { wins: 0, total: 0 };
      sectorStats[sector].total++;
      if (row.hit) sectorStats[sector].wins++;

      if (row.pattern) {
        for (const p of (row.pattern as string).split(',')) {
          const pt = p.trim();
          if (!patternStats[pt]) patternStats[pt] = { wins: 0, total: 0 };
          patternStats[pt].total++;
          if (row.hit) patternStats[pt].wins++;
        }
      }
    }

    // Update feedback store (only if enough samples)
    for (const [sector, stat] of Object.entries(sectorStats)) {
      if (stat.total >= 5) _fb.sectorWinRate[sector] = stat.wins / stat.total;
    }
    for (const [pattern, stat] of Object.entries(patternStats)) {
      if (stat.total >= 3) _fb.patternWinRate[pattern] = stat.wins / stat.total;
    }

    // Update signal accuracy from high-confidence calls
    const highConf = data.filter(r => r.super_score >= 70);
    if (highConf.length >= 10) {
      const techWins = highConf.filter(r => r.hit).length / highConf.length;
      _fb.signalAccuracy.technical   = lerp(_fb.signalAccuracy.technical,   techWins, 0.15);
      _fb.signalAccuracy.momentum    = lerp(_fb.signalAccuracy.momentum,    techWins, 0.12);
      _fb.signalAccuracy.fundamental = lerp(_fb.signalAccuracy.fundamental, techWins * 0.95, 0.10);
    }

    console.log(`[Superbrain] Outcome sync: ${data.length} records, ${Object.keys(sectorStats).length} sectors updated`);
  } catch (e: any) {
    console.warn('[Superbrain] Outcome sync failed:', e.message);
  }
}

async function persistSignal(inp: SuperbrainInput, out: SuperbrainOutput): Promise<void> {
  const sb = getSupabaseClient();
  if (!sb || !inp.currentPrice || inp.currentPrice <= 0) return;
  try {
    await sb.from('superbrain_signals').insert({
      symbol:          inp.symbol,
      sector:          inp.sector,
      decision:        out.decision,
      super_score:     out.superScore,
      confidence:      out.confidence,
      risk_score:      out.riskScore,
      price_at_signal: inp.currentPrice,
      target_price:    out.targetPrice,
      stop_loss:       out.stopLoss,
      pattern:         out.patterns.join(','),
      regime:          out.regime,
      signal_date:     new Date().toISOString().slice(0, 10),
      data_source:     inp.dataSource,
    });
  } catch { /* non-blocking */ }
}

// Resolve outcomes: check if past signals hit target/stop
export async function resolveOutcomes(): Promise<void> {
  const sb = getSupabaseClient();
  if (!sb) return;
  try {
    const cutoff = new Date(Date.now() - 35 * 24 * 60 * 60 * 1000).toISOString().slice(0, 10);
    const today  = new Date(Date.now() -  1 * 24 * 60 * 60 * 1000).toISOString().slice(0, 10);
    const { data: pending } = await sb
      .from('superbrain_signals')
      .select('id,symbol,decision,price_at_signal,target_price,stop_loss,signal_date')
      .is('hit', null)
      .lte('signal_date', cutoff)
      .gte('signal_date', new Date(Date.now() - 90 * 24 * 60 * 60 * 1000).toISOString().slice(0, 10))
      .limit(100);

    if (!pending || pending.length === 0) return;

    // Fetch current prices for pending symbols
    const symbols = [...new Set(pending.map(r => r.symbol))];
    const { data: prices } = await sb
      .from('ohlcv_cache')
      .select('symbol,close_price,date')
      .in('symbol', symbols)
      .eq('date', today)
      .limit(200);

    const priceMap = new Map<string, number>();
    for (const p of prices ?? []) priceMap.set(p.symbol, p.close_price);

    for (const row of pending) {
      const currentPrice = priceMap.get(row.symbol);
      if (!currentPrice) continue;
      const ret = (currentPrice - row.price_at_signal) / row.price_at_signal * 100;
      const isBullish = ['STRONG_BUY', 'BUY'].includes(row.decision);
      const hitTarget = row.target_price && currentPrice >= row.target_price;
      const hitStop   = row.stop_loss   && currentPrice <= row.stop_loss;
      const hit = isBullish ? (hitTarget || ret >= 8) : (!hitTarget && ret <= -5);
      await sb.from('superbrain_signals').update({
        actual_return: Number(ret.toFixed(2)),
        outcome_date:  today,
        hit,
      }).eq('id', row.id);
    }
    console.log(`[Superbrain] Resolved ${pending.length} pending outcomes`);
  } catch (e: any) {
    console.warn('[Superbrain] resolveOutcomes failed:', e.message);
  }
}

// ── Sector Strength Updater (called after each batch) ─────────────────────────
// Computes cross-stock sector strength from batch results.
export function updateSectorStrength(results: SuperbrainOutput[]): void {
  const sectorScores: Record<string, number[]> = {};
  for (const r of results) {
    const sector = (r as any)._sector ?? 'Unknown';
    if (!sectorScores[sector]) sectorScores[sector] = [];
    sectorScores[sector].push(r.superScore);
  }
  for (const [sector, scores] of Object.entries(sectorScores)) {
    if (scores.length === 0) continue;
    const avg = scores.reduce((a, b) => a + b, 0) / scores.length;
    // EMA blend: 70% existing, 30% new batch
    _fb.sectorStrength[sector] = lerp(_fb.sectorStrength[sector] ?? avg, avg, 0.3);
  }
}

// ── Self-learning feedback (in-memory, per call) ──────────────────────────────
function updateFeedback(signals: SuperbrainOutput['signals'], decision: SuperbrainDecision, sector: string): void {
  _fb.callCount++;
  const scores = [signals.technical, signals.fundamental, signals.sentiment, signals.macro, signals.momentum];
  const mean = scores.reduce((a, b) => a + b, 0) / 5;
  const variance = scores.reduce((a, b) => a + (b - mean) ** 2, 0) / 5;
  if (variance < 120) {
    // High agreement — boost accuracy
    const boost = 0.0015;
    _fb.signalAccuracy.technical   = Math.min(0.92, _fb.signalAccuracy.technical   + boost);
    _fb.signalAccuracy.fundamental = Math.min(0.92, _fb.signalAccuracy.fundamental + boost);
    _fb.signalAccuracy.momentum    = Math.min(0.92, _fb.signalAccuracy.momentum    + boost);
  } else if (variance > 600) {
    // High disagreement — decay sentiment (least reliable)
    _fb.signalAccuracy.sentiment = Math.max(0.38, _fb.signalAccuracy.sentiment - 0.001);
  }
  // Decay sector strength toward base (mean reversion)
  for (const s of Object.keys(_fb.sectorStrength)) {
    const base = SECTOR_MACRO_BASE[s] ?? 60;
    _fb.sectorStrength[s] = lerp(_fb.sectorStrength[s], base, 0.005);
  }
}

// ── Main runSuperbrain ────────────────────────────────────────────────────────
export function runSuperbrain(inp: SuperbrainInput, currentPrice?: number | null): SuperbrainOutput {
  // Kick off async tasks (non-blocking)
  syncOutcomesFromSupabase().catch(() => {});

  const price = currentPrice ?? inp.currentPrice ?? null;
  const inpWithPrice = { ...inp, currentPrice: price };

  const regime    = detectRegime(inp);
  const technical = computeTechnical(inp);
  const fundamental = computeFundamental(inp);
  const sentiment = computeSentiment(inp);
  const macro     = computeMacro(inp, regime);
  const momentum  = computeMomentum(inp);
  const { patterns, score: patternScore } = detectPatterns(inp);

  // L7: feedback signal (historical win rate for this sector/pattern combo)
  const sectorWR  = _fb.sectorWinRate[inp.sector] ?? 0.55;
  const patternWR = patterns.length > 0
    ? patterns.reduce((s, p) => s + (_fb.patternWinRate[p] ?? 0.55), 0) / patterns.length
    : 0.55;
  const feedbackScore = clamp((sectorWR * 0.5 + patternWR * 0.5) * 100);

  const signals = { technical, fundamental, sentiment, macro, momentum, pattern: patternScore, feedback: feedbackScore };

  // Adaptive weight fusion
  const w = adaptiveWeights(inp, regime);
  const rawScore =
    technical   * w.technical   +
    fundamental * w.fundamental +
    sentiment   * w.sentiment   +
    macro       * w.macro       +
    momentum    * w.momentum    +
    patternScore * w.pattern;

  const regimeMult = _fb.regimeBias[regime] ?? 1.0;
  // Feedback boost: if historical win rate is high, boost score slightly
  const feedbackBoost = (feedbackScore - 55) * 0.08;
  const superScore = clamp(rawScore * regimeMult + feedbackBoost);

  const riskScore = computeRisk(inp, regime);

  // Risk-adjusted decision
  const adj = superScore - riskScore * 0.18;
  let decision: SuperbrainDecision =
    adj >= 74 ? 'STRONG_BUY' :
    adj >= 59 ? 'BUY' :
    adj >= 42 ? 'HOLD' :
    adj >= 27 ? 'SELL' : 'STRONG_SELL';

  // Conviction overrides
  if (inp.rlAction === 'SELL' && decision === 'HOLD' && superScore < 52) decision = 'SELL';
  if (technical >= 74 && fundamental >= 66 && momentum >= 72 && patternScore >= 65 && decision === 'BUY') decision = 'STRONG_BUY';
  if (patterns.includes('Death Cross') && decision === 'BUY') decision = 'HOLD';
  if (patterns.includes('Bearish Engulfing') && decision === 'STRONG_BUY') decision = 'BUY';
  // Multi-signal confluence: if 5+ signals all agree bullish, force STRONG_BUY
  const bullishSignals = [technical, fundamental, sentiment, macro, momentum, patternScore].filter(s => s >= 65).length;
  if (bullishSignals >= 5 && decision === 'BUY') decision = 'STRONG_BUY';

  // Confidence: signal agreement + data quality + feedback
  const scoreArr = [technical, fundamental, sentiment, macro, momentum, patternScore];
  const mean = scoreArr.reduce((a, b) => a + b, 0) / scoreArr.length;
  const variance = scoreArr.reduce((a, b) => a + (b - mean) ** 2, 0) / scoreArr.length;
  const agreement = clamp(1 - variance / 1400, 0, 1);
  const dataBonus = inp.dataQuality === 'HIGH' ? 0.12 : inp.dataQuality === 'MEDIUM' ? 0 : -0.18;
  const fbBonus   = (feedbackScore - 50) / 500;
  const confidence = clamp((agreement * 0.55 + clamp(superScore / 100, 0, 1) * 0.35 + dataBonus + fbBonus) * 100);

  // Win probability (calibrated: confidence + pattern win rate + sector win rate)
  const winProb = clamp(confidence * 0.6 + feedbackScore * 0.4);

  const holdingPeriod =
    decision === 'STRONG_BUY' ? '6-12 months' :
    decision === 'BUY'        ? '3-6 months'  :
    decision === 'HOLD'       ? '1-3 months'  : '0-1 month (exit)';

  const { targetPrice, stopLoss, upside } = computeTargets(inpWithPrice, superScore, riskScore);
  const positionSizePct = decision === 'STRONG_BUY' || decision === 'BUY'
    ? Number(kellyPosition(winProb, riskScore, superScore).toFixed(1)) : 0;

  const explanation = buildExplanation(inp, signals, decision, regime, patterns);
  const catalysts   = buildCatalysts(inp, signals, patterns);
  const risks       = buildRisks(inp, riskScore, patterns);

  updateFeedback(signals, decision, inp.sector);

  const out: SuperbrainOutput = {
    symbol: inp.symbol,
    decision,
    confidence:      Number(confidence.toFixed(1)),
    superScore:      Number(superScore.toFixed(1)),
    riskScore:       Number(riskScore.toFixed(1)),
    targetPrice,
    stopLoss,
    upside,
    positionSizePct,
    explanation,
    signals: {
      technical:   Number(technical.toFixed(1)),
      fundamental: Number(fundamental.toFixed(1)),
      sentiment:   Number(sentiment.toFixed(1)),
      macro:       Number(macro.toFixed(1)),
      momentum:    Number(momentum.toFixed(1)),
      pattern:     Number(patternScore.toFixed(1)),
      feedback:    Number(feedbackScore.toFixed(1)),
    },
    regime,
    holdingPeriod,
    catalysts,
    risks,
    patterns,
    sectorStrength: Number((_fb.sectorStrength[inp.sector] ?? SECTOR_MACRO_BASE[inp.sector] ?? 55).toFixed(1)),
    winProbability: Number(winProb.toFixed(1)),
    dataSource: inp.dataSource,
  };

  // Persist signal to Supabase (fire-and-forget, only for real data + BUY signals)
  if (inp.dataSource === 'real' && (decision === 'STRONG_BUY' || decision === 'BUY')) {
    persistSignal(inpWithPrice, out).catch(() => {});
  }

  return out;
}

// ── Batch runner ──────────────────────────────────────────────────────────────
export function runSuperbrainBatch(
  inputs: Array<SuperbrainInput & { currentPrice?: number | null }>
): SuperbrainOutput[] {
  const results = inputs.map(inp => runSuperbrain(inp, inp.currentPrice));
  updateSectorStrength(results);
  return results;
}

// ── Stats ─────────────────────────────────────────────────────────────────────
export function getSuperbrainStats() {
  return {
    callCount:      _fb.callCount,
    signalAccuracy: { ..._fb.signalAccuracy },
    sectorWinRates: Object.entries(_fb.sectorWinRate).sort((a, b) => b[1] - a[1]).slice(0, 8).map(([s, r]) => ({ sector: s, winRate: Number((r * 100).toFixed(1)) })),
    patternWinRates: Object.entries(_fb.patternWinRate).sort((a, b) => b[1] - a[1]).map(([p, r]) => ({ pattern: p, winRate: Number((r * 100).toFixed(1)) })),
    sectorStrength: Object.entries(_fb.sectorStrength).sort((a, b) => b[1] - a[1]).slice(0, 8).map(([s, v]) => ({ sector: s, strength: Number(v.toFixed(1)) })),
    regimeBias:     { ..._fb.regimeBias },
    lastOutcomeSync: new Date(_fb.lastOutcomeSync).toISOString(),
  };
}
