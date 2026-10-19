/**
 * SMS OTP sender with pluggable providers (set one in .env):
 *   SMS_PROVIDER=fast2sms   + FAST2SMS_API_KEY=...            (India, DLT-free OTP route)
 *   SMS_PROVIDER=msg91      + MSG91_AUTH_KEY=... [+ MSG91_TEMPLATE_ID / MSG91_SENDER_ID]
 *   SMS_PROVIDER=twilio     + TWILIO_SID / TWILIO_TOKEN / TWILIO_FROM
 *   SMS_PROVIDER=console    (default) → OTP is printed in the SERVER console only
 */
export function smsProvider(): string {
  const p = (process.env.SMS_PROVIDER || "").toLowerCase();
  if (p === "fast2sms" && process.env.FAST2SMS_API_KEY) return "fast2sms";
  if (p === "msg91" && process.env.MSG91_AUTH_KEY) return "msg91";
  if (p === "twilio" && process.env.TWILIO_SID && process.env.TWILIO_TOKEN && process.env.TWILIO_FROM) return "twilio";
  return "console";
}

/** +91XXXXXXXXXX → 10-digit local part (Indian numbers) */
export function normalizeMobile(raw: string): string | null {
  const digits = String(raw || "").replace(/[^\d]/g, "");
  const ten = digits.length === 12 && digits.startsWith("91") ? digits.slice(2) : digits.length === 11 && digits.startsWith("0") ? digits.slice(1) : digits;
  return /^[6-9]\d{9}$/.test(ten) ? ten : null;
}

export const maskMobile = (m: string) => (m.length >= 4 ? `••••••${m.slice(-4)}` : "••••");

async function post(url: string, init: RequestInit, timeoutMs = 10000): Promise<{ status: number; text: string }> {
  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), timeoutMs);
  try {
    const res = await fetch(url, { ...init, signal: ctrl.signal });
    return { status: res.status, text: await res.text() };
  } finally {
    clearTimeout(t);
  }
}

export async function sendOtpSms(mobile10: string, otp: string): Promise<{ ok: boolean; provider: string; message: string }> {
  const provider = smsProvider();
  const msg = `${otp} is your AlgoDesk password reset OTP. Valid 10 minutes. Do not share.`;
  try {
    if (provider === "fast2sms") {
      const { status, text } = await post("https://www.fast2sms.com/dev/bulkV2", {
        method: "POST",
        headers: { authorization: process.env.FAST2SMS_API_KEY!, "Content-Type": "application/json" },
        body: JSON.stringify({ route: "otp", variables_values: otp, numbers: mobile10 }),
      });
      const ok = status === 200 && /"return"\s*:\s*true/.test(text);
      return { ok, provider, message: ok ? "OTP sent via Fast2SMS" : `Fast2SMS ${status}: ${text.slice(0, 140)}` };
    }
    if (provider === "msg91") {
      const params = new URLSearchParams({ mobile: `91${mobile10}`, authkey: process.env.MSG91_AUTH_KEY!, otp, otp_length: "6" });
      if (process.env.MSG91_TEMPLATE_ID) params.set("template_id", process.env.MSG91_TEMPLATE_ID);
      const { status, text } = await post(`https://control.msg91.com/api/v5/otp?${params.toString()}`, { method: "POST", headers: { "Content-Type": "application/json" } });
      const ok = status === 200 && /success/i.test(text);
      return { ok, provider, message: ok ? "OTP sent via MSG91" : `MSG91 ${status}: ${text.slice(0, 140)}` };
    }
    if (provider === "twilio") {
      const sid = process.env.TWILIO_SID!;
      const body = new URLSearchParams({ To: `+91${mobile10}`, From: process.env.TWILIO_FROM!, Body: msg });
      const { status, text } = await post(`https://api.twilio.com/2010-04-01/Accounts/${sid}/Messages.json`, {
        method: "POST",
        headers: { Authorization: `Basic ${Buffer.from(`${sid}:${process.env.TWILIO_TOKEN}`).toString("base64")}`, "Content-Type": "application/x-www-form-urlencoded" },
        body: body.toString(),
      });
      const ok = status >= 200 && status < 300;
      return { ok, provider, message: ok ? "OTP sent via Twilio" : `Twilio ${status}: ${text.slice(0, 140)}` };
    }
  } catch (e) {
    return { ok: false, provider, message: `SMS send failed: ${(e as Error).message}` };
  }
  // console fallback — OTP only visible to whoever controls the server
  const line = "=".repeat(58);
  console.log(`\n${line}\n  AlgoDesk PASSWORD RESET OTP for ${maskMobile(mobile10)}:   ${otp}\n  (valid 10 min · configure SMS_PROVIDER in .env for real SMS)\n${line}\n`);
  return { ok: true, provider, message: "OTP printed in the server console (no SMS provider configured)" };
}
