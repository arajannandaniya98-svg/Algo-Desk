import nodemailer, { type Transporter } from "nodemailer";

/**
 * Email OTP sender — SMTP (Gmail app-password friendly). Set in .env:
 *   SMTP_HOST=smtp.gmail.com  SMTP_PORT=465  SMTP_USER=you@gmail.com  SMTP_PASS=<16-char app password>
 *   [SMTP_FROM="AlgoDesk <you@gmail.com>"]
 * Without SMTP config the OTP is printed in the SERVER console (single-owner safe).
 */
export function emailProvider(): "smtp" | "console" {
  return process.env.SMTP_HOST && process.env.SMTP_USER && process.env.SMTP_PASS ? "smtp" : "console";
}

export function maskEmail(e: string): string {
  const [u, d] = String(e).split("@");
  if (!d) return "•••";
  const head = u.length <= 2 ? u[0] ?? "•" : u.slice(0, 2);
  return `${head}•••@${d}`;
}

export const isValidEmail = (e: string) => /^[^\s@]{1,64}@[^\s@]{1,255}\.[a-zA-Z]{2,}$/.test(e);

let transporter: Transporter | null = null;
function smtp(): Transporter {
  if (transporter) return transporter;
  const port = Number(process.env.SMTP_PORT) || 465;
  transporter = nodemailer.createTransport({
    host: process.env.SMTP_HOST,
    port,
    secure: port === 465,
    auth: { user: process.env.SMTP_USER, pass: process.env.SMTP_PASS },
    connectionTimeout: 10_000,
  });
  return transporter;
}

export async function sendOtpEmail(to: string, otp: string, purpose = "login confirmation"): Promise<{ ok: boolean; provider: string; message: string }> {
  const provider = emailProvider();
  if (provider === "smtp") {
    try {
      await smtp().sendMail({
        from: process.env.SMTP_FROM || `AlgoDesk <${process.env.SMTP_USER}>`,
        to,
        subject: `${otp} — AlgoDesk ${purpose} OTP`,
        text: `${otp} is your AlgoDesk ${purpose} OTP. Valid for 10 minutes. Never share it with anyone.`,
        html: `<div style="font-family:monospace"><h2 style="letter-spacing:6px">${otp}</h2><p>AlgoDesk ${purpose} OTP · valid 10 minutes.<br/>Never share this code with anyone.</p></div>`,
      });
      return { ok: true, provider, message: `OTP emailed to ${maskEmail(to)}` };
    } catch (e) {
      return { ok: false, provider, message: `Email send failed: ${(e as Error).message}` };
    }
  }
  const line = "=".repeat(58);
  console.log(`\n${line}\n  AlgoDesk EMAIL OTP for ${maskEmail(to)} (${purpose}):   ${otp}\n  (valid 10 min · set SMTP_HOST/USER/PASS in .env for real email)\n${line}\n`);
  return { ok: true, provider, message: "OTP printed in the server console (no SMTP configured)" };
}
