/**
 * UpstoxTokenManager — Token storage and auto-refresh logic
 *
 * Storage priority (first available wins):
 *   1. Supabase  — works everywhere including Vercel (set SUPABASE_URL + SUPABASE_SERVICE_KEY)
 *   2. SQLite    — local dev / Railway / Render (writable filesystem)
 *   3. Memory    — last resort; token lost on process restart / cold start
 *
 * Auto-refresh strategy:
 *   - Upstox access tokens expire in 24h (86400s)
 *   - We proactively refresh when < 2h remain (called every 30 min by UpstoxScheduler)
 *   - On expiry (< 5 min buffer), refresh is also triggered on every getValidAccessToken() call
 *   - refresh_token grant is used when available; otherwise re-auth is required
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

// ─── In-memory last resort ────────────────────────────────────────────────────
let memoryToken: TokenRecord | null = null;

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
        return {
          access_token: data.access_token,
          refresh_token: data.refresh_token ?? null,
          expires_at: Number(data.expires_at),
        };
      }
    } catch (e: any) {
      console.error('[UpstoxTokenManager] Supabase read error:', e.message);
    }
  }

  // 2. SQLite
  const db = getSqliteDb();
  if (db) {
    const row = db.prepare('SELECT * FROM upstox_tokens ORDER BY id DESC LIMIT 1').get() as any;
    if (row) return { access_token: row.access_token, refresh_token: row.refresh_token, expires_at: row.expires_at };
  }

  // 3. Memory
  return memoryToken;
}

async function writeRecord(r: TokenRecord): Promise<void> {
  const now = Date.now();

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
        memoryToken = r; // keep memory in sync
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
    db.prepare('DELETE FROM upstox_tokens').run();
    db.prepare(
      'INSERT INTO upstox_tokens (access_token, refresh_token, expires_at, created_at, updated_at) VALUES (?, ?, ?, ?, ?)'
    ).run(r.access_token, r.refresh_token, r.expires_at, now, now);
    memoryToken = r;
    return;
  }

  // 3. Memory
  memoryToken = r;
}

// ─── Token Manager ────────────────────────────────────────────────────────────

export class UpstoxTokenManager {
  constructor() {
    const envToken = process.env.UPSTOX_ACCESS_TOKEN;
    if (envToken && envToken !== 'your_token_here' && envToken.length > 20 && !memoryToken) {
      const expiresAt = Date.now() + 24 * 60 * 60 * 1000;
      memoryToken = { access_token: envToken, refresh_token: null, expires_at: expiresAt };
      console.log('[UpstoxTokenManager] Seeded memory token from UPSTOX_ACCESS_TOKEN env var');
    }
  }

  async storeTokens(accessToken: string, refreshToken: string | null, expiresIn: number): Promise<void> {
    const expiresAt = Date.now() + expiresIn * 1000;
    await writeRecord({ access_token: accessToken, refresh_token: refreshToken, expires_at: expiresAt });
    console.log(`[UpstoxTokenManager] Tokens stored | expires=${new Date(expiresAt).toISOString()} | len=${accessToken.length}`);
  }

  /** True when token is within 5-min of expiry (hard expiry guard) */
  private isExpired(expiresAt: number): boolean {
    return Date.now() >= expiresAt - 5 * 60 * 1000;
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

    if (!clientId || !clientSecret || !redirectUri) throw new Error('Upstox credentials not configured');

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
    console.log('[UpstoxTokenManager] Token refreshed successfully');
  }

  /**
   * Proactive refresh — call this on a schedule (every 30 min).
   * Refreshes if token expires within 2 hours.
   * Returns true if a refresh was attempted.
   */
  async proactiveRefresh(): Promise<boolean> {
    const record = await readRecord();
    if (!record) {
      console.log('[UpstoxTokenManager] Proactive refresh: no token stored');
      return false;
    }

    const minsLeft = Math.round((record.expires_at - Date.now()) / 60000);

    if (!this.isExpiringSoon(record.expires_at)) {
      console.log(`[UpstoxTokenManager] Proactive refresh: token healthy (${minsLeft}m left) — skipping`);
      return false;
    }

    console.log(`[UpstoxTokenManager] Proactive refresh triggered — ${minsLeft}m until expiry`);

    if (record.refresh_token) {
      try {
        await this.refreshAccessToken(record.refresh_token);
        console.log('[UpstoxTokenManager] Proactive refresh: SUCCESS');
        return true;
      } catch (e: any) {
        console.error('[UpstoxTokenManager] Proactive refresh failed:', e.message);
      }
    } else {
      console.warn('[UpstoxTokenManager] Proactive refresh: no refresh_token — manual re-auth required');
    }
    return false;
  }

  async getValidAccessToken(): Promise<string | null> {
    const record = await readRecord();

    // ── No record ─────────────────────────────────────────────────────────────
    if (!record) {
      const envToken = process.env.UPSTOX_ACCESS_TOKEN;
      if (envToken && envToken !== 'your_token_here' && envToken.length > 20) {
        console.log('[UpstoxTokenManager] No record — seeding from UPSTOX_ACCESS_TOKEN env var');
        const expiresAt = Date.now() + 24 * 60 * 60 * 1000;
        await writeRecord({ access_token: envToken, refresh_token: null, expires_at: expiresAt });
        return envToken;
      }
      console.log('[UpstoxTokenManager] No tokens found');
      return null;
    }

    // ── Expired (hard guard) ──────────────────────────────────────────────────
    if (this.isExpired(record.expires_at)) {
      if (record.refresh_token) {
        try {
          await this.refreshAccessToken(record.refresh_token);
          return (await readRecord())?.access_token || null;
        } catch (e) {
          console.error('[UpstoxTokenManager] Auto-refresh on expiry failed:', e);
        }
      }
      const envToken = process.env.UPSTOX_ACCESS_TOKEN;
      if (envToken && envToken !== 'your_token_here' && envToken.length > 20) {
        console.log('[UpstoxTokenManager] Expired — falling back to UPSTOX_ACCESS_TOKEN env var');
        const expiresAt = Date.now() + 24 * 60 * 60 * 1000;
        await writeRecord({ access_token: envToken, refresh_token: null, expires_at: expiresAt });
        return envToken;
      }
      console.error('[UpstoxTokenManager] Token expired, no refresh token, no env fallback');
      return null;
    }

    const minsLeft = Math.round((record.expires_at - Date.now()) / 60000);
    console.log(`[UpstoxTokenManager] Valid token (expires in ${minsLeft}m, len=${record.access_token.length})`);
    return record.access_token;
  }

  async exchangeAuthorizationCode(code: string, redirectUriOverride?: string): Promise<void> {
    const clientId     = process.env.UPSTOX_CLIENT_ID     || '37381aec-8f2d-47da-a89b-ab9476dd15d7';
    const clientSecret = process.env.UPSTOX_CLIENT_SECRET || 'tqfd41uqib';
    const redirectUri  = redirectUriOverride
      || process.env.UPSTOX_REDIRECT_URI
      || 'https://backend-render-qyt7.onrender.com/api/upstox/callback';

    if (!clientId || !clientSecret || !redirectUri) throw new Error('Upstox credentials not configured');

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
  async getTokenInfo(): Promise<{ expiresAt: string; minsLeft: number; expiringSoon: boolean } | null> {
    const record = await readRecord();
    if (!record) return null;
    const minsLeft = Math.round((record.expires_at - Date.now()) / 60000);
    return {
      expiresAt:    new Date(record.expires_at).toISOString(),
      minsLeft,
      expiringSoon: this.isExpiringSoon(record.expires_at),
    };
  }
}
