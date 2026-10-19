import type { Broker } from "@/db/schema";
import type { Provider } from "./broker-meta";
import { deltaProductId, deltaRequest } from "./data/delta";
export type { Provider } from "./broker-meta";

export interface OrderRequest {
  symbol: string;
  exchange: string; // NSE | BSE | NFO | MCX | CDS
  segment: string;
  instrumentType: string;
  side: "BUY" | "SELL";
  quantity: number;
  orderType: "MARKET" | "LIMIT";
  productType: "MIS" | "CNC" | "NRML";
  price: number;
  brokerToken?: string;
}

export interface OrderResult {
  ok: boolean;
  brokerOrderId: string;
  filledPrice: number | null;
  status: "FILLED" | "PENDING" | "REJECTED";
  message: string;
}

// ---------- helpers ----------
function genId(prefix: string) {
  return `${prefix}${Date.now().toString(36).toUpperCase()}${Math.floor(Math.random() * 1e4)
    .toString()
    .padStart(4, "0")}`;
}

async function safeFetch(url: string, init: RequestInit, timeoutMs = 10000): Promise<{ status: number; body: unknown }> {
  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), timeoutMs);
  try {
    const res = await fetch(url, { ...init, signal: ctrl.signal });
    const text = await res.text();
    let body: unknown = text;
    try {
      body = JSON.parse(text);
    } catch {
      /* keep text */
    }
    return { status: res.status, body };
  } finally {
    clearTimeout(t);
  }
}

function paperFill(req: OrderRequest, provider: string): OrderResult {
  const slippage = req.orderType === "MARKET" ? req.price * 0.0005 * (req.side === "BUY" ? 1 : -1) : 0;
  const filled = +(req.price + slippage).toFixed(2);
  return {
    ok: true,
    brokerOrderId: genId("PAPER-"),
    filledPrice: filled,
    status: "FILLED",
    message: `Paper trade executed via ${provider.toUpperCase()} simulator`,
  };
}

// ---------- Dhan ----------
function dhanExchangeSegment(req: OrderRequest) {
  if (req.exchange === "MCX") return "MCX_COMM";
  if (req.exchange === "CDS") return "NSE_CURRENCY";
  if (req.exchange === "BSE") return req.instrumentType === "EQ" ? "BSE_EQ" : "BSE_FNO";
  return req.instrumentType === "EQ" ? "NSE_EQ" : "NSE_FNO";
}
async function placeDhan(b: Broker, req: OrderRequest): Promise<OrderResult> {
  if (!b.accessToken || !b.clientId) return { ok: false, brokerOrderId: "", filledPrice: null, status: "REJECTED", message: "Dhan: clientId / accessToken missing" };
  if (!req.brokerToken) return { ok: false, brokerOrderId: "", filledPrice: null, status: "REJECTED", message: "Dhan: securityId (Broker Token) required in setup" };
  const payload = {
    dhanClientId: b.clientId,
    correlationId: genId("ALGO"),
    transactionType: req.side,
    exchangeSegment: dhanExchangeSegment(req),
    productType: req.productType === "MIS" ? "INTRADAY" : req.productType === "CNC" ? "CNC" : "MARGIN",
    orderType: req.orderType,
    validity: "DAY",
    securityId: req.brokerToken,
    quantity: req.quantity,
    disclosedQuantity: 0,
    price: req.orderType === "LIMIT" ? req.price : 0,
    triggerPrice: 0,
    afterMarketOrder: false,
  };
  try {
    const { status, body } = await safeFetch("https://api.dhan.co/v2/orders", {
      method: "POST",
      headers: { "Content-Type": "application/json", "access-token": b.accessToken },
      body: JSON.stringify(payload),
    });
    const j = body as { orderId?: string; orderStatus?: string; errorMessage?: string; errorCode?: string };
    if (status >= 200 && status < 300 && j.orderId) {
      return { ok: true, brokerOrderId: j.orderId, filledPrice: null, status: j.orderStatus === "TRADED" ? "FILLED" : "PENDING", message: `Dhan: ${j.orderStatus ?? "placed"}` };
    }
    return { ok: false, brokerOrderId: "", filledPrice: null, status: "REJECTED", message: `Dhan ${status}: ${j.errorMessage ?? JSON.stringify(body).slice(0, 200)}` };
  } catch (e) {
    return { ok: false, brokerOrderId: "", filledPrice: null, status: "REJECTED", message: `Dhan network error: ${(e as Error).message}` };
  }
}

// ---------- Angel One ----------
function angelHeaders(b: Broker) {
  return {
    "Content-Type": "application/json",
    Accept: "application/json",
    "X-UserType": "USER",
    "X-SourceID": "WEB",
    "X-ClientLocalIP": "127.0.0.1",
    "X-ClientPublicIP": "127.0.0.1",
    "X-MACAddress": "00:00:00:00:00:00",
    "X-PrivateKey": b.apiKey,
    Authorization: `Bearer ${b.accessToken}`,
  };
}
async function placeAngel(b: Broker, req: OrderRequest): Promise<OrderResult> {
  if (!b.accessToken || !b.apiKey) return { ok: false, brokerOrderId: "", filledPrice: null, status: "REJECTED", message: "Angel One: API key / JWT token missing (use Login)" };
  if (!req.brokerToken) return { ok: false, brokerOrderId: "", filledPrice: null, status: "REJECTED", message: "Angel One: symboltoken (Broker Token) required in setup" };
  const exchange = req.exchange === "NSE" && req.instrumentType !== "EQ" ? "NFO" : req.exchange === "BSE" && req.instrumentType !== "EQ" ? "BFO" : req.exchange;
  const payload = {
    variety: "NORMAL",
    tradingsymbol: req.symbol,
    symboltoken: req.brokerToken,
    transactiontype: req.side,
    exchange,
    ordertype: req.orderType,
    producttype: req.productType === "MIS" ? "INTRADAY" : req.productType === "CNC" ? "DELIVERY" : "CARRYFORWARD",
    duration: "DAY",
    price: req.orderType === "LIMIT" ? String(req.price) : "0",
    squareoff: "0",
    stoploss: "0",
    quantity: String(req.quantity),
  };
  try {
    const { status, body } = await safeFetch("https://apiconnect.angelone.in/rest/secure/angelbroking/order/v1/placeOrder", {
      method: "POST",
      headers: angelHeaders(b),
      body: JSON.stringify(payload),
    });
    const j = body as { status?: boolean; message?: string; data?: { orderid?: string; uniqueorderid?: string } };
    if (j.status && j.data?.orderid) {
      return { ok: true, brokerOrderId: j.data.orderid, filledPrice: null, status: "PENDING", message: `Angel One: ${j.message ?? "placed"}` };
    }
    return { ok: false, brokerOrderId: "", filledPrice: null, status: "REJECTED", message: `Angel One ${status}: ${j.message ?? JSON.stringify(body).slice(0, 200)}` };
  } catch (e) {
    return { ok: false, brokerOrderId: "", filledPrice: null, status: "REJECTED", message: `Angel One network error: ${(e as Error).message}` };
  }
}

