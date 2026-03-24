/**
 * NewsIntelligenceService
 *
 * Fetches real financial news from free RSS/XML feeds (no API key needed),
 * applies NLP-based credibility filtering, cross-source verification,
 * ticker mapping, and sentiment scoring.
 *
 * Architecture: serverless-friendly — all state in module-level cache,
 * no persistent connections, lazy-fetched on demand.
 */

import axios from 'axios';

// ─── Types ────────────────────────────────────────────────────────────────────

export interface NewsItem {
  id: string;
  headline: string;
  summary: string;
  source: string;
  sourceUrl: string;
  publishedAt: string;          // ISO string
  tickers: string[];            // mapped NSE/BSE symbols
  sectors: string[];
  sentiment: 'POSITIVE' | 'NEGATIVE' | 'NEUTRAL';
  sentimentScore: number;       // -1 to +1
  credibilityScore: number;     // 0 to 1
  impactScore: number;          // 0 to 1
  impact: 'HIGH' | 'MEDIUM' | 'LOW';
  verified: boolean;            // cross-verified across ≥2 sources
  flags: string[];              // e.g. ['RUMOR', 'SENSATIONAL']
  type: 'stock' | 'macro' | 'sector';
}

export interface StockNewsSentiment {
  symbol: string;
  sentimentScore: number;       // weighted avg, -1 to +1
  newsScore: number;            // 0 to 1 (for ranking injection)
  socialScore: number;          // 0 to 1 (credibility-weighted)
  impactScore: number;          // 0 to 1
  newsCount: number;
  latestHeadline: string;
  latestSource: string;
  latestAt: string;
}

// ─── Source Registry ──────────────────────────────────────────────────────────
// Free RSS feeds — no auth required, CORS-safe from server side

const NEWS_SOURCES = [
  {
    name: 'Economic Times Markets',
    url: 'https://economictimes.indiatimes.com/markets/rss.cms',
    credibility: 0.92,
    type: 'premium',
  },
  {
    name: 'Moneycontrol',
    url: 'https://www.moneycontrol.com/rss/latestnews.xml',
    credibility: 0.88,
    type: 'premium',
  },
  {
    name: 'LiveMint Markets',
    url: 'https://www.livemint.com/rss/markets',
    credibility: 0.90,
    type: 'premium',
  },
  {
    name: 'Business Standard',
    url: 'https://www.business-standard.com/rss/markets-106.rss',
    credibility: 0.91,
    type: 'premium',
  },
  {
    name: 'NDTV Profit',
    url: 'https://feeds.feedburner.com/ndtvprofit-latest',
    credibility: 0.82,
    type: 'standard',
  },
  {
    name: 'Financial Express',
    url: 'https://www.financialexpress.com/market/feed/',
    credibility: 0.85,
    type: 'standard',
  },
];

// ─── NLP Dictionaries ─────────────────────────────────────────────────────────

const POSITIVE_WORDS = new Set([
  'surge', 'rally', 'gain', 'rise', 'jump', 'soar', 'climb', 'beat', 'exceed',
  'record', 'high', 'profit', 'growth', 'strong', 'bullish', 'upgrade', 'buy',
  'outperform', 'positive', 'boost', 'win', 'award', 'order', 'deal', 'inflow',
  'expansion', 'acquisition', 'dividend', 'buyback', 'breakout', 'momentum',
  'recovery', 'rebound', 'upside', 'optimistic', 'robust', 'healthy', 'solid',
]);

const NEGATIVE_WORDS = new Set([
  'fall', 'drop', 'decline', 'crash', 'plunge', 'slump', 'loss', 'miss',
  'weak', 'bearish', 'downgrade', 'sell', 'underperform', 'negative', 'cut',
  'reduce', 'outflow', 'concern', 'risk', 'warning', 'fraud', 'probe',
  'investigation', 'default', 'debt', 'pressure', 'slowdown', 'contraction',
  'disappointing', 'below', 'shortfall', 'penalty', 'fine', 'lawsuit',
]);

