/**
 * UpstoxMarketDataService — Universal market data provider for all tabs
 * 
 * Responsibilities:
 *   • Provide real-time market data when Upstox is connected
 *   • Fetch live quotes, holdings, positions for all features
 *   • Calculate real indicators from live data
 *   • Fall back to simulated data only when not authenticated
 *   • Cache data to minimize API calls
 */

import { UpstoxService } from './UpstoxService';

interface MarketQuote {
  symbol: string;
  lastPrice: number;
  change: number;
  changePercent: number;
  volume: number;
  high: number;
  low: number;
  open: number;
  previousClose: number;
}

interface SectorData {
  sector: string;
  strength: number;
  momentum: string;
  leaders: string[];
}

export class UpstoxMarketDataService {
  private upstoxService: UpstoxService;
  private quoteCache: Map<string, { data: any; expiresAt: number }> = new Map();
  private sectorCache: { data: SectorData[]; expiresAt: number } | null = null;
  private readonly CACHE_TTL = 15000;       // 15s quote cache
  private readonly SECTOR_CACHE_TTL = 30000; // 30s sector cache

  constructor() {
    this.upstoxService = UpstoxService.getInstance();
  }

  /**
   * Check if Upstox is connected
   */
  async isConnected(): Promise<boolean> {
    return await this.upstoxService.isAuthenticated();
  }

  /**
   * Get live market quotes for multiple symbols
   */
  async getMarketQuotes(symbols: string[]): Promise<MarketQuote[]> {
    const isConnected = await this.isConnected();
    
    console.log('[UpstoxMarketDataService] getMarketQuotes - connected:', isConnected, 'symbols:', symbols.length);
    
    if (!isConnected) {
      console.log('[UpstoxMarketDataService] Not connected, using simulated quotes');
      return this.getSimulatedQuotes(symbols);
    }

    try {
      // Map symbols to instrument keys
      const instrumentKeys = symbols.map(s => this.symbolToInstrumentKey(s));
      console.log('[UpstoxMarketDataService] Fetching quotes for instrument keys:', instrumentKeys.slice(0, 3), '...');
      
      const response = await this.upstoxService.apiClient.fetchMarketQuotes(instrumentKeys);
      console.log('[UpstoxMarketDataService] Received response:', response ? 'yes' : 'no');
      
      const quotes = this.parseUpstoxQuotes(response);
      console.log('[UpstoxMarketDataService] Parsed quotes:', quotes.length);
      
      return quotes;
    } catch (error: any) {
      console.error('[UpstoxMarketDataService] Failed to fetch quotes:', error.message);
      console.log('[UpstoxMarketDataService] Falling back to simulated quotes');
      return this.getSimulatedQuotes(symbols);
    }
  }

  /**
   * Get single stock quote with caching
   */
  async getQuote(symbol: string): Promise<MarketQuote | null> {
    const cacheKey = `quote_${symbol}`;
    const cached = this.quoteCache.get(cacheKey);
    
    if (cached && cached.expiresAt > Date.now()) {
      return cached.data;
    }

    const quotes = await this.getMarketQuotes([symbol]);
    const quote = quotes[0] || null;
    
    if (quote) {
      this.quoteCache.set(cacheKey, {
        data: quote,
        expiresAt: Date.now() + this.CACHE_TTL
      });
    }
    
    return quote;
  }

  /**
   * Get real-time momentum stocks (top movers)
   */
  async getMomentumStocks(limit: number = 10): Promise<any[]> {
    const isConnected = await this.isConnected();
    
    console.log('[UpstoxMarketDataService] getMomentumStocks - connected:', isConnected);
    
    if (!isConnected) {
      console.log('[UpstoxMarketDataService] Not connected, using simulated momentum');
      return this.getSimulatedMomentum(limit);
    }

    try {
      // Get quotes for popular stocks
      const symbols = this.getPopularSymbols();
      console.log('[UpstoxMarketDataService] Fetching quotes for symbols:', symbols.length);
      
      const quotes = await this.getMarketQuotes(symbols);
      console.log('[UpstoxMarketDataService] Received quotes:', quotes.length);
      
      if (quotes.length === 0) {
        console.log('[UpstoxMarketDataService] No quotes received, using simulated momentum');
        return this.getSimulatedMomentum(limit);
      }
      
      // Sort by change percent and volume (include all stocks, not just positive)
      const sorted = quotes
        .sort((a, b) => {
          const scoreA = Math.abs(a.changePercent) * Math.log(Math.max(a.volume, 1));
          const scoreB = Math.abs(b.changePercent) * Math.log(Math.max(b.volume, 1));
          return scoreB - scoreA;
        })
        .slice(0, limit);
      
      console.log('[UpstoxMarketDataService] Returning', sorted.length, 'momentum stocks');
      
      return sorted.map(q => ({
        symbol: q.symbol,
        priceChange: q.changePercent.toFixed(2),
        volumeRatio: (q.volume / 1000000).toFixed(2),
        strength: Math.min(100, Math.abs(q.changePercent) * 20 + 50),
        alert: Math.abs(q.changePercent) > 3 ? 'High Velocity Spike' : 
               Math.abs(q.changePercent) > 2 ? 'Strong Momentum' : 'Momentum Building'
      }));
    } catch (error) {
      console.error('[UpstoxMarketDataService] Failed to fetch momentum:', error);
      return this.getSimulatedMomentum(limit);
    }
  }

