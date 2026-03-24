/**
 * MarketDataAggregator — Indian Stock Market Data
 *
 * Data priority (fastest → slowest):
 *  1. In-memory cache (module-level Map, survives warm Vercel instances)
 *  2. Supabase ohlcv_cache / fundamentals_cache (~50ms, persists across cold starts)
 *  3. Yahoo Finance v8 chart API — only called from /api/admin/refresh-eod (evening batch)
 *  4. Screener.in HTML scraping — only called from /api/stock/enrich (lazy on row expand)
 *
 * Design rules for Vercel (10s function timeout):
 *  - Scan pipeline reads ONLY from in-memory cache → Supabase (zero live HTTP)
 *  - /api/admin/refresh-eod fetches everything once per day and writes to Supabase
 *  - All HTTP timeouts hard-capped at 4s
 *  - Cache TTL: 1hr in-memory, 24hr in Supabase
 */

import axios from 'axios';
import { getSupabaseClient } from '../lib/supabase.js';

// ─── Types ────────────────────────────────────────────────────────────────────

export interface YahooFundamentals {
  symbol: string;
  pe: number | null;
  eps: number | null;
  weekHigh52: number | null;
  weekLow52: number | null;
  marketCap: number | null;       // in INR crores
  bookValue: number | null;
  priceToBook: number | null;
  dividendYield: number | null;
  forwardPE: number | null;
  pChange: number | null;         // % change today
  lastPrice: number | null;
  dataSource: 'YAHOO';
}

export interface ScreenerFundamentals {
  symbol: string;
  pe: number | null;
  roe: number | null;
  roce: number | null;
  debtToEquity: number | null;
  promoterHolding: number | null;
  salesGrowth3yr: number | null;
  profitGrowth3yr: number | null;
  dividendYield: number | null;
  currentRatio: number | null;
  dataSource: 'SCREENER';
}

export interface FIIDIIData {
  date: string;
  fiiNetBuy: number;
  diiNetBuy: number;
  fiiSentiment: 'BULLISH' | 'BEARISH' | 'NEUTRAL';
  diiSentiment: 'BULLISH' | 'BEARISH' | 'NEUTRAL';
}

export interface EnrichedStockData {
  symbol: string;
  yahoo: YahooFundamentals | null;
  screener: ScreenerFundamentals | null;
  newsHeadlines: string[];
  dataQuality: 'HIGH' | 'MEDIUM' | 'LOW';
  enrichedAt: string;
}

// ─── Module-level cache (survives across warm Vercel invocations) ─────────────

const yahooFundCache  = new Map<string, { data: YahooFundamentals; expiresAt: number }>();
const screenerCache   = new Map<string, { data: ScreenerFundamentals; expiresAt: number }>();
const newsCache       = new Map<string, { headlines: string[]; expiresAt: number }>();
let   fiiDiiCache: { data: FIIDIIData; expiresAt: number } | null = null;

// Background warm state — tracks which symbols are currently being fetched
const warmingSet = new Set<string>();

const YAHOO_FUND_TTL  = 60 * 60_000;   // 1 hour
const SCREENER_TTL    = 60 * 60_000;   // 1 hour
const NEWS_TTL        = 15 * 60_000;   // 15 min
const FIIDII_TTL      = 30 * 60_000;   // 30 min
const HTTP_TIMEOUT    = 4_000;          // 4s hard cap — Vercel safe
const SUPABASE_TTL    = 24 * 60 * 60_000; // 24hr — Supabase cache freshness

const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36';

// ─── Supabase fundamentals_cache helpers ─────────────────────────────────────

// Set to true once we confirm the table is missing — avoids repeated 404 attempts
let supabaseTableMissing = false;

