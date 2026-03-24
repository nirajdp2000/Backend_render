/**
 * useStockSearch
 * Preloads the full NSE+BSE universe once, then searches in-memory.
 * Ranking: exact symbol > starts-with > partial symbol > no match.
 */
import { useState, useEffect, useRef, useCallback } from 'react';

export interface SearchStock {
  symbol:   string;
  name:     string;
  key:      string;
  exchange: 'NSE' | 'BSE';
  sector:   string;
}

let _cache: SearchStock[] | null = null;
let _loadPromise: Promise<SearchStock[]> | null = null;

async function loadUniverse(): Promise<SearchStock[]> {
  if (_cache && _cache.length > 1000) return _cache;  // only trust cache if it has real data
  if (_loadPromise) return _loadPromise;
  _loadPromise = fetch('/api/stocks/universe')
    .then(r => r.json())
    .then((data: SearchStock[]) => {
      _cache = data;
      _loadPromise = null;
      console.log(`[useStockSearch] Loaded ${data.length} searchable stocks`);
      return data;
    });
  return _loadPromise;
}

function rankSearch(universe: SearchStock[], q: string): SearchStock[] {
  if (!q) return [];
  const up = q.toUpperCase();
  const exact: SearchStock[]      = [];
  const startsWith: SearchStock[] = [];
  const partial: SearchStock[]    = [];
  const nameMatch: SearchStock[]  = [];

  for (const s of universe) {
    const sym = s.symbol.toUpperCase();
    const name = (s.name || '').toUpperCase();
    if (sym === up)                        { exact.push(s);      continue; }
    if (sym.startsWith(up))               { startsWith.push(s); continue; }
    if (sym.includes(up))                 { partial.push(s);    continue; }
    if (name.includes(up))                { nameMatch.push(s); }
  }

  const results = [...exact, ...startsWith, ...partial, ...nameMatch].slice(0, 20);
  return results;
}

export function useStockSearch(debounceMs = 200) {
  const [universe, setUniverse]     = useState<SearchStock[]>(_cache ?? []);
  const [results, setResults]       = useState<SearchStock[]>([]);
  const [loading, setLoading]       = useState(false);
  const [universeReady, setUniverseReady] = useState(!!_cache);
  const timerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  // Preload universe on mount
  useEffect(() => {
    if (_cache && _cache.length > 1000) { setUniverse(_cache); setUniverseReady(true); return; }
    loadUniverse().then(data => {
      setUniverse(data);
      setUniverseReady(true);
    });
  }, []);

  const search = useCallback((query: string) => {
    if (timerRef.current) clearTimeout(timerRef.current);
    if (!query || query.length < 1) { setResults([]); return; }

    setLoading(true);
    timerRef.current = setTimeout(() => {
      const u = _cache ?? universe;
      setResults(rankSearch(u, query));
      setLoading(false);
    }, debounceMs);
  }, [universe, debounceMs]);

  const clear = useCallback(() => setResults([]), []);

  return { results, search, clear, loading, universeReady, universeSize: universe.length };
}
