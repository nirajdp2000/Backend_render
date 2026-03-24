/**
 * NextDayPredictionEngine — Multi-factor AI algorithm for next-day stock predictions
 *
 * Algorithm:
 *   Step 1: Compute RSI(14), MACD(12,26,9), EMA(20,50), Bollinger(20), ATR(14), Volume Ratio
 *   Step 2: Normalize all signals to [-1, +1]
 *   Step 3: Weighted score = 0.25*RSI + 0.25*MACD + 0.20*Volume + 0.15*Trend + 0.10*Sentiment + 0.05*Bollinger
 *   Step 4: Prediction: score > 0.15 → Bullish, < -0.15 → Bearish, else Neutral
 *   Step 5: Confidence = |score| * 100 * (1 - volatilityFactor) * signalAgreement
 *   Step 6: Smart filter: confidence > 55, no hard trend-confirmation block
 */

export interface Candle {
  open: number;
  high: number;
  low: number;
  close: number;
  volume: number;
}

export interface PredictionSignals {
  RSI: number;       // -1 to +1
  MACD: number;      // -1 to +1
  Volume: number;    // 0 to +1
  Trend: number;     // -1 or +1
  Sentiment: number; // -1 to +1
  Bollinger: number; // -1 to +1
}

export interface NextDayPrediction {
  stock: string;
  prediction: 'Bullish' | 'Bearish' | 'Neutral';
  confidence: number;
  signals: PredictionSignals;
  explanation: string;
  predicted_price: number;
  current_price: number;
  raw_score: number;
  rsi: number;
  atr: number;
  volumeRatio: number;
  ema20: number;
  ema50: number;
}

export class NextDayPredictionEngine {

  // ─── RSI (14) ─────────────────────────────────────────────────────────────
  static calculateRSI(candles: Candle[], period = 14): number {
    if (candles.length < period + 1) return 50;

    // Wilder's smoothed RSI
    const changes = candles.slice(-(period + 1)).map((c, i, arr) =>
      i === 0 ? 0 : c.close - arr[i - 1].close
    ).slice(1);

    let avgGain = changes.filter(c => c > 0).reduce((s, c) => s + c, 0) / period;
    let avgLoss = changes.filter(c => c < 0).reduce((s, c) => s + Math.abs(c), 0) / period;

    if (avgLoss === 0) return 100;
    const rs = avgGain / avgLoss;
    return 100 - (100 / (1 + rs));
  }

  // ─── EMA ──────────────────────────────────────────────────────────────────
  static calculateEMA(candles: Candle[], period: number): number {
    if (candles.length < period) return candles[candles.length - 1]?.close ?? 0;
    const k = 2 / (period + 1);
    let ema = candles.slice(0, period).reduce((s, c) => s + c.close, 0) / period;
    for (let i = period; i < candles.length; i++) {
      ema = candles[i].close * k + ema * (1 - k);
    }
    return ema;
  }

  // ─── MACD (12, 26, 9) — proper signal line ────────────────────────────────
  static calculateMACD(candles: Candle[]): { macd: number; signal: number; histogram: number } {
    if (candles.length < 35) return { macd: 0, signal: 0, histogram: 0 };

    // Build EMA12 and EMA26 series for last 9+1 bars to compute signal EMA
    const macdSeries: number[] = [];
    const lookback = Math.min(candles.length, 60);
    const slice = candles.slice(-lookback);

    const k12 = 2 / 13;
    const k26 = 2 / 27;
    let ema12 = slice.slice(0, 12).reduce((s, c) => s + c.close, 0) / 12;
    let ema26 = slice.slice(0, 26).reduce((s, c) => s + c.close, 0) / 26;

    for (let i = 12; i < slice.length; i++) {
      ema12 = slice[i].close * k12 + ema12 * (1 - k12);
      if (i >= 26) {
        ema26 = slice[i].close * k26 + ema26 * (1 - k26);
        macdSeries.push(ema12 - ema26);
      }
    }

    if (macdSeries.length < 9) return { macd: 0, signal: 0, histogram: 0 };

    // Signal = 9-period EMA of MACD series
    const k9 = 2 / 10;
    let signal = macdSeries.slice(0, 9).reduce((s, v) => s + v, 0) / 9;
    for (let i = 9; i < macdSeries.length; i++) {
      signal = macdSeries[i] * k9 + signal * (1 - k9);
    }

    const macd = macdSeries[macdSeries.length - 1];
    return { macd, signal, histogram: macd - signal };
  }

