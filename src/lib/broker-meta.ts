import type { Broker } from "@/db/schema";

export type Provider = "dhan" | "angelone" | "kotakneo" | "deltaexchange" | "zerodha" | "upstox" | "fyers" | "shoonya" | "flattrade" | "aliceblue" | "fivepaisa" | "icicibreeze";

export const PROVIDERS: { id: Provider; name: string; color: string; docs: string; fields: { key: keyof Broker; label: string; hint: string; secret?: boolean }[] }[] = [
  {
    id: "dhan",
    name: "Dhan",
    color: "#00b386",
    docs: "https://dhanhq.co/docs/v2/",
    fields: [
      { key: "clientId", label: "Dhan Client ID", hint: "e.g. 1000000123" },
      { key: "accessToken", label: "Access Token (JWT)", hint: "Generate from web.dhan.co → My Profile → Access DhanHQ APIs", secret: true },
    ],
  },
  {
    id: "angelone",
    name: "Angel One (SmartAPI)",
    color: "#ff6b00",
    docs: "https://smartapi.angelbroking.com/docs",
    fields: [
      { key: "clientId", label: "Client Code", hint: "e.g. A123456" },
      { key: "apiKey", label: "API Key", hint: "From smartapi.angelbroking.com → My Apps", secret: true },
      { key: "mpin", label: "MPIN / Password", hint: "Trading PIN", secret: true },
      { key: "totpSecret", label: "TOTP Secret", hint: "Base32 secret from SmartAPI TOTP enable page", secret: true },
      { key: "accessToken", label: "JWT Token (optional)", hint: "Auto-generated on Login. Paste if you already have one.", secret: true },
    ],
  },
  {
    id: "zerodha",
    name: "Zerodha (Kite Connect)",
    color: "#387ed1",
    docs: "https://kite.trade/docs/connect/v3/",
    fields: [
      { key: "apiKey", label: "API Key", hint: "developers.kite.trade → Create app (₹500/month Connect plan)", secret: true },
      { key: "accessToken", label: "Access Token", hint: "Daily token from the request-token login flow (valid till ~7:30 AM next day)", secret: true },
      { key: "clientId", label: "Client ID (optional)", hint: "e.g. AB1234" },
    ],
  },
  {
    id: "upstox",
    name: "Upstox",
    color: "#5a2d82",
    docs: "https://upstox.com/developer/api-documentation",
    fields: [
      { key: "accessToken", label: "Access Token", hint: "upstox.com/developer → app → generate token (valid 1 day)", secret: true },
      { key: "clientId", label: "Client ID (optional)", hint: "UCC e.g. 2AXXXX" },
    ],
  },
  {
    id: "fyers",
    name: "Fyers",
    color: "#f45e29",
    docs: "https://myapi.fyers.in/docsv3",
    fields: [
      { key: "clientId", label: "App ID", hint: "e.g. XC4EODE5IB-100 (myapi.fyers.in)" },
      { key: "accessToken", label: "Access Token", hint: "Daily token from auth-code flow", secret: true },
    ],
  },
  {
    id: "shoonya",
    name: "Shoonya (Finvasia)",
    color: "#00a99d",
    docs: "https://shoonya.com/api-documentation",
    fields: [
      { key: "clientId", label: "User ID (UID)", hint: "e.g. FA12345" },
      { key: "password", label: "Password", hint: "Shoonya login password", secret: true },
      { key: "apiKey", label: "API Key", hint: "From Shoonya API portal", secret: true },
      { key: "totpSecret", label: "TOTP Secret", hint: "Base32 secret from 2FA enable page", secret: true },
      { key: "accessToken", label: "Session Token (auto)", hint: "Filled automatically after 🔐 Login", secret: true },
    ],
  },
  {
    id: "flattrade",
    name: "Flattrade",
    color: "#2563eb",
    docs: "https://pi.flattrade.in/docs",
    fields: [
      { key: "clientId", label: "User ID (UID)", hint: "e.g. FT012345" },
      { key: "accessToken", label: "API Token", hint: "wall.flattrade.in → Pi → generate token (daily)", secret: true },
    ],
  },
  {
    id: "aliceblue",
    name: "Alice Blue (ANT)",
    color: "#0ea5e9",
    docs: "https://v2api.aliceblueonline.com/introduction",
    fields: [
      { key: "clientId", label: "User ID", hint: "e.g. AB123456" },
      { key: "apiKey", label: "API Key", hint: "ant.aliceblueonline.com → Apps", secret: true },
      { key: "accessToken", label: "Session ID", hint: "From getUserSID flow (daily)", secret: true },
    ],
  },
  {
    id: "fivepaisa",
    name: "5paisa",
    color: "#ef4444",
    docs: "https://www.5paisa.com/developerapi/overview",
    fields: [
      { key: "clientId", label: "Client Code", hint: "e.g. 5XXXXXXX" },
      { key: "apiKey", label: "User Key", hint: "developerapi key", secret: true },
      { key: "accessToken", label: "Access Token", hint: "From TOTP login flow (daily)", secret: true },
    ],
  },
  {
    id: "icicibreeze",
    name: "ICICI Direct (Breeze)",
    color: "#b45309",
    docs: "https://api.icicidirect.com/apiuser/home",
    fields: [
      { key: "apiKey", label: "App Key", hint: "api.icicidirect.com → Register app", secret: true },
      { key: "apiSecret", label: "Secret Key", hint: "Shown with the app key", secret: true },
      { key: "accessToken", label: "Session Token", hint: "Daily login → API session value", secret: true },
    ],
  },
  {
    id: "deltaexchange",
    name: "Delta Exchange (Crypto)",
    color: "#22c55e",
    docs: "https://docs.delta.exchange",
    fields: [
      { key: "apiKey", label: "API Key", hint: "india.delta.exchange → Account → API Keys (trading permission)", secret: true },
      { key: "apiSecret", label: "API Secret", hint: "Shown once while creating the key", secret: true },
    ],
  },
  {
    id: "kotakneo",
    name: "Kotak Neo",
    color: "#e4002b",
    docs: "https://github.com/Kotak-Neo/kotak-neo-api",
    fields: [
      { key: "apiKey", label: "Consumer Key", hint: "From Neo API portal", secret: true },
      { key: "apiSecret", label: "Consumer Secret", hint: "From Neo API portal", secret: true },
      { key: "mobile", label: "Mobile Number", hint: "+919999999999" },
      { key: "password", label: "Login Password", hint: "Neo login password", secret: true },
      { key: "mpin", label: "MPIN", hint: "6 digit MPIN", secret: true },
      { key: "accessToken", label: "Session Token (optional)", hint: "Auto-generated on Login", secret: true },
      { key: "clientId", label: "Server ID / sid (optional)", hint: "Filled automatically after login" },
    ],
  },
];

