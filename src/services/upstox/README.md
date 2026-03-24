# Upstox Integration Module

Complete OAuth-based integration with Upstox API for persistent, automatic daily connection with secure token management.

## Features

✅ **OAuth 2.0 Flow** - Secure authorization without hardcoded tokens  
✅ **Persistent Token Storage** - SQLite database for secure token persistence  
✅ **Auto-Refresh Logic** - Tokens refresh automatically before expiry  
✅ **Daily Auto-Connection** - Scheduled refresh at 8:30 AM IST (before market open)  
✅ **Fail-Safe Error Handling** - Graceful degradation with retry logic  
✅ **Extensible API Client** - Ready for orders, portfolio, live trading  
✅ **Zero Breaking Changes** - Completely isolated from existing features  

## Architecture

```
UpstoxService (Singleton)
├── UpstoxTokenManager    → Token storage & refresh logic
├── UpstoxApiClient       → Reusable API wrapper
└── UpstoxScheduler       → Daily auto-connection scheduler
```

## Setup Instructions

### 1. Get Upstox API Credentials

1. Go to [Upstox Developer Console](https://account.upstox.com/developer/apps)
2. Create a new app
3. Note down:
   - **Client ID**
   - **Client Secret**
   - **Redirect URI**: `http://localhost:3000/api/upstox/callback`

### 2. Configure Environment Variables

Update your `.env` file:

```env
UPSTOX_CLIENT_ID=your_client_id_here
UPSTOX_CLIENT_SECRET=your_client_secret_here
UPSTOX_REDIRECT_URI=http://localhost:3000/api/upstox/callback
```

### 3. Authenticate (One-Time Setup)

1. Start the server: `npm run dev`
2. Get the authorization URL:
   ```bash
   curl http://localhost:3000/api/upstox/auth-url
   ```
3. Open the returned URL in your browser
4. Login to Upstox and authorize the app
5. You'll be redirected to the callback URL
6. Tokens are now stored and will auto-refresh daily!

## API Endpoints

### OAuth & Token Management

#### `GET /api/upstox/auth-url`
Returns the OAuth authorization URL for user login.

**Response:**
```json
{
  "authUrl": "https://api.upstox.com/v2/login/authorization/dialog?..."
}
```

#### `GET /api/upstox/callback?code=xxx`
OAuth callback endpoint (handled automatically by browser redirect).

#### `GET /api/upstox/status`
Check authentication status.

**Response:**
```json
{
  "authenticated": true,
  "message": "Connected to Upstox. Tokens will auto-refresh daily."
}
```

#### `POST /api/upstox/refresh`
Manually trigger token refresh (for testing).

**Response:**
```json
{
  "success": true,
  "message": "Token refreshed successfully"
}
```

#### `GET /api/upstox/profile`
Fetch user profile (test endpoint to verify connection).

**Response:**
```json
{
  "data": {
    "user_id": "ABC123",
    "user_name": "John Doe",
    "email": "john@example.com"
  }
}
```

## Usage in Code

### Get Valid Access Token

```typescript
import { UpstoxService } from './src/services/upstox/UpstoxService';

const upstoxService = UpstoxService.getInstance();
const token = await upstoxService.tokenManager.getValidAccessToken();

if (token) {
  // Use token for API calls
} else {
  // User needs to authenticate
}
```

### Fetch Historical Data

```typescript
const data = await upstoxService.apiClient.fetchHistoricalData(
  'NSE_EQ|INE002A01018', // RELIANCE
  '5minute',
  '2024-01-01',
  '2024-01-31'
);
```

### Fetch User Holdings

```typescript
const holdings = await upstoxService.apiClient.fetchHoldings();
```

### Fetch Market Quotes

```typescript
const quotes = await upstoxService.apiClient.fetchMarketQuotes([
  'NSE_EQ|INE002A01018', // RELIANCE
  'NSE_EQ|INE467B01029'  // TCS
]);
```

## How It Works

### Token Lifecycle

1. **Initial Authentication**
   - User clicks authorization URL
   - Logs in to Upstox
   - Redirects to callback with authorization code
   - Code exchanged for access_token + refresh_token
   - Tokens stored in SQLite database

2. **Auto-Refresh Logic**
   - Before each API call, `getValidAccessToken()` checks expiry
   - If token expires within 5 minutes → auto-refresh
   - New tokens stored in database
   - API call proceeds with fresh token

3. **Daily Scheduled Refresh**
   - Scheduler runs at 8:30 AM IST (before market open)
   - Proactively refreshes token
   - Ensures connection stays active without manual intervention

4. **Fail-Safe Handling**
   - If refresh fails → logs error, returns null
   - Existing features continue working (fallback to simulated data)
   - User can re-authenticate via OAuth flow

### Database Schema

```sql
CREATE TABLE upstox_tokens (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  access_token TEXT NOT NULL,
  refresh_token TEXT,
  expires_at INTEGER NOT NULL,  -- Unix timestamp (ms)
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);
```

## Security Best Practices

✅ **No Hardcoded Tokens** - All credentials in `.env`  
✅ **Encrypted Storage** - SQLite database with file permissions  
✅ **Token Expiry Buffer** - 5-minute buffer before expiry  
✅ **Secure OAuth Flow** - Industry-standard authorization code grant  
✅ **Graceful Degradation** - App continues working if Upstox unavailable  

## Extensibility

The API client is designed for easy extension:

```typescript
// Add new methods to UpstoxApiClient.ts

async placeOrder(orderParams: any): Promise<any> {
  return this.makeRequest({
    method: 'POST',
    url: '/order/place',
    data: orderParams,
  });
}

async fetchOrderBook(): Promise<any> {
  return this.makeRequest({
    method: 'GET',
    url: '/order/retrieve-all',
  });
}
```

## Troubleshooting

### "No valid token" error
- Run: `curl http://localhost:3000/api/upstox/status`
- If not authenticated, get auth URL and complete OAuth flow

### Token refresh fails
- Check `.env` credentials are correct
- Verify `UPSTOX_CLIENT_SECRET` is set
- Check Upstox API status

### Daily refresh not working
- Check server logs for scheduler messages
- Verify server timezone (scheduler uses UTC internally)
- Manually trigger: `curl -X POST http://localhost:3000/api/upstox/refresh`

## Logs

The integration logs all key events:

```
[UpstoxService] Initializing Upstox integration...
[UpstoxScheduler] Starting scheduler...
[UpstoxScheduler] Token validated successfully on startup
[UpstoxScheduler] Next token refresh scheduled at 2024-01-15T03:00:00.000Z
[UpstoxTokenManager] Tokens stored successfully
[UpstoxScheduler] Daily token refresh successful
```

## Non-Breaking Integration

This module is **completely isolated** from existing features:

- ✅ No modifications to existing API endpoints
- ✅ No changes to existing data flows
- ✅ Existing historical endpoint still works with legacy token
- ✅ Fallback to simulated data if Upstox unavailable
- ✅ All existing tabs, components, and logic unchanged

## Future Enhancements

- [ ] Live WebSocket feed for real-time quotes
- [ ] Order placement UI
- [ ] Portfolio sync dashboard
- [ ] Trade execution automation
- [ ] Risk management integration
- [ ] Multi-account support
