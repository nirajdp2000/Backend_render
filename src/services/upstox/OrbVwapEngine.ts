/**
 * OrbVwapEngine — Real-time ORB + VWAP + Volume Spike scanner for NSE
 *
 * Strategy:
 *   1. Lock Opening Range (9:15–9:30 AM IST) from first two 5-min candles
 *   2. Track incremental VWAP (cumulative TP×Vol / cumVol)
 *   3. Dynamic volume baseline (last 5–10 candles, time-of-day normalized)
 *   4. EARLY_RALLY fires when:
 *        price > orbHigh * 1.003  (0.3% buffer — avoids fake breakouts)
 *        price > vwap              (sustained above, not just crossover)
 *        volSpike > 1.8x dynamic avg
 *        optional: RSI > 55
 *   5. Confidence score blends ORB breakout strength, VWAP gap, vol spike, sentiment
 *
 * Data source: Upstox REST (5-min intraday candles) — polled every 60s during
 * market hours. WebSocket upgrade path is documented but not required for Vercel.
 *
 * Architecture note: This module is stateful (in-memory per process). On Vercel
 * serverless it resets each cold start; on Railway/Render it persists all day.
 * The engine degrades gracefully — if Upstox is unavailable it returns the last
 * known signals (stale-while-revalidate pattern).
 */

import axios from 'axios';
import { UpstoxTokenManager } from './UpstoxTokenManager';

// ─── Types ────────────────────────────────────────────────────────────────────

export interface Candle {
  timestamp: string; // ISO
  open: number;
  high: number;
  low: number;
  close: number;
  volume: number;
}

export interface OrbState {
  locked: boolean;
  high: number;
  low: number;
  lockedAt: string | null;
}

export interface VwapState {
  cumTPV: number;  // cumulative (typical price × volume)
  cumVol: number;
  vwap: number;
}

export interface StockOrbData {
  symbol: string;
  instrumentKey: string;
  sector: string;
  orb: OrbState;
  vwap: VwapState;
  candles: Candle[];          // today's intraday candles
  lastPrice: number;
  lastVolume: number;
  rsi14: number;
  dynamicVolAvg: number;      // avg of last 5–10 candles (time-normalized)
  volSpike: number;
  signal: 'EARLY_RALLY' | 'WATCH' | 'NONE';
  confidence: number;
  sentimentBoost: number;     // injected from NewsIntelligenceService
  updatedAt: string;
}

export interface EarlyRallySignal {
  stock: string;
  sector: string;
  signal: 'EARLY_RALLY' | 'WATCH' | 'NONE';
  confidence: number;
  price: number;
  vwap: number;
  orbHigh: number;
  orbLow: number;
  orbBreakoutPct: number;
  volumeSpike: number;
  volumeSpikeConfirmed: boolean;
  rsi: number;
  sentiment: 'POSITIVE' | 'NEUTRAL' | 'NEGATIVE';
  sentimentScore: number;
  priceAboveVwap: boolean;
  priceAboveOrb: boolean;
  timestamp: string;
  staleSince?: string;        // set if data is older than 5 min
}

// ─── NSE watchlist (top 50 liquid stocks) ────────────────────────────────────
// instrument_key format: NSE_EQ|<ISIN>
// We use symbol→instrumentKey map for Upstox v2 API

