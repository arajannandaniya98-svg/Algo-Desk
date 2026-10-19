import {
  pgTable,
  serial,
  text,
  integer,
  boolean,
  timestamp,
  doublePrecision,
  jsonb,
  index,
} from "drizzle-orm/pg-core";

// ---------- Broker accounts (Dhan / Angel One / Kotak Neo) ----------
export const brokers = pgTable("brokers", {
  id: serial("id").primaryKey(),
  label: text("label").notNull(),
  provider: text("provider").notNull(), // dhan | angelone | kotakneo
  clientId: text("client_id").notNull().default(""),
  apiKey: text("api_key").notNull().default(""),
  apiSecret: text("api_secret").notNull().default(""),
  accessToken: text("access_token").notNull().default(""),
  totpSecret: text("totp_secret").notNull().default(""),
  mobile: text("mobile").notNull().default(""),
  password: text("password").notNull().default(""),
  mpin: text("mpin").notNull().default(""),
  mode: text("mode").notNull().default("paper"), // paper | live
  isDefault: boolean("is_default").notNull().default(false),
  isActive: boolean("is_active").notNull().default(true),
  extra: jsonb("extra").$type<Record<string, string>>().notNull().default({}),
  createdAt: timestamp("created_at").notNull().defaultNow(),
  updatedAt: timestamp("updated_at").notNull().defaultNow(),
});

// ---------- Instruments master (all segments) ----------
export const instruments = pgTable("instruments", {
  id: serial("id").primaryKey(),
  symbol: text("symbol").notNull().unique(),
  name: text("name").notNull(),
  exchange: text("exchange").notNull(), // NSE | BSE | NFO | MCX | CDS
  segment: text("segment").notNull(), // EQ | INDEX | FUT | OPT | COMMODITY | CURRENCY
  sector: text("sector").notNull().default("Other"),
  lotSize: integer("lot_size").notNull().default(1),
  basePrice: doublePrecision("base_price").notNull(),
  marketCap: doublePrecision("market_cap").notNull().default(0), // in crores
  pe: doublePrecision("pe").notNull().default(0),
  high52: doublePrecision("high_52").notNull().default(0),
  low52: doublePrecision("low_52").notNull().default(0),
  isFno: boolean("is_fno").notNull().default(false),
  volatility: doublePrecision("volatility").notNull().default(0.2),
  createdAt: timestamp("created_at").notNull().defaultNow(),
});

// ---------- Account settings (capital / risk) ----------
export const appSettings = pgTable("app_settings", {
  id: integer("id").primaryKey(),
  capital: doublePrecision("capital").notNull().default(10000),
  riskPerTradePct: doublePrecision("risk_per_trade_pct").notNull().default(1),
  maxDailyLossPct: doublePrecision("max_daily_loss_pct").notNull().default(3),
  enforceCapital: boolean("enforce_capital").notNull().default(true),
  autoExcelMinutes: integer("auto_excel_minutes").notNull().default(5),
  feedBrokerId: integer("feed_broker_id"),
  feedAutoStart: boolean("feed_auto_start").notNull().default(false),
  tokenSync: jsonb("token_sync").$type<Record<string, { at: string; rows: number }>>().notNull().default({}),
  autoTrade: jsonb("auto_trade").$type<{
    enabled: boolean;
    symbols: string[];
    interval: string;
    maxPositions: number;
    minScore: number;
    defaultLots: number;
  }>().notNull().default({
    enabled: false,
    symbols: ["NIFTY", "BANKNIFTY", "RELIANCE", "BTCUSD"],
    interval: "15m",
    maxPositions: 3,
    minScore: 40,
    defaultLots: 1,
  }),
  indicatorConfig: jsonb("indicator_config").$type<Record<string, number>>().notNull().default({}),
  updatedAt: timestamp("updated_at").notNull().defaultNow(),
});

// ---------- Multi-leg strategies built in Strategy Builder ----------
export const strategies = pgTable("strategies", {
  id: serial("id").primaryKey(),
  name: text("name").notNull(),
  template: text("template").notNull().default("CUSTOM"),
  underlying: text("underlying").notNull(),
  exchange: text("exchange").notNull().default("NSE"),
  expiry: text("expiry").notNull().default(""),
  spot: doublePrecision("spot").notNull().default(0),
  lots: integer("lots").notNull().default(1),
  lotSize: integer("lot_size").notNull().default(1),
  netPremium: doublePrecision("net_premium").notNull().default(0),
  maxProfit: doublePrecision("max_profit").notNull().default(0),
  maxLoss: doublePrecision("max_loss").notNull().default(0),
  breakevens: jsonb("breakevens").$type<number[]>().notNull().default([]),
  marginRequired: doublePrecision("margin_required").notNull().default(0),
  status: text("status").notNull().default("DRAFT"),
  notes: text("notes").notNull().default(""),
  createdAt: timestamp("created_at").notNull().defaultNow(),
  updatedAt: timestamp("updated_at").notNull().defaultNow(),
});