// ---------- Kotak Neo ----------
async function placeKotak(b: Broker, req: OrderRequest): Promise<OrderResult> {
  if (!b.accessToken || !b.clientId) return { ok: false, brokerOrderId: "", filledPrice: null, status: "REJECTED", message: "Kotak Neo: session token / sid missing (use Login)" };
  const es =
    req.exchange === "MCX" ? "mcx_fo" : req.exchange === "CDS" ? "cde_fo" : req.exchange === "BSE" ? (req.instrumentType === "EQ" ? "bse_cm" : "bse_fo") : req.instrumentType === "EQ" ? "nse_cm" : "nse_fo";
  const jData = {
    am: "NO",
    dq: "0",
    es,
    mp: "0",
    pc: req.productType,
    pf: "N",
    pr: req.orderType === "LIMIT" ? String(req.price) : "0",
    pt: req.orderType === "LIMIT" ? "L" : "MKT",
    qt: String(req.quantity),
    rt: "DAY",
    tp: "0",
    ts: req.brokerToken || req.symbol,
    tt: req.side === "BUY" ? "B" : "S",
  };
  const extra = b.extra ?? {};
  const baseUrl = extra.baseUrl || "https://gw-napi.kotaksecurities.com";
  try {
    const { status, body } = await safeFetch(`${baseUrl}/Orders/2.0/quick/order/rule/ms/place?sId=${encodeURIComponent(b.clientId)}`, {
      method: "POST",
      headers: {
        "Content-Type": "application/x-www-form-urlencoded",
        accept: "application/json",
        Sid: b.clientId,
        Auth: b.accessToken,
        "neo-fin-key": "neotradeapi",
        Authorization: `Bearer ${extra.oauthToken ?? ""}`,
      },
      body: `jData=${encodeURIComponent(JSON.stringify(jData))}`,
    });
    const j = body as { stat?: string; nOrdNo?: string; errMsg?: string; emsg?: string };
    if (j.stat === "Ok" && j.nOrdNo) {
      return { ok: true, brokerOrderId: j.nOrdNo, filledPrice: null, status: "PENDING", message: "Kotak Neo: order placed" };
    }
    return { ok: false, brokerOrderId: "", filledPrice: null, status: "REJECTED", message: `Kotak Neo ${status}: ${j.errMsg ?? j.emsg ?? JSON.stringify(body).slice(0, 200)}` };
  } catch (e) {
    return { ok: false, brokerOrderId: "", filledPrice: null, status: "REJECTED", message: `Kotak Neo network error: ${(e as Error).message}` };
  }
}

// ---------- Delta Exchange (crypto) ----------
async function placeDelta(b: Broker, req: OrderRequest): Promise<OrderResult> {
  if (!b.apiKey || !b.apiSecret) return { ok: false, brokerOrderId: "", filledPrice: null, status: "REJECTED", message: "Delta Exchange: API key & secret missing (Brokers page)" };
  const productId = Number(req.brokerToken) || (await deltaProductId(req.symbol));
  if (!productId) return { ok: false, brokerOrderId: "", filledPrice: null, status: "REJECTED", message: `Delta Exchange: unknown product for ${req.symbol}` };
  const body: Record<string, unknown> = {
    product_id: productId,
    size: Math.max(1, Math.round(req.quantity)),
    side: req.side === "BUY" ? "buy" : "sell",
    order_type: req.orderType === "LIMIT" ? "limit_order" : "market_order",
  };
  if (req.orderType === "LIMIT") body.limit_price = String(req.price);
  try {
    const { status, json } = await deltaRequest({ apiKey: b.apiKey, apiSecret: b.apiSecret, method: "POST", path: "/v2/orders", body });
    const result = (json.result ?? {}) as { id?: number; state?: string; average_fill_price?: string };
    if (json.success && result.id) {
      const filled = Number(result.average_fill_price) || null;
      return { ok: true, brokerOrderId: String(result.id), filledPrice: filled, status: result.state === "closed" ? "FILLED" : "PENDING", message: `Delta: ${result.state ?? "placed"}` };
    }
    return { ok: false, brokerOrderId: "", filledPrice: null, status: "REJECTED", message: `Delta ${status}: ${JSON.stringify(json.error ?? json).slice(0, 180)}` };
  } catch (e) {
    return { ok: false, brokerOrderId: "", filledPrice: null, status: "REJECTED", message: `Delta network error: ${(e as Error).message}` };
  }
}

