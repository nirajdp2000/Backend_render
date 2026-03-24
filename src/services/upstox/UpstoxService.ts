/**
 * UpstoxService — Main entry point for Upstox integration
 * 
 * Responsibilities:
 *   • Initialize token manager, API client, and scheduler
 *   • Provide singleton instance for app-wide access
 *   • Coordinate OAuth flow and token management
 */

import { UpstoxTokenManager } from './UpstoxTokenManager';
import { UpstoxApiClient } from './UpstoxApiClient';
import { UpstoxScheduler } from './UpstoxScheduler';

export class UpstoxService {
  private static instance: UpstoxService | null = null;

  public tokenManager: UpstoxTokenManager;
  public apiClient: UpstoxApiClient;
  public scheduler: UpstoxScheduler;

  private constructor() {
    this.tokenManager = new UpstoxTokenManager();
    this.apiClient = new UpstoxApiClient(this.tokenManager);
    this.scheduler = new UpstoxScheduler(this.tokenManager);
  }

  /**
   * Get singleton instance
   */
  static getInstance(): UpstoxService {
    if (!UpstoxService.instance) {
      UpstoxService.instance = new UpstoxService();
    }
    return UpstoxService.instance;
  }

  /**
   * Initialize the service (call on app startup)
   */
  initialize(): void {
    console.log('[UpstoxService] Initializing Upstox integration...');
    this.scheduler.start();
  }

  /**
   * Generate OAuth authorization URL for user login
   */
  getAuthorizationUrl(redirectUriOverride?: string): string {
    const clientId = process.env.UPSTOX_CLIENT_ID;
    const redirectUri = redirectUriOverride || process.env.UPSTOX_REDIRECT_URI;

    if (!clientId || !redirectUri) {
      throw new Error('Upstox credentials not configured in .env');
    }

    return `https://api.upstox.com/v2/login/authorization/dialog?client_id=${clientId}&redirect_uri=${encodeURIComponent(redirectUri)}&response_type=code`;
  }

  /**
   * Handle OAuth callback (exchange code for tokens)
   */
  async handleOAuthCallback(code: string, redirectUriOverride?: string): Promise<void> {
    await this.tokenManager.exchangeAuthorizationCode(code, redirectUriOverride);
  }

  /**
   * Check if user is authenticated
   */
  async isAuthenticated(): Promise<boolean> {
    const token = await this.tokenManager.getValidAccessToken();
    return token !== null;
  }

  /**
   * Cleanup on app shutdown
   */
  shutdown(): void {
    this.scheduler.stop();
    this.tokenManager.close();
    console.log('[UpstoxService] Shutdown complete');
  }
}
