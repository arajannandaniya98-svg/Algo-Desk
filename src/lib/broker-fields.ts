const FIELDS = ["label", "provider", "clientId", "apiKey", "apiSecret", "accessToken", "totpSecret", "mobile", "password", "mpin", "mode"] as const;

export function pickBroker(body: Record<string, unknown>) {
  const out: Record<string, unknown> = {};
  // masked values (••••) mean "unchanged" — secrets are never sent back to the browser
  for (const f of FIELDS) if (typeof body[f] === "string" && !(body[f] as string).includes("•")) out[f] = body[f];
  if (typeof body.isActive === "boolean") out.isActive = body.isActive;
  if (typeof body.isDefault === "boolean") out.isDefault = body.isDefault;
  return out;
}
