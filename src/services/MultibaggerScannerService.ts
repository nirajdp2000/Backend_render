import { fetchJson } from '../lib/api';

// ─── Types ────────────────────────────────────────────────────────────────────

/** Supported scan cycle durations in days */
export type ScanCycle = 30 | 60 | 90 | 120 | 180 | 300;

/**
 * A single stock entry returned by the hedge-fund grade scanner.
 *
 * Final BullishScore formula:
 *   Score = (trendScore × w.trend) + (momentumScore × w.momentum)
 *         + (relativeStrength × w.relStrength) + (volumeScore × w.volume)
 *         + (breakoutScore × w.breakout) + (sectorScore × w.sector)
 *         + (stabilityScore × w.stability)
 *
 * Weights shift per cycle (short → momentum/breakout heavy,
 * long → trend/stability heavy).
 */
export interface MultibaggerStock {
  rank: number;
  symbol: string;
  companyName: string;
  sector: string;

  // ── Composite score ──────────────────────────────────────────────────────
  /** Final weighted bullish score 0–100 */
  bullishScore: number;

  // ── Individual factor scores (all 0–100) ─────────────────────────────────
  /** MA alignment: Price>50DMA(+40) + 50DMA>200DMA(+30) + Price>200DMA(+30) + slope bonus */
  trendScore: number;
  /** Weighted blend: ret30d×0.5 + ret90d×0.3 + ret180d×0.2, cross-sectionally normalised */
  momentumScore: number;
  /** Percentile rank of cycle return vs universe (100 = best performer) */
  relativeStrength: number;
  /** Volume accumulation(+50) + spike(+50) */
  volumeScore: number;
  /** 52-week proximity(+50) + recent breakout(+50) */
  breakoutScore: number;
  /** Sector average return percentile rank */
  sectorScore: number;
  /** Inverse annualised volatility: lower vol → higher score */
  stabilityScore: number;

  // ── Display helpers ───────────────────────────────────────────────────────
  /** Sector percentile rank 0–100 */
  sectorRank: number;
  /** Cycle return expressed as ratio (1.12 = +12%) */
  momentumIndicator: number;
  /** 30-day return % */
  ret30: number;
  /** 90-day return % */
  ret90: number;
  /** 180-day return % */
  ret180: number;
  /** Volume accumulation signal */
  volumeSignal: 'STRONG' | 'MODERATE' | 'WEAK';
  /** Recent 20-bar avg volume / overall avg volume */
  volRatio: number;
  /** AI-style sentiment tag (heuristic, no external API) */
  sentimentTag?: string;

  // ── Legacy alias kept for backward UI compatibility ───────────────────────
  /** Alias for trendScore */
  trendStrength: number;

  /** Real-time last close price from Yahoo Finance (null if unavailable) */
  currentPrice?: number | null;
  /** 'real' if fetched from Yahoo Finance, 'synthetic' if estimated */
  dataSource?: string;
  // ── Enriched fields from NSE + Screener.in ───────────────────────────────
  pChange?: number | null;
  weekHigh52?: number | null;
  weekLow52?: number | null;
  deliveryPct?: number | null;
  pe?: number | null;
  roe?: number | null;
  roce?: number | null;
  debtToEquity?: number | null;
  promoterHolding?: number | null;
  fundamentalScore?: number | null;
  dataQuality?: 'HIGH' | 'MEDIUM' | 'LOW';
  newsHeadlines?: string[];
  superbrain?: {
    decision: string; confidence: number; superScore: number; riskScore: number;
    targetPrice: number | null; stopLoss: number | null; upside: number | null;
    explanation: string[]; catalysts: string[]; risks: string[]; regime: string;
    holdingPeriod: string;
    signals: { technical: number; fundamental: number; sentiment: number; macro: number; momentum: number };
  };
}

/** Full response from the scanner API */
export interface MultibaggerScanResult {
  cycle: ScanCycle;
  scannedUniverse: number;
  returned: number;
  stocks: MultibaggerStock[];
  leadingSector: string;
  avgBullishScore: number;
  cachedAt: string;
}

// ─── Service ──────────────────────────────────────────────────────────────────

export class MultibaggerScannerService {
  /**
   * Fetch the top-100 multibagger candidates for a given cycle.
   * Results are cached server-side per cycle and refreshed automatically.
   */
  static async scan(cycle: ScanCycle): Promise<MultibaggerScanResult> {
    return fetchJson<MultibaggerScanResult>(`/api/multibagger/scan?cycle=${cycle}`);
  }
}