/** Read fundamentals for multiple symbols from Supabase in one query (~50ms). */
async function readSupabaseFundamentals(symbols: string[]): Promise<Map<string, any>> {
  const result = new Map<string, any>();
  if (supabaseTableMissing) return result;
  try {
    const sb = getSupabaseClient();
    if (!sb || symbols.length === 0) return result;
    const cutoff = Date.now() - SUPABASE_TTL;
    const { data, error } = await sb
      .from('fundamentals_cache')
      .select('symbol,pe,roe,roce,debt_to_equity,promoter_holding,week_high_52,week_low_52,last_price,p_change,market_cap,book_value,dividend_yield,sales_growth_3yr,profit_growth_3yr,fetched_at')
      .in('symbol', symbols)
      .gt('fetched_at', cutoff);
    if (error) {
      // Table doesn't exist — stop trying for this process lifetime
      if (error.code === 'PGRST205' || error.message?.includes('fundamentals_cache')) {
        supabaseTableMissing = true;
        console.log('[Supabase] fundamentals_cache table missing — disabling Supabase reads');
      }
      return result;
    }
    if (!data) return result;
    for (const row of data) result.set(row.symbol, row);
  } catch (_e) { /* Supabase unavailable — degrade gracefully */ }
  return result;
}

/** Write fundamentals for one symbol to Supabase (fire-and-forget, non-blocking). */
function writeSupabaseFundamentals(symbol: string, yahoo: YahooFundamentals | null, screener: ScreenerFundamentals | null): void {
  if (supabaseTableMissing) return;
  try {
    const sb = getSupabaseClient();
    if (!sb) return;
    const row: Record<string, any> = {
      symbol,
      fetched_at: Date.now(),
      pe:               yahoo?.pe               ?? screener?.pe               ?? null,
      week_high_52:     yahoo?.weekHigh52        ?? null,
      week_low_52:      yahoo?.weekLow52         ?? null,
      last_price:       yahoo?.lastPrice         ?? null,
      p_change:         yahoo?.pChange           ?? null,
      market_cap:       yahoo?.marketCap         ?? null,
      book_value:       yahoo?.bookValue         ?? null,
      dividend_yield:   yahoo?.dividendYield     ?? screener?.dividendYield   ?? null,
      roe:              screener?.roe            ?? null,
      roce:             screener?.roce           ?? null,
      debt_to_equity:   screener?.debtToEquity   ?? null,
      promoter_holding: screener?.promoterHolding ?? null,
      sales_growth_3yr: screener?.salesGrowth3yr  ?? null,
      profit_growth_3yr:screener?.profitGrowth3yr ?? null,
    };
    // Non-blocking — don't await, don't let errors surface
    sb.from('fundamentals_cache').upsert(row, { onConflict: 'symbol' }).then(() => {}).catch(() => {});
  } catch (_e) {}
}

// ─── 1. Yahoo Finance Fundamentals (v7 quoteSummary) ─────────────────────────
// Same domain as OHLCV — already proven to work, no cookie needed

// Known Yahoo Finance symbol overrides — same as server.ts fetchRealOHLCV
const YAHOO_OVERRIDES: Record<string, string> = {
  'TATAMOTORS': 'TATAMOTORS.BO',
  'M&M':        'M%26M.NS',
  'BAJAJ-AUTO': 'BAJAJ-AUTO.NS',
};