const WATCHLIST: Array<{ symbol: string; instrumentKey: string; sector: string }> = [
  { symbol: 'RELIANCE',   instrumentKey: 'NSE_EQ|INE002A01018', sector: 'Energy' },
  { symbol: 'TCS',        instrumentKey: 'NSE_EQ|INE467B01029', sector: 'Technology' },
  { symbol: 'HDFCBANK',   instrumentKey: 'NSE_EQ|INE040A01034', sector: 'Financials' },
  { symbol: 'INFY',       instrumentKey: 'NSE_EQ|INE009A01021', sector: 'Technology' },
  { symbol: 'ICICIBANK',  instrumentKey: 'NSE_EQ|INE090A01021', sector: 'Financials' },
  { symbol: 'HINDUNILVR', instrumentKey: 'NSE_EQ|INE030A01027', sector: 'Consumer' },
  { symbol: 'SBIN',       instrumentKey: 'NSE_EQ|INE062A01020', sector: 'Financials' },
  { symbol: 'BHARTIARTL', instrumentKey: 'NSE_EQ|INE397D01024', sector: 'Telecom' },
  { symbol: 'KOTAKBANK',  instrumentKey: 'NSE_EQ|INE237A01028', sector: 'Financials' },
  { symbol: 'LT',         instrumentKey: 'NSE_EQ|INE018A01030', sector: 'Industrials' },
  { symbol: 'WIPRO',      instrumentKey: 'NSE_EQ|INE075A01022', sector: 'Technology' },
  { symbol: 'HCLTECH',    instrumentKey: 'NSE_EQ|INE860A01027', sector: 'Technology' },
  { symbol: 'AXISBANK',   instrumentKey: 'NSE_EQ|INE238A01034', sector: 'Financials' },
  { symbol: 'ASIANPAINT', instrumentKey: 'NSE_EQ|INE021A01026', sector: 'Consumer' },
  { symbol: 'MARUTI',     instrumentKey: 'NSE_EQ|INE585B01010', sector: 'Consumer' },
  { symbol: 'SUNPHARMA',  instrumentKey: 'NSE_EQ|INE044A01036', sector: 'Healthcare' },
  { symbol: 'TITAN',      instrumentKey: 'NSE_EQ|INE280A01028', sector: 'Consumer' },
  { symbol: 'BAJFINANCE', instrumentKey: 'NSE_EQ|INE296A01024', sector: 'Financials' },
  { symbol: 'ULTRACEMCO', instrumentKey: 'NSE_EQ|INE481G01011', sector: 'Materials' },
  { symbol: 'NESTLEIND',  instrumentKey: 'NSE_EQ|INE239A01016', sector: 'Consumer' },
  { symbol: 'POWERGRID',  instrumentKey: 'NSE_EQ|INE752E01010', sector: 'Energy' },
  { symbol: 'NTPC',       instrumentKey: 'NSE_EQ|INE733E01010', sector: 'Energy' },
  { symbol: 'ONGC',       instrumentKey: 'NSE_EQ|INE213A01029', sector: 'Energy' },
  { symbol: 'TATAMOTORS', instrumentKey: 'NSE_EQ|INE155A01022', sector: 'Consumer' },
  { symbol: 'TATASTEEL',  instrumentKey: 'NSE_EQ|INE081A01020', sector: 'Materials' },
  { symbol: 'JSWSTEEL',   instrumentKey: 'NSE_EQ|INE019A01038', sector: 'Materials' },
  { symbol: 'ADANIENT',   instrumentKey: 'NSE_EQ|INE423A01024', sector: 'Industrials' },
  { symbol: 'ADANIPORTS', instrumentKey: 'NSE_EQ|INE742F01042', sector: 'Industrials' },
  { symbol: 'COALINDIA',  instrumentKey: 'NSE_EQ|INE522F01014', sector: 'Energy' },
  { symbol: 'DRREDDY',    instrumentKey: 'NSE_EQ|INE089A01023', sector: 'Healthcare' },
  { symbol: 'CIPLA',      instrumentKey: 'NSE_EQ|INE059A01026', sector: 'Healthcare' },
  { symbol: 'DIVISLAB',   instrumentKey: 'NSE_EQ|INE361B01024', sector: 'Healthcare' },
  { symbol: 'TECHM',      instrumentKey: 'NSE_EQ|INE669C01036', sector: 'Technology' },
  { symbol: 'BAJAJFINSV', instrumentKey: 'NSE_EQ|INE918I01026', sector: 'Financials' },
  { symbol: 'GRASIM',     instrumentKey: 'NSE_EQ|INE047A01021', sector: 'Materials' },
  { symbol: 'HINDALCO',   instrumentKey: 'NSE_EQ|INE038A01020', sector: 'Materials' },
  { symbol: 'INDUSINDBK', instrumentKey: 'NSE_EQ|INE095A01012', sector: 'Financials' },
  { symbol: 'M&M',        instrumentKey: 'NSE_EQ|INE101A01026', sector: 'Consumer' },
  { symbol: 'EICHERMOT',  instrumentKey: 'NSE_EQ|INE066A01021', sector: 'Consumer' },
  { symbol: 'HEROMOTOCO', instrumentKey: 'NSE_EQ|INE158A01026', sector: 'Consumer' },
  { symbol: 'BPCL',       instrumentKey: 'NSE_EQ|INE029A01011', sector: 'Energy' },
  { symbol: 'IOC',        instrumentKey: 'NSE_EQ|INE242A01010', sector: 'Energy' },
  { symbol: 'TATACONSUM', instrumentKey: 'NSE_EQ|INE192A01025', sector: 'Consumer' },
  { symbol: 'APOLLOHOSP', instrumentKey: 'NSE_EQ|INE437A01024', sector: 'Healthcare' },
  { symbol: 'BRITANNIA',  instrumentKey: 'NSE_EQ|INE216A01030', sector: 'Consumer' },
  { symbol: 'PIDILITIND', instrumentKey: 'NSE_EQ|INE318A01026', sector: 'Materials' },
  { symbol: 'SIEMENS',    instrumentKey: 'NSE_EQ|INE003A01024', sector: 'Industrials' },
  { symbol: 'ABB',        instrumentKey: 'NSE_EQ|INE117A01022', sector: 'Industrials' },
  { symbol: 'HAVELLS',    instrumentKey: 'NSE_EQ|INE176B01034', sector: 'Industrials' },
  { symbol: 'NIFTY_50',   instrumentKey: 'NSE_INDEX|Nifty 50',  sector: 'Index' },
];