// Fake/low-credibility signals
const FAKE_NEWS_SIGNALS = [
  /\b(100x|1000%|guaranteed|sure shot|multibagger in \d+ days?)\b/i,
  /\b(breaking|urgent|alert|shocking|explosive|massive)\b.*\b(tip|call|target)\b/i,
  /\b(insider|leaked|secret|confidential)\b.*\b(tip|info|source)\b/i,
  /\bwhatsapp\b/i,
  /\btelegram (group|channel|tip)\b/i,
  /\b(pump|dump)\b/i,
  /\bget rich\b/i,
  /\b(unverified|rumour|rumor|speculation)\b/i,
];

const SENSATIONAL_PATTERNS = [
  /\b(SHOCKING|EXPLOSIVE|BOMBSHELL|MASSIVE CRASH|MARKET COLLAPSE)\b/i,
  /\b\d{3,}%\s*(gain|return|profit)\b/i,
  /\b(MUST BUY|MUST SELL|URGENT BUY)\b/i,
];

// ─── Ticker Mapping ───────────────────────────────────────────────────────────
// Maps company name fragments → NSE symbols

const TICKER_MAP: Record<string, string> = {
  'reliance': 'RELIANCE', 'tcs': 'TCS', 'tata consultancy': 'TCS',
  'infosys': 'INFY', 'hdfc bank': 'HDFCBANK', 'hdfc': 'HDFCBANK',
  'icici bank': 'ICICIBANK', 'icici': 'ICICIBANK',
  'sbi': 'SBIN', 'state bank': 'SBIN',
  'wipro': 'WIPRO', 'hcl': 'HCLTECH', 'hcl tech': 'HCLTECH',
  'bajaj finance': 'BAJFINANCE', 'bajaj finserv': 'BAJAJFINSV',
  'kotak': 'KOTAKBANK', 'kotak bank': 'KOTAKBANK',
  'axis bank': 'AXISBANK', 'axis': 'AXISBANK',
  'maruti': 'MARUTI', 'maruti suzuki': 'MARUTI',
  'tata motors': 'TATAMOTORS', 'tata steel': 'TATASTEEL',
  'sun pharma': 'SUNPHARMA', 'sun pharmaceutical': 'SUNPHARMA',
  'dr reddy': 'DRREDDY', "dr. reddy": 'DRREDDY',
  'cipla': 'CIPLA', 'divis': 'DIVISLAB', "divi's": 'DIVISLAB',
  'asian paints': 'ASIANPAINT', 'nestle': 'NESTLEIND',
  'hindustan unilever': 'HINDUNILVR', 'hul': 'HINDUNILVR',
  'itc': 'ITC', 'larsen': 'LT', 'l&t': 'LT',
  'ultratech': 'ULTRACEMCO', 'ultratech cement': 'ULTRACEMCO',
  'titan': 'TITAN', 'adani': 'ADANIENT', 'adani enterprises': 'ADANIENT',
  'adani ports': 'ADANIPORTS', 'adani green': 'ADANIGREEN',
  'ongc': 'ONGC', 'ntpc': 'NTPC', 'power grid': 'POWERGRID',
  'coal india': 'COALINDIA', 'bhel': 'BHEL', 'bpcl': 'BPCL',
  'ioc': 'IOC', 'indian oil': 'IOC', 'gail': 'GAIL',
  'nifty': 'NIFTY50', 'sensex': 'SENSEX', 'bse': 'SENSEX',
  'rbi': 'MACRO', 'sebi': 'MACRO', 'fed': 'MACRO',
  'tech mahindra': 'TECHM', 'mphasis': 'MPHASIS',
  'zomato': 'ZOMATO', 'paytm': 'PAYTM', 'nykaa': 'NYKAA',
  'indusind': 'INDUSINDBK', 'yes bank': 'YESBANK',
  'vedanta': 'VEDL', 'hindalco': 'HINDALCO', 'jsw': 'JSWSTEEL',
  'jsw steel': 'JSWSTEEL', 'sail': 'SAIL',
  'hero motocorp': 'HEROMOTOCO', 'hero': 'HEROMOTOCO',
  'bajaj auto': 'BAJAJ-AUTO', 'eicher': 'EICHERMOT',
  'apollo hospitals': 'APOLLOHOSP', 'fortis': 'FORTIS',
  'max healthcare': 'MAXHEALTH',
  'zydus': 'ZYDUSLIFE', 'lupin': 'LUPIN', 'torrent': 'TORNTPHARM',
  'pidilite': 'PIDILITIND', 'berger': 'BERGEPAINT',
  'havells': 'HAVELLS', 'voltas': 'VOLTAS',
  'dmart': 'DMART', 'avenue supermarts': 'DMART',
  'trent': 'TRENT', 'v-mart': 'VMART',
  'irctc': 'IRCTC', 'indian railway': 'IRCTC',
  'indigo': 'INDIGO', 'interglobe': 'INDIGO',
  'spicejet': 'SPICEJET', 'air india': 'AIRINDIA',
};

