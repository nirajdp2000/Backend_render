import { fetchJson } from '../lib/api';

export interface OrderBookLevel {
  price: number;
  volume: number;
}

export interface OrderBook {
  bids: OrderBookLevel[];
  asks: OrderBookLevel[];
}

export interface VolumeProfileNode {
  price: number;
  volume: number;
  isPOC: boolean;
  isInValueArea: boolean;
}

export interface InstitutionalMetrics {
  orderImbalance: number;
  accumulationScore: number;
  tradeFrequency: number;
  spreadDynamics: number;
  marketRegime: 'TRENDING' | 'SIDEWAYS' | 'VOLATILE';
}

export interface SectorRotationNode {
  sector: string;
  strength: number;
  leader: string;
  flow: string;
  bias: 'LEADING' | 'IMPROVING' | 'LAGGING';
}

export class InstitutionalService {
  /**
   * ORDER FLOW IMBALANCE ENGINE
   * order_imbalance = bid_volume / ask_volume
   */
  static async calculateOrderImbalance(orderBook: OrderBook): Promise<{ imbalance: number; signal: string; score: number }> {
    return fetchJson('/api/institutional/imbalance', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(orderBook)
    });
  }

  /**
   * VOLUME PROFILE ANALYZER
   * Computes POC, VAH, VAL
   */
  static async calculateVolumeProfile(candles: any[], binSize: number = 1): Promise<{ 
    profile: VolumeProfileNode[]; 
    poc: number; 
    vah: number; 
    val: number;
  }> {
    return fetchJson('/api/institutional/volume-profile', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ candles, binSize })
    });
  }

  /**
   * CROSS-ASSET CORRELATION ENGINE
   */
  static async calculateCorrelation(seriesA: number[], seriesB: number[]): Promise<number> {
    const data = await fetchJson<{ correlation: number }>('/api/institutional/correlation', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ seriesA, seriesB })
    });
    return data.correlation;
  }

  /**
   * ADAPTIVE STRATEGY ENGINE
   * Detects market regime
   */
  static async detectMarketRegime(candles: any[]): Promise<'TRENDING' | 'SIDEWAYS' | 'VOLATILE'> {
    const data = await fetchJson<{ regime: 'TRENDING' | 'SIDEWAYS' | 'VOLATILE' }>('/api/institutional/market-regime', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(candles)
    });
    return data.regime as 'TRENDING' | 'SIDEWAYS' | 'VOLATILE';
  }

  static async getSectorRotation(): Promise<SectorRotationNode[]> {
    return fetchJson('/api/institutional/sector-rotation');
  }
}