// ─── Helpers ──────────────────────────────────────────────────────────────────

function istNow(): Date {
  return new Date(new Date().toLocaleString('en-US', { timeZone: 'Asia/Kolkata' }));
}

function isMarketHours(): boolean {
  const ist = istNow();
  const h = ist.getHours(), m = ist.getMinutes();
  const mins = h * 60 + m;
  return mins >= 9 * 60 + 15 && mins <= 15 * 60 + 30; // 9:15–15:30
}

function isOrbWindow(): boolean {
  const ist = istNow();
  const h = ist.getHours(), m = ist.getMinutes();
  const mins = h * 60 + m;
  return mins >= 9 * 60 + 15 && mins < 9 * 60 + 30; // 9:15–9:29
}

/** Time-of-day volume normalization factor (morning spikes are expected) */
function volNormFactor(): number {
  const ist = istNow();
  const mins = ist.getHours() * 60 + ist.getMinutes() - 9 * 60 - 15;
  if (mins < 30) return 1.4;   // first 30 min: high baseline
  if (mins < 60) return 1.15;  // 9:45–10:15
  if (mins < 120) return 1.0;  // 10:15–11:15
  return 0.9;                  // midday: lower baseline → easier to spike
}

/** RSI-14 from close array */
function calcRsi(closes: number[]): number {
  if (closes.length < 15) return 50;
  let gains = 0, losses = 0;
  for (let i = closes.length - 14; i < closes.length; i++) {
    const d = closes[i] - closes[i - 1];
    if (d > 0) gains += d; else losses -= d;
  }
  const avgGain = gains / 14;
  const avgLoss = losses / 14;
  if (avgLoss === 0) return 100;
  const rs = avgGain / avgLoss;
  return 100 - 100 / (1 + rs);
}

/** Incremental VWAP update */
function updateVwap(state: VwapState, candle: Candle): VwapState {
  const tp = (candle.high + candle.low + candle.close) / 3;
  const cumTPV = state.cumTPV + tp * candle.volume;
  const cumVol = state.cumVol + candle.volume;
  return { cumTPV, cumVol, vwap: cumVol > 0 ? cumTPV / cumVol : candle.close };
}

/** Dynamic volume average (last N candles, time-normalized) */
function dynamicVolAvg(candles: Candle[], n = 7): number {
  if (candles.length < 2) return 1;
  const slice = candles.slice(-Math.min(n, candles.length - 1));
  const avg = slice.reduce((s, c) => s + c.volume, 0) / slice.length;
  return avg * volNormFactor();
}

// ─── Engine ───────────────────────────────────────────────────────────────────

export class OrbVwapEngine {
  private tokenManager: UpstoxTokenManager;
  private state: Map<string, StockOrbData> = new Map();
  private lastScanAt: Date | null = null;
  private scanInProgress = false;
  private sentimentMap: Map<string, number> = new Map(); // symbol → newsScore 0-1

  constructor(tokenManager: UpstoxTokenManager) {
    this.tokenManager = tokenManager;
  }

  /** Inject sentiment scores from NewsIntelligenceService */
  injectSentiment(map: Map<string, number>): void {
    this.sentimentMap = map;
  }