// ---------- Users / sessions / audit (admin panel & security) ----------
export const users = pgTable("users", {
  id: serial("id").primaryKey(),
  username: text("username").notNull().unique(),
  displayName: text("display_name").notNull().default(""),
  passwordHash: text("password_hash").notNull(),
  role: text("role").notNull().default("viewer"), // admin | trader | viewer
  isActive: boolean("is_active").notNull().default(true),
  mustChangePassword: boolean("must_change_password").notNull().default(false),
  totpSecret: text("totp_secret").notNull().default(""), // AES-256-GCM sealed
  totpEnabled: boolean("totp_enabled").notNull().default(false),
  totpLastCounter: integer("totp_last_counter").notNull().default(0),
  mobile: text("mobile").notNull().default(""), // for OTP password reset (+91XXXXXXXXXX)
  email: text("email").notNull().default(""), // for login OTP confirmation (Gmail etc.)
  loginOtpChannel: text("login_otp_channel").notNull().default("none"), // none | email | mobile | both
  loginOtpHash: text("login_otp_hash").notNull().default(""),
  loginOtpExpires: timestamp("login_otp_expires"),
  loginOtpAttempts: integer("login_otp_attempts").notNull().default(0),
  resetOtpHash: text("reset_otp_hash").notNull().default(""),
  resetOtpExpires: timestamp("reset_otp_expires"),
  resetOtpAttempts: integer("reset_otp_attempts").notNull().default(0),
  failedAttempts: integer("failed_attempts").notNull().default(0),
  lockedUntil: timestamp("locked_until"),
  lastLoginAt: timestamp("last_login_at"),
  lastLoginIp: text("last_login_ip").notNull().default(""),
  passwordChangedAt: timestamp("password_changed_at").notNull().defaultNow(),
  createdAt: timestamp("created_at").notNull().defaultNow(),
  updatedAt: timestamp("updated_at").notNull().defaultNow(),
});

export const sessions = pgTable(
  "sessions",
  {
    id: serial("id").primaryKey(),
    tokenHash: text("token_hash").notNull().unique(), // SHA-256 of the cookie token
    userId: integer("user_id").notNull(),
    ip: text("ip").notNull().default(""),
    userAgent: text("user_agent").notNull().default(""),
    createdAt: timestamp("created_at").notNull().defaultNow(),
    lastSeenAt: timestamp("last_seen_at").notNull().defaultNow(),
    expiresAt: timestamp("expires_at").notNull(),
    revokedAt: timestamp("revoked_at"),
  },
  (t) => [index("sessions_user_idx").on(t.userId)],
);

export const auditLogs = pgTable(
  "audit_logs",
  {
    id: serial("id").primaryKey(),
    userId: integer("user_id"),
    username: text("username").notNull().default(""),
    action: text("action").notNull(),
    target: text("target").notNull().default(""),
    detail: text("detail").notNull().default(""),
    ip: text("ip").notNull().default(""),
    userAgent: text("user_agent").notNull().default(""),
    success: boolean("success").notNull().default(true),
    createdAt: timestamp("created_at").notNull().defaultNow(),
  },
  (t) => [index("audit_created_idx").on(t.createdAt)],
);

export const securitySettings = pgTable("security_settings", {
  id: integer("id").primaryKey(),
  sessionIdleMinutes: integer("session_idle_minutes").notNull().default(120),
  sessionMaxHours: integer("session_max_hours").notNull().default(12),
  maxLoginAttempts: integer("max_login_attempts").notNull().default(5),
  lockoutMinutes: integer("lockout_minutes").notNull().default(15),
  passwordMinLength: integer("password_min_length").notNull().default(10),
  require2faAdmin: boolean("require_2fa_admin").notNull().default(false),
  setupCodeHash: text("setup_code_hash").notNull().default(""),
  setupCodeExpires: timestamp("setup_code_expires"),
  updatedAt: timestamp("updated_at").notNull().defaultNow(),
});

