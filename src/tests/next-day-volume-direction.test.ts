import { describe, expect, it } from 'vitest';
import { NextDayPredictionEngine, type Candle } from '../services/NextDayPredictionEngine';

const makeCandles = (): Candle[] => {
  const candles: Candle[] = [];
  let price = 130;
  for (let i = 0; i < 40; i++) {
    const close = i === 39 ? price * 0.96 : price * 0.997;
    candles.push({
      open: price,
      high: Math.max(price, close) * 1.005,
      low: Math.min(price, close) * 0.995,
      close,
      volume: i === 39 ? 5_000_000 : 1_000_000,
    });
    price = close;
  }
  return candles;
};

describe('NextDayPredictionEngine volume direction', () => {
  it('treats high volume on bearish price action as bearish evidence', () => {
    const signals = NextDayPredictionEngine.normalizeSignals(makeCandles());

    expect(signals.Volume).toBeLessThan(0);
  });
});
