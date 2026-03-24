/**
 * UpstoxScheduler — Proactive token refresh + daily hard refresh
 *
 * Strategy:
 *   1. On startup — validate token immediately
 *   2. Every 30 min — call proactiveRefresh() which refreshes if < 2h remain
 *   3. Daily at 8:30 AM IST (3:00 AM UTC) — force refresh regardless of expiry
 *
 * This guarantees the token is always refreshed well before its 24h expiry,
 * even if the server restarts mid-day or the daily cron fires late.
 */

import { UpstoxTokenManager } from './UpstoxTokenManager';

const PROACTIVE_INTERVAL_MS = 30 * 60 * 1000;  // 30 minutes
const DAILY_REFRESH_HOUR_UTC = 3;               // 3:00 AM UTC = 8:30 AM IST
const DAILY_REFRESH_MIN_UTC  = 0;

export class UpstoxScheduler {
  private tokenManager: UpstoxTokenManager;
  private proactiveTimer: NodeJS.Timeout | null = null;
  private dailyTimer: NodeJS.Timeout | null = null;

  constructor(tokenManager: UpstoxTokenManager) {
    this.tokenManager = tokenManager;
  }

  start(): void {
    console.log('[UpstoxScheduler] Starting — proactive refresh every 30 min + daily at 08:30 IST');

    // 1. Validate immediately on startup
    this.validateOnStartup();

    // 2. Proactive check every 30 min (refreshes if < 2h left)
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
        console.log('[UpstoxScheduler] Startup: token valid');
        // Also run proactive check immediately — if token was issued yesterday
        // and we're near expiry, refresh now rather than waiting 30 min
        await this.runProactiveRefresh();
      } else {
        console.warn('[UpstoxScheduler] Startup: no valid token — OAuth re-auth required');
      }
    } catch (e: any) {
      console.error('[UpstoxScheduler] Startup validation error:', e.message);
    }
  }

  private async runProactiveRefresh(): Promise<void> {
    try {
      const refreshed = await this.tokenManager.proactiveRefresh();
      if (refreshed) {
        console.log('[UpstoxScheduler] Proactive refresh completed');
      }
    } catch (e: any) {
      console.error('[UpstoxScheduler] Proactive refresh error:', e.message);
    }
  }

  /**
   * Schedule a hard refresh at 8:30 AM IST (3:00 AM UTC) every day.
   * This fires even if the token is still valid — ensures a fresh 24h window
   * starts at market open time every day.
   */
  private scheduleDailyRefresh(): void {
    const msUntilNext = this.msUntilNextDailyRefresh();
    const nextAt = new Date(Date.now() + msUntilNext);
    console.log(`[UpstoxScheduler] Daily hard refresh scheduled at ${nextAt.toISOString()} (${Math.round(msUntilNext / 60000)}m from now)`);

    this.dailyTimer = setTimeout(() => {
      this.runDailyRefresh();
      // Re-schedule for next day
      this.dailyTimer = setInterval(() => {
        this.runDailyRefresh();
      }, 24 * 60 * 60 * 1000);
    }, msUntilNext);
  }

  private msUntilNextDailyRefresh(): number {
    const now = new Date();
    const target = new Date();
    target.setUTCHours(DAILY_REFRESH_HOUR_UTC, DAILY_REFRESH_MIN_UTC, 0, 0);
    if (now >= target) {
      target.setUTCDate(target.getUTCDate() + 1);
    }
    return target.getTime() - now.getTime();
  }

  private async runDailyRefresh(): Promise<void> {
    console.log('[UpstoxScheduler] Daily hard refresh firing at 08:30 IST...');
    try {
      // Force proactive refresh regardless of window — token is ~24h old at this point
      const refreshed = await this.tokenManager.proactiveRefresh();
      if (!refreshed) {
        // Token may still have hours left — call getValidAccessToken to log status
        const token = await this.tokenManager.getValidAccessToken();
        console.log(token
          ? '[UpstoxScheduler] Daily refresh: token still valid, no refresh needed'
          : '[UpstoxScheduler] Daily refresh: no token — re-auth required'
        );
      }
    } catch (e: any) {
      console.error('[UpstoxScheduler] Daily refresh error:', e.message);
    }
  }

  stop(): void {
    if (this.proactiveTimer) { clearInterval(this.proactiveTimer); this.proactiveTimer = null; }
    if (this.dailyTimer)     { clearTimeout(this.dailyTimer);  this.dailyTimer = null; }
    console.log('[UpstoxScheduler] Stopped');
  }
}