  // ─── Bollinger Bands (20, 2) ──────────────────────────────────────────────
  static calculateBollinger(candles: Candle[], period = 20): {
    upper: number; middle: number; lower: number; position: number; bandwidth: number;
  } {
    if (candles.length < period) {
      const close = candles[candles.length - 1]?.close ?? 0;
      return { upper: close, middle: close, lower: close, position: 0, bandwidth: 0 };
    }
    const closes = candles.slice(-period).map(c => c.close);
    const sma = closes.reduce((a, b) => a + b, 0) / period;
    const stdDev = Math.sqrt(closes.reduce((s, c) => s + (c - sma) ** 2, 0) / period);
    const upper = sma + 2 * stdDev;
    const lower = sma - 2 * stdDev;
    const current = candles[candles.length - 1].close;
    const bandwidth = stdDev > 0 ? (upper - lower) / sma : 0;
    // position: -1 = at lower band, 0 = middle, +1 = at upper band
    const position = stdDev > 0 ? (current - sma) / (2 * stdDev) : 0;
    return { upper, middle: sma, lower, position: Math.max(-1, Math.min(1, position)), bandwidth };
  }

  // ─── ATR (14) ─────────────────────────────────────────────────────────────
  static calculateATR(candles: Candle[], period = 14): number {
    if (candles.length < 2) return 0;
    const trs = candles.slice(1).map((c, i) => Math.max(
      c.high - c.low,
      Math.abs(c.high - candles[i].close),
      Math.abs(c.low - candles[i].close)
    ));
    return trs.slice(-period).reduce((a, b) => a + b, 0) / Math.min(period, trs.length);
  }

  // ─── Volume Ratio (current / 10-day avg) ─────────────────────────────────
  static calculateVolumeRatio(candles: Candle[]): number {
    if (candles.length < 5) return 1;
    const current = candles[candles.length - 1].volume;
    const lookback = Math.min(10, candles.length - 1);
    const avg = candles.slice(-lookback - 1, -1).reduce((s, c) => s + c.volume, 0) / lookback;
    return avg > 0 ? current / avg : 1;
  }

  // ─── Normalize signals to [-1, +1] ───────────────────────────────────────
  static normalizeSignals(candles: Candle[], sentiment = 0): PredictionSignals {
    const rsi = this.calculateRSI(candles);
    const macd = this.calculateMACD(candles);
    const ema20 = this.calculateEMA(candles, 20);
    const ema50 = this.calculateEMA(candles, 50);
    const bollinger = this.calculateBollinger(candles);
    const volumeRatio = this.calculateVolumeRatio(candles);

    // RSI: normalize around 50, capped at ±1
    const rsiScore = Math.max(-1, Math.min(1, (rsi - 50) / 30));

    // MACD: use histogram sign + magnitude, normalized by price
    const price = candles[candles.length - 1].close;
    const macdNorm = price > 0 ? Math.max(-1, Math.min(1, macd.histogram / (price * 0.005))) : (macd.histogram > 0 ? 1 : -1);

    // Volume: 0 to +1 (high volume is always a positive signal for momentum)
    const volumeScore = Math.min(1, Math.max(0, (volumeRatio - 0.5) / 2));

    // Trend: EMA crossover — continuous, not binary
    const trendScore = ema50 > 0 ? Math.max(-1, Math.min(1, (ema20 - ema50) / (ema50 * 0.02))) : 0;

    // Bollinger position already -1 to +1
    const bollingerScore = bollinger.position;

    return {
      RSI: rsiScore,
      MACD: macdNorm,
      Volume: volumeScore,
      Trend: trendScore,
      Sentiment: Math.max(-1, Math.min(1, sentiment)),
      Bollinger: bollingerScore,
    };
  }

  // ─── Weighted score ───────────────────────────────────────────────────────
  static calculateScore(signals: PredictionSignals): number {
    return (
      0.25 * signals.RSI +
      0.25 * signals.MACD +
      0.20 * signals.Volume +
      0.15 * signals.Trend +
      0.10 * signals.Sentiment +
      0.05 * signals.Bollinger
    );
  }

  // ─── Prediction direction ─────────────────────────────────────────────────
  static getPrediction(score: number): 'Bullish' | 'Bearish' | 'Neutral' {
    if (score > 0.2) return 'Bullish';
    if (score < -0.2) return 'Bearish';
    return 'Neutral';
  }