export async function fetchYahooFundamentals(symbol: string): Promise<YahooFundamentals | null> {
  const cached = yahooFundCache.get(symbol);
  if (cached && cached.expiresAt > Date.now()) return cached.data;

  const override = YAHOO_OVERRIDES[symbol.toUpperCase()];
  const tickers = override
    ? [override, `${symbol}.NS`, `${symbol}.BO`]
    : [`${symbol}.NS`, `${symbol}.BO`];

  for (const ticker of tickers) {
    try {
      const encoded = encodeURIComponent(ticker);
      // Use v8 chart API (proven working, no 401) — fetch 5d for live price (fast, small payload)
      // v7 /quote returns 401 on Vercel IPs — v8 /chart works reliably
      // 52W high/low derived from 1y range only when needed (separate call below)
      const url = `https://query1.finance.yahoo.com/v8/finance/chart/${encoded}?interval=1d&range=5d&includePrePost=false`;
      const resp = await axios.get(url, {
        timeout: HTTP_TIMEOUT,
        headers: { 'User-Agent': UA, 'Accept': 'application/json' },
      });

      const result = resp.data?.chart?.result?.[0];
      const meta = result?.meta;
      if (!meta || !meta.regularMarketPrice) continue;

      // Validate symbol match
      const returnedBase = (meta.symbol ?? '').toUpperCase().replace(/\.(NS|BO)$/, '');
      const requestedBase = symbol.toUpperCase();
      if (returnedBase && returnedBase !== requestedBase) continue;

      // Derive 52W high/low from meta fields (5d range doesn't have full year)
      // Yahoo v8 meta.fiftyTwoWeekHigh/Low are reliable for this
      const highs: number[] = result.indicators?.quote?.[0]?.high?.filter((v: any) => v != null) ?? [];
      const lows:  number[] = result.indicators?.quote?.[0]?.low?.filter((v: any) => v != null) ?? [];
      const closes: number[] = result.indicators?.quote?.[0]?.close?.filter((v: any) => v != null) ?? [];

      const weekHigh52 = meta.fiftyTwoWeekHigh ?? (highs.length > 0 ? Math.max(...highs) : null);
      const weekLow52  = meta.fiftyTwoWeekLow  ?? (lows.length  > 0 ? Math.min(...lows)  : null);

      // PE: Yahoo v8 meta sometimes has trailingPE
      const pe = meta.trailingPE ?? null;

      // Market cap from meta (in INR) → convert to crores
      const mcapRaw = meta.marketCap ?? null;
      const marketCapCr = mcapRaw ? Math.round(mcapRaw / 1e7) : null;

      // pChange: compute from regularMarketPrice vs chartPreviousClose
      const prevClose = meta.chartPreviousClose ?? meta.previousClose ?? null;
      const pChange = prevClose && prevClose > 0
        ? ((meta.regularMarketPrice - prevClose) / prevClose) * 100
        : (meta.regularMarketChangePercent ?? null);

      const data: YahooFundamentals = {
        symbol,
        pe,
        eps:           null,  // not available in v8
        weekHigh52,
        weekLow52,
        marketCap:     marketCapCr,
        bookValue:     null,
        priceToBook:   null,
        dividendYield: null,
        forwardPE:     null,
        pChange:       pChange !== null ? Number(pChange.toFixed(2)) : null,
        lastPrice:     Number(meta.regularMarketPrice.toFixed(2)),
        dataSource:    'YAHOO',
      };

      yahooFundCache.set(symbol, { data, expiresAt: Date.now() + YAHOO_FUND_TTL });
      // Write to Supabase so next cold start skips live fetch
      writeSupabaseFundamentals(symbol, data, screenerCache.get(symbol)?.data ?? null);
      return data;
    } catch (_e) {
      continue;
    }
  }

  return null;
}

// ─── 2. Screener.in HTML scraping ────────────────────────────────────────────
// Screener /api/company/ returns 404 — scrape HTML instead.
// Confirmed working structure (tested 2026-03):
//   <li class="flex flex-space-between">
//     <span class="name">Stock P/E</span>
//     <span class="nowrap value"><span class="number">47.9</span></span>
//   </li>