// Sector keyword map
const SECTOR_KEYWORDS: Record<string, string[]> = {
  Technology: ['it', 'software', 'tech', 'digital', 'ai', 'cloud', 'cyber', 'semiconductor'],
  Financials: ['bank', 'nbfc', 'insurance', 'finance', 'credit', 'loan', 'rbi', 'sebi', 'nse', 'bse'],
  Healthcare: ['pharma', 'drug', 'hospital', 'health', 'medicine', 'biotech', 'fda', 'cdsco'],
  Energy: ['oil', 'gas', 'crude', 'petroleum', 'power', 'solar', 'wind', 'renewable', 'coal'],
  Consumer: ['fmcg', 'retail', 'consumer', 'food', 'beverage', 'auto', 'vehicle', 'ev'],
  Industrials: ['infra', 'infrastructure', 'construction', 'cement', 'steel', 'metal', 'mining'],
  Telecom: ['telecom', 'jio', 'airtel', 'vi', '5g', 'spectrum'],
  Materials: ['chemical', 'fertilizer', 'paint', 'plastic', 'rubber'],
  Macro: ['gdp', 'inflation', 'repo rate', 'rbi', 'fed', 'dollar', 'rupee', 'fii', 'dii', 'budget'],
};

// ─── Cache ────────────────────────────────────────────────────────────────────

interface NewsCache {
  items: NewsItem[];
  stockSentiments: Map<string, StockNewsSentiment>;
  fetchedAt: number;
  ttl: number;
}

let newsCache: NewsCache | null = null;
const CACHE_TTL_MS = 8 * 60 * 1000; // 8 minutes — balances freshness vs rate limits

// ─── RSS Parser ───────────────────────────────────────────────────────────────

function parseRssXml(xml: string, sourceName: string, sourceCredibility: number): Array<{
  title: string; description: string; pubDate: string; link: string;
}> {
  const items: Array<{ title: string; description: string; pubDate: string; link: string }> = [];
  const itemRegex = /<item[^>]*>([\s\S]*?)<\/item>/gi;
  let match;
  while ((match = itemRegex.exec(xml)) !== null) {
    const block = match[1];
    const title = stripCdata(extractTag(block, 'title'));
    const description = stripCdata(extractTag(block, 'description') || extractTag(block, 'summary'));
    const pubDate = extractTag(block, 'pubDate') || extractTag(block, 'published') || new Date().toISOString();
    const link = extractTag(block, 'link') || extractTag(block, 'guid') || '';
    if (title && title.length > 10) {
      items.push({ title, description: stripHtml(description), pubDate, link });
    }
  }
  return items;
}

function extractTag(xml: string, tag: string): string {
  const re = new RegExp(`<${tag}[^>]*>([\\s\\S]*?)<\\/${tag}>`, 'i');
  const m = xml.match(re);
  return m ? m[1].trim() : '';
}

