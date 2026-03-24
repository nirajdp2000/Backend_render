/**
 * UpstoxTokenManager — Token storage and auto-refresh logic
 *
 * IMPORTANT: Upstox does NOT support refresh_token grant for most app types.
 * Tokens are valid for 24h from issuance. Re-auth via authorization_code is
 * required once per day (user visits /upstox/connect).
 *
 * Strategy:
 *   - Store token in Supabase (primary) → SQLite (fallback) → Memory (last resort)
 *   - Keep a lastKnownGoodToken in memory so Supabase read failures don't break connection
 *   - isExpired() uses the actual expires_at with NO buffer — use every second of the token
 *   - proactiveRefresh() attempts refresh_token grant if available, otherwise just logs
 *     a warning and keeps the existing token alive — never breaks the connection
 *   - getValidAccessToken() NEVER returns null if a non-expired token exists anywhere
 */

import axios from 'axios';
import path from 'path';
import { createRequire } from 'module';
import { getSupabaseClient } from '../../lib/supabase';

interface TokenRecord {
  access_token: string;
  refresh_token: string | null;
  expires_at: number; // Unix ms
}

// ─── SQLite (local / Railway / Render) ───────────────────────────────────────

type SqliteDB = {
  exec: (sql: string) => void;
  prepare: (sql: string) => { run: (...args: any[]) => void; get: () => any };
};

let sqliteDb: SqliteDB | null = null;
let sqliteInitialized = false;

function getSqliteDb(): SqliteDB | null {
  if (sqliteInitialized) return sqliteDb;
  sqliteInitialized = true;
  if (process.env.VERCEL) return null;
  try {
    const _require = createRequire(import.meta.url);
    const Database = _require('better-sqlite3');
    const dbPath = path.join(process.cwd(), 'upstox-tokens.db');
    sqliteDb = new Database(dbPath) as SqliteDB;
    sqliteDb.exec(`
      CREATE TABLE IF NOT EXISTS upstox_tokens (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        access_token TEXT NOT NULL,
        refresh_token TEXT,
        expires_at INTEGER NOT NULL,
        created_at INTEGER NOT NULL,
        updated_at INTEGER NOT NULL
      )
    `);
    console.log('[UpstoxTokenManager] SQLite storage initialised');
  } catch {
    console.log('[UpstoxTokenManager] SQLite unavailable');
  }
  return sqliteDb;
}

// ─── In-memory cache (survives warm restarts, guards against Supabase read failures) ──
let memoryToken: TokenRecord | null = null;
// Last known good token — never cleared, used as ultimate fallback
let lastKnownGoodToken: TokenRecord | null = null;

// ─── Unified read / write ─────────────────────────────────────────────────────

async function readRecord(): Promise<TokenRecord | null> {
  // 1. Supabase
  const sb = getSupabaseClient();
  if (sb) {
    try {
      const { data, error } = await sb
        .from('upstox_tokens')
        .select('access_token, refresh_token, expires_at')
        .order('id', { ascending: false })
        .limit(1)
        .single();
      if (!error && data) {
        const record: TokenRecord = {
          access_token: data.access_token,
          refresh_token: data.refresh_token ?? null,
          expires_at: Number(data.expires_at),
        };
        // Keep memory in sync with Supabase
        memoryToken = record;
        // Update lastKnownGoodToken only if not expired
        if (record.expires_at > Date.now()) {
          lastKnownGoodToken = record;
        }
        return record;
      }
    } catch (e: any) {
      console.error('[UpstoxTokenManager] Supabase read error:', e.message);
    }
  }

  // 2. SQLite
  const db = getSqliteDb();
  if (db) {
    try {
      const row = db.prepare('SELECT * FROM upstox_tokens ORDER BY id DESC LIMIT 1').get() as any;
      if (row) {
        const record: TokenRecord = { access_token: row.access_token, refresh_token: row.refresh_token, expires_at: row.expires_at };
        if (record.expires_at > Date.now()) lastKnownGoodToken = record;
        return record;
      }
    } catch {}
  }

  // 3. Memory
  if (memoryToken) return memoryToken;

  // 4. Last known good (Supabase was unreachable but we had a valid token before)
  return lastKnownGoodToken;
}