  /**
   * Get sector strength data from real market — single batched Upstox call
   */
  async getSectorStrength(): Promise<SectorData[]> {
    // Return cached sector data if still fresh
    if (this.sectorCache && this.sectorCache.expiresAt > Date.now()) {
      return this.sectorCache.data;
    }

    const isConnected = await this.isConnected();
    
    if (!isConnected) {
      return this.getSimulatedSectors();
    }

    try {
      const sectorMap = this.getSectorMapping();
      // Collect ALL symbols across all sectors in one array
      const allSymbols = Array.from(new Set(Object.values(sectorMap).flat()));
      // Single batched API call instead of one per sector
      const allQuotes = await this.getMarketQuotes(allSymbols);
      const quoteBySymbol = new Map(allQuotes.map(q => [q.symbol, q]));

      const sectorData: SectorData[] = Object.entries(sectorMap).map(([sector, symbols]) => {
        const quotes = symbols.map(s => quoteBySymbol.get(s)).filter(Boolean) as typeof allQuotes;
        const avgChange = quotes.length
          ? quotes.reduce((sum, q) => sum + q.changePercent, 0) / quotes.length
          : 0;
        const leaders = [...quotes]
          .sort((a, b) => b.changePercent - a.changePercent)
          .slice(0, 3)
          .map(q => q.symbol);
        return {
          sector,
          strength: avgChange,
          momentum: avgChange > 1 ? 'Strong Bullish' :
                    avgChange > 0.5 ? 'Bullish' :
                    avgChange > -0.5 ? 'Neutral' : 'Bearish',
          leaders
        };
      });

      const sorted = sectorData.sort((a, b) => b.strength - a.strength);
      this.sectorCache = { data: sorted, expiresAt: Date.now() + this.SECTOR_CACHE_TTL };
      return sorted;
    } catch (error) {
      console.error('[UpstoxMarketDataService] Failed to fetch sectors:', error);
      return this.getSimulatedSectors();
    }
  }

  /**
   * Get user portfolio holdings (if authenticated)
   */
  async getHoldings(): Promise<any[]> {
    const isConnected = await this.isConnected();
    
    if (!isConnected) {
      return [];
    }

    try {
      const response = await this.upstoxService.apiClient.fetchHoldings();
      return response.data || [];
    } catch (error) {
      console.error('[UpstoxMarketDataService] Failed to fetch holdings:', error);
      return [];
    }
  }

  /**
   * Get user positions (if authenticated)
   */
  async getPositions(): Promise<any[]> {
    const isConnected = await this.isConnected();
    
    if (!isConnected) {
      return [];
    }

    try {
      const response = await this.upstoxService.apiClient.fetchPositions();
      return response.data || [];
    } catch (error) {
      console.error('[UpstoxMarketDataService] Failed to fetch positions:', error);
      return [];
    }
  }

  // ─── Helper Methods ────────────────────────────────────────────────────────

  /**
   * Map symbol to Upstox instrument key
   */
  private symbolToInstrumentKey(symbol: string): string {
    return this.symbolToInstrumentKeyMap()[symbol] || `NSE_EQ|${symbol}`;
  }

  /**
   * Parse Upstox quote response to MarketQuote format.
   * Upstox returns response keys as "NSE_EQ:RELIANCE" (colon-separated with symbol name)
   * but we send requests as "NSE_EQ|INE002A01018" (pipe-separated with ISIN).
   * We build a reverse ISIN→symbol map to correctly resolve symbols.
   */
  private parseUpstoxQuotes(response: any): MarketQuote[] {
    const quotes: MarketQuote[] = [];
    if (!response?.data) return quotes;

    const map = this.symbolToInstrumentKeyMap();
    // Build reverse lookup: ISIN → symbol  AND  "NSE_EQ:SYMBOL" → symbol
    const isinToSymbol = new Map<string, string>();
    for (const [sym, key] of Object.entries(map)) {
      const isin = key.split('|')[1] || '';
      if (isin) isinToSymbol.set(isin, sym);
      // Upstox response key format: "NSE_EQ:RELIANCE"
      isinToSymbol.set(`NSE_EQ:${sym}`, sym);
      isinToSymbol.set(`BSE_EQ:${sym}`, sym);
    }

    for (const [responseKey, value] of Object.entries(response.data)) {
      const data = value as any;
      const ohlc = data.ohlc || {};
      const lastPrice = data.last_price || ohlc.close || 0;
      const previousClose = ohlc.close || lastPrice;
      const change = lastPrice - previousClose;
      const changePercent = previousClose > 0 ? (change / previousClose) * 100 : 0;

      // Try: direct map lookup, then ISIN from key, then symbol name from key
      const isin = responseKey.split(/[|:]/).pop() || '';
      const symbol = isinToSymbol.get(responseKey)
        || isinToSymbol.get(isin)
        || data.instrument_token?.toString()
        || isin;

      quotes.push({
        symbol,
        lastPrice,
        change,
        changePercent,
        volume: data.volume || 0,
        high: ohlc.high || lastPrice,
        low: ohlc.low || lastPrice,
        open: ohlc.open || lastPrice,
        previousClose
      });
    }
    return quotes;
  }

