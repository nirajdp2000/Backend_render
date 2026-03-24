/**
 * UniverseSyncService — Daily NSE+BSE stock universe sync to Supabase
 *
 * Source: Upstox BOD instrument JSON files (updated daily ~6 AM IST)
 *   NSE: https://assets.upstox.com/market-quote/instruments/exchange/NSE.json.gz
 *   BSE: https://assets.upstox.com/market-quote/instruments/exchange/BSE.json.gz
 *
 * Strategy (smart upsert — never drops valid data):
 *   1. Download NSE.json.gz + BSE.json.gz, filter to EQ (equity) instruments only
 *   2. Build canonical set of {symbol, exchange, instrument_key, name}
 *   3. INSERT new symbols not in DB
 *   4. DELETE symbols in DB that no longer exist in the source (delisted)
 *   5. UPDATE name/instrument_key if changed
 *   6. Preserve existing sector/industry/market_cap/avg_volume — never overwrite with nulls
 *   7. After sync, reload in-memory universe so live requests use fresh data
 *
 * Schedule: once daily at 7:00 AM IST (1:30 AM UTC), Mon–Fri, non-holiday only
 */

import axios from 'axios';
import zlib from 'zlib';
import { promisify } from 'util';
import { getSupabaseClient } from '../lib/supabase.js';

const gunzip = promisify(zlib.gunzip);

// ── Types ─────────────────────────────────────────────────────────────────────

interface UpstoxInstrument {
  segment: string;
  name: string;
  exchange: string;
  isin?: string;
  instrument_type: string;
  instrument_key: string;
  trading_symbol: string;
  short_name?: string;
  security_type?: string;
}

interface CanonicalStock {
  symbol: string;
  name: string;
  exchange: 'NSE' | 'BSE';
  instrument_key: string;
  isin: string;
}

// ── NSE holidays (YYYY-MM-DD) — keep in sync with server.ts ──────────────────
const NSE_HOLIDAYS = new Set([
  '2025-01-26','2025-02-19','2025-03-14','2025-03-31',
  '2025-04-10','2025-04-14','2025-04-18','2025-05-01',
  '2025-08-15','2025-08-27','2025-10-02','2025-10-21',
  '2025-10-22','2025-11-05','2025-12-25',
  '2026-01-26','2026-03-03','2026-03-20','2026-04-02',
  '2026-04-03','2026-04-14','2026-05-01','2026-08-15',
  '2026-09-16','2026-10-02','2026-11-10','2026-11-11',
  '2026-12-25',
]);

function isTradingDay(date = new Date()): boolean {
  const ist = new Date(date.toLocaleString('en-US', { timeZone: 'Asia/Kolkata' }));
  const dow = ist.getDay();
  if (dow === 0 || dow === 6) return false;
  const dateStr = ist.toISOString().slice(0, 10);
  return !NSE_HOLIDAYS.has(dateStr);
}

// ── Downloader ────────────────────────────────────────────────────────────────

async function downloadInstruments(exchange: 'NSE' | 'BSE'): Promise<UpstoxInstrument[]> {
  const url = `https://assets.upstox.com/market-quote/instruments/exchange/${exchange}.json.gz`;
  console.log(`[UniverseSync] Downloading ${exchange} instruments from ${url}`);

  const response = await axios.get(url, {
    responseType: 'arraybuffer',
    timeout: 30_000,
    headers: { 'Accept-Encoding': 'identity' }, // get raw gzip bytes
  });

  const decompressed = await gunzip(Buffer.from(response.data));
  const instruments: UpstoxInstrument[] = JSON.parse(decompressed.toString('utf8'));
  console.log(`[UniverseSync] ${exchange}: ${instruments.length} total instruments downloaded`);
  return instruments;
}

// ── Filter to equity only ─────────────────────────────────────────────────────