// ---------- Zerodha Kite Connect ----------
function kiteExchange(req: OrderRequest) {
  if (req.exchange === "MCX") return "MCX";
  if (req.exchange === "CDS") return "CDS";
  if (req.exchange === "BSE") return req.instrumentType === "EQ" ? "BSE" : "BFO";
  return req.instrumentType === "EQ" ? "NSE" : "NFO";
}
async function placeZerodha(b: Broker, req: OrderRequest): Promise<OrderResult> {
  if (!b.apiKey || !b.accessToken) return { ok: false, brokerOrderId: "", filledPrice: null, status: "REJECTED", message: "Zerodha: API key / access token missing" };
  const form = new URLSearchParams({
    tradingsymbol: req.brokerToken || req.symbol,
    exchange: kiteExchange(req),
    transaction_type: req.side,
    order_type: req.orderType,
    quantity: String(req.quantity),
    product: req.productType === "CNC" ? "CNC" : req.productType === "NRML" ? "NRML" : "MIS",
    validity: "DAY",
    ...(req.orderType === "LIMIT" ? { price: String(req.price) } : {}),
  });
  try {
    const { status, body } = await safeFetch("https://api.kite.trade/orders/regular", {
      method: "POST",
      headers: { "X-Kite-Version": "3", Authorization: `token ${b.apiKey}:${b.accessToken}`, "Content-Type": "application/x-www-form-urlencoded" },
      body: form.toString(),
    });
    const j = body as { status?: string; data?: { order_id?: string }; message?: string };
    if (j.status === "success" && j.data?.order_id) return { ok: true, brokerOrderId: j.data.order_id, filledPrice: null, status: "PENDING", message: "Zerodha: order placed" };
    return { ok: false, brokerOrderId: "", filledPrice: null, status: "REJECTED", message: `Zerodha ${status}: ${j.message ?? JSON.stringify(body).slice(0, 180)}` };
  } catch (e) {
    return { ok: false, brokerOrderId: "", filledPrice: null, status: "REJECTED", message: `Zerodha network error: ${(e as Error).message}` };
  }
}

// ---------- Upstox v2 ----------
async function placeUpstox(b: Broker, req: OrderRequest): Promise<OrderResult> {
  if (!b.accessToken) return { ok: false, brokerOrderId: "", filledPrice: null, status: "REJECTED", message: "Upstox: access token missing" };
  if (!req.brokerToken) return { ok: false, brokerOrderId: "", filledPrice: null, status: "REJECTED", message: "Upstox: instrument_key required in Broker Token (e.g. NSE_EQ|INE002A01018)" };
  const payload = {
    quantity: req.quantity,
    product: req.productType === "CNC" ? "D" : "I",
    validity: "DAY",
    price: req.orderType === "LIMIT" ? req.price : 0,
    instrument_token: req.brokerToken,
    order_type: req.orderType,
    transaction_type: req.side,
    disclosed_quantity: 0,
    trigger_price: 0,
    is_amo: false,
  };
  try {
    const { status, body } = await safeFetch("https://api.upstox.com/v2/order/place", {
      method: "POST",
      headers: { Authorization: `Bearer ${b.accessToken}`, "Content-Type": "application/json", Accept: "application/json" },
      body: JSON.stringify(payload),
    });
    const j = body as { status?: string; data?: { order_id?: string }; errors?: { message?: string }[] };
    if (j.status === "success" && j.data?.order_id) return { ok: true, brokerOrderId: j.data.order_id, filledPrice: null, status: "PENDING", message: "Upstox: order placed" };
    return { ok: false, brokerOrderId: "", filledPrice: null, status: "REJECTED", message: `Upstox ${status}: ${j.errors?.[0]?.message ?? JSON.stringify(body).slice(0, 180)}` };
  } catch (e) {
    return { ok: false, brokerOrderId: "", filledPrice: null, status: "REJECTED", message: `Upstox network error: ${(e as Error).message}` };
  }
}

// ---------- Fyers v3 ----------
async function placeFyers(b: Broker, req: OrderRequest): Promise<OrderResult> {
  if (!b.clientId || !b.accessToken) return { ok: false, brokerOrderId: "", filledPrice: null, status: "REJECTED", message: "Fyers: App ID / access token missing" };
  if (!req.brokerToken) return { ok: false, brokerOrderId: "", filledPrice: null, status: "REJECTED", message: "Fyers: symbol required in Broker Token (e.g. NSE:SBIN-EQ)" };
  const payload = {
    symbol: req.brokerToken,
    qty: req.quantity,
    type: req.orderType === "LIMIT" ? 1 : 2,
    side: req.side === "BUY" ? 1 : -1,
    productType: req.productType === "CNC" ? "CNC" : req.productType === "NRML" ? "MARGIN" : "INTRADAY",
    limitPrice: req.orderType === "LIMIT" ? req.price : 0,
    stopPrice: 0,
    validity: "DAY",
    disclosedQty: 0,
    offlineOrder: false,
  };
  try {
    const { status, body } = await safeFetch("https://api-t1.fyers.in/api/v3/orders/sync", {
      method: "POST",
      headers: { Authorization: `${b.clientId}:${b.accessToken}`, "Content-Type": "application/json" },
      body: JSON.stringify(payload),
    });
    const j = body as { s?: string; id?: string; message?: string };
    if (j.s === "ok" && j.id) return { ok: true, brokerOrderId: j.id, filledPrice: null, status: "PENDING", message: "Fyers: order placed" };
    return { ok: false, brokerOrderId: "", filledPrice: null, status: "REJECTED", message: `Fyers ${status}: ${j.message ?? JSON.stringify(body).slice(0, 180)}` };
  } catch (e) {
    return { ok: false, brokerOrderId: "", filledPrice: null, status: "REJECTED", message: `Fyers network error: ${(e as Error).message}` };
  }
}

