/**
 * UpstoxApiClient — Reusable API wrapper with auto-token-attachment
 * 
 * Responsibilities:
 *   • Provide clean methods for Upstox API calls
 *   • Auto-attach valid access token to all requests
 *   • Handle token expiry and retry logic
 *   • Extensible for future features (orders, portfolio, etc.)
 */

import axios, { AxiosInstance, AxiosRequestConfig } from 'axios';
import { UpstoxTokenManager } from './UpstoxTokenManager';

export class UpstoxApiClient {
  private tokenManager: UpstoxTokenManager;
  private axiosInstance: AxiosInstance;

  constructor(tokenManager: UpstoxTokenManager) {
    this.tokenManager = tokenManager;
    this.axiosInstance = axios.create({
      baseURL: 'https://api.upstox.com/v2',
      timeout: 8000,
      headers: {
        'Accept': 'application/json',
        'Accept-Encoding': 'gzip, deflate',
      },
    });
  }

  /**
   * Make authenticated API request with auto-token-attachment
   */
  private async makeRequest<T>(config: AxiosRequestConfig): Promise<T> {
    const token = await this.tokenManager.getValidAccessToken();

    if (!token) {
      throw new Error('No valid Upstox access token available. Please authenticate.');
    }

    try {
      const response = await this.axiosInstance.request<T>({
        ...config,
        headers: {
          ...config.headers,
          'Authorization': `Bearer ${token}`,
        },
      });

      return response.data;
    } catch (error: any) {
      // Check if error is due to invalid/expired token
      const errorCode = error.response?.data?.errors?.[0]?.errorCode;
      if (errorCode === 'UDAPI100011' || error.response?.status === 401) {
        console.error('[UpstoxApiClient] Token invalid/expired, please re-authenticate');
        throw new Error('Upstox token expired. Please re-authenticate.');
      }

      throw error;
    }
  }

  /**
   * Fetch historical candle data
   * 
   * @param instrumentKey - e.g., "NSE_EQ|INE002A01018"
   * @param interval - "1minute", "5minute", "30minute", "day", etc.
   * @param fromDate - "YYYY-MM-DD"
   * @param toDate - "YYYY-MM-DD"
   */
  async fetchHistoricalData(
    instrumentKey: string,
    interval: string,
    fromDate: string,
    toDate: string
  ): Promise<any> {
    const encodedKey = encodeURIComponent(instrumentKey);
    const url = `/historical-candle/${encodedKey}/${interval}/${toDate}/${fromDate}`;

    return this.makeRequest({
      method: 'GET',
      url,
    });
  }

  /**
   * Fetch user holdings (portfolio)
   */
  async fetchHoldings(): Promise<any> {
    return this.makeRequest({
      method: 'GET',
      url: '/portfolio/long-term-holdings',
    });
  }

  /**
   * Fetch user positions (open trades)
   */
  async fetchPositions(): Promise<any> {
    return this.makeRequest({
      method: 'GET',
      url: '/portfolio/short-term-positions',
    });
  }

  /**
   * Fetch user profile
   */
  async fetchProfile(): Promise<any> {
    return this.makeRequest({
      method: 'GET',
      url: '/user/profile',
    });
  }

  /**
   * Fetch market quotes for instruments
   * 
   * @param instrumentKeys - Array of instrument keys
   */
  async fetchMarketQuotes(instrumentKeys: string[]): Promise<any> {
    return this.makeRequest({
      method: 'GET',
      url: '/market-quote/quotes',
      params: {
        instrument_key: instrumentKeys.join(','),
      },
    });
  }

  /**
   * Place an order (extensibility for future trading features)
   * 
   * @param orderParams - Order parameters (quantity, price, instrument, etc.)
   */
  async placeOrder(orderParams: any): Promise<any> {
    return this.makeRequest({
      method: 'POST',
      url: '/order/place',
      data: orderParams,
    });
  }

  /**
   * Get order book (all orders)
   */
  async fetchOrderBook(): Promise<any> {
    return this.makeRequest({
      method: 'GET',
      url: '/order/retrieve-all',
    });
  }

  /**
   * Get funds and margin
   */
  async fetchFunds(): Promise<any> {
    return this.makeRequest({
      method: 'GET',
      url: '/user/get-funds-and-margin',
    });
  }
}