function filterEquity(instruments: UpstoxInstrument[], exchange: 'NSE' | 'BSE'): CanonicalStock[] {
  const segment = exchange === 'NSE' ? 'NSE_EQ' : 'BSE_EQ';
  return instruments
    .filter(i =>
      i.segment === segment &&
      i.instrument_type === 'EQ' &&
      i.trading_symbol &&
      i.trading_symbol.trim().length > 0 &&
      // Exclude index/ETF/SGBs/bonds — pure equity only
      !i.trading_symbol.includes('-') &&
      !i.trading_symbol.endsWith('BE') &&
      !i.trading_symbol.endsWith('BL') &&
      !i.trading_symbol.endsWith('GS') &&
      (i.security_type === 'NORMAL' || !i.security_type)
    )
    .map(i => ({
      symbol:         i.trading_symbol.trim().toUpperCase(),
      name:           i.name || i.short_name || i.trading_symbol,
      exchange,
      instrument_key: i.instrument_key,
      isin:           i.isin || '',
    }));
}

// ── Main sync ─────────────────────────────────────────────────────────────────

export interface SyncResult {
  inserted: number;
  deleted: number;
  updated: number;
  total: number;
  skipped: boolean;
  reason?: string;
}

export async function syncUniverseToSupabase(force = false): Promise<SyncResult> {
  const supabase = getSupabaseClient();
  if (!supabase) {
    return { inserted: 0, deleted: 0, updated: 0, total: 0, skipped: true, reason: 'No Supabase client' };
  }

  if (!force && !isTradingDay()) {
    const day = new Date().toLocaleDateString('en-IN', { timeZone: 'Asia/Kolkata', weekday: 'long' });
    return { inserted: 0, deleted: 0, updated: 0, total: 0, skipped: true, reason: `Non-trading day (${day})` };
  }

  console.log('[UniverseSync] Starting daily universe sync...');
  const startMs = Date.now();

  // ── Step 1: Download NSE + BSE instruments ────────────────────────────────
  let nseStocks: CanonicalStock[] = [];
  let bseStocks: CanonicalStock[] = [];

  try {
    const [nseRaw, bseRaw] = await Promise.all([
      downloadInstruments('NSE'),
      downloadInstruments('BSE'),
    ]);
    nseStocks = filterEquity(nseRaw, 'NSE');
    bseStocks = filterEquity(bseRaw, 'BSE');
  } catch (e: any) {
    console.error('[UniverseSync] Download failed:', e.message);
    return { inserted: 0, deleted: 0, updated: 0, total: 0, skipped: true, reason: `Download failed: ${e.message}` };
  }

  console.log(`[UniverseSync] Filtered: NSE=${nseStocks.length} BSE=${bseStocks.length} equity stocks`);

  // Build canonical map: symbol+exchange → CanonicalStock
  const canonical = new Map<string, CanonicalStock>();
  for (const s of [...nseStocks, ...bseStocks]) {
    canonical.set(`${s.symbol}|${s.exchange}`, s);
  }

  // ── Step 2: Load existing DB rows ─────────────────────────────────────────
  const PAGE_SIZE = 1000;
  let dbRows: any[] = [];
  let from = 0;
  let done = false;
  while (!done) {
    const { data, error } = await supabase
      .from('stock_universe')
      .select('id,symbol,exchange,name,instrument_key,sector,industry,market_cap,avg_volume')
      .range(from, from + PAGE_SIZE - 1);
    if (error || !data || data.length === 0) { done = true; break; }
    dbRows = dbRows.concat(data);
    from += PAGE_SIZE;
    if (data.length < PAGE_SIZE) done = true;
  }
  console.log(`[UniverseSync] DB has ${dbRows.length} existing rows`);

  const dbMap = new Map<string, any>();
  for (const row of dbRows) {
    dbMap.set(`${row.symbol}|${row.exchange}`, row);
  }

  // ── Step 3: Compute diff ──────────────────────────────────────────────────
  const toInsert: any[] = [];
  const toUpdate: Array<{ id: number; changes: any }> = [];
  const toDeleteIds: number[] = [];

  // Find new + changed
  for (const [key, stock] of canonical) {
    const existing = dbMap.get(key);
    if (!existing) {
      // New stock — insert with defaults
      toInsert.push({
        symbol:         stock.symbol,
        name:           stock.name,
        exchange:       stock.exchange,
        instrument_key: stock.instrument_key,
        sector:         'Unknown',
        industry:       'Unknown',
        market_cap:     1000,
        avg_volume:     100000,
      });
    } else {
      // Existing — update only if name or instrument_key changed
      const changes: any = {};
      if (stock.name && stock.name !== existing.name) changes.name = stock.name;
      if (stock.instrument_key && stock.instrument_key !== existing.instrument_key) {
        changes.instrument_key = stock.instrument_key;
      }
      if (Object.keys(changes).length > 0) {
        toUpdate.push({ id: existing.id, changes });
      }
    }
  }

  // Find delisted (in DB but not in canonical)
  for (const [key, row] of dbMap) {
    if (!canonical.has(key)) {
      toDeleteIds.push(row.id);
    }
  }

  console.log(`[UniverseSync] Diff — insert:${toInsert.length} update:${toUpdate.length} delete:${toDeleteIds.length}`);

  // ── Step 4: Apply changes in batches ──────────────────────────────────────
  let inserted = 0;
  let updated = 0;
  let deleted = 0;
  const BATCH = 500;

  // Inserts
  for (let i = 0; i < toInsert.length; i += BATCH) {
    const batch = toInsert.slice(i, i + BATCH);
    const { error } = await supabase.from('stock_universe').insert(batch);
    if (error) {
      console.error(`[UniverseSync] Insert batch error:`, error.message);
    } else {
      inserted += batch.length;
    }
  }

  // Updates (name/instrument_key only — never touch sector/market_cap etc.)
  for (const { id, changes } of toUpdate) {
    const { error } = await supabase.from('stock_universe').update(changes).eq('id', id);
    if (!error) updated++;
  }

  // Deletes (delisted stocks)
  for (let i = 0; i < toDeleteIds.length; i += BATCH) {
    const batch = toDeleteIds.slice(i, i + BATCH);
    const { error } = await supabase.from('stock_universe').delete().in('id', batch);
    if (error) {
      console.error(`[UniverseSync] Delete batch error:`, error.message);
    } else {
      deleted += batch.length;
    }
  }

  const total = dbRows.length - deleted + inserted;
  const elapsed = ((Date.now() - startMs) / 1000).toFixed(1);

  console.log(`[UniverseSync] Done in ${elapsed}s — inserted:${inserted} updated:${updated} deleted:${deleted} total:${total}`);

  return { inserted, deleted, updated, total, skipped: false };
}