// ---------- Noren platform (Shoonya / Flattrade share the same protocol) ----------
const NOREN_BASE: Record<string, string> = {
  shoonya: "https://api.shoonya.com/NorenWClientTP",
  flattrade: "https://piconnect.flattrade.in/PiConnectTP",
};
function norenTsym(req: OrderRequest): { exch: string; tsym: string } {
  const exch = req.exchange === "MCX" ? "MCX" : req.exchange === "CDS" ? "CDS" : req.exchange === "BSE" ? (req.instrumentType === "EQ" ? "BSE" : "BFO") : req.instrumentType === "EQ" ? "NSE" : "NFO";
  const tsym = req.brokerToken || (req.instrumentType === "EQ" && exch === "NSE" ? `${req.symbol}-EQ` : req.symbol);
  return { exch, tsym };
}
async function placeNoren(provider: "shoonya" | "flattrade", b: Broker, req: OrderRequest): Promise<OrderResult> {
  if (!b.clientId || !b.accessToken) return { ok: false, brokerOrderId: "", filledPrice: null, status: "REJECTED", message: `${provider === "shoonya" ? "Shoonya" : "Flattrade"}: UID / session token missing${provider === "shoonya" ? " (use 🔐 Login)" : ""}` };
  const { exch, tsym } = norenTsym(req);
  const jData = {
    uid: b.clientId,
    actid: b.clientId,
    exch,
    tsym,
    qty: String(req.quantity),
    prc: req.orderType === "LIMIT" ? String(req.price) : "0",
    prd: req.productType === "CNC" ? "C" : req.productType === "NRML" ? "M" : "I",
    trantype: req.side === "BUY" ? "B" : "S",
    prctyp: req.orderType === "LIMIT" ? "LMT" : "MKT",
    ret: "DAY",
    ordersource: "API",
  };
  try {
    const { status, body } = await safeFetch(`${NOREN_BASE[provider]}/PlaceOrder`, {
      method: "POST",
      headers: { "Content-Type": "text/plain" },
      body: `jData=${JSON.stringify(jData)}&jKey=${b.accessToken}`,
    });
    const j = body as { stat?: string; norenordno?: string; emsg?: string };
    if (j.stat === "Ok" && j.norenordno) return { ok: true, brokerOrderId: j.norenordno, filledPrice: null, status: "PENDING", message: `${provider === "shoonya" ? "Shoonya" : "Flattrade"}: order placed` };
    return { ok: false, brokerOrderId: "", filledPrice: null, status: "REJECTED", message: `${provider} ${status}: ${j.emsg ?? JSON.stringify(body).slice(0, 180)}` };
  } catch (e) {
    return { ok: false, brokerOrderId: "", filledPrice: null, status: "REJECTED", message: `${provider} network error: ${(e as Error).message}` };
  }
}

// ---------- Alice Blue ANT ----------
async function placeAliceBlue(b: Broker, req: OrderRequest): Promise<OrderResult> {
  if (!b.clientId || !b.accessToken) return { ok: false, brokerOrderId: "", filledPrice: null, status: "REJECTED", message: "Alice Blue: User ID / session ID missing" };
  const exch = req.exchange === "MCX" ? "MCX" : req.exchange === "CDS" ? "CDS" : req.exchange === "BSE" ? (req.instrumentType === "EQ" ? "BSE" : "BFO") : req.instrumentType === "EQ" ? "NSE" : "NFO";
  const payload = [{
    complexty: "regular",
    discqty: "0",
    exch,
    pCode: req.productType === "CNC" ? "CNC" : req.productType === "NRML" ? "NRML" : "MIS",
    prctyp: req.orderType === "LIMIT" ? "L" : "MKT",
    price: req.orderType === "LIMIT" ? String(req.price) : "",
    qty: req.quantity,
    ret: "DAY",
    symbol_id: req.brokerToken || "",
    trading_symbol: req.symbol,
    transtype: req.side,
    trigPrice: "",
    orderTag: "algodesk",
  }];
  try {
    const { status, body } = await safeFetch("https://ant.aliceblueonline.com/rest/AliceBlueAPIService/api/placeOrder/executePlaceOrder", {
      method: "POST",
      headers: { Authorization: `Bearer ${b.clientId} ${b.accessToken}`, "Content-Type": "application/json" },
      body: JSON.stringify(payload),
    });
    const arr = (Array.isArray(body) ? body : [body]) as { stat?: string; NOrdNo?: string; emsg?: string }[];
    const j = arr[0] ?? {};
    if (j.stat === "Ok" && j.NOrdNo) return { ok: true, brokerOrderId: j.NOrdNo, filledPrice: null, status: "PENDING", message: "Alice Blue: order placed" };
    return { ok: false, brokerOrderId: "", filledPrice: null, status: "REJECTED", message: `Alice Blue ${status}: ${j.emsg ?? JSON.stringify(body).slice(0, 180)}` };
  } catch (e) {
    return { ok: false, brokerOrderId: "", filledPrice: null, status: "REJECTED", message: `Alice Blue network error: ${(e as Error).message}` };
  }
}

