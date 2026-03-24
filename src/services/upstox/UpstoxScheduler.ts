/**
 * UpstoxScheduler — Proactive token monitoring + daily refresh
 *
 * NOTE: Upstox tokens are valid for 24h. Most app types do NOT support
 * refresh_token grant — re-auth via /upstox/connect is required once per day.
 *
 * Strategy:
 *   1. Startup — validate token, log status
 *   2. Every 30 min — proactiveRefresh() attempts silent refresh if < 2h left;
 *      if no refresh_token, logs a warning but KEEPS the connection alive
 *   3. Daily at 8:30 AM IST (3:00 AM UTC) — force refresh attempt;
 *      if it fails, logs a clear re-auth reminder (does NOT break connection)
 */

import { UpstoxTokenManager } from './UpstoxTokenManager';

const PROACTIVE_INTERVAL_MS  = 30 * 60 * 1000;  // 30 minutes
const DAILY_REFRESH_HOUR_UTC = 3;                // 3:00 AM UTC = 8:30 AM IST
const DAILY_REFRESH_MIN_UTC  = 0;

export class UpstoxScheduler {
  private tokenManager: UpstoxTokenManager;
  private proactiveTimer: NodeJS.Timeout | null = null;
  private dailyTimer:     NodeJS.Timeout | null = null;

  constructor(tokenManager: UpstoxTokenManager) {
    this.tokenManager = tokenManager;
  }

  start(): void {
    console.log('[UpstoxScheduler] Starting — proactive check every 30 min + daily at 08:30 IST');

    // 1. Validate immediately on startup
    this.validateOnStartup();

    // 2. Proactive check every 30 min
    this.proactiveTimer = setInterval(() => {
      this.runProactiveRefresh();
    }, PROACTIVE_INTERVAL_MS);

    // 3. Hard daily refresh at 8:30 AM IST
    this.scheduleDailyRefresh();
  }

  private async validateOnStartup(): Promise<void> {
    try {
      const token = await this.tokenManager.getValidAccessToken();
      if (token) {
        const info = await this.tokenManager.getTokenInfo();
        console.log(`[UpstoxScheduler] Startup: token valid — ${info?.minsLeft ?? '?'}m remaining`);
        // Immediate proactive check in case token is already near expiry
        await this.runProactiveRefresh();
      } else {
        console.warn('[UpstoxScheduler] Startup: no valid token — visit /upstox/connect to authenticate');
      }
    } catch (e: any) {
      console.error('[UpstoxScheduler] Startup validation error:', e.message);
    }
  }

  private async runProactiveRefresh(): Promise<void> {
    try {
      await this.tokenManager.proactiveRefresh();
    } catch (e: any) {
      // proactiveRefresh never throws — this is just a safety net
      console.error('[UpstoxScheduler] Proactive refresh unexpected error:', e.message);
    }
  }

  /**
   * Schedule a hard refresh at 8:30 AM IST (3:00 AM UTC) every day.
   * Attempts refresh_token grant; if unavailable, logs re-auth reminder.
   * NEVER marks the connection as broken — that only happens when the token
   * actually expires and getValidAccessToken() returns null.
   */
  private scheduleDailyRefresh(): void {
    const msUntilNext = this.msUntilNextDailyRefresh();
    const nextAt = new Date(Date.now() + msUntilNext);
    console.log(`[UpstoxScheduler] Daily refresh scheduled at ${nextAt.toISOString()} (${Math.round(msUntilNext / 60000)}m from now)`);

    this.dailyTimer = setTimeout(async () => {
      await this.runDailyRefresh();
      // Re-schedule every 24h
      this.dailyTimer = setInterval(() => {
        this.runDailyRefresh();
      }, 24 * 60 * 60 * 1000);
    }, msUntilNext);
  }

  private msUntilNextDailyRefresh(): number {
    const now    = new Date();
    const target = new Date();
    target.setUTCHours(DAILY_REFRESH_HOUR_UTC, DAILY_REFRESH_MIN_UTC, 0, 0);
    if (now >= target) target.setUTCDate(target.getUTCDate() + 1);
    return target.getTime() - now.getTime();
  }

  private async runDailyRefresh(): Promise<void> {
    console.log('[UpstoxScheduler] Daily refresh firing at 08:30 IST...');
    try {
      const info = await this.tokenManager.getTokenInfo();
      if (!info) {
        console.warn('[UpstoxScheduler] Daily refresh: no token found — re-auth required at /upstox/connect');
        return;
      }

      console.log(`[UpstoxScheduler] Daily refresh: token has ${info.minsLeft}m left, expiringSoon=${info.expiringSoon}`);

      // Always attempt proactive refresh at daily window
      const refreshed = await this.tokenManager.proactiveRefresh();

      if (!refreshed) {
        if (info.minsLeft > 120) {
          // Token still has plenty of time — this is fine, no action needed
          console.log('[UpstoxScheduler] Daily refresh: token still healthy, no refresh needed');
        } else {
          // Token is expiring and refresh failed — user must re-auth
          console.warn(
            `[UpstoxScheduler] Daily refresh: token expires in ${info.minsLeft}m and auto-refresh unavailable. ` +
            'Visit https://backend-render-qyt7.onrender.com/upstox/connect to re-authenticate.'
          );
        }
      } else {
        console.log('[UpstoxScheduler] Daily refresh: token refreshed successfully');
      }
    } catch (e: any) {
      console.error('[UpstoxScheduler] Daily refresh error:', e.message);
    }
  }

  stop(): void {
    if (this.proactiveTimer) { clearInterval(this.proactiveTimer); this.proactiveTimer = null; }
    if (this.dailyTimer)     { clearTimeout(this.dailyTimer);      this.dailyTimer = null; }
    console.log('[UpstoxScheduler] Stopped');
  }
}