async function writeRecord(r: TokenRecord): Promise<void> {
  const now = Date.now();
  memoryToken = r;
  if (r.expires_at > now) lastKnownGoodToken = r;

  // 1. Supabase
  const sb = getSupabaseClient();
  if (sb) {
    try {
      await sb.from('upstox_tokens').delete().neq('id', 0);
      const { error } = await sb.from('upstox_tokens').insert({
        access_token: r.access_token,
        refresh_token: r.refresh_token,
        expires_at: r.expires_at,
        created_at: now,
        updated_at: now,
      });
      if (!error) {
        console.log('[UpstoxTokenManager] Token written to Supabase');
        return;
      }
      console.error('[UpstoxTokenManager] Supabase write error:', error.message);
    } catch (e: any) {
      console.error('[UpstoxTokenManager] Supabase write exception:', e.message);
    }
  }

  // 2. SQLite
  const db = getSqliteDb();
  if (db) {
    try {
      db.prepare('DELETE FROM upstox_tokens').run();
      db.prepare(
        'INSERT INTO upstox_tokens (access_token, refresh_token, expires_at, created_at, updated_at) VALUES (?, ?, ?, ?, ?)'
      ).run(r.access_token, r.refresh_token, r.expires_at, now, now);
    } catch {}
  }
}

// ─── Token Manager ────────────────────────────────────────────────────────────

export class UpstoxTokenManager {
  constructor() {
    const envToken = process.env.UPSTOX_ACCESS_TOKEN;
    if (envToken && envToken !== 'your_token_here' && envToken.length > 20 && !memoryToken) {
      const expiresAt = Date.now() + 24 * 60 * 60 * 1000;
      memoryToken = { access_token: envToken, refresh_token: null, expires_at: expiresAt };
      lastKnownGoodToken = memoryToken;
      console.log('[UpstoxTokenManager] Seeded memory token from UPSTOX_ACCESS_TOKEN env var');
    }
  }

  async storeTokens(accessToken: string, refreshToken: string | null, expiresIn: number): Promise<void> {
    const expiresAt = Date.now() + expiresIn * 1000;
    await writeRecord({ access_token: accessToken, refresh_token: refreshToken, expires_at: expiresAt });
    console.log(`[UpstoxTokenManager] Tokens stored | expires=${new Date(expiresAt).toISOString()} | len=${accessToken.length}`);
  }

  /**
   * True only when token is ACTUALLY expired (no buffer).
   * We use every second of the token lifetime.
   */
  private isExpired(expiresAt: number): boolean {
    return Date.now() >= expiresAt;
  }

  /** True when token expires within the proactive window (default 2h) */
  isExpiringSoon(expiresAt: number, windowMs = 2 * 60 * 60 * 1000): boolean {
    return Date.now() >= expiresAt - windowMs;
  }

  async refreshAccessToken(refreshToken: string, redirectUriOverride?: string): Promise<void> {
    const clientId     = process.env.UPSTOX_CLIENT_ID     || '37381aec-8f2d-47da-a89b-ab9476dd15d7';
    const clientSecret = process.env.UPSTOX_CLIENT_SECRET || 'tqfd41uqib';
    const redirectUri  = redirectUriOverride
      || process.env.UPSTOX_REDIRECT_URI
      || 'https://backend-render-qyt7.onrender.com/api/upstox/callback';

    const params = new URLSearchParams({
      grant_type:    'refresh_token',
      refresh_token: refreshToken,
      client_id:     clientId,
      client_secret: clientSecret,
      redirect_uri:  redirectUri,
    });

    const { data } = await axios.post('https://api.upstox.com/v2/login/authorization/token', params, {
      headers: { 'Content-Type': 'application/x-www-form-urlencoded', Accept: 'application/json' },
    });

    const { access_token, refresh_token: newRefresh, expires_in } = data;
    if (!access_token) throw new Error('No access_token in refresh response');
    await this.storeTokens(access_token, newRefresh || refreshToken, expires_in || 86400);
    console.log('[UpstoxTokenManager] Token refreshed successfully via refresh_token grant');
  }

  /**
   * Proactive refresh — called every 30 min by UpstoxScheduler.
   *
   * If refresh_token is available → attempt silent refresh.
   * If not (Upstox authorization_code apps) → log warning, keep existing token.
   * NEVER breaks the connection — only logs that re-auth will be needed.
   */
  async proactiveRefresh(): Promise<boolean> {
    const record = await readRecord();
    if (!record) {
      console.log('[UpstoxTokenManager] Proactive refresh: no token stored');
      return false;
    }

    const minsLeft = Math.round((record.expires_at - Date.now()) / 60000);

    if (!this.isExpiringSoon(record.expires_at)) {
      console.log(`[UpstoxTokenManager] Token healthy — ${minsLeft}m left, no refresh needed`);
      return false;
    }

    console.log(`[UpstoxTokenManager] Token expiring in ${minsLeft}m — attempting refresh`);

    // Try refresh_token grant if available
    if (record.refresh_token) {
      try {
        await this.refreshAccessToken(record.refresh_token);
        console.log('[UpstoxTokenManager] Proactive refresh: SUCCESS via refresh_token');
        return true;
      } catch (e: any) {
        console.warn(`[UpstoxTokenManager] refresh_token grant failed (${e.message}) — Upstox may not support it`);
      }
    }

    // No refresh_token or refresh failed — keep existing token, warn about re-auth
    if (minsLeft > 0) {
      console.warn(`[UpstoxTokenManager] Token expires in ${minsLeft}m — re-auth needed at /upstox/connect before expiry`);
    } else {
      console.error('[UpstoxTokenManager] Token EXPIRED — connection will fail until re-auth at /upstox/connect');
    }
    return false;
  }