  /** Main scan — fetches 5-min intraday candles for all watchlist stocks */
  async scan(): Promise<EarlyRallySignal[]> {
    if (this.scanInProgress) return this.getSignals();
    this.scanInProgress = true;

    try {
      const token = await this.tokenManager.getValidAccessToken();
      if (!token) {
        console.warn('[OrbVwapEngine] No Upstox token — returning synthetic signals');
        return this.getSyntheticSignals();
      }

      const today = new Date().toISOString().slice(0, 10);
      const stocks = WATCHLIST.filter(s => s.sector !== 'Index');

      // Fetch in batches of 5 to avoid rate limits
      const BATCH = 5;
      for (let i = 0; i < stocks.length; i += BATCH) {
        const batch = stocks.slice(i, i + BATCH);
        await Promise.allSettled(batch.map(s => this.fetchAndProcess(s, token, today)));
        if (i + BATCH < stocks.length) await sleep(300); // 300ms between batches
      }

      // Also fetch NIFTY 50 for index trend filter
      await this.fetchAndProcess(
        { symbol: 'NIFTY_50', instrumentKey: 'NSE_INDEX|Nifty 50', sector: 'Index' },
        token, today
      ).catch(() => {});

      this.lastScanAt = new Date();
      return this.getSignals();
    } catch (err: any) {
      console.error('[OrbVwapEngine] Scan error:', err.message);
      return this.getSignals(); // return stale if available
    } finally {
      this.scanInProgress = false;
    }
  }

  private async fetchAndProcess(
    stock: { symbol: string; instrumentKey: string; sector: string },
    token: string,
    today: string
  ): Promise<void> {
    try {
      const encoded = encodeURIComponent(stock.instrumentKey);
      const url = `https://api.upstox.com/v2/historical-candle/intraday/${encoded}/5minute`;
      const { data } = await axios.get(url, {
        headers: { Authorization: `Bearer ${token}`, Accept: 'application/json' },
        timeout: 6000,
      });

      const raw: any[][] = data?.data?.candles ?? [];
      if (!raw.length) return;

      // Upstox format: [timestamp, open, high, low, close, volume, oi]
      const candles: Candle[] = raw
        .map(c => ({
          timestamp: c[0] as string,
          open:   Number(c[1]),
          high:   Number(c[2]),
          low:    Number(c[3]),
          close:  Number(c[4]),
          volume: Number(c[5]),
        }))
        .sort((a, b) => a.timestamp.localeCompare(b.timestamp)); // oldest first

      this.processCandles(stock, candles);
    } catch (err: any) {
      // Mark stale if we have existing data
      const existing = this.state.get(stock.symbol);
      if (existing) {
        existing.updatedAt = existing.updatedAt; // keep stale
      }
    }
  }

