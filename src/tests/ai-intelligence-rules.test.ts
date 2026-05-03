import { describe, expect, it } from 'vitest';
import {
  deriveAiSignal,
  mapNewsItemForDashboard,
  pickCandleForDate,
} from '../services/aiIntelligenceRules';

describe('AI intelligence dashboard rules', () => {
  it('does not emit actionable BUY labels without BUY directional agreement', () => {
    expect(deriveAiSignal(0.74, 'HOLD')).toEqual({ signal: 'HOLD', confidence: 'MEDIUM' });
    expect(deriveAiSignal(0.61, 'SELL')).toEqual({ signal: 'HOLD', confidence: 'MEDIUM' });
    expect(deriveAiSignal(0.76, 'BUY')).toEqual({ signal: 'STRONG BUY', confidence: 'HIGH' });
    expect(deriveAiSignal(0.62, 'BUY')).toEqual({ signal: 'BUY', confidence: 'HIGH' });
  });

  it('maps real news service fields into the dashboard contract', () => {
    const mapped = mapNewsItemForDashboard({
      headline: 'Reliance wins large renewable order',
      tickers: ['RELIANCE'],
      sectors: ['Energy'],
      impact: 'HIGH',
      sentiment: 'POSITIVE',
      source: 'Economic Times',
      credibilityScore: 0.91,
      verified: true,
      flags: ['CROSS_VERIFIED'],
      impactScore: 0.82,
      publishedAt: '2026-04-24T10:00:00.000Z',
    });

    expect(mapped).toMatchObject({
      symbol: 'RELIANCE',
      headline: 'Reliance wins large renewable order',
      sector: 'Energy',
      impact: 'HIGH',
      sentiment: 'POSITIVE',
      credibilityScore: 0.91,
      fakeNewsFlags: ['CROSS_VERIFIED'],
      aiScore: 82,
      type: 'stock',
      rallyRelevance: 'WATCHLIST',
    });
  });

  it('selects the candle matching the requested trading date', () => {
    const candles = [
      { date: '2026-04-20', close: 100 },
      { timestamp: '2026-04-21T10:00:00.000Z', close: 103 },
      { t: Date.parse('2026-04-22T00:00:00.000Z'), close: 109 },
    ];

    expect(pickCandleForDate(candles, '2026-04-21')?.close).toBe(103);
    expect(pickCandleForDate(candles, '2026-04-22')?.close).toBe(109);
    expect(pickCandleForDate(candles, '2026-04-23')).toBeNull();
  });
});