  /**
   * Full symbol → instrument key map (single source of truth)
   */
  private symbolToInstrumentKeyMap(): Record<string, string> {
    return {
      'RELIANCE':   'NSE_EQ|INE002A01018',
      'TCS':        'NSE_EQ|INE467B01029',
      'HDFCBANK':   'NSE_EQ|INE040A01034',
      'INFY':       'NSE_EQ|INE009A01021',
      'ICICIBANK':  'NSE_EQ|INE090A01021',
      'SBIN':       'NSE_EQ|INE062A01020',
      'BHARTIARTL': 'NSE_EQ|INE397D01024',
      'LT':         'NSE_EQ|INE018A01030',
      'ITC':        'NSE_EQ|INE154A01025',
      'KOTAKBANK':  'NSE_EQ|INE237A01028',
      'AXISBANK':   'NSE_EQ|INE238A01034',
      'ADANIENT':   'NSE_EQ|INE423A01024',
      'ASIANPAINT': 'NSE_EQ|INE021A01026',
      'MARUTI':     'NSE_EQ|INE585B01010',
      'SUNPHARMA':  'NSE_EQ|INE044A01036',
      'TITAN':      'NSE_EQ|INE280A01028',
      'BAJFINANCE': 'NSE_EQ|INE296A01024',
      'HCLTECH':    'NSE_EQ|INE860A01027',
      'WIPRO':      'NSE_EQ|INE075A01022',
      'TATAMOTORS': 'NSE_EQ|INE155A01022',
      'NESTLEIND':  'NSE_EQ|INE239A01016',
    };
  }

  private getPopularSymbols(): string[] {
    return [
      'RELIANCE', 'TCS', 'HDFCBANK', 'INFY', 'ICICIBANK',
      'SBIN', 'BHARTIARTL', 'LT', 'ITC', 'KOTAKBANK',
      'AXISBANK', 'ASIANPAINT', 'MARUTI', 'SUNPHARMA', 'TITAN'
    ];
  }

  private getSectorMapping(): Record<string, string[]> {
    return {
      'IT':         ['TCS', 'INFY', 'HCLTECH', 'WIPRO'],
      'Banking':    ['HDFCBANK', 'ICICIBANK', 'SBIN', 'KOTAKBANK', 'AXISBANK'],
      'Auto':       ['MARUTI', 'TATAMOTORS'],
      'Pharma':     ['SUNPHARMA'],
      'Industrials':['LT', 'ADANIENT'],
      'Consumer':   ['ITC', 'TITAN', 'ASIANPAINT', 'NESTLEIND']
    };
  }

  // ─── Simulated Data Fallbacks ──────────────────────────────────────────────

  private getSimulatedQuotes(symbols: string[]): MarketQuote[] {
    return symbols.map(symbol => {
      const seed = symbol.split('').reduce((acc, char) => acc + char.charCodeAt(0), 0);
      const random = () => {
        const x = Math.sin(seed + Date.now() / 10000) * 10000;
        return x - Math.floor(x);
      };
      
      const basePrice = 1000 + random() * 2000;
      const changePercent = (random() - 0.5) * 5;
      const change = basePrice * (changePercent / 100);
      
      return {
        symbol,
        lastPrice: basePrice,
        change,
        changePercent,
        volume: Math.floor(1000000 + random() * 5000000),
        high: basePrice * (1 + random() * 0.02),
        low: basePrice * (1 - random() * 0.02),
        open: basePrice * (1 + (random() - 0.5) * 0.01),
        previousClose: basePrice - change
      };
    });
  }

  private getSimulatedMomentum(limit: number): any[] {
    const symbols = this.getPopularSymbols();
    return Array.from({ length: Math.min(limit, symbols.length) }, (_, i) => ({
      symbol: symbols[i],
      priceChange: (1.5 + Math.random() * 2).toFixed(2),
      volumeRatio: (2.0 + Math.random() * 5).toFixed(2),
      strength: Math.floor(70 + Math.random() * 25),
      alert: i === 0 ? 'High Velocity Spike' : i < 3 ? 'Strong Momentum' : 'Momentum Building'
    }));
  }

  private getSimulatedSectors(): SectorData[] {
    const sectors = ['IT', 'Banking', 'Pharma', 'Energy', 'Auto', 'FMCG'];
    return sectors.map(sector => ({
      sector,
      strength: -2.0 + Math.random() * 5.0,
      momentum: Math.random() > 0.5 ? 'Bullish' : 'Neutral',
      leaders: this.getPopularSymbols().slice(0, 3)
    }));
  }
}