export async function fetchScreenerFundamentals(symbol: string): Promise<ScreenerFundamentals | null> {
  const cached = screenerCache.get(symbol);
  if (cached && cached.expiresAt > Date.now()) return cached.data;

  // URL variants: BAJAJ-AUTO stays as-is, M&M → MM (no ampersand)
  const variants = [
    symbol.toUpperCase(),
    symbol.toUpperCase().replace(/&/g, ''),   // M&M → MM
    symbol.toUpperCase().replace(/-/g, ''),   // BAJAJ-AUTO → BAJAJAUTO
  ].filter((v, i, arr) => arr.indexOf(v) === i);

  for (const variant of variants) {
    try {
      const url = `https://www.screener.in/company/${encodeURIComponent(variant)}/`;
      const resp = await axios.get(url, {
        timeout: HTTP_TIMEOUT,
        headers: { 'User-Agent': UA, 'Accept': 'text/html', 'Referer': 'https://www.screener.in/' },
        validateStatus: s => s === 200,
      });

      const html: string = resp.data ?? '';
      if (!html || html.length < 1000) continue;

      // Parse each <li> in top-ratios: name span → number span
      // Confirmed pattern from live HTML inspection
      const ratioMap: Record<string, number> = {};
      const liRe = /<li[^>]*>[\s\S]*?<span[^>]*class="name"[^>]*>\s*([\s\S]*?)\s*<\/span>[\s\S]*?<span[^>]*class="number"[^>]*>\s*([\d,.\-]+)\s*<\/span>/gi;
      let m: RegExpExecArray | null;
      while ((m = liRe.exec(html)) !== null) {
        const key = m[1].replace(/\s+/g, ' ').trim().toLowerCase();
        const val = parseFloat(m[2].replace(/,/g, ''));
        if (!isNaN(val) && key.length > 0) ratioMap[key] = val;
      }

      // Helper: find value by partial key match
      const get = (...keys: string[]): number | null => {
        for (const k of keys) {
          for (const [rk, rv] of Object.entries(ratioMap)) {
            if (rk.includes(k.toLowerCase())) return rv;
          }
        }
        return null;
      };

      // Validate: must have at least ROE or ROCE (otherwise page didn't load properly)
      const roe  = get('roe');
      const roce = get('roce');
      if (roe === null && roce === null) continue;

      // Promoter% — first <td> after "Promoters" in shareholding table
      // Pattern: Promoters&nbsp;...  <td>50.41%</td>
      const promoterMatch = html.match(/Promoters[\s\S]{0,400}?<td[^>]*>\s*(\d{1,2}\.\d{1,2})%/);
      const promoterHolding = promoterMatch ? parseFloat(promoterMatch[1]) : null;

      // D/E — not in top-ratios, look in the ratios table rows
      // Pattern: <td class="text">Debt to equity</td> ... <td>0.35</td>
      const deMatch = html.match(/[Dd]ebt\s+to\s+[Ee]quity[\s\S]{0,300}?<td[^>]*>\s*([\d.]+)\s*<\/td>/);
      const debtToEquity = deMatch ? parseFloat(deMatch[1]) : null;

      // 3yr compounded growth — from growth tables
      // Pattern: Compounded Sales Growth ... 3 Years ... value%
      const salesGrowthMatch = html.match(/Compounded\s+Sales\s+Growth[\s\S]{0,600}?3\s+Years[\s\S]{0,200}?<td[^>]*>\s*(-?\d+\.?\d*)\s*%/i);
      const profitGrowthMatch = html.match(/Compounded\s+Profit\s+Growth[\s\S]{0,600}?3\s+Years[\s\S]{0,200}?<td[^>]*>\s*(-?\d+\.?\d*)\s*%/i);

      const data: ScreenerFundamentals = {
        symbol,
        pe:             get('stock p/e', 'p/e'),
        roe,
        roce,
        debtToEquity,
        promoterHolding,
        salesGrowth3yr:  salesGrowthMatch  ? parseFloat(salesGrowthMatch[1])  : null,
        profitGrowth3yr: profitGrowthMatch ? parseFloat(profitGrowthMatch[1]) : null,
        dividendYield:   get('dividend yield'),
        currentRatio:    get('current ratio'),
        dataSource:      'SCREENER',
      };

      screenerCache.set(symbol, { data, expiresAt: Date.now() + SCREENER_TTL });
      // Write to Supabase so next cold start skips live scraping
      writeSupabaseFundamentals(symbol, yahooFundCache.get(symbol)?.data ?? null, data);
      return data;
    } catch (_e) {
      continue;
    }
  }

  return null;
}

// ─── 3. NSE FII/DII (public CSV) ─────────────────────────────────────────────
// NSE publishes daily FII/DII CSV — no cookie needed, direct download

export async function fetchFIIDIIData(): Promise<FIIDIIData | null> {
  if (fiiDiiCache && fiiDiiCache.expiresAt > Date.now()) return fiiDiiCache.data;

  try {
    // NSE FII/DII activity — public CSV, no auth
    const url = 'https://archives.nseindia.com/content/fo/fii_stats.json';
    const resp = await axios.get(url, {
      timeout: HTTP_TIMEOUT,
      headers: { 'User-Agent': UA, 'Accept': 'application/json' },
    });

    const rows: any[] = Array.isArray(resp.data) ? resp.data : [];
    const latest = rows[rows.length - 1] ?? rows[0];
    if (!latest) return null;

    const fiiNet = parseFloat(latest.NET ?? latest.net ?? latest.fiiNet ?? '0') || 0;
    const diiNet = parseFloat(latest.diiNet ?? latest.DII_NET ?? '0') || 0;

    const data: FIIDIIData = {
      date: latest.date ?? latest.DATE ?? new Date().toISOString().split('T')[0],
      fiiNetBuy: fiiNet,
      diiNetBuy: diiNet,
      fiiSentiment: fiiNet > 500 ? 'BULLISH' : fiiNet < -500 ? 'BEARISH' : 'NEUTRAL',
      diiSentiment: diiNet > 500 ? 'BULLISH' : diiNet < -500 ? 'BEARISH' : 'NEUTRAL',
    };

    fiiDiiCache = { data, expiresAt: Date.now() + FIIDII_TTL };
    return data;
  } catch (_e) {
    return null;
  }
}