function stripCdata(s: string): string {
  return s.replace(/<!\[CDATA\[([\s\S]*?)\]\]>/g, '$1').trim();
}

function stripHtml(s: string): string {
  return s.replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim().slice(0, 300);
}

// ─── NLP Analysis ─────────────────────────────────────────────────────────────

function analyzeSentiment(text: string): { score: number; label: 'POSITIVE' | 'NEGATIVE' | 'NEUTRAL' } {
  const words = text.toLowerCase().split(/\W+/);
  let pos = 0, neg = 0;
  for (const w of words) {
    if (POSITIVE_WORDS.has(w)) pos++;
    if (NEGATIVE_WORDS.has(w)) neg++;
  }
  const total = pos + neg;
  if (total === 0) return { score: 0, label: 'NEUTRAL' };
  const score = (pos - neg) / (total + 2); // Laplace smoothing
  const label = score > 0.1 ? 'POSITIVE' : score < -0.1 ? 'NEGATIVE' : 'NEUTRAL';
  return { score: +score.toFixed(3), label };
}

function detectFakeNews(text: string): string[] {
  const flags: string[] = [];
  const combined = text.toLowerCase();
  for (const pattern of FAKE_NEWS_SIGNALS) {
    if (pattern.test(combined)) { flags.push('FAKE_SIGNAL'); break; }
  }
  for (const pattern of SENSATIONAL_PATTERNS) {
    if (pattern.test(text)) { flags.push('SENSATIONAL'); break; }
  }
  // Very short headlines are often clickbait
  if (text.length < 20) flags.push('TOO_SHORT');
  // All-caps is a red flag
  if (text === text.toUpperCase() && text.length > 15) flags.push('ALL_CAPS');
  return flags;
}

function computeCredibility(
  sourceCredibility: number,
  flags: string[],
  pubDate: string,
  sentimentScore: number,
): number {
  let score = sourceCredibility;
  // Penalize fake/sensational flags
  if (flags.includes('FAKE_SIGNAL')) score -= 0.40;
  if (flags.includes('SENSATIONAL')) score -= 0.20;
  if (flags.includes('ALL_CAPS')) score -= 0.10;
  if (flags.includes('TOO_SHORT')) score -= 0.05;
  // Penalize extreme sentiment (likely clickbait)
  if (Math.abs(sentimentScore) > 0.85) score -= 0.10;
  // Recency bonus: news < 2h old gets +0.05
  const ageMs = Date.now() - new Date(pubDate).getTime();
  if (ageMs < 2 * 3600_000) score += 0.05;
  return Math.max(0, Math.min(1, +score.toFixed(3)));
}

function mapTickers(text: string): string[] {
  const lower = text.toLowerCase();
  const found = new Set<string>();
  for (const [fragment, symbol] of Object.entries(TICKER_MAP)) {
    if (lower.includes(fragment)) found.add(symbol);
  }
  // Also match explicit NSE symbols like "RELIANCE", "TCS" in uppercase
  const upperWords = text.match(/\b[A-Z]{2,12}\b/g) || [];
  for (const w of upperWords) {
    if (Object.values(TICKER_MAP).includes(w)) found.add(w);
  }
  return [...found].slice(0, 5);
}

function mapSectors(text: string, tickers: string[]): string[] {
  const lower = text.toLowerCase();
  const found = new Set<string>();
  for (const [sector, keywords] of Object.entries(SECTOR_KEYWORDS)) {
    if (keywords.some(k => lower.includes(k))) found.add(sector);
  }
  if (found.size === 0) found.add('Macro');
  return [...found];
}

function computeImpact(credibility: number, sentimentScore: number, tickers: string[]): {
  score: number; label: 'HIGH' | 'MEDIUM' | 'LOW';
} {
  const base = credibility * 0.5 + Math.abs(sentimentScore) * 0.3 + (tickers.length > 0 ? 0.2 : 0);
  const score = +Math.min(1, base).toFixed(3);
  const label = score > 0.65 ? 'HIGH' : score > 0.40 ? 'MEDIUM' : 'LOW';
  return { score, label };
}

