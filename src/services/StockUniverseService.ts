/**
 * StockUniverseService — Supabase-first universe loader.
 *
 * Priority:
 *   1. Supabase `stock_universe` table  (5000+ stocks)
 *   2. Fallback list set via setFallbackUniverse() (440 embedded stocks)
 *
 * Usage:
 *   await initUniverse()        — call once at startup (non-blocking)
 *   getUniverseAsync()          — always resolves (waits for init if needed)
 *   getUniverse()               — sync, returns whatever is loaded so far
 *   setFallbackUniverse(list)   — register the embedded fallback
 */

import { getSupabaseClient } from '../lib/supabase.js';

export interface StockProfile {
  symbol: string;
  name: string;
  exchange: 'NSE' | 'BSE';
  sector: string;
  industry: string;
  marketCap: number;
  averageVolume: number;
  instrumentKey: string;
}

// ── State ────────────────────────────────────────────────────────────────────
let _universe: StockProfile[] = [];
let _fallback: StockProfile[] = [];
let _initPromise: Promise<void> | null = null;
let _initialized = false;

// ── Public API ────────────────────────────────────────────────────────────────

export function setFallbackUniverse(stocks: StockProfile[]): void {
  _fallback = stocks;
  // If universe not yet loaded, seed it with fallback immediately
  if (_universe.length === 0) {
    _universe = stocks;
  }
}

export function getUniverse(): StockProfile[] {
  return _universe.length > 0 ? _universe : _fallback;
}

export async function getUniverseAsync(): Promise<StockProfile[]> {
  // Always trigger init if not done — handles cold starts where initUniverse()
  // was called fire-and-forget and _initPromise may already be set
  await initUniverse();
  return getUniverse();
}

export async function initUniverse(): Promise<void> {
  if (_initialized) return;
  // If already in-flight, wait for it
  if (_initPromise) return _initPromise;
  // Start loading and wait
  _initPromise = _loadUniverse();
  return _initPromise;
}

// ── Internal ──────────────────────────────────────────────────────────────────

async function _loadUniverse(): Promise<void> {
  try {
    const supabase = getSupabaseClient();
    if (!supabase) {
      console.warn('[StockUniverseService] No Supabase client — using fallback');
      _universe = _fallback;
      _initialized = true;
      return;
    }

    console.log('[StockUniverseService] Loading universe from Supabase...');

    // Paginate — Supabase default limit is 1000 rows per request
    const PAGE_SIZE = 1000;
    let allRows: any[] = [];
    let from = 0;
    let done = false;

    while (!done) {
      const { data, error } = await supabase
        .from('stock_universe')
        .select('symbol,name,exchange,sector,industry,market_cap,avg_volume,instrument_key')
        .range(from, from + PAGE_SIZE - 1);

      if (error) {
        console.error('[StockUniverseService] Supabase error:', error.message);
        break;
      }

      if (!data || data.length === 0) {
        done = true;
      } else {
        allRows = allRows.concat(data);
        from += PAGE_SIZE;
        if (data.length < PAGE_SIZE) done = true;
      }
    }

    if (allRows.length > 0) {
      _universe = allRows.map(row => ({
        symbol:        row.symbol,
        name:          row.name || row.symbol,
        exchange:      (row.exchange === 'BSE' ? 'BSE' : 'NSE') as 'NSE' | 'BSE',
        sector:        row.sector || 'Unknown',
        industry:      row.industry || 'Unknown',
        marketCap:     Number(row.market_cap) || 1000,
        averageVolume: Number(row.avg_volume) || 100000,
        instrumentKey: row.instrument_key || `NSE_EQ|${row.symbol}`,
      }));
      console.log(`[StockUniverseService] Loaded ${_universe.length} stocks from Supabase`);
    } else {
      console.warn('[StockUniverseService] Supabase returned 0 rows — using fallback');
      _universe = _fallback;
    }
  } catch (err: any) {
    console.error('[StockUniverseService] Load failed:', err.message);
    _universe = _fallback;
  } finally {
    _initialized = true;
  }
}