// ---------- 5paisa ----------
async function placeFivePaisa(b: Broker, req: OrderRequest): Promise<OrderResult> {
  if (!b.clientId || !b.apiKey || !b.accessToken) return { ok: false, brokerOrderId: "", filledPrice: null, status: "REJECTED", message: "5paisa: client code / user key / access token missing" };
  if (!req.brokerToken) return { ok: false, brokerOrderId: "", filledPrice: null, status: "REJECTED", message: "5paisa: ScripCode required in Broker Token" };
  const payload = {
    head: { key: b.apiKey },
    body: {
      Exchange: req.exchange === "BSE" ? "B" : req.exchange === "MCX" ? "M" : "N",
      ExchangeType: req.instrumentType === "EQ" ? "C" : "D",
      ScripCode: Number(req.brokerToken),
      Price: req.orderType === "LIMIT" ? req.price : 0,
      OrderType: req.side === "BUY" ? "Buy" : "Sell",
      Qty: req.quantity,
      IsIntraday: req.productType === "MIS",
      RemoteOrderID: `algodesk${Date.now()}`,
    },
  };
  try {
    const { status, body } = await safeFetch("https://Openapi.5paisa.com/VendorsAPI/Service1.svc/V1/PlaceOrderRequest", {
      method: "POST",
      headers: { Authorization: `Bearer ${b.accessToken}`, "Content-Type": "application/json" },
      body: JSON.stringify(payload),
    });
    const j = (body as { body?: { Status?: number; BrokerOrderID?: number; Message?: string } }).body ?? {};
    if (j.Status === 0 && j.BrokerOrderID) return { ok: true, brokerOrderId: String(j.BrokerOrderID), filledPrice: null, status: "PENDING", message: "5paisa: order placed" };
    return { ok: false, brokerOrderId: "", filledPrice: null, status: "REJECTED", message: `5paisa ${status}: ${j.Message ?? JSON.stringify(body).slice(0, 180)}` };
  } catch (e) {
    return { ok: false, brokerOrderId: "", filledPrice: null, status: "REJECTED", message: `5paisa network error: ${(e as Error).message}` };
  }
}

// ---------- ICICI Direct Breeze ----------
async function breezeHeaders(b: Broker, payload: string) {
  const { createHash } = await import("crypto");
  const timestamp = new Date().toISOString().split(".")[0] + ".000Z";
  const checksum = createHash("sha256").update(timestamp + payload + b.apiSecret).digest("hex");
  return { "Content-Type": "application/json", "X-Checksum": `token ${checksum}`, "X-Timestamp": timestamp, "X-AppKey": b.apiKey, "X-SessionToken": b.accessToken };
}
async function placeBreeze(b: Broker, req: OrderRequest): Promise<OrderResult> {
  if (!b.apiKey || !b.apiSecret || !b.accessToken) return { ok: false, brokerOrderId: "", filledPrice: null, status: "REJECTED", message: "ICICI Breeze: app key / secret / session token missing" };
  const payload = JSON.stringify({
    stock_code: req.brokerToken || req.symbol,
    exchange_code: req.instrumentType === "EQ" ? req.exchange : "NFO",
    product: req.productType === "CNC" ? "cash" : req.instrumentType === "FUT" ? "futures" : req.instrumentType === "CE" || req.instrumentType === "PE" ? "options" : "margin",
    action: req.side.toLowerCase(),
    order_type: req.orderType.toLowerCase(),
    quantity: String(req.quantity),
    price: req.orderType === "LIMIT" ? String(req.price) : "",
    validity: "day",
  });
  try {
    const { status, body } = await safeFetch("https://api.icicidirect.com/breezeapi/api/v1/order", { method: "POST", headers: await breezeHeaders(b, payload), body: payload });
    const j = body as { Status?: number; Success?: { order_id?: string }; Error?: string };
    if (j.Status === 200 && j.Success?.order_id) return { ok: true, brokerOrderId: j.Success.order_id, filledPrice: null, status: "PENDING", message: "ICICI Breeze: order placed" };
    return { ok: false, brokerOrderId: "", filledPrice: null, status: "REJECTED", message: `Breeze ${status}: ${j.Error ?? JSON.stringify(body).slice(0, 180)}` };
  } catch (e) {
    return { ok: false, brokerOrderId: "", filledPrice: null, status: "REJECTED", message: `Breeze network error: ${(e as Error).message}` };
  }
}

// ---------- Auto-Broker Resolution for Indian vs Crypto Markets ----------
export function isCryptoMarket(exchange?: string, symbol?: string, segment?: string): boolean {
  return exchange === "DELTA" || segment === "CRYPTO" || (symbol?.endsWith("USD") ?? false) || (/^[CP]-/.test(symbol ?? ""));
}

export async function resolveAutoBroker(opts: {
  exchange?: string;
  symbol?: string;
  segment?: string;
  preferredBrokerId?: number | null;
}): Promise<Broker | null> {
  const { db } = await import("@/db");
  const { brokers } = await import("@/db/schema");
  const { openBroker } = await import("./security/secrets");

  const isCrypto = isCryptoMarket(opts.exchange, opts.symbol, opts.segment);
  const allBrokers = await db.select().from(brokers);
  if (!allBrokers.length) return null;

  // 1. If preferred ID given, check if it matches market
  if (opts.preferredBrokerId) {
    const pref = allBrokers.find((b) => b.id === opts.preferredBrokerId);
    if (pref) {
      const prefIsCrypto = pref.provider === "deltaexchange";
      if (isCrypto === prefIsCrypto) return openBroker(pref);
    }
  }

  // 2. Select matching market broker
  if (isCrypto) {
    const delta = allBrokers.find((b) => b.provider === "deltaexchange" && b.isActive);
    if (delta) return openBroker(delta);
  } else {
    // Indian broker: first default that is Indian
    const defIndian = allBrokers.find((b) => b.isDefault && b.provider !== "deltaexchange" && b.isActive);
    if (defIndian) return openBroker(defIndian);
    // Any active Indian broker
    const anyIndian = allBrokers.find((b) => b.provider !== "deltaexchange" && b.isActive);
    if (anyIndian) return openBroker(anyIndian);
  }

  // Fallback to default or first
  const fallback = allBrokers.find((b) => b.isDefault && b.isActive) ?? allBrokers[0];
  return fallback ? openBroker(fallback) : null;
}