// ── Scheduler ─────────────────────────────────────────────────────────────────

const SYNC_HOUR_UTC = 1;   // 1:30 AM UTC = 7:00 AM IST (after Upstox 6 AM refresh)
const SYNC_MIN_UTC  = 30;

let _syncTimer: NodeJS.Timeout | null = null;
let _lastSyncDate: string | null = null;

function msUntilNextSync(): number {
  const now = new Date();
  const target = new Date();
  target.setUTCHours(SYNC_HOUR_UTC, SYNC_MIN_UTC, 0, 0);
  if (now >= target) target.setUTCDate(target.getUTCDate() + 1);
  return target.getTime() - now.getTime();
}

export function startUniverseSyncScheduler(
  onSyncComplete?: (result: SyncResult) => void
): void {
  const scheduleNext = () => {
    const ms = msUntilNextSync();
    const nextAt = new Date(Date.now() + ms);
    console.log(`[UniverseSync] Next sync scheduled at ${nextAt.toISOString()} (${Math.round(ms / 60000)}m from now)`);

    _syncTimer = setTimeout(async () => {
      const todayIST = new Date().toLocaleDateString('en-CA', { timeZone: 'Asia/Kolkata' });

      // Guard: don't run twice on same day (e.g. server restart mid-morning)
      if (_lastSyncDate === todayIST) {
        console.log(`[UniverseSync] Already ran today (${todayIST}) — skipping`);
      } else {
        _lastSyncDate = todayIST;
        try {
          const result = await syncUniverseToSupabase();
          onSyncComplete?.(result);
        } catch (e: any) {
          console.error('[UniverseSync] Scheduler error:', e.message);
        }
      }

      // Schedule next day
      scheduleNext();
    }, ms);
  };

  scheduleNext();
}

export function stopUniverseSyncScheduler(): void {
  if (_syncTimer) { clearTimeout(_syncTimer); _syncTimer = null; }
}
