import { pool } from "@/db";
import { clientIp } from "./session";

export interface AuditEntry {
  userId?: number | null;
  username?: string;
  action: string;
  target?: string;
  detail?: string;
  ip?: string;
  userAgent?: string;
  success?: boolean;
}

/** Fire-and-forget audit trail insert (never blocks or breaks the request). */
export function audit(e: AuditEntry): void {
  pool
    .query("insert into audit_logs (user_id, username, action, target, detail, ip, user_agent, success) values ($1, $2, $3, $4, $5, $6, $7, $8)", [
      e.userId ?? null,
      (e.username ?? "").slice(0, 64),
      e.action.slice(0, 120),
      (e.target ?? "").slice(0, 300),
      (e.detail ?? "").slice(0, 1000),
      (e.ip ?? "").slice(0, 64),
      (e.userAgent ?? "").slice(0, 300),
      e.success ?? true,
    ])
    .catch(() => {});
}

/** Identity injected by src/proxy.ts after session validation (client copies are stripped). */
export function actor(h: Headers) {
  return {
    userId: Number(h.get("x-user-id")) || null,
    username: h.get("x-user-name") ?? "",
    role: h.get("x-user-role") ?? "",
    sessionId: Number(h.get("x-session-id")) || null,
    ip: h.get("x-client-ip") || clientIp(h),
    userAgent: (h.get("user-agent") ?? "").slice(0, 300),
  };
}