  /**
   * Returns a valid access token, or null only if truly expired with no fallback.
   * Uses lastKnownGoodToken as ultimate fallback when Supabase is unreachable.
   */
  async getValidAccessToken(): Promise<string | null> {
    const record = await readRecord();

    // ── No record anywhere ────────────────────────────────────────────────────
    if (!record) {
      const envToken = process.env.UPSTOX_ACCESS_TOKEN;
      if (envToken && envToken !== 'your_token_here' && envToken.length > 20) {
        console.log('[UpstoxTokenManager] No record — seeding from UPSTOX_ACCESS_TOKEN env var');
        const expiresAt = Date.now() + 24 * 60 * 60 * 1000;
        await writeRecord({ access_token: envToken, refresh_token: null, expires_at: expiresAt });
        return envToken;
      }
      console.log('[UpstoxTokenManager] No tokens found anywhere');
      return null;
    }

    // ── Token still valid ─────────────────────────────────────────────────────
    if (!this.isExpired(record.expires_at)) {
      const minsLeft = Math.round((record.expires_at - Date.now()) / 60000);
      if (minsLeft % 60 === 0 || minsLeft <= 30) {
        // Log only at hour boundaries or when < 30 min left (avoid log spam)
        console.log(`[UpstoxTokenManager] Valid token — ${minsLeft}m remaining`);
      }
      return record.access_token;
    }

    // ── Token expired ─────────────────────────────────────────────────────────
    console.warn('[UpstoxTokenManager] Token expired — attempting recovery');

    // Try refresh_token grant
    if (record.refresh_token) {
      try {
        await this.refreshAccessToken(record.refresh_token);
        const fresh = await readRecord();
        if (fresh && !this.isExpired(fresh.expires_at)) {
          console.log('[UpstoxTokenManager] Recovered via refresh_token grant');
          return fresh.access_token;
        }
      } catch (e: any) {
        console.warn(`[UpstoxTokenManager] refresh_token recovery failed: ${e.message}`);
      }
    }

    // Try env var fallback
    const envToken = process.env.UPSTOX_ACCESS_TOKEN;
    if (envToken && envToken !== 'your_token_here' && envToken.length > 20) {
      console.log('[UpstoxTokenManager] Expired — falling back to UPSTOX_ACCESS_TOKEN env var');
      const expiresAt = Date.now() + 24 * 60 * 60 * 1000;
      await writeRecord({ access_token: envToken, refresh_token: null, expires_at: expiresAt });
      return envToken;
    }

    console.error('[UpstoxTokenManager] Token expired, no recovery possible — re-auth required at /upstox/connect');
    return null;
  }

  async exchangeAuthorizationCode(code: string, redirectUriOverride?: string): Promise<void> {
    const clientId     = process.env.UPSTOX_CLIENT_ID     || '37381aec-8f2d-47da-a89b-ab9476dd15d7';
    const clientSecret = process.env.UPSTOX_CLIENT_SECRET || 'tqfd41uqib';
    const redirectUri  = redirectUriOverride
      || process.env.UPSTOX_REDIRECT_URI
      || 'https://backend-render-qyt7.onrender.com/api/upstox/callback';

    const params = new URLSearchParams({
      grant_type:   'authorization_code',
      code,
      client_id:    clientId,
      client_secret: clientSecret,
      redirect_uri: redirectUri,
    });

    const { data } = await axios.post('https://api.upstox.com/v2/login/authorization/token', params, {
      headers: { 'Content-Type': 'application/x-www-form-urlencoded', Accept: 'application/json' },
    });

    const { access_token, refresh_token, expires_in } = data;
    if (!access_token) throw new Error('No access_token in response');
    await this.storeTokens(access_token, refresh_token || null, expires_in || 86400);
    console.log('[UpstoxTokenManager] Authorization code exchanged successfully');
  }

  close(): void { /* no-op */ }

  /** Returns token expiry info for monitoring endpoints */
  async getTokenInfo(): Promise<{ expiresAt: string; minsLeft: number; expiringSoon: boolean; isExpired: boolean } | null> {
    const record = await readRecord();
    if (!record) return null;
    const minsLeft = Math.round((record.expires_at - Date.now()) / 60000);
    return {
      expiresAt:    new Date(record.expires_at).toISOString(),
      minsLeft,
      expiringSoon: this.isExpiringSoon(record.expires_at),
      isExpired:    this.isExpired(record.expires_at),
    };
  }
}