// ─── Fetch & Process ──────────────────────────────────────────────────────────

async function fetchSource(source: typeof NEWS_SOURCES[0]): Promise<NewsItem[]> {
  try {
    const res = await axios.get(source.url, {
      timeout: 6000,
      headers: {
        'User-Agent': 'Mozilla/5.0 (compatible; StockPulse/1.0; +https://nirajstock.vercel.app)',
        'Accept': 'application/rss+xml, application/xml, text/xml, */*',
      },
      responseType: 'text',
    });
    const raw = parseRssXml(res.data, source.name, source.credibility);
    return raw.map((item, idx) => {
      const text = `${item.title} ${item.description}`;
      const sentiment = analyzeSentiment(text);
      const flags = detectFakeNews(item.title);
      const credibility = computeCredibility(source.credibility, flags, item.pubDate, sentiment.score);
      const tickers = mapTickers(text);
      const sectors = mapSectors(text, tickers);
      const impact = computeImpact(credibility, sentiment.score, tickers);
      const type: NewsItem['type'] = tickers.includes('MACRO') || tickers.length === 0 ? 'macro'
        : tickers.length === 1 ? 'stock' : 'sector';

      return {
        id: `${source.name}-${idx}-${Date.now()}`,
        headline: item.title,
        summary: item.description,
        source: source.name,
        sourceUrl: item.link,
        publishedAt: new Date(item.pubDate).toISOString(),
        tickers: tickers.filter(t => t !== 'MACRO'),
        sectors,
        sentiment: sentiment.label,
        sentimentScore: sentiment.score,
        credibilityScore: credibility,
        impactScore: impact.score,
        impact: impact.label,
        verified: false, // set after cross-verification
        flags,
        type,
      } as NewsItem;
    });
  } catch {
    return []; // silently skip failed sources
  }
}

function crossVerify(allItems: NewsItem[]): NewsItem[] {
  // Group by normalized headline similarity (first 40 chars)
  const groups = new Map<string, NewsItem[]>();
  for (const item of allItems) {
    const key = item.headline.toLowerCase().replace(/[^a-z0-9 ]/g, '').slice(0, 40).trim();
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key)!.push(item);
  }
  // Mark items that appear in ≥2 sources as verified
  return allItems.map(item => {
    const key = item.headline.toLowerCase().replace(/[^a-z0-9 ]/g, '').slice(0, 40).trim();
    const group = groups.get(key) || [];
    const uniqueSources = new Set(group.map(i => i.source)).size;
    return { ...item, verified: uniqueSources >= 2 };
  });
}

function deduplicateAndFilter(items: NewsItem[]): NewsItem[] {
  const seen = new Set<string>();
  return items
    .filter(item => {
      // Remove fake/low-credibility items
      if (item.flags.includes('FAKE_SIGNAL')) return false;
      if (item.credibilityScore < 0.45) return false;
      // Deduplicate by headline prefix
      const key = item.headline.toLowerCase().slice(0, 50);
      if (seen.has(key)) return false;
      seen.add(key);
      return true;
    })
    .sort((a, b) => {
      // Sort: verified first, then by credibility × impact
      if (a.verified !== b.verified) return a.verified ? -1 : 1;
      return (b.credibilityScore * b.impactScore) - (a.credibilityScore * a.impactScore);
    })
    .slice(0, 80); // keep top 80 clean items
}

