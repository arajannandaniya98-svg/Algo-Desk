/** Classifies expiry dates: This Week / Next Week / later + Monthly tag (last expiry of its month). */
export interface ExpiryInfo {
  date: string; // yyyy-mm-dd
  label: string; // "This Week" | "Next Week" | "Oct W3" | "—"
  monthly: boolean;
  dow: string; // Tue / Thu …
  daysLeft: number;
}

const DOW = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];

export function labelExpiries(expiries: string[]): ExpiryInfo[] {
  const today = new Date();
  today.setHours(0, 0, 0, 0);
  // week = Monday..Sunday containing today
  const monday = new Date(today);
  monday.setDate(today.getDate() - ((today.getDay() + 6) % 7));
  const weekEnd = new Date(monday);
  weekEnd.setDate(monday.getDate() + 6);
  const nextWeekEnd = new Date(monday);
  nextWeekEnd.setDate(monday.getDate() + 13);

  // last expiry per month ⇒ monthly contract
  const lastOfMonth = new Map<string, string>();
  for (const e of expiries) {
    const m = e.slice(0, 7);
    if (!lastOfMonth.has(m) || e > (lastOfMonth.get(m) ?? "")) lastOfMonth.set(m, e);
  }

  return expiries.map((e) => {
    const d = new Date(`${e}T00:00:00`);
    const daysLeft = Math.round((d.getTime() - today.getTime()) / 86400000);
    const monthly = lastOfMonth.get(e.slice(0, 7)) === e;
    let label: string;
    if (d <= weekEnd) label = daysLeft <= 0 ? "Today" : "This Week";
    else if (d <= nextWeekEnd) label = "Next Week";
    else label = d.toLocaleDateString("en-IN", { month: "short" });
    return { date: e, label, monthly, dow: DOW[d.getDay()], daysLeft };
  });
}
