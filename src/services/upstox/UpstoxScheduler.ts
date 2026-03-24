/**
 * UpstoxScheduler — Daily auto-connection and proactive token refresh
 * 
 * Responsibilities:
 *   • Schedule daily token refresh before market open (8:30 AM IST)
 *   • Proactive token validation on app startup
 *   • Ensure connection stays active without manual intervention
 */

import { UpstoxTokenManager } from './UpstoxTokenManager';

export class UpstoxScheduler {
  private tokenManager: UpstoxTokenManager;
  private dailyRefreshInterval: NodeJS.Timeout | null = null;

  constructor(tokenManager: UpstoxTokenManager) {
    this.tokenManager = tokenManager;
  }

  /**
   * Start the scheduler — validates token on startup and schedules daily refresh
   */
  start(): void {
    console.log('[UpstoxScheduler] Starting scheduler...');

    // Validate token immediately on startup
    this.validateTokenOnStartup();

    // Schedule daily refresh at 8:30 AM IST (3:00 AM UTC)
    this.scheduleDailyRefresh();
  }

  /**
   * Validate token on app startup
   */
  private async validateTokenOnStartup(): Promise<void> {
    try {
      const token = await this.tokenManager.getValidAccessToken();
      if (token) {
        console.log('[UpstoxScheduler] Token validated successfully on startup');
      } else {
        console.warn('[UpstoxScheduler] No valid token found. Please authenticate via OAuth.');
      }
    } catch (error) {
      console.error('[UpstoxScheduler] Token validation failed on startup:', error);
    }
  }

  /**
   * Schedule daily token refresh at 8:30 AM IST (before market open)
   */
  private scheduleDailyRefresh(): void {
    const now = new Date();
    const targetTime = new Date();

    // Set target time to 8:30 AM IST (3:00 AM UTC)
    targetTime.setUTCHours(3, 0, 0, 0);

    // If target time has passed today, schedule for tomorrow
    if (now > targetTime) {
      targetTime.setDate(targetTime.getDate() + 1);
    }

    const msUntilTarget = targetTime.getTime() - now.getTime();

    console.log(`[UpstoxScheduler] Next token refresh scheduled at ${targetTime.toISOString()}`);

    // Schedule first refresh
    setTimeout(() => {
      this.performDailyRefresh();

      // Then repeat every 24 hours
      this.dailyRefreshInterval = setInterval(() => {
        this.performDailyRefresh();
      }, 24 * 60 * 60 * 1000); // 24 hours
    }, msUntilTarget);
  }

  /**
   * Perform daily token refresh
   */
  private async performDailyRefresh(): Promise<void> {
    console.log('[UpstoxScheduler] Performing daily token refresh...');

    try {
      const token = await this.tokenManager.getValidAccessToken();
      if (token) {
        console.log('[UpstoxScheduler] Daily token refresh successful');
      } else {
        console.warn('[UpstoxScheduler] Daily refresh failed: No valid token. Re-authentication required.');
      }
    } catch (error) {
      console.error('[UpstoxScheduler] Daily token refresh failed:', error);
    }
  }

  /**
   * Stop the scheduler
   */
  stop(): void {
    if (this.dailyRefreshInterval) {
      clearInterval(this.dailyRefreshInterval);
      this.dailyRefreshInterval = null;
      console.log('[UpstoxScheduler] Scheduler stopped');
    }
  }
}