// ---------- public API ----------
export async function placeOrder(broker: Broker | null, req: OrderRequest): Promise<OrderResult> {
  if (!broker || broker.mode === "paper") return paperFill(req, broker?.provider ?? "paper");
  switch (broker.provider as Provider) {
    case "dhan":
      return placeDhan(broker, req);
    case "angelone":
      return placeAngel(broker, req);
    case "kotakneo":
      return placeKotak(broker, req);
    case "deltaexchange":
      return placeDelta(broker, req);
    case "zerodha":
      return placeZerodha(broker, req);
    case "upstox":
      return placeUpstox(broker, req);
    case "fyers":
      return placeFyers(broker, req);
    case "shoonya":
      return placeNoren("shoonya", broker, req);
    case "flattrade":
      return placeNoren("flattrade", broker, req);
    case "aliceblue":
      return placeAliceBlue(broker, req);
    case "fivepaisa":
      return placeFivePaisa(broker, req);
    case "icicibreeze":
      return placeBreeze(broker, req);
    default:
      return paperFill(req, broker.provider);
  }
}

/** Connection test — hits a lightweight authenticated endpoint per broker */
export async function testConnection(b: Broker): Promise<{ ok: boolean; message: string; data?: unknown }> {
  if (b.mode === "paper") return { ok: true, message: "Paper mode – no live connection needed. Simulator ready." };
  try {
    if (b.provider === "dhan") {
      if (!b.accessToken) return { ok: false, message: "Access token missing" };
      const { status, body } = await safeFetch("https://api.dhan.co/v2/fundlimit", { headers: { "access-token": b.accessToken, "Content-Type": "application/json" } });
      if (status === 200) return { ok: true, message: "Dhan connected ✓", data: body };
      return { ok: false, message: `Dhan ${status}: ${JSON.stringify(body).slice(0, 200)}` };
    }
    if (b.provider === "angelone") {
      if (!b.accessToken || !b.apiKey) return { ok: false, message: "JWT / API key missing – click Login first" };
      const { status, body } = await safeFetch("https://apiconnect.angelone.in/rest/secure/angelbroking/user/v1/getProfile", { headers: angelHeaders(b) });
      const j = body as { status?: boolean; message?: string; data?: { name?: string } };
      if (status === 200 && j.status) return { ok: true, message: `Angel One connected ✓ (${j.data?.name ?? b.clientId})`, data: j.data };
      return { ok: false, message: `Angel One ${status}: ${j.message ?? JSON.stringify(body).slice(0, 200)}` };
    }
    if (b.provider === "deltaexchange") {
      if (!b.apiKey || !b.apiSecret) return { ok: false, message: "API key & secret missing" };
      const { status, json } = await deltaRequest({ apiKey: b.apiKey, apiSecret: b.apiSecret, method: "GET", path: "/v2/wallet/balances" });
      if (status === 200 && json.success) {
        const rows = (json.result ?? []) as { asset_symbol?: string; balance?: string }[];
        const bal = rows.filter((r) => Number(r.balance) > 0).map((r) => `${r.asset_symbol} ${Number(r.balance).toFixed(2)}`).slice(0, 4).join(", ");
        return { ok: true, message: `Delta Exchange connected ✓${bal ? ` (${bal})` : ""}` };
      }
      return { ok: false, message: `Delta ${status}: ${JSON.stringify(json.error ?? json).slice(0, 160)} — check key/secret & server IP whitelist` };
    }
    if (b.provider === "zerodha") {
      if (!b.apiKey || !b.accessToken) return { ok: false, message: "API key / access token missing" };
      const { status, body } = await safeFetch("https://api.kite.trade/user/profile", { headers: { "X-Kite-Version": "3", Authorization: `token ${b.apiKey}:${b.accessToken}` } });
      const j = body as { status?: string; data?: { user_name?: string }; message?: string };
      if (status === 200 && j.status === "success") return { ok: true, message: `Zerodha connected ✓ (${j.data?.user_name ?? b.clientId})` };
      return { ok: false, message: `Zerodha ${status}: ${j.message ?? "token expired? Generate today's access token"}` };
    }
    if (b.provider === "upstox") {
      if (!b.accessToken) return { ok: false, message: "Access token missing" };
      const { status, body } = await safeFetch("https://api.upstox.com/v2/user/profile", { headers: { Authorization: `Bearer ${b.accessToken}`, Accept: "application/json" } });
      const j = body as { status?: string; data?: { user_name?: string } };
      if (status === 200 && j.status === "success") return { ok: true, message: `Upstox connected ✓ (${j.data?.user_name ?? ""})` };
      return { ok: false, message: `Upstox ${status}: ${JSON.stringify(body).slice(0, 160)}` };
    }
    if (b.provider === "fyers") {
      if (!b.clientId || !b.accessToken) return { ok: false, message: "App ID / access token missing" };
      const { status, body } = await safeFetch("https://api-t1.fyers.in/api/v3/profile", { headers: { Authorization: `${b.clientId}:${b.accessToken}` } });
      const j = body as { s?: string; data?: { name?: string }; message?: string };
      if (status === 200 && j.s === "ok") return { ok: true, message: `Fyers connected ✓ (${j.data?.name ?? ""})` };
      return { ok: false, message: `Fyers ${status}: ${j.message ?? JSON.stringify(body).slice(0, 160)}` };
    }
    if (b.provider === "shoonya" || b.provider === "flattrade") {
      if (!b.clientId || !b.accessToken) return { ok: false, message: `UID / session token missing${b.provider === "shoonya" ? " — click 🔐 Login first" : " — paste today's API token"}` };
      const { status, body } = await safeFetch(`${NOREN_BASE[b.provider]}/UserDetails`, { method: "POST", headers: { "Content-Type": "text/plain" }, body: `jData=${JSON.stringify({ uid: b.clientId })}&jKey=${b.accessToken}` });
      const j = body as { stat?: string; uname?: string; emsg?: string };
      if (j.stat === "Ok") return { ok: true, message: `${b.provider === "shoonya" ? "Shoonya" : "Flattrade"} connected ✓ (${j.uname ?? b.clientId})` };
      return { ok: false, message: `${b.provider} ${status}: ${j.emsg ?? JSON.stringify(body).slice(0, 160)}` };
    }
    if (b.provider === "aliceblue") {
      if (!b.clientId || !b.accessToken) return { ok: false, message: "User ID / session ID missing" };
      const { status, body } = await safeFetch("https://ant.aliceblueonline.com/rest/AliceBlueAPIService/api/customer/accountDetails", { method: "GET", headers: { Authorization: `Bearer ${b.clientId} ${b.accessToken}` } });
      const j = body as { accountName?: string; emsg?: string; stat?: string };
      if (status === 200 && (j.accountName || j.stat === "Ok")) return { ok: true, message: `Alice Blue connected ✓ (${j.accountName ?? b.clientId})` };
      return { ok: false, message: `Alice Blue ${status}: ${j.emsg ?? JSON.stringify(body).slice(0, 160)}` };
    }
    if (b.provider === "fivepaisa") {
      if (!b.clientId || !b.apiKey || !b.accessToken) return { ok: false, message: "Client code / user key / access token missing" };
      const { status, body } = await safeFetch("https://Openapi.5paisa.com/VendorsAPI/Service1.svc/V4/Margin", {
        method: "POST",
        headers: { Authorization: `Bearer ${b.accessToken}`, "Content-Type": "application/json" },
        body: JSON.stringify({ head: { key: b.apiKey }, body: { ClientCode: b.clientId } }),
      });
      const j = (body as { body?: { Status?: number; Message?: string } }).body ?? {};
      if (status === 200 && j.Status === 0) return { ok: true, message: "5paisa connected ✓" };
      return { ok: false, message: `5paisa ${status}: ${j.Message ?? JSON.stringify(body).slice(0, 160)}` };
    }
    if (b.provider === "icicibreeze") {
      if (!b.apiKey || !b.apiSecret || !b.accessToken) return { ok: false, message: "App key / secret / session token missing" };
      const payload = JSON.stringify({});
      const { status, body } = await safeFetch("https://api.icicidirect.com/breezeapi/api/v1/customerdetails", { method: "GET", headers: await breezeHeaders(b, payload) });
      const j = body as { Status?: number; Error?: string };
      if (status === 200 && j.Status === 200) return { ok: true, message: "ICICI Breeze connected ✓" };
      return { ok: false, message: `Breeze ${status}: ${j.Error ?? JSON.stringify(body).slice(0, 160)}` };
    }
    if (b.provider === "kotakneo") {
      if (!b.accessToken || !b.clientId) return { ok: false, message: "Session token / sid missing – click Login first" };
      const { status, body } = await safeFetch(`https://gw-napi.kotaksecurities.com/Orders/2.0/quick/user/limits?sId=${encodeURIComponent(b.clientId)}`, {
        method: "POST",
        headers: { "Content-Type": "application/x-www-form-urlencoded", Sid: b.clientId, Auth: b.accessToken, "neo-fin-key": "neotradeapi", Authorization: `Bearer ${b.extra?.oauthToken ?? ""}` },
        body: `jData=${encodeURIComponent(JSON.stringify({ seg: "ALL", exch: "ALL", prod: "ALL" }))}`,
      });
      if (status === 200) return { ok: true, message: "Kotak Neo connected ✓", data: body };
      return { ok: false, message: `Kotak Neo ${status}: ${JSON.stringify(body).slice(0, 200)}` };
    }
  } catch (e) {
    return { ok: false, message: `Network error: ${(e as Error).message}` };
  }
  return { ok: false, message: "Unknown provider" };
}

