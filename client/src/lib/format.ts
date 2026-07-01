export function formatViews(n: number): string {
  if (n >= 1_000_000) return (n / 1_000_000).toFixed(1).replace(/\.0$/, "") + "M";
  if (n >= 1_000) return (n / 1_000).toFixed(1).replace(/\.0$/, "") + "K";
  return String(n);
}

export const CITY_LABEL: Record<string, string> = {
  austin: "Austin",
  san_antonio: "San Antonio",
  dallas: "Dallas–Fort Worth",
};

export function formatScheduledCdt(ms?: number | null): string {
  if (!ms) return "—";
  // Render in America/Chicago for the owner.
  return new Date(ms).toLocaleString("en-US", {
    timeZone: "America/Chicago",
    hour: "numeric",
    minute: "2-digit",
    hour12: true,
  }) + " CDT";
}

export function formatDateNice(d?: string | number | Date | null): string {
  if (!d) return "—";
  const date = typeof d === "string" || typeof d === "number" ? new Date(d) : d;
  if (isNaN(date.getTime())) return "—";
  return date.toLocaleDateString("en-US", { month: "short", day: "numeric", year: "numeric" });
}
