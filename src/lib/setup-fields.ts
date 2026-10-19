const STR = ["name", "symbol", "underlying", "exchange", "segment", "instrumentType", "expiry", "side", "productType", "orderType", "entryTrigger", "brokerToken", "notes", "status"] as const;
const NUM = ["strike", "entryPrice", "stopLoss", "target", "trailingSl"] as const;

export function pickSetup(body: Record<string, unknown>) {
  const out: Record<string, unknown> = {};
  for (const f of STR) if (typeof body[f] === "string") out[f] = body[f];
  for (const f of NUM) {
    if (body[f] === "" || body[f] === null) out[f] = null;
    else if (body[f] !== undefined && !Number.isNaN(Number(body[f]))) out[f] = Number(body[f]);
  }
  if (body.quantity !== undefined) out.quantity = Math.max(1, Math.floor(Number(body.quantity) || 1));
  if (body.brokerId === null || body.brokerId === "" || body.brokerId === 0) out.brokerId = null;
  else if (body.brokerId !== undefined) out.brokerId = Number(body.brokerId);
  if (typeof out.symbol === "string") out.symbol = out.symbol.toUpperCase();
  if (typeof out.underlying === "string") out.underlying = out.underlying.toUpperCase();
  return out;
}