// ---------- TOTP (RFC 6238) for Angel One login ----------
async function totp(secretB32: string): Promise<string> {
  const alphabet = "ABCDEFGHIJKLMNOPQRSTUVWXYZ234567";
  const clean = secretB32.replace(/=+$/, "").toUpperCase().replace(/[^A-Z2-7]/g, "");
  let bits = "";
  for (const c of clean) bits += alphabet.indexOf(c).toString(2).padStart(5, "0");
  const bytes = new Uint8Array(Math.floor(bits.length / 8));
  for (let i = 0; i < bytes.length; i++) bytes[i] = parseInt(bits.slice(i * 8, i * 8 + 8), 2);
  const counter = Math.floor(Date.now() / 30000);
  const msg = new Uint8Array(8);
  let c = counter;
  for (let i = 7; i >= 0; i--) {
    msg[i] = c & 0xff;
    c = Math.floor(c / 256);
  }
  const key = await crypto.subtle.importKey("raw", bytes, { name: "HMAC", hash: "SHA-1" }, false, ["sign"]);
  const sig = new Uint8Array(await crypto.subtle.sign("HMAC", key, msg));
  const off = sig[19] & 0xf;
  const code = ((sig[off] & 0x7f) << 24) | (sig[off + 1] << 16) | (sig[off + 2] << 8) | sig[off + 3];
  return (code % 1_000_000).toString().padStart(6, "0");
}