  private processCandles(
    stock: { symbol: string; instrumentKey: string; sector: string },
    candles: Candle[]
  ): void {
    if (!candles.length) return;

    // ── ORB: lock from first two 5-min candles (9:15 + 9:20) ────────────────
    const orbCandles = candles.filter(c => {
      const t = new Date(c.timestamp);
      const ist = new Date(t.toLocaleString('en-US', { timeZone: 'Asia/Kolkata' }));
      const mins = ist.getHours() * 60 + ist.getMinutes();
      return mins >= 9 * 60 + 15 && mins < 9 * 60 + 30;
    });

    let orb: OrbState = { locked: false, high: 0, low: Infinity, lockedAt: null };
    if (orbCandles.length >= 1) {
      orb.high = Math.max(...orbCandles.map(c => c.high));
      orb.low  = Math.min(...orbCandles.map(c => c.low));
      orb.locked = orbCandles.length >= 2 || !isOrbWindow();
      orb.lockedAt = orbCandles[orbCandles.length - 1].timestamp;
    }

    // ── Incremental VWAP (full day) ──────────────────────────────────────────
    let vwap: VwapState = { cumTPV: 0, cumVol: 0, vwap: 0 };
    for (const c of candles) vwap = updateVwap(vwap, c);

    // ── RSI-14 from closes ───────────────────────────────────────────────────
    const closes = candles.map(c => c.close);
    const rsi = calcRsi(closes);

    // ── Dynamic volume baseline ──────────────────────────────────────────────
    const dynAvg = dynamicVolAvg(candles);
    const lastCandle = candles[candles.length - 1];
    const volSpike = dynAvg > 0 ? lastCandle.volume / dynAvg : 1;

    // ── Signal logic ─────────────────────────────────────────────────────────
    const price = lastCandle.close;
    const priceAboveOrb  = orb.locked && price > orb.high * 1.003; // 0.3% buffer
    const priceAboveVwap = price > vwap.vwap;
    const volConfirmed   = volSpike > 1.8;
    const rsiOk          = rsi > 55;

    // NIFTY trend boost
    const niftyData = this.state.get('NIFTY_50');
    const niftyBullish = niftyData
      ? niftyData.lastPrice > (niftyData.vwap.vwap * 0.999)
      : true; // assume bullish if no data

    const sentimentBoost = this.sentimentMap.get(stock.symbol) ?? 0.5;
    const sentimentPositive = sentimentBoost > 0.55;

    // Confidence score
    const orbBreakoutPct = orb.locked && orb.high > 0
      ? ((price - orb.high) / orb.high) * 100
      : 0;

    let confidence = 0;
    if (priceAboveOrb)  confidence += 0.30;
    if (priceAboveVwap) confidence += 0.20;
    if (volConfirmed)   confidence += 0.20;
    if (rsiOk)          confidence += 0.15;
    if (niftyBullish)   confidence += 0.10;
    if (sentimentPositive) confidence += 0.05;
    // Boost for strong breakout
    confidence += Math.min(0.10, orbBreakoutPct / 10);
    confidence = Math.min(0.99, Math.max(0, confidence));

    const signal: StockOrbData['signal'] =
      priceAboveOrb && priceAboveVwap && volConfirmed
        ? 'EARLY_RALLY'
        : priceAboveOrb || (priceAboveVwap && volConfirmed)
        ? 'WATCH'
        : 'NONE';

    this.state.set(stock.symbol, {
      symbol: stock.symbol,
      instrumentKey: stock.instrumentKey,
      sector: stock.sector,
      orb,
      vwap,
      candles,
      lastPrice: price,
      lastVolume: lastCandle.volume,
      rsi14: rsi,
      dynamicVolAvg: dynAvg,
      volSpike,
      signal,
      confidence,
      sentimentBoost,
      updatedAt: new Date().toISOString(),
    });
  }

  /** Return structured signals for all tracked stocks */
  getSignals(): EarlyRallySignal[] {
    const now = Date.now();
    return Array.from(this.state.values())
      .filter(s => s.sector !== 'Index')
      .map(s => {
        const staleMs = now - new Date(s.updatedAt).getTime();
        const orbBreakoutPct = s.orb.locked && s.orb.high > 0
          ? ((s.lastPrice - s.orb.high) / s.orb.high) * 100
          : 0;
        return {
          stock: s.symbol,
          sector: s.sector,
          signal: s.signal,
          confidence: +s.confidence.toFixed(3),
          price: s.lastPrice,
          vwap: +s.vwap.vwap.toFixed(2),
          orbHigh: +s.orb.high.toFixed(2),
          orbLow: +s.orb.low.toFixed(2),
          orbBreakoutPct: +orbBreakoutPct.toFixed(3),
          volumeSpike: +s.volSpike.toFixed(2),
          volumeSpikeConfirmed: s.volSpike > 1.8,
          rsi: +s.rsi14.toFixed(1),
          sentiment: s.sentimentBoost > 0.6 ? 'POSITIVE' : s.sentimentBoost < 0.4 ? 'NEGATIVE' : 'NEUTRAL',
          sentimentScore: +s.sentimentBoost.toFixed(3),
          priceAboveVwap: s.lastPrice > s.vwap.vwap,
          priceAboveOrb: s.orb.locked && s.lastPrice > s.orb.high * 1.003,
          timestamp: s.updatedAt,
          ...(staleMs > 5 * 60_000 ? { staleSince: s.updatedAt } : {}),
        } as EarlyRallySignal;
      })
      .sort((a, b) => b.confidence - a.confidence);
  }

  /** Synthetic fallback when Upstox is unavailable — returns empty so caller uses its own synthetic path */
  private getSyntheticSignals(): EarlyRallySignal[] {
    // Return empty array — buildAIIntelligenceDashboard handles synthetic rally detection itself
    return [];
  }

  isStale(): boolean {
    if (!this.lastScanAt) return true;
    return Date.now() - this.lastScanAt.getTime() > 5 * 60_000;
  }

  lastScanTime(): string | null {
    return this.lastScanAt?.toISOString() ?? null;
  }
}

function sleep(ms: number) {
  return new Promise(resolve => setTimeout(resolve, ms));
}
