/**
 * StockUniverseService - Supabase-first universe loader.
 *
 * Priority:
 *   1. Supabase stock_universe table
 *   2. Public Upstox BOD instrument files
 *   3. Embedded fallback list registered by server.ts
 */

import { getSupabaseClient } from '../lib/supabase.js';
import { loadUpstoxEquityUniverse } from './UniverseSyncService.js';

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

let _universe: StockProfile[] = [];
let _fallback: StockProfile[] = [];
let _initPromise: Promise<void> | null = null;
let _initialized = false;
let _lastLoadAttempt = 0;

const FULL_UNIVERSE_MIN_SIZE = Number(process.env.FULL_UNIVERSE_MIN_SIZE || '1000');

function mapRows(rows: any[]): StockProfile[] {
  return rows.map(row => ({
    symbol:        String(row.symbol ?? '').toUpperCase(),
    name:          row.name || row.symbol,
    exchange:      (row.exchange === 'BSE' ? 'BSE' : 'NSE') as 'NSE' | 'BSE',
    sector:        row.sector || 'Unknown',
    industry:      row.industry || 'Unknown',
    marketCap:     Number(row.market_cap ?? row.marketCap) || 1000,
    averageVolume: Number(row.avg_volume ?? row.averageVolume) || 100000,
    instrumentKey: row.instrument_key || row.instrumentKey || `NSE_EQ|${row.symbol}`,
  })).filter(row => row.symbol.length > 0);
}

export function setFallbackUniverse(stocks: StockProfile[]): void {
  _fallback = stocks;
  if (_universe.length === 0) {
    _universe = stocks;
  }
}

export function getUniverse(): StockProfile[] {
  return _universe.length > 0 ? _universe : _fallback;
}

export async function getUniverseAsync(): Promise<StockProfile[]> {
  await initUniverse();
  return getUniverse();
}

export async function initUniverse(): Promise<void> {
  const retryAllowed = Date.now() - _lastLoadAttempt > 5 * 60_000;
  if (_initialized && (_universe.length >= FULL_UNIVERSE_MIN_SIZE || !retryAllowed)) return;
  if (_initPromise) return _initPromise;
  _initPromise = _loadUniverse();
  return _initPromise;
}

async function loadSupabaseRows(): Promise<any[]> {
  const supabase = getSupabaseClient();
  if (!supabase) {
    console.warn('[StockUniverseService] No Supabase client');
    return [];
  }

  console.log('[StockUniverseService] Loading universe from Supabase...');
  const PAGE_SIZE = 1000;
  const allRows: any[] = [];
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
      allRows.push(...data);
      from += PAGE_SIZE;
      if (data.length < PAGE_SIZE) done = true;
    }
  }

  return allRows;
}

async function _loadUniverse(): Promise<void> {
  _lastLoadAttempt = Date.now();
  try {
    const supabaseRows = await loadSupabaseRows();
    if (supabaseRows.length >= FULL_UNIVERSE_MIN_SIZE) {
      _universe = mapRows(supabaseRows);
      console.log(`[StockUniverseService] Loaded ${_universe.length} stocks from Supabase`);
      return;
    }

    if (supabaseRows.length > 0) {
      console.warn(`[StockUniverseService] Supabase returned only ${supabaseRows.length} rows; trying Upstox instrument universe`);
    }

    try {
      const upstoxRows = await loadUpstoxEquityUniverse();
      if (upstoxRows.length >= FULL_UNIVERSE_MIN_SIZE) {
        _universe = mapRows(upstoxRows);
        console.log(`[StockUniverseService] Loaded ${_universe.length} stocks from Upstox instruments`);
        return;
      }
      console.warn(`[StockUniverseService] Upstox returned only ${upstoxRows.length} stocks`);
    } catch (e: any) {
      console.error('[StockUniverseService] Upstox fallback failed:', e.message);
    }

    if (supabaseRows.length > 0) {
      _universe = mapRows(supabaseRows);
      console.log(`[StockUniverseService] Using partial Supabase universe (${_universe.length} stocks)`);
      return;
    }

    console.warn('[StockUniverseService] Using embedded fallback universe');
    _universe = _fallback;
  } catch (err: any) {
    console.error('[StockUniverseService] Load failed:', err.message);
    _universe = _fallback;
  } finally {
    _initialized = true;
    _initPromise = null;
  }
}