  // ─── Confidence ───────────────────────────────────────────────────────────
  static calculateConfidence(score: number, signals: PredictionSignals, candles: Candle[]): number {
    const atr = this.calculateATR(candles);
    const price = candles[candles.length - 1].close;
    // Volatility penalty: high ATR/price = less confident
    const volatilityFactor = price > 0 ? Math.min(0.4, (atr / price) * 8) : 0;

    // Signal agreement: what fraction of signals agree with the prediction direction
    const direction = score > 0 ? 1 : -1;
    const signalArr = [signals.RSI, signals.MACD, signals.Volume * direction, signals.Trend, signals.Sentiment, signals.Bollinger];
    const agreeing = signalArr.filter(s => s * direction > 0.1).length;
    const agreementFactor = 0.4 + 0.6 * (agreeing / signalArr.length);

    // Base confidence from score magnitude, boosted by agreement
    const base = Math.min(95, Math.abs(score) * 150);
    return Math.max(10, Math.round(base * (1 - volatilityFactor) * agreementFactor));
  }

  // ─── AI explanation ───────────────────────────────────────────────────────
  static generateExplanation(
    prediction: 'Bullish' | 'Bearish' | 'Neutral',
    signals: PredictionSignals,
    rsi: number,
    volumeRatio: number,
    macdHist: number
  ): string {
    const reasons: string[] = [];

    if (rsi > 60) reasons.push(`RSI ${rsi.toFixed(0)} — strong momentum`);
    else if (rsi < 40) reasons.push(`RSI ${rsi.toFixed(0)} — oversold bounce`);
    else reasons.push(`RSI ${rsi.toFixed(0)} — neutral zone`);

    if (macdHist > 0) reasons.push('MACD bullish crossover');
    else if (macdHist < 0) reasons.push('MACD bearish crossover');

    if (volumeRatio > 2) reasons.push(`${volumeRatio.toFixed(1)}x volume surge`);
    else if (volumeRatio > 1.3) reasons.push(`${volumeRatio.toFixed(1)}x above avg volume`);

    if (signals.Trend > 0.3) reasons.push('EMA20 above EMA50 (uptrend)');
    else if (signals.Trend < -0.3) reasons.push('EMA20 below EMA50 (downtrend)');

    if (signals.Bollinger > 0.6) reasons.push('price near upper Bollinger band');
    else if (signals.Bollinger < -0.6) reasons.push('price near lower Bollinger band (support)');

    if (signals.Sentiment > 0.3) reasons.push('positive news sentiment');
    else if (signals.Sentiment < -0.3) reasons.push('negative news sentiment');

    const top = reasons.slice(0, 3).join(', ');
    return `${prediction} — ${top || 'mixed signals across indicators'}`;
  }

  // ─── Main predict function ────────────────────────────────────────────────
  static predict(stockSymbol: string, candles: Candle[], sentiment = 0): NextDayPrediction | null {
    if (candles.length < 30) return null;

    const signals = this.normalizeSignals(candles, sentiment);
    const score = this.calculateScore(signals);
    const prediction = this.getPrediction(score);

    // Skip Neutral — only actionable predictions
    if (prediction === 'Neutral') return null;

    const confidence = this.calculateConfidence(score, signals, candles);

    // Minimum confidence threshold
    if (confidence < 52) return null;

    const rsi = this.calculateRSI(candles);
    const atr = this.calculateATR(candles);
    const volumeRatio = this.calculateVolumeRatio(candles);
    const ema20 = this.calculateEMA(candles, 20);
    const ema50 = this.calculateEMA(candles, 50);
    const macd = this.calculateMACD(candles);
    const currentPrice = candles[candles.length - 1].close;

    const explanation = this.generateExplanation(prediction, signals, rsi, volumeRatio, macd.histogram);

    // Predicted price: ATR-based move in predicted direction
    const atrPct = currentPrice > 0 ? atr / currentPrice : 0.01;
    const moveFactor = prediction === 'Bullish' ? 0.4 : -0.4;
    const predictedPrice = currentPrice * (1 + atrPct * moveFactor);

    return {
      stock: stockSymbol,
      prediction,
      confidence,
      signals,
      explanation,
      predicted_price: +predictedPrice.toFixed(2),
      current_price: currentPrice,
      raw_score: +score.toFixed(4),
      rsi: +rsi.toFixed(1),
      atr: +atr.toFixed(2),
      volumeRatio: +volumeRatio.toFixed(2),
      ema20: +ema20.toFixed(2),
      ema50: +ema50.toFixed(2),
    };
  }
}
