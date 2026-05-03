export type AiSignal = 'STRONG BUY' | 'BUY' | 'HOLD' | 'SELL';
export type AiConfidence = 'HIGH' | 'MEDIUM' | 'LOW';
export type RlAction = 'BUY' | 'HOLD' | 'SELL' | string;

export function deriveAiSignal(finalScore: number, rlAction: RlAction): { signal: AiSignal; confidence: AiConfidence } {
  if (rlAction === 'BUY' && finalScore >= 0.72) return { signal: 'STRONG BUY', confidence: 'HIGH' };
  if (rlAction === 'BUY' && finalScore >= 0.55) return { signal: 'BUY', confidence: 'HIGH' };
  if (rlAction === 'SELL' && finalScore <= 0.38) return { signal: 'SELL', confidence: finalScore <= 0.28 ? 'HIGH' : 'MEDIUM' };
  if (finalScore >= 0.48) return { signal: 'HOLD', confidence: 'MEDIUM' };
  return { signal: 'HOLD', confidence: 'LOW' };
}

export function mapNewsItemForDashboard(item: {
  headline: string;
  tickers?: string[];
  sectors?: string[];
  impact: 'HIGH' | 'MEDIUM' | 'LOW' | string;
  sentiment: 'POSITIVE' | 'NEUTRAL' | 'NEGATIVE' | string;
  source: string;
  credibilityScore: number;
  verified: boolean;
  flags?: string[];
  impactScore: number;
  publishedAt: string;
  type?: 'stock' | 'macro' | 'sector';
}) {
  const tickers = item.tickers ?? [];
  return {
    symbol: tickers[0] || null,
    headline: item.headline,
    sector: item.sectors?.[0] || 'General',
    impact: item.impact,
    sentiment: item.sentiment,
    source: item.source,
    credibilityScore: +item.credibilityScore.toFixed(2),
    verified: item.verified,
    fakeNewsFlags: item.flags ?? [],
    priceChange: undefined,
    volumeSpike: undefined,
    aiScore: Math.round(item.impactScore * 100),
    timestamp: item.publishedAt,
    type: tickers.length > 0 ? 'stock' : (item.type === 'sector' ? 'macro' : item.type ?? 'macro'),
    rallyRelevance: item.sentiment === 'POSITIVE' ? 'WATCHLIST' : undefined,
  };
}

type CandleLike = {
  date?: string;
  timestamp?: string | number;
  time?: string | number;
  t?: string | number;
  close?: number;
  c?: number;
};

function candleDate(candle: CandleLike): string | null {
  const raw = candle.date ?? candle.timestamp ?? candle.time ?? candle.t;
  if (raw == null) return null;
  if (typeof raw === 'string') {
    if (/^\d{4}-\d{2}-\d{2}$/.test(raw)) return raw;
    const parsed = new Date(raw);
    return Number.isNaN(parsed.getTime()) ? null : parsed.toISOString().slice(0, 10);
  }
  const millis = raw > 10_000_000_000 ? raw : raw * 1000;
  const parsed = new Date(millis);
  return Number.isNaN(parsed.getTime()) ? null : parsed.toISOString().slice(0, 10);
}

export function pickCandleForDate<T extends CandleLike>(candles: T[], targetDate: string): T | null {
  return candles.find(c => candleDate(c) === targetDate) ?? null;
}
