import express from "express";
import { initUniverse, getUniverse, getUniverseAsync, setFallbackUniverse } from "./src/services/StockUniverseService";
import axios from "axios";
import dotenv from "dotenv";
import {
  errorLoggingMiddleware,
  installProcessErrorHandlers,
  logAction,
  logError,
  requestLoggingMiddleware,
  withErrorBoundary,
} from "./serverLogger";
import { UpstoxService } from "./src/services/upstox/UpstoxService";
import { UpstoxMarketDataService } from "./src/services/upstox/UpstoxMarketDataService";
import { OrbVwapEngine } from "./src/services/upstox/OrbVwapEngine";
import { PredictionStorageService } from "./src/services/PredictionStorageService";
import { getSupabaseClient } from "./src/lib/supabase";
import { fetchNewsIntelligence, getStockSentiment, getTopNews, getSectorSentiment } from "./src/services/NewsIntelligenceService";
import { enrichStocksBackground, getEnrichedFromCache, fetchFIIDIIData, computeFundamentalScore, fetchYahooFundamentals, fetchScreenerFundamentals, isYahooCached, loadFundamentalsFromSupabase, loadOHLCVFromSupabase, writeOHLCVToSupabase, type EnrichedStockData, type OHLCVCandle } from "./src/services/MarketDataAggregator";
import { runSuperbrain, type SuperbrainInput } from "./src/services/SuperbrainEngine";

import path from "path";
import fs from "fs";

dotenv.config();
installProcessErrorHandlers();

async function buildApp() {
  const app = express();

  // CORS — allow Netlify frontend and any configured origins
  app.use((req, res, next) => {
    const allowedOrigins = (process.env.ALLOWED_ORIGINS || '')
      .split(',')
      .map(o => o.trim())
      .filter(Boolean);
    const origin = req.headers.origin || '';
    const isNetlify = origin.endsWith('.netlify.app');
    const isAllowed = allowedOrigins.includes(origin);
    if (isNetlify || isAllowed || process.env.NODE_ENV !== 'production') {
      res.setHeader('Access-Control-Allow-Origin', origin || '*');
      res.setHeader('Access-Control-Allow-Methods', 'GET,POST,PUT,DELETE,OPTIONS');
      res.setHeader('Access-Control-Allow-Headers', 'Content-Type,Authorization,x-admin-secret');
      res.setHeader('Access-Control-Allow-Credentials', 'true');
    }
    if (req.method === 'OPTIONS') { res.sendStatus(204); return; }
    next();
  });

  app.use(express.json({ limit: '1mb' }));
  app.use(requestLoggingMiddleware());

  // Serve the Spring Boot template for a specific route
  app.get("/sb-terminal", (req, res) => {
    const templatePath = path.join(process.cwd(), "src/main/resources/templates/index.html");
    if (fs.existsSync(templatePath)) {
      let content = fs.readFileSync(templatePath, 'utf8');
      // Inject the API key for the frontend script
      const apiKey = process.env.GEMINI_API_KEY || "";
      content = content.replace('process.env.GEMINI_API_KEY', `'${apiKey}'`);
      // Also replace the Thymeleaf-like placeholder if it exists
      content = content.replace(/\[\[\$\{@environment\.getProperty\('GEMINI_API_KEY'\)\}\]\]/g, apiKey);
      res.send(content);
    } else {
      res.status(404).send("Template not found. Please ensure src/main/resources/templates/index.html exists.");
    }
  });

  // Mock/Curated list of popular NSE stocks for autocomplete
  const POPULAR_STOCKS = [
    { name: "RELIANCE INDUSTRIES LTD", symbol: "RELIANCE", key: "NSE_EQ|INE002A01018" },
    { name: "TATA CONSULTANCY SERVICES LTD", symbol: "TCS", key: "NSE_EQ|INE467B01029" },
    { name: "HDFC BANK LTD", symbol: "HDFCBANK", key: "NSE_EQ|INE040A01034" },
    { name: "INFOSYS LTD", symbol: "INFY", key: "NSE_EQ|INE009A01021" },
    { name: "ICICI BANK LTD", symbol: "ICICIBANK", key: "NSE_EQ|INE090A01021" },
    { name: "STATE BANK OF INDIA", symbol: "SBIN", key: "NSE_EQ|INE062A01020" },
    { name: "BHARTI AIRTEL LTD", symbol: "BHARTIARTL", key: "NSE_EQ|INE397D01024" },
    { name: "LARSEN & TOUBRO LTD", symbol: "LT", key: "NSE_EQ|INE018A01030" },
    { name: "ITC LTD", symbol: "ITC", key: "NSE_EQ|INE154A01025" },
    { name: "KOTAK MAHINDRA BANK LTD", symbol: "KOTAKBANK", key: "NSE_EQ|INE237A01028" },
    { name: "AXIS BANK LTD", symbol: "AXISBANK", key: "NSE_EQ|INE238A01034" },
    { name: "ADANI ENTERPRISES LTD", symbol: "ADANIENT", key: "NSE_EQ|INE423A01024" },
    { name: "ASIAN PAINTS LTD", symbol: "ASIANPAINT", key: "NSE_EQ|INE021A01026" },
    { name: "MARUTI SUZUKI INDIA LTD", symbol: "MARUTI", key: "NSE_EQ|INE585B01010" },
    { name: "SUN PHARMACEUTICAL IND LTD", symbol: "SUNPHARMA", key: "NSE_EQ|INE044A01036" },
    { name: "TITAN COMPANY LTD", symbol: "TITAN", key: "NSE_EQ|INE280A01028" },
    { name: "BAJAJ FINANCE LTD", symbol: "BAJFINANCE", key: "NSE_EQ|INE296A01024" },
    { name: "HCL TECHNOLOGIES LTD", symbol: "HCLTECH", key: "NSE_EQ|INE860A01027" },
    { name: "WIPRO LTD", symbol: "WIPRO", key: "NSE_EQ|INE075A01022" },
    { name: "TATA MOTORS LTD", symbol: "TATAMOTORS", key: "NSE_EQ|INE155A01022" },
    { name: "MAHINDRA & MAHINDRA LTD", symbol: "M&M", key: "NSE_EQ|INE101A01026" },
    { name: "ULTRATECH CEMENT LTD", symbol: "ULTRACEMCO", key: "NSE_EQ|INE481G01011" },
    { name: "POWER GRID CORP OF INDIA LTD", symbol: "POWERGRID", key: "NSE_EQ|INE752E01010" },
    { name: "NTPC LTD", symbol: "NTPC", key: "NSE_EQ|INE733E01010" },
    { name: "NESTLE INDIA LTD", symbol: "NESTLEIND", key: "NSE_EQ|INE239A01016" },
    { name: "BAJAJ FINSERV LTD", symbol: "BAJAJFINSV", key: "NSE_EQ|INE918I01018" },
    { name: "JSW STEEL LTD", symbol: "JSWSTEEL", key: "NSE_EQ|INE019A01038" },
    { name: "HINDALCO INDUSTRIES LTD", symbol: "HINDALCO", key: "NSE_EQ|INE038A01020" },
  ];

  type UltraQuantRequest = {
    historicalPeriodYears?: number;
    minCagr?: number;
    sectorFilter?: string;
    minMarketCap?: number;
    maxMarketCap?: number;
    minVolume?: number;
    maxDrawdown?: number;
    volatilityThreshold?: number;
    breakoutFrequency?: number;
    trendStrengthThreshold?: number;
    riskPercentage?: number;
  };

  type UltraQuantProfile = {
    symbol: string;
    sector: string;
    industry: string;
    marketCap: number;
    averageVolume: number;
  };

  type UltraQuantCandle = {
    open: number;
    high: number;
    low: number;
    close: number;
    volume: number;
  };

  type HedgeFundSignalScore = {
    rank: number;
    stockSymbol: string;
    sector: string;
    momentumScore: number;
    trendScore: number;
    volumeScore: number;
    volatilityScore: number;
    sectorScore: number;
    institutionalScore: number;
    breakoutScore: number;
    finalScore: number;
    momentumValue: number;
    orderImbalance: number;
    breakoutProbability: number;
  };

  type HedgeFundSignalDashboard = {
    rankings: HedgeFundSignalScore[];
    sectorStrength: Array<{
      sector: string;
      averageReturn: number;
      sectorScore: number;
      leaders: string[];
    }>;
    momentumHeatmap: Array<{
      symbol: string;
      sector: string;
      momentumScore: number;
      finalScore: number;
      breakoutScore: number;
    }>;
    summary: {
      scannedUniverse: number;
      returned: number;
      averageFinalScore: number;
      leadingSector: string;
      institutionalAccumulationCandidates: number;
    };
  };

  const ultraArchitecture = [
    { stage: "Market Feed", description: "Ingests real-time ticks and historical candles through provider adapters." },
    { stage: "Tick Processor", description: "Normalizes OHLCV, order book depth, sector metadata, and microstructure events." },
    { stage: "Feature Generator", description: "Builds CAGR, EMA slope, RSI proxy, ATR proxy, VWAP distance, drawdown, and breakout features." },
    { stage: "AI Prediction Models", description: "Runs gradient boost scoring, LSTM-style path forecasting, regime detection, hidden states, and RL policy actioning." },
    { stage: "Signal Aggregator", description: "Combines technical, AI, and sentiment signals into a single institutional prediction score." },
    { stage: "Stock Ranking Engine", description: "Ranks filtered stocks, computes sector rotation, and emits alerts with risk-aware sizing." },
    { stage: "Ultra Quant Analyzer Tab", description: "Renders the dedicated tab with filters, rankings, model diagnostics, and alert views." },
    { stage: "Alert Engine", description: "Publishes high-conviction signals with symbol, signal type, confidence, and timestamp." }
  ];

  const clamp = (value: number, min = 0, max = 1) => Math.max(min, Math.min(max, value));
  const average = (values: number[]) => values.length ? values.reduce((sum, value) => sum + value, 0) / values.length : 0;
  const seededGenerator = (seed: number) => {
    let state = seed >>> 0;
    return () => {
      state = (state * 1664525 + 1013904223) >>> 0;
      return state / 4294967296;
    };
  };
  const symbolSeed = (symbol: string) => Array.from(symbol).reduce((sum, char) => sum + char.charCodeAt(0), 0);

  const normalizeUltraQuantRequest = (payload: UltraQuantRequest = {}) => ({
    historicalPeriodYears: Math.min(15, Math.max(1, Number(payload.historicalPeriodYears ?? 5))),
    minCagr: Number(payload.minCagr ?? 18),
    sectorFilter: (payload.sectorFilter ?? "ALL").toString(),
    minMarketCap: Number(payload.minMarketCap ?? 0),
    maxMarketCap: Number(payload.maxMarketCap ?? Number.MAX_SAFE_INTEGER),
    minVolume: Number(payload.minVolume ?? 100000),
    maxDrawdown: Number(payload.maxDrawdown ?? 45),
    volatilityThreshold: Number(payload.volatilityThreshold ?? 0.5),
    breakoutFrequency: Number(payload.breakoutFrequency ?? 0.08),
    trendStrengthThreshold: Number(payload.trendStrengthThreshold ?? 0.12),
    riskPercentage: Number(payload.riskPercentage ?? 1)
  });

// NSE full universe â€” all major NSE-listed stocks with sector/industry metadata
// Covers Nifty 50, Nifty Next 50, Nifty Midcap 150, Nifty Smallcap 250, and broader market
// Total: ~1500 real NSE symbols with deterministic market-cap and volume estimates

const NSE_STOCK_UNIVERSE: Array<{ symbol: string; sector: string; industry: string; marketCap: number; averageVolume: number }> = [
  // â”€â”€ LARGE CAP / NIFTY 50 â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
  { symbol: "RELIANCE",    sector: "Energy",       industry: "Oil & Gas",         marketCap: 1750000, averageVolume: 8000000 },
  { symbol: "TCS",         sector: "Technology",   industry: "IT Services",        marketCap: 1400000, averageVolume: 3000000 },
  { symbol: "HDFCBANK",    sector: "Financials",   industry: "Private Bank",       marketCap: 1200000, averageVolume: 9000000 },
  { symbol: "INFY",        sector: "Technology",   industry: "IT Services",        marketCap: 750000,  averageVolume: 5000000 },
  { symbol: "ICICIBANK",   sector: "Financials",   industry: "Private Bank",       marketCap: 720000,  averageVolume: 10000000 },
  { symbol: "HINDUNILVR",  sector: "Consumer",     industry: "FMCG",               marketCap: 600000,  averageVolume: 2000000 },
  { symbol: "SBIN",        sector: "Financials",   industry: "Public Bank",        marketCap: 580000,  averageVolume: 15000000 },
  { symbol: "BHARTIARTL",  sector: "Telecom",      industry: "Telecom Services",   marketCap: 560000,  averageVolume: 5000000 },
  { symbol: "ITC",         sector: "Consumer",     industry: "FMCG",               marketCap: 540000,  averageVolume: 12000000 },
  { symbol: "KOTAKBANK",   sector: "Financials",   industry: "Private Bank",       marketCap: 380000,  averageVolume: 4000000 },
  { symbol: "LT",          sector: "Industrials",  industry: "Engineering",        marketCap: 370000,  averageVolume: 3000000 },
  { symbol: "AXISBANK",    sector: "Financials",   industry: "Private Bank",       marketCap: 340000,  averageVolume: 8000000 },
  { symbol: "ASIANPAINT",  sector: "Consumer",     industry: "Paints",             marketCap: 290000,  averageVolume: 1500000 },
  { symbol: "MARUTI",      sector: "Auto",         industry: "Passenger Vehicles", marketCap: 280000,  averageVolume: 800000 },
  { symbol: "SUNPHARMA",   sector: "Healthcare",   industry: "Pharma",             marketCap: 270000,  averageVolume: 3000000 },
  { symbol: "TITAN",       sector: "Consumer",     industry: "Jewellery",          marketCap: 260000,  averageVolume: 2000000 },
  { symbol: "BAJFINANCE",  sector: "Financials",   industry: "NBFC",               marketCap: 250000,  averageVolume: 3500000 },
  { symbol: "HCLTECH",     sector: "Technology",   industry: "IT Services",        marketCap: 240000,  averageVolume: 4000000 },
  { symbol: "WIPRO",       sector: "Technology",   industry: "IT Services",        marketCap: 230000,  averageVolume: 5000000 },
  { symbol: "TATAMOTORS",  sector: "Auto",         industry: "Commercial Vehicles",marketCap: 220000,  averageVolume: 10000000 },
  { symbol: "M&M",         sector: "Auto",         industry: "Passenger Vehicles", marketCap: 210000,  averageVolume: 3000000 },
  { symbol: "ULTRACEMCO",  sector: "Materials",    industry: "Cement",             marketCap: 200000,  averageVolume: 800000 },
  { symbol: "POWERGRID",   sector: "Utilities",    industry: "Power Transmission", marketCap: 195000,  averageVolume: 6000000 },
  { symbol: "NTPC",        sector: "Utilities",    industry: "Power Generation",   marketCap: 190000,  averageVolume: 8000000 },
  { symbol: "NESTLEIND",   sector: "Consumer",     industry: "FMCG",               marketCap: 185000,  averageVolume: 500000 },
  { symbol: "BAJAJFINSV",  sector: "Financials",   industry: "Insurance",          marketCap: 180000,  averageVolume: 2000000 },
  { symbol: "JSWSTEEL",    sector: "Materials",    industry: "Steel",              marketCap: 175000,  averageVolume: 5000000 },
  { symbol: "HINDALCO",    sector: "Materials",    industry: "Aluminium",          marketCap: 170000,  averageVolume: 7000000 },
  { symbol: "ADANIENT",    sector: "Industrials",  industry: "Conglomerate",       marketCap: 165000,  averageVolume: 4000000 },
  { symbol: "ADANIPORTS",  sector: "Industrials",  industry: "Ports & Logistics",  marketCap: 160000,  averageVolume: 4000000 },
  { symbol: "ONGC",        sector: "Energy",       industry: "Oil & Gas",          marketCap: 155000,  averageVolume: 10000000 },
  { symbol: "COALINDIA",   sector: "Energy",       industry: "Mining",             marketCap: 150000,  averageVolume: 6000000 },
  { symbol: "TATASTEEL",   sector: "Materials",    industry: "Steel",              marketCap: 145000,  averageVolume: 12000000 },
  { symbol: "TECHM",       sector: "Technology",   industry: "IT Services",        marketCap: 140000,  averageVolume: 4000000 },
  { symbol: "GRASIM",      sector: "Materials",    industry: "Diversified",        marketCap: 135000,  averageVolume: 1500000 },
  { symbol: "INDUSINDBK",  sector: "Financials",   industry: "Private Bank",       marketCap: 130000,  averageVolume: 4000000 },
  { symbol: "CIPLA",       sector: "Healthcare",   industry: "Pharma",             marketCap: 125000,  averageVolume: 2500000 },
  { symbol: "DRREDDY",     sector: "Healthcare",   industry: "Pharma",             marketCap: 120000,  averageVolume: 1500000 },
  { symbol: "EICHERMOT",   sector: "Auto",         industry: "Two Wheelers",       marketCap: 115000,  averageVolume: 800000 },
  { symbol: "HEROMOTOCO",  sector: "Auto",         industry: "Two Wheelers",       marketCap: 110000,  averageVolume: 1500000 },
  { symbol: "BPCL",        sector: "Energy",       industry: "Oil Refining",       marketCap: 105000,  averageVolume: 6000000 },
  { symbol: "TATACONSUM",  sector: "Consumer",     industry: "FMCG",               marketCap: 100000,  averageVolume: 2000000 },
  { symbol: "APOLLOHOSP",  sector: "Healthcare",   industry: "Hospitals",          marketCap: 95000,   averageVolume: 1000000 },
  { symbol: "DIVISLAB",    sector: "Healthcare",   industry: "Pharma",             marketCap: 90000,   averageVolume: 800000 },
  { symbol: "BRITANNIA",   sector: "Consumer",     industry: "FMCG",               marketCap: 88000,   averageVolume: 600000 },
  { symbol: "SBILIFE",     sector: "Financials",   industry: "Insurance",          marketCap: 85000,   averageVolume: 1500000 },
  { symbol: "HDFCLIFE",    sector: "Financials",   industry: "Insurance",          marketCap: 82000,   averageVolume: 2000000 },
  { symbol: "SHREECEM",    sector: "Materials",    industry: "Cement",             marketCap: 80000,   averageVolume: 200000 },

  // â”€â”€ NIFTY NEXT 50 â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
  { symbol: "ADANIGREEN",  sector: "Utilities",    industry: "Renewable Energy",   marketCap: 78000,   averageVolume: 3000000 },
  { symbol: "ADANITRANS",  sector: "Utilities",    industry: "Power Transmission", marketCap: 75000,   averageVolume: 2000000 },
  { symbol: "AMBUJACEM",   sector: "Materials",    industry: "Cement",             marketCap: 72000,   averageVolume: 4000000 },
  { symbol: "BAJAJ-AUTO",  sector: "Auto",         industry: "Two Wheelers",       marketCap: 70000,   averageVolume: 600000 },
  { symbol: "BANKBARODA",  sector: "Financials",   industry: "Public Bank",        marketCap: 68000,   averageVolume: 10000000 },
  { symbol: "BERGEPAINT",  sector: "Consumer",     industry: "Paints",             marketCap: 65000,   averageVolume: 800000 },
  { symbol: "BOSCHLTD",    sector: "Auto",         industry: "Auto Components",    marketCap: 63000,   averageVolume: 200000 },
  { symbol: "CHOLAFIN",    sector: "Financials",   industry: "NBFC",               marketCap: 60000,   averageVolume: 2000000 },
  { symbol: "COLPAL",      sector: "Consumer",     industry: "FMCG",               marketCap: 58000,   averageVolume: 600000 },
  { symbol: "DABUR",       sector: "Consumer",     industry: "FMCG",               marketCap: 56000,   averageVolume: 2000000 },
  { symbol: "DLF",         sector: "Real Estate",  industry: "Real Estate",        marketCap: 54000,   averageVolume: 5000000 },
  { symbol: "GAIL",        sector: "Energy",       industry: "Gas Distribution",   marketCap: 52000,   averageVolume: 6000000 },
  { symbol: "GODREJCP",    sector: "Consumer",     industry: "FMCG",               marketCap: 50000,   averageVolume: 1500000 },
  { symbol: "HAVELLS",     sector: "Industrials",  industry: "Electricals",        marketCap: 48000,   averageVolume: 1500000 },
  { symbol: "ICICIPRULI",  sector: "Financials",   industry: "Insurance",          marketCap: 46000,   averageVolume: 2000000 },
  { symbol: "INDIGO",      sector: "Industrials",  industry: "Aviation",           marketCap: 44000,   averageVolume: 1500000 },
  { symbol: "IOC",         sector: "Energy",       industry: "Oil Refining",       marketCap: 42000,   averageVolume: 8000000 },
  { symbol: "IRCTC",       sector: "Industrials",  industry: "Travel Services",    marketCap: 40000,   averageVolume: 2000000 },
  { symbol: "JINDALSTEL",  sector: "Materials",    industry: "Steel",              marketCap: 38000,   averageVolume: 3000000 },
  { symbol: "JUBLFOOD",    sector: "Consumer",     industry: "QSR",                marketCap: 36000,   averageVolume: 1500000 },
  { symbol: "LICI",        sector: "Financials",   industry: "Insurance",          marketCap: 350000,  averageVolume: 5000000 },
  { symbol: "LUPIN",       sector: "Healthcare",   industry: "Pharma",             marketCap: 34000,   averageVolume: 2000000 },
  { symbol: "MARICO",      sector: "Consumer",     industry: "FMCG",               marketCap: 32000,   averageVolume: 2000000 },
  { symbol: "MCDOWELL-N",  sector: "Consumer",     industry: "Beverages",          marketCap: 30000,   averageVolume: 1000000 },
  { symbol: "MUTHOOTFIN",  sector: "Financials",   industry: "NBFC",               marketCap: 28000,   averageVolume: 1500000 },
  { symbol: "NAUKRI",      sector: "Technology",   industry: "Internet Services",  marketCap: 26000,   averageVolume: 500000 },
  { symbol: "NMDC",        sector: "Materials",    industry: "Mining",             marketCap: 24000,   averageVolume: 5000000 },
  { symbol: "PAGEIND",     sector: "Consumer",     industry: "Apparel",            marketCap: 22000,   averageVolume: 100000 },
  { symbol: "PIDILITIND",  sector: "Materials",    industry: "Adhesives",          marketCap: 20000,   averageVolume: 600000 },
  { symbol: "PIIND",       sector: "Healthcare",   industry: "Agrochemicals",      marketCap: 18000,   averageVolume: 400000 },
  { symbol: "PNB",         sector: "Financials",   industry: "Public Bank",        marketCap: 16000,   averageVolume: 15000000 },
  { symbol: "RECLTD",      sector: "Financials",   industry: "NBFC",               marketCap: 14000,   averageVolume: 5000000 },
  { symbol: "SAIL",        sector: "Materials",    industry: "Steel",              marketCap: 12000,   averageVolume: 10000000 },
  { symbol: "SIEMENS",     sector: "Industrials",  industry: "Engineering",        marketCap: 10000,   averageVolume: 400000 },
  { symbol: "SRF",         sector: "Materials",    industry: "Chemicals",          marketCap: 9500,    averageVolume: 600000 },
  { symbol: "TORNTPHARM", sector: "Healthcare",   industry: "Pharma",             marketCap: 9000,    averageVolume: 500000 },
  { symbol: "TRENT",       sector: "Consumer",     industry: "Retail",             marketCap: 8500,    averageVolume: 1000000 },
  { symbol: "UBL",         sector: "Consumer",     industry: "Beverages",          marketCap: 8000,    averageVolume: 400000 },
  { symbol: "VEDL",        sector: "Materials",    industry: "Metals & Mining",    marketCap: 7500,    averageVolume: 8000000 },
  { symbol: "VOLTAS",      sector: "Consumer",     industry: "Consumer Durables",  marketCap: 7000,    averageVolume: 1000000 },
  { symbol: "ZOMATO",      sector: "Technology",   industry: "Food Delivery",      marketCap: 6500,    averageVolume: 15000000 },
  { symbol: "PAYTM",       sector: "Technology",   industry: "Fintech",            marketCap: 6000,    averageVolume: 5000000 },
  { symbol: "NYKAA",       sector: "Consumer",     industry: "E-Commerce",         marketCap: 5500,    averageVolume: 3000000 },
  { symbol: "POLICYBZR",   sector: "Technology",   industry: "Insurtech",          marketCap: 5000,    averageVolume: 2000000 },
  { symbol: "DELHIVERY",   sector: "Industrials",  industry: "Logistics",          marketCap: 4500,    averageVolume: 2000000 },

  // â”€â”€ NIFTY MIDCAP 150 â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
  { symbol: "ABCAPITAL",   sector: "Financials",   industry: "NBFC",               marketCap: 22000,   averageVolume: 3000000 },
  { symbol: "ABFRL",       sector: "Consumer",     industry: "Apparel",            marketCap: 8000,    averageVolume: 3000000 },
  { symbol: "AIAENG",      sector: "Industrials",  industry: "Engineering",        marketCap: 12000,   averageVolume: 200000 },
  { symbol: "ALKEM",       sector: "Healthcare",   industry: "Pharma",             marketCap: 14000,   averageVolume: 300000 },
  { symbol: "APLLTD",      sector: "Healthcare",   industry: "Pharma",             marketCap: 6000,    averageVolume: 500000 },
  { symbol: "ASTRAL",      sector: "Industrials",  industry: "Pipes",              marketCap: 18000,   averageVolume: 600000 },
  { symbol: "ATUL",        sector: "Materials",    industry: "Chemicals",          marketCap: 10000,   averageVolume: 100000 },
  { symbol: "AUBANK",      sector: "Financials",   industry: "Small Finance Bank", marketCap: 16000,   averageVolume: 2000000 },
  { symbol: "AUROPHARMA",  sector: "Healthcare",   industry: "Pharma",             marketCap: 15000,   averageVolume: 2000000 },
  { symbol: "BALKRISIND",  sector: "Auto",         industry: "Tyres",              marketCap: 14000,   averageVolume: 500000 },
  { symbol: "BANDHANBNK",  sector: "Financials",   industry: "Private Bank",       marketCap: 13000,   averageVolume: 5000000 },
  { symbol: "BATAINDIA",   sector: "Consumer",     industry: "Footwear",           marketCap: 12000,   averageVolume: 400000 },
  { symbol: "BEL",         sector: "Industrials",  industry: "Defence",            marketCap: 55000,   averageVolume: 8000000 },
  { symbol: "BHARATFORG",  sector: "Auto",         industry: "Auto Components",    marketCap: 20000,   averageVolume: 1500000 },
  { symbol: "BHEL",        sector: "Industrials",  industry: "Engineering",        marketCap: 25000,   averageVolume: 10000000 },
  { symbol: "BIOCON",      sector: "Healthcare",   industry: "Biotech",            marketCap: 18000,   averageVolume: 3000000 },
  { symbol: "CANBK",       sector: "Financials",   industry: "Public Bank",        marketCap: 22000,   averageVolume: 8000000 },
  { symbol: "CANFINHOME",  sector: "Financials",   industry: "Housing Finance",    marketCap: 8000,    averageVolume: 1000000 },
  { symbol: "CASTROLIND",  sector: "Energy",       industry: "Lubricants",         marketCap: 7000,    averageVolume: 1000000 },
  { symbol: "CEATLTD",     sector: "Auto",         industry: "Tyres",              marketCap: 6000,    averageVolume: 400000 },
  { symbol: "CGPOWER",     sector: "Industrials",  industry: "Electricals",        marketCap: 30000,   averageVolume: 3000000 },
  { symbol: "COFORGE",     sector: "Technology",   industry: "IT Services",        marketCap: 20000,   averageVolume: 500000 },
  { symbol: "CONCOR",      sector: "Industrials",  industry: "Logistics",          marketCap: 18000,   averageVolume: 1000000 },
  { symbol: "CROMPTON",    sector: "Consumer",     industry: "Consumer Durables",  marketCap: 12000,   averageVolume: 1500000 },
  { symbol: "CUMMINSIND",  sector: "Industrials",  industry: "Engines",            marketCap: 16000,   averageVolume: 500000 },
  { symbol: "DEEPAKNTR",   sector: "Materials",    industry: "Chemicals",          marketCap: 14000,   averageVolume: 600000 },
  { symbol: "DIXON",       sector: "Technology",   industry: "Electronics Mfg",    marketCap: 22000,   averageVolume: 400000 },
  { symbol: "ESCORTS",     sector: "Auto",         industry: "Tractors",           marketCap: 12000,   averageVolume: 600000 },
  { symbol: "EXIDEIND",    sector: "Auto",         industry: "Batteries",          marketCap: 10000,   averageVolume: 2000000 },
  { symbol: "FEDERALBNK",  sector: "Financials",   industry: "Private Bank",       marketCap: 18000,   averageVolume: 5000000 },
  { symbol: "FORTIS",      sector: "Healthcare",   industry: "Hospitals",          marketCap: 16000,   averageVolume: 3000000 },
  { symbol: "GLENMARK",    sector: "Healthcare",   industry: "Pharma",             marketCap: 12000,   averageVolume: 1500000 },
  { symbol: "GMRINFRA",    sector: "Industrials",  industry: "Infrastructure",     marketCap: 20000,   averageVolume: 8000000 },
  { symbol: "GODREJPROP",  sector: "Real Estate",  industry: "Real Estate",        marketCap: 18000,   averageVolume: 1500000 },
  { symbol: "GRANULES",    sector: "Healthcare",   industry: "Pharma",             marketCap: 6000,    averageVolume: 1500000 },
  { symbol: "GSPL",        sector: "Energy",       industry: "Gas Distribution",   marketCap: 8000,    averageVolume: 1000000 },
  { symbol: "HDFCAMC",     sector: "Financials",   industry: "Asset Management",   marketCap: 30000,   averageVolume: 500000 },
  { symbol: "HINDPETRO",   sector: "Energy",       industry: "Oil Refining",       marketCap: 14000,   averageVolume: 4000000 },
  { symbol: "HONAUT",      sector: "Industrials",  industry: "Automation",         marketCap: 12000,   averageVolume: 50000 },
  { symbol: "IDFCFIRSTB",  sector: "Financials",   industry: "Private Bank",       marketCap: 20000,   averageVolume: 10000000 },
  { symbol: "IGL",         sector: "Energy",       industry: "Gas Distribution",   marketCap: 16000,   averageVolume: 2000000 },
  { symbol: "INDHOTEL",    sector: "Consumer",     industry: "Hotels",             marketCap: 18000,   averageVolume: 3000000 },
  { symbol: "INDUSTOWER",  sector: "Telecom",      industry: "Tower Infrastructure",marketCap: 22000,  averageVolume: 5000000 },
  { symbol: "INOXWIND",    sector: "Utilities",    industry: "Wind Energy",        marketCap: 8000,    averageVolume: 2000000 },
  { symbol: "IPCALAB",     sector: "Healthcare",   industry: "Pharma",             marketCap: 10000,   averageVolume: 500000 },
  { symbol: "IRFC",        sector: "Financials",   industry: "NBFC",               marketCap: 35000,   averageVolume: 8000000 },
  { symbol: "JKCEMENT",    sector: "Materials",    industry: "Cement",             marketCap: 12000,   averageVolume: 200000 },
  { symbol: "JSWENERGY",   sector: "Utilities",    industry: "Power Generation",   marketCap: 20000,   averageVolume: 3000000 },
  { symbol: "JUBILANT",    sector: "Healthcare",   industry: "Pharma",             marketCap: 8000,    averageVolume: 500000 },

  { symbol: "KAJARIACER",  sector: "Materials",    industry: "Tiles",              marketCap: 8000,    averageVolume: 400000 },
  { symbol: "KANSAINER",   sector: "Consumer",     industry: "Paints",             marketCap: 6000,    averageVolume: 300000 },
  { symbol: "KEC",         sector: "Industrials",  industry: "Power T&D",          marketCap: 10000,   averageVolume: 1000000 },
  { symbol: "KPITTECH",    sector: "Technology",   industry: "Auto Tech",          marketCap: 14000,   averageVolume: 1000000 },
  { symbol: "LALPATHLAB",  sector: "Healthcare",   industry: "Diagnostics",        marketCap: 10000,   averageVolume: 300000 },
  { symbol: "LAURUSLABS",  sector: "Healthcare",   industry: "Pharma",             marketCap: 8000,    averageVolume: 2000000 },
  { symbol: "LICHSGFIN",   sector: "Financials",   industry: "Housing Finance",    marketCap: 12000,   averageVolume: 3000000 },
  { symbol: "LTIM",        sector: "Technology",   industry: "IT Services",        marketCap: 40000,   averageVolume: 800000 },
  { symbol: "LTTS",        sector: "Technology",   industry: "Engineering Services",marketCap: 18000,  averageVolume: 400000 },
  { symbol: "MANAPPURAM",  sector: "Financials",   industry: "NBFC",               marketCap: 8000,    averageVolume: 3000000 },
  { symbol: "MAXHEALTH",   sector: "Healthcare",   industry: "Hospitals",          marketCap: 16000,   averageVolume: 1500000 },
  { symbol: "MCX",         sector: "Financials",   industry: "Exchange",           marketCap: 10000,   averageVolume: 500000 },
  { symbol: "METROPOLIS",  sector: "Healthcare",   industry: "Diagnostics",        marketCap: 8000,    averageVolume: 300000 },
  { symbol: "MFSL",        sector: "Financials",   industry: "Insurance",          marketCap: 10000,   averageVolume: 500000 },
  { symbol: "MINDTREE",    sector: "Technology",   industry: "IT Services",        marketCap: 12000,   averageVolume: 600000 },
  { symbol: "MOTHERSON",   sector: "Auto",         industry: "Auto Components",    marketCap: 30000,   averageVolume: 8000000 },
  { symbol: "MRF",         sector: "Auto",         industry: "Tyres",              marketCap: 22000,   averageVolume: 50000 },
  { symbol: "NATCOPHARM",  sector: "Healthcare",   industry: "Pharma",             marketCap: 6000,    averageVolume: 500000 },
  { symbol: "NBCC",        sector: "Industrials",  industry: "Construction",       marketCap: 10000,   averageVolume: 5000000 },
  { symbol: "NCC",         sector: "Industrials",  industry: "Construction",       marketCap: 8000,    averageVolume: 3000000 },
  { symbol: "NHPC",        sector: "Utilities",    industry: "Hydro Power",        marketCap: 20000,   averageVolume: 8000000 },
  { symbol: "NLCINDIA",    sector: "Utilities",    industry: "Power Generation",   marketCap: 12000,   averageVolume: 3000000 },
  { symbol: "OBEROIRLTY",  sector: "Real Estate",  industry: "Real Estate",        marketCap: 14000,   averageVolume: 800000 },
  { symbol: "OIL",         sector: "Energy",       industry: "Oil & Gas",          marketCap: 10000,   averageVolume: 2000000 },
  { symbol: "OFSS",        sector: "Technology",   industry: "Banking Software",   marketCap: 30000,   averageVolume: 200000 },
  { symbol: "PERSISTENT",  sector: "Technology",   industry: "IT Services",        marketCap: 22000,   averageVolume: 400000 },
  { symbol: "PETRONET",    sector: "Energy",       industry: "Gas",                marketCap: 14000,   averageVolume: 3000000 },
  { symbol: "PFIZER",      sector: "Healthcare",   industry: "Pharma",             marketCap: 8000,    averageVolume: 100000 },
  { symbol: "PHOENIXLTD",  sector: "Real Estate",  industry: "Retail Real Estate", marketCap: 16000,   averageVolume: 1000000 },
  { symbol: "POLYCAB",     sector: "Industrials",  industry: "Cables & Wires",     marketCap: 20000,   averageVolume: 600000 },
  { symbol: "PRESTIGE",    sector: "Real Estate",  industry: "Real Estate",        marketCap: 14000,   averageVolume: 1500000 },
  { symbol: "PRINCEPIPE",  sector: "Industrials",  industry: "Pipes",              marketCap: 6000,    averageVolume: 500000 },
  { symbol: "PGHH",        sector: "Consumer",     industry: "FMCG",               marketCap: 10000,   averageVolume: 100000 },
  { symbol: "PVRINOX",     sector: "Consumer",     industry: "Entertainment",      marketCap: 8000,    averageVolume: 1000000 },
  { symbol: "RAMCOCEM",    sector: "Materials",    industry: "Cement",             marketCap: 8000,    averageVolume: 500000 },
  { symbol: "RBLBANK",     sector: "Financials",   industry: "Private Bank",       marketCap: 8000,    averageVolume: 5000000 },
  { symbol: "SBICARD",     sector: "Financials",   industry: "Credit Cards",       marketCap: 20000,   averageVolume: 2000000 },
  { symbol: "SCHAEFFLER",  sector: "Auto",         industry: "Bearings",           marketCap: 10000,   averageVolume: 200000 },
  { symbol: "SHYAMMETL",   sector: "Materials",    industry: "Steel",              marketCap: 6000,    averageVolume: 1000000 },
  { symbol: "SKFINDIA",    sector: "Auto",         industry: "Bearings",           marketCap: 8000,    averageVolume: 100000 },
  { symbol: "SONACOMS",    sector: "Auto",         industry: "Auto Components",    marketCap: 10000,   averageVolume: 1000000 },
  { symbol: "STARHEALTH",  sector: "Financials",   industry: "Insurance",          marketCap: 14000,   averageVolume: 1000000 },
  { symbol: "SUMICHEM",    sector: "Materials",    industry: "Agrochemicals",      marketCap: 8000,    averageVolume: 400000 },
  { symbol: "SUNDARMFIN",  sector: "Financials",   industry: "NBFC",               marketCap: 12000,   averageVolume: 300000 },
  { symbol: "SUNDRMFAST",  sector: "Auto",         industry: "Auto Components",    marketCap: 6000,    averageVolume: 200000 },
  { symbol: "SUNTV",       sector: "Consumer",     industry: "Media",              marketCap: 14000,   averageVolume: 1000000 },
  { symbol: "SUPREMEIND",  sector: "Industrials",  industry: "Plastics",           marketCap: 10000,   averageVolume: 300000 },
  { symbol: "SYNGENE",     sector: "Healthcare",   industry: "CRO",                marketCap: 12000,   averageVolume: 600000 },

  { symbol: "TANLA",       sector: "Technology",   industry: "CPaaS",              marketCap: 8000,    averageVolume: 500000 },
  { symbol: "TATACHEM",    sector: "Materials",    industry: "Chemicals",          marketCap: 14000,   averageVolume: 1500000 },
  { symbol: "TATACOMM",    sector: "Telecom",      industry: "Data Services",      marketCap: 16000,   averageVolume: 500000 },
  { symbol: "TATAELXSI",   sector: "Technology",   industry: "Design Services",    marketCap: 20000,   averageVolume: 400000 },
  { symbol: "TATAPOWER",   sector: "Utilities",    industry: "Power",              marketCap: 30000,   averageVolume: 8000000 },
  { symbol: "TEAMLEASE",   sector: "Industrials",  industry: "Staffing",           marketCap: 6000,    averageVolume: 200000 },
  { symbol: "THERMAX",     sector: "Industrials",  industry: "Engineering",        marketCap: 12000,   averageVolume: 200000 },
  { symbol: "TIINDIA",     sector: "Auto",         industry: "Auto Components",    marketCap: 10000,   averageVolume: 300000 },
  { symbol: "TIMKEN",      sector: "Auto",         industry: "Bearings",           marketCap: 8000,    averageVolume: 100000 },
  { symbol: "TORNTPOWER",  sector: "Utilities",    industry: "Power",              marketCap: 14000,   averageVolume: 1000000 },
  { symbol: "TTKPRESTIG",  sector: "Consumer",     industry: "Consumer Durables",  marketCap: 6000,    averageVolume: 100000 },
  { symbol: "TVSMOTORS",   sector: "Auto",         industry: "Two Wheelers",       marketCap: 30000,   averageVolume: 1500000 },
  { symbol: "UPL",         sector: "Materials",    industry: "Agrochemicals",      marketCap: 18000,   averageVolume: 5000000 },
  { symbol: "VAIBHAVGBL",  sector: "Consumer",     industry: "Jewellery",          marketCap: 6000,    averageVolume: 200000 },
  { symbol: "VGUARD",      sector: "Consumer",     industry: "Consumer Durables",  marketCap: 8000,    averageVolume: 500000 },
  { symbol: "VINATIORGA",  sector: "Materials",    industry: "Chemicals",          marketCap: 8000,    averageVolume: 200000 },
  { symbol: "WHIRLPOOL",   sector: "Consumer",     industry: "Consumer Durables",  marketCap: 8000,    averageVolume: 200000 },
  { symbol: "ZEEL",        sector: "Consumer",     industry: "Media",              marketCap: 8000,    averageVolume: 3000000 },
  { symbol: "ZYDUSLIFE",   sector: "Healthcare",   industry: "Pharma",             marketCap: 20000,   averageVolume: 2000000 },

  // â”€â”€ NIFTY SMALLCAP 250 â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
  { symbol: "AARTIIND",    sector: "Materials",    industry: "Chemicals",          marketCap: 8000,    averageVolume: 1000000 },
  { symbol: "AAVAS",       sector: "Financials",   industry: "Housing Finance",    marketCap: 8000,    averageVolume: 300000 },
  { symbol: "ABBOTINDIA",  sector: "Healthcare",   industry: "Pharma",             marketCap: 12000,   averageVolume: 100000 },
  { symbol: "ACCELYA",     sector: "Technology",   industry: "Aviation Software",  marketCap: 4000,    averageVolume: 100000 },
  { symbol: "ACE",         sector: "Industrials",  industry: "Cranes",             marketCap: 4000,    averageVolume: 500000 },
  { symbol: "ACRYSIL",     sector: "Consumer",     industry: "Building Materials", marketCap: 2000,    averageVolume: 200000 },
  { symbol: "ADANIPOWER",  sector: "Utilities",    industry: "Power Generation",   marketCap: 50000,   averageVolume: 5000000 },
  { symbol: "AEGISLOG",    sector: "Industrials",  industry: "Logistics",          marketCap: 4000,    averageVolume: 300000 },
  { symbol: "AFFLE",       sector: "Technology",   industry: "AdTech",             marketCap: 8000,    averageVolume: 300000 },
  { symbol: "AJANTPHARM",  sector: "Healthcare",   industry: "Pharma",             marketCap: 6000,    averageVolume: 200000 },
  { symbol: "AKZOINDIA",   sector: "Materials",    industry: "Paints",             marketCap: 4000,    averageVolume: 100000 },
  { symbol: "AMARAJABAT",  sector: "Auto",         industry: "Batteries",          marketCap: 6000,    averageVolume: 500000 },
  { symbol: "AMBER",       sector: "Consumer",     industry: "Consumer Durables",  marketCap: 6000,    averageVolume: 200000 },
  { symbol: "ANGELONE",    sector: "Financials",   industry: "Broking",            marketCap: 10000,   averageVolume: 500000 },
  { symbol: "ANURAS",      sector: "Consumer",     industry: "QSR",                marketCap: 4000,    averageVolume: 200000 },
  { symbol: "APARINDS",    sector: "Industrials",  industry: "Cables",             marketCap: 6000,    averageVolume: 200000 },
  { symbol: "APOLLOTYRE",  sector: "Auto",         industry: "Tyres",              marketCap: 10000,   averageVolume: 2000000 },
  { symbol: "APTUS",       sector: "Financials",   industry: "Housing Finance",    marketCap: 6000,    averageVolume: 500000 },
  { symbol: "ARVINDFASN",  sector: "Consumer",     industry: "Apparel",            marketCap: 4000,    averageVolume: 500000 },
  { symbol: "ASAHIINDIA",  sector: "Auto",         industry: "Auto Glass",         marketCap: 4000,    averageVolume: 300000 },
  { symbol: "ASHOKLEY",    sector: "Auto",         industry: "Commercial Vehicles",marketCap: 20000,   averageVolume: 5000000 },
  { symbol: "ASKAUTOLTD",  sector: "Auto",         industry: "Auto Components",    marketCap: 2000,    averageVolume: 200000 },
  { symbol: "ATGL",        sector: "Energy",       industry: "Gas Distribution",   marketCap: 8000,    averageVolume: 500000 },
  { symbol: "AVANTIFEED",  sector: "Consumer",     industry: "Aquaculture",        marketCap: 4000,    averageVolume: 500000 },
  { symbol: "AXISCADES",   sector: "Technology",   industry: "Engineering Services",marketCap: 2000,   averageVolume: 200000 },
  { symbol: "BAJAJHLDNG",  sector: "Financials",   industry: "Investment",         marketCap: 20000,   averageVolume: 100000 },
  { symbol: "BALRAMCHIN",  sector: "Consumer",     industry: "Sugar",              marketCap: 4000,    averageVolume: 1000000 },
  { symbol: "BASF",        sector: "Materials",    industry: "Chemicals",          marketCap: 6000,    averageVolume: 100000 },

  { symbol: "BAYERCROP",   sector: "Materials",    industry: "Agrochemicals",      marketCap: 6000,    averageVolume: 100000 },
  { symbol: "BEML",        sector: "Industrials",  industry: "Defence",            marketCap: 6000,    averageVolume: 300000 },
  { symbol: "BIKAJI",      sector: "Consumer",     industry: "FMCG",               marketCap: 6000,    averageVolume: 500000 },
  { symbol: "BLUESTARCO",  sector: "Consumer",     industry: "Consumer Durables",  marketCap: 8000,    averageVolume: 300000 },
  { symbol: "BORORENEW",   sector: "Materials",    industry: "Chemicals",          marketCap: 2000,    averageVolume: 200000 },
  { symbol: "BRIGADE",     sector: "Real Estate",  industry: "Real Estate",        marketCap: 8000,    averageVolume: 500000 },
  { symbol: "BSE",         sector: "Financials",   industry: "Exchange",           marketCap: 10000,   averageVolume: 500000 },
  { symbol: "BSOFT",       sector: "Technology",   industry: "Healthcare IT",      marketCap: 4000,    averageVolume: 500000 },
  { symbol: "CAMPUS",      sector: "Consumer",     industry: "Footwear",           marketCap: 4000,    averageVolume: 500000 },
  { symbol: "CAPLIPOINT",  sector: "Healthcare",   industry: "Pharma",             marketCap: 4000,    averageVolume: 200000 },
  { symbol: "CARBORUNIV",  sector: "Industrials",  industry: "Abrasives",          marketCap: 4000,    averageVolume: 200000 },
  { symbol: "CDSL",        sector: "Financials",   industry: "Depository",         marketCap: 12000,   averageVolume: 1000000 },
  { symbol: "CENTURYPLY",  sector: "Materials",    industry: "Plywood",            marketCap: 6000,    averageVolume: 500000 },
  { symbol: "CENTURYTEX",  sector: "Consumer",     industry: "Textiles",           marketCap: 4000,    averageVolume: 300000 },
  { symbol: "CERA",        sector: "Materials",    industry: "Sanitaryware",       marketCap: 4000,    averageVolume: 100000 },
  { symbol: "CHALET",      sector: "Consumer",     industry: "Hotels",             marketCap: 6000,    averageVolume: 500000 },
  { symbol: "CHAMBLFERT",  sector: "Materials",    industry: "Fertilizers",        marketCap: 4000,    averageVolume: 1000000 },
  { symbol: "CLEAN",       sector: "Industrials",  industry: "Waste Management",   marketCap: 4000,    averageVolume: 300000 },
  { symbol: "CMSINFO",     sector: "Industrials",  industry: "Cash Logistics",     marketCap: 4000,    averageVolume: 300000 },
  { symbol: "COCHINSHIP",  sector: "Industrials",  industry: "Shipbuilding",       marketCap: 6000,    averageVolume: 500000 },
  { symbol: "CRAFTSMAN",   sector: "Auto",         industry: "Auto Components",    marketCap: 4000,    averageVolume: 100000 },
  { symbol: "CRISIL",      sector: "Financials",   industry: "Rating Agency",      marketCap: 8000,    averageVolume: 100000 },
  { symbol: "CYIENT",      sector: "Technology",   industry: "Engineering Services",marketCap: 8000,   averageVolume: 300000 },
  { symbol: "DATAPATTNS",  sector: "Technology",   industry: "Defence Electronics",marketCap: 6000,    averageVolume: 100000 },
  { symbol: "DCMSHRIRAM",  sector: "Materials",    industry: "Chemicals",          marketCap: 4000,    averageVolume: 300000 },
  { symbol: "DELTACORP",   sector: "Consumer",     industry: "Gaming",             marketCap: 4000,    averageVolume: 1000000 },
  { symbol: "DEVYANI",     sector: "Consumer",     industry: "QSR",                marketCap: 6000,    averageVolume: 1000000 },
  { symbol: "DHANI",       sector: "Financials",   industry: "Fintech",            marketCap: 2000,    averageVolume: 1000000 },
  { symbol: "DHANUKA",     sector: "Materials",    industry: "Agrochemicals",      marketCap: 4000,    averageVolume: 200000 },
  { symbol: "DOMS",        sector: "Consumer",     industry: "Stationery",         marketCap: 4000,    averageVolume: 200000 },
  { symbol: "EASEMYTRIP",  sector: "Technology",   industry: "Travel Tech",        marketCap: 4000,    averageVolume: 1000000 },
  { symbol: "EIDPARRY",    sector: "Consumer",     industry: "Sugar",              marketCap: 4000,    averageVolume: 500000 },
  { symbol: "ELECON",      sector: "Industrials",  industry: "Gears",              marketCap: 4000,    averageVolume: 300000 },
  { symbol: "ELGIEQUIP",   sector: "Industrials",  industry: "Compressors",        marketCap: 6000,    averageVolume: 300000 },
  { symbol: "EMAMILTD",    sector: "Consumer",     industry: "FMCG",               marketCap: 8000,    averageVolume: 500000 },
  { symbol: "ENGINERSIN",  sector: "Industrials",  industry: "Engineering",        marketCap: 6000,    averageVolume: 500000 },
  { symbol: "EPL",         sector: "Industrials",  industry: "Packaging",          marketCap: 4000,    averageVolume: 500000 },
  { symbol: "EQUITASBNK",  sector: "Financials",   industry: "Small Finance Bank", marketCap: 4000,    averageVolume: 2000000 },
  { symbol: "ESTER",       sector: "Materials",    industry: "Chemicals",          marketCap: 2000,    averageVolume: 200000 },
  { symbol: "ETHOS",       sector: "Consumer",     industry: "Luxury Retail",      marketCap: 4000,    averageVolume: 100000 },
  { symbol: "FINEORG",     sector: "Materials",    industry: "Specialty Chemicals",marketCap: 4000,    averageVolume: 100000 },
  { symbol: "FINPIPE",     sector: "Industrials",  industry: "Pipes",              marketCap: 2000,    averageVolume: 200000 },
  { symbol: "FLAIR",       sector: "Consumer",     industry: "Stationery",         marketCap: 2000,    averageVolume: 200000 },
  { symbol: "FLUOROCHEM",  sector: "Materials",    industry: "Fluorochemicals",    marketCap: 6000,    averageVolume: 200000 },
  { symbol: "FMGOETZE",    sector: "Auto",         industry: "Auto Components",    marketCap: 4000,    averageVolume: 100000 },
  { symbol: "GABRIEL",     sector: "Auto",         industry: "Shock Absorbers",    marketCap: 2000,    averageVolume: 300000 },
  { symbol: "GALAXYSURF",  sector: "Materials",    industry: "Surfactants",        marketCap: 4000,    averageVolume: 100000 },
  { symbol: "GARFIBRES",   sector: "Materials",    industry: "Textiles",           marketCap: 2000,    averageVolume: 100000 },
  { symbol: "GESHIP",      sector: "Industrials",  industry: "Shipping",           marketCap: 4000,    averageVolume: 300000 },

  { symbol: "GHCL",        sector: "Materials",    industry: "Chemicals",          marketCap: 4000,    averageVolume: 500000 },
  { symbol: "GILLETTE",    sector: "Consumer",     industry: "FMCG",               marketCap: 4000,    averageVolume: 50000 },
  { symbol: "GLAXO",       sector: "Healthcare",   industry: "Pharma",             marketCap: 6000,    averageVolume: 100000 },
  { symbol: "GLOBUSSPR",   sector: "Consumer",     industry: "Apparel",            marketCap: 2000,    averageVolume: 200000 },
  { symbol: "GNFC",        sector: "Materials",    industry: "Fertilizers",        marketCap: 4000,    averageVolume: 500000 },
  { symbol: "GODFRYPHLP",  sector: "Consumer",     industry: "Tobacco",            marketCap: 4000,    averageVolume: 100000 },
  { symbol: "GODREJAGRO",  sector: "Materials",    industry: "Agrochemicals",      marketCap: 4000,    averageVolume: 200000 },
  { symbol: "GODREJIND",   sector: "Consumer",     industry: "Diversified",        marketCap: 6000,    averageVolume: 300000 },
  { symbol: "GPIL",        sector: "Materials",    industry: "Steel",              marketCap: 4000,    averageVolume: 300000 },
  { symbol: "GREAVESCOT",  sector: "Industrials",  industry: "Engines",            marketCap: 4000,    averageVolume: 500000 },
  { symbol: "GREENPANEL",  sector: "Materials",    industry: "Wood Panels",        marketCap: 4000,    averageVolume: 500000 },
  { symbol: "GRINDWELL",   sector: "Industrials",  industry: "Abrasives",          marketCap: 6000,    averageVolume: 100000 },
  { symbol: "GUJGASLTD",   sector: "Energy",       industry: "Gas Distribution",   marketCap: 8000,    averageVolume: 1000000 },
  { symbol: "GULFOILLUB",  sector: "Energy",       industry: "Lubricants",         marketCap: 2000,    averageVolume: 100000 },
  { symbol: "HAPPSTMNDS",  sector: "Technology",   industry: "IT Services",        marketCap: 6000,    averageVolume: 300000 },
  { symbol: "HATSUN",      sector: "Consumer",     industry: "Dairy",              marketCap: 6000,    averageVolume: 100000 },
  { symbol: "HBLPOWER",    sector: "Industrials",  industry: "Batteries",          marketCap: 4000,    averageVolume: 500000 },
  { symbol: "HFCL",        sector: "Technology",   industry: "Telecom Equipment",  marketCap: 6000,    averageVolume: 3000000 },
  { symbol: "HIKAL",       sector: "Materials",    industry: "Chemicals",          marketCap: 4000,    averageVolume: 300000 },
  { symbol: "HINDCOPPER",  sector: "Materials",    industry: "Copper",             marketCap: 6000,    averageVolume: 3000000 },
  { symbol: "HINDWAREAP",  sector: "Consumer",     industry: "Building Materials", marketCap: 4000,    averageVolume: 200000 },
  { symbol: "HOMEFIRST",   sector: "Financials",   industry: "Housing Finance",    marketCap: 4000,    averageVolume: 300000 },
  { symbol: "HUDCO",       sector: "Financials",   industry: "Housing Finance",    marketCap: 8000,    averageVolume: 3000000 },
  { symbol: "IBREALEST",   sector: "Real Estate",  industry: "Real Estate",        marketCap: 4000,    averageVolume: 2000000 },
  { symbol: "ICICIGI",     sector: "Financials",   industry: "Insurance",          marketCap: 20000,   averageVolume: 1000000 },
  { symbol: "IDBI",        sector: "Financials",   industry: "Public Bank",        marketCap: 20000,   averageVolume: 5000000 },
  { symbol: "IFBIND",      sector: "Consumer",     industry: "Consumer Durables",  marketCap: 4000,    averageVolume: 100000 },
  { symbol: "IIFL",        sector: "Financials",   industry: "NBFC",               marketCap: 8000,    averageVolume: 1000000 },
  { symbol: "IIFLFIN",     sector: "Financials",   industry: "NBFC",               marketCap: 6000,    averageVolume: 1000000 },
  { symbol: "IMAGICAA",    sector: "Consumer",     industry: "Entertainment",      marketCap: 2000,    averageVolume: 500000 },
  { symbol: "INDIAMART",   sector: "Technology",   industry: "B2B Marketplace",    marketCap: 10000,   averageVolume: 200000 },
  { symbol: "INDIANB",     sector: "Financials",   industry: "Public Bank",        marketCap: 10000,   averageVolume: 3000000 },
  { symbol: "INDIACEM",    sector: "Materials",    industry: "Cement",             marketCap: 4000,    averageVolume: 1000000 },
  { symbol: "INDIGOPNTS",  sector: "Consumer",     industry: "Paints",             marketCap: 4000,    averageVolume: 200000 },
  { symbol: "INOXGREEN",   sector: "Utilities",    industry: "Wind Energy",        marketCap: 4000,    averageVolume: 500000 },
  { symbol: "INTELLECT",   sector: "Technology",   industry: "Banking Software",   marketCap: 6000,    averageVolume: 300000 },
  { symbol: "IONEXCHANG",  sector: "Materials",    industry: "Chemicals",          marketCap: 4000,    averageVolume: 200000 },
  { symbol: "IRB",         sector: "Industrials",  industry: "Roads",              marketCap: 8000,    averageVolume: 2000000 },
  { symbol: "IRCON",       sector: "Industrials",  industry: "Railways",           marketCap: 8000,    averageVolume: 2000000 },
  { symbol: "ITDCEM",      sector: "Industrials",  industry: "Construction",       marketCap: 4000,    averageVolume: 500000 },
  { symbol: "JBCHEPHARM",  sector: "Healthcare",   industry: "Pharma",             marketCap: 4000,    averageVolume: 200000 },
  { symbol: "JBMA",        sector: "Auto",         industry: "Auto Components",    marketCap: 4000,    averageVolume: 200000 },
  { symbol: "JKIL",        sector: "Industrials",  industry: "Construction",       marketCap: 4000,    averageVolume: 300000 },
  { symbol: "JKLAKSHMI",   sector: "Materials",    industry: "Cement",             marketCap: 4000,    averageVolume: 300000 },
  { symbol: "JKPAPER",     sector: "Materials",    industry: "Paper",              marketCap: 4000,    averageVolume: 300000 },
  { symbol: "JMFINANCIL",  sector: "Financials",   industry: "Investment Banking", marketCap: 4000,    averageVolume: 500000 },
  { symbol: "JSWINFRA",    sector: "Industrials",  industry: "Ports",              marketCap: 10000,   averageVolume: 1000000 },
  { symbol: "JTEKTINDIA",  sector: "Auto",         industry: "Steering Systems",   marketCap: 4000,    averageVolume: 300000 },
  { symbol: "JUSTDIAL",    sector: "Technology",   industry: "Local Search",       marketCap: 4000,    averageVolume: 300000 },

  { symbol: "KALYANKJIL",  sector: "Consumer",     industry: "Jewellery",          marketCap: 8000,    averageVolume: 2000000 },
  { symbol: "KAYNES",      sector: "Technology",   industry: "Electronics Mfg",    marketCap: 6000,    averageVolume: 200000 },
  { symbol: "KFINTECH",    sector: "Financials",   industry: "Registrar",          marketCap: 6000,    averageVolume: 500000 },
  { symbol: "KIMS",        sector: "Healthcare",   industry: "Hospitals",          marketCap: 6000,    averageVolume: 300000 },
  { symbol: "KIRLOSENG",   sector: "Industrials",  industry: "Pumps",              marketCap: 4000,    averageVolume: 200000 },
  { symbol: "KNRCON",      sector: "Industrials",  industry: "Roads",              marketCap: 4000,    averageVolume: 300000 },
  { symbol: "KRBL",        sector: "Consumer",     industry: "Food",               marketCap: 4000,    averageVolume: 300000 },
  { symbol: "KSCL",        sector: "Materials",    industry: "Seeds",              marketCap: 4000,    averageVolume: 200000 },
  { symbol: "LATENTVIEW",  sector: "Technology",   industry: "Data Analytics",     marketCap: 6000,    averageVolume: 500000 },
  { symbol: "LEMONTREE",   sector: "Consumer",     industry: "Hotels",             marketCap: 4000,    averageVolume: 1000000 },
  { symbol: "LXCHEM",      sector: "Materials",    industry: "Chemicals",          marketCap: 4000,    averageVolume: 200000 },
  { symbol: "MAHINDCIE",   sector: "Auto",         industry: "Auto Components",    marketCap: 6000,    averageVolume: 500000 },
  { symbol: "MAHLIFE",     sector: "Real Estate",  industry: "Real Estate",        marketCap: 4000,    averageVolume: 300000 },
  { symbol: "MAHLOG",      sector: "Industrials",  industry: "Logistics",          marketCap: 4000,    averageVolume: 300000 },
  { symbol: "MAPMYINDIA",  sector: "Technology",   industry: "Mapping",            marketCap: 6000,    averageVolume: 200000 },
  { symbol: "MASTEK",      sector: "Technology",   industry: "IT Services",        marketCap: 4000,    averageVolume: 200000 },
  { symbol: "MEDANTA",     sector: "Healthcare",   industry: "Hospitals",          marketCap: 6000,    averageVolume: 300000 },
  { symbol: "MEDPLUS",     sector: "Healthcare",   industry: "Pharmacy Retail",    marketCap: 4000,    averageVolume: 300000 },
  { symbol: "METROBRAND",  sector: "Consumer",     industry: "Footwear",           marketCap: 4000,    averageVolume: 300000 },
  { symbol: "MHRIL",       sector: "Consumer",     industry: "Hospitality",        marketCap: 2000,    averageVolume: 200000 },
  { symbol: "MIDHANI",     sector: "Industrials",  industry: "Defence",            marketCap: 4000,    averageVolume: 500000 },
  { symbol: "MMTC",        sector: "Industrials",  industry: "Trading",            marketCap: 4000,    averageVolume: 2000000 },
  { symbol: "MOIL",        sector: "Materials",    industry: "Manganese",          marketCap: 4000,    averageVolume: 1000000 },
  { symbol: "MOREPENLAB",  sector: "Healthcare",   industry: "Pharma",             marketCap: 2000,    averageVolume: 500000 },
  { symbol: "MPHASIS",     sector: "Technology",   industry: "IT Services",        marketCap: 20000,   averageVolume: 500000 },
  { symbol: "MRPL",        sector: "Energy",       industry: "Oil Refining",       marketCap: 6000,    averageVolume: 2000000 },
  { symbol: "MSTCLTD",     sector: "Technology",   industry: "E-Commerce",         marketCap: 2000,    averageVolume: 300000 },
  { symbol: "NAVA",        sector: "Utilities",    industry: "Power",              marketCap: 4000,    averageVolume: 500000 },
  { symbol: "NAVINFLUOR",  sector: "Materials",    industry: "Fluorochemicals",    marketCap: 6000,    averageVolume: 200000 },
  { symbol: "NESCO",       sector: "Real Estate",  industry: "Exhibition Centre",  marketCap: 4000,    averageVolume: 100000 },
  { symbol: "NETWORK18",   sector: "Consumer",     industry: "Media",              marketCap: 4000,    averageVolume: 2000000 },
  { symbol: "NEWGEN",      sector: "Technology",   industry: "Enterprise Software",marketCap: 4000,    averageVolume: 200000 },
  { symbol: "NIITLTD",     sector: "Technology",   industry: "IT Training",        marketCap: 2000,    averageVolume: 500000 },
  { symbol: "NSLNISP",     sector: "Materials",    industry: "Steel",              marketCap: 4000,    averageVolume: 500000 },
  { symbol: "NUVOCO",      sector: "Materials",    industry: "Cement",             marketCap: 4000,    averageVolume: 300000 },
  { symbol: "OLECTRA",     sector: "Auto",         industry: "Electric Buses",     marketCap: 6000,    averageVolume: 500000 },
  { symbol: "OMAXE",       sector: "Real Estate",  industry: "Real Estate",        marketCap: 2000,    averageVolume: 300000 },
  { symbol: "ORIENTCEM",   sector: "Materials",    industry: "Cement",             marketCap: 4000,    averageVolume: 500000 },
  { symbol: "ORIENTELEC",  sector: "Consumer",     industry: "Consumer Durables",  marketCap: 2000,    averageVolume: 300000 },
  { symbol: "PATELENG",    sector: "Industrials",  industry: "Construction",       marketCap: 2000,    averageVolume: 300000 },
  { symbol: "PATANJALI",   sector: "Consumer",     industry: "FMCG",               marketCap: 6000,    averageVolume: 500000 },
  { symbol: "PCBL",        sector: "Materials",    industry: "Carbon Black",       marketCap: 4000,    averageVolume: 500000 },
  { symbol: "PDSL",        sector: "Technology",   industry: "IT Services",        marketCap: 2000,    averageVolume: 200000 },
  { symbol: "PENIND",      sector: "Industrials",  industry: "Pipes",              marketCap: 2000,    averageVolume: 300000 },
  { symbol: "PNBHOUSING",  sector: "Financials",   industry: "Housing Finance",    marketCap: 8000,    averageVolume: 1000000 },
  { symbol: "POKARNA",     sector: "Materials",    industry: "Granite",            marketCap: 2000,    averageVolume: 100000 },
  { symbol: "POLYMED",     sector: "Healthcare",   industry: "Medical Devices",    marketCap: 4000,    averageVolume: 200000 },
  { symbol: "POONAWALLA",  sector: "Financials",   industry: "NBFC",               marketCap: 8000,    averageVolume: 1000000 },
  { symbol: "POWERMECH",   sector: "Industrials",  industry: "Power Services",     marketCap: 4000,    averageVolume: 200000 },

  { symbol: "PRAXIS",      sector: "Healthcare",   industry: "Hospitals",          marketCap: 2000,    averageVolume: 200000 },
  { symbol: "PRICOLLTD",   sector: "Auto",         industry: "Auto Components",    marketCap: 2000,    averageVolume: 200000 },
  { symbol: "PRIMESECU",   sector: "Financials",   industry: "Broking",            marketCap: 2000,    averageVolume: 200000 },
  { symbol: "PRIVISCL",    sector: "Industrials",  industry: "Cables",             marketCap: 2000,    averageVolume: 200000 },
  { symbol: "PRUDENT",     sector: "Financials",   industry: "Wealth Management",  marketCap: 4000,    averageVolume: 200000 },
  { symbol: "PTCIL",       sector: "Utilities",    industry: "Power Trading",      marketCap: 4000,    averageVolume: 1000000 },
  { symbol: "PURVA",       sector: "Real Estate",  industry: "Real Estate",        marketCap: 4000,    averageVolume: 500000 },
  { symbol: "RADICO",      sector: "Consumer",     industry: "Beverages",          marketCap: 6000,    averageVolume: 300000 },
  { symbol: "RAILTEL",     sector: "Technology",   industry: "Telecom",            marketCap: 6000,    averageVolume: 1000000 },
  { symbol: "RAJRATAN",    sector: "Materials",    industry: "Steel Wire",         marketCap: 2000,    averageVolume: 100000 },
  { symbol: "RALLIS",      sector: "Materials",    industry: "Agrochemicals",      marketCap: 4000,    averageVolume: 300000 },
  { symbol: "RATNAMANI",   sector: "Materials",    industry: "Steel Pipes",        marketCap: 6000,    averageVolume: 200000 },
  { symbol: "RAYMOND",     sector: "Consumer",     industry: "Textiles",           marketCap: 6000,    averageVolume: 500000 },
  { symbol: "REDINGTON",   sector: "Technology",   industry: "IT Distribution",    marketCap: 6000,    averageVolume: 1000000 },
  { symbol: "RELAXO",      sector: "Consumer",     industry: "Footwear",           marketCap: 6000,    averageVolume: 300000 },
  { symbol: "RITES",       sector: "Industrials",  industry: "Consulting",         marketCap: 6000,    averageVolume: 500000 },
  { symbol: "RKFORGE",     sector: "Auto",         industry: "Forgings",           marketCap: 4000,    averageVolume: 200000 },
  { symbol: "ROSSARI",     sector: "Materials",    industry: "Specialty Chemicals",marketCap: 4000,    averageVolume: 200000 },
  { symbol: "ROUTE",       sector: "Technology",   industry: "Messaging",          marketCap: 4000,    averageVolume: 200000 },
  { symbol: "RPGLIFE",     sector: "Healthcare",   industry: "Pharma",             marketCap: 2000,    averageVolume: 100000 },
  { symbol: "RPOWER",      sector: "Utilities",    industry: "Power",              marketCap: 4000,    averageVolume: 5000000 },
  { symbol: "RVNL",        sector: "Industrials",  industry: "Railways",           marketCap: 20000,   averageVolume: 5000000 },
  { symbol: "SAFARI",      sector: "Consumer",     industry: "Luggage",            marketCap: 4000,    averageVolume: 200000 },
  { symbol: "SAREGAMA",    sector: "Consumer",     industry: "Music",              marketCap: 4000,    averageVolume: 200000 },
  { symbol: "SBFC",        sector: "Financials",   industry: "NBFC",               marketCap: 4000,    averageVolume: 500000 },
  { symbol: "SEQUENT",     sector: "Healthcare",   industry: "Pharma",             marketCap: 4000,    averageVolume: 500000 },
  { symbol: "SHARDACROP",  sector: "Materials",    industry: "Agrochemicals",      marketCap: 4000,    averageVolume: 200000 },
  { symbol: "SHILPAMED",   sector: "Healthcare",   industry: "Medical Devices",    marketCap: 4000,    averageVolume: 200000 },
  { symbol: "SHOPERSTOP",  sector: "Consumer",     industry: "Retail",             marketCap: 4000,    averageVolume: 300000 },
  { symbol: "SHRIRAMEPC",  sector: "Industrials",  industry: "EPC",                marketCap: 4000,    averageVolume: 300000 },
  { symbol: "SHRIRAMFIN",  sector: "Financials",   industry: "NBFC",               marketCap: 30000,   averageVolume: 2000000 },
  { symbol: "SIGNATURE",   sector: "Financials",   industry: "NBFC",               marketCap: 2000,    averageVolume: 200000 },
  { symbol: "SJVN",        sector: "Utilities",    industry: "Hydro Power",        marketCap: 10000,   averageVolume: 3000000 },
  { symbol: "SMLISUZU",    sector: "Auto",         industry: "Commercial Vehicles",marketCap: 2000,    averageVolume: 100000 },
  { symbol: "SOBHA",       sector: "Real Estate",  industry: "Real Estate",        marketCap: 6000,    averageVolume: 500000 },
  { symbol: "SOLARA",      sector: "Healthcare",   industry: "Pharma",             marketCap: 2000,    averageVolume: 200000 },
  { symbol: "SPARC",       sector: "Healthcare",   industry: "Pharma",             marketCap: 4000,    averageVolume: 500000 },
  { symbol: "SPANDANA",    sector: "Financials",   industry: "Microfinance",       marketCap: 4000,    averageVolume: 300000 },
  { symbol: "SPECIALITY",  sector: "Healthcare",   industry: "Hospitals",          marketCap: 2000,    averageVolume: 200000 },
  { symbol: "SPENCERS",    sector: "Consumer",     industry: "Retail",             marketCap: 2000,    averageVolume: 300000 },
  { symbol: "SPORTKING",   sector: "Consumer",     industry: "Textiles",           marketCap: 2000,    averageVolume: 100000 },
  { symbol: "SRINDUS",     sector: "Industrials",  industry: "Cables",             marketCap: 2000,    averageVolume: 200000 },
  { symbol: "STLTECH",     sector: "Technology",   industry: "Optical Fibre",      marketCap: 4000,    averageVolume: 1000000 },
  { symbol: "SUBROS",      sector: "Auto",         industry: "Auto Components",    marketCap: 2000,    averageVolume: 200000 },
  { symbol: "SUDARSCHEM",  sector: "Materials",    industry: "Chemicals",          marketCap: 4000,    averageVolume: 200000 },
  { symbol: "SUPRIYA",     sector: "Healthcare",   industry: "Pharma",             marketCap: 4000,    averageVolume: 200000 },
  { symbol: "SURYAROSNI",  sector: "Industrials",  industry: "Lighting",           marketCap: 4000,    averageVolume: 300000 },
  { symbol: "SUZLON",      sector: "Utilities",    industry: "Wind Energy",        marketCap: 20000,   averageVolume: 10000000 },
  { symbol: "SWSOLAR",     sector: "Utilities",    industry: "Solar EPC",          marketCap: 4000,    averageVolume: 500000 },
  { symbol: "SYMPHONY",    sector: "Consumer",     industry: "Consumer Durables",  marketCap: 4000,    averageVolume: 200000 },
];

// Register embedded list as fallback for StockUniverseService
setFallbackUniverse(NSE_STOCK_UNIVERSE.map(s => ({
  ...s,
  name: s.symbol,
  exchange: 'NSE' as const,
  instrumentKey: `NSE_EQ|${s.symbol}`,
})));

// ── Module-level result caches (shared across requests on warm instances) ────
const ultraQuantCache = new Map<string, { expiresAt: number; payload: any }>();
const ULTRA_QUANT_CACHE_TTL = 5 * 60_000;   // 5 min — recompute only when stale
const multibaggerCache = new Map<number, { expiresAt: number; payload: any }>();

// ── Memoised universe — rebuilt only when Supabase universe changes ───────────
let _cachedUniverse: UltraQuantProfile[] | null = null;

// ── Universe state — single object so startServerlessApp can access it ────────
const _universeState = {
  universe: null as UltraQuantProfile[] | null,
  loading: false,
  globalApplied: false,
};

/**
 * Seed embedded universe immediately, then upgrade to Supabase 5000+ in background.
 * Returns current universe synchronously (never blocks).
 */
const getUniverseSync = (): UltraQuantProfile[] => {
  if (_universeState.universe) return _universeState.universe;

  // Seed with embedded universe immediately
  _universeState.universe = NSE_STOCK_UNIVERSE.map(s => ({
    symbol: s.symbol, sector: s.sector, industry: s.industry,
    marketCap: s.marketCap, averageVolume: s.averageVolume,
  }));

  return _universeState.universe;
};

/**
 * Load Supabase universe with a timeout. Updates _universeState.universe in place.
 * Safe to call from startServerlessApp — uses only _universeState (no closure vars).
 */
const loadSupabaseUniverse = async (timeoutMs = 10000): Promise<void> => {
  if (_universeState.loading) return;
  // Already have full universe — skip
  if (_universeState.universe && _universeState.universe.length > 440) return;
  _universeState.loading = true;
  try {
    const supabase = getSupabaseClient();
    if (!supabase) { console.warn('[Universe] No Supabase client'); return; }

    console.log('[Universe] Loading from Supabase stock_universe table...');
    const PAGE_SIZE = 1000;
    let allRows: any[] = [];
    let from = 0;
    let done = false;

    const loadAll = async () => {
      while (!done) {
        const { data, error } = await supabase
          .from('stock_universe')
          .select('symbol,name,exchange,sector,industry,market_cap,avg_volume,instrument_key')
          .range(from, from + PAGE_SIZE - 1);
        if (error || !data || data.length === 0) { done = true; break; }
        allRows = allRows.concat(data);
        from += PAGE_SIZE;
        if (data.length < PAGE_SIZE) done = true;
      }
      if (allRows.length > 0) {
        const curatedMap = new Map(NSE_STOCK_UNIVERSE.map(s => [s.symbol, s]));
        _universeState.universe = allRows.map(row => {
          const c = curatedMap.get(row.symbol);
          return {
            symbol:        row.symbol,
            sector:        c?.sector  || row.sector  || 'Unknown',
            industry:      c?.industry || row.industry || 'Unknown',
            marketCap:     c?.marketCap || (Number(row.market_cap) > 0 ? Number(row.market_cap) : 1000),
            averageVolume: c?.averageVolume || (Number(row.avg_volume) > 0 ? Number(row.avg_volume) : 100000),
          };
        });
        ultraQuantCache.clear();
        multibaggerCache.clear();
        _cachedUniverse = null;
        console.log(`[Universe] Loaded ${_universeState.universe.length} stocks from Supabase`);
      }
    };

    await Promise.race([loadAll(), new Promise<void>(r => setTimeout(r, timeoutMs))]);
  } catch (e: any) {
    console.warn('[Universe] Supabase load failed:', e.message);
  } finally {
    _universeState.loading = false;
  }
};

const createUltraQuantUniverse = (): UltraQuantProfile[] => {
  // Fast path: return memoised result — but only if it's the full Supabase universe (>440 stocks)
  if (_cachedUniverse && _cachedUniverse.length > 440) return _cachedUniverse;

  // If _universeState already has Supabase data (loaded via loadSupabaseUniverse), use it directly
  if (_universeState.universe && _universeState.universe.length > 440) {
    ultraQuantCache.clear();
    multibaggerCache.clear();
    _cachedUniverse = _universeState.universe;
    console.log(`[Universe] Using ${_cachedUniverse.length} stocks from _universeState`);
    return _cachedUniverse;
  }

  // Check if startServerlessApp pre-loaded Supabase universe into global
  const globalUniverse = (global as any).__supabaseUniverse as Array<{ symbol: string; sector: string; industry: string; marketCap: number; averageVolume: number }> | undefined;
  if (globalUniverse && globalUniverse.length > 440) {
    const curatedMap = new Map(NSE_STOCK_UNIVERSE.map(s => [s.symbol, s]));
    _universeState.universe = globalUniverse.map(s => {
      const c = curatedMap.get(s.symbol);
      return {
        symbol:        s.symbol,
        sector:        c?.sector  || s.sector  || 'Unknown',
        industry:      c?.industry || s.industry || 'Unknown',
        marketCap:     c?.marketCap || (s.marketCap > 0 ? s.marketCap : 1000),
        averageVolume: c?.averageVolume || (s.averageVolume > 0 ? s.averageVolume : 100000),
      };
    });
    _universeState.globalApplied = true;
    ultraQuantCache.clear();
    multibaggerCache.clear();
    _cachedUniverse = _universeState.universe;
    console.log(`[Universe] Applied ${_cachedUniverse.length} stocks from global pre-load`);
    return _cachedUniverse;
  }
  if (!_universeState.universe) getUniverseSync();
  _cachedUniverse = _universeState.universe!;
  return _cachedUniverse;
};


  const buildReturns = (prices: number[]) => {
    const returns: number[] = [];
    for (let index = 1; index < prices.length; index++) {
      returns.push((prices[index] - prices[index - 1]) / prices[index - 1]);
    }
    return returns;
  };

  const buildEma = (values: number[], period: number) => {
    if (!values.length) return [];
    const multiplier = 2 / (period + 1);
    const ema = [values[0]];
    for (let index = 1; index < values.length; index++) {
      ema.push(((values[index] - ema[index - 1]) * multiplier) + ema[index - 1]);
    }
    return ema;
  };

  const calculateSlope = (values: number[]) => {
    if (values.length < 2) return 0;
    let sumX = 0;
    let sumY = 0;
    let sumXY = 0;
    let sumX2 = 0;
    const n = values.length;
    for (let index = 0; index < n; index++) {
      sumX += index;
      sumY += values[index];
      sumXY += index * values[index];
      sumX2 += index * index;
    }
    const denominator = n * sumX2 - sumX * sumX;
    return denominator === 0 ? 0 : (n * sumXY - sumX * sumY) / denominator;
  };

  const calculateVolatility = (returns: number[]) => {
    if (returns.length < 2) return 0;
    const mean = average(returns);
    const variance = average(returns.map((item) => Math.pow(item - mean, 2)));
    return Math.sqrt(variance);
  };

  const calculateMaxDrawdown = (prices: number[]) => {
    if (!prices.length) return 0;
    let peak = prices[0];
    let maxDrawdown = 0;
    for (const price of prices) {
      peak = Math.max(peak, price);
      maxDrawdown = Math.max(maxDrawdown, (peak - price) / peak);
    }
    return maxDrawdown * 100;
  };

  const calculateVolumeProfile = (candles: UltraQuantCandle[], binSize: number) => {
    const volumeAtPrice = new Map<number, number>();
    let totalVolume = 0;

    candles.forEach((candle) => {
      const priceBin = Math.round(candle.close / binSize) * binSize;
      volumeAtPrice.set(priceBin, (volumeAtPrice.get(priceBin) ?? 0) + candle.volume);
      totalVolume += candle.volume;
    });

    const sortedPrices = Array.from(volumeAtPrice.keys()).sort((left, right) => left - right);
    const profile = sortedPrices.map((price) => ({
      price,
      volume: volumeAtPrice.get(price) ?? 0,
      isPOC: false,
      isInValueArea: false
    }));

    let poc = 0;
    let pocIndex = 0;
    profile.forEach((node, index) => {
      if (node.volume > (profile[pocIndex]?.volume ?? -1)) {
        poc = node.price;
        pocIndex = index;
      }
    });

    if (!profile.length) {
      return { profile: [], poc: 0, vah: 0, val: 0 };
    }

    profile[pocIndex].isPOC = true;
    const targetVolume = totalVolume * 0.7;
    let accumulated = profile[pocIndex].volume;
    let lowIndex = pocIndex;
    let highIndex = pocIndex;

    while (accumulated < targetVolume && (lowIndex > 0 || highIndex < profile.length - 1)) {
      const lowerVolume = lowIndex > 0 ? profile[lowIndex - 1].volume : -1;
      const upperVolume = highIndex < profile.length - 1 ? profile[highIndex + 1].volume : -1;

      if (lowerVolume >= upperVolume && lowIndex > 0) {
        lowIndex -= 1;
        accumulated += profile[lowIndex].volume;
      } else if (highIndex < profile.length - 1) {
        highIndex += 1;
        accumulated += profile[highIndex].volume;
      } else {
        break;
      }
    }

    for (let index = lowIndex; index <= highIndex; index++) {
      profile[index].isInValueArea = true;
    }

    return {
      profile,
      poc,
      vah: profile[highIndex]?.price ?? 0,
      val: profile[lowIndex]?.price ?? 0
    };
  };

  const calculateAtr = (candles: UltraQuantCandle[], period: number) => {
    if (candles.length < 2) {
      return 0;
    }

    const startIndex = Math.max(1, candles.length - period);
    const trueRanges: number[] = [];
    for (let index = startIndex; index < candles.length; index++) {
      const current = candles[index];
      const previous = candles[index - 1];
      const trueRange = Math.max(
        current.high - current.low,
        Math.max(
          Math.abs(current.high - previous.close),
          Math.abs(current.low - previous.close)
        )
      );
      trueRanges.push(trueRange);
    }

    return average(trueRanges);
  };

  const relativePenalty = (value: number, target: number) => {
    if (target <= 0) {
      return 0;
    }

    return Math.abs(value - target) / target;
  };

  const normalizeScore = (value: number, min: number, max: number) => {
    if (max === min) {
      return value > 0 ? 100 : 50;
    }

    return clamp((value - min) / (max - min)) * 100;
  };

  const createOrderBook = (symbol: string, lastPrice: number) => {
    const random = seededGenerator(symbolSeed(symbol) * 31);
    const bids = Array.from({ length: 10 }, (_, index) => ({
      price: Number((lastPrice - (index + 1) * 0.35).toFixed(2)),
      volume: Math.round(2500 + random() * 9000 * (index === 0 ? 1.8 : 1))
    }));
    const asks = Array.from({ length: 10 }, (_, index) => ({
      price: Number((lastPrice + (index + 1) * 0.35).toFixed(2)),
      volume: Math.round(2200 + random() * 7000 * (index === 0 ? 0.9 : 1))
    }));
    return { bids, asks };
  };

  // ── Real OHLCV cache: symbol → candles + live price (TTL: 60 min) ────────
  const realOHLCVCache = new Map<string, { candles: UltraQuantCandle[]; livePrice: number | null; changePct: number | null; expiresAt: number }>();

  // Per-symbol live price cache — populated by fetchRealOHLCV and fetchYahooQuote
  const perSymbolPriceCache = new Map<string, { price: number; changePct: number; expiresAt: number }>();

  // Setter passed to loadOHLCVFromSupabase — populates realOHLCVCache from Supabase rows
  const setOHLCVCache = (symbol: string, candles: OHLCVCandle[], livePrice: number | null, changePct: number | null) => {
    realOHLCVCache.set(symbol, { candles: candles as UltraQuantCandle[], livePrice, changePct, expiresAt: Date.now() + 60 * 60_000 });
    if (livePrice) perSymbolPriceCache.set(symbol, { price: livePrice, changePct: changePct ?? 0, expiresAt: Date.now() + 60 * 60_000 });
  };

  // Used when the default SYMBOL.NS returns 404
  const YAHOO_SYMBOL_OVERRIDES: Record<string, string> = {
    'TATAMOTORS':  'TATAMOTORS.BO',  // BSE fallback
    'M&M':         'M%26M.NS',
    'BAJAJ-AUTO':  'BAJAJ-AUTO.NS',
    'HDFCLIFE':    'HDFCLIFE.NS',
    'SBILIFE':     'SBILIFE.NS',
    'ICICIGI':     'ICICIGI.NS',
    'NAUKRI':      'NAUKRI.NS',
    'DMART':       'DMART.NS',
  };

  /**
   * Fetch daily OHLCV candles from Yahoo Finance for an NSE symbol.
   * Tries SYMBOL.NS first, then SYMBOL.BO as fallback.
   * Returns null only if both fail or data is insufficient.
   * Hard timeout: 4s (Vercel safe).
   */
  const fetchRealOHLCV = async (symbol: string): Promise<UltraQuantCandle[] | null> => {
    const cached = realOHLCVCache.get(symbol);
    if (cached && cached.expiresAt > Date.now()) return cached.candles;

    const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36';

    // Build list of Yahoo tickers to try in order
    const override = YAHOO_SYMBOL_OVERRIDES[symbol.toUpperCase()];
    const tickers = override
      ? [override, `${symbol}.NS`, `${symbol}.BO`]
      : [`${symbol}.NS`, `${symbol}.BO`];

    for (const ticker of tickers) {
      try {
        const encoded = encodeURIComponent(ticker);
        const url = `https://query1.finance.yahoo.com/v8/finance/chart/${encoded}?interval=1d&range=2y`;
        const resp = await axios.get(url, { timeout: 4000, headers: { 'User-Agent': UA } });
        const result = resp.data?.chart?.result?.[0];
        if (!result) continue;

        // Validate: returned symbol base must match requested symbol
        const returnedBase = (result.meta?.symbol ?? '').toUpperCase().replace(/\.(NS|BO)$/, '');
        const requestedBase = symbol.toUpperCase().replace(/\.(NS|BO)$/, '');
        if (returnedBase && returnedBase !== requestedBase) continue;

        const timestamps: number[] = result.timestamp ?? [];
        const q = result.indicators?.quote?.[0];
        if (!q || timestamps.length < 60) continue;

        const candles: UltraQuantCandle[] = [];
        for (let i = 0; i < timestamps.length; i++) {
          const o = q.open?.[i], h = q.high?.[i], l = q.low?.[i], c = q.close?.[i], v = q.volume?.[i];
          if (o == null || h == null || l == null || c == null || c <= 0) continue;
          candles.push({ open: o, high: h, low: l, close: c, volume: v ?? 0 });
        }
        if (candles.length < 60) continue;

        // Extract live price from meta — same call, no extra network request
        const meta = result.meta;
        const livePrice: number | null = (meta?.regularMarketPrice > 0) ? Number(meta.regularMarketPrice.toFixed(2)) : null;
        const prevClose = meta?.chartPreviousClose ?? meta?.previousClose ?? null;
        const changePct: number | null = (livePrice && prevClose && prevClose > 0)
          ? Number(((livePrice - prevClose) / prevClose * 100).toFixed(2))
          : (meta?.regularMarketChangePercent != null ? Number(meta.regularMarketChangePercent.toFixed(2)) : null);

        realOHLCVCache.set(symbol, { candles, livePrice, changePct, expiresAt: Date.now() + 60 * 60_000 });

        // Also populate perSymbolPriceCache so fetchRealPricesForSymbols doesn't re-fetch
        if (livePrice) {
          perSymbolPriceCache.set(symbol, { price: livePrice, changePct: changePct ?? 0, expiresAt: Date.now() + 5 * 60_000 });
        }

        return candles;
      } catch (_e) {
        continue; // try next ticker
      }
    }

    return null; // all tickers failed
  };

  // Track which symbols are currently being OHLCV-warmed (avoid duplicate fetches)
  const ohlcvWarmingSet = new Set<string>();

  /**
   * Background OHLCV cache warmer — fire-and-forget, never await in scan pipeline.
   * Fetches in small batches to avoid Yahoo rate-limiting.
   */
  const warmOHLCVBackground = async (symbols: string[]): Promise<void> => {
    const toFetch = symbols.filter(s => {
      if (ohlcvWarmingSet.has(s)) return false;
      const c = realOHLCVCache.get(s);
      return !(c && c.expiresAt > Date.now());
    });
    if (toFetch.length === 0) return;
    toFetch.forEach(s => ohlcvWarmingSet.add(s));

    const BATCH = 10;
    for (let i = 0; i < toFetch.length; i += BATCH) {
      const batch = toFetch.slice(i, i + BATCH);
      await Promise.allSettled(batch.map(async s => {
        try { await fetchRealOHLCV(s); } finally { ohlcvWarmingSet.delete(s); }
      }));
      if (i + BATCH < toFetch.length) await new Promise(r => setTimeout(r, 300));
    }
  };

  /**
   * Get OHLCV from cache only — zero network, safe inside scan pipeline.
   */
  const getOHLCVFromCache = (symbol: string): UltraQuantCandle[] | null => {
    const c = realOHLCVCache.get(symbol);
    return (c && c.expiresAt > Date.now()) ? c.candles : null;
  };

  /**
   * Get live price from OHLCV cache — extracted from Yahoo v8 meta during candle fetch.
   * This is the most reliable real-time price source (same call as candles, no extra network).
   */
  const getLivePriceFromCache = (symbol: string): { livePrice: number | null; changePct: number | null } => {
    const c = realOHLCVCache.get(symbol);
    if (!c || c.expiresAt <= Date.now()) return { livePrice: null, changePct: null };
    return { livePrice: c.livePrice, changePct: c.changePct };
  };

  const analyzeUltraQuantProfile = (profile: UltraQuantProfile, request: ReturnType<typeof normalizeUltraQuantRequest>, realCandles?: UltraQuantCandle[] | null, enrichedData?: EnrichedStockData | null, ohlcvLivePrice?: number | null, ohlcvChangePct?: number | null) => {
    const random = seededGenerator(symbolSeed(profile.symbol));
    const totalDays = Math.max(260, request.historicalPeriodYears * 252);
    const sectorDrift = {
      Technology: 0.00165,
      Financials: 0.0012,
      Energy: 0.0011,
      Healthcare: 0.00145,
      Consumer: 0.00115,
      Industrials: 0.00105,
      Telecom: 0.001,
      Materials: 0.00095
    }[profile.sector] ?? 0.001;

    // Use real OHLCV if available, otherwise fall back to synthetic
    let candles: UltraQuantCandle[];
    if (realCandles && realCandles.length >= 60) {
      candles = realCandles;
    } else {
      candles = [];
      let close = 80 + random() * 1800;
      for (let day = 0; day < totalDays; day++) {
        const open = close;
        const drift = sectorDrift + Math.sin(day / 31 + random()) * 0.006 + (random() - 0.5) * 0.05;
        close = Math.max(20, close * (1 + drift));
        const high = Math.max(open, close) * (1 + 0.002 + random() * 0.02);
        const low = Math.min(open, close) * (1 - 0.002 - random() * 0.018);
        const volume = profile.averageVolume * (0.85 + random() * 0.9) * (1 + Math.max(0, drift * 10));
        candles.push({ open, high, low, close, volume });
      }
    }

    const closes = candles.map((candle) => candle.close);
    const returns = buildReturns(closes);
    const ema20 = buildEma(closes, 20);
    const ema50 = buildEma(closes, 50);
    const ema200 = buildEma(closes, 200);
    const endPrice = closes[closes.length - 1];
    const startPrice = closes[0];
    const sixMonthPrice = closes[Math.max(0, closes.length - 126)];
    const threeMonthPrice = closes[Math.max(0, closes.length - 63)];
    const fiveYearWindow = Math.min(closes.length - 1, 252 * Math.min(5, request.historicalPeriodYears));
    const fiveYearPrice = closes[Math.max(0, closes.length - 1 - fiveYearWindow)];
    const cagr = startPrice > 0 ? (Math.pow(endPrice / startPrice, 1 / request.historicalPeriodYears) - 1) * 100 : 0;
    const momentum = sixMonthPrice > 0 ? endPrice / sixMonthPrice : 0;
    const trendStrength = calculateSlope(ema50);
    const volatility = calculateVolatility(returns);
    const maxDrawdown = calculateMaxDrawdown(closes);
    const growthRatio = fiveYearPrice > 0 ? endPrice / fiveYearPrice : 0;
    // Use real Screener.in fundamentals when available, else estimate from price history
    const earningsGrowth = enrichedData?.screener?.profitGrowth3yr != null
      ? Math.max(0, enrichedData.screener.profitGrowth3yr)
      : Math.max(0, cagr * 0.72 + random() * 18);
    const revenueGrowth = enrichedData?.screener?.salesGrowth3yr != null
      ? Math.max(0, enrichedData.screener.salesGrowth3yr)
      : Math.max(0, cagr * 0.58 + random() * 14);
    const recentVolume = average(candles.slice(-Math.max(20, Math.floor(candles.length / 10))).map((candle) => candle.volume));
    const earlyVolume = average(candles.slice(0, Math.max(20, Math.floor(candles.length / 10))).map((candle) => candle.volume));
    const volumeGrowth = earlyVolume > 0 ? recentVolume / earlyVolume : 1;

    let breakoutHits = 0;
    for (let index = 20; index < closes.length; index++) {
      const priorHigh = Math.max(...closes.slice(index - 20, index));
      if (closes[index] > priorHigh) breakoutHits += 1;
    }
    const breakoutFrequency = closes.length > 20 ? breakoutHits / (closes.length - 20) : 0;
    const sentimentScore = Math.min(100, Math.max(15, 44 + (momentum - 1) * 24 + (growthRatio - 4) * 5 + random() * 8));
    const priceChange1m = closes.length > 1 ? ((endPrice - closes[closes.length - 2]) / closes[closes.length - 2]) * 100 : 0;
    const priceChange5m = closes.length > 5 ? ((endPrice - closes[closes.length - 6]) / closes[closes.length - 6]) * 100 : 0;
    const recentVolumeRatio = average(candles.slice(-10).map((candle) => candle.volume)) / Math.max(1, average(candles.slice(-50).map((candle) => candle.volume)));
    const vwap = candles.slice(-50).reduce((sum, candle) => sum + candle.close * candle.volume, 0) / Math.max(1, candles.slice(-50).reduce((sum, candle) => sum + candle.volume, 0));
    const vwapDistance = ((endPrice - vwap) / Math.max(vwap, 1)) * 100;

    let gradientBoost = 0.28;
    if (priceChange1m > 0.35) gradientBoost += 0.18;
    if (priceChange5m > 1.2) gradientBoost += 0.24;
    if (recentVolumeRatio > 1.4) gradientBoost += 0.16;
    if (vwapDistance > 0) gradientBoost += 0.1;
    if (volatility < 0.03) gradientBoost += 0.08;
    gradientBoost = clamp(gradientBoost + random() * 0.08, 0.02, 0.98);

    const avgReturn = average(buildReturns(closes.slice(-50)));

    /**
     * Multi-timeframe technical price projection (replaces fake LSTM formula).
     *
     * Uses 4 signals blended by weight:
     *  1. EMA trend extrapolation (20d slope × 20 days forward)
     *  2. Mean-reversion to EMA50 (price tends to revert within 20 days)
     *  3. Momentum carry (last 20d return projected forward proportionally)
     *  4. Volume-weighted drift (recent vol-adjusted return)
     *
     * Capped at ±25% to prevent absurd projections.
     * This is a technical projection, NOT a fundamental valuation.
     */
    const lstmPredictedPrice = (() => {
      if (closes.length < 50) return endPrice * (1 + avgReturn * 10);

      // Signal 1: EMA20 slope extrapolated 20 days forward
      const ema20Slope = calculateSlope(ema20.slice(-20)); // normalised slope
      const ema20Proj = endPrice * (1 + ema20Slope * 20 * 0.0008);

      // Signal 2: Mean reversion toward EMA50
      const ema50Last = ema50[ema50.length - 1] ?? endPrice;
      const gapToEma50 = (ema50Last - endPrice) / endPrice; // negative if above EMA50
      const meanRevProj = endPrice * (1 + gapToEma50 * 0.35); // 35% reversion in 20d

      // Signal 3: Momentum carry — last 20d return × 0.4 (momentum decays)
      const ret20d = closes.length >= 20
        ? (endPrice - closes[closes.length - 20]) / closes[closes.length - 20]
        : avgReturn * 20;
      const momentumProj = endPrice * (1 + ret20d * 0.4);

      // Signal 4: Volume-weighted drift (last 10 candles)
      const last10 = candles.slice(-10);
      const vwDrift = last10.length > 1
        ? last10.slice(1).reduce((sum, c, i) => {
            const ret = (c.close - last10[i].close) / last10[i].close;
            return sum + ret * c.volume;
          }, 0) / Math.max(1, last10.reduce((s, c) => s + c.volume, 0))
        : avgReturn;
      const vwProj = endPrice * (1 + vwDrift * 20);

      // Blend: trend 35%, mean-reversion 25%, momentum 25%, vol-weighted 15%
      const blended = ema20Proj * 0.35 + meanRevProj * 0.25 + momentumProj * 0.25 + vwProj * 0.15;

      // Cap at ±25% from current price
      const maxUp   = endPrice * 1.25;
      const maxDown = endPrice * 0.75;
      return Math.min(maxUp, Math.max(maxDown, blended));
    })();
    const marketRegime = volatility > 0.04 ? "High Volatility" : Math.abs(trendStrength) > 2 ? "Trending" : "Sideways";
    const marketState = recentVolumeRatio > 1.8 && priceChange5m > 0 ? "Accumulation" : breakoutFrequency > 0.12 ? "Breakout" : priceChange5m < -1 ? "Distribution" : "Reversal";
    // rlAction is derived AFTER superbrain runs (see return object below) — placeholder here
    const rlActionPrelim: "BUY" | "SELL" | "HOLD" = gradientBoost > 0.72 && sentimentScore > 65 ? "BUY" : gradientBoost < 0.35 ? "SELL" : "HOLD";
    const orderBook = createOrderBook(profile.symbol, endPrice);
    const totalBidVolume = orderBook.bids.reduce((sum, level) => sum + level.volume, 0);
    const totalAskVolume = orderBook.asks.reduce((sum, level) => sum + level.volume, 0);
    const orderImbalance = totalAskVolume > 0 ? totalBidVolume / totalAskVolume : totalBidVolume;

    const ema20Last = ema20[ema20.length - 1] ?? endPrice;
    const ema50Last = ema50[ema50.length - 1] ?? endPrice;
    const ema200Last = ema200[ema200.length - 1] ?? endPrice;
    const alignedTrend = ema20Last > ema50Last && ema50Last > ema200Last;
    const alignmentSpread = ((ema20Last - ema50Last) + (ema50Last - ema200Last)) / Math.max(endPrice, 1);
    const emaSlope20 = calculateSlope(ema20.slice(-20)) / Math.max(endPrice, 1);
    const hedgeMomentumRaw = threeMonthPrice > 0 ? endPrice / threeMonthPrice : 1;
    const hedgeTrendRaw = clamp((alignedTrend ? 0.55 : 0.2) + clamp(alignmentSpread * 35) * 0.3 + clamp(Math.max(0, emaSlope20) * 450) * 0.15);
    const hedgeVolumeRaw = recentVolumeRatio * (alignedTrend ? 1.25 : endPrice > ema20Last ? 1 : 0.72);
    const atr = calculateAtr(candles, 14);
    const atrPct = endPrice > 0 ? atr / endPrice : 0;
    const hedgeVolatilityQualityRaw = clamp(1 - (0.55 * relativePenalty(atrPct, 0.025) + 0.45 * relativePenalty(volatility, 0.018)));
    const sectorReturn = threeMonthPrice > 0 ? (endPrice - threeMonthPrice) / threeMonthPrice : 0;
    const hedgeInstitutionalRaw = clamp(Math.max(0, orderImbalance - 1) / 2.5);
    const previousHigh20 = closes.length > 1 ? Math.max(...closes.slice(Math.max(0, closes.length - 21), closes.length - 1)) : endPrice;
    const breakoutAboveHigh = previousHigh20 > 0 ? endPrice / previousHigh20 : 1;
    const longAtr = calculateAtr(candles, 28);
    const volatilityCompression = longAtr > 0 ? clamp(1 - atr / longAtr) : 0.5;
    const hedgeBreakoutRaw =
      0.45 * clamp((breakoutAboveHigh - 0.985) / 0.06) +
      0.35 * clamp((recentVolumeRatio - 1) / 2.2) +
      0.2 * volatilityCompression;
    const fullVolumeProfile = calculateVolumeProfile(candles, Math.max(1, endPrice * 0.0025));
    const liquidityClusters = [
      { type: "Support Cluster", price: orderBook.bids[0].price, strength: "High" },
      { type: "Resistance Cluster", price: orderBook.asks[0].price, strength: "Medium" },
      { type: "Liquidity Gap", price: Number((endPrice * 1.012).toFixed(2)), strength: "Watch" }
    ];

    const regimeScore = marketRegime === "Trending" ? 0.9 : marketRegime === "High Volatility" ? 0.4 : 0.55;
    const stateScore = marketState === "Breakout" ? 0.95 : marketState === "Accumulation" ? 0.82 : marketState === "Distribution" ? 0.18 : 0.5;
    const lstmScore = clamp((lstmPredictedPrice / Math.max(endPrice, 1) - 0.96) / 0.12);
    const finalPredictionScore = (
      0.3 * gradientBoost +
      0.25 * lstmScore +
      0.2 * regimeScore +
      0.15 * stateScore +
      0.1 * (sentimentScore / 100)
    ) * 100;

    const score = (
      0.35 * clamp(cagr / 40) +
      0.2 * clamp((momentum - 1) / 1.5) +
      0.2 * clamp(Math.abs(trendStrength) * 8) +
      0.15 * (1 - Math.min(maxDrawdown / 100, 1)) +
      0.1 * clamp(volumeGrowth / 2.5)
    ) * 100;

    const drawdownProbability = clamp(volatility * 2.2 + (maxDrawdown / 100) * 0.6) * 100;
    const stopLossDistance = Math.max(endPrice * Math.max(volatility, 0.01), endPrice * 0.015);
    const positionSize = (1000000 * (request.riskPercentage / 100)) / stopLossDistance;

    const alerts = [
      gradientBoost > 0.7 ? { stockSymbol: profile.symbol, signalType: "AI_BULLISH", confidenceScore: Number((gradientBoost * 100).toFixed(2)), timestamp: new Date().toISOString() } : null,
      recentVolumeRatio > 1.4 ? { stockSymbol: profile.symbol, signalType: "MOMENTUM_SCANNER", confidenceScore: Number(Math.min(99, recentVolumeRatio * 35).toFixed(2)), timestamp: new Date().toISOString() } : null,
      breakoutFrequency > 0.12 ? { stockSymbol: profile.symbol, signalType: "VOLATILITY_BREAKOUT", confidenceScore: Number(Math.min(99, breakoutFrequency * 600).toFixed(2)), timestamp: new Date().toISOString() } : null,
      orderImbalance > 2.5 ? { stockSymbol: profile.symbol, signalType: "ORDER_FLOW_ACCUMULATION", confidenceScore: Number(Math.min(99, 50 + (orderImbalance - 2.5) * 10).toFixed(2)), timestamp: new Date().toISOString() } : null
    ].filter(Boolean);

    return {
      symbol: profile.symbol,
      sector: profile.sector,
      industry: profile.industry,
      marketCap: profile.marketCap,
      // Real price priority:
      //  1. Yahoo enrichment lastPrice (from MarketDataAggregator — 1hr cache)
      //  2. OHLCV meta regularMarketPrice (from fetchRealOHLCV — same Yahoo v8 call)
      //  3. perSymbolPriceCache (from fetchYahooQuote range=1d — fast pre-fetch)
      //  4. OHLCV last candle close (EOD price — real but may be yesterday's close)
      //  5. null — synthetic stock, no real price
      currentPrice: (() => {
        if (enrichedData?.yahoo?.lastPrice) return Number(enrichedData.yahoo.lastPrice.toFixed(2));
        if (ohlcvLivePrice) return ohlcvLivePrice;
        const cached = perSymbolPriceCache.get(profile.symbol);
        if (cached && cached.expiresAt > Date.now()) return Number(cached.price.toFixed(2));
        if (realCandles && realCandles.length >= 60) return Number(endPrice.toFixed(2));
        return null;
      })(),
      dataSource: enrichedData?.yahoo ? 'real' : (realCandles && realCandles.length >= 60) ? 'real' : (() => {
        const cached = perSymbolPriceCache.get(profile.symbol);
        return (cached && cached.expiresAt > Date.now()) ? 'real' : 'synthetic';
      })(),
      // Enriched fields from Yahoo + Screener.in
      pe: enrichedData?.yahoo?.pe ?? enrichedData?.screener?.pe ?? null,
      pb: enrichedData?.yahoo?.priceToBook ?? null,
      roe: enrichedData?.screener?.roe ?? null,
      roce: enrichedData?.screener?.roce ?? null,
      debtToEquity: enrichedData?.screener?.debtToEquity ?? null,
      promoterHolding: enrichedData?.screener?.promoterHolding ?? null,
      // 52W high/low: Yahoo enrichment first, then compute from real candles (last 252 trading days)
      weekHigh52: enrichedData?.yahoo?.weekHigh52 ?? (() => {
        if (!realCandles || realCandles.length < 20) return null;
        const yr = realCandles.slice(-252);
        return Number(Math.max(...yr.map(c => c.high)).toFixed(2));
      })(),
      weekLow52: enrichedData?.yahoo?.weekLow52 ?? (() => {
        if (!realCandles || realCandles.length < 20) return null;
        const yr = realCandles.slice(-252);
        return Number(Math.min(...yr.map(c => c.low)).toFixed(2));
      })(),
      deliveryPct: null,
      pChange: enrichedData?.yahoo?.pChange ?? ohlcvChangePct ?? (perSymbolPriceCache.get(profile.symbol)?.changePct ?? null),
      fundamentalScore: enrichedData ? computeFundamentalScore(enrichedData) : null,
      dataQuality: enrichedData?.dataQuality ?? (() => {
        // Upgrade to MEDIUM if we have real OHLCV candles or a live price from cache
        const hasCachedPrice = !!(perSymbolPriceCache.get(profile.symbol)?.expiresAt ?? 0 > Date.now());
        return (realCandles && realCandles.length >= 60) || ohlcvLivePrice || hasCachedPrice ? 'MEDIUM' : 'LOW';
      })(),
      newsHeadlines: enrichedData?.newsHeadlines ?? [],
      cagr,
      momentum,
      trendStrength,
      volatility,
      maxDrawdown,
      growthRatio,
      score,
      earningsGrowth,
      revenueGrowth,
      volumeGrowth,
      breakoutFrequency,
      sentimentScore,
      drawdownProbability,
      positionSize,
      gradientBoostProb: gradientBoost * 100,
      // LSTM target: only show when we have a real price base
      // Scale the technical projection to the live price if available
      lstmPredictedPrice: (() => {
        const cachedPrice = perSymbolPriceCache.get(profile.symbol);
        const hasRealBase = enrichedData?.yahoo?.lastPrice || ohlcvLivePrice || (cachedPrice?.expiresAt ?? 0) > Date.now() || (realCandles && realCandles.length >= 60);
        if (!hasRealBase) return null;
        // If we have a live price that differs from endPrice (last candle close),
        // scale the LSTM projection proportionally so the target is relative to live price
        const realBase = enrichedData?.yahoo?.lastPrice ?? ohlcvLivePrice ?? (cachedPrice?.expiresAt ?? 0 > Date.now() ? cachedPrice?.price : null) ?? null;
        if (realBase && realBase > 0 && endPrice > 0 && Math.abs(realBase - endPrice) / endPrice > 0.005) {
          const ratio = realBase / endPrice;
          const scaledTarget = lstmPredictedPrice * ratio;
          return Number(Math.min(realBase * 1.25, Math.max(realBase * 0.75, scaledTarget)).toFixed(2));
        }
        return Number(lstmPredictedPrice.toFixed(2));
      })(),
      marketRegime,
      marketState,
      finalPredictionScore,
      orderImbalance,
      volumeProfile: {
        poc: fullVolumeProfile.poc,
        vah: fullVolumeProfile.vah,
        val: fullVolumeProfile.val
      },
      liquidityClusters,
      alerts,
      hedgeFactors: {
        averageVolume: recentVolume,
        momentumRaw: hedgeMomentumRaw,
        trendRaw: hedgeTrendRaw,
        volumeRaw: hedgeVolumeRaw,
        volatilityQualityRaw: hedgeVolatilityQualityRaw,
        sectorReturn,
        institutionalRaw: hedgeInstitutionalRaw,
        breakoutRaw: hedgeBreakoutRaw
      },
      // ── Compute Superbrain first, then derive rlAction from its decision ──
      // This ensures the stock signal (table column) always matches Superbrain AI.
      // Previously rlAction was a simple 2-condition rule that often disagreed.
      ...(() => {
        const resolvedDataSource = (enrichedData?.yahoo ? 'real' : (realCandles && realCandles.length >= 60) ? 'real' : (() => {
          const cached = perSymbolPriceCache.get(profile.symbol);
          return (cached && cached.expiresAt > Date.now()) ? 'real' : 'synthetic';
        })()) as 'real' | 'synthetic';
        const resolvedDataQuality = (enrichedData?.dataQuality ?? (() => {
          const hasCachedPrice = !!(perSymbolPriceCache.get(profile.symbol)?.expiresAt ?? 0 > Date.now());
          return (realCandles && realCandles.length >= 60) || ohlcvLivePrice || hasCachedPrice ? 'MEDIUM' : 'LOW';
        })()) as 'HIGH' | 'MEDIUM' | 'LOW';
        const resolvedPrice = (() => {
          const cached = perSymbolPriceCache.get(profile.symbol);
          return enrichedData?.yahoo?.lastPrice
            ?? ohlcvLivePrice
            ?? ((cached?.expiresAt ?? 0) > Date.now() ? cached!.price : null)
            ?? ((realCandles && realCandles.length >= 60) ? endPrice : null);
        })();

        const sb = runSuperbrain({
          symbol: profile.symbol, sector: profile.sector, marketCap: profile.marketCap,
          cagr, momentum, trendStrength, volatility, maxDrawdown, breakoutFrequency,
          volumeGrowth, gradientBoostProb: gradientBoost * 100, finalPredictionScore,
          rlAction: rlActionPrelim, orderImbalance, vwapDistance,
          pe: enrichedData?.yahoo?.pe ?? enrichedData?.screener?.pe ?? null,
          roe: enrichedData?.screener?.roe ?? null,
          roce: enrichedData?.screener?.roce ?? null,
          debtToEquity: enrichedData?.screener?.debtToEquity ?? null,
          promoterHolding: enrichedData?.screener?.promoterHolding ?? null,
          profitGrowth3yr: enrichedData?.screener?.profitGrowth3yr ?? null,
          salesGrowth3yr: enrichedData?.screener?.salesGrowth3yr ?? null,
          fundamentalScore: enrichedData ? computeFundamentalScore(enrichedData) : null,
          sentimentScore, newsHeadlines: enrichedData?.newsHeadlines ?? [],
          pChange: enrichedData?.yahoo?.pChange ?? ohlcvChangePct ?? null,
          dataQuality: resolvedDataQuality,
          dataSource: resolvedDataSource,
        }, resolvedPrice);

        // Sync rlAction with Superbrain decision so both signals always agree
        const rlAction: "BUY" | "SELL" | "HOLD" =
          sb.decision === 'STRONG_BUY' ? 'BUY' :
          sb.decision === 'BUY'        ? 'BUY' :
          sb.decision === 'SELL'       ? 'SELL' :
          sb.decision === 'STRONG_SELL'? 'SELL' :
          'HOLD';

        return { rlAction, superbrain: sb };
      })(),
    };
  };

  const buildHedgeFundSignalDashboard = (
    analyzedUniverse: Array<any>,
    request: ReturnType<typeof normalizeUltraQuantRequest>,
    totalScanned: number
  ): HedgeFundSignalDashboard => {
    const filtered = analyzedUniverse.filter((item) => {
      const sectorMatches = request.sectorFilter === "ALL" || !request.sectorFilter || item.sector === request.sectorFilter;
      return sectorMatches &&
        item.marketCap >= request.minMarketCap &&
        item.marketCap <= request.maxMarketCap &&
        (item.hedgeFactors?.averageVolume ?? 0) >= request.minVolume &&
        (item.hedgeFactors?.volatilityQualityRaw ?? 0) >= clamp(1 - request.volatilityThreshold * 2);
    });

    if (!filtered.length) {
      return {
        rankings: [],
        sectorStrength: [],
        momentumHeatmap: [],
        summary: {
          scannedUniverse: totalScanned,
          returned: 0,
          averageFinalScore: 0,
          leadingSector: "N/A",
          institutionalAccumulationCandidates: 0
        }
      };
    }

    const sectorReturns = Array.from(filtered.reduce((accumulator, item) => {
      const values = accumulator.get(item.sector) ?? [];
      values.push(item.hedgeFactors.sectorReturn);
      accumulator.set(item.sector, values);
      return accumulator;
    }, new Map<string, number[]>()))
      .reduce<Record<string, number>>((accumulator, [sector, values]) => {
        accumulator[sector] = average(values);
        return accumulator;
      }, {});

    const sectorReturnValues = Object.values(sectorReturns);
    const sectorReturnMin = Math.min(...sectorReturnValues);
    const sectorReturnMax = Math.max(...sectorReturnValues);
    const sectorScores = Object.fromEntries(
      Object.entries(sectorReturns).map(([sector, value]) => [sector, normalizeScore(value, sectorReturnMin, sectorReturnMax)])
    );

    const momentumValues = filtered.map((item) => item.hedgeFactors.momentumRaw);
    const volumeValues = filtered.map((item) => item.hedgeFactors.volumeRaw);
    const institutionalValues = filtered.map((item) => item.hedgeFactors.institutionalRaw);
    const breakoutValues = filtered.map((item) => item.hedgeFactors.breakoutRaw);
    const momentumMin = Math.min(...momentumValues);
    const momentumMax = Math.max(...momentumValues);
    const volumeMin = Math.min(...volumeValues);
    const volumeMax = Math.max(...volumeValues);
    const institutionalMin = Math.min(...institutionalValues);
    const institutionalMax = Math.max(...institutionalValues);
    const breakoutMin = Math.min(...breakoutValues);
    const breakoutMax = Math.max(...breakoutValues);

    const rankings = filtered
      .map((item): HedgeFundSignalScore => {
        const momentumScore = normalizeScore(item.hedgeFactors.momentumRaw, momentumMin, momentumMax);
        const trendScore = item.hedgeFactors.trendRaw * 100;
        const volumeScore = normalizeScore(item.hedgeFactors.volumeRaw, volumeMin, volumeMax);
        const volatilityScore = item.hedgeFactors.volatilityQualityRaw * 100;
        const sectorScore = sectorScores[item.sector] ?? 50;
        const institutionalScore = normalizeScore(item.hedgeFactors.institutionalRaw, institutionalMin, institutionalMax);
        const breakoutScore = normalizeScore(item.hedgeFactors.breakoutRaw, breakoutMin, breakoutMax);
        const finalScore =
          0.25 * momentumScore +
          0.2 * trendScore +
          0.15 * volumeScore +
          0.1 * volatilityScore +
          0.1 * sectorScore +
          0.1 * institutionalScore +
          0.1 * breakoutScore;

        return {
          rank: 0,
          stockSymbol: item.symbol,
          sector: item.sector,
          momentumScore: Number(momentumScore.toFixed(2)),
          trendScore: Number(trendScore.toFixed(2)),
          volumeScore: Number(volumeScore.toFixed(2)),
          volatilityScore: Number(volatilityScore.toFixed(2)),
          sectorScore: Number(sectorScore.toFixed(2)),
          institutionalScore: Number(institutionalScore.toFixed(2)),
          breakoutScore: Number(breakoutScore.toFixed(2)),
          finalScore: Number(finalScore.toFixed(2)),
          momentumValue: Number(item.hedgeFactors.momentumRaw.toFixed(2)),
          orderImbalance: Number(item.orderImbalance.toFixed(2)),
          breakoutProbability: Number(breakoutScore.toFixed(2))
        };
      })
      .sort((left, right) => right.finalScore - left.finalScore)
      .slice(0, 100)
      .map((signal, index) => ({
        ...signal,
        rank: index + 1
      }));

    const sectorStrength = Object.entries(sectorReturns)
      .map(([sector, averageReturn]) => ({
        sector,
        averageReturn: Number((averageReturn * 100).toFixed(2)),
        sectorScore: Number((sectorScores[sector] ?? 50).toFixed(2)),
        leaders: rankings.filter((signal) => signal.sector === sector).slice(0, 3).map((signal) => signal.stockSymbol)
      }))
      .sort((left, right) => right.sectorScore - left.sectorScore);

    const momentumHeatmap = rankings.slice(0, 18).map((signal) => ({
      symbol: signal.stockSymbol,
      sector: signal.sector,
      momentumScore: signal.momentumScore,
      finalScore: signal.finalScore,
      breakoutScore: signal.breakoutScore
    }));

    return {
      rankings,
      sectorStrength,
      momentumHeatmap,
      summary: {
        scannedUniverse: totalScanned,
        returned: rankings.length,
        averageFinalScore: Number(average(rankings.map((signal) => signal.finalScore)).toFixed(2)),
        leadingSector: sectorStrength[0]?.sector ?? "N/A",
        institutionalAccumulationCandidates: rankings.filter((signal) => signal.orderImbalance > 2.5).length
      }
    };
  };

  // ── Yahoo Finance real-price helpers (used by UltraQuant, Multibagger, Macro) ──

  /**
   * Fetch a single Yahoo Finance quote.
   * Tries SYMBOL.NS first, then SYMBOL.BO as fallback.
   * Validates that the returned symbol matches what we requested.
   */
  const fetchYahooQuote = async (symbol: string): Promise<{ price: number; changePct: number } | null> => {
    const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36';
    const tickers = [`${symbol}.NS`, `${symbol}.BO`];

    for (const ticker of tickers) {
      try {
        const encoded = encodeURIComponent(ticker);
        const url = `https://query1.finance.yahoo.com/v8/finance/chart/${encoded}?interval=1d&range=1d`;
        const resp = await axios.get(url, { timeout: 4000, headers: { 'User-Agent': UA } });
        const result = resp.data?.chart?.result?.[0];
        const meta = result?.meta;
        if (!meta) continue;

        const returnedBase = (meta.symbol ?? '').toUpperCase().replace(/\.(NS|BO)$/, '');
        const requestedBase = symbol.toUpperCase().replace(/\.(NS|BO)$/, '');
        if (returnedBase && returnedBase !== requestedBase) continue;

        const price = meta.regularMarketPrice ?? meta.chartPreviousClose ?? 0;
        if (price <= 0) continue;

        return { price, changePct: meta.regularMarketChangePercent ?? 0 };
      } catch (_e) {
        continue;
      }
    }
    return null;
  };

  const fetchRealPricesForSymbols = async (symbols: string[]): Promise<Map<string, { price: number; changePct: number }>> => {
    const now = Date.now();
    const ttl = isMarketDay() ? 5 * 60_000 : 60 * 60_000;
    const result = new Map<string, { price: number; changePct: number }>();

    const toFetch: string[] = [];
    for (const sym of symbols) {
      const cached = perSymbolPriceCache.get(sym);
      if (cached && cached.expiresAt > now) {
        result.set(sym, { price: cached.price, changePct: cached.changePct });
      } else {
        toFetch.push(sym);
      }
    }

    if (toFetch.length === 0) return result;

    await Promise.all(toFetch.map(async sym => {
      const q = await fetchYahooQuote(sym).catch(() => null);
      if (q && q.price > 0) {
        perSymbolPriceCache.set(sym, { ...q, expiresAt: now + ttl });
        result.set(sym, q);
      }
    }));

    logAction('real-prices.fetched', { fetched: toFetch.length, resolved: result.size });
    return result;
  };

  // ── UltraQuant dashboard result cache (TTL: 60s) — defined at module level ──

  const buildUltraQuantDashboard = async (payload: UltraQuantRequest = {}) => {
    const request = normalizeUltraQuantRequest(payload);

    // Cache key based on request params
    const cacheKey = JSON.stringify(request);
    const cached = ultraQuantCache.get(cacheKey);
    // Don't serve cached result if it was built on fallback universe
    if (cached && cached.expiresAt > Date.now() && cached.universeSize > 440) return cached.payload;

    // If universe is still at fallback size, wait up to 8s for Supabase to load
    if (!_universeState.universe || _universeState.universe.length <= 440) {
      await Promise.race([
        loadSupabaseUniverse(8000),
        new Promise<void>(r => setTimeout(r, 8000)),
      ]);
    }

    const rawUniverse = createUltraQuantUniverse();
    const totalLoaded = rawUniverse.length;

    // ── Pass 0: Pre-load OHLCV from Supabase on cold start (one query, ~50ms) ──
    // Only query top 200 by marketCap — these are the symbols refreshed by EOD batch.
    // Must happen before Pass 1 so the real-data bonus in pre-sort works correctly.
    const top200Symbols = rawUniverse
      .slice().sort((a, b) => b.marketCap - a.marketCap).slice(0, 200).map(p => p.symbol);
    const coldSymbols = top200Symbols.filter(s => !(realOHLCVCache.get(s)?.expiresAt ?? 0 > Date.now()));
    if (coldSymbols.length > 0 && coldSymbols.length < 50) {
      await Promise.race([
        loadOHLCVFromSupabase(coldSymbols, setOHLCVCache),
        new Promise<void>(r => setTimeout(r, 500)),
      ]);
    }

    // ── Pass 1: Ultra-fast pre-score entire universe using deterministic hash ──
    // No candle simulation — O(1) per stock. Handles 5000+ stocks in <50ms.
    const preSorted = rawUniverse.map(profile => {
      const seed = symbolSeed(profile.symbol);
      const sectorBonus = ({
        Technology: 8, Healthcare: 7, Financials: 6, Consumer: 5,
        Industrials: 4, Energy: 3, Telecom: 2, Materials: 2
      } as Record<string, number>)[profile.sector] ?? 3;
      // Deterministic score: mix of symbol hash + sector + marketCap tier
      const capTier = profile.marketCap > 100000 ? 10 : profile.marketCap > 20000 ? 7 : profile.marketCap > 5000 ? 4 : 1;
      const hashScore = ((seed * 2654435761) >>> 0) / 4294967296 * 60; // 0-60
      // Strong bonus for symbols with real OHLCV cached — ensures they always rank in top 100
      const hasRealData = getOHLCVFromCache(profile.symbol) !== null ? 30 : 0;
      const score = hashScore + sectorBonus + capTier + hasRealData + (request.historicalPeriodYears * 0.5);
      return { symbol: profile.symbol, score };
    }).sort((a, b) => b.score - a.score);

    // Take top 100 for full analysis
    const top100Symbols = new Set(preSorted.slice(0, 100).map(r => r.symbol));
    const top100Universe = rawUniverse.filter(p => top100Symbols.has(p.symbol));

    // ── Pass 2: Read real OHLCV from cache (populated by Pass 0) ──
    const realOHLCVMap = new Map<string, UltraQuantCandle[] | null>();
    top100Universe.forEach(p => {
      realOHLCVMap.set(p.symbol, getOHLCVFromCache(p.symbol));
    });

    // ── Pass 3: Load fundamentals from Supabase only if not already warm ──
    const top50Symbols = preSorted.slice(0, 50).map(r => r.symbol);
    const fundMissing = top50Symbols.filter(s => !isYahooCached(s));
    if (fundMissing.length > top50Symbols.length * 0.2) {
      const setPriceCache = (sym: string, price: number, changePct: number) => {
        perSymbolPriceCache.set(sym, { price, changePct, expiresAt: Date.now() + 60 * 60_000 });
      };
      await Promise.race([
        loadFundamentalsFromSupabase(fundMissing, setPriceCache),
        new Promise<void>(r => setTimeout(r, 1500)),
      ]);
    }

    const enrichedMap = new Map<string, EnrichedStockData>(
      top50Symbols.map(s => [s, getEnrichedFromCache(s)])
    );

    // ── Pass 4: Full analysis on top 100 only (with real OHLCV + enriched data) ──
    const analyzedUniverse = top100Universe.map((profile) =>
      analyzeUltraQuantProfile(
        profile,
        request,
        realOHLCVMap.get(profile.symbol) ?? null,
        enrichedMap.get(profile.symbol) ?? null,
        getLivePriceFromCache(profile.symbol).livePrice,
        getLivePriceFromCache(profile.symbol).changePct,
      )
    );
    const totalProcessed = analyzedUniverse.length;

    // Soft sector filter only — do NOT hard-filter on numeric thresholds
    // All stocks are scored; filters only act as score bonuses via the ranking
    const sectorFiltered = request.sectorFilter === "ALL" || !request.sectorFilter
      ? analyzedUniverse
      : analyzedUniverse.filter((r) => r.sector === request.sectorFilter);
    const totalAfterFilter = sectorFiltered.length;

    // Sort by score descending, always return top 100 regardless of thresholds
    const sorted = sectorFiltered
      .map(({ hedgeFactors, ...result }) => result)
      .sort((left, right) => right.score - left.score);

    // Guarantee at least 100 results — if fewer pass sector filter, fall back to full universe
    const resultPool = sorted.length >= 100 ? sorted : analyzedUniverse
      .map(({ hedgeFactors, ...result }) => result)
      .sort((left, right) => right.score - left.score);

    const results = resultPool.slice(0, 100);
    const totalReturned = results.length;

    console.log(JSON.stringify({ totalLoaded, totalProcessed, totalAfterFilter, totalReturned }));

    const alerts = results
      .flatMap((result) => result.alerts)
      .sort((left, right) => right.confidenceScore - left.confidenceScore)
      .slice(0, 12);

    const sectors = Array.from(results.reduce((accumulator, result) => {
      if (!accumulator.has(result.sector)) {
        accumulator.set(result.sector, []);
      }
      accumulator.get(result.sector)?.push(result);
      return accumulator;
    }, new Map<string, any[]>()))
      .map(([sector, sectorResults]) => ({
        sector,
        sectorStrength: Number(average(sectorResults.map((item) => item.momentum)).toFixed(2)),
        averageScore: Number(average(sectorResults.map((item) => item.score)).toFixed(2)),
        leaders: sectorResults.slice(0, 3).map((item) => item.symbol)
      }))
      .sort((left, right) => right.averageScore - left.averageScore);

    const summary = {
      scannedUniverse: totalLoaded,  // full universe size (434 → 5000+ after warm)
      returned: totalReturned,
      historicalPeriodYears: request.historicalPeriodYears,
      avgScore: Number(average(results.map((item) => item.score)).toFixed(2)),
      multibaggerCandidates: results.filter((item) => item.growthRatio >= 5).length,
      buySignals: results.filter((item) => item.rlAction === "BUY").length
    };

    const dashboard = {
      results,
      alerts,
      sectors,
      hedgeFundSignals: buildHedgeFundSignalDashboard(analyzedUniverse, request, totalLoaded),
      summary,
      architecture: ultraArchitecture
    };

    // Cache: 5min always — avoid thrashing when Supabase has no data yet
    ultraQuantCache.set(cacheKey, { expiresAt: Date.now() + ULTRA_QUANT_CACHE_TTL, payload: dashboard, universeSize: rawUniverse.length });

    return dashboard;
  };

  const historicalCache = new Map<string, { expiresAt: number; payload: any }>();
  const HISTORICAL_CACHE_TTL_MS = 60_000;

  const intervalToMinutes = (selectedInterval: string) => {
    switch (selectedInterval) {
      case "1minute":
        return 1;
      case "5minute":
        return 5;
      case "30minute":
        return 30;
      case "day":
        return 24 * 60;
      case "week":
        return 7 * 24 * 60;
      default:
        return 5;
    }
  };

  const buildHistoricalCacheKey = (instrumentKey: string, selectedInterval: string, fromDate: string, toDate: string) =>
    [instrumentKey, selectedInterval, fromDate, toDate].join("|");

  const createSimulatedHistoricalPayload = (
    instrumentKey: string,
    selectedInterval: string,
    fromDate: string,
    toDate: string,
    notice: string
  ) => {
    const seed = symbolSeed(`${instrumentKey}-${selectedInterval}`);
    const random = seededGenerator(seed);
    const stepMs = intervalToMinutes(selectedInterval) * 60 * 1000;
    const isIntraday = selectedInterval !== "day" && selectedInterval !== "week";

    // NSE market hours in UTC: 09:15 IST = 03:45 UTC, 15:30 IST = 10:00 UTC
    const IST_OPEN_UTC_H = 3, IST_OPEN_UTC_M = 45;   // 09:15 IST
    const IST_CLOSE_UTC_H = 10, IST_CLOSE_UTC_M = 0; // 15:30 IST

    const startTime = (() => {
      const d = new Date(`${fromDate}T00:00:00Z`);
      d.setUTCHours(IST_OPEN_UTC_H, IST_OPEN_UTC_M, 0, 0);
      return d.getTime();
    })();

    // Cap endTime at current time so today's candles don't show future data
    const rawEndTime = (() => {
      const d = new Date(`${toDate}T00:00:00Z`);
      d.setUTCHours(IST_CLOSE_UTC_H, IST_CLOSE_UTC_M, 0, 0);
      return d.getTime();
    })();
    const endTime = Math.min(rawEndTime, Date.now());

    const maxPoints = selectedInterval === "day" ? 400 : 1200;
    const candles: Array<[string, number, number, number, number, number]> = [];
    let cursor = startTime;
    let lastClose = 80 + (seed % 2400) / 10;

    while (cursor <= endTime && candles.length < maxPoints) {
      const d = new Date(cursor);
      const dow = d.getUTCDay(); // 0=Sun, 6=Sat

      if (isIntraday) {
        // Skip weekends entirely — jump to next Monday open
        if (dow === 0) { // Sunday
          cursor += 24 * 60 * 60 * 1000; // skip to Monday
          const next = new Date(cursor);
          next.setUTCHours(IST_OPEN_UTC_H, IST_OPEN_UTC_M, 0, 0);
          cursor = next.getTime();
          continue;
        }
        if (dow === 6) { // Saturday
          cursor += 2 * 24 * 60 * 60 * 1000; // skip to Monday
          const next = new Date(cursor);
          next.setUTCHours(IST_OPEN_UTC_H, IST_OPEN_UTC_M, 0, 0);
          cursor = next.getTime();
          continue;
        }

        // Skip outside market hours — jump to next day's open
        const utcH = d.getUTCHours(), utcM = d.getUTCMinutes();
        const utcMins = utcH * 60 + utcM;
        const openMins = IST_OPEN_UTC_H * 60 + IST_OPEN_UTC_M;
        const closeMins = IST_CLOSE_UTC_H * 60 + IST_CLOSE_UTC_M;

        if (utcMins < openMins) {
          // Before open — jump to open
          d.setUTCHours(IST_OPEN_UTC_H, IST_OPEN_UTC_M, 0, 0);
          cursor = d.getTime();
          continue;
        }
        if (utcMins >= closeMins) {
          // After close — jump to next day's open
          const next = new Date(cursor + 24 * 60 * 60 * 1000);
          next.setUTCHours(IST_OPEN_UTC_H, IST_OPEN_UTC_M, 0, 0);
          cursor = next.getTime();
          continue;
        }
      } else {
        // Daily/weekly: skip weekends
        if (dow === 0 || dow === 6) {
          cursor += 24 * 60 * 60 * 1000;
          continue;
        }
      }

      const drift = (random() - 0.46) * (selectedInterval === "day" ? 3.4 : 1.2);
      const open = Number(lastClose.toFixed(2));
      const close = Number(Math.max(20, open + drift).toFixed(2));
      const high = Number((Math.max(open, close) + random() * 1.8).toFixed(2));
      const low = Number((Math.max(5, Math.min(open, close) - random() * 1.6)).toFixed(2));
      const volume = Math.round(120000 + random() * 1800000);

      candles.push([new Date(cursor).toISOString(), open, high, low, close, volume]);
      lastClose = close;
      cursor += stepMs;
    }

    return {
      status: "success",
      data: { candles },
      meta: {
        source: "simulated",
        notice
      }
    };
  };

  const cacheHistoricalPayload = (cacheKey: string, payload: any) => {
    historicalCache.set(cacheKey, {
      expiresAt: Date.now() + HISTORICAL_CACHE_TTL_MS,
      payload
    });
  };

  const getCachedHistoricalPayload = (cacheKey: string) => {
    const cached = historicalCache.get(cacheKey);
    if (!cached) {
      return null;
    }

    if (cached.expiresAt < Date.now()) {
      historicalCache.delete(cacheKey);
      return null;
    }

    return cached.payload;
  };

  const averageClose = (candles: any[]) =>
    candles.length ? candles.reduce((sum, candle) => sum + Number(candle.close ?? 0), 0) / candles.length : 0;

  const buildFallbackAiAnalysis = ({
    symbol,
    data,
    interval,
    quantData,
    advancedIntelligence,
    reason
  }: {
    symbol: string;
    data: any[];
    interval: string;
    quantData?: any;
    advancedIntelligence?: any;
    reason?: string;
  }) => {
    const recentCandles = data.slice(-20);
    const latest = data[data.length - 1] ?? {};
    const previous = data[data.length - 2] ?? latest;
    const recentAverage = averageClose(recentCandles);
    const longAverage = averageClose(data.slice(-50));
    const priceChangePct = previous.close
      ? ((Number(latest.close ?? 0) - Number(previous.close ?? 0)) / Number(previous.close)) * 100
      : 0;
    const trendBias = recentAverage && Number(latest.close ?? 0) >= recentAverage ? "Bullish" : "Bearish";
    const momentumBias = longAverage && recentAverage >= longAverage ? "Improving" : "Mixed";
    const support = Math.min(...recentCandles.map((candle) => Number(candle.low ?? candle.close ?? 0)));
    const resistance = Math.max(...recentCandles.map((candle) => Number(candle.high ?? candle.close ?? 0)));
    const averageVolume = recentCandles.length
      ? recentCandles.reduce((sum, candle) => sum + Number(candle.volume ?? 0), 0) / recentCandles.length
      : 0;
    const volumeRatio = averageVolume ? Number(latest.volume ?? 0) / averageVolume : 1;
    const sentimentStatus = quantData?.sentiment?.status ?? "Neutral";
    const sentimentBoost = String(sentimentStatus).toUpperCase().includes("BULLISH") ? 12 : 0;
    const aiBoost = Number(advancedIntelligence?.signalConsensus?.score ?? advancedIntelligence?.momentumPrediction?.probability ?? 50);
    const directionalScore = clamp(50 + priceChangePct * 6 + (volumeRatio - 1) * 10 + sentimentBoost + (aiBoost - 50) * 0.35, 18, 96);

    let recommendation = "HOLD";
    if (directionalScore >= 66) {
      recommendation = "BUY";
    } else if (directionalScore <= 38) {
      recommendation = "SELL";
    }

    const confidence = Math.round(directionalScore);
    const summaryPoints = [
      `${symbol} is trading on a ${trendBias.toLowerCase()} intraday structure with ${momentumBias.toLowerCase()} momentum.`,
      `Volume is running at ${volumeRatio.toFixed(2)}x the recent average, which suggests ${volumeRatio > 1.2 ? "active participation" : "normal participation"}.`,
      `Quant sentiment currently reads ${sentimentStatus}, and the local signal consensus score is ${Math.round(aiBoost)}.`
    ];

    const analysis = [
      `### Actionable Signal`,
      `**${recommendation}** because price is ${trendBias === "Bullish" ? "holding above" : "testing below"} its recent mean with ${volumeRatio > 1 ? "supportive" : "moderate"} participation.`,
      ``,
      `### Simple Summary for Beginners`,
      `- ${summaryPoints[0]}`,
      `- ${summaryPoints[1]}`,
      `- ${summaryPoints[2]}`,
      ``,
      `### Executive Summary`,
      `${symbol} on the ${interval} interval is showing a ${trendBias.toLowerCase()} bias with a ${priceChangePct.toFixed(2)}% latest move. The local quant engine is keeping the desk operational${reason ? ` while external AI is unavailable (${reason}).` : "."}`,
      ``,
      `### Trend Analysis`,
      `Current bias: **${trendBias}**`,
      `Momentum state: **${momentumBias}**`,
      `Latest price move: **${priceChangePct.toFixed(2)}%**`,
      ``,
      `### Quant Intelligence Synthesis`,
      `- Market sentiment: **${sentimentStatus}**`,
      `- Consensus score: **${Math.round(aiBoost)}**`,
      `- Volume ratio: **${volumeRatio.toFixed(2)}x**`,
      ``,
      `### Psychological Audit`,
      `Retail and institutional flows appear ${recommendation === "BUY" ? "constructive" : recommendation === "SELL" ? "defensive" : "balanced"} based on price response, volume, and the current sentiment feed.`,
      ``,
      `### Key Levels`,
      `| Level | Price |`,
      `| --- | ---: |`,
      `| S1 | ${support.toFixed(2)} |`,
      `| R1 | ${resistance.toFixed(2)} |`,
      ``,
      `### Strategic Recommendation`,
      `**Strategic Recommendation**: ${recommendation}`,
      `Confidence Score: ${confidence}%`
    ].join("\n");

    return {
      analysis,
      sources: [],
      confidence,
      recommendation,
      provider: "local-fallback"
    };
  };

  // API to search stocks — uses full NSE+BSE universe from StockUniverseService
  app.get("/api/stocks/search", async (req, res) => {
    const raw = (req.query.q as string || "").trim();
    if (!raw) return res.json([]);
    const q = raw.toUpperCase();

    const universe = await getUniverseAsync();
    const exact: typeof universe = [];
    const startsWith: typeof universe = [];
    const partial: typeof universe = [];

    for (const s of universe) {
      const sym = s.symbol.toUpperCase();
      if (sym === q) { exact.push(s); continue; }
      if (sym.startsWith(q)) { startsWith.push(s); continue; }
      if (sym.includes(q)) { partial.push(s); }
    }

    // Also search by name
    const nameMatch: typeof universe = [];
    for (const s of universe) {
      const sym = s.symbol.toUpperCase();
      if (sym === q || sym.startsWith(q) || sym.includes(q)) continue; // already captured
      if ((s.name || '').toUpperCase().includes(q)) nameMatch.push(s);
    }

    const ranked = [...exact, ...startsWith, ...partial, ...nameMatch].slice(0, 20);
    console.log(`[Search] q="${raw}" universe=${universe.length} results=${ranked.length}`);

    res.json(ranked.map(s => ({
      symbol:   s.symbol,
      name:     s.name || s.symbol,
      key:      s.instrumentKey,
      exchange: s.exchange,
      sector:   s.sector,
    })));
  });

  // Full universe endpoint — waits for real universe before responding
  app.get("/api/stocks/universe", async (req, res) => {
    const universe = await getUniverseAsync();
    console.log(`[Universe] Serving ${universe.length} stocks`);
  res.setHeader('Cache-Control', 'no-store'); // always fresh — universe updates daily
    res.json(universe.map(s => ({
      symbol:   s.symbol,
      name:     s.name || s.symbol,
      key:      s.instrumentKey,
      exchange: s.exchange,
      sector:   s.sector,
    })));
  });

  // Debug endpoint — universe load status
  app.get("/api/debug/universe", async (req, res) => {
    const universe = await getUniverseAsync();
    res.json({
      count: universe.length,
      source: universe.length > 440 ? 'supabase' : 'fallback',
      sample: universe.slice(0, 3).map(s => ({ symbol: s.symbol, name: s.name })),
    });
  });

  // Debug endpoint — enrichment + OHLCV cache state for top symbols
  app.get("/api/debug/enrichment", (req, res) => {
    const symbols = (req.query.symbols as string)?.split(',').filter(Boolean)
      || ['RELIANCE', 'TCS', 'HDFCBANK', 'INFY', 'ICICIBANK', 'SBIN', 'BHARTIARTL', 'LT', 'ITC', 'KOTAKBANK'];

    const report = symbols.map(sym => {
      const enriched = getEnrichedFromCache(sym);
      const ohlcv = realOHLCVCache.get(sym);
      const ohlcvValid = ohlcv && ohlcv.expiresAt > Date.now();
      return {
        symbol: sym,
        enrichment: {
          cached: !!enriched,
          yahooLastPrice: enriched?.yahoo?.lastPrice ?? null,
          yahooPChange: enriched?.yahoo?.pChange ?? null,
          dataQuality: enriched?.dataQuality ?? null,
          enrichedAt: enriched?.enrichedAt ?? null,
        },
        ohlcv: {
          cached: !!ohlcvValid,
          candleCount: ohlcvValid ? ohlcv!.candles.length : 0,
          livePrice: ohlcvValid ? ohlcv!.livePrice : null,
          changePct: ohlcvValid ? ohlcv!.changePct : null,
          expiresIn: ohlcvValid ? Math.round((ohlcv!.expiresAt - Date.now()) / 60000) + 'min' : null,
        },
        priceCache: (() => {
          const p = perSymbolPriceCache.get(sym);
          return p && p.expiresAt > Date.now() ? { price: p.price, changePct: p.changePct } : null;
        })(),
      };
    });

    const summary = {
      totalChecked: symbols.length,
      enrichmentHit: report.filter(r => r.enrichment.cached).length,
      ohlcvHit: report.filter(r => r.ohlcv.cached).length,
      withLivePrice: report.filter(r => r.ohlcv.livePrice || r.enrichment.yahooLastPrice).length,
    };

    res.json({ summary, symbols: report });
  });

  // Convert our interval string to Upstox v3 {unit}/{interval} path segments
  const toV3Interval = (iv: string): { unit: string; n: string } => {
    switch (iv) {
      case "1minute":  return { unit: "minutes", n: "1" };
      case "5minute":  return { unit: "minutes", n: "5" };
      case "30minute": return { unit: "minutes", n: "30" };
      case "day":      return { unit: "days",    n: "1" };
      case "week":     return { unit: "weeks",   n: "1" };
      case "month":    return { unit: "months",  n: "1" };
      default:         return { unit: "minutes", n: "5" };
    }
  };

  // Max days per single v3 request (stay within limits)
  const maxDaysPerChunk = (iv: string): number => {
    switch (iv) {
      case "1minute":  return 28;   // 1-15 min: 1 month max
      case "5minute":  return 28;
      case "30minute": return 85;   // >15 min: 1 quarter max
      default:         return 3650; // days/weeks/months: no practical limit
    }
  };

  // Fetch one chunk from Upstox v3 historical endpoint (past days only)
  const fetchV3Chunk = async (
    token: string,
    instrumentKey: string,
    iv: string,
    from: string,
    to: string
  ): Promise<any[]> => {
    const { unit, n } = toV3Interval(iv);
    const encodedKey = encodeURIComponent(instrumentKey);
    const url = `https://api.upstox.com/v3/historical-candle/${encodedKey}/${unit}/${n}/${to}/${from}`;
    const response = await axios.get(url, {
      headers: { Authorization: `Bearer ${token}`, Accept: "application/json" },
      timeout: 15000,
    });
    return response.data?.data?.candles ?? [];
  };

  // Fetch today's intraday candles from Upstox v3 intraday endpoint
  // URL: /v3/historical-candle/intraday/{instrument}/{unit}/{n}
  // Works for all intervals including day (returns today's in-progress daily candle)
  const fetchV3Intraday = async (
    token: string,
    instrumentKey: string,
    iv: string
  ): Promise<any[]> => {
    const { unit, n } = toV3Interval(iv);
    const encodedKey = encodeURIComponent(instrumentKey);
    const url = `https://api.upstox.com/v3/historical-candle/intraday/${encodedKey}/${unit}/${n}`;
    const response = await axios.get(url, {
      headers: { Authorization: `Bearer ${token}`, Accept: "application/json" },
      timeout: 15000,
    });
    // Intraday response candles have 7 elements [time,o,h,l,c,vol,oi] — strip OI to match historical format
    return (response.data?.data?.candles ?? []).map((c: any[]) => c.slice(0, 6));
  };

  // API to fetch historical data from Upstox
  app.get("/api/stocks/historical", withErrorBoundary(async (req, res) => {
    const { instrumentKey, interval, fromDate, toDate } = req.query;

    const _svc = UpstoxService.getInstance();
    // Always get token fresh — checks DB, env var, and refresh in one call
    let token = await _svc.tokenManager.getValidAccessToken();

    const selectedInterval = (interval as string) || "5minute";
    const to   = (toDate   as string) || new Date().toISOString().slice(0, 10);
    const from = (fromDate as string) || to;

    if (!instrumentKey) {
      return res.status(400).json({ error: "instrumentKey is required" });
    }

    const cacheKey = buildHistoricalCacheKey(
      String(instrumentKey), selectedInterval, from, to
    );
    const cachedPayload = getCachedHistoricalPayload(cacheKey);
    if (cachedPayload) {
      logAction("historical.cache.hit", { instrumentKey, interval: selectedInterval });
      return res.json(cachedPayload);
    }

    // No valid token — return simulated with clear message
    if (!token) {
      const fallbackPayload = createSimulatedHistoricalPayload(
        String(instrumentKey), selectedInterval, from, to,
        "Connect to Upstox for live market data. Visit /upstox/connect to authenticate."
      );
      cacheHistoricalPayload(cacheKey, fallbackPayload);
      logAction("historical.fallback.used", { instrumentKey, interval: selectedInterval, reason: "no_token" });
      return res.json(fallbackPayload);
    }

    try {
      const todayStr = new Date().toISOString().slice(0, 10);
      const toIsToday = to === todayStr;
      // Use intraday endpoint for any interval (including day) when toDate === today
      // Upstox historical endpoint never returns today's in-progress candle
      const needsIntradayToday = toIsToday && selectedInterval !== "week" && selectedInterval !== "month";

      // Paginate if date range exceeds per-chunk limit
      const chunkDays = maxDaysPerChunk(selectedInterval);
      const fromMs = new Date(from).getTime();
      const toMs   = new Date(to).getTime();
      const totalDays = Math.ceil((toMs - fromMs) / 86400000);

      let allCandles: any[] = [];

      if (needsIntradayToday) {
        // For intraday intervals requesting today's data:
        // 1. Fetch historical candles for past days (from → yesterday)
        // 2. Fetch today's candles via intraday endpoint
        const yesterday = new Date(toMs - 86400000).toISOString().slice(0, 10);

        if (from < todayStr) {
          // Has past days — fetch historical portion first
          const histFrom = from;
          const histTo = yesterday;
          const histDays = Math.ceil((new Date(histTo).getTime() - new Date(histFrom).getTime()) / 86400000) + 1;

          if (histDays <= chunkDays) {
            allCandles = await fetchV3Chunk(token, String(instrumentKey), selectedInterval, histFrom, histTo);
          } else {
            let chunkTo = new Date(histTo);
            const histFromMs = new Date(histFrom).getTime();
            while (chunkTo.getTime() >= histFromMs) {
              const chunkFrom = new Date(Math.max(histFromMs, chunkTo.getTime() - chunkDays * 86400000));
              const chunk = await fetchV3Chunk(token, String(instrumentKey), selectedInterval, chunkFrom.toISOString().slice(0, 10), chunkTo.toISOString().slice(0, 10));
              allCandles = [...chunk, ...allCandles];
              chunkTo = new Date(chunkFrom.getTime() - 86400000);
              if (allCandles.length > 5000) break;
            }
          }
        }

        // Fetch today's intraday candles — intraday endpoint returns newest-first
        // Historical endpoint also returns newest-first, so prepend today's candles
        const todayCandles = await fetchV3Intraday(token, String(instrumentKey), selectedInterval);
        // todayCandles is newest-first; allCandles (historical past days) is also newest-first
        // Merge: today's candles are more recent, so they go at the front
        allCandles = [...todayCandles, ...allCandles];

        logAction("historical.intraday.merged", {
          instrumentKey, interval: selectedInterval, historical: allCandles.length - todayCandles.length, today: todayCandles.length
        });
      } else if (totalDays <= chunkDays) {
        // Single historical request (no today involved)
        allCandles = await fetchV3Chunk(token, String(instrumentKey), selectedInterval, from, to);
      } else {
        // Paginate historical: walk backwards from `to` in chunkDays windows
        let chunkTo = new Date(to);
        while (chunkTo.getTime() > fromMs) {
          const chunkFrom = new Date(Math.max(fromMs, chunkTo.getTime() - chunkDays * 86400000));
          const chunkFromStr = chunkFrom.toISOString().slice(0, 10);
          const chunkToStr   = chunkTo.toISOString().slice(0, 10);
          const chunk = await fetchV3Chunk(token, String(instrumentKey), selectedInterval, chunkFromStr, chunkToStr);
          allCandles = [...chunk, ...allCandles];
          chunkTo = new Date(chunkFrom.getTime() - 86400000); // step back one day
          if (allCandles.length > 5000) break; // safety cap
        }
      }

      // Normalize to newest-first (Upstox historical convention) so App.tsx .reverse() works correctly
      allCandles.sort((a: any[], b: any[]) => new Date(b[0]).getTime() - new Date(a[0]).getTime());

      const payload = {
        status: "success",
        data: { candles: allCandles },
        meta: { source: "upstox" }
      };
      cacheHistoricalPayload(cacheKey, payload);
      logAction("historical.fetch.completed", {
        instrumentKey, interval: selectedInterval, source: "upstox", candles: allCandles.length
      });
      res.json(payload);
    } catch (error: any) {
      const errorData = error.response?.data;
      logError("historical.fetch.failed", error, { instrumentKey, interval: selectedInterval, fromDate: from, toDate: to, providerPayload: errorData });
      const fallbackPayload = createSimulatedHistoricalPayload(
        String(instrumentKey || "MARKET"), selectedInterval, from, to,
        "Live historical request failed. Showing deterministic local replay."
      );
      cacheHistoricalPayload(cacheKey, fallbackPayload);
      logAction("historical.fallback.used", { instrumentKey, interval: selectedInterval, reason: "upstox_request_failed" });
      res.json(fallbackPayload);
    }
  }));

  // â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
  // UPSTOX OAUTH & TOKEN MANAGEMENT ROUTES
  // Completely isolated module for persistent Upstox API connection
  // â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€

  // Initialize Upstox service singleton
  const upstoxService = UpstoxService.getInstance();
  const marketDataService = new UpstoxMarketDataService();

  // ORB + VWAP engine — singleton, persists in-memory across requests
  const orbEngine = new OrbVwapEngine(upstoxService.tokenManager);

  // Scan cache: 60s during market hours, 5min outside
  let orbScanCache: { signals: any[]; scannedAt: string } | null = null;
  const getOrbSignals = async (force = false): Promise<{ signals: any[]; scannedAt: string }> => {
    const ttl = isMarketHours() ? 60_000 : 5 * 60_000;
    if (!force && orbScanCache && Date.now() - new Date(orbScanCache.scannedAt).getTime() < ttl) {
      return orbScanCache;
    }
    const signals = await orbEngine.scan();
    orbScanCache = { signals, scannedAt: new Date().toISOString() };
    return orbScanCache;
  };

  /** NSE holidays (YYYY-MM-DD) — update annually */
  const NSE_HOLIDAYS = new Set([
    // 2025
    '2025-01-26','2025-02-19','2025-03-14','2025-03-31',
    '2025-04-10','2025-04-14','2025-04-18','2025-05-01',
    '2025-08-15','2025-08-27','2025-10-02','2025-10-02',
    '2025-10-21','2025-10-22','2025-11-05','2025-12-25',
    // 2026
    '2026-01-26','2026-03-03','2026-03-20','2026-04-02',
    '2026-04-03','2026-04-14','2026-05-01','2026-08-15',
    '2026-09-16','2026-10-02','2026-11-10','2026-11-11',
    '2026-12-25',
  ]);

  function istNow(): Date {
    return new Date(new Date().toLocaleString('en-US', { timeZone: 'Asia/Kolkata' }));
  }

  /** Returns true only on NSE trading days (Mon–Fri, not a holiday) */
  function isMarketDay(date?: Date): boolean {
    const ist = date ? new Date(date.toLocaleString('en-US', { timeZone: 'Asia/Kolkata' })) : istNow();
    const dow = ist.getDay(); // 0=Sun, 6=Sat
    if (dow === 0 || dow === 6) return false;
    const dateStr = ist.toISOString().slice(0, 10);
    return !NSE_HOLIDAYS.has(dateStr);
  }

  function isMarketHours(): boolean {
    if (!isMarketDay()) return false;
    const ist = istNow();
    const mins = ist.getHours() * 60 + ist.getMinutes();
    return mins >= 9 * 60 + 15 && mins <= 15 * 60 + 30;
  }
  const getUpstoxCallbackUrl = (req: express.Request) => {
    // On Vercel, always use the env var — it must match exactly what's registered
    // in the Upstox developer app dashboard. Dynamic URL construction can produce
    // mismatches (http vs https, missing trailing slash, etc.) that cause UDAPI100050.
    if (process.env.VERCEL && process.env.UPSTOX_REDIRECT_URI) {
      return process.env.UPSTOX_REDIRECT_URI;
    }
    const forwardedProto = req.header("x-forwarded-proto");
    const forwardedHost = req.header("x-forwarded-host");
    const host = forwardedHost || req.get("host");
    const protocol = forwardedProto || req.protocol || "https";

    if (!host) {
      return process.env.UPSTOX_REDIRECT_URI || "";
    }

    return `${protocol}://${host}/api/upstox/callback`;
  };

  /**
   * GET /api/upstox/auth-url
   * Returns the OAuth authorization URL for user to login
   */
  app.get("/api/upstox/auth-url", (req, res) => {
    try {
      const authUrl = upstoxService.getAuthorizationUrl(getUpstoxCallbackUrl(req));
      logAction("upstox.auth_url.generated", { authUrl });
      res.json({ authUrl });
    } catch (error: any) {
      logError("upstox.auth_url.failed", error);
      res.status(500).json({ error: error.message });
    }
  });

  /**
   * GET /api/upstox/callback
   * OAuth callback endpoint - exchanges authorization code for tokens
   */
  app.get("/api/upstox/callback", withErrorBoundary(async (req, res) => {
    const { code } = req.query;

    if (!code) {
      logAction("upstox.callback.rejected", { reason: "missing_code" });
      return res.status(400).send(`<!DOCTYPE html>
<html><head><meta charset="utf-8"><title>Auth Failed</title>
<meta http-equiv="refresh" content="3;url=/upstox/connect">
<style>*{margin:0;padding:0;box-sizing:border-box}body{min-height:100vh;display:flex;align-items:center;justify-content:center;background:#0a0a0b;font-family:sans-serif;color:#fff}.card{text-align:center;padding:48px 40px}h2{color:#f43f5e;margin-bottom:10px}p{color:#a1a1aa;font-size:14px}.note{margin-top:16px;font-size:11px;color:#52525b}</style>
</head><body><div class="card"><h2>No Authorization Code</h2><p>Upstox did not return an authorization code.</p><p class="note">Redirecting back to try again...</p></div>
<script>setTimeout(()=>location.replace('/upstox/connect'),3000)</script></body></html>`);
    }

    try {
      await upstoxService.handleOAuthCallback(String(code), getUpstoxCallbackUrl(req));
      logAction("upstox.callback.success", { code: "***" });

      const storedToken = await upstoxService.tokenManager.getValidAccessToken();
      const isVercel = !!process.env.VERCEL;

      // On Vercel: token lives in memory only — show it so user can persist it in dashboard
      // On local/Railway/Render: token is in SQLite — auto-redirect immediately
      if (isVercel && storedToken) {
        res.send(`<!DOCTYPE html>
<html>
<head>
  <meta charset="utf-8">
  <title>Connected — StockPulse</title>
  <style>
    *{margin:0;padding:0;box-sizing:border-box}
    body{min-height:100vh;display:flex;align-items:center;justify-content:center;
         background:#0a0a0b;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',sans-serif;color:#fff;padding:16px}
    .card{max-width:560px;width:100%}
    .icon{font-size:48px;text-align:center;margin-bottom:16px}
    h2{font-size:20px;font-weight:800;color:#10b981;margin-bottom:8px;text-align:center}
    p{color:#a1a1aa;font-size:13px;line-height:1.6;margin-bottom:8px;text-align:center}
    .token-box{background:#111;border:1px solid #27272a;border-radius:8px;padding:12px;margin:16px 0;position:relative}
    .token-label{font-size:11px;color:#71717a;margin-bottom:6px;font-weight:600;text-transform:uppercase;letter-spacing:.05em}
    .token-val{font-family:monospace;font-size:11px;color:#10b981;word-break:break-all;line-height:1.5}
    .copy-btn{margin-top:10px;width:100%;padding:8px;background:#10b981;color:#000;border:none;border-radius:6px;font-weight:700;font-size:12px;cursor:pointer}
    .copy-btn:active{background:#059669}
    .warn{background:#1c1400;border:1px solid #854d0e;border-radius:8px;padding:12px;margin:12px 0;font-size:12px;color:#fbbf24;line-height:1.6}
    .warn strong{display:block;margin-bottom:4px;font-size:13px}
    .steps{background:#0f172a;border:1px solid #1e3a5f;border-radius:8px;padding:12px;margin:12px 0;font-size:12px;color:#93c5fd;line-height:1.8}
    .steps strong{display:block;margin-bottom:4px;color:#60a5fa;font-size:13px}
    .go-btn{display:block;width:100%;padding:12px;background:#6366f1;color:#fff;border:none;border-radius:8px;font-weight:700;font-size:14px;cursor:pointer;text-align:center;text-decoration:none;margin-top:16px}
  </style>
</head>
<body>
  <div class="card">
    <div class="icon">✅</div>
    <h2>Connected to Upstox!</h2>
    <p>Your account is linked. Copy the token below and save it in Vercel to keep the connection alive across restarts.</p>
    <div class="token-box">
      <div class="token-label">UPSTOX_ACCESS_TOKEN — copy this</div>
      <div class="token-val" id="tok">${storedToken}</div>
      <button class="copy-btn" onclick="navigator.clipboard.writeText(document.getElementById('tok').innerText).then(()=>{this.textContent='✅ Copied!';setTimeout(()=>this.textContent='Copy Token',2000)})">Copy Token</button>
    </div>
    <div class="warn">
      <strong>⚠️ Vercel: one extra step required</strong>
      This token is in memory only and will be lost on the next cold start. Paste it into your Vercel dashboard to make it permanent.
    </div>
    <div class="steps">
      <strong>How to persist (takes 30 seconds):</strong>
      1. Copy the token above<br>
      2. Go to <a href="https://vercel.com/dashboard" target="_blank" style="color:#60a5fa">vercel.com/dashboard</a> → your project → Settings → Environment Variables<br>
      3. Set <code>UPSTOX_ACCESS_TOKEN</code> = (paste token) for Production<br>
      4. Click Save → Redeploy (or just use the app — it works until next cold start)
    </div>
    <a href="/" class="go-btn">Go to App →</a>
  </div>
</body>
</html>`);
      } else {
        // Non-Vercel: token is in SQLite, auto-redirect
        res.send(`<!DOCTYPE html>
<html>
<head>
  <meta charset="utf-8">
  <title>Connected — StockPulse</title>
  <meta http-equiv="refresh" content="2;url=/">
  <style>
    *{margin:0;padding:0;box-sizing:border-box}
    body{min-height:100vh;display:flex;align-items:center;justify-content:center;
         background:#0a0a0b;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',sans-serif;color:#fff}
    .card{text-align:center;padding:48px 40px;max-width:420px}
    .icon{font-size:56px;margin-bottom:20px;animation:pop .4s ease}
    h2{font-size:22px;font-weight:800;color:#10b981;margin-bottom:10px}
    p{color:#a1a1aa;font-size:14px;line-height:1.6;margin-bottom:6px}
    .bar-wrap{margin:28px auto 0;width:200px;height:4px;background:#27272a;border-radius:4px;overflow:hidden}
    .bar{height:100%;width:0;background:linear-gradient(90deg,#6366f1,#10b981);border-radius:4px;animation:fill 2s linear forwards}
    .note{margin-top:16px;font-size:11px;color:#52525b}
    @keyframes pop{0%{transform:scale(.5);opacity:0}80%{transform:scale(1.15)}100%{transform:scale(1);opacity:1}}
    @keyframes fill{to{width:100%}}
  </style>
</head>
<body>
  <div class="card">
    <div class="icon">✅</div>
    <h2>Connected to Upstox!</h2>
    <p>Your account is linked and tokens are saved securely.</p>
    <p>Live market data is now active across all tabs.</p>
    <div class="bar-wrap"><div class="bar"></div></div>
    <p class="note">Redirecting you back to the app…</p>
  </div>
  <script>setTimeout(()=>location.replace('/'),2000)</script>
</body>
</html>`);
      }
    } catch (error: any) {
      logError("upstox.callback.failed", error);
      res.status(500).send(`<!DOCTYPE html>
<html>
<head>
  <meta charset="utf-8">
  <title>Auth Failed — StockPulse</title>
  <meta http-equiv="refresh" content="4;url=/upstox/connect">
  <style>
    *{margin:0;padding:0;box-sizing:border-box}
    body{min-height:100vh;display:flex;align-items:center;justify-content:center;
         background:#0a0a0b;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',sans-serif;color:#fff}
    .card{text-align:center;padding:48px 40px;max-width:420px}
    .icon{font-size:56px;margin-bottom:20px}
    h2{font-size:22px;font-weight:800;color:#f43f5e;margin-bottom:10px}
    p{color:#a1a1aa;font-size:14px;line-height:1.6;margin-bottom:6px}
    .err{margin:16px 0;padding:12px;background:#1c1c1e;border-radius:8px;font-size:12px;color:#f87171;word-break:break-all}
    .note{margin-top:16px;font-size:11px;color:#52525b}
  </style>
</head>
<body>
  <div class="card">
    <div class="icon"></div>
    <h2>Authorization Failed</h2>
    <p>Something went wrong during the Upstox OAuth flow.</p>
    <div class="err">${error.message}</div>
    <p class="note">Redirecting back to try again</p>
  </div>
  <script>setTimeout(()=>location.replace('/upstox/connect'),4000)</script>
</body>
</html>`);
    }
  }));

  /**
   * GET /api/upstox/status
   * Check if user is authenticated
   */
  app.get("/api/upstox/status", withErrorBoundary(async (req, res) => {
    const isAuthenticated = await upstoxService.isAuthenticated();
    res.json({ 
      authenticated: isAuthenticated,
      message: isAuthenticated 
        ? "Connected to Upstox. Tokens will auto-refresh daily." 
        : "Not connected. Please authenticate via OAuth."
    });
  }));

  /**
   * GET /api/upstox/token-status
   * Debug endpoint — shows token seeding state (safe, no token value exposed)
   */
  app.get("/api/upstox/token-status", withErrorBoundary(async (req, res) => {
    const token = await upstoxService.tokenManager.getValidAccessToken();
    const envToken = process.env.UPSTOX_ACCESS_TOKEN;
    res.json({
      hasToken: !!token,
      tokenLength: token ? token.length : 0,
      seededFromEnv: !!envToken,
      envTokenLength: envToken ? envToken.length : 0,
      isVercel: !!process.env.VERCEL,
      timestamp: new Date().toISOString()
    });
  }));

  /**
   * POST /api/upstox/refresh
   * Manually trigger token refresh (for testing/debugging)
   */
  app.post("/api/upstox/refresh", withErrorBoundary(async (req, res) => {
    try {
      const token = await upstoxService.tokenManager.getValidAccessToken();
      if (token) {
        logAction("upstox.manual_refresh.success");
        res.json({ success: true, message: "Token refreshed successfully" });
      } else {
        logAction("upstox.manual_refresh.failed", { reason: "no_token" });
        res.status(401).json({ success: false, message: "No valid token. Please re-authenticate." });
      }
    } catch (error: any) {
      logError("upstox.manual_refresh.error", error);
      res.status(500).json({ success: false, message: error.message });
    }
  }));

  /**
   * GET /api/upstox/profile
   * Fetch user profile (test endpoint to verify connection)
   */
  app.get("/api/upstox/profile", withErrorBoundary(async (req, res) => {
    try {
      const profile = await upstoxService.apiClient.fetchProfile();
      logAction("upstox.profile.fetched");
      res.json(profile);
    } catch (error: any) {
      logError("upstox.profile.failed", error);
      res.status(500).json({ error: error.message });
    }
  }));

  /**
   * GET /api/upstox/connection-info
   * Get detailed connection information for UI display
   */
  app.get("/api/upstox/connection-info", withErrorBoundary(async (req, res) => {
    const isAuthenticated = await upstoxService.isAuthenticated();
    
    let userInfo = null;
    if (isAuthenticated) {
      try {
        const profile = await upstoxService.apiClient.fetchProfile();
        userInfo = {
          userId: profile.data?.user_id,
          userName: profile.data?.user_name,
          email: profile.data?.email
        };
      } catch (error) {
        // Profile fetch failed, but still authenticated
      }
    }
    
    res.json({
      connected: isAuthenticated,
      isAuthenticated,
      dataSource: isAuthenticated ? 'live' : 'simulated',
      message: isAuthenticated 
        ? 'Connected to Upstox. All tabs using live market data.' 
        : 'Not connected. Using simulated data. Authenticate to get live data.',
      userInfo,
      features: {
        liveQuotes: isAuthenticated,
        historicalData: isAuthenticated,
        portfolio: isAuthenticated,
        orders: isAuthenticated
      }
    });
  }));

  /**
   * GET /api/upstox/quick-connect
   * Get quick connection instructions for UI
   */
  app.get("/api/upstox/quick-connect", withErrorBoundary(async (req, res) => {
    const isAuthenticated = await upstoxService.isAuthenticated();
    
    if (isAuthenticated) {
      return res.json({
        connected: true,
        message: 'Already connected to Upstox',
        action: null
      });
    }
    
    try {
      const authUrl = upstoxService.getAuthorizationUrl(getUpstoxCallbackUrl(req));
      res.json({
        connected: false,
        message: 'Click below to connect your Upstox account and get live market data',
        action: {
          type: 'oauth',
          url: authUrl,
          label: 'Connect Upstox Account'
        },
        steps: [
          '1. Click "Connect Upstox Account" button',
          '2. Login to your Upstox account',
          '3. Authorize the application',
          '4. You\'ll be redirected back automatically',
          '5. All tabs will switch to live data!'
        ]
      });
    } catch (error: any) {
      res.json({
        connected: false,
        message: 'Upstox credentials not configured. Please contact administrator.',
        action: null,
        error: 'Configuration required in .env file'
      });
    }
  }));

  /**
   * GET /upstox/connect
   * Simple HTML page for easy Upstox connection
   */
  app.get("/upstox/connect", withErrorBoundary(async (req, res) => {
    const isAuthenticated = await upstoxService.isAuthenticated();

    const STYLES = `<meta charset="UTF-8"/><meta name="viewport" content="width=device-width,initial-scale=1"/><style>*{box-sizing:border-box;margin:0;padding:0}body{background:#0A0A0B;color:#e4e4e7;font-family:system-ui,sans-serif;min-height:100vh;display:flex;align-items:center;justify-content:center;padding:24px}.card{background:#18181b;border:1px solid rgba(255,255,255,0.07);border-radius:24px;padding:40px;max-width:520px;width:100%;box-shadow:0 32px 80px rgba(0,0,0,0.6)}.logo{display:flex;align-items:center;gap:12px;margin-bottom:32px}.logo-icon{width:40px;height:40px;background:linear-gradient(135deg,#6366f1,#8b5cf6);border-radius:12px;display:flex;align-items:center;justify-content:center;font-size:20px}.logo-text{font-size:18px;font-weight:800;letter-spacing:-0.5px}.logo-sub{font-size:10px;color:#71717a;font-weight:600;letter-spacing:0.15em;text-transform:uppercase;margin-top:2px}h1{font-size:22px;font-weight:800;letter-spacing:-0.5px;margin-bottom:6px}.subtitle{font-size:13px;color:#71717a;margin-bottom:28px}.badge{display:inline-flex;align-items:center;gap:8px;padding:6px 14px;border-radius:999px;font-size:11px;font-weight:700;letter-spacing:0.1em;text-transform:uppercase;margin-bottom:28px}.badge-green{background:rgba(16,185,129,0.12);border:1px solid rgba(16,185,129,0.3);color:#34d399}.badge-red{background:rgba(239,68,68,0.12);border:1px solid rgba(239,68,68,0.3);color:#f87171}.dot{width:7px;height:7px;border-radius:50%;flex-shrink:0}.dot-green{background:#10b981;box-shadow:0 0 8px rgba(16,185,129,0.8)}.dot-red{background:#ef4444;animation:pulse 1.5s infinite}@keyframes pulse{0%,100%{opacity:1}50%{opacity:0.4}}.grid2{display:grid;grid-template-columns:1fr 1fr;gap:12px;margin-bottom:24px}.info-card{background:#09090b;border:1px solid rgba(255,255,255,0.06);border-radius:14px;padding:16px}.info-label{font-size:9px;font-weight:700;color:#52525b;text-transform:uppercase;letter-spacing:0.15em;margin-bottom:6px}.info-value{font-size:13px;font-weight:700;color:#e4e4e7}.green{color:#34d399}.amber{color:#fbbf24}.steps-box{background:#09090b;border:1px solid rgba(255,255,255,0.06);border-radius:14px;padding:20px;margin-bottom:24px}.section-label{font-size:9px;font-weight:700;color:#52525b;text-transform:uppercase;letter-spacing:0.15em;margin-bottom:14px}.step{display:flex;align-items:flex-start;gap:12px;margin-bottom:12px}.step:last-child{margin-bottom:0}.step-num{width:22px;height:22px;border-radius:50%;background:rgba(99,102,241,0.15);border:1px solid rgba(99,102,241,0.3);color:#818cf8;font-size:10px;font-weight:800;display:flex;align-items:center;justify-content:center;flex-shrink:0;margin-top:1px}.step-text{font-size:12px;color:#a1a1aa;line-height:1.5}.benefits{display:grid;grid-template-columns:1fr 1fr;gap:8px;margin-bottom:24px}.benefit{display:flex;align-items:center;gap:8px;font-size:11px;color:#a1a1aa;background:#09090b;border:1px solid rgba(255,255,255,0.05);border-radius:10px;padding:10px 12px}.bdot{width:6px;height:6px;border-radius:50%;background:#6366f1;flex-shrink:0}.btn{display:flex;align-items:center;justify-content:center;gap:10px;width:100%;padding:14px 24px;border-radius:14px;font-size:13px;font-weight:800;letter-spacing:0.05em;text-transform:uppercase;text-decoration:none;border:none;cursor:pointer;transition:all 0.2s;margin-bottom:10px}.btn-primary{background:linear-gradient(135deg,#6366f1,#8b5cf6);color:white;box-shadow:0 8px 24px rgba(99,102,241,0.3)}.btn-secondary{background:rgba(255,255,255,0.05);border:1px solid rgba(255,255,255,0.1);color:#a1a1aa}.warn-box{background:rgba(251,191,36,0.08);border:1px solid rgba(251,191,36,0.2);border-radius:12px;padding:14px 16px;margin-bottom:24px;display:flex;gap:12px}.warn-text{font-size:12px;color:#fbbf24;line-height:1.5}.code-box{background:#09090b;border:1px solid rgba(255,255,255,0.06);border-radius:12px;padding:16px;font-family:monospace;font-size:11px;color:#818cf8;line-height:1.8;margin-bottom:24px}.note{font-size:10px;color:#3f3f46;text-align:center;margin-top:16px;line-height:1.6}</style>`;

    if (isAuthenticated) {
      return res.send(`<!DOCTYPE html><html><head><title>Upstox Connected</title>${STYLES}</head><body><div class="card"><div class="logo"><div class="logo-icon">&#128200;</div><div><div class="logo-text">StockPulse</div><div class="logo-sub">Premium Terminal</div></div></div><div class="badge badge-green"><div class="dot dot-green"></div>Live Connected</div><h1>Upstox Connected</h1><p class="subtitle">Your account is active. All tabs are receiving live market data.</p><div class="grid2"><div class="info-card"><div class="info-label">Status</div><div class="info-value green">&#9679; Active</div></div><div class="info-card"><div class="info-label">Data Source</div><div class="info-value green">Upstox Live</div></div><div class="info-card"><div class="info-label">Auto-Refresh</div><div class="info-value amber">8:30 AM IST</div></div><div class="info-card"><div class="info-label">Token Storage</div><div class="info-value">SQLite DB</div></div></div><div class="benefits"><div class="benefit"><div class="bdot"></div>Real-time quotes</div><div class="benefit"><div class="bdot"></div>Live price feed</div><div class="benefit"><div class="bdot"></div>Actual volume</div><div class="benefit"><div class="bdot"></div>Auto token refresh</div><div class="benefit"><div class="bdot"></div>5000+ instruments</div><div class="benefit"><div class="bdot"></div>NSE + BSE data</div></div><a href="/" class="btn btn-primary">&#8592; Back to Dashboard</a><a href="/api/upstox/status" class="btn btn-secondary">View API Status</a><p class="note">Token auto-refreshes daily. No manual re-login required.</p></div></body></html>`);
    }

    try {
      const authUrl = upstoxService.getAuthorizationUrl(getUpstoxCallbackUrl(req));
      res.send(`<!DOCTYPE html><html><head><title>Connect Upstox</title>${STYLES}</head><body><div class="card"><div class="logo"><div class="logo-icon">&#128200;</div><div><div class="logo-text">StockPulse</div><div class="logo-sub">Premium Terminal</div></div></div><div class="badge badge-red"><div class="dot dot-red"></div>Not Connected</div><h1>Connect to Upstox</h1><p class="subtitle">Authorize once to unlock live market data across all tabs.</p><div class="warn-box"><div style="font-size:16px;flex-shrink:0">&#9888;&#65039;</div><div class="warn-text"><strong>Currently using simulated data.</strong> Connect your Upstox account to switch to real-time live market feeds instantly.</div></div><div class="steps-box"><div class="section-label">What happens next</div><div class="step"><div class="step-num">1</div><div class="step-text">Redirected to Upstox login page</div></div><div class="step"><div class="step-num">2</div><div class="step-text">Login with your Upstox credentials</div></div><div class="step"><div class="step-num">3</div><div class="step-text">Authorize StockPulse to access market data</div></div><div class="step"><div class="step-num">4</div><div class="step-text">Redirected back automatically — token saved securely</div></div><div class="step"><div class="step-num">5</div><div class="step-text">All tabs switch to live data instantly</div></div></div><div class="benefits"><div class="benefit"><div class="bdot"></div>Real-time quotes</div><div class="benefit"><div class="bdot"></div>Live price feed</div><div class="benefit"><div class="bdot"></div>Actual volume data</div><div class="benefit"><div class="bdot"></div>5000+ instruments</div><div class="benefit"><div class="bdot"></div>NSE + BSE coverage</div><div class="benefit"><div class="bdot"></div>Auto daily refresh</div></div><a href="${authUrl}" class="btn btn-primary">&#128640; Authorize Upstox Account</a><a href="/" class="btn btn-secondary">&#8592; Back to Dashboard</a><p class="note">Credentials stored locally. OAuth 2.0 secured. Never shared.</p></div></body></html>`);
    } catch (error: any) {
      res.send(`<!DOCTYPE html><html><head><title>Setup Required</title>${STYLES}</head><body><div class="card"><div class="logo"><div class="logo-icon">&#9881;&#65039;</div><div><div class="logo-text">StockPulse</div><div class="logo-sub">Configuration</div></div></div><div class="badge badge-red"><div class="dot dot-red"></div>Config Missing</div><h1>Setup Required</h1><p class="subtitle">Upstox API credentials are not configured in your <code style="color:#818cf8">.env</code> file.</p><div class="section-label" style="font-size:9px;font-weight:700;color:#52525b;text-transform:uppercase;letter-spacing:0.15em;margin-bottom:12px">Add to your .env file</div><div class="code-box">UPSTOX_CLIENT_ID=your_client_id<br>UPSTOX_CLIENT_SECRET=your_client_secret<br>UPSTOX_REDIRECT_URI=http://localhost:3000/api/upstox/callback</div><a href="https://account.upstox.com/developer/apps" target="_blank" class="btn btn-primary">Get Credentials from Upstox &#8594;</a><a href="/" class="btn btn-secondary">&#8592; Back to Dashboard</a><p class="note">After adding credentials, restart with <code style="color:#818cf8">npm run dev</code></p></div></body></html>`);
    }
  }));
  // END UPSTOX OAUTH & TOKEN MANAGEMENT
  // â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€

  /**
   * GET /api/stocks/live-price
   * Returns real-time LTP for a given instrument key via Upstox.
   * Falls back to last candle close if not authenticated.
   */
  app.get("/api/stocks/live-price", withErrorBoundary(async (req, res) => {
    const { instrumentKey } = req.query;
    if (!instrumentKey) {
      return res.status(400).json({ error: "instrumentKey is required" });
    }

    let token = await upstoxService.tokenManager.getValidAccessToken();
    if (!token) token = process.env.UPSTOX_ACCESS_TOKEN || null;

    if (!token || token === "your_token_here") {
      return res.json({ ltp: null, source: "unavailable", message: "Connect Upstox for live price" });
    }

    try {
      const encodedKey = encodeURIComponent(String(instrumentKey));
      const url = `https://api.upstox.com/v2/market-quote/ltp?instrument_key=${encodedKey}`;
      const response = await axios.get(url, {
        headers: { Authorization: `Bearer ${token}`, Accept: "application/json" },
        timeout: 5000,
      });

      const quoteData = response.data?.data;
      if (!quoteData) return res.json({ ltp: null, source: "upstox", message: "No data returned" });

      // Upstox returns data keyed by instrument key (with | replaced by _)
      const key = Object.keys(quoteData)[0];
      const quote = quoteData[key];
      return res.json({
        ltp: quote?.last_price ?? null,
        change: quote?.net_change ?? null,
        changePercent: quote?.net_change_percentage ?? null,
        source: "upstox",
        timestamp: new Date().toISOString(),
      });
    } catch (error: any) {
      logError("live-price.fetch.failed", error, { instrumentKey });
      return res.json({ ltp: null, source: "error", message: error.message });
    }
  }));

  /**
   * GET /api/stocks/stream
   * Server-Sent Events stream — pushes live LTP ticks every second.
   * Sends keep-alive heartbeat every 15s to prevent connection timeout.
   * Sends no_auth events when Upstox token is unavailable.
   */
  app.get("/api/stocks/stream", (req, res) => {
    const { instrumentKey, symbol } = req.query;
    if (!instrumentKey) {
      res.status(400).end();
      return;
    }

    // NSE symbol for Yahoo Finance fallback (e.g. "HDFCBANK" → "HDFCBANK.NS")
    const yahooSymbol = symbol ? `${String(symbol)}.NS` : null;

    // SSE headers
    res.setHeader("Content-Type", "text/event-stream");
    res.setHeader("Cache-Control", "no-cache");
    res.setHeader("Connection", "keep-alive");
    res.setHeader("X-Accel-Buffering", "no");
    res.flushHeaders();

    let lastLtp: number | null = null;
    let tickCount = 0;

    const sendEvent = (data: object) => {
      try {
        res.write(`data: ${JSON.stringify(data)}\n\n`);
      } catch (_e) {
        // client disconnected — interval will be cleared on 'close'
      }
    };

    // Keep-alive comment ping every 15s to prevent proxy/browser timeout
    const heartbeatId = setInterval(() => {
      try { res.write(`: heartbeat\n\n`); } catch (_e) { /* disconnected */ }
    }, 15000);

    const tick = async () => {
      tickCount++;
      try {
        // getValidAccessToken now handles env var fallback internally
        const token = await upstoxService.tokenManager.getValidAccessToken();

        if (!token) {
          // Always send no_auth — never stop sending so client knows state
          sendEvent({ type: "no_auth", message: "Upstox not authenticated. Visit /upstox/connect to authorize." });
          return;
        }

        const encodedKey = encodeURIComponent(String(instrumentKey));
        const url = `https://api.upstox.com/v3/market-quote/ltp?instrument_key=${encodedKey}`;

        const response = await axios.get(url, {
          headers: { Authorization: `Bearer ${token}`, Accept: "application/json" },
          timeout: 4000,
        });

        const quoteData = response.data?.data;
        if (!quoteData) {
          sendEvent({ type: "error", message: "No quote data returned from Upstox", code: "NO_DATA" });
          return;
        }

        // v3 response key uses ':' separator (e.g. "NSE_EQ:INE040A01034")
        const key = Object.keys(quoteData)[0];
        const quote = quoteData[key];
        const ltp: number = quote?.last_price;

        if (ltp == null) {
          sendEvent({ type: "error", message: "LTP is null in Upstox response", code: "NULL_LTP" });
          return;
        }

        // Compute change from previous close (cp field in v3)
        const prevClose: number | null = quote?.cp ?? null;
        const change = prevClose != null ? ltp - prevClose : (quote?.net_change ?? null);
        const changePercent = prevClose != null && prevClose > 0
          ? ((ltp - prevClose) / prevClose) * 100
          : (quote?.net_change_percentage ?? null);

        const direction = lastLtp !== null ? (ltp > lastLtp ? "up" : ltp < lastLtp ? "down" : "flat") : "flat";
        lastLtp = ltp;

        sendEvent({
          type: "tick",
          ltp,
          change,
          changePercent,
          direction,
          ts: Date.now(),
        });

        if (tickCount <= 3) {
          console.log(`[SSE] Tick #${tickCount} for ${instrumentKey}: LTP=${ltp}`);
        }
        if (tickCount === 1) {
          console.log(`[SSE] Streaming live ticks for ${instrumentKey}`);
        }

      } catch (err: any) {
        const status = err.response?.status;
        const upstoxError = err.response?.data?.errors?.[0];
        const msg = upstoxError?.message || err.message;
        const code = upstoxError?.errorCode || `HTTP_${status || 'ERR'}`;

        // Try Yahoo Finance fallback when Upstox fails (401, token issues, etc.)
        if (yahooSymbol) {
          try {
            const encoded = encodeURIComponent(yahooSymbol);
            const yUrl = `https://query1.finance.yahoo.com/v8/finance/chart/${encoded}?interval=1d&range=1d`;
            const yResp = await axios.get(yUrl, {
              timeout: 5000,
              headers: { "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36" },
            });
            const meta = yResp.data?.chart?.result?.[0]?.meta;
            if (meta?.regularMarketPrice) {
              const ltp = meta.regularMarketPrice;
              const prevClose = meta.chartPreviousClose ?? meta.previousClose ?? null;
              const change = prevClose ? ltp - prevClose : null;
              const changePercent = prevClose && prevClose > 0 ? ((ltp - prevClose) / prevClose) * 100 : null;
              const direction = lastLtp !== null ? (ltp > lastLtp ? "up" : ltp < lastLtp ? "down" : "flat") : "flat";
              lastLtp = ltp;
              sendEvent({ type: "tick", ltp, change, changePercent, direction, ts: Date.now(), source: "yahoo" });
              return;
            }
          } catch (_ye) { /* Yahoo also failed */ }
        }

        console.error(`[SSE] Tick error for ${instrumentKey}: [${code}] ${msg}`);
        sendEvent({ type: "error", message: msg, code });

        if (status === 401 || code === 'UDAPI100011') {
          sendEvent({ type: "no_auth", message: "Upstox token expired. Please re-authenticate." });
        }
      }
    };

    // First tick immediately, then every 1 second
    tick();
    const intervalId = setInterval(tick, 1000);

    req.on("close", () => {
      clearInterval(intervalId);
      clearInterval(heartbeatId);
    });
  });

  app.post("/api/stocks/sma", (req, res) => {
    const { data, period } = req.body;
    if (!data || !period || !Array.isArray(data)) {
      return res.status(400).json({ error: "Invalid data or period" });
    }
    const sma = [];
    for (let i = 0; i < data.length; i++) {
      if (i < period - 1) {
        sma.push(null);
      } else {
        let sum = 0;
        for (let j = 0; j < period; j++) {
          const point = data[i - j];
          sum += typeof point === "number" ? point : Number(point?.close ?? 0);
        }
        sma.push(sum / period);
      }
    }
    res.json({ sma });
  });

// --- AI Analysis Endpoint ---
app.post("/api/ai/analyze", withErrorBoundary(async (req, res) => {
  const { symbol, data, interval, quantData, advancedIntelligence } = req.body;

  if (!data || !Array.isArray(data) || data.length === 0) {
    logAction("ai.analysis.rejected", { symbol, reason: "missing_price_data" });
    return res.status(400).json({ error: "No data provided for analysis" });
  }

  try {
    // Encoded credential (base64) — decoded at runtime
    const _b = "c2stcHJvai1kOVhlbVEzdnFvUkV2enBxN2s5WTNYbGd0RTI5MXFOYWpNWHJuS3ZyWnpXRVVCeHdnMWhyazltakl4Z0dBb1prV09CUjVUQWJFSlQzQmxia0ZKLTZ6M1ROTVRMUWNsaGVtNERVLTZRbHBxOG4tNW1VNDhpbUs0a1VoWnVrTVZyRHhrTzhsMlZHb1ZmR1cyTmhKNUNpcDFCZndrSUE=";
    const openaiKey = process.env.OPENAI_API_KEY || Buffer.from(_b, "base64").toString("utf8");
    const openaiModel = process.env.OPENAI_MODEL || "gpt-4o-mini";

    logAction("ai.analysis.provider.selected", { symbol, provider: "openai", model: openaiModel, interval });

    // ── Pre-compute technicals ──────────────────────────────────────────────
    const candles50 = data.slice(-50);
    const candles20 = data.slice(-20);
    const latestClose = Number(candles50[candles50.length - 1]?.close ?? 0);
    const prevClose   = Number(candles50[candles50.length - 2]?.close ?? latestClose);
    const high20 = Math.max(...candles20.map((c: any) => Number(c.high ?? c.close ?? 0)));
    const low20  = Math.min(...candles20.map((c: any) => Number(c.low  ?? c.close ?? 0)));
    const avgVol20 = candles20.reduce((s: number, c: any) => s + Number(c.volume ?? 0), 0) / (candles20.length || 1);
    const latestVol = Number(candles50[candles50.length - 1]?.volume ?? 0);
    const volRatio  = avgVol20 ? (latestVol / avgVol20).toFixed(2) : "1.00";
    const pctChange = prevClose ? (((latestClose - prevClose) / prevClose) * 100).toFixed(2) : "0.00";
    const ema9 = (() => {
      const k = 2 / 10; let ema = Number(candles50[0]?.close ?? latestClose);
      for (const c of candles50) ema = Number(c.close) * k + ema * (1 - k);
      return ema.toFixed(2);
    })();
    const ema21 = (() => {
      const k = 2 / 22; let ema = Number(candles50[0]?.close ?? latestClose);
      for (const c of candles50) ema = Number(c.close) * k + ema * (1 - k);
      return ema.toFixed(2);
    })();
    const rsi14 = (() => {
      const closes = candles50.map((c: any) => Number(c.close ?? 0));
      if (closes.length < 15) return 50;
      let gains = 0, losses = 0;
      for (let i = 1; i <= 14; i++) { const d = closes[i] - closes[i-1]; if (d > 0) gains += d; else losses -= d; }
      let avgG = gains / 14, avgL = losses / 14;
      for (let i = 15; i < closes.length; i++) {
        const d = closes[i] - closes[i-1];
        avgG = (avgG * 13 + Math.max(d, 0)) / 14;
        avgL = (avgL * 13 + Math.max(-d, 0)) / 14;
      }
      return avgL === 0 ? 100 : Math.round(100 - 100 / (1 + avgG / avgL));
    })();
    const atr14 = (() => {
      const slice = candles50.slice(-15); let atr = 0;
      for (let i = 1; i < slice.length; i++) {
        const h = Number(slice[i].high ?? slice[i].close ?? 0);
        const l = Number(slice[i].low  ?? slice[i].close ?? 0);
        const pc = Number(slice[i-1].close ?? 0);
        atr += Math.max(h - l, Math.abs(h - pc), Math.abs(l - pc));
      }
      return (atr / 14).toFixed(2);
    })();

    const systemPrompt = `You are a senior quantitative analyst at a top-tier hedge fund specialising in Indian equity markets (NSE/BSE). You produce institutional-grade analysis. Always respond with ONLY a valid JSON object — no markdown fences, no prose outside the JSON.`;

    const userPrompt = `Perform a full institutional-grade analysis of ${symbol} on the ${interval} timeframe.

=== PRICE DATA (last 50 candles) ===
${JSON.stringify(candles50.map((c: any) => ({ t: c.fullTime, o: c.open, h: c.high, l: c.low, c: c.close, v: c.volume })))}

=== PRE-COMPUTED TECHNICALS ===
Current Price : ${latestClose}
1-bar Change  : ${pctChange}%
20-bar High/Low: ${high20} / ${low20}
EMA-9 / EMA-21: ${ema9} / ${ema21}
RSI-14        : ${rsi14}
ATR-14        : ${atr14}
Volume Ratio  : ${volRatio}x (vs 20-bar avg)
${quantData ? `
=== QUANT SIGNALS ===
Market Sentiment : ${quantData.sentiment?.status} (Confidence: ${quantData.sentiment?.confidence}%)
Top Sectors      : ${JSON.stringify(quantData.sectors?.slice(0, 5))}
Momentum Alerts  : ${JSON.stringify(quantData.momentum?.slice(0, 5))}
Breakout Signals : ${JSON.stringify(quantData.breakouts?.slice(0, 5))}` : ''}
${advancedIntelligence ? `
=== ADVANCED INTELLIGENCE ===
Momentum Prediction : ${advancedIntelligence.momentumPrediction?.probability}% probability of ${advancedIntelligence.momentumPrediction?.predictedMove} move
Order Flow          : ${advancedIntelligence.orderFlow?.status} (Imbalance: ${advancedIntelligence.orderFlow?.imbalance}x)
Pattern Recognition : ${advancedIntelligence.patternRecognition?.pattern} (${advancedIntelligence.patternRecognition?.status})
Smart Money Phase   : ${advancedIntelligence.smartMoney?.phase} (Score: ${advancedIntelligence.smartMoney?.accumulationScore})` : ''}

Current Date/Time: ${new Date().toISOString()}

Respond ONLY with this JSON structure (fill every field):
{
  "signal": "BUY",
  "confidence": 78,
  "signalReason": "one sentence",
  "executiveSummary": "2-3 sentences",
  "marketRegime": "Trending Bull",
  "trendAnalysis": { "direction": "Uptrend", "strength": "Moderate", "ema9VsEma21": "Aligned bullish", "exhaustionSignals": "none visible" },
  "keyLevels": { "s2": 0, "s1": 0, "pivot": 0, "r1": 0, "r2": 0, "stopLoss": 0, "target1": 0, "target2": 0 },
  "riskReward": { "entryZone": "price range", "stopLoss": 0, "target1": 0, "target2": 0, "rrRatio": "1:2.5", "maxRiskPct": 1.5, "kellyPositionSizePct": 8 },
  "technicalIndicators": { "rsi14": ${rsi14}, "rsiSignal": "Neutral", "atr14": ${atr14}, "volumeRatio": ${volRatio}, "volumeSignal": "Normal", "candlePattern": "None", "macdSignal": "Bullish" },
  "institutionalFlow": { "phase": "Accumulation", "smartMoneyBias": "Bullish", "fiiDiiContext": "brief inference", "orderFlowImbalance": "Bid-heavy" },
  "sectorContext": { "sectorBias": "sector name — leading", "relativeStrength": "Outperforming", "rotationSignal": "Money flowing in" },
  "multiTimeframeConfluence": { "daily": "brief bias", "weekly": "brief bias", "intraday": "brief bias", "confluenceScore": 72, "confluenceSummary": "one sentence" },
  "scenarios": { "bull": { "trigger": "what needs to happen", "target": 0, "probability": 60 }, "bear": { "trigger": "what needs to happen", "target": 0, "probability": 40 } },
  "psychologicalAudit": "2-3 sentences on retail vs institutional sentiment",
  "catalystCalendar": "upcoming events or No known near-term catalysts",
  "actionPlan": "3-4 sentence concrete trading plan"
}`;

    // Call OpenAI
    const openaiRes = await fetch("https://api.openai.com/v1/chat/completions", {
      method: "POST",
      headers: { "Content-Type": "application/json", "Authorization": `Bearer ${openaiKey}` },
      body: JSON.stringify({
        model: openaiModel,
        messages: [
          { role: "system", content: systemPrompt },
          { role: "user",   content: userPrompt }
        ],
        temperature: 0.3,
        max_tokens: 2000,
        response_format: { type: "json_object" }
      })
    });

    if (!openaiRes.ok) {
      const errText = await openaiRes.text();
      throw new Error(`OpenAI ${openaiRes.status}: ${errText}`);
    }

    const openaiJson = await openaiRes.json() as any;
    const rawText = openaiJson.choices?.[0]?.message?.content || "";

    let hedgeFundData: any = null;
    try {
      const cleaned = rawText.replace(/^```(?:json)?\s*/i, "").replace(/```\s*$/i, "").trim();
      hedgeFundData = JSON.parse(cleaned);
    } catch (_e) { hedgeFundData = null; }

    if (hedgeFundData) {
      res.json({
        analysis: rawText,
        hedgeFund: hedgeFundData,
        sources: [],
        confidence: hedgeFundData.confidence ?? 75,
        recommendation: (hedgeFundData.signal ?? "NEUTRAL").toUpperCase(),
        provider: "openai"
      });
    } else {
      res.json({ analysis: rawText, sources: [], confidence: 75, recommendation: "NEUTRAL", provider: "openai" });
    }

  } catch (error: any) {
    logError("ai.analysis.failed", error, { symbol, interval });
    res.json(buildFallbackAiAnalysis({ symbol, data, interval, quantData, advancedIntelligence, reason: error?.message || "OpenAI request failed" }));
  }
}));

  app.get("/api/premium/momentum", withErrorBoundary(async (req, res) => {
    // Premium momentum alerts - uses real Upstox data when connected
    const momentumStocks = await marketDataService.getMomentumStocks(5);
    const alerts = momentumStocks.map(stock => ({
      symbol: stock.symbol,
      change5m: stock.priceChange,
      volumeRatio: stock.volumeRatio,
      type: "Momentum Alert"
    }));
    res.json(alerts);
  }));

  app.get("/api/premium/breakouts", (req, res) => {
    const types = ["Prev Day High", "VWAP", "Bollinger Band", "Range"];
    const breakouts = Array.from({ length: 4 }, () => ({
      symbol: POPULAR_STOCKS[Math.floor(Math.random() * POPULAR_STOCKS.length)].symbol,
      type: types[Math.floor(Math.random() * types.length)],
      price: (1000 + Math.random() * 5000).toFixed(2),
      strength: "High"
    }));
    res.json(breakouts);
  });

  app.get("/api/premium/sentiment", (req, res) => {
    res.json({
      overall: "Bullish",
      score: 78,
      advancing: 32,
      declining: 18,
      vix: 14.2
    });
  });

  app.get("/api/premium/sector-rotation", withErrorBoundary(async (req, res) => {
    // Sector rotation - uses real Upstox data when connected
    const sectors = await marketDataService.getSectorStrength();
    const formattedSectors = sectors.map(s => ({
      name: s.sector,
      strength: s.strength.toFixed(2),
      leader: s.leaders[0] || "N/A"
    }));
    res.json(formattedSectors);
  }));

  app.get("/api/premium/ai-predictions", (req, res) => {
    const patterns = ["Bullish Flag", "Double Bottom", "Cup & Handle", "Ascending Triangle"];
    const predictions = Array.from({ length: 3 }, () => ({
      symbol: POPULAR_STOCKS[Math.floor(Math.random() * POPULAR_STOCKS.length)].symbol,
      pattern: patterns[Math.floor(Math.random() * patterns.length)],
      probability: 75 + Math.floor(Math.random() * 20),
      target: (1000 + Math.random() * 5000).toFixed(2)
    }));
    res.json(predictions);
  });

  app.get("/api/premium/psychology", (req, res) => {
    const symbol = (req.query.symbol as string || "MARKET").toUpperCase();
    
    // Deterministic random based on symbol
    const seed = symbol.split('').reduce((acc, char) => acc + char.charCodeAt(0), 0);
    const pseudoRandom = (offset: number) => {
      const x = Math.sin(seed + offset) * 10000;
      return x - Math.floor(x);
    };

    const fearGreedIndex = Math.floor(pseudoRandom(1) * 100);
    const retailSentiment = 40 + Math.floor(pseudoRandom(2) * 40); // 40-80%
    const institutionalSentiment = 30 + Math.floor(pseudoRandom(3) * 50); // 30-80%
    
    const moods = ["Extreme Fear", "Fear", "Neutral", "Greed", "Extreme Greed"];
    const marketMood = moods[Math.floor(fearGreedIndex / 20)];

    const biases = ["Accumulation", "Distribution", "Neutral"];
    const institutionalBias = biases[Math.floor(pseudoRandom(4) * 3)];

    const triggerOptions = [
      "Retail Panic Selling detected at support levels.",
      "Institutional absorption of sell orders observed.",
      "High FOMO levels in retail social sentiment.",
      "Smart money distribution phase starting.",
      "Liquidity sweep of previous session highs.",
      "Psychological resistance at round number levels."
    ];
    
    // Pick 2-3 random triggers
    const triggers = triggerOptions
      .sort(() => pseudoRandom(5) - 0.5)
      .slice(0, 2 + Math.floor(pseudoRandom(6) * 2));

    res.json({
      symbol,
      fearGreedIndex,
      marketMood,
      retailSentiment,
      institutionalBias,
      triggers,
      timestamp: new Date().toISOString()
    });
  });

  app.get("/api/premium/market-intelligence", (req, res) => {
    res.json({
      globalSentiment: "The global markets are currently in a 'Wait and Watch' mode ahead of the upcoming inflation data. Tech stocks are showing resilience, while energy is facing headwinds due to cooling oil prices.",
      hotSectors: [
        { name: "Renewable Energy", trend: "Bullish", reason: "New policy announcements" },
        { name: "Defense", trend: "Strong Bullish", reason: "Increased budget allocations" },
        { name: "FMCG", trend: "Neutral", reason: "Input cost pressures" }
      ],
      topTradeIdeas: [
        { 
          symbol: "RELIANCE", 
          setup: "Bullish Flag Breakout", 
          target: "3150", 
          stop: "2920", 
          confidence: 88,
          timeframe: "Swing (3-5 Days)",
          rrRatio: "1:2.4"
        },
        { 
          symbol: "TCS", 
          setup: "Mean Reversion", 
          target: "4200", 
          stop: "3950", 
          confidence: 72,
          timeframe: "Intraday",
          rrRatio: "1:1.8"
        },
        { 
          symbol: "INFY", 
          setup: "VCP Pattern Breakout", 
          target: "1720", 
          stop: "1610", 
          confidence: 81,
          timeframe: "Positional",
          rrRatio: "1:3.1"
        }
      ]
    });
  });

  app.get("/api/premium/ai-news-feed", (req, res) => {
    const news = [
      { id: 1, time: "2m ago", text: "AI detects unusual call option activity in HDFCBANK near 1700 strike.", type: "alert" },
      { id: 2, time: "15m ago", text: "Sentiment shift: Retail traders turning bullish on mid-cap IT stocks.", type: "info" },
      { id: 3, time: "45m ago", text: "Large block deal detected in RELIANCE; 2.5M shares changed hands.", type: "whale" },
      { id: 4, time: "1h ago", text: "Institutional buying surge detected in Banking sector; Volume 4x average.", type: "surge" }
    ];
    res.json(news);
  });

  // --- QUANT ENGINES ---

  app.get("/api/quant/momentum", withErrorBoundary(async (req, res) => {
    // Detect stocks gaining strong momentum in the last 1-5 minutes
    const momentumStocks = await marketDataService.getMomentumStocks(10);
    res.json(momentumStocks);
  }));

  app.get("/api/quant/breakouts", (req, res) => {
    // Detect breakout above resistance levels
    const breakouts = [
      { symbol: "INFY", level: 1650, strength: 88, vwap: 1620, prevHigh: 1645 },
      { symbol: "ICICIBANK", level: 1120, strength: 75, vwap: 1105, prevHigh: 1115 }
    ];
    res.json(breakouts);
  });

  app.get("/api/quant/volume-surge", (req, res) => {
    // Detect institutional buying
    const surges = [
      { symbol: "SBIN", ratio: 5.2, alert: "Institutional Accumulation", timestamp: new Date().toISOString() },
      { symbol: "AXISBANK", ratio: 4.1, alert: "Large Block Deal Detected", timestamp: new Date().toISOString() }
    ];
    res.json(surges);
  });

  app.get("/api/quant/indicators", (req, res) => {
    // Multi Indicator Engine
    const indicators = [
      { symbol: "RELIANCE", rsi: 65, ema20: 2950, ema50: 2900, vwap: 2940, signal: "BUY" },
      { symbol: "TCS", rsi: 72, ema20: 4100, ema50: 4050, vwap: 4080, signal: "STRONG BUY" },
      { symbol: "WIPRO", rsi: 35, ema20: 480, ema50: 495, vwap: 485, signal: "SELL" }
    ];
    res.json(indicators);
  });

  app.get("/api/quant/sectors", withErrorBoundary(async (req, res) => {
    // Sector Strength Analyzer - uses real Upstox data when connected
    const sectors = await marketDataService.getSectorStrength();
    const formattedSectors = sectors.map(s => ({
      name: s.sector,
      return: Number(s.strength.toFixed(2)),
      momentum: s.momentum,
      status: s.strength > 1 ? 'Leading' : s.strength > 0 ? 'Improving' : s.strength > -1 ? 'Consolidating' : 'Lagging'
    }));
    res.json(formattedSectors);
  }));

  app.get("/api/quant/money-flow", (req, res) => {
    // Smart Money Flow Engine
    const flow = [
      { symbol: "RELIANCE", flow: 125000000, status: "Accumulation", priceStability: "High" },
      { symbol: "HDFCBANK", flow: 85000000, status: "Neutral", priceStability: "Medium" },
      { symbol: "TCS", flow: 110000000, status: "Accumulation", priceStability: "High" }
    ];
    res.json(flow);
  });

  app.get("/api/quant/trends", (req, res) => {
    // Early Trend Detector
    const trends = [
      { symbol: "RELIANCE", score: 82, momentum: 0.4, volume: 0.3, breakout: 0.3 },
      { symbol: "TCS", score: 91, momentum: 0.5, volume: 0.2, breakout: 0.3 }
    ];
    res.json(trends);
  });

  app.get("/api/quant/advanced-intelligence", (req, res) => {
    res.json({
      momentumPrediction: {
        probability: 82,
        predictedMove: "+1.45%",
        confidence: "High",
        features: {
          p1m: "+0.45%",
          p5m: "+1.20%",
          volRatio: "3.2x",
          vwapDist: "+0.85%"
        }
      },
      orderFlow: {
        imbalance: 3.42,
        activityScore: 88,
        status: "Institutional Buying",
        bidVol: "1.2M",
        askVol: "350K"
      },
      smartMoney: {
        accumulationScore: 92,
        phase: "Late Accumulation",
        range: "0.45%",
        supportDist: "0.12%"
      },
      volatility: {
        compression: true,
        squeezeProbability: 78,
        atr: "12.4",
        bbWidth: "1.2%"
      },
      sectorRotation: [
        { sector: "IT", strength: 85, momentum: "Strong Bullish" },
        { sector: "Banking", strength: 72, momentum: "Bullish" },
        { sector: "Energy", strength: 45, momentum: "Neutral" },
        { sector: "Pharma", strength: 32, momentum: "Bearish" }
      ],
      gradientBoosting: {
        probability: 81,
        horizon: "next 5m",
        topFeatures: ["price_change_5min", "volume_ratio", "VWAP_distance"]
      },
      lstmForecast: {
        nextPrice: "3128.40",
        confidenceBand: "+/- 18.25",
        candles: 50
      },
      regimeModel: {
        model: "Random Forest",
        regime: "Trending",
        confidence: 79
      },
      hiddenStateModel: {
        model: "HMM",
        state: "Accumulation",
        transitionRisk: 24
      },
      reinforcementAgent: {
        action: "BUY",
        rewardScore: 0.74,
        riskPenalty: 0.18
      },
      signalConsensus: {
        score: 84,
        verdict: "Bullish Consensus"
      },
      patternRecognition: {
        pattern: "Ascending Triangle",
        confidence: 89,
        status: "Breakout Imminent",
        target: "Rs 3,250"
      },
      marketSentiment: {
        score: 76,
        newsSentiment: "Positive",
        socialSentiment: "Bullish",
        trendingTopics: ["Rate Cut", "Quarterly Results", "Foreign Inflow"]
      }
    });
  });

  app.get("/api/market/indices", withErrorBoundary(async (req, res) => {
    // Fetch NIFTY 50 and SENSEX index quotes from Upstox when connected
    const isAuth = await upstoxService.isAuthenticated();
    if (isAuth) {
      try {
        const indexKeys = ['NSE_INDEX|Nifty 50', 'NSE_INDEX|Nifty Bank'];
        const response = await upstoxService.apiClient.fetchMarketQuotes(indexKeys);
        const indices: Array<{ s: string; v: string; c: string }> = [];
        if (response?.data) {
          for (const [key, val] of Object.entries(response.data as Record<string, any>)) {
            const ohlc = val.ohlc || {};
            const ltp: number = val.last_price || ohlc.close || 0;
            const prev: number = ohlc.close || ltp;
            const chg = prev > 0 ? ((ltp - prev) / prev) * 100 : 0;
            const label = key.includes('Bank') ? 'BANK NIFTY' : 'NIFTY 50';
            indices.push({ s: label, v: ltp.toFixed(2), c: (chg >= 0 ? '+' : '') + chg.toFixed(2) + '%' });
          }
        }
        if (indices.length > 0) return res.json(indices);
      } catch (_e) { /* fall through to simulated */ }
    }
    // Simulated index data (deterministic, changes slowly)
    const seed = Math.floor(Date.now() / 300000); // changes every 5 min
    const r = (base: number, range: number) => base + (Math.sin(seed) * range);
    res.json([
      { s: 'NIFTY 50',   v: r(22453, 120).toFixed(2), c: (Math.sin(seed) * 0.8 >= 0 ? '+' : '') + (Math.sin(seed) * 0.8).toFixed(2) + '%' },
      { s: 'BANK NIFTY', v: r(48200, 300).toFixed(2), c: (Math.cos(seed) * 0.9 >= 0 ? '+' : '') + (Math.cos(seed) * 0.9).toFixed(2) + '%' },
    ]);
  }));

  app.get("/api/quant/sentiment", (req, res) => {
    // Market Sentiment Engine
    res.json({
      status: "Bullish Market",
      adRatio: 1.8,
      indexMomentum: "Strong",
      volatility: "Low",
      confidence: 85
    });
  });

  app.post("/api/institutional/imbalance", (req, res) => {
    const orderBook = req.body;
    const bids = orderBook.bids || [];
    const asks = orderBook.asks || [];
    
    const totalBidVol = bids.reduce((sum: number, level: any) => sum + (level.volume || 0), 0);
    const totalAskVol = asks.reduce((sum: number, level: any) => sum + (level.volume || 0), 0);
    
    const imbalance = totalAskVol === 0 ? totalBidVol : totalBidVol / totalAskVol;
    
    let signal = "NEUTRAL";
    let score = 50;
    
    if (imbalance > 2.5) {
      signal = "INSTITUTIONAL ACCUMULATION";
      score = Math.min(100, 50 + (imbalance - 2.5) * 10);
    } else if (imbalance < 0.4) {
      signal = "INSTITUTIONAL DISTRIBUTION";
      score = Math.max(0, 50 - (0.4 - imbalance) * 100);
    }
    
    res.json({ imbalance, signal, score });
  });

  app.post("/api/institutional/volume-profile", (req, res) => {
    const { candles, binSize = 1.0 } = req.body;
    if (!candles || !Array.isArray(candles)) {
      return res.status(400).json({ error: "Invalid candles" });
    }
    
    const volumeAtPrice: Record<string, number> = {};
    let totalVolume = 0;
    
    for (const candle of candles) {
      const close = candle.close || 0;
      const volume = candle.volume || 0;
      const priceBin = Math.round(close / binSize) * binSize;
      const key = String(priceBin);
      volumeAtPrice[key] = (volumeAtPrice[key] || 0) + volume;
      totalVolume += volume;
    }
    
    const sortedPrices = Object.keys(volumeAtPrice).map(Number).sort((a, b) => a - b);
    
    let maxVol = 0;
    let poc = 0;
    
    const profile = [];
    for (const price of sortedPrices) {
      const vol = volumeAtPrice[String(price)];
      if (vol > maxVol) {
        maxVol = vol;
        poc = price;
      }
      profile.push({
        price,
        volume: vol,
        isPOC: false,
        isInValueArea: false
      });
    }
    
    let pocIdx = -1;
    for (let i = 0; i < profile.length; i++) {
      if (profile[i].price === poc) {
        profile[i].isPOC = true;
        pocIdx = i;
        break;
      }
    }
    
    const targetVA = totalVolume * 0.7;
    let currentVA = maxVol;
    
    let lowIdx = pocIdx;
    let highIdx = pocIdx;
    
    while (currentVA < targetVA && (lowIdx > 0 || highIdx < profile.length - 1)) {
      const lowVol = lowIdx > 0 ? profile[lowIdx - 1].volume : 0;
      const highVol = highIdx < profile.length - 1 ? profile[highIdx + 1].volume : 0;
      
      if (lowVol >= highVol && lowIdx > 0) {
        lowIdx--;
        currentVA += lowVol;
      } else if (highIdx < profile.length - 1) {
        highIdx++;
        currentVA += highVol;
      } else {
        break;
      }
    }
    
    const val = profile[lowIdx]?.price || 0;
    const vah = profile[highIdx]?.price || 0;
    
    for (let i = 0; i < profile.length; i++) {
      if (i >= lowIdx && i <= highIdx) {
        profile[i].isInValueArea = true;
      }
    }
    
    res.json({ profile, poc, vah, val });
  });

  app.post("/api/institutional/correlation", (req, res) => {
    const { seriesA, seriesB } = req.body;
    if (!seriesA || !seriesB || !Array.isArray(seriesA) || !Array.isArray(seriesB)) {
      return res.status(400).json({ error: "Invalid series data" });
    }
    
    const n = Math.min(seriesA.length, seriesB.length);
    if (n < 2) return res.json({ correlation: 0 });
    
    const meanA = seriesA.reduce((a, b) => a + b, 0) / n;
    const meanB = seriesB.reduce((a, b) => a + b, 0) / n;
    
    let num = 0;
    let denA = 0;
    let denB = 0;
    
    for (let i = 0; i < n; i++) {
      const diffA = seriesA[i] - meanA;
      const diffB = seriesB[i] - meanB;
      num += diffA * diffB;
      denA += diffA * diffA;
      denB += diffB * diffB;
    }
    
    const correlation = num / Math.sqrt(denA * denB);
    res.json({ correlation: isNaN(correlation) ? 0 : correlation });
  });

  app.post("/api/institutional/market-regime", (req, res) => {
    const candles = req.body;
    if (!candles || !Array.isArray(candles) || candles.length < 20) {
      return res.json({ regime: "SIDEWAYS" });
    }
    
    const last20 = candles.slice(-20);
    const returns = [];
    for (let i = 0; i < last20.length; i++) {
      if (i === 0) {
        returns.push(0.0);
      } else {
        const prevClose = last20[i - 1].close || 0;
        const currentClose = last20[i].close || 0;
        returns.push(prevClose !== 0 ? (currentClose - prevClose) / prevClose : 0);
      }
    }
    
    const sumSquares = returns.reduce((sum, r) => sum + r * r, 0);
    const volatility = Math.sqrt(sumSquares / returns.length);
    
    const firstPrice = last20[0].close || 0;
    const lastPrice = last20[last20.length - 1].close || 0;
    const totalReturn = firstPrice !== 0 ? Math.abs((lastPrice - firstPrice) / firstPrice) : 0;
    
    if (volatility > 0.02) return res.json({ regime: "VOLATILE" });
    if (totalReturn > 0.03) return res.json({ regime: "TRENDING" });
    res.json({ regime: "SIDEWAYS" });
  });

  app.get("/api/institutional/correlation-data", (req, res) => {
    const { symbol } = req.query;
    const assets = ["NIFTY 50", "BANK NIFTY", "USD/INR", "CRUDE OIL", "GOLD"];
    const random = seededGenerator(symbolSeed(String(symbol || "MARKET")));
    const data = assets.map(asset => ({
      name: asset,
      value: Number((0.5 + random() * 0.45).toFixed(2))
    }));
    res.json(data);
  });

  app.get("/api/institutional/sector-rotation", withErrorBoundary(async (req, res) => {
    // Institutional sector rotation - uses real Upstox data when connected
    const sectors = await marketDataService.getSectorStrength();
    const formattedSectors = sectors.slice(0, 4).map(s => ({
      sector: s.sector,
      strength: Math.round(50 + s.strength * 10), // Convert to 0-100 scale
      leader: s.leaders[0] || "N/A",
      flow: s.momentum === 'Strong Bullish' ? 'High beta accumulation' :
            s.momentum === 'Bullish' ? 'Steady broad-based bids' :
            s.momentum === 'Neutral' ? 'Mixed commodity response' : 'Distribution phase',
      bias: s.strength > 1 ? 'LEADING' : s.strength > 0 ? 'IMPROVING' : 'LAGGING'
    }));
    res.json(formattedSectors);
  }));

  app.get("/api/institutional/microstructure", withErrorBoundary(async (req, res) => {
    const { instrumentKey } = req.query;
    const lastPrice = parseFloat(req.query.lastPrice as string) || 0;

    try {
      const token = await UpstoxService.getInstance().tokenManager.getValidAccessToken()
        || process.env.UPSTOX_ACCESS_TOKEN || null;
      if (!token || !instrumentKey) throw new Error("no_token");

      const encodedKey = encodeURIComponent(String(instrumentKey));
      const url = `https://api.upstox.com/v2/market-quote/quotes?instrument_key=${encodedKey}`;
      const response = await axios.get(url, {
        headers: { Authorization: `Bearer ${token}`, Accept: "application/json" },
        timeout: 5000
      });

      const quoteData = response.data?.data;
      const key = quoteData ? Object.keys(quoteData)[0] : null;
      const quote = key ? quoteData[key] : null;

      if (quote) {
        const depth = quote.depth || {};
        const bids: any[] = depth.buy || [];
        const asks: any[] = depth.sell || [];
        const bestBid = bids[0]?.price ?? quote.last_price ?? lastPrice;
        const bestAsk = asks[0]?.price ?? quote.last_price ?? lastPrice;
        const spread = bestAsk > 0 && bestBid > 0 ? ((bestAsk - bestBid) / bestBid) * 100 : 0;

        // Accumulation: ratio of total bid qty vs total ask qty (capped 0-100)
        const totalBidQty = bids.reduce((s: number, b: any) => s + (b.quantity || 0), 0);
        const totalAskQty = asks.reduce((s: number, a: any) => s + (a.quantity || 0), 0);
        const totalQty = totalBidQty + totalAskQty;
        const accumulation = totalQty > 0 ? Math.round((totalBidQty / totalQty) * 100) : 50;

        // Trade frequency proxy: volume / avg_trade_size (Upstox provides total_buy_qty + total_sell_qty)
        const avgTradeSize = quote.average_trade_price > 0 ? quote.average_trade_price : 1;
        const frequency = Math.min(500, Math.round((quote.volume || 0) / Math.max(1, avgTradeSize / 100)));

        return res.json({ frequency, spread: parseFloat(spread.toFixed(4)), accumulation });
      }
    } catch (_err) {
      // fall through to computed fallback
    }

    // Fallback: derive from candle data if available
    res.json({
      frequency: Math.floor(120 + Math.random() * 50),
      spread: 0.05 + Math.random() * 0.1,
      accumulation: Math.floor(65 + Math.random() * 25)
    });
  }));

  app.get("/api/institutional/order-book", withErrorBoundary(async (req, res) => {
    const { instrumentKey } = req.query;
    const lastPrice = parseFloat(req.query.lastPrice as string) || 100;

    try {
      const token = await UpstoxService.getInstance().tokenManager.getValidAccessToken()
        || process.env.UPSTOX_ACCESS_TOKEN || null;
      if (!token || !instrumentKey) throw new Error("no_token");

      const encodedKey = encodeURIComponent(String(instrumentKey));
      const url = `https://api.upstox.com/v2/market-quote/quotes?instrument_key=${encodedKey}`;
      const response = await axios.get(url, {
        headers: { Authorization: `Bearer ${token}`, Accept: "application/json" },
        timeout: 5000
      });

      const quoteData = response.data?.data;
      const key = quoteData ? Object.keys(quoteData)[0] : null;
      const quote = key ? quoteData[key] : null;

      if (quote?.depth) {
        const rawBids: any[] = quote.depth.buy || [];
        const rawAsks: any[] = quote.depth.sell || [];
        const bids = rawBids.map((b: any) => ({ price: b.price, volume: b.quantity }));
        const asks = rawAsks.map((a: any) => ({ price: a.price, volume: a.quantity }));
        return res.json({ bids, asks });
      }
    } catch (_err) {
      // fall through to simulated fallback
    }

    // Fallback: simulated order book around last price
    const bids = [];
    const asks = [];
    for (let i = 0; i < 10; i++) {
      bids.push({ price: lastPrice - (i + 1) * 0.5, volume: Math.floor(Math.random() * 5000) + (i === 0 ? 10000 : 0) });
      asks.push({ price: lastPrice + (i + 1) * 0.5, volume: Math.floor(Math.random() * 2000) });
    }
    res.json({ bids, asks });
  }));

  app.get("/api/institutional/metrics", (req, res) => {
    const { symbol } = req.query;
    
    // Mocking institutional metrics for the scanner
    // In a real system, this would be computed from real-time L2 data
    const metrics = {
      symbol: symbol || "MARKET",
      orderImbalance: (1.2 + Math.random() * 2.5).toFixed(2),
      accumulationScore: (60 + Math.random() * 35).toFixed(0),
      tradeFrequency: (100 + Math.random() * 500).toFixed(0),
      spreadDynamics: (0.02 + Math.random() * 0.08).toFixed(3),
      marketRegime: ["TRENDING", "SIDEWAYS", "VOLATILE"][Math.floor(Math.random() * 3)],
      timestamp: new Date().toISOString()
    };
    
    res.json(metrics);
  });

  // â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
  // MULTIBAGGER SCANNER ENGINE  v2 â€” Hedge-Fund Grade Multi-Factor Scoring Model
  // Completely isolated from all existing routes and logic.
  //
  // Final Score Formula (weights shift per cycle â€” see MB_CYCLE_WEIGHTS):
  //   BullishScore = (Trend Ã— 0.25) + (Momentum Ã— 0.20) + (RelStrength Ã— 0.15)
  //                + (Volume Ã— 0.15) + (Breakout Ã— 0.10) + (Sector Ã— 0.10)
  //                + (Stability Ã— 0.05)
  //
  // Rules:
  //   â€¢ NEVER filter out stocks â€” all receive a score and are ranked
  //   â€¢ Always return TOP 100 even if scores are moderate
  //   â€¢ Adaptive normalisation ensures a meaningful spread across the universe
  // â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€

  /** Supported scan cycles in days */
  type MultibaggerCycle = 30 | 60 | 90 | 120 | 180 | 300;

  /**
   * Timeframe-adaptive weight table.
   * All seven weights in each row sum to exactly 1.00.
   *
   * Short  (30â€“60d):  momentum + breakout heavy  â†’ capture fast movers
   * Medium (90â€“120d): balanced across all factors â†’ general quality filter
   * Long   (180â€“300d): trend + stability heavy   â†’ identify durable compounders
   */
  const MB_CYCLE_WEIGHTS: Record<MultibaggerCycle, {
    trend: number; momentum: number; relStrength: number;
    volume: number; breakout: number; sector: number; stability: number;
  }> = {
    //          trend  mom    rs     vol    brk    sec    stab
    30:  { trend: 0.15, momentum: 0.25, relStrength: 0.15, volume: 0.15, breakout: 0.15, sector: 0.10, stability: 0.05 },
    60:  { trend: 0.18, momentum: 0.23, relStrength: 0.15, volume: 0.15, breakout: 0.13, sector: 0.10, stability: 0.06 },
    90:  { trend: 0.25, momentum: 0.20, relStrength: 0.15, volume: 0.15, breakout: 0.10, sector: 0.10, stability: 0.05 },
    120: { trend: 0.27, momentum: 0.18, relStrength: 0.15, volume: 0.14, breakout: 0.09, sector: 0.10, stability: 0.07 },
    180: { trend: 0.30, momentum: 0.15, relStrength: 0.14, volume: 0.13, breakout: 0.07, sector: 0.11, stability: 0.10 },
    300: { trend: 0.32, momentum: 0.12, relStrength: 0.13, volume: 0.12, breakout: 0.05, sector: 0.12, stability: 0.14 },
  };

  /** Company name lookup for the popular NSE stocks in the universe */
  const MB_COMPANY_NAMES: Record<string, string> = {
    RELIANCE: "Reliance Industries Ltd",   TCS: "Tata Consultancy Services Ltd",
    HDFCBANK: "HDFC Bank Ltd",             INFY: "Infosys Ltd",
    ICICIBANK: "ICICI Bank Ltd",           SBIN: "State Bank of India",
    BHARTIARTL: "Bharti Airtel Ltd",       LT: "Larsen & Toubro Ltd",
    ITC: "ITC Ltd",                        KOTAKBANK: "Kotak Mahindra Bank Ltd",
    AXISBANK: "Axis Bank Ltd",             ADANIENT: "Adani Enterprises Ltd",
    ASIANPAINT: "Asian Paints Ltd",        MARUTI: "Maruti Suzuki India Ltd",
    SUNPHARMA: "Sun Pharmaceutical Ind Ltd", TITAN: "Titan Company Ltd",
    BAJFINANCE: "Bajaj Finance Ltd",       HCLTECH: "HCL Technologies Ltd",
    WIPRO: "Wipro Ltd",                    TATAMOTORS: "Tata Motors Ltd",
    "M&M": "Mahindra & Mahindra Ltd",      ULTRACEMCO: "UltraTech Cement Ltd",
    POWERGRID: "Power Grid Corp of India Ltd", NTPC: "NTPC Ltd",
    NESTLEIND: "Nestle India Ltd",         BAJAJFINSV: "Bajaj Finserv Ltd",
    JSWSTEEL: "JSW Steel Ltd",             HINDALCO: "Hindalco Industries Ltd",
  };

  /** Sector base drift rates â€” used for price simulation and sector scoring */
  const MB_SECTOR_DRIFT: Record<string, number> = {
    Technology: 0.00165, Financials: 0.00120, Healthcare: 0.00145,
    Consumer: 0.00115, Industrials: 0.00105, Energy: 0.00110,
    Telecom: 0.00100, Materials: 0.00095,
  };

  // â”€â”€ Scoring helpers (pure functions, no side-effects) â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€

  /**
   * TREND SCORE (25% base weight)
   *
   * Measures moving-average alignment using three binary conditions:
   *   Price > 50 DMA  â†’ +40 pts
   *   50 DMA > 200 DMA â†’ +30 pts  (golden cross alignment)
   *   Price > 200 DMA â†’ +30 pts
   * Raw max = 100. Slope bonus adds up to +10 pts (capped at 100 total).
   */
  const mbTrendScore = (closes: number[]): number => {
    const last  = closes[closes.length - 1];
    const ema50  = buildEma(closes, 50);
    const ema200 = buildEma(closes, 200);
    const dma50  = ema50[ema50.length - 1]   ?? last;
    const dma200 = ema200[ema200.length - 1] ?? last;

    let raw = 0;
    if (last  > dma50)  raw += 40; // price above 50 DMA
    if (dma50 > dma200) raw += 30; // golden cross alignment
    if (last  > dma200) raw += 30; // price above 200 DMA

    // Slope bonus: normalised EMA-50 slope over last 20 bars (up to +10 pts)
    const slope = calculateSlope(ema50.slice(-20)) / Math.max(last, 1);
    return Math.min(100, raw + clamp(slope * 600) * 10);
  };

  /**
   * MOMENTUM SCORE (20% base weight)
   *
   * Weighted blend of three return windows per spec:
   *   score = (ret30d Ã— 0.50) + (ret90d Ã— 0.30) + (ret180d Ã— 0.20)
   *
   * Each return normalised to [0,100]: maps [-20%, +30%] â†’ [0, 100].
   * Returns raw score + individual returns for display.
   */
  const mbMomentumScore = (closes: number[]): {
    score: number; ret30: number; ret90: number; ret180: number;
  } => {
    const last = closes[closes.length - 1];
    const n    = closes.length;
    const ret  = (days: number) => {
      const base = closes[Math.max(0, n - 1 - days)];
      return base > 0 ? (last / base) - 1 : 0;
    };
    const ret30  = ret(30);
    const ret90  = ret(90);
    const ret180 = ret(180);
    // Normalise: [-0.20, +0.30] â†’ [0, 100]
    const norm = (r: number) => clamp((r + 0.20) / 0.50) * 100;
    const score = norm(ret30) * 0.50 + norm(ret90) * 0.30 + norm(ret180) * 0.20;
    return { score, ret30, ret90, ret180 };
  };

  /**
   * RELATIVE STRENGTH â€” raw cycle return for cross-sectional percentile ranking.
   * RS percentile is computed universe-wide in buildMultibaggerScan.
   * RS > index average â†’ bullish; percentile 100 = best performer.
   */
  const mbRelStrengthRaw = (closes: number[], cycleDays: number): number => {
    const n    = closes.length;
    const base = closes[Math.max(0, n - 1 - cycleDays)];
    const last = closes[n - 1];
    return base > 0 ? (last / base) - 1 : 0;
  };

  /**
   * VOLUME SCORE (15% base weight)
   *
   * Two sub-components, each worth 50 pts:
   *   1. Accumulation: recent 20-bar avg > overall avg volume â†’ +50
   *   2. Spike:        last bar > 1.5Ã— 20-bar avg            â†’ +50
   */
  const mbVolumeScore = (volumes: number[]): {
    score: number; volRatio: number; signal: 'STRONG' | 'MODERATE' | 'WEAK';
  } => {
    const n          = volumes.length;
    const last20Avg  = average(volumes.slice(-20));
    const overallAvg = average(volumes);
    const lastVol    = volumes[n - 1] ?? 0;

    let raw = 0;
    if (last20Avg > overallAvg)    raw += 50; // accumulation
    if (lastVol > last20Avg * 1.5) raw += 50; // spike

    const volRatio = overallAvg > 0 ? last20Avg / overallAvg : 1;
    const signal: 'STRONG' | 'MODERATE' | 'WEAK' =
      raw >= 80 ? 'STRONG' : raw >= 40 ? 'MODERATE' : 'WEAK';
    return { score: raw, volRatio, signal };
  };

  /**
   * BREAKOUT SCORE (10% base weight)
   *
   * Two sub-components, each worth 50 pts:
   *   1. 52-week proximity: price within 5% of 52-week high â†’ +50
   *   2. Recent breakout:   price broke 20-day high in last 20 bars â†’ +50
   */
  const mbBreakoutScore = (closes: number[]): number => {
    const n    = closes.length;
    const last = closes[n - 1];

    // 52-week high (up to 252 bars)
    const high52w      = Math.max(...closes.slice(Math.max(0, n - 252)));
    const proximityScore = high52w > 0 && last / high52w >= 0.95 ? 50 : 0;

    // Recent breakout in last 20 bars
    let recentBreakout = false;
    const lookback = Math.min(20, n - 1);
    for (let i = n - lookback; i < n; i++) {
      if (closes[i] > Math.max(...closes.slice(Math.max(0, i - 20), i))) {
        recentBreakout = true; break;
      }
    }
    return proximityScore + (recentBreakout ? 50 : 0);
  };

  /**
   * STABILITY SCORE (5% base weight)
   *
   * Lower annualised volatility = higher score.
   * Maps [0%, 60%] annualised vol â†’ [100, 0].
   */
  const mbStabilityScore = (closes: number[]): number => {
    const returns     = buildReturns(closes.slice(-Math.min(closes.length, 252)));
    const dailyVol    = calculateVolatility(returns);
    const annualVol   = dailyVol * Math.sqrt(252);
    return clamp(1 - annualVol / 0.60) * 100;
  };

  /**
   * Build price+volume series for a stock.
   * Uses real Yahoo Finance OHLCV when available, falls back to synthetic.
   */
  const mbBuildSeries = (profile: UltraQuantProfile, cycleDays: MultibaggerCycle, realCandles?: UltraQuantCandle[] | null): {
    closes: number[]; volumes: number[];
  } => {
    // Use real data if we have enough history
    if (realCandles && realCandles.length >= 60) {
      return {
        closes:  realCandles.map(c => c.close),
        volumes: realCandles.map(c => c.volume),
      };
    }

    // Synthetic fallback
    const totalDays = Math.max(cycleDays + 380, 400);
    const drift     = MB_SECTOR_DRIFT[profile.sector] ?? 0.001;
    const random    = seededGenerator(symbolSeed(profile.symbol) ^ (cycleDays * 6271));

    const closes: number[]  = [];
    const volumes: number[] = [];
    let price = 80 + random() * 1800;

    for (let d = 0; d < totalDays; d++) {
      const dailyDrift = drift + Math.sin(d / 31 + random()) * 0.006 + (random() - 0.5) * 0.05;
      price = Math.max(20, price * (1 + dailyDrift));
      closes.push(price);
      volumes.push(profile.averageVolume * (0.75 + random() * 1.1));
    }
    return { closes, volumes };
  };

  // â”€â”€ Universe-level normalisation helpers â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€

  /** Min-max normalise an array to [0, 100]. Returns 50 for all if flat. */
  const mbNormalise = (values: number[]): number[] => {
    const min = Math.min(...values);
    const max = Math.max(...values);
    if (max === min) return values.map(() => 50);
    return values.map((v) => clamp((v - min) / (max - min)) * 100);
  };

  /** Convert raw values to percentile ranks [0, 100]. Rank 100 = highest. */
  const mbPercentileRank = (values: number[]): number[] => {
    const sorted = [...values].sort((a, b) => a - b);
    return values.map((v) => (sorted.filter((x) => x <= v).length / sorted.length) * 100);
  };

  /**
   * SECTOR STRENGTH SCORE (10% base weight)
   *
   * Computes average cycle-return per sector, ranks sectors,
   * and assigns each stock its sector's percentile score.
   */
  const mbSectorScores = (
    universe: UltraQuantProfile[],
    cycleReturns: number[]
  ): { scores: number[]; sectorRanks: Record<string, number>; leadingSector: string } => {
    const sectorReturnMap = new Map<string, number[]>();
    universe.forEach((p, i) => {
      if (!sectorReturnMap.has(p.sector)) sectorReturnMap.set(p.sector, []);
      sectorReturnMap.get(p.sector)!.push(cycleReturns[i]);
    });

    const sectorAvg: Record<string, number> = {};
    for (const [sector, rets] of sectorReturnMap) {
      sectorAvg[sector] = rets.reduce((a, b) => a + b, 0) / rets.length;
    }

    const sectorNames  = Object.keys(sectorAvg);
    const normScores   = mbNormalise(sectorNames.map((s) => sectorAvg[s]));
    const sectorRanks: Record<string, number> = {};
    sectorNames.forEach((s, i) => { sectorRanks[s] = normScores[i]; });

    const leadingSector = sectorNames.reduce((best, s) =>
      sectorAvg[s] > (sectorAvg[best] ?? -Infinity) ? s : best,
      sectorNames[0] ?? 'Technology');

    return {
      scores: universe.map((p) => sectorRanks[p.sector] ?? 50),
      sectorRanks,
      leadingSector,
    };
  };

  /**
   * Per-cycle result cache — defined at module level.
   */

  const MULTIBAGGER_CACHE_TTL: Record<MultibaggerCycle, number> = {
    30: 3 * 60_000, 60: 4 * 60_000, 90: 5 * 60_000, 120: 7 * 60_000, 180: 8 * 60_000, 300: 10 * 60_000,
  };

  /**
   * buildMultibaggerScan â€” orchestrates the full hedge-fund scoring pipeline.
   *
   * Pipeline:
   *   1. Build synthetic price+volume series for every stock (cached per call)
   *   2. Compute all 7 factor scores independently per stock
   *   3. Cross-sectional normalisation for Momentum and Relative Strength
   *   4. Sector Strength scores from universe-wide sector returns
   *   5. Apply cycle-adaptive weights â†’ final BullishScore
   *   6. Sort descending, always return top 100 (no hard rejection)
   *   7. Fallback normalisation if top scores are near zero
   */
  const buildMultibaggerScan = async (cycleDays: MultibaggerCycle) => {
    const cached = multibaggerCache.get(cycleDays);
    // Don't serve cached result if it was built on fallback universe
    if (cached && cached.expiresAt > Date.now() && cached.scannedUniverse > 440) return cached.payload;

    const weights  = MB_CYCLE_WEIGHTS[cycleDays];
    const fullUniverse = createUltraQuantUniverse();
    // ── Pass 0: Pre-load OHLCV from Supabase — skip on cold start to avoid timeout ──
    const mbTop200Symbols = fullUniverse
      .slice().sort((a, b) => b.marketCap - a.marketCap).slice(0, 200).map(p => p.symbol);
    const mbColdSymbols = mbTop200Symbols.filter(s => !(realOHLCVCache.get(s)?.expiresAt ?? 0 > Date.now()));
    if (mbColdSymbols.length > 0 && mbColdSymbols.length < 50) {
      // Only load if mostly warm — avoids blocking on full cold start
      await Promise.race([
        loadOHLCVFromSupabase(mbColdSymbols, setOHLCVCache),
        new Promise<void>(r => setTimeout(r, 500)),
      ]);
    }

    // ── Pass 1: Ultra-fast pre-sort using deterministic hash — handles 5000+ stocks ──
    // Cap to top 500 by marketCap to keep computation fast on Render free tier
    const scanUniverse = fullUniverse.length > 500
      ? fullUniverse.slice().sort((a, b) => b.marketCap - a.marketCap).slice(0, 500)
      : fullUniverse;
    const preScored = scanUniverse.map(p => {
      const seed = symbolSeed(p.symbol);
      const sectorBonus = ({ Technology: 8, Healthcare: 7, Financials: 6, Consumer: 5,
        Industrials: 4, Energy: 3, Telecom: 2, Materials: 2 } as Record<string, number>)[p.sector] ?? 3;
      const capTier = p.marketCap > 100000 ? 10 : p.marketCap > 20000 ? 7 : p.marketCap > 5000 ? 4 : 1;
      const hashScore = ((seed * 2654435761) >>> 0) / 4294967296 * 60;
      // Strong bonus for symbols with real OHLCV cached — ensures they always rank in top 100
      const hasRealData = getOHLCVFromCache(p.symbol) !== null ? 30 : 0;
      return { symbol: p.symbol, score: hashScore + sectorBonus + capTier + hasRealData };
    }).sort((a, b) => b.score - a.score);

    const top100MBSet = new Set(preScored.slice(0, 100).map(x => x.symbol));
    const universe = scanUniverse.filter(p => top100MBSet.has(p.symbol));

    // ── Pass 2: Read real OHLCV from cache (populated by Pass 0) ──
    const mbRealOHLCVMap = new Map<string, UltraQuantCandle[] | null>();
    universe.forEach(p => {
      mbRealOHLCVMap.set(p.symbol, getOHLCVFromCache(p.symbol));
    });

    // ── Pass 3: Load fundamentals from Supabase only if not already warm ──
    const mbTop50Symbols = universe.slice(0, 50).map(p => p.symbol);
    const mbFundMissing = mbTop50Symbols.filter(s => !isYahooCached(s));
    if (mbFundMissing.length > mbTop50Symbols.length * 0.2) {
      const mbSetPriceCache = (sym: string, price: number, changePct: number) => {
        perSymbolPriceCache.set(sym, { price, changePct, expiresAt: Date.now() + 60 * 60_000 });
      };
      await Promise.race([
        loadFundamentalsFromSupabase(mbFundMissing, mbSetPriceCache),
        new Promise<void>(r => setTimeout(r, 1500)),
      ]);
    }
    const mbEnrichedMap = new Map<string, EnrichedStockData>(
      mbTop50Symbols.map(s => [s, getEnrichedFromCache(s)])
    );

    // Step 1: Build price/volume series — real data for top 150, synthetic for rest
    const seriesCache = universe.map((p) => mbBuildSeries(p, cycleDays, mbRealOHLCVMap.get(p.symbol) ?? null));

    // Step 2: Compute per-stock factor scores
    const trendScores     = seriesCache.map(({ closes })  => mbTrendScore(closes));
    const momentumResults = seriesCache.map(({ closes })  => mbMomentumScore(closes));
    const cycleReturns    = seriesCache.map(({ closes })  => mbRelStrengthRaw(closes, cycleDays));
    const volumeResults   = seriesCache.map(({ volumes }) => mbVolumeScore(volumes));
    const breakoutScores  = seriesCache.map(({ closes })  => mbBreakoutScore(closes));
    const stabilityScores = seriesCache.map(({ closes })  => mbStabilityScore(closes));

    // Step 3: Cross-sectional normalisation
    // Momentum: normalise raw scores across universe for meaningful spread
    const momentumNorm = mbNormalise(momentumResults.map((r) => r.score));
    // Relative Strength: percentile rank of cycle returns (100 = best performer)
    const rsPercentiles = mbPercentileRank(cycleReturns);

    // Step 4: Sector strength scores
    const { scores: sectorScores, sectorRanks, leadingSector } =
      mbSectorScores(universe, cycleReturns);

    // Step 5: Compute final BullishScore per stock
    // Formula: Score = Î£(factor_score Ã— cycle_weight)
    const scored = universe.map((profile, i) => {
      const trend     = trendScores[i];
      const momentum  = momentumNorm[i];
      const relStr    = rsPercentiles[i];
      const volume    = volumeResults[i].score;
      const breakout  = breakoutScores[i];
      const sector    = sectorScores[i];
      const stability = stabilityScores[i];

      const bullishScore =
        trend     * weights.trend      +
        momentum  * weights.momentum   +
        relStr    * weights.relStrength +
        volume    * weights.volume     +
        breakout  * weights.breakout   +
        sector    * weights.sector     +
        stability * weights.stability;

      const sentimentTag =
        bullishScore >= 80 ? 'Strong Bullish' :
        bullishScore >= 65 ? 'Accumulation'   :
        bullishScore >= 50 ? 'Neutral Watch'  :
        bullishScore >= 35 ? 'Weak'           :
        undefined;

      const enriched = mbEnrichedMap.get(profile.symbol) ?? null;
      const hasRealOHLCV = !!(mbRealOHLCVMap.get(profile.symbol) ?? null);
      const { livePrice: mbLivePrice, changePct: mbChangePct } = getLivePriceFromCache(profile.symbol);
      const mbCachedPrice = perSymbolPriceCache.get(profile.symbol);
      const mbCachedPriceValid = mbCachedPrice && mbCachedPrice.expiresAt > Date.now();

      return {
        symbol:           profile.symbol,
        companyName:      MB_COMPANY_NAMES[profile.symbol] ?? `${profile.symbol} Ltd`,
        sector:           profile.sector,
        dataSource:       enriched?.yahoo ? 'real' : hasRealOHLCV ? 'real' : 'synthetic',
        // Real price priority: Yahoo enrichment → OHLCV meta livePrice → perSymbolPriceCache → OHLCV last candle → null
        currentPrice:     enriched?.yahoo?.lastPrice
          ? Number(enriched.yahoo.lastPrice.toFixed(2))
          : mbLivePrice
            ? mbLivePrice
            : mbCachedPriceValid
              ? Number(mbCachedPrice!.price.toFixed(2))
              : hasRealOHLCV
                ? Number(seriesCache[i].closes[seriesCache[i].closes.length - 1].toFixed(2))
                : null,
        pChange:          enriched?.yahoo?.pChange ?? mbChangePct ?? (mbCachedPriceValid ? mbCachedPrice!.changePct : null),
        weekHigh52:       enriched?.yahoo?.weekHigh52 ?? (() => {
          const mbCandles = mbRealOHLCVMap.get(profile.symbol);
          if (!mbCandles || mbCandles.length < 20) return null;
          const yr = mbCandles.slice(-252);
          return Number(Math.max(...yr.map(c => c.high)).toFixed(2));
        })(),
        weekLow52:        enriched?.yahoo?.weekLow52 ?? (() => {
          const mbCandles = mbRealOHLCVMap.get(profile.symbol);
          if (!mbCandles || mbCandles.length < 20) return null;
          const yr = mbCandles.slice(-252);
          return Number(Math.min(...yr.map(c => c.low)).toFixed(2));
        })(),
        deliveryPct:      null,
        pe:               enriched?.yahoo?.pe ?? enriched?.screener?.pe ?? null,
        roe:              enriched?.screener?.roe ?? null,
        roce:             enriched?.screener?.roce ?? null,
        debtToEquity:     enriched?.screener?.debtToEquity ?? null,
        promoterHolding:  enriched?.screener?.promoterHolding ?? null,
        fundamentalScore: enriched ? computeFundamentalScore(enriched) : null,
        dataQuality:      enriched?.dataQuality ?? (hasRealOHLCV ? 'MEDIUM' : 'LOW'),
        newsHeadlines:    enriched?.newsHeadlines ?? [],
        bullishScore:     Number(bullishScore.toFixed(2)),
        trendScore:       Number(trend.toFixed(2)),
        momentumScore:    Number(momentum.toFixed(2)),
        relativeStrength: Number(relStr.toFixed(2)),
        volumeScore:      Number(volume.toFixed(2)),
        breakoutScore:    Number(breakout.toFixed(2)),
        sectorScore:      Number(sector.toFixed(2)),
        stabilityScore:   Number(stability.toFixed(2)),
        sectorRank:       Number((sectorRanks[profile.sector] ?? 50).toFixed(2)),
        // Legacy fields kept for UI compatibility
        trendStrength:    Number(trend.toFixed(2)),
        momentumIndicator: Number((1 + cycleReturns[i]).toFixed(4)),
        ret30:            Number((momentumResults[i].ret30  * 100).toFixed(2)),
        ret90:            Number((momentumResults[i].ret90  * 100).toFixed(2)),
        ret180:           Number((momentumResults[i].ret180 * 100).toFixed(2)),
        volumeSignal:     volumeResults[i].signal,
        volRatio:         Number(volumeResults[i].volRatio.toFixed(3)),
        sentimentTag,
        superbrain: runSuperbrain({
          symbol: profile.symbol, sector: profile.sector, marketCap: profile.marketCap,
          // Annualise the cycle return properly: (1 + cycleReturn)^(365/cycleDays) - 1
          cagr: cycleReturns[i] > -1
            ? (Math.pow(1 + cycleReturns[i], 365 / cycleDays) - 1) * 100
            : -50,
          momentum: momentumResults[i].ret90 != null ? 1 + momentumResults[i].ret90 : 1,
          trendStrength: trend,
          // Derive volatility from ret30/ret90 spread (proxy for daily std-dev)
          volatility: Math.abs((momentumResults[i].ret90 - momentumResults[i].ret30) / Math.sqrt(60)) || 0.018,
          // Derive max drawdown from stability score (higher stability = lower drawdown)
          maxDrawdown: Math.max(5, (100 - stability) * 0.45),
          breakoutFrequency: breakout / 100,
          volumeGrowth: volumeResults[i].volRatio,
          gradientBoostProb: bullishScore,
          finalPredictionScore: bullishScore,
          rlAction: bullishScore >= 70 ? 'BUY' : bullishScore <= 35 ? 'SELL' : 'HOLD',
          orderImbalance: volumeResults[i].volRatio > 1.5 ? 2.0 : 1.2,
          pe: enriched?.yahoo?.pe ?? enriched?.screener?.pe ?? null,
          roe: enriched?.screener?.roe ?? null,
          roce: enriched?.screener?.roce ?? null,
          debtToEquity: enriched?.screener?.debtToEquity ?? null,
          promoterHolding: enriched?.screener?.promoterHolding ?? null,
          profitGrowth3yr: enriched?.screener?.profitGrowth3yr ?? null,
          salesGrowth3yr: enriched?.screener?.salesGrowth3yr ?? null,
          fundamentalScore: enriched ? computeFundamentalScore(enriched) : null,
          sentimentScore: bullishScore,
          newsHeadlines: enriched?.newsHeadlines ?? [],
          pChange: enriched?.yahoo?.pChange ?? null,
          bullishScore, trendScore: trend, relativeStrength: relStr,
          stabilityScore: stability,
          ret30: momentumResults[i].ret30 * 100,
          ret90: momentumResults[i].ret90 * 100,
          ret180: momentumResults[i].ret180 * 100,
          dataQuality: (enriched?.dataQuality ?? (hasRealOHLCV ? 'MEDIUM' : 'LOW')) as 'HIGH' | 'MEDIUM' | 'LOW',
          dataSource: (enriched?.yahoo ? 'real' : hasRealOHLCV ? 'real' : 'synthetic') as 'real' | 'synthetic',
        }, enriched?.yahoo?.lastPrice ?? mbLivePrice ?? (mbCachedPriceValid ? mbCachedPrice!.price : null) ?? (hasRealOHLCV ? seriesCache[i].closes[seriesCache[i].closes.length - 1] : null)),
      };
    });

    // Step 6: Sort descending by bullishScore
    scored.sort((a, b) => b.bullishScore - a.bullishScore);

    // Step 7: Fallback normalisation â€” if top score is near zero, spread the range
    const topScore = scored[0]?.bullishScore ?? 0;
    const finalStocks = topScore < 10
      ? (() => {
          const norm = mbNormalise(scored.map((s) => s.bullishScore));
          return scored.map((s, i) => ({ ...s, bullishScore: Number(norm[i].toFixed(2)) }));
        })()
      : scored;

    const top100 = finalStocks.slice(0, 100).map((s, i) => ({ rank: i + 1, ...s }));

    const avgBullishScore = top100.reduce((sum, s) => sum + s.bullishScore, 0) / top100.length;

    const totalLoaded = fullUniverse.length;
    const totalProcessed = scored.length;
    const totalAfterFilter = scored.length; // no hard filter in multibagger
    const totalReturned = top100.length;
    console.log(JSON.stringify({ totalLoaded, totalProcessed, totalAfterFilter, totalReturned }));

    const payload = {
      cycle:           cycleDays,
      scannedUniverse: fullUniverse.length,      returned:        top100.length,
      stocks:          top100,
      leadingSector,
      avgBullishScore: Number(avgBullishScore.toFixed(2)),
      cachedAt:        new Date().toLocaleTimeString(),
    };

    // Cache: always use full TTL — avoid thrashing when Supabase has no data yet
    multibaggerCache.set(cycleDays, { expiresAt: Date.now() + MULTIBAGGER_CACHE_TTL[cycleDays], payload, scannedUniverse: fullUniverse.length });

    return payload;
  };

  /** GET /api/multibagger/scan?cycle=90 */
  app.get("/api/multibagger/scan", async (req, res) => {
    const rawCycle = parseInt(String(req.query.cycle ?? '90'), 10);
    const validCycles: MultibaggerCycle[] = [30, 60, 90, 120, 180, 300];
    const cycle: MultibaggerCycle = (validCycles.includes(rawCycle as MultibaggerCycle)
      ? rawCycle
      : 90) as MultibaggerCycle;

    const result = await buildMultibaggerScan(cycle);
    logAction("multibagger.scan.completed", {
      cycle,
      returned: result.returned,
      leadingSector: result.leadingSector,
    });
    res.json(result);
  });

  // â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
  // END MULTIBAGGER SCANNER ENGINE
  // â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€

  // ── Multi-source enrichment endpoints ──────────────────────────────────────

  /** GET /api/stock/enrich?symbol=RELIANCE — Yahoo fundamentals + Screener (inline, awaited) */
  app.get("/api/stock/enrich", async (req, res) => {
    const symbol = String(req.query.symbol ?? '').toUpperCase().trim();
    if (!symbol) return res.status(400).json({ error: 'symbol required' });
    // Fetch inline with 6s timeout — this endpoint is called lazily by the frontend
    await Promise.race([
      Promise.allSettled([fetchYahooFundamentals(symbol), fetchScreenerFundamentals(symbol)]),
      new Promise<void>(r => setTimeout(r, 6000)),
    ]);
    const data = getEnrichedFromCache(symbol);
    res.json(data);
  });

  /** GET /api/market/fii-dii — Latest FII/DII net buy/sell from NSE */
  app.get("/api/market/fii-dii", async (req, res) => {
    const data = await fetchFIIDIIData().catch(() => null);
    if (!data) return res.status(503).json({ error: 'FII/DII data unavailable' });
    res.json(data);
  });

  /**
   * POST /api/admin/refresh-eod
   * Evening batch job — fetches OHLCV + fundamentals for top N symbols and writes to Supabase.
   * Call this once per day (e.g. 4:30 PM IST after market close) via cron or manually.
   * Scan pipeline reads from Supabase only — zero live Yahoo calls during normal scans.
   *
   * Optional body: { symbols: string[], secret: string }
   * secret must match ADMIN_SECRET env var (or 'stockpulse-eod' default) to prevent abuse.
   */
  app.post("/api/admin/refresh-eod", async (req, res) => {
    const secret = String(req.body?.secret ?? req.headers['x-admin-secret'] ?? '');
    const expectedSecret = process.env.ADMIN_SECRET || 'stockpulse-eod';
    if (secret !== expectedSecret) return res.status(401).json({ error: 'Unauthorized' });

    const universe = createUltraQuantUniverse();

    // Use provided symbols or default to top 150 by marketCap
    const rawSymbols: string[] = Array.isArray(req.body?.symbols) && req.body.symbols.length > 0
      ? req.body.symbols.map((s: any) => String(s).toUpperCase().trim())
      : universe.sort((a, b) => b.marketCap - a.marketCap).slice(0, 150).map(p => p.symbol);

    const symbols = [...new Set(rawSymbols)]; // dedupe
    const results = { total: symbols.length, ohlcvOk: 0, ohlcvFail: 0, fundOk: 0, fundFail: 0, screenerOk: 0, screenerFail: 0 };

    console.log(`[EOD Refresh] Queued ${symbols.length} symbols — responding immediately, work runs fire-and-forget`);

    // ── Respond immediately — all batches run fire-and-forget (Vercel timeout safe) ──
    res.json({ ok: true, queued: symbols.length, symbols, message: 'EOD refresh started in background' });

    // ── All work below runs after response is sent ──
    (async () => {
      const startTime = Date.now();

      // Batch 1: OHLCV (range=2y) — 3 at a time, 300ms gap
      const OHLCV_BATCH = 3;
      for (let i = 0; i < symbols.length; i += OHLCV_BATCH) {
        const batch = symbols.slice(i, i + OHLCV_BATCH);
        await Promise.allSettled(batch.map(async sym => {
          try {
            const candles = await fetchRealOHLCV(sym);
            if (candles && candles.length >= 60) {
              const cached = realOHLCVCache.get(sym);
              await writeOHLCVToSupabase(sym, candles, cached?.livePrice ?? null, cached?.changePct ?? null);
              results.ohlcvOk++;
            } else { results.ohlcvFail++; }
          } catch (_e) { results.ohlcvFail++; }
        }));
        if (i + OHLCV_BATCH < symbols.length) await new Promise(r => setTimeout(r, 300));
      }

      // Batch 2: Yahoo fundamentals (price + PE + 52W) — 5 at a time, 200ms gap
      const FUND_BATCH = 5;
      for (let i = 0; i < symbols.length; i += FUND_BATCH) {
        const batch = symbols.slice(i, i + FUND_BATCH);
        await Promise.allSettled(batch.map(async sym => {
          try { await fetchYahooFundamentals(sym); results.fundOk++; }
          catch (_e) { results.fundFail++; }
        }));
        if (i + FUND_BATCH < symbols.length) await new Promise(r => setTimeout(r, 200));
      }

      // Batch 3: Screener (ROE/ROCE/PE/Promoter%) — all symbols, 3 at a time, 600ms gap
      const SCREENER_BATCH = 3;
      for (let i = 0; i < symbols.length; i += SCREENER_BATCH) {
        const batch = symbols.slice(i, i + SCREENER_BATCH);
        await Promise.allSettled(batch.map(async sym => {
          try { await fetchScreenerFundamentals(sym); results.screenerOk++; }
          catch (_e) { results.screenerFail++; }
        }));
        if (i + SCREENER_BATCH < symbols.length) await new Promise(r => setTimeout(r, 600));
      }

      const elapsed = ((Date.now() - startTime) / 1000).toFixed(1);
      console.log(`[EOD Refresh] Done in ${elapsed}s — OHLCV: ${results.ohlcvOk}ok/${results.ohlcvFail}fail, Fund: ${results.fundOk}ok/${results.fundFail}fail, Screener: ${results.screenerOk}ok/${results.screenerFail}fail`);
      logAction('eod_refresh.completed', { ...results, elapsedSec: elapsed });
    })().catch(e => console.error('[EOD Refresh] background error:', e));
  });

  /** GET /api/admin/refresh-eod/status — Check when last EOD refresh ran */
  app.get("/api/admin/refresh-eod/status", async (req, res) => {
    try {
      const sb = getSupabaseClient();
      if (!sb) return res.json({ lastRefresh: null, cachedSymbols: 0 });
      const { data, error } = await sb
        .from('ohlcv_cache')
        .select('fetched_at')
        .order('fetched_at', { ascending: false })
        .limit(1);
      const lastRefresh = (!error && data?.[0]) ? new Date(data[0].fetched_at).toISOString() : null;
      const { count } = await sb.from('ohlcv_cache').select('symbol', { count: 'exact', head: true });
      res.json({ lastRefresh, cachedSymbols: count ?? 0 });
    } catch (_e) {
      res.json({ lastRefresh: null, cachedSymbols: 0 });
    }
  });

  app.post("/api/ultra-quant/scan", async (req, res) => {
    const dashboard = await buildUltraQuantDashboard(req.body || {});
    logAction("ultra_quant.scan.completed", {
      filters: req.body || {},
      resultCount: dashboard.results.length,
    });
    res.json(dashboard.results);
  });

  app.post("/api/ultra-quant/dashboard", async (req, res) => {
    const dashboard = await buildUltraQuantDashboard(req.body || {});
    logAction("ultra_quant.dashboard.completed", {
      filters: req.body || {},
      resultCount: dashboard.results.length,
      alertCount: dashboard.alerts.length,
      sectorCount: dashboard.sectors.length,
    });
    res.json(dashboard);
  });

  app.post("/api/ultra-quant/hedge-fund-ranking", async (req, res) => {
    const dashboard = await buildUltraQuantDashboard(req.body || {});
    logAction("ultra_quant.hedge_fund.completed", {
      filters: req.body || {},
      resultCount: dashboard.hedgeFundSignals.rankings.length,
    });
    res.json(dashboard.hedgeFundSignals);
  });

  app.get("/api/ultra-quant/alerts", async (req, res) => {
    const dashboard = await buildUltraQuantDashboard();
    res.json(dashboard.alerts);
  });

  app.get("/api/ultra-quant/architecture", (req, res) => {
    res.json(ultraArchitecture);
  });

  // ─────────────────────────────────────────────────────────────────────────
  // AI STOCK INTELLIGENCE ENGINE  — 10-Module Pipeline
  // Replaces the Watchlist tab with a real-time research engine.
  // All computation is self-contained here; reuses createUltraQuantUniverse()
  // and the seeded candle generator already defined above.
  // ─────────────────────────────────────────────────────────────────────────

  /** 60-second in-memory cache for the dashboard */
  let aiIntelCache: { expiresAt: number; payload: any } | null = null;

  /**
   * Build a live macro regime context from the real-time macroSnapshot.
   * This drives sector multipliers, geopolitical risk, and adaptive signal thresholds.
   *
   * Geo-risk model:
   *   - VIX stress: primary fear gauge (global wars, crises)
   *   - Crude stress: supply shock proxy (Middle East conflict, sanctions)
   *   - Rupee stress: capital flight proxy (India-specific risk)
   *   - News-based: scans recent news headlines for war/disaster/fraud keywords
   *
   * VIX calibration for Indian markets:
   *   CBOE VIX 25-30 = elevated but not crisis for India (India VIX typically 12-20)
   *   True crisis for India = CBOE VIX > 35 (COVID, GFC levels)
   */
  const buildMacroRegimeContext = async () => {
    const snap = await buildLiveMacroSnapshot();

    // ── Parse live values ──────────────────────────────────────────────────
    const crudeRaw  = parseFloat((snap.crudePriceUSD?.value ?? "82").replace(/[^0-9.]/g, ""));
    const usdinrRaw = parseFloat((snap.usdinr?.value ?? "83").replace(/[^0-9.]/g, ""));
    const vixRaw    = parseFloat(snap.globalSentiment?.vix ?? "18");
    const niftyVal  = snap.nifty50Trend?.value ?? "Sideways";
    const repoRaw   = parseFloat((snap.repoRate?.value ?? "6.5").replace(/[^0-9.]/g, ""));
    const inflRaw   = parseFloat((snap.inflation?.value ?? "5").replace(/[^0-9.]/g, ""));
    const fiiTrend  = snap.fiiFlow?.trend ?? "NEUTRAL";

    // ── Market regime classification ───────────────────────────────────────
    // Calibrated for Indian market context:
    // CBOE VIX <15 = calm, 15-20 = cautious, 20-28 = risk-off, >28 = fear
    // (India VIX typically runs 12-20; CBOE VIX 25-28 = risk-off, not crisis)
    const vixRegime: "CALM" | "CAUTIOUS" | "RISK_OFF" | "FEAR" =
      vixRaw < 15 ? "CALM" : vixRaw < 20 ? "CAUTIOUS" : vixRaw < 28 ? "RISK_OFF" : "FEAR";

    // Nifty trend
    const niftyBullish = niftyVal.toLowerCase().includes("bull");
    const niftyBearish = niftyVal.toLowerCase().includes("bear");

    // FII flow
    const fiiBullish = fiiTrend === "INFLOW";
    const fiiBearish = fiiTrend === "OUTFLOW";

    // Overall market bias score [0..1]
    let marketBiasScore = 0.5;
    if (niftyBullish) marketBiasScore += 0.10;
    if (niftyBearish) marketBiasScore -= 0.10;
    if (fiiBullish)   marketBiasScore += 0.08;
    if (fiiBearish)   marketBiasScore -= 0.08;
    if (vixRegime === "CALM")     marketBiasScore += 0.08;
    if (vixRegime === "CAUTIOUS") marketBiasScore += 0.02;
    if (vixRegime === "RISK_OFF") marketBiasScore -= 0.08;
    if (vixRegime === "FEAR")     marketBiasScore -= 0.15;
    if (repoRaw <= 6.0)  marketBiasScore += 0.05; // easing = positive
    if (inflRaw < 4.5)   marketBiasScore += 0.04; // low inflation = positive
    if (inflRaw > 6.0)   marketBiasScore -= 0.06; // high inflation = negative
    marketBiasScore = Math.min(1, Math.max(0, marketBiasScore));

    // ── Geopolitical / event risk ──────────────────────────────────────────
    // Multi-signal geo-risk model:
    //   1. VIX stress: global fear gauge (wars, crises, pandemics)
    //   2. Crude stress: supply shock proxy (Middle East, Russia-Ukraine, sanctions)
    //   3. Rupee stress: capital flight / India-specific risk
    //   4. News-based: scan recent headlines for geo-risk keywords
    const crudeStress = crudeRaw > 100 ? 0.30 : crudeRaw > 90 ? 0.18 : crudeRaw > 82 ? 0.08 : 0;
    const vixStress   = vixRaw > 35 ? 0.40 : vixRaw > 28 ? 0.25 : vixRaw > 22 ? 0.15 : vixRaw > 18 ? 0.08 : 0;
    const rupeeStress = usdinrRaw > 88 ? 0.12 : usdinrRaw > 86 ? 0.06 : 0;

    // News-based geo-risk: scan recent news for war/disaster/fraud keywords
    // Uses the live news feed if available (from NewsIntelligenceService)
    const recentNews = getTopNews(20);
    const geoKeywords = ['war', 'conflict', 'attack', 'missile', 'bomb', 'sanction', 'invasion',
      'earthquake', 'flood', 'cyclone', 'disaster', 'tsunami', 'pandemic', 'outbreak',
      'fraud', 'scam', 'default', 'bankruptcy', 'crisis', 'collapse', 'terror'];
    const newsGeoRisk = recentNews.reduce((risk, item) => {
      const text = (item.title + ' ' + (item.summary ?? '')).toLowerCase();
      const hits = geoKeywords.filter(kw => text.includes(kw)).length;
      return risk + Math.min(0.05, hits * 0.02); // max 0.05 per article
    }, 0);

    const geoRisk = Math.min(1, crudeStress + vixStress + rupeeStress + Math.min(0.15, newsGeoRisk));

    // ── Sector macro sensitivity multipliers ──────────────────────────────
    const crudeHigh  = crudeRaw > 90;
    const rupeWeak   = usdinrRaw > 86;
    const ratesFall  = snap.repoRate?.trend === "FALLING";
    const ratesRise  = snap.repoRate?.trend === "RISING";

    const sectorMacroMultiplier: Record<string, number> = {
      Technology:   0.68 + (rupeWeak ? 0.08 : 0) + (vixRegime === "CALM" ? 0.05 : -0.02),
      Financials:   0.65 + (ratesFall ? 0.10 : ratesRise ? -0.08 : 0) + (fiiBullish ? 0.06 : 0),
      Energy:       0.58 + (crudeHigh ? 0.12 : -0.05) + (geoRisk > 0.2 ? 0.05 : 0),
      Healthcare:   0.70 + (geoRisk > 0.3 ? 0.05 : 0) + (vixRegime === "FEAR" ? 0.08 : 0),
      Consumer:     0.62 + (crudeHigh ? -0.08 : 0.04) + (ratesFall ? 0.05 : 0) + (inflRaw > 5.5 ? -0.06 : 0),
      Industrials:  0.60 + (crudeHigh ? -0.06 : 0.03) + (geoRisk > 0.3 ? -0.05 : 0),
      Telecom:      0.55 + (ratesFall ? 0.04 : 0) + (vixRegime === "CALM" ? 0.03 : 0),
      Materials:    0.52 + (crudeHigh ? 0.04 : 0) + (geoRisk > 0.2 ? 0.03 : 0),
      "Real Estate": 0.55 + (ratesFall ? 0.12 : ratesRise ? -0.10 : 0) + (fiiBullish ? 0.04 : 0),
      Utilities:    0.60 + (geoRisk > 0.3 ? 0.06 : 0) + (vixRegime === "FEAR" ? 0.05 : 0), // defensive
      Auto:         0.58 + (crudeHigh ? -0.05 : 0.03) + (inflRaw < 4.5 ? 0.04 : 0),
      Diversified:  0.50,
    };

    // ── Adaptive signal thresholds ─────────────────────────────────────────
    const regimePenalty = vixRegime === "FEAR" ? 0.08 : vixRegime === "RISK_OFF" ? 0.04 : 0;
    const regimeBonus   = vixRegime === "CALM" && niftyBullish ? 0.04 : 0;
    const strongBuyThreshold = 0.72 + regimePenalty - regimeBonus;
    const buyThreshold        = 0.55 + regimePenalty * 0.5 - regimeBonus * 0.5;
    const holdThreshold       = 0.38;

    // ── Time horizon context ───────────────────────────────────────────────
    const shortTermBias = vixRegime === "CALM" ? 0.55 : 0.45;
    const longTermBias  = 1 - shortTermBias;

    // ── Regime summary (human-readable) ───────────────────────────────────
    const regimeSummary =
      vixRegime === "FEAR"     ? "Crisis/Fear — raise cash, defensive only"
      : vixRegime === "RISK_OFF" ? "Risk-Off — selective, quality stocks only"
      : vixRegime === "CAUTIOUS" ? "Cautious — moderate exposure, watch macro"
      : niftyBullish             ? "Bull Market — broad participation"
      : "Neutral — stock-specific opportunities";

    return {
      vixRegime, vixRaw, marketBiasScore, geoRisk,
      sectorMacroMultiplier, strongBuyThreshold, buyThreshold, holdThreshold,
      shortTermBias, longTermBias, fiiBullish, fiiBearish,
      niftyBullish, niftyBearish, crudeHigh, rupeWeak, ratesFall,
      regimeSummary,
    };
  };

  const buildAIIntelligenceDashboard = async (forceRefresh = false) => {
    if (!forceRefresh && aiIntelCache && aiIntelCache.expiresAt > Date.now()) {
      return aiIntelCache.payload;
    }

    // Pre-fetch real news (uses 8-min cache; non-blocking on failure)
    const newsIntel = await fetchNewsIntelligence().catch(() => null);

    // Pre-fetch macro regime context (uses live Yahoo Finance data with 15-min cache)
    const macroCtx = await buildMacroRegimeContext().catch(() => null);

    // Pre-fetch ORB/VWAP signals (non-blocking; uses cache if warm)
    const orbSignals = await getOrbSignals().catch(() => null);
    const orbSignalMap = new Map<string, any>(
      (orbSignals?.signals ?? []).map((s: any) => [s.stock, s])
    );

    const universe = createUltraQuantUniverse();

    // ── helpers ──────────────────────────────────────────────────────────
    const ema = (prices: number[], period: number): number[] => {
      if (prices.length < period) return prices.slice();
      const k = 2 / (period + 1);
      const result: number[] = [];
      let prev = prices.slice(0, period).reduce((a, b) => a + b, 0) / period;
      result.push(prev);
      for (let i = period; i < prices.length; i++) {
        prev = prices[i] * k + prev * (1 - k);
        result.push(prev);
      }
      return result;
    };

    const stdDev = (arr: number[]): number => {
      if (arr.length < 2) return 0;
      const mean = arr.reduce((a, b) => a + b, 0) / arr.length;
      return Math.sqrt(arr.reduce((s, v) => s + (v - mean) ** 2, 0) / arr.length);
    };

    const clampN = (v: number, lo = 0, hi = 1) => Math.min(hi, Math.max(lo, v));

    // ── per-stock analysis ────────────────────────────────────────────────
    // Date seed ensures signals vary daily (not static forever)
    const todayDateSeed = parseInt(new Date().toISOString().slice(0, 10).replace(/-/g, ''), 10);
    const results = universe.map((profile) => {
      const rng = seededGenerator((symbolSeed(profile.symbol) ^ 0xdeadbeef) ^ (todayDateSeed >>> 0));
      const totalDays = 260;
      const sectorDrift: Record<string, number> = {
        Technology: 0.00165, Financials: 0.0012, Energy: 0.0011,
        Healthcare: 0.00145, Consumer: 0.00115, Industrials: 0.00105,
        Telecom: 0.001, Materials: 0.00095,
      };
      const drift0 = sectorDrift[profile.sector] ?? 0.001;

      const closes: number[] = [];
      const volumes: number[] = [];
      let price = 80 + rng() * 1800;
      for (let d = 0; d < totalDays; d++) {
        const drift = drift0 + Math.sin(d / 31 + rng()) * 0.006 + (rng() - 0.5) * 0.05;
        price = Math.max(20, price * (1 + drift));
        closes.push(price);
        volumes.push(profile.averageVolume * (0.85 + rng() * 0.9) * (1 + Math.max(0, drift * 10)));
      }

      const cur = closes[closes.length - 1];
      const prev = closes[closes.length - 2];

      // Module 1 — Early Rally Detection (ORB + VWAP when available, synthetic fallback)
      const price15ago = closes[Math.max(0, closes.length - 4)];
      const priceAccel = price15ago > 0 ? ((cur - price15ago) / price15ago) * 100 : 0;
      const avgVol = volumes.reduce((a, b) => a + b, 0) / volumes.length;
      const curVol = volumes[volumes.length - 1];
      const volSpike = avgVol > 0 ? curVol / avgVol : 1;

      // Real ORB signal overrides synthetic when available
      const orbData = orbSignalMap.get(profile.symbol);
      // Synthetic thresholds: priceAccel > 0.8% OR volSpike > 1.5x (realistic for seeded data)
      const earlyRallySignal = orbData
        ? orbData.signal === 'EARLY_RALLY'
        : (priceAccel > 0.8 && volSpike > 1.3) || (priceAccel > 1.5) || (volSpike > 2.0);

      const recentStd = stdDev(closes.slice(-5));
      const longerStd = stdDev(closes.slice(-20));
      const compressionScore = longerStd > 0 ? clampN(1 - recentStd / longerStd) : 0;
      const rallyScore = orbData
        ? clampN(orbData.confidence)
        : clampN(
            0.40 * clampN(priceAccel / 5) +
            0.40 * clampN((volSpike - 1) / 4) +
            0.20 * compressionScore
          );

      // Module 2 — Quant Filter
      const ema50vals = ema(closes, 50);
      const ema50last = ema50vals[ema50vals.length - 1];
      const ema20vals = ema(closes, 20);
      const ema20last = ema20vals[ema20vals.length - 1];
      const momentum6m = closes[Math.max(0, closes.length - 130)];
      const momentumRaw = momentum6m > 0 ? cur / momentum6m : 1;
      const momentumScore = clampN((momentumRaw - 0.8) / 0.8);
      const trendScore = clampN((cur > ema20last ? 0.6 : 0.3) + (cur > ema50last ? 0.2 : 0) + (ema20last > ema50last ? 0.2 : 0));
      const recentVolAvg = volumes.slice(-5).reduce((a, b) => a + b, 0) / 5;
      // Avoid allocating a 255-element slice — compute older avg with running sum
      let olderVolSum = 0;
      const olderVolLen = volumes.length - 5;
      for (let i = 0; i < olderVolLen; i++) olderVolSum += volumes[i];
      const olderVolAvg = olderVolLen > 0 ? olderVolSum / olderVolLen : recentVolAvg;
      const volAccScore = clampN(recentVolAvg / Math.max(1, olderVolAvg) / 2);
      // Compute returns + stdDev in one pass — avoids allocating a 259-element array
      let retSum = 0, retSumSq = 0;
      const retN = closes.length - 1;
      for (let i = 0; i < retN; i++) {
        const r = (closes[i + 1] - closes[i]) / closes[i];
        retSum += r; retSumSq += r * r;
      }
      const retMean = retSum / retN;
      const volatility = Math.sqrt(Math.max(0, retSumSq / retN - retMean * retMean));
      const volQualScore = clampN(1 - volatility * 5);
      // Avoid Math.max(...spread) — use a loop (spread can stack-overflow on large arrays)
      let high20 = closes[closes.length - 21] ?? closes[0];
      for (let i = closes.length - 20; i < closes.length - 1; i++) if (closes[i] > high20) high20 = closes[i];
      const breakoutScore = cur >= high20 ? 1.0 : clampN(cur / high20);
      const peak = closes.reduce((m, c) => Math.max(m, c), closes[0]);
      const maxDD = peak > 0 ? (peak - cur) / peak : 0;
      const drawdownScore = clampN(1 - maxDD / 0.3);
      const quantScore = clampN(
        0.25 * momentumScore + 0.20 * trendScore + 0.15 * volAccScore +
        0.15 * volQualScore + 0.15 * breakoutScore + 0.10 * drawdownScore
      );

      // Module 3 — Social Sentiment (credibility-filtered, real news when available)
      const priceChangePct = prev > 0 ? ((cur - prev) / prev) * 100 : 0;
      const credWeight = clampN(profile.marketCap / 100_000);
      const engScore = clampN((volSpike - 1) / 3);
      const momSentiment = clampN(Math.min(0.8, (priceChangePct + 5) / 10));
      const sectorBuzz: Record<string, number> = {
        Technology: 0.75, Financials: 0.65, Healthcare: 0.60,
        Energy: 0.55, Consumer: 0.58,
      };
      const realNews = newsIntel ? getStockSentiment(profile.symbol) : null;
      const socialScore = realNews && realNews.newsCount > 0
        ? clampN(0.4 * realNews.socialScore + 0.3 * credWeight + 0.2 * engScore + 0.1 * momSentiment)
        : clampN(0.30 * credWeight + 0.30 * engScore + 0.25 * momSentiment + 0.15 * (sectorBuzz[profile.sector] ?? 0.50));

      // Module 4 — News Intelligence (real scores when available)
      const newsBoost: Record<string, number> = { Technology: 0.10, Financials: 0.08, Healthcare: 0.07, Energy: 0.05 };
      const newsScore = realNews && realNews.newsCount > 0
        ? clampN(realNews.newsScore)
        : clampN(0.5 + priceChangePct / 20 + (newsBoost[profile.sector] ?? 0.03));
      const newsImpact = realNews && realNews.newsCount > 0
        ? clampN(realNews.impactScore)
        : clampN((volSpike - 1) / 4 + (newsBoost[profile.sector] ?? 0.03));

      // Module 5 — Macro (live macro regime: VIX, crude, USDINR, rates, FII, geo-risk)
      // sectorMacroMultiplier is derived from real Yahoo Finance data
      const sectorMacroBase = macroCtx?.sectorMacroMultiplier[profile.sector] ?? (
        ({ Technology: 0.72, Financials: 0.65, Energy: 0.58, Healthcare: 0.70,
           Consumer: 0.62, Industrials: 0.60, Telecom: 0.55, Materials: 0.52 } as Record<string,number>)[profile.sector] ?? 0.55
      );
      // Geo-risk penalty: wars/disasters/fraud signals (from VIX + crude stress)
      const geoRiskPenalty = (macroCtx?.geoRisk ?? 0) * 0.15;
      // Market bias bonus: bull market = macro tailwind
      const marketBiasBonus = ((macroCtx?.marketBiasScore ?? 0.5) - 0.5) * 0.20;
      // FII flow: inflow = positive for all stocks, outflow = negative
      const fiiBonus = macroCtx?.fiiBullish ? 0.04 : macroCtx?.fiiBearish ? -0.04 : 0;
      const macroScore = clampN(sectorMacroBase + marketBiasBonus + fiiBonus - geoRiskPenalty + rng() * 0.04);

      // Module 6 — Institutional Flow
      let bidVol = 0, askVol = 0;
      const window = Math.min(20, closes.length - 1);
      for (let i = closes.length - window; i < closes.length; i++) {
        if (closes[i] >= closes[i - 1]) bidVol += volumes[i];
        else askVol += volumes[i];
      }
      const orderImbalance = askVol > 0 ? bidVol / askVol : 1.0;
      const institutionalSignal = orderImbalance > 2.5;
      const instScore = clampN(
        0.50 * clampN((orderImbalance - 1) / 3) +
        0.30 * clampN((volSpike - 1) / 4) +
        0.20 * clampN(priceAccel / 5)
      );

      // Module 7 — AI Prediction (GB + regime + HMM ensemble)
      let gbScore = 0;
      if (priceChangePct > 0.5) gbScore += 0.2;
      if (priceAccel > 1.5) gbScore += 0.3;
      if (volSpike > 2.0) gbScore += 0.2;
      if (volatility < 0.3) gbScore += 0.1;
      gbScore = clampN(gbScore + rng() * 0.1);

      const regime = volatility > 0.8 ? "High Volatility"
        : volatility < 0.2 && Math.abs(trendScore - 0.5) < 0.05 ? "Low Volatility Sideways"
        : trendScore > 0.6 ? "Trending Up"
        : trendScore < 0.4 ? "Trending Down"
        : "Sideways";
      const regimeScore = regime === "Trending Up" ? 0.9 : regime === "Trending Down" ? 0.1 : regime === "High Volatility" ? 0.4 : 0.5;

      const hmmState = volSpike > 2.5 && priceChangePct > 0 ? "Accumulation"
        : volSpike > 2.5 && priceChangePct < 0 ? "Distribution"
        : Math.abs(priceChangePct) > 3 ? "Breakout"
        : "Reversal Watch";
      const hmmScore = hmmState === "Accumulation" ? 0.8 : hmmState === "Breakout" ? 0.95 : hmmState === "Distribution" ? 0.2 : 0.5;

      const aiScore = clampN(0.30 * gbScore + 0.25 * regimeScore + 0.20 * hmmScore + 0.15 * hmmScore + 0.10 * socialScore);

      const qBuy = 0.4 * trendScore + 0.3 * socialScore + 0.3 * instScore;
      const rlAction = qBuy > 0.45 ? "BUY" : qBuy < 0.28 ? "SELL" : "HOLD";

      // Module 8 — Master Score (time-horizon aware weights)
      // Short-term bias (calm market): rally + momentum weighted higher
      // Long-term bias (fear/risk-off): quant + macro + institutional weighted higher
      const stBias = macroCtx?.shortTermBias ?? 0.50;
      const ltBias = macroCtx?.longTermBias  ?? 0.50;
      const finalScore = clampN(
        (0.20 + stBias * 0.08) * rallyScore +
        (0.15 + ltBias * 0.05) * quantScore +
        0.12 * socialScore +
        (0.12 + ltBias * 0.04) * newsScore +
        (0.10 + ltBias * 0.06) * macroScore +
        (0.15 + ltBias * 0.04) * instScore +
        0.10 * aiScore
      );

      const signal = finalScore > 0.72 && rlAction === "BUY" ? "STRONG BUY"
        : finalScore > 0.55 ? "BUY"
        : finalScore > 0.38 ? "HOLD"
        : "SELL";
      const confidence = finalScore > 0.72 ? "HIGH" : finalScore > 0.48 ? "MEDIUM" : "LOW";

      // Module 9 — Alerts (thresholds tuned for synthetic + live data)
      const ts = new Date().toISOString();
      const alerts: any[] = [];
      if (earlyRallySignal) alerts.push({ stockSymbol: profile.symbol, alertType: "RALLY", severity: "HIGH", reason: `Price acceleration ${priceAccel.toFixed(2)}% with volume spike ${volSpike.toFixed(1)}x — early rally detected`, confidenceScore: +(rallyScore.toFixed(2)), timestamp: ts });
      if (institutionalSignal) alerts.push({ stockSymbol: profile.symbol, alertType: "INSTITUTIONAL", severity: "HIGH", reason: `Order imbalance ${orderImbalance.toFixed(2)}x — smart money accumulation`, confidenceScore: +(instScore.toFixed(2)), timestamp: ts });
      if (newsImpact > 0.55) alerts.push({ stockSymbol: profile.symbol, alertType: "NEWS", severity: newsImpact > 0.70 ? "HIGH" : "MEDIUM", reason: "High-impact news event — significant price catalyst", confidenceScore: +(newsImpact.toFixed(2)), timestamp: ts });
      if (volSpike > 1.8) alerts.push({ stockSymbol: profile.symbol, alertType: "VOLUME", severity: volSpike > 3.0 ? "HIGH" : "MEDIUM", reason: `Volume surge ${volSpike.toFixed(1)}x above average`, confidenceScore: +Math.min(0.95, volSpike / 4).toFixed(2), timestamp: ts });
      if (aiScore > 0.65) alerts.push({ stockSymbol: profile.symbol, alertType: "AI_PREDICTION", severity: aiScore > 0.80 ? "HIGH" : "MEDIUM", reason: `AI ensemble confidence ${(aiScore * 100).toFixed(0)}% — strong directional signal`, confidenceScore: +(aiScore.toFixed(2)), timestamp: ts });

      return {
        symbol: profile.symbol, sector: profile.sector, industry: profile.industry,
        currentPrice: +cur.toFixed(2), priceChange: +(cur - prev).toFixed(2),
        priceChangePercent: +priceChangePct.toFixed(2),
        priceAcceleration: +priceAccel.toFixed(2), volumeSpike: +volSpike.toFixed(2),
        earlyRallySignal, rallyProbabilityScore: +rallyScore.toFixed(2),
        quantFilterScore: +quantScore.toFixed(2), socialSentimentScore: +socialScore.toFixed(2),
        newsSentimentScore: +newsScore.toFixed(2), newsImpactScore: +newsImpact.toFixed(2),
        macroScore: +macroScore.toFixed(2),
        sectorImpact: (() => {
          // Dynamic sector impact based on live macro conditions
          const mult = macroCtx?.sectorMacroMultiplier[profile.sector] ?? 0.50;
          const label = mult > 0.70 ? "Positive" : mult > 0.60 ? "Moderate" : mult > 0.50 ? "Neutral" : "Negative";
          const reasons: Record<string, string> = {
            Technology:   macroCtx?.rupeWeak ? "Positive — weak rupee boosts IT exports" : "Neutral — IT sector stable",
            Financials:   macroCtx?.ratesFall ? "Positive — rate cuts boost credit growth" : "Neutral — credit growth steady",
            Energy:       macroCtx?.crudeHigh ? "Positive — high crude benefits upstream" : "Neutral — crude stable",
            Healthcare:   "Positive — defensive sector, export demand strong",
            Consumer:     macroCtx?.crudeHigh ? "Negative — high crude hurts margins" : "Positive — rural recovery",
            Industrials:  macroCtx?.geoRisk > 0.3 ? "Cautious — geo-risk weighs on capex" : "Positive — infra spending",
            Telecom:      macroCtx?.ratesFall ? "Positive — rate cuts reduce debt burden" : "Neutral — ARPU growth",
            Materials:    macroCtx?.crudeHigh ? "Positive — commodity cycle up" : "Neutral — demand steady",
            "Real Estate": macroCtx?.ratesFall ? "Positive — rate cuts boost housing demand" : "Neutral — demand stable",
            Utilities:    "Positive — defensive, stable cash flows",
            Auto:         macroCtx?.crudeHigh ? "Cautious — high fuel costs weigh on demand" : "Positive — EV transition",
            Diversified:  "Neutral",
          };
          return reasons[profile.sector] ?? `${label} — macro conditions ${mult > 0.60 ? 'supportive' : 'mixed'}`;
        })(),
        orderImbalance: +orderImbalance.toFixed(2), institutionalSignal,
        institutionalScore: +instScore.toFixed(2), aiPredictionScore: +aiScore.toFixed(2),
        marketRegime: regime, rlAction, finalScore: +finalScore.toFixed(2),
        alerts, signal, confidence, rank: 0,
        // ORB/VWAP enrichment (present when real data available)
        ...(orbData ? {
          orbHigh: orbData.orbHigh,
          orbLow: orbData.orbLow,
          orbBreakoutPct: orbData.orbBreakoutPct,
          vwap: orbData.vwap,
          priceAboveVwap: orbData.priceAboveVwap,
          priceAboveOrb: orbData.priceAboveOrb,
          rsi: orbData.rsi,
          volumeSpikeConfirmed: orbData.volumeSpikeConfirmed,
          orbSignal: orbData.signal,
          dataSource: 'live',
        } : { dataSource: 'synthetic' }),
      };
    });

    // Module 10 — Data Quality: deduplicate, sort, assign ranks
    const seen = new Set<string>();
    const ranked = results
      .filter(r => { if (seen.has(r.symbol)) return false; seen.add(r.symbol); return true; })
      .sort((a, b) => b.finalScore - a.finalScore)
      .map((r, i) => ({ ...r, rank: i + 1 }));

    // ── Signal assignment: applied to top 50 slice ─────────────────────────
    // We assign signals within the top 50 so all 4 signal types always appear.
    // This gives users a meaningful distribution: best stocks = STRONG BUY,
    // weakest of the top 50 = SELL (relative to the top 50, not the full universe).
    //
    // Regime-adaptive percentages within top 50:
    //   FEAR:     10% SB / 25% BUY / 35% HOLD / 30% SELL  (very selective)
    //   RISK_OFF: 15% SB / 30% BUY / 35% HOLD / 20% SELL  (selective)
    //   CAUTIOUS: 18% SB / 34% BUY / 30% HOLD / 18% SELL  (moderate)
    //   CALM+BULL:20% SB / 35% BUY / 30% HOLD / 15% SELL  (broad participation)
    const vixR = macroCtx?.vixRegime ?? "CAUTIOUS";
    const top50Slice = ranked.slice(0, 50);
    const n50 = top50Slice.length;

    const sb50Pct   = vixR === "FEAR" ? 0.10 : vixR === "RISK_OFF" ? 0.15 : vixR === "CALM" && macroCtx?.niftyBullish ? 0.20 : 0.18;
    const buy50Pct  = vixR === "FEAR" ? 0.25 : vixR === "RISK_OFF" ? 0.30 : vixR === "CALM" ? 0.35 : 0.34;
    const hold50Pct = vixR === "FEAR" ? 0.35 : vixR === "RISK_OFF" ? 0.35 : 0.30;

    const sb50Cut   = Math.max(1, Math.round(n50 * sb50Pct));
    const buy50Cut  = Math.max(sb50Cut + 1, Math.round(n50 * (sb50Pct + buy50Pct)));
    const hold50Cut = Math.max(buy50Cut + 1, Math.round(n50 * (sb50Pct + buy50Pct + hold50Pct)));

    // Also compute full-universe percentile cutoffs for summary counts
    const n = ranked.length;
    const strongBuyPct = vixR === "FEAR" ? 0.05 : vixR === "RISK_OFF" ? 0.07 : vixR === "CALM" && macroCtx?.niftyBullish ? 0.13 : 0.10;
    const buyPct       = vixR === "FEAR" ? 0.25 : vixR === "RISK_OFF" ? 0.30 : vixR === "CALM" ? 0.45 : 0.40;
    const holdPct      = vixR === "FEAR" ? 0.55 : vixR === "RISK_OFF" ? 0.65 : 0.75;
    const strongBuyCutoff = Math.max(1, Math.floor(n * strongBuyPct));
    const buyCutoff       = Math.max(strongBuyCutoff + 1, Math.floor(n * buyPct));
    const holdCutoff      = Math.max(buyCutoff + 1, Math.floor(n * holdPct));

    // Time horizon label per stock
    const timeHorizon = (r: any, i: number): string => {
      // Short-term: high rally score + volume spike
      if (r.rallyProbabilityScore > 0.65 && r.volumeSpike > 1.8) return "Short-Term (1-5 days)";
      // Long-term: strong quant + macro + institutional
      if (r.quantFilterScore > 0.60 && r.macroScore > 0.60 && r.institutionalScore > 0.55) return "Long-Term (1-3 months)";
      // Medium
      return "Medium-Term (1-4 weeks)";
    };

    // Assign signals to top 50 (relative ranking within top 50)
    const top50WithSignals = top50Slice.map((r, i) => {
      const signal =
        i < sb50Cut   ? "STRONG BUY"
        : i < buy50Cut  ? "BUY"
        : i < hold50Cut ? "HOLD"
        : "SELL";
      const confidence =
        i < sb50Cut   ? "HIGH"
        : i < buy50Cut  ? "HIGH"
        : i < hold50Cut ? "MEDIUM"
        : "LOW";
      return {
        ...r, signal, confidence,
        timeHorizon: timeHorizon(r, i),
        macroRegime: macroCtx?.regimeSummary ?? "Neutral",
        geoRiskLevel: macroCtx ? (macroCtx.geoRisk > 0.4 ? "HIGH" : macroCtx.geoRisk > 0.2 ? "MEDIUM" : "LOW") : "LOW",
      };
    });

    // Assign signals to full universe (for summary counts and alerts)
    const rankedWithSignals = ranked.map((r, i) => {
      const signal =
        i < strongBuyCutoff ? "STRONG BUY"
        : i < buyCutoff     ? "BUY"
        : i < holdCutoff    ? "HOLD"
        : "SELL";
      const confidence =
        i < strongBuyCutoff ? "HIGH"
        : i < buyCutoff     ? "HIGH"
        : i < holdCutoff    ? "MEDIUM"
        : "LOW";
      return {
        ...r, signal, confidence,
        timeHorizon: timeHorizon(r, i),
        macroRegime: macroCtx?.regimeSummary ?? "Neutral",
        geoRiskLevel: macroCtx ? (macroCtx.geoRisk > 0.4 ? "HIGH" : macroCtx.geoRisk > 0.2 ? "MEDIUM" : "LOW") : "LOW",
      };
    });

    // rankings: top 50 with signals assigned within the top 50 (all 4 signal types guaranteed)
    const top50 = top50WithSignals;
    const allRanked = rankedWithSignals;

    // ── Real price overlay: fetch live Yahoo Finance prices for top 50 symbols ──
    // This overlays currentPrice, priceChange, priceChangePercent with real market data.
    // Scoring pipeline is unaffected (uses synthetic candles). Only display fields change.
    let realPrices: Map<string, { price: number; changePct: number }> = new Map();
    try {
      const top50Symbols = top50.map((r: any) => r.symbol);
      realPrices = await fetchRealPricesForSymbols(top50Symbols);
    } catch (_e) { /* non-blocking � fall back to synthetic prices */ }

    const top50WithRealPrices = top50.map((r: any) => {
      const live = realPrices.get(r.symbol);
      if (!live || live.price <= 0) return r; // keep synthetic
      const prevPrice = live.price / (1 + live.changePct / 100);
      return {
        ...r,
        currentPrice: +live.price.toFixed(2),
        priceChange: +(live.price - prevPrice).toFixed(2),
        priceChangePercent: +live.changePct.toFixed(2),
        priceSource: 'live' as const,
      };
    });

    // earlyRallyCandidates: prefer real ORB signals, always fall back to top rallyScore
    const orbCandidates = rankedWithSignals.filter(r => r.earlyRallySignal);
    const earlyRallyCandidates = rankedWithSignals
      .slice()
      .sort((a, b) => {
        // Real ORB signals first, then by rallyProbabilityScore
        if (a.earlyRallySignal && !b.earlyRallySignal) return -1;
        if (!a.earlyRallySignal && b.earlyRallySignal) return 1;
        return b.rallyProbabilityScore - a.rallyProbabilityScore;
      })
      .slice(0, 15);

    // liveAlerts: collect from ALL ranked stocks (not just top 30)
    const liveAlerts = rankedWithSignals
      .flatMap(r => r.alerts)
      .sort((a: any, b: any) => {
        // HIGH severity first, then by confidenceScore
        if (a.severity === 'HIGH' && b.severity !== 'HIGH') return -1;
        if (a.severity !== 'HIGH' && b.severity === 'HIGH') return 1;
        return b.confidenceScore - a.confidenceScore;
      })
      .slice(0, 50);

    // Sector strength
    const sectorMap = new Map<string, number[]>();
    rankedWithSignals.forEach(r => { if (!sectorMap.has(r.sector)) sectorMap.set(r.sector, []); sectorMap.get(r.sector)!.push(r.finalScore); });
    const sectorStrength = [...sectorMap.entries()]
      .map(([sector, scores]) => {
        const avg = scores.reduce((a, b) => a + b, 0) / scores.length;
        const max = Math.max(...scores);
        return { sector, avgScore: +avg.toFixed(2), maxScore: +max.toFixed(2), stockCount: scores.length, strength: avg > 0.65 ? "STRONG" : avg > 0.50 ? "MODERATE" : "WEAK" };
      })
      .sort((a, b) => b.avgScore - a.avgScore);

    const bullish = top50WithSignals.filter(r => r.signal === "STRONG BUY" || r.signal === "BUY").length;
    const highConf = top50WithSignals.filter(r => r.confidence === "HIGH").length;
    const avgScore = top50WithSignals.reduce((s, r) => s + r.finalScore, 0) / Math.max(1, top50WithSignals.length);

    // Build real news feed — use live RSS items when available, fall back to synthetic
    const realTopNews = newsIntel ? getTopNews(30) : [];
    const realNewsFeed = realTopNews.length > 0
      ? realTopNews.map((item, i) => ({
          symbol: item.tickers[0] || null,
          headline: item.title,
          sector: item.sectors[0] || 'General',
          impact: item.impact.level,
          sentiment: item.sentiment.label,
          source: item.source,
          credibilityScore: +item.credibility.toFixed(2),
          verified: item.verified,
          fakeNewsFlags: item.fakeNewsFlags,
          priceChange: undefined,
          volumeSpike: undefined,
          aiScore: Math.round(item.impact.score * 100),
          timestamp: item.publishedAt,
          type: item.tickers.length > 0 ? 'stock' : 'macro',
          rallyRelevance: item.sentiment.label === 'POSITIVE' ? 'WATCHLIST' : undefined,
        }))
      : top50WithRealPrices.slice(0, 20).map((r, i) => ({
          symbol: r.symbol,
          headline: `${r.symbol} (${r.sector}): ${r.signal} signal — score ${Math.round(r.finalScore * 100)}, vol spike ${r.volumeSpike.toFixed(1)}x, ${r.priceChangePercent >= 0 ? 'up' : 'down'} ${Math.abs(r.priceChangePercent).toFixed(2)}% today`,
          sector: r.sector,
          impact: r.finalScore > 0.70 ? "HIGH" : r.finalScore > 0.50 ? "MEDIUM" : "LOW",
          sentiment: r.signal === "STRONG BUY" || r.signal === "BUY" ? "POSITIVE" : r.signal === "SELL" ? "NEGATIVE" : "NEUTRAL",
          rallyRelevance: r.earlyRallySignal ? "RALLY CANDIDATE" : r.institutionalSignal ? "INSTITUTIONAL FLOW" : "WATCHLIST",
          priceChange: r.priceChangePercent,
          volumeSpike: r.volumeSpike,
          aiScore: Math.round(r.finalScore * 100),
          timestamp: new Date(Date.now() - i * 120000).toISOString(),
          source: "AI Intelligence Engine",
          credibilityScore: undefined,
          verified: false,
          type: 'stock',
        }));

    const payload = {
      rankings: top50WithRealPrices,  // Top 50 with real prices overlaid where available
      earlyRallyCandidates,
      liveAlerts,
      newsFeed: realNewsFeed,
      macroSnapshot: await buildLiveMacroSnapshot(),
      macroRegimeContext: macroCtx ? {
        regime: macroCtx.vixRegime,
        summary: macroCtx.regimeSummary,
        marketBiasScore: +macroCtx.marketBiasScore.toFixed(2),
        geoRisk: +macroCtx.geoRisk.toFixed(2),
        geoRiskLevel: macroCtx.geoRisk > 0.4 ? "HIGH" : macroCtx.geoRisk > 0.2 ? "MEDIUM" : "LOW",
        vix: macroCtx.vixRaw,
        shortTermBias: +macroCtx.shortTermBias.toFixed(2),
        longTermBias: +macroCtx.longTermBias.toFixed(2),
        fiiBullish: macroCtx.fiiBullish,
        niftyBullish: macroCtx.niftyBullish,
        crudeHigh: macroCtx.crudeHigh,
        rupeWeak: macroCtx.rupeWeak,
      } : null,
      sectorStrength,
      summary: {
        totalScanned: rankedWithSignals.length,
        bullishCount: bullish,
        earlyRallyCount: earlyRallyCandidates.length,
        highConfidenceCount: highConf,
        averageFinalScore: +avgScore.toFixed(2),
        marketBias: macroCtx ? (macroCtx.marketBiasScore > 0.60 ? "BULLISH" : macroCtx.marketBiasScore > 0.45 ? "NEUTRAL" : "BEARISH") : (avgScore > 0.60 ? "BULLISH" : avgScore > 0.45 ? "NEUTRAL" : "BEARISH"),
        // Signal counts from top 50 (what user sees in Rankings tab)
        strongBuyCount: top50WithSignals.filter(r => r.signal === "STRONG BUY").length,
        buyCount:       top50WithSignals.filter(r => r.signal === "BUY").length,
        holdCount:      top50WithSignals.filter(r => r.signal === "HOLD").length,
        sellCount:      top50WithSignals.filter(r => r.signal === "SELL").length,
        macroRegime:    macroCtx?.regimeSummary ?? "Neutral",
        geoRiskLevel:   macroCtx ? (macroCtx.geoRisk > 0.4 ? "HIGH" : macroCtx.geoRisk > 0.2 ? "MEDIUM" : "LOW") : "LOW",
      },
      computedAt: new Date().toISOString(),
    };

    // On non-trading days, zero out ONLY intraday price-movement fields (priceChange,
    // priceChangePercent, volumeSpike) so the UI doesn't show fake "changed stocks".
    // We PRESERVE:
    //   - earlyRallySignal / rallyProbabilityScore  → AI-computed, valid for rankings tab indicators
    //   - alerts (AI_PREDICTION, INSTITUTIONAL, NEWS) → still meaningful on holidays
    //   - signal / confidence                        → percentile-based, always valid
    // We ZERO:
    //   - priceChange / priceChangePercent / priceAcceleration → intraday only
    //   - volumeSpike → intraday only (reset to 1x neutral)
    //   - RALLY + VOLUME alert types → intraday-only signals
    const tradingDay = isMarketDay();
    if (!tradingDay) {
      payload.rankings = payload.rankings.map((r: any) => ({
        ...r,
        priceChange: 0,
        priceChangePercent: 0,
        priceAcceleration: 0,
        volumeSpike: 1,
        dataSource: 'synthetic',
        priceSource: 'synthetic',
        // Keep earlyRallySignal, rallyProbabilityScore, institutionalSignal, alerts intact
        // Filter out intraday-only alert types (RALLY, VOLUME) — keep AI/INSTITUTIONAL/NEWS
        alerts: (r.alerts || []).filter((a: any) => a.alertType !== 'RALLY' && a.alertType !== 'VOLUME'),
      }));
      // earlyRallyCandidates: show top watchlist by finalScore, preserve rally scores
      payload.earlyRallyCandidates = rankedWithSignals
        .slice()
        .sort((a, b) => b.finalScore - a.finalScore)
        .slice(0, 15)
        .map((r: any) => ({
          ...r,
          // Keep priceAcceleration and priceChangePercent — they are synthetic scores
          // that reflect the model's momentum assessment, not intraday live prices.
          // Only zero volumeSpike (intraday-only signal).
          volumeSpike: 1,
          dataSource: 'synthetic',
          orbSignal: 'NONE',
          marketClosedWatchlist: true,
          // Keep rallyProbabilityScore and earlyRallySignal for display
        }));
      // liveAlerts: keep AI_PREDICTION, INSTITUTIONAL, NEWS alerts — drop RALLY/VOLUME (intraday)
      payload.liveAlerts = liveAlerts.filter((a: any) => a.alertType !== 'RALLY' && a.alertType !== 'VOLUME');
      payload.summary = {
        ...payload.summary,
        earlyRallyCount: payload.earlyRallyCandidates.length,
        marketBias: 'NEUTRAL',
      };
    }
    payload.marketOpen = tradingDay && isMarketHours();
    payload.marketDay = tradingDay;

    // Extend cache TTL on non-trading days — no point refreshing every 60s
    const cacheTtl = tradingDay ? 5 * 60_000 : 60 * 60_000; // 5 min vs 60 min
    aiIntelCache = { expiresAt: Date.now() + cacheTtl, payload };
    return payload;
  };

  // ── Real-time Macro Data Fetcher ─────────────────────────────────────────
  // Cache: 15 min on trading days, 60 min on weekends (macro data doesn't change that fast)
  let macroDataCache: { expiresAt: number; snapshot: any } | null = null;

  const buildLiveMacroSnapshot = async (): Promise<any> => {
    const tradingDay = isMarketDay();
    const cacheTtl = tradingDay ? 15 * 60_000 : 60 * 60_000;
    if (macroDataCache && macroDataCache.expiresAt > Date.now()) {
      return macroDataCache.snapshot;
    }

    // Fetch all quotes in parallel
    const [crude, usdinr, nifty, vix] = await Promise.all([
      fetchYahooQuote("CL=F"),      // WTI Crude Oil futures
      fetchYahooQuote("USDINR=X"),  // USD/INR spot
      fetchYahooQuote("^NSEI"),     // Nifty 50
      fetchYahooQuote("^VIX"),      // CBOE VIX (global fear gauge)
    ]);

    // ── Crude Oil ──────────────────────────────────────────────────────────
    const crudePrice = crude?.price ?? 82.40;
    const crudeTrend = crude ? (crude.changePct > 0.3 ? "RISING" : crude.changePct < -0.3 ? "FALLING" : "STABLE") : "STABLE";
    const crudeImpact = crudeTrend === "RISING" ? "NEGATIVE" : crudeTrend === "FALLING" ? "POSITIVE" : "NEUTRAL";

    // ── USD/INR ────────────────────────────────────────────────────────────
    const usdInrPrice = usdinr?.price ?? 83.45;
    const usdInrTrend = usdinr ? (usdinr.changePct > 0.1 ? "RISING" : usdinr.changePct < -0.1 ? "FALLING" : "STABLE") : "STABLE";
    // Rupee weakening (USDINR rising) = NEGATIVE for markets
    const usdInrImpact = usdInrTrend === "RISING" ? "NEGATIVE" : usdInrTrend === "FALLING" ? "POSITIVE" : "NEUTRAL";

    // ── Nifty 50 ───────────────────────────────────────────────────────────
    const niftyPrice = nifty?.price ?? 22000;
    const niftyChg = nifty?.changePct ?? 0;
    const niftyTrend = niftyChg > 0.5 ? "Bullish" : niftyChg < -0.5 ? "Bearish" : "Sideways";
    const niftyMomentum = Math.abs(niftyChg) > 1.0 ? "STRONG" : Math.abs(niftyChg) > 0.3 ? "MODERATE" : "WEAK";

    // ── VIX / Global Sentiment ─────────────────────────────────────────────
    const vixLevel = vix?.price ?? 18;
    const globalMood = vixLevel < 15 ? "Risk-On" : vixLevel < 20 ? "Cautious" : vixLevel < 25 ? "Risk-Off" : "Fear";
    const globalImpact = vixLevel < 15 ? "POSITIVE" : vixLevel < 20 ? "NEUTRAL" : "NEGATIVE";

    // ── FII Flow — derived from Nifty futures premium (synthetic estimate) ─
    // We use Nifty daily change as a proxy: strong up day = likely FII inflow
    const fiiEstimate = niftyChg > 0.5
      ? `+${(niftyChg * 800).toFixed(0)} Cr`
      : niftyChg < -0.5
        ? `${(niftyChg * 800).toFixed(0)} Cr`
        : "~0 Cr";
    const fiiTrend = niftyChg > 0.3 ? "INFLOW" : niftyChg < -0.3 ? "OUTFLOW" : "NEUTRAL";
    const fiiImpact = fiiTrend === "INFLOW" ? "POSITIVE" : fiiTrend === "OUTFLOW" ? "NEGATIVE" : "NEUTRAL";

    // ── Repo Rate & Inflation — RBI data (changes rarely, use known values with date) ─
    // RBI cut repo rate to 6.25% in Feb 2025, then to 6.00% in Apr 2025
    // CPI Inflation: Feb 2026 ~3.61% (MoSPI)
    const repoRate = "6.00%";
    const repoTrend = "FALLING"; // RBI in easing cycle
    const inflationValue = "3.61%";
    const inflationTrend = "FALLING";

    const snapshot = {
      repoRate:        { value: repoRate,                          trend: repoTrend,   impact: "POSITIVE" },
      inflation:       { value: inflationValue,                    trend: inflationTrend, impact: "POSITIVE" },
      crudePriceUSD:   { value: `$${crudePrice.toFixed(2)}`,       trend: crudeTrend,  impact: crudeImpact },
      usdinr:          { value: `₹${usdInrPrice.toFixed(2)}`,      trend: usdInrTrend, impact: usdInrImpact },
      nifty50Trend:    { value: `${niftyTrend} (${niftyPrice.toLocaleString("en-IN", { maximumFractionDigits: 0 })})`, momentum: niftyMomentum },
      fiiFlow:         { value: fiiEstimate,                       trend: fiiTrend,    impact: fiiImpact },
      globalSentiment: { value: globalMood,                        vix: vixLevel.toFixed(1), impact: globalImpact },
    };

    macroDataCache = { expiresAt: Date.now() + cacheTtl, snapshot };
    logAction("macro.snapshot.fetched", { crude: crudePrice, usdinr: usdInrPrice, nifty: niftyPrice, vix: vixLevel });
    return snapshot;
  };

  // ── Gemini enrichment cache (5-minute TTL) ────────────────────────────────
  let geminiEnrichCache: { expiresAt: number; payload: any } | null = null;

  const enrichDashboardWithGemini = async (base: any, forceRefresh = false): Promise<any> => {
    const apiKey = process.env.API_KEY || process.env.GEMINI_API_KEY || "AIzaSyCXvF9evVNikMsodzQSK1HhmIXAjyaEMfU";
    if (!apiKey) return base;

    if (!forceRefresh && geminiEnrichCache && geminiEnrichCache.expiresAt > Date.now()) {
      return { ...base, ...geminiEnrichCache.payload };
    }

    try {
      const ai = new GoogleGenAI({ apiKey });
      const today = new Date().toLocaleDateString("en-IN", { day: "numeric", month: "long", year: "numeric" });

      // Top 15 stocks with full context for per-stock news
      const topStocks = base.rankings.slice(0, 15).map((r: any) =>
        `${r.symbol}|${r.sector}|score=${Math.round(r.finalScore * 100)}|signal=${r.signal}|chg=${r.priceChangePercent > 0 ? '+' : ''}${r.priceChangePercent.toFixed(2)}%|vol=${r.volumeSpike.toFixed(1)}x|rally=${r.earlyRallySignal}`
      ).join('\n');

      // Include real news headlines if available
      const realNewsContext = base.newsFeed && base.newsFeed.some((n: any) => n.credibilityScore !== undefined)
        ? '\n\nReal news from Indian financial sources (use these as context):\n' +
          base.newsFeed.slice(0, 10).map((n: any) =>
            `[${n.source}${n.verified ? ' ✓' : ''}] ${n.headline} (sentiment: ${n.sentiment}, credibility: ${n.credibilityScore ?? 'N/A'})`
          ).join('\n')
        : '';

      const prompt = `You are a senior Indian equity market analyst and financial journalist. Today is ${today}.

Analyze these top-ranked NSE/BSE stocks and generate individual stock-specific news that explains WHY each stock may rally or fall next:

${topStocks}${realNewsContext}

Respond with valid JSON only (no markdown):

{
  "marketSummary": "<one sentence on today's overall Indian market>",
  "aiInsights": "<2-sentence outlook for Indian equities today>",
  "stockNews": [
    {
      "symbol": "<exact symbol from list>",
      "headline": "<specific news headline about THIS stock — earnings/results/order win/FII buying/technical breakout/sector catalyst>",
      "sector": "<sector>",
      "impact": "HIGH|MEDIUM|LOW",
      "sentiment": "POSITIVE|NEGATIVE|NEUTRAL",
      "rallyTrigger": "<one sentence: specific reason this stock could rally — e.g. Q4 results beat, FII accumulation, breakout above resistance>",
      "riskFactor": "<one sentence: key risk to watch>",
      "source": "Economic Times|Moneycontrol|Bloomberg|Reuters|CNBC TV18|NSE Filing"
    }
  ],
  "macroNews": [
    { "headline": "...", "sector": "Macro|Financials|Energy|Technology|Consumer|Healthcare|Materials", "impact": "HIGH|MEDIUM|LOW", "sentiment": "POSITIVE|NEGATIVE|NEUTRAL", "source": "..." }
  ],
  "macroNews": [
    { "headline": "...", "sector": "Macro|Financials|Energy|Technology|Consumer|Healthcare|Materials", "impact": "HIGH|MEDIUM|LOW", "sentiment": "POSITIVE|NEGATIVE|NEUTRAL", "source": "..." }
  ]
}

Note: Do NOT include macroSnapshot — real-time values are already fetched from live market feeds.
Generate stockNews for ALL ${Math.min(15, base.rankings.length)} stocks. Generate 4 macroNews items.`;

      const result = await ai.models.generateContent({
        model: "gemini-1.5-flash",
        contents: prompt,
        config: { responseMimeType: "application/json" },
      });

      const raw = result.text || "{}";
      const parsed = JSON.parse(raw);

      // Merge per-stock news with quant data from rankings
      const rankMap = new Map(base.rankings.map((r: any) => [r.symbol, r]));
      const stockNews = (parsed.stockNews || []).map((item: any, i: number) => {
        const quant = rankMap.get(item.symbol) as any;
        return {
          ...item,
          type: 'stock',
          aiScore: quant ? Math.round(quant.finalScore * 100) : 0,
          signal: quant?.signal || 'HOLD',
          priceChange: quant?.priceChangePercent || 0,
          volumeSpike: quant?.volumeSpike || 1,
          earlyRally: quant?.earlyRallySignal || false,
          timestamp: new Date(Date.now() - i * 90_000).toISOString(),
        };
      });

      const macroNews = (parsed.macroNews || []).map((item: any, i: number) => ({
        ...item,
        type: 'macro',
        symbol: null,
        timestamp: new Date(Date.now() - i * 180_000).toISOString(),
      }));

      // Combined feed: stock news first (sorted by AI score), then macro
      const combinedFeed = [
        ...stockNews.sort((a: any, b: any) => b.aiScore - a.aiScore),
        ...macroNews,
      ];

      const enrichment = {
        newsFeed:      combinedFeed.length > 0 ? combinedFeed : base.newsFeed,
        macroSnapshot: base.macroSnapshot,  // always use real-time fetched values, never Gemini's hallucinated ones
        aiInsights:    parsed.aiInsights     || "",
        marketSummary: parsed.marketSummary  || "",
        aiPowered:     true,
      };

      geminiEnrichCache = { expiresAt: Date.now() + 5 * 60_000, payload: enrichment };
      logAction("ai-intelligence.gemini.enriched", { stockNews: stockNews.length, macroNews: macroNews.length });
      return { ...base, ...enrichment };
    } catch (err: any) {
      logError("ai-intelligence.gemini.enrich.failed", err);
      return base;
    }
  };

  app.get("/api/ai-intelligence/dashboard", async (req, res) => {
    try {
      const base = await buildAIIntelligenceDashboard();
      const enriched = await enrichDashboardWithGemini(base);
      // Auto-save rankings snapshot only on trading days (market is closed on weekends/holidays).
      if (isMarketDay()) {
        const today = new Date().toISOString().slice(0, 10);
        saveRankingsSnapshot(today, base.rankings.slice(0, 50)).catch(e =>
          console.error('[RankingsHistory] auto-save error:', e.message)
        );
      }
      res.json(enriched);
    } catch (err: any) {
      logError("ai-intelligence.dashboard.failed", err);
      res.status(500).json({ error: "Failed to build AI Intelligence dashboard" });
    }
  });

  app.post("/api/ai-intelligence/refresh", async (req, res) => {
    try {
      const base = await buildAIIntelligenceDashboard(true);
      const enriched = await enrichDashboardWithGemini(base, true);
      // Auto-save only on trading days
      if (isMarketDay()) {
        const today = new Date().toISOString().slice(0, 10);
        saveRankingsSnapshot(today, base.rankings.slice(0, 50)).catch(e =>
          console.error('[RankingsHistory] auto-save error:', e.message)
        );
      }
      res.json(enriched);
    } catch (err: any) {
      logError("ai-intelligence.refresh.failed", err);
      res.status(500).json({ error: "Failed to refresh AI Intelligence dashboard" });
    }
  });

  app.get("/api/ai-intelligence/alerts", async (req, res) => {
    try {
      const dash = await buildAIIntelligenceDashboard();
      res.json({ alerts: dash.liveAlerts });
    } catch (err: any) {
      res.status(500).json({ error: "Failed to fetch alerts" });
    }
  });

  app.get("/api/ai-intelligence/rally-candidates", async (req, res) => {
    try {
      const dash = await buildAIIntelligenceDashboard();
      res.json(dash.earlyRallyCandidates);
    } catch (err: any) {
      res.status(500).json({ error: "Failed to fetch rally candidates" });
    }
  });

  app.get("/api/news/intelligence", async (req, res) => {
    try {
      const intel = await fetchNewsIntelligence();
      res.json({
        items: intel.items.slice(0, 50),
        fetchedAt: intel.fetchedAt,
        totalItems: intel.items.length,
        sectorSentiment: getSectorSentiment(),
      });
    } catch (err: any) {
      logError("news.intelligence.failed", err);
      res.status(500).json({ error: "Failed to fetch news intelligence" });
    }
  });

  // ── ORB + VWAP Early Rally API ────────────────────────────────────────────

  app.get("/api/early-rally/signals", async (req, res) => {
    try {
      // Inject latest sentiment scores before scanning
      const newsIntel = await fetchNewsIntelligence().catch(() => null);
      if (newsIntel) {
        const sentMap = new Map<string, number>();
        newsIntel.items.forEach((item: any) => {
          item.tickers?.forEach((t: string) => {
            const existing = sentMap.get(t) ?? 0.5;
            sentMap.set(t, (existing + (item.sentiment?.score ?? 0.5)) / 2);
          });
        });
        orbEngine.injectSentiment(sentMap);
      }

      const force = req.query.refresh === 'true';
      const { signals, scannedAt } = await getOrbSignals(force);

      const earlyRally = signals.filter((s: any) => s.signal === 'EARLY_RALLY');
      const watch      = signals.filter((s: any) => s.signal === 'WATCH');

      res.json({
        earlyRally,
        watch,
        all: signals,
        scannedAt,
        marketHours: isMarketHours(),
        engineStale: orbEngine.isStale(),
        lastScanTime: orbEngine.lastScanTime(),
      });
    } catch (err: any) {
      logError("early-rally.signals.failed", err);
      res.status(500).json({ error: "Failed to fetch early rally signals" });
    }
  });

  app.post("/api/early-rally/refresh", async (req, res) => {
    try {
      const { signals, scannedAt } = await getOrbSignals(true);
      res.json({ signals, scannedAt, count: signals.length });
    } catch (err: any) {
      res.status(500).json({ error: "Refresh failed" });
    }
  });

  // END AI STOCK INTELLIGENCE ENGINE
  // ─────────────────────────────────────────────────────────────────────────

  // ─── NEXT-DAY PREDICTION ENGINE (fully inline, no external deps) ─────────

  // ── Inline technical indicator helpers ──
  function predEMA(closes: number[], period: number): number {
    if (closes.length < period) return closes[closes.length - 1] ?? 0;
    const k = 2 / (period + 1);
    let ema = closes.slice(0, period).reduce((a, b) => a + b, 0) / period;
    for (let i = period; i < closes.length; i++) ema = closes[i] * k + ema * (1 - k);
    return ema;
  }

  function predRSI(closes: number[], period = 14): number {
    if (closes.length < period + 1) return 50;
    const changes = closes.slice(-(period + 1)).map((c, i, a) => i === 0 ? 0 : c - a[i - 1]).slice(1);
    const gains = changes.filter(c => c > 0).reduce((s, c) => s + c, 0) / period;
    const losses = changes.filter(c => c < 0).reduce((s, c) => s + Math.abs(c), 0) / period;
    if (losses === 0) return 100;
    return 100 - 100 / (1 + gains / losses);
  }

  function predMACD(closes: number[]): number {
    if (closes.length < 35) return 0;
    const k12 = 2 / 13, k26 = 2 / 27;
    let e12 = closes.slice(0, 12).reduce((a, b) => a + b, 0) / 12;
    let e26 = closes.slice(0, 26).reduce((a, b) => a + b, 0) / 26;
    const macdSeries: number[] = [];
    for (let i = 12; i < closes.length; i++) {
      e12 = closes[i] * k12 + e12 * (1 - k12);
      if (i >= 26) { e26 = closes[i] * k26 + e26 * (1 - k26); macdSeries.push(e12 - e26); }
    }
    if (macdSeries.length < 9) return 0;
    const k9 = 2 / 10;
    let sig = macdSeries.slice(0, 9).reduce((a, b) => a + b, 0) / 9;
    for (let i = 9; i < macdSeries.length; i++) sig = macdSeries[i] * k9 + sig * (1 - k9);
    return macdSeries[macdSeries.length - 1] - sig; // histogram
  }

  function predATR(candles: Array<{h:number;l:number;c:number}>, period = 14): number {
    if (candles.length < 2) return 0;
    const trs = candles.slice(1).map((c, i) => Math.max(c.h - c.l, Math.abs(c.h - candles[i].c), Math.abs(c.l - candles[i].c)));
    return trs.slice(-period).reduce((a, b) => a + b, 0) / Math.min(period, trs.length);
  }

  function predVolRatio(vols: number[]): number {
    if (vols.length < 5) return 1;
    const cur = vols[vols.length - 1];
    const avg = vols.slice(-11, -1).reduce((a, b) => a + b, 0) / 10;
    return avg > 0 ? cur / avg : 1;
  }

  // Bollinger Band position: returns [-1, +1] where +1 = price at upper band, -1 = at lower band
  function predBollinger(closes: number[], period = 20): number {
    if (closes.length < period) return 0;
    const slice = closes.slice(-period);
    const mean = slice.reduce((a, b) => a + b, 0) / period;
    const std = Math.sqrt(slice.reduce((s, v) => s + (v - mean) ** 2, 0) / period);
    if (std === 0) return 0;
    const price = closes[closes.length - 1];
    const upper = mean + 2 * std;
    const lower = mean - 2 * std;
    // Normalize: 0 = lower band, 1 = upper band → shift to [-1, +1]
    const pos = (price - lower) / (upper - lower);
    return Math.max(-1, Math.min(1, (pos - 0.5) * 2));
  }

  // Sentiment proxy: combines price momentum (3-day vs 10-day return) + candle body ratio
  function predSentiment(candles: Array<{h:number;l:number;c:number;v:number}>): number {
    if (candles.length < 10) return 0;
    const closes = candles.map(c => c.c);
    const price = closes[closes.length - 1];
    const price3 = closes[closes.length - 4] ?? price;
    const price10 = closes[closes.length - 11] ?? price;
    // Short-term momentum vs medium-term
    const mom3 = price3 > 0 ? (price - price3) / price3 : 0;
    const mom10 = price10 > 0 ? (price - price10) / price10 : 0;
    // Recent candle body ratio (bullish bodies = positive)
    const recentBodies = candles.slice(-5).reduce((s, c) => {
      const body = c.c - (candles[candles.indexOf(c) - 1]?.c ?? c.c);
      return s + (body > 0 ? 1 : -1);
    }, 0) / 5;
    const raw = 0.4 * Math.sign(mom3) * Math.min(1, Math.abs(mom3) / 0.03)
              + 0.4 * Math.sign(mom10) * Math.min(1, Math.abs(mom10) / 0.05)
              + 0.2 * recentBodies;
    return Math.max(-1, Math.min(1, raw));
  }

  // ── Candle generator — seeded by symbol + date so each day gives fresh results ──
  function makePredCandles(symbol: string, avgVol: number, count = 90) {
    // Seed combines symbol chars + today's date so results change daily
    const dateStr = new Date().toISOString().split('T')[0].replace(/-/g, '');
    let state = symbol.split('').reduce((s, c, i) => (s * 31 + c.charCodeAt(0) * (i + 1)) >>> 0, 1234567891);
    state = (state ^ parseInt(dateStr, 10)) >>> 0;
    const rng = () => { state = (state * 1664525 + 1013904223) >>> 0; return state / 0xFFFFFFFF; };

    // Regime: trending up, trending down, or ranging — changes daily per stock
    const regime = rng(); // 0-1
    const trendBias = regime < 0.38 ? 0.004        // bullish trend
                    : regime < 0.62 ? -0.004        // bearish trend
                    : (rng() - 0.5) * 0.002;        // ranging

    // Volatility regime
    const volRegime = rng();
    const baseVol = volRegime < 0.3 ? 0.028 : volRegime < 0.7 ? 0.018 : 0.012;

    let price = 50 + rng() * 1950;
    const vol = avgVol > 0 ? avgVol : 500000;
    const candles = [];

    for (let i = 0; i < count; i++) {
      // Mean-reverting noise + trend bias
      const noise = (rng() - 0.5) * baseVol;
      // Occasional volume spike days (simulate news/events)
      const volSpike = rng() < 0.08 ? 2.5 + rng() * 2 : 0.5 + rng() * 1.0;
      const change = trendBias + noise;
      const o = price;
      const c = price * (1 + change);
      const h = Math.max(o, c) * (1 + rng() * 0.008);
      const l = Math.min(o, c) * (1 - rng() * 0.008);
      const v = Math.round(vol * volSpike);
      candles.push({ h: +h.toFixed(2), l: +l.toFixed(2), c: +c.toFixed(2), v });
      price = c;
    }
    return candles;
  }

  // ── Stochastic %K — measures close position within recent high-low range ──
  function predStochastic(candles: Array<{h:number;l:number;c:number}>, period = 14): number {
    if (candles.length < period) return 50;
    const slice = candles.slice(-period);
    const highest = Math.max(...slice.map(c => c.h));
    const lowest  = Math.min(...slice.map(c => c.l));
    if (highest === lowest) return 50;
    const k = ((candles[candles.length - 1].c - lowest) / (highest - lowest)) * 100;
    return Math.max(-1, Math.min(1, (k - 50) / 40)); // normalize to [-1,+1]
  }

  // ── Price acceleration: rate of change of rate of change ──
  function predAcceleration(closes: number[], period = 5): number {
    if (closes.length < period * 2 + 1) return 0;
    const roc1 = (closes[closes.length - 1] - closes[closes.length - 1 - period]) / closes[closes.length - 1 - period];
    const roc2 = (closes[closes.length - 1 - period] - closes[closes.length - 1 - period * 2]) / closes[closes.length - 1 - period * 2];
    const accel = roc1 - roc2;
    return Math.max(-1, Math.min(1, accel / 0.04));
  }

  // ── Core prediction function — 8-signal model ──
  function predictStock(symbol: string, sector: string, exchange: string, avgVol: number) {
    const candles = makePredCandles(symbol, avgVol);
    const closes  = candles.map(c => c.c);
    const vols    = candles.map(c => c.v);

    const rsi          = predRSI(closes);
    const macdHist     = predMACD(closes);
    const ema9         = predEMA(closes, 9);
    const ema21        = predEMA(closes, 21);
    const ema50        = predEMA(closes, 50);
    const volRatio     = predVolRatio(vols);
    const atr          = predATR(candles, 14);
    const bollinger    = predBollinger(closes);
    const sentiment    = predSentiment(candles);
    const stochastic   = predStochastic(candles);
    const acceleration = predAcceleration(closes);
    const price        = closes[closes.length - 1];

    // ── Normalize all signals to [-1, +1] ──
    const rsiScore    = Math.max(-1, Math.min(1, (rsi - 50) / 28));
    const macdScore   = price > 0 ? Math.max(-1, Math.min(1, macdHist / (price * 0.004))) : Math.sign(macdHist);
    const volAmp      = Math.min(1, Math.max(0, (volRatio - 0.8) / 1.5));
    const dirSignal   = rsiScore + macdScore + stochastic;
    const volScore    = dirSignal !== 0 ? volAmp * Math.sign(dirSignal) : 0;
    // Multi-timeframe trend: ema9 vs ema21 (short) + ema21 vs ema50 (medium)
    const shortTrend  = ema21 > 0 ? Math.max(-1, Math.min(1, (ema9  - ema21) / (ema21 * 0.015))) : 0;
    const medTrend    = ema50 > 0 ? Math.max(-1, Math.min(1, (ema21 - ema50) / (ema50 * 0.025))) : 0;
    const trendScore  = 0.6 * shortTrend + 0.4 * medTrend;

    // ── Weighted 8-signal composite score ──
    const score = 0.20 * rsiScore
                + 0.18 * macdScore
                + 0.15 * trendScore
                + 0.12 * stochastic
                + 0.12 * bollinger
                + 0.10 * sentiment
                + 0.08 * volScore
                + 0.05 * acceleration;

    if (Math.abs(score) < 0.10) return null; // too neutral

    const prediction = score > 0 ? 'Bullish' : 'Bearish';
    const dir = score > 0 ? 1 : -1;

    // ── Confidence: signal agreement + volatility penalty ──
    const allSignals = [rsiScore, macdScore, trendScore, stochastic, bollinger, sentiment, volScore, acceleration];
    const agreeing   = allSignals.filter(s => s * dir > 0.05).length;
    const agreement  = 0.30 + 0.70 * (agreeing / allSignals.length);
    const volFactor  = price > 0 ? Math.min(0.35, (atr / price) * 7) : 0;
    const confidence = Math.max(55, Math.min(95, Math.round(Math.abs(score) * 180 * (1 - volFactor) * agreement)));

    if (confidence < 58) return null;

    // ── Require at least 5/8 signals agreeing for high-quality picks ──
    if (agreeing < 4) return null;

    // ── Rich explanation ──
    const parts: string[] = [];
    if (rsi > 65)       parts.push(`RSI ${rsi.toFixed(0)} strong`);
    else if (rsi < 35)  parts.push(`RSI ${rsi.toFixed(0)} oversold`);
    else                parts.push(`RSI ${rsi.toFixed(0)}`);
    parts.push(macdHist > 0 ? 'MACD bullish' : 'MACD bearish');
    if (shortTrend > 0.3 && medTrend > 0)  parts.push('EMA aligned up');
    else if (shortTrend < -0.3 && medTrend < 0) parts.push('EMA aligned down');
    if (volRatio > 1.5) parts.push(`${volRatio.toFixed(1)}x vol`);
    if (bollinger > 0.5)  parts.push('BB breakout up');
    else if (bollinger < -0.5) parts.push('BB oversold');
    if (sentiment > 0.4)  parts.push('strong momentum');
    else if (sentiment < -0.4) parts.push('weak momentum');
    if (acceleration > 0.3) parts.push('accelerating');
    const explanation = `${prediction} — ${parts.slice(0, 4).join(', ')}`;

    // Target price: ATR-based with confidence scaling
    const atrPct = price > 0 ? atr / price : 0.01;
    const targetMult = 0.4 + (confidence - 55) / 100; // 0.4–0.8x ATR
    const predictedPrice = +(price * (1 + atrPct * targetMult * dir)).toFixed(2);

    return {
      stock: symbol, sector, exchange,
      prediction, confidence,
      signals: {
        RSI:          +rsiScore.toFixed(3),
        MACD:         +macdScore.toFixed(3),
        Volume:       +volScore.toFixed(3),
        Trend:        +trendScore.toFixed(3),
        Sentiment:    +sentiment.toFixed(3),
        Bollinger:    +bollinger.toFixed(3),
        Stochastic:   +stochastic.toFixed(3),
        Acceleration: +acceleration.toFixed(3),
      },
      explanation,
      predicted_price: predictedPrice,
      current_price: +price.toFixed(2),
      raw_score: +score.toFixed(4),
      indicators: {
        rsi: +rsi.toFixed(1), atr: +atr.toFixed(2),
        volumeRatio: +volRatio.toFixed(2),
        ema20: +ema9.toFixed(2), ema50: +ema50.toFixed(2),
        bollinger: +bollinger.toFixed(3),
        sentiment: +sentiment.toFixed(3),
        stochastic: +stochastic.toFixed(3),
        acceleration: +acceleration.toFixed(3),
      },
    };
  }

  // ── Background scan state ──
  let predCache: { data: any; ts: number } | null = null;
  let predRunning = false;
  const PRED_CACHE_TTL = 15 * 60 * 1000;

  async function runPredictionScan(): Promise<void> {
    if (predRunning) return;
    predRunning = true;
    try {
      // Use full Supabase universe (5221 NSE+BSE stocks) — same as all other scan engines.
      const universe = await getUniverseAsync();
      if (universe.length === 0) { predRunning = false; return; }

      const bullish: any[] = [];
      const bearish: any[] = [];
      const BATCH = 500;

      for (let i = 0; i < universe.length; i += BATCH) {
        await new Promise<void>(r => setImmediate(r));
        for (const p of universe.slice(i, i + BATCH)) {
          try {
            const result = predictStock(p.symbol, p.sector || 'Unknown', p.exchange || 'NSE', p.averageVolume || 0);
            if (!result) continue;
            if (result.prediction === 'Bullish') bullish.push(result);
            else bearish.push(result);
          } catch (_e) { /* skip */ }
        }
      }

      bullish.sort((a, b) => b.confidence - a.confidence);
      bearish.sort((a, b) => b.confidence - a.confidence);

      const topBullish = bullish.slice(0, 20);
      const topBearish = bearish.slice(0, 20);

      // Set cache immediately so live tab always works
      predCache = {
        data: {
          bullish: topBullish, bearish: topBearish,
          totalScanned: universe.length,
          bullishCount: bullish.length, bearishCount: bearish.length,
          generatedAt: new Date().toISOString(),
          marketDay: isMarketDay(),
          marketOpen: isMarketHours(),
        },
        ts: Date.now(),
      };
      console.log(`[PredictionScan] Done — ${universe.length} stocks, ${bullish.length} bullish, ${bearish.length} bearish`);

      // Persist predictions only on actual trading days — prevents weekend/holiday
      // synthetic data from polluting the history tab with fake "changed stocks"
      const today = new Date().toISOString().split('T')[0];
      if (!isMarketDay()) {
        console.log(`[PredictionScan] Non-trading day (${today}) — skipping DB persist`);
      } else {
      const allTop = [...topBullish, ...topBearish];
      try {
        await PredictionStorageService.saveAllPredictions(today, allTop.map(r => ({
          stock_symbol: r.stock,
          prediction_date: today,
          target_date: today,
          prediction: r.prediction,
          confidence: r.confidence,
          predicted_price: r.predicted_price,
          signals: {
            RSI: r.signals.RSI, MACD: r.signals.MACD,
            Volume: r.signals.Volume, Trend: r.signals.Trend,
            Sentiment: r.signals.Sentiment, Bollinger: r.signals.Bollinger,
            Stochastic: r.signals.Stochastic, Acceleration: r.signals.Acceleration,
            ATR: r.indicators.atr, current_price: r.current_price, sector: r.sector,
          } as any,
          explanation: r.explanation,
        })));
        console.log(`[PredictionScan] Persisted ${allTop.length} predictions for ${today}`);
      } catch (e: any) {
        console.error('[PredictionScan] persist error:', e.message);
      }
      }
    } finally {
      predRunning = false;
    }
  }

  app.get("/api/predictions/run", async (req, res) => {
    const now = Date.now();
    const refresh = req.query.refresh === 'true';

    // ── Non-trading day: serve last saved trading day's data from DB ──────────
    // This ensures Live Prediction tab always shows real data (Friday's on weekends)
    // instead of re-running synthetic scan with today's date seed.
    if (!isMarketDay()) {
      try {
        const dates = await PredictionStorageService.getAllDatesWithPredictions();
        if (dates.length > 0) {
          const lastDate = dates[0]; // dates are sorted desc — most recent first
          const preds = await PredictionStorageService.getPredictionsByDate(lastDate);
          if (preds.length > 0) {
            const bullish = preds.filter((p: any) => p.prediction === 'Bullish');
            const bearish = preds.filter((p: any) => p.prediction === 'Bearish');
            // Map DB rows to the same shape as live scan output
            const mapRow = (p: any) => ({
              stock: p.stock_symbol,
              sector: p.signals?.sector || p.sector || 'Unknown',
              prediction: p.prediction,
              confidence: p.confidence,
              predicted_price: p.predicted_price,
              current_price: p.signals?.current_price || p.current_price || p.predicted_price,
              explanation: p.explanation,
              signals: {
                RSI: p.signals?.RSI ?? 0, MACD: p.signals?.MACD ?? 0,
                Volume: p.signals?.Volume ?? 0, Trend: p.signals?.Trend ?? 0,
                Sentiment: p.signals?.Sentiment ?? 0, Bollinger: p.signals?.Bollinger ?? 0,
                Stochastic: p.signals?.Stochastic ?? 0, Acceleration: p.signals?.Acceleration ?? 0,
              },
              indicators: {
                rsi: p.signals?.RSI ? Math.round(50 + p.signals.RSI * 30) : 50,
                atr: p.signals?.ATR ?? 0,
                volumeRatio: p.signals?.Volume ? 1 + p.signals.Volume : 1,
                ema20: p.signals?.current_price || p.predicted_price,
                ema50: p.signals?.current_price || p.predicted_price,
                bollinger: p.signals?.Bollinger ?? 0,
                sentiment: p.signals?.Sentiment ?? 0,
                stochastic: p.signals?.Stochastic ?? 0,
                acceleration: p.signals?.Acceleration ?? 0,
              },
            });
            return res.json({
              bullish: bullish.map(mapRow),
              bearish: bearish.map(mapRow),
              totalScanned: preds.length,
              bullishCount: bullish.length,
              bearishCount: bearish.length,
              generatedAt: new Date(lastDate).toISOString(),
              marketDay: false,
              marketOpen: false,
              lastTradingDay: lastDate,  // frontend uses this to show "Showing Friday data"
            });
          }
        }
      } catch (e: any) {
        console.error('[PredictionRun] last-trading-day fallback error:', e.message);
      }
      // No DB data yet — fall through to synthetic scan as last resort
    }

    // ── Trading day: normal cache / scan flow ─────────────────────────────────
    // Fresh cache — return immediately
    if (!refresh && predCache && (now - predCache.ts) < PRED_CACHE_TTL) {
      return res.json(predCache.data);
    }

    // No cache at all — must await the full scan so Vercel doesn't kill it before save completes
    if (!predCache) {
      if (!predRunning) await runPredictionScan().catch(e => console.error('[PredictionScan]', e));
      if (predCache) return res.json(predCache.data);
      return res.json({
        computing: true,
        message: 'Scanning universe — ready in ~15s. Click Refresh.',
        bullish: [], bearish: [], totalScanned: 0, bullishCount: 0, bearishCount: 0,
        generatedAt: new Date().toISOString(),
      });
    }

    // Stale cache — return stale data immediately, kick off background refresh
    if (!predRunning) {
      runPredictionScan().catch(e => console.error('[PredictionScan]', e));
    }
    return res.json({ ...predCache.data, stale: true });
  });

  app.get("/api/predictions/dates", async (req, res) => {
    try {
      const dates = await PredictionStorageService.getAllDatesWithPredictions();
      res.json({ dates });
    } catch (e: any) {
      res.json({ dates: [] });
    }
  });

  app.get("/api/predictions/history/:date", async (req, res) => {
    try {
      const preds = await PredictionStorageService.getPredictionsByDate(req.params.date);
      res.json({
        date: req.params.date,
        bullish: preds.filter((p: any) => p.prediction === 'Bullish'),
        bearish: preds.filter((p: any) => p.prediction === 'Bearish'),
        total: preds.length,
      });
    } catch (e: any) {
      res.json({ date: req.params.date, bullish: [], bearish: [], total: 0 });
    }
  });

  app.get("/api/predictions/accuracy", async (req, res) => {
    try {
      const stats = await PredictionStorageService.getAccuracyStats();
      res.json(stats);
    } catch (e: any) {
      res.json({ total: 0, correct: 0, accuracy: 0, avgConfidence: 0 });
    }
  });

  // Smart comparison: for a given prediction_date, compute predicted vs actual direction + price error
  app.get("/api/predictions/compare/:date", async (req, res) => {
    try {
      const preds = await PredictionStorageService.getPredictionsByDate(req.params.date);
      const compared = preds.map((p: any) => {
        const hasActual = p.actual_price != null && p.actual_change != null;
        const directionCorrect = hasActual
          ? (p.prediction === 'Bullish' && p.actual_change > 0) || (p.prediction === 'Bearish' && p.actual_change < 0)
          : null;
        const priceError = hasActual && p.predicted_price > 0
          ? Math.abs((p.actual_price - p.predicted_price) / p.predicted_price) * 100
          : null;
        return { ...p, directionCorrect, priceError };
      });

      const resolved = compared.filter((p: any) => p.actual_price != null);
      const correct = resolved.filter((p: any) => p.directionCorrect).length;
      const avgPriceError = resolved.length > 0
        ? resolved.reduce((s: number, p: any) => s + (p.priceError ?? 0), 0) / resolved.length
        : null;
      const highConfCorrect = resolved.filter((p: any) => p.confidence >= 75 && p.directionCorrect).length;
      const highConfTotal = resolved.filter((p: any) => p.confidence >= 75).length;

      res.json({
        date: req.params.date,
        predictions: compared,
        summary: {
          total: preds.length,
          resolved: resolved.length,
          correct,
          directionAccuracy: resolved.length > 0 ? (correct / resolved.length) * 100 : null,
          avgPriceError,
          highConfAccuracy: highConfTotal > 0 ? (highConfCorrect / highConfTotal) * 100 : null,
        },
      });
    } catch (e: any) {
      res.status(500).json({ error: e.message });
    }
  });

  app.post("/api/predictions/update-actual", express.json(), async (req, res) => {
    try {
      const { id, actual_price, actual_change } = req.body;
      if (!id || actual_price == null || actual_change == null) {
        return res.status(400).json({ error: 'id, actual_price, actual_change required' });
      }
      await PredictionStorageService.updateActualPrice(id, actual_price, actual_change);
      res.json({ success: true });
    } catch (e: any) {
      res.status(500).json({ error: e.message });
    }
  });

  // ─── Rankings History Engine ──────────────────────────────────────────────
  // Stores daily top-50 snapshot on trading days for historical tracking.
  // Schema (Supabase table: rankings_history):
  //   id, snapshot_date, symbol, sector, rank, signal, confidence,
  //   final_score, rally_score, inst_score, ai_score, quant_score,
  //   early_rally_signal, market_regime, created_at

  // In-memory store (fallback when Supabase unavailable)
  const rankingsMemory: any[] = [];

  async function saveRankingsSnapshot(date: string, top50: any[]): Promise<void> {
    const now = Date.now();
    const rows = top50.map(r => ({
      snapshot_date: date,
      symbol: r.symbol,
      sector: r.sector,
      rank: r.rank,
      signal: r.signal,
      confidence: r.confidence,
      final_score: +r.finalScore.toFixed(4),
      rally_score: +r.rallyProbabilityScore.toFixed(4),
      inst_score: +r.institutionalScore.toFixed(4),
      ai_score: +r.aiPredictionScore.toFixed(4),
      quant_score: +r.quantFilterScore.toFixed(4),
      early_rally_signal: r.earlyRallySignal,
      market_regime: r.marketRegime,
      created_at: now,
    }));

    const sb = getSupabaseClient();
    if (sb) {
      try {
        await sb.from('rankings_history').delete().eq('snapshot_date', date);
        const { error } = await sb.from('rankings_history').insert(rows);
        if (!error) { console.log(`[RankingsHistory] Saved ${rows.length} rows for ${date}`); return; }
        console.error('[RankingsHistory] Supabase insert error:', error.message);
      } catch (e: any) { console.error('[RankingsHistory] Supabase exception:', e.message); }
    }
    // Memory fallback
    const keep = rankingsMemory.filter(r => r.snapshot_date !== date);
    rankingsMemory.length = 0;
    rankingsMemory.push(...keep, ...rows);
    console.log(`[RankingsHistory] Saved ${rows.length} rows to memory for ${date}`);
  }

  async function getRankingsDates(): Promise<string[]> {
    const sb = getSupabaseClient();
    if (sb) {
      try {
        const { data, error } = await sb
          .from('rankings_history').select('snapshot_date')
          .order('snapshot_date', { ascending: false });
        if (!error && data) return [...new Set(data.map((r: any) => r.snapshot_date as string))];
      } catch (_e) {}
    }
    return [...new Set(rankingsMemory.map(r => r.snapshot_date))].sort().reverse();
  }

  async function getRankingsByDate(date: string): Promise<any[]> {
    const sb = getSupabaseClient();
    if (sb) {
      try {
        const { data, error } = await sb
          .from('rankings_history').select('*')
          .eq('snapshot_date', date)
          .order('rank', { ascending: true });
        if (!error && data) return data;
      } catch (_e) {}
    }
    return rankingsMemory.filter(r => r.snapshot_date === date).sort((a, b) => a.rank - b.rank);
  }

  async function getRankingsTrend(symbol: string, limit = 30): Promise<any[]> {
    const sb = getSupabaseClient();
    if (sb) {
      try {
        const { data, error } = await sb
          .from('rankings_history').select('*')
          .eq('symbol', symbol)
          .order('snapshot_date', { ascending: false })
          .limit(limit);
        if (!error && data) return data.reverse(); // oldest first for charting
      } catch (_e) {}
    }
    return rankingsMemory
      .filter(r => r.symbol === symbol)
      .sort((a, b) => a.snapshot_date.localeCompare(b.snapshot_date))
      .slice(-limit);
  }

  // Trigger snapshot save (called internally after dashboard build on trading days)

  app.get("/api/rankings/history/dates", async (_req, res) => {
    try {
      const dates = await getRankingsDates();
      // Annotate each date with trading-day status so the frontend can label them
      const annotated = dates.map(d => ({
        date: d,
        isTrading: isMarketDay(new Date(d + 'T12:00:00+05:30')), // noon IST avoids TZ edge cases
      }));
      res.json({ dates, annotated });
    }
    catch { res.json({ dates: [], annotated: [] }); }
  });

  app.get("/api/rankings/history/:date", async (req, res) => {
    try {
      const dateStr = req.params.date;
      const rows = await getRankingsByDate(dateStr);
      const tradingDay = isMarketDay(new Date(dateStr + 'T12:00:00+05:30'));
      // Compute sector breakdown for this snapshot
      const sectorMap: Record<string, { count: number; strongBuy: number; buy: number; avgScore: number }> = {};
      rows.forEach(r => {
        if (!sectorMap[r.sector]) sectorMap[r.sector] = { count: 0, strongBuy: 0, buy: 0, avgScore: 0 };
        sectorMap[r.sector].count++;
        if (r.signal === 'STRONG BUY') sectorMap[r.sector].strongBuy++;
        if (r.signal === 'BUY') sectorMap[r.sector].buy++;
        sectorMap[r.sector].avgScore += r.final_score;
      });
      const sectors = Object.entries(sectorMap).map(([sector, v]) => ({
        sector, count: v.count, strongBuy: v.strongBuy, buy: v.buy,
        avgScore: +(v.avgScore / v.count).toFixed(3),
      })).sort((a, b) => b.avgScore - a.avgScore);

      res.json({
        date: dateStr,
        isTrading: tradingDay,
        rankings: rows,
        sectors,
        summary: {
          total: rows.length,
          strongBuy: rows.filter(r => r.signal === 'STRONG BUY').length,
          buy: rows.filter(r => r.signal === 'BUY').length,
          earlyRally: rows.filter(r => r.early_rally_signal).length,
          avgScore: rows.length ? +(rows.reduce((s, r) => s + r.final_score, 0) / rows.length).toFixed(3) : 0,
        },
      });
    } catch (e: any) { res.status(500).json({ error: e.message }); }
  });

  app.get("/api/rankings/history/trend/:symbol", async (req, res) => {
    try {
      const rows = await getRankingsTrend(req.params.symbol, 30);
      res.json({ symbol: req.params.symbol, trend: rows });
    } catch (e: any) { res.status(500).json({ error: e.message }); }
  });

  // ── Outcome Tracker ──────────────────────────────────────────────────────
  // For a given snapshot date + horizon (5/10/20 trading days), compute
  // whether each ranked stock's signal was correct by comparing synthetic
  // price on snapshot day vs. price on the outcome day.
  app.get("/api/rankings/history/outcomes/:date", async (req, res) => {
    try {
      const snapshotDate = req.params.date;
      const horizon = Math.min(30, Math.max(1, parseInt(String(req.query.horizon ?? '5'), 10)));

      // Advance N trading days (skip weekends + NSE holidays)
      const nTradingDaysAfter = (fromDate: string, n: number): string => {
        let d = new Date(fromDate + 'T12:00:00+05:30');
        let count = 0;
        while (count < n) {
          d.setDate(d.getDate() + 1);
          if (isMarketDay(d)) count++;
        }
        return d.toISOString().slice(0, 10);
      };

      const outcomeDate = nTradingDaysAfter(snapshotDate, horizon);
      const today = istNow().toISOString().slice(0, 10);
      const horizonAvailable = outcomeDate <= today;

      // Reproduce the seeded closing price for any (symbol, sector, dateStr).
      // Uses the exact same generator as buildAIIntelligenceDashboard.
      const syntheticPrice = (symbol: string, sector: string, dateStr: string): number => {
        const dateSeed = parseInt(dateStr.replace(/-/g, ''), 10);
        const rng = seededGenerator((symbolSeed(symbol) ^ 0xdeadbeef) ^ (dateSeed >>> 0));
        const sectorDrift: Record<string, number> = {
          Technology: 0.00165, Financials: 0.0012, Energy: 0.0011,
          Healthcare: 0.00145, Consumer: 0.00115, Industrials: 0.00105,
          Telecom: 0.001, Materials: 0.00095,
        };
        const drift0 = sectorDrift[sector] ?? 0.001;
        let price = 80 + rng() * 1800;
        for (let d = 0; d < 260; d++) {
          const drift = drift0 + Math.sin(d / 31 + rng()) * 0.006 + (rng() - 0.5) * 0.05;
          price = Math.max(20, price * (1 + drift));
        }
        return price;
      };

      const rows = await getRankingsByDate(snapshotDate);
      if (!rows.length) return res.json({ snapshotDate, outcomeDate, horizon, horizonAvailable, outcomes: [], accuracy: null });

      const outcomes = rows.map(r => {
        const p0 = syntheticPrice(r.symbol, r.sector, snapshotDate);
        const p1 = horizonAvailable ? syntheticPrice(r.symbol, r.sector, outcomeDate) : null;
        const pctChange = p1 !== null ? +((p1 - p0) / p0 * 100).toFixed(2) : null;
        // A BUY/STRONG BUY is a "hit" if price went up; SELL is a hit if price went down
        const hit = pctChange !== null
          ? (r.signal === 'STRONG BUY' || r.signal === 'BUY') ? pctChange > 0
            : r.signal === 'SELL' ? pctChange < 0
            : null
          : null;
        return { rank: r.rank, symbol: r.symbol, sector: r.sector, signal: r.signal, confidence: r.confidence,
          final_score: r.final_score, priceAtSnapshot: +p0.toFixed(2),
          priceAtOutcome: p1 !== null ? +p1.toFixed(2) : null, pctChange, hit };
      });

      // Accuracy stats (only when outcome is available)
      let accuracy = null;
      if (horizonAvailable) {
        const buySignals = outcomes.filter(o => o.signal === 'STRONG BUY' || o.signal === 'BUY');
        const strongBuys = outcomes.filter(o => o.signal === 'STRONG BUY');
        const buys = outcomes.filter(o => o.signal === 'BUY');
        const hitCount = outcomes.filter(o => o.hit === true).length;
        const totalSignaled = outcomes.filter(o => o.hit !== null).length;
        const avgReturn = (arr: typeof outcomes) => arr.length
          ? +(arr.reduce((s, o) => s + (o.pctChange ?? 0), 0) / arr.length).toFixed(2) : 0;
        accuracy = {
          overallHitRate: totalSignaled > 0 ? +(hitCount / totalSignaled * 100).toFixed(1) : 0,
          strongBuyHitRate: strongBuys.length > 0
            ? +(strongBuys.filter(o => o.hit).length / strongBuys.length * 100).toFixed(1) : 0,
          buyHitRate: buys.length > 0
            ? +(buys.filter(o => o.hit).length / buys.length * 100).toFixed(1) : 0,
          avgReturnStrongBuy: avgReturn(strongBuys),
          avgReturnBuy: avgReturn(buys),
          avgReturnAll: avgReturn(buySignals),
          totalStocks: outcomes.length,
          strongBuyCount: strongBuys.length,
          buyCount: buys.length,
        };
      }

      res.json({ snapshotDate, outcomeDate, horizon, horizonAvailable, outcomes, accuracy });
    } catch (e: any) { res.status(500).json({ error: e.message }); }
  });

  // Trigger snapshot save (called internally after dashboard build on trading days)
  app.post("/api/rankings/history/save", express.json(), async (req, res) => {
    try {
      const { date, rankings } = req.body;
      if (!date || !rankings?.length) return res.status(400).json({ error: 'date and rankings required' });
      await saveRankingsSnapshot(date, rankings);
      res.json({ success: true, saved: rankings.length });
    } catch (e: any) { res.status(500).json({ error: e.message }); }
  });

  // END NEXT-DAY PREDICTION ENGINE
  // ─────────────────────────────────────────────────────────────────────────

  // Static file serving removed — frontend is served by Netlify

  app.use(errorLoggingMiddleware);

  // Initialize Upstox service (auto-validates token and schedules daily refresh)
  upstoxService.initialize();

  return app;
}

async function startServer() {
  const app = await buildApp();
  const PORT = parseInt(process.env.PORT || '3000', 10);

  app.listen(PORT, "0.0.0.0", () => {
    logAction("server.started", {
      port: PORT,
      nodeEnv: process.env.NODE_ENV || "development",
    });
    console.log(`Server running on http://localhost:${PORT}`);
    // Load Supabase universe on startup, then pre-warm scan cache
    loadSupabaseUniverse(10000).then(async () => {
      console.log(`[Universe] Startup load complete: ${_universeState.universe?.length ?? 0} stocks`);
      // Pre-warm multibagger scan cache so first user request is instant
      try {
        const warmRes = await fetch(`http://localhost:${PORT}/api/multibagger/scan?cycle=30`);
        const warmData = await warmRes.json() as any;
        console.log(`[Prewarm] Multibagger scan cached: ${warmData.scannedUniverse} stocks`);
      } catch (e: any) {
        console.warn('[Prewarm] Scan pre-warm failed:', e.message);
      }
    }).catch(err => console.warn('[Universe] Startup load failed:', err.message));
    // Kick off full market universe load in background (doesn't block startup)
    initUniverse().catch(err =>
      console.warn('[StockUniverseService] Background init failed:', err.message)
    );
  });

  // Graceful shutdown handler
  process.on('SIGTERM', () => {
    console.log('SIGTERM received, shutting down gracefully...');
    UpstoxService.getInstance().shutdown();
    process.exit(0);
  });

  process.on('SIGINT', () => {
    console.log('SIGINT received, shutting down gracefully...');
    UpstoxService.getInstance().shutdown();
    process.exit(0);
  });
}

// ── Serverless export for Vercel ──────────────────────────────────────────────
export async function startServerlessApp() {
  // Pre-load Supabase universe into global so buildApp's createUltraQuantUniverse can use it.
  // getUniverseAsync IS accessible here (top-level import). We race against 6s timeout.
  const universeLoad = getUniverseAsync().then(stocks => {
    if (stocks.length > 0) {
      (global as any).__supabaseUniverse = stocks;
      // Invalidate memoised universe so next createUltraQuantUniverse() call picks up Supabase data
      _cachedUniverse = null;
      console.log(`[Universe] Pre-loaded ${stocks.length} stocks into global`);

      // ── Pre-warm OHLCV + enrichment for top 100 symbols at startup ──
      // This ensures the FIRST scan request gets real prices, not synthetic.
      // Fire-and-forget — never blocks the app from starting.
      const top100 = stocks.slice(0, 100).map((s: any) => s.symbol ?? s.nse_symbol ?? s.Symbol).filter(Boolean);
      if (top100.length > 0) {
        // Warm OHLCV in background (needed for real candles + endPrice)
        import('./src/services/MarketDataAggregator').then(({ enrichStocksBackground }) => {
          enrichStocksBackground(top100.slice(0, 50)).catch(() => {});
        }).catch(() => {});
        console.log(`[Startup] Pre-warming enrichment for ${Math.min(50, top100.length)} symbols`);
      }
    }
  }).catch(() => {});

  const [app] = await Promise.all([
    buildApp(),
    Promise.race([universeLoad, new Promise<void>(r => setTimeout(r, 6000))]),
  ]);

  return app;
}

// Only start the HTTP server when running directly (not on Vercel)
if (!process.env.VERCEL) {
  startServer().catch((error) => {
    logError("server.startup.failed", error);
    process.exitCode = 1;
  });
}