// ---------- Broker instrument tokens (scrip master) for the live feed ----------
export const instrumentTokens = pgTable(
  "instrument_tokens",
  {
    id: serial("id").primaryKey(),
    provider: text("provider").notNull(), // dhan | angelone
    symbol: text("symbol").notNull(), // app symbol (EQ/INDEX) or underlying (FUT/CE/PE)
    tradingSymbol: text("trading_symbol").notNull().default(""),
    exchange: text("exchange").notNull(), // NSE | BSE | MCX | CDS
    segment: text("segment").notNull(), // dhan: NSE_FNO… / angel: exchangeType "2"…
    token: text("token").notNull(),
    instrumentType: text("instrument_type").notNull(), // EQ | INDEX | FUT | CE | PE
    expiry: text("expiry").notNull().default(""),
    strike: doublePrecision("strike").notNull().default(0),
    lotSize: integer("lot_size").notNull().default(1),
  },
  (t) => [index("itok_lookup_idx").on(t.provider, t.symbol, t.instrumentType, t.expiry), index("itok_token_idx").on(t.provider, t.token)],
);

// ---------- Algo setups (single-leg or one leg of a strategy) ----------
export const setups = pgTable("setups", {
  id: serial("id").primaryKey(),
  name: text("name").notNull(),
  brokerId: integer("broker_id"),
  symbol: text("symbol").notNull(),
  underlying: text("underlying").notNull().default(""),
  exchange: text("exchange").notNull().default("NSE"),
  segment: text("segment").notNull().default("EQ"),
  instrumentType: text("instrument_type").notNull().default("EQ"), // EQ | FUT | CE | PE
  strike: doublePrecision("strike"),
  expiry: text("expiry").notNull().default(""),
  side: text("side").notNull().default("BUY"), // BUY | SELL
  quantity: integer("quantity").notNull().default(1),
  productType: text("product_type").notNull().default("MIS"), // MIS | CNC | NRML
  orderType: text("order_type").notNull().default("MARKET"), // MARKET | LIMIT
  entryTrigger: text("entry_trigger").notNull().default("MANUAL"), // MANUAL | PRICE_ABOVE | PRICE_BELOW
  entryPrice: doublePrecision("entry_price"),
  stopLoss: doublePrecision("stop_loss"),
  target: doublePrecision("target"),
  trailingSl: doublePrecision("trailing_sl"),
  brokerToken: text("broker_token").notNull().default(""), // securityId / symboltoken
  status: text("status").notNull().default("DRAFT"), // DRAFT | ACTIVE | ENTERED | EXITED | CANCELLED
  entryFilledPrice: doublePrecision("entry_filled_price"),
  exitFilledPrice: doublePrecision("exit_filled_price"),
  entryAt: timestamp("entry_at"),
  exitAt: timestamp("exit_at"),
  exitReason: text("exit_reason").notNull().default(""),
  pnl: doublePrecision("pnl").notNull().default(0),
  notes: text("notes").notNull().default(""),
  meta: jsonb("meta").$type<Record<string, unknown>>().default({}),
  strategyId: integer("strategy_id"),
  legIndex: integer("leg_index").notNull().default(0),
  createdAt: timestamp("created_at").notNull().defaultNow(),
  updatedAt: timestamp("updated_at").notNull().defaultNow(),
});

// ---------- Orders log ----------
export const orders = pgTable("orders", {
  id: serial("id").primaryKey(),
  setupId: integer("setup_id"),
  brokerId: integer("broker_id"),
  provider: text("provider").notNull().default("paper"),
  mode: text("mode").notNull().default("paper"),
  symbol: text("symbol").notNull(),
  exchange: text("exchange").notNull().default("NSE"),
  side: text("side").notNull(),
  quantity: integer("quantity").notNull(),
  orderType: text("order_type").notNull().default("MARKET"),
  productType: text("product_type").notNull().default("MIS"),
  price: doublePrecision("price").notNull().default(0),
  filledPrice: doublePrecision("filled_price"),
  status: text("status").notNull().default("PENDING"), // PENDING | FILLED | REJECTED
  action: text("action").notNull().default("ENTRY"), // ENTRY | EXIT
  brokerOrderId: text("broker_order_id").notNull().default(""),
  message: text("message").notNull().default(""),
  createdAt: timestamp("created_at").notNull().defaultNow(),
});

export type AppSettings = typeof appSettings.$inferSelect;
export type User = typeof users.$inferSelect;
export type Session = typeof sessions.$inferSelect;
export type AuditLog = typeof auditLogs.$inferSelect;
export type SecuritySettings = typeof securitySettings.$inferSelect;
export type InstrumentToken = typeof instrumentTokens.$inferSelect;
export type Strategy = typeof strategies.$inferSelect;
export type Broker = typeof brokers.$inferSelect;
export type Instrument = typeof instruments.$inferSelect;
export type Setup = typeof setups.$inferSelect;
export type Order = typeof orders.$inferSelect;