/** Login flow — returns tokens to be saved on the broker record */
export async function brokerLogin(b: Broker): Promise<{ ok: boolean; message: string; update?: Partial<Broker> }> {
  try {
    if (b.provider === "angelone") {
      if (!b.clientId || !b.mpin || !b.totpSecret || !b.apiKey) return { ok: false, message: "Client code, MPIN, TOTP secret and API key are required" };
      const code = await totp(b.totpSecret);
      const { status, body } = await safeFetch("https://apiconnect.angelone.in/rest/auth/angelbroking/user/v1/loginByPassword", {
        method: "POST",
        headers: { ...angelHeaders(b), Authorization: "" },
        body: JSON.stringify({ clientcode: b.clientId, password: b.mpin, totp: code }),
      });
      const j = body as { status?: boolean; message?: string; data?: { jwtToken?: string; refreshToken?: string; feedToken?: string } };
      if (status === 200 && j.status && j.data?.jwtToken) {
        return { ok: true, message: "Angel One login successful ✓ JWT saved", update: { accessToken: j.data.jwtToken, extra: { ...(b.extra ?? {}), feedToken: j.data.feedToken ?? "", refreshToken: j.data.refreshToken ?? "" } } };
      }
      return { ok: false, message: `Angel One login failed: ${j.message ?? JSON.stringify(body).slice(0, 200)}` };
    }
    if (b.provider === "kotakneo") {
      if (!b.apiKey || !b.apiSecret || !b.mobile || !b.password || !b.mpin) return { ok: false, message: "Consumer key/secret, mobile, password and MPIN are required" };
      const basic = Buffer.from(`${b.apiKey}:${b.apiSecret}`).toString("base64");
      const tok = await safeFetch("https://napi.kotaksecurities.com/oauth2/token", {
        method: "POST",
        headers: { Authorization: `Basic ${basic}`, "Content-Type": "application/x-www-form-urlencoded" },
        body: "grant_type=client_credentials",
      });
      const tj = tok.body as { access_token?: string; error_description?: string };
      if (!tj.access_token) return { ok: false, message: `Kotak token failed: ${tj.error_description ?? JSON.stringify(tok.body).slice(0, 200)}` };
      const login = await safeFetch("https://gw-napi.kotaksecurities.com/login/1.0/login/v2/validate", {
        method: "POST",
        headers: { Authorization: `Bearer ${tj.access_token}`, "Content-Type": "application/json", "neo-fin-key": "neotradeapi" },
        body: JSON.stringify({ mobileNumber: b.mobile, password: b.password }),
      });
      const lj = login.body as { data?: { token?: string; sid?: string }; message?: string };
      if (!lj.data?.token) return { ok: false, message: `Kotak login failed: ${lj.message ?? JSON.stringify(login.body).slice(0, 200)}` };
      const sess = await safeFetch("https://gw-napi.kotaksecurities.com/login/1.0/login/v2/validate", {
        method: "POST",
        headers: { Authorization: `Bearer ${tj.access_token}`, "Content-Type": "application/json", "neo-fin-key": "neotradeapi", sid: lj.data.sid ?? "", Auth: lj.data.token },
        body: JSON.stringify({ mpin: b.mpin }),
      });
      const sj = sess.body as { data?: { token?: string; sid?: string; baseUrl?: string }; message?: string };
      if (sj.data?.token) {
        return { ok: true, message: "Kotak Neo login successful ✓ session saved", update: { accessToken: sj.data.token, clientId: sj.data.sid ?? lj.data.sid ?? "", extra: { ...(b.extra ?? {}), oauthToken: tj.access_token, baseUrl: sj.data.baseUrl ?? "" } } };
      }
      return { ok: false, message: `Kotak MPIN validation failed: ${sj.message ?? JSON.stringify(sess.body).slice(0, 200)}` };
    }
    if (b.provider === "shoonya") {
      if (!b.clientId || !b.password || !b.apiKey || !b.totpSecret) return { ok: false, message: "UID, password, API key and TOTP secret required" };
      const { createHash } = await import("crypto");
      const sha = (x: string) => createHash("sha256").update(x).digest("hex");
      const jData = {
        apkversion: "1.0.0",
        uid: b.clientId,
        pwd: sha(b.password),
        factor2: await totp(b.totpSecret),
        vc: `${b.clientId}_U`,
        appkey: sha(`${b.clientId}|${b.apiKey}`),
        imei: "algodesk",
        source: "API",
      };
      const { body } = await safeFetch(`${NOREN_BASE.shoonya}/QuickAuth`, { method: "POST", headers: { "Content-Type": "text/plain" }, body: `jData=${JSON.stringify(jData)}` });
      const j = body as { stat?: string; susertoken?: string; emsg?: string };
      if (j.stat === "Ok" && j.susertoken) return { ok: true, message: "Shoonya login successful ✓ session saved", update: { accessToken: j.susertoken } };
      return { ok: false, message: `Shoonya login failed: ${j.emsg ?? JSON.stringify(body).slice(0, 160)}` };
    }
    if (b.provider === "zerodha") return { ok: !!b.accessToken, message: b.accessToken ? "Zerodha uses a daily access token — already set ✓ (regenerate every morning)" : "Paste today's access token from the Kite Connect login flow" };
    if (b.provider === "upstox") return { ok: !!b.accessToken, message: b.accessToken ? "Upstox token set ✓ (valid 1 day)" : "Generate today's access token on upstox developer portal" };
    if (b.provider === "fyers") return { ok: !!b.accessToken, message: b.accessToken ? "Fyers token set ✓ (valid till 7 AM next day)" : "Generate today's access token (auth-code flow)" };
    if (b.provider === "flattrade") return { ok: !!b.accessToken, message: b.accessToken ? "Flattrade token set ✓" : "Generate today's API token on wall.flattrade.in" };
    if (b.provider === "aliceblue") return { ok: !!b.accessToken, message: b.accessToken ? "Alice Blue session set ✓" : "Paste session ID from getUserSID flow" };
    if (b.provider === "fivepaisa") return { ok: !!b.accessToken, message: b.accessToken ? "5paisa token set ✓" : "Generate access token via TOTP login flow" };
    if (b.provider === "icicibreeze") return { ok: !!b.accessToken, message: b.accessToken ? "Breeze session set ✓ (valid 1 day)" : "Login on api.icicidirect.com and paste the API session value" };
    if (b.provider === "dhan") {
      return { ok: !!b.accessToken, message: b.accessToken ? "Dhan uses a static access token – already configured ✓" : "Paste your Dhan access token (valid 24h / 30 days)" };
    }
    if (b.provider === "deltaexchange") {
      return { ok: !!(b.apiKey && b.apiSecret), message: b.apiKey && b.apiSecret ? "Delta Exchange uses static API keys – no login needed ✓ (use Test)" : "Enter API key & secret from india.delta.exchange" };
    }
  } catch (e) {
    return { ok: false, message: `Login error: ${(e as Error).message}` };
  }
  return { ok: false, message: "Unknown provider" };
}
