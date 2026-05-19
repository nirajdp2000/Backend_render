/**
 * UpstoxScheduler - proactive token monitoring plus daily refresh.
 *
 * Upstox access tokens are commonly valid for 24 hours. Some app types do not
 * support refresh_token grant, so this scheduler never marks a still-valid
 * token as broken. It validates on startup, checks every 30 minutes, and runs
 * a hard refresh attempt every day at 2:45 AM IST, before the 3:00 AM boundary.
 */

import { UpstoxTokenManager } from './UpstoxTokenManager';

const PROACTIVE_INTERVAL_MS = 30 * 60 * 1000;
const DAILY_REFRESH_HOUR_IST = 2;
const DAILY_REFRESH_MIN_IST = 45;

export class UpstoxScheduler {
  private tokenManager: UpstoxTokenManager;
  private proactiveTimer: NodeJS.Timeout | null = null;
  private dailyTimer: NodeJS.Timeout | null = null;

  constructor(tokenManager: UpstoxTokenManager) {
    this.tokenManager = tokenManager;
  }

  start(): void {
    console.log('[UpstoxScheduler] Starting - proactive check every 30 min + daily before 03:00 IST');
    this.validateOnStartup();
    this.proactiveTimer = setInterval(() => {
      this.runProactiveRefresh();
    }, PROACTIVE_INTERVAL_MS);
    this.scheduleDailyRefresh();
  }

  private async validateOnStartup(): Promise<void> {
    try {
      const token = await this.tokenManager.getValidAccessToken();
      if (token) {
        const info = await this.tokenManager.getTokenInfo();
        console.log(`[UpstoxScheduler] Startup: token valid - ${info?.minsLeft ?? '?'}m remaining`);
        await this.runProactiveRefresh();
      } else {
        console.warn('[UpstoxScheduler] Startup: no valid token - visit /upstox/connect to authenticate');
      }
    } catch (e: any) {
      console.error('[UpstoxScheduler] Startup validation error:', e.message);
    }
  }

  private async runProactiveRefresh(): Promise<void> {
    try {
      await this.tokenManager.proactiveRefresh();
    } catch (e: any) {
      console.error('[UpstoxScheduler] Proactive refresh unexpected error:', e.message);
    }
  }

  private scheduleDailyRefresh(): void {
    const msUntilNext = this.msUntilNextDailyRefresh();
    const nextAt = new Date(Date.now() + msUntilNext);
    console.log(`[UpstoxScheduler] Daily refresh scheduled at ${nextAt.toISOString()} (${Math.round(msUntilNext / 60000)}m from now)`);

    this.dailyTimer = setTimeout(async () => {
      await this.runDailyRefresh();
      this.dailyTimer = setInterval(() => {
        this.runDailyRefresh();
      }, 24 * 60 * 60 * 1000);
    }, msUntilNext);
  }

  private msUntilNextDailyRefresh(): number {
    const now = new Date();
    const istNow = new Date(now.toLocaleString('en-US', { timeZone: 'Asia/Kolkata' }));
    const targetIst = new Date(istNow);
    targetIst.setHours(DAILY_REFRESH_HOUR_IST, DAILY_REFRESH_MIN_IST, 0, 0);
    if (istNow >= targetIst) targetIst.setDate(targetIst.getDate() + 1);
    return targetIst.getTime() - istNow.getTime();
  }

  private async runDailyRefresh(): Promise<void> {
    console.log('[UpstoxScheduler] Daily refresh firing before 03:00 IST...');
    try {
      const info = await this.tokenManager.getTokenInfo();
      if (!info) {
        console.warn('[UpstoxScheduler] Daily refresh: no token found - re-auth required at /upstox/connect');
        return;
      }

      console.log(`[UpstoxScheduler] Daily refresh: token has ${info.minsLeft}m left, expiringSoon=${info.expiringSoon}`);
      const refreshed = await this.tokenManager.proactiveRefresh();

      if (!refreshed) {
        if (info.minsLeft > 120) {
          console.log('[UpstoxScheduler] Daily refresh: token still healthy, no refresh needed');
        } else {
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
    if (this.dailyTimer) { clearTimeout(this.dailyTimer); this.dailyTimer = null; }
    console.log('[UpstoxScheduler] Stopped');
  }
}