// ─── 4. Economic Times RSS news (reuse existing feed) ────────────────────────

export async function fetchStockNews(symbol: string): Promise<string[]> {
  const cached = newsCache.get(symbol);
  if (cached && cached.expiresAt > Date.now()) return cached.headlines;

  try {
    // ET Markets search RSS — free, no auth
    const query = encodeURIComponent(`${symbol}`);
    const url = `https://economictimes.indiatimes.com/markets/stocks/news/rss.cms?q=${query}`;
    const resp = await axios.get(url, {
      timeout: HTTP_TIMEOUT,
      headers: { 'User-Agent': UA, 'Accept': 'text/xml,application/rss+xml' },
    });

    const xml: string = resp.data ?? '';
    const titles: string[] = [];
    // Match both CDATA and plain title tags
    const re = /<title>(?:<!\[CDATA\[)?(.*?)(?:\]\]>)?<\/title>/gi;
    let m: RegExpExecArray | null;
    while ((m = re.exec(xml)) !== null && titles.length < 4) {
      const t = m[1].trim();
      if (t && t.length > 10 && !t.toLowerCase().includes('economic times')) {
        titles.push(t);
      }
    }

    newsCache.set(symbol, { headlines: titles, expiresAt: Date.now() + NEWS_TTL });
    return titles;
  } catch (_e) {
    newsCache.set(symbol, { headlines: [], expiresAt: Date.now() + NEWS_TTL });
    return [];
  }
}

// ─── Batch enrichment — BACKGROUND ONLY, never block scan ────────────────────

/**
 * Enrich top-N stocks with Yahoo fundamentals + Screener data.
 *
 * IMPORTANT: This must NEVER be awaited inside the main scan pipeline.
 * Call it fire-and-forget after the scan returns, so results are cached
 * for the NEXT request. This keeps scan latency under Vercel's 10s limit.
 *
 * Usage:
 *   // After scan completes and response is sent:
 *   enrichStocksBackground(top10Symbols);  // no await
 */
export async function enrichStocksBackground(symbols: string[]): Promise<void> {
  const THIRTY_MIN = 30 * 60_000;
  const now = Date.now();

  // Skip symbols already warming, or cached within last 30 min (both yahoo + screener)
  const toEnrich = symbols.filter(s => {
    if (warmingSet.has(s)) return false;
    const yc = yahooFundCache.get(s);
    const sc = screenerCache.get(s);
    // Skip if both caches are fresh (within 30 min)
    if (yc && yc.expiresAt > now + (YAHOO_FUND_TTL - THIRTY_MIN)) return false;
    if (sc && sc.expiresAt > now + (SCREENER_TTL - THIRTY_MIN)) return false;
    return true;
  });

  if (toEnrich.length === 0) return;

  toEnrich.forEach(s => warmingSet.add(s));

  // Process in batches of 3 — Screener HTML scraping is heavier than JSON
  const BATCH = 3;
  for (let i = 0; i < toEnrich.length; i += BATCH) {
    const batch = toEnrich.slice(i, i + BATCH);
    await Promise.allSettled(batch.map(async (symbol) => {
      try {
        // Yahoo first (fast), then Screener HTML (slower), skip news to save CPU
        await fetchYahooFundamentals(symbol);
        await fetchScreenerFundamentals(symbol);
      } finally {
        warmingSet.delete(symbol);
      }
    }));
    // 500ms gap between batches — Screener rate-limit friendly
    if (i + BATCH < toEnrich.length) {
      await new Promise(r => setTimeout(r, 500));
    }
  }
}

/**
 * Check if a symbol has fresh Yahoo fundamentals cached.
 * Used by server.ts to decide whether to inline-fetch during scan.
 */