function buildStockSentiments(items: NewsItem[]): Map<string, StockNewsSentiment> {
  const map = new Map<string, { scores: number[]; impacts: number[]; credibilities: number[]; latest: NewsItem }>();

  for (const item of items) {
    for (const ticker of item.tickers) {
      if (!map.has(ticker)) map.set(ticker, { scores: [], impacts: [], credibilities: [], latest: item });
      const entry = map.get(ticker)!;
      entry.scores.push(item.sentimentScore);
      entry.impacts.push(item.impactScore);
      entry.credibilities.push(item.credibilityScore);
      // Keep most recent
      if (new Date(item.publishedAt) > new Date(entry.latest.publishedAt)) {
        entry.latest = item;
      }
    }
  }

  const result = new Map<string, StockNewsSentiment>();
  for (const [symbol, data] of map.entries()) {
    const n = data.scores.length;
    // Credibility-weighted average sentiment
    const totalCred = data.credibilities.reduce((s, c) => s + c, 0);
    const weightedSentiment = data.scores.reduce((s, score, i) => s + score * data.credibilities[i], 0) / Math.max(totalCred, 0.01);
    const avgImpact = data.impacts.reduce((s, v) => s + v, 0) / n;
    const avgCred = totalCred / n;

    // newsScore: 0-1 for ranking injection (0.5 = neutral baseline)
    const newsScore = Math.min(1, Math.max(0, 0.5 + weightedSentiment * 0.4 + avgImpact * 0.1));
    // socialScore: credibility-weighted engagement proxy
    const socialScore = Math.min(1, avgCred * 0.6 + Math.abs(weightedSentiment) * 0.25 + Math.min(n / 5, 1) * 0.15);

    result.set(symbol, {
      symbol,
      sentimentScore: +weightedSentiment.toFixed(3),
      newsScore: +newsScore.toFixed(3),
      socialScore: +socialScore.toFixed(3),
      impactScore: +avgImpact.toFixed(3),
      newsCount: n,
      latestHeadline: data.latest.headline,
      latestSource: data.latest.source,
      latestAt: data.latest.publishedAt,
    });
  }
  return result;
}

// ─── Public API ───────────────────────────────────────────────────────────────

export async function fetchNewsIntelligence(forceRefresh = false): Promise<NewsCache> {
  if (!forceRefresh && newsCache && (Date.now() - newsCache.fetchedAt) < newsCache.ttl) {
    return newsCache;
  }

  // Fetch all sources in parallel (with individual timeouts)
  const allRaw = await Promise.all(NEWS_SOURCES.map(fetchSource));
  const allItems = allRaw.flat();

  const verified = crossVerify(allItems);
  const clean = deduplicateAndFilter(verified);
  const stockSentiments = buildStockSentiments(clean);

  newsCache = {
    items: clean,
    stockSentiments,
    fetchedAt: Date.now(),
    ttl: CACHE_TTL_MS,
  };

  console.log(`[NewsIntelligence] Fetched ${allItems.length} raw → ${clean.length} clean items, ${stockSentiments.size} stocks mapped`);
  return newsCache;
}

/** Get sentiment for a specific symbol — returns neutral defaults if no news */
export function getStockSentiment(symbol: string): StockNewsSentiment {
  const cached = newsCache?.stockSentiments.get(symbol);
  if (cached) return cached;
  return {
    symbol,
    sentimentScore: 0,
    newsScore: 0.5,
    socialScore: 0.5,
    impactScore: 0,
    newsCount: 0,
    latestHeadline: '',
    latestSource: '',
    latestAt: '',
  };
}

/** Get top N news items, optionally filtered by ticker */
export function getTopNews(n = 30, ticker?: string): NewsItem[] {
  const items = newsCache?.items ?? [];
  if (ticker) return items.filter(i => i.tickers.includes(ticker)).slice(0, n);
  return items.slice(0, n);
}

/** Sector-level sentiment aggregation */
export function getSectorSentiment(): Record<string, { score: number; count: number }> {
  const items = newsCache?.items ?? [];
  const map: Record<string, { total: number; count: number }> = {};
  for (const item of items) {
    for (const sector of item.sectors) {
      if (!map[sector]) map[sector] = { total: 0, count: 0 };
      map[sector].total += item.sentimentScore * item.credibilityScore;
      map[sector].count++;
    }
  }
  return Object.fromEntries(
    Object.entries(map).map(([s, v]) => [s, { score: +(v.total / Math.max(v.count, 1)).toFixed(3), count: v.count }])
  );
}