export function isYahooCached(symbol: string): boolean {
  const c = yahooFundCache.get(symbol);
  return !!(c && c.expiresAt > Date.now());
}

/**
 * Batch-load fundamentals from Supabase for multiple symbols in one query.
 * Populates in-memory caches so getEnrichedFromCache() returns real data.
 * Falls back gracefully if Supabase is unavailable.
 * ~50ms for any number of symbols — replaces per-symbol live fetching on cold start.
 */
export async function loadFundamentalsFromSupabase(
  symbols: string[],
  setPriceCache?: (symbol: string, price: number, changePct: number) => void
): Promise<void> {
  // Only fetch symbols not already in memory cache
  const missing = symbols.filter(s => !isYahooCached(s));
  if (missing.length === 0 || supabaseTableMissing) return;

  const rows = await readSupabaseFundamentals(missing);
  if (rows.size === 0) return;

  const now = Date.now();
  for (const [symbol, row] of rows) {
    // Populate Yahoo cache
    if (!yahooFundCache.has(symbol) || (yahooFundCache.get(symbol)!.expiresAt <= now)) {
      const yahoo: YahooFundamentals = {
        symbol,
        pe:            row.pe            ?? null,
        eps:           null,
        weekHigh52:    row.week_high_52  ?? null,
        weekLow52:     row.week_low_52   ?? null,
        marketCap:     row.market_cap    ?? null,
        bookValue:     row.book_value    ?? null,
        priceToBook:   null,
        dividendYield: row.dividend_yield ?? null,
        forwardPE:     null,
        pChange:       row.p_change      ?? null,
        lastPrice:     row.last_price    ?? null,
        dataSource:    'YAHOO',
      };
      if (yahoo.lastPrice) {
        yahooFundCache.set(symbol, { data: yahoo, expiresAt: now + YAHOO_FUND_TTL });
        // Also populate perSymbolPriceCache so Superbrain gets price for all symbols
        if (setPriceCache && yahoo.lastPrice > 0) {
          setPriceCache(symbol, yahoo.lastPrice, yahoo.pChange ?? 0);
        }
      }
    }
    // Populate Screener cache
    if (!screenerCache.has(symbol) || (screenerCache.get(symbol)!.expiresAt <= now)) {
      const hasScreener = row.roe != null || row.roce != null || row.promoter_holding != null;
      if (hasScreener) {
        const screener: ScreenerFundamentals = {
          symbol,
          pe:              row.pe               ?? null,
          roe:             row.roe              ?? null,
          roce:            row.roce             ?? null,
          debtToEquity:    row.debt_to_equity   ?? null,
          promoterHolding: row.promoter_holding ?? null,
          salesGrowth3yr:  row.sales_growth_3yr  ?? null,
          profitGrowth3yr: row.profit_growth_3yr ?? null,
          dividendYield:   row.dividend_yield   ?? null,
          currentRatio:    null,
          dataSource:      'SCREENER',
        };
        screenerCache.set(symbol, { data: screener, expiresAt: now + SCREENER_TTL });
      }
    }
  }
}

/**
 * Get enriched data from cache only — never triggers a network fetch.
 * Returns whatever is cached; null fields mean not yet enriched.
 * Safe to call inside the scan pipeline.
 */
export function getEnrichedFromCache(symbol: string): EnrichedStockData {
  const yahoo   = yahooFundCache.get(symbol)?.data ?? null;
  const screener = screenerCache.get(symbol)?.data ?? null;
  const news    = newsCache.get(symbol)?.headlines ?? [];

  const dataQuality: EnrichedStockData['dataQuality'] =
    yahoo && screener ? 'HIGH' :
    yahoo ? 'MEDIUM' : 'LOW';

  return {
    symbol,
    yahoo,
    screener,
    newsHeadlines: news,
    dataQuality,
    enrichedAt: new Date().toISOString(),
  };
}

// ─── Fundamental quality score ────────────────────────────────────────────────

export function computeFundamentalScore(enriched: EnrichedStockData): number {
  let score = 50;

  const y = enriched.yahoo;
  const s = enriched.screener;

  // PE from Yahoo (most reliable)
  const pe = y?.pe ?? s?.pe ?? null;
  if (pe !== null && pe > 0) {
    if (pe <= 15) score += 8;
    else if (pe <= 25) score += 5;
    else if (pe <= 40) score += 0;
    else if (pe <= 60) score -= 5;
    else score -= 10;
  }

  if (s) {
    if (s.roe !== null) {
      if (s.roe >= 25) score += 10;
      else if (s.roe >= 15) score += 6;
      else if (s.roe >= 10) score += 2;
      else score -= 4;
    }
    if (s.roce !== null) {
      if (s.roce >= 20) score += 8;
      else if (s.roce >= 15) score += 4;
      else if (s.roce < 10) score -= 4;
    }
    if (s.debtToEquity !== null) {
      if (s.debtToEquity <= 0.3) score += 8;
      else if (s.debtToEquity <= 0.8) score += 4;
      else if (s.debtToEquity > 1.5) score -= 8;
    }
    if (s.promoterHolding !== null) {
      if (s.promoterHolding >= 65) score += 8;
      else if (s.promoterHolding >= 50) score += 4;
      else if (s.promoterHolding < 30) score -= 6;
    }
    if (s.profitGrowth3yr !== null) {
      if (s.profitGrowth3yr >= 25) score += 8;
      else if (s.profitGrowth3yr >= 15) score += 4;
      else if (s.profitGrowth3yr < 0) score -= 8;
    }
    if (s.salesGrowth3yr !== null) {
      if (s.salesGrowth3yr >= 20) score += 5;
      else if (s.salesGrowth3yr >= 10) score += 2;
      else if (s.salesGrowth3yr < 0) score -= 5;
    }
  }

  // Near 52W high = momentum confirmation
  if (y?.weekHigh52 && y?.lastPrice) {
    if ((y.lastPrice / y.weekHigh52) >= 0.95) score += 6;
  }

  return Math.min(100, Math.max(0, score));
}

// ─── OHLCV Supabase cache helpers ─────────────────────────────────────────────
// ohlcv_cache table stores daily candles as JSONB — written by /api/admin/refresh-eod
// Read by scan pipeline on every request (zero live Yahoo calls during scans)

let ohlcvTableMissing = false;

export interface OHLCVCandle {
  open: number; high: number; low: number; close: number; volume: number;
}

/**
 * Load OHLCV candles from Supabase into realOHLCVCache (passed in from server.ts).
 * Called once per scan — replaces all inline fetchRealOHLCV calls.
 */
export async function loadOHLCVFromSupabase(
  symbols: string[],
  setCache: (symbol: string, candles: OHLCVCandle[], livePrice: number | null, changePct: number | null) => void
): Promise<void> {
  if (ohlcvTableMissing || symbols.length === 0) return;
  try {
    const sb = getSupabaseClient();
    if (!sb) return;
    const cutoff = Date.now() - SUPABASE_TTL;
    const { data, error } = await sb
      .from('ohlcv_cache')
      .select('symbol,candles,live_price,change_pct,fetched_at')
      .in('symbol', symbols)
      .gt('fetched_at', cutoff);
    if (error) {
      if (error.code === 'PGRST205') { ohlcvTableMissing = true; }
      return;
    }
    if (!data) return;
    for (const row of data) {
      const candles: OHLCVCandle[] = Array.isArray(row.candles) ? row.candles : [];
      if (candles.length >= 60) {
        setCache(row.symbol, candles, row.live_price ?? null, row.change_pct ?? null);
      }
    }
  } catch (_e) {}
}

/**
 * Write OHLCV candles for one symbol to Supabase (called from refresh-eod endpoint).
 */
export async function writeOHLCVToSupabase(
  symbol: string,
  candles: OHLCVCandle[],
  livePrice: number | null,
  changePct: number | null
): Promise<void> {
  if (ohlcvTableMissing) return;
  try {
    const sb = getSupabaseClient();
    if (!sb) return;
    const { error } = await sb.from('ohlcv_cache').upsert({
      symbol,
      candles,
      live_price: livePrice,
      change_pct: changePct,
      fetched_at: Date.now(),
    }, { onConflict: 'symbol' });
    if (error && error.code === 'PGRST205') ohlcvTableMissing = true;
  } catch (_e) {}
}
