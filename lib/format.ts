export function formatBytes(bytes: number): string {
  if (!bytes) return "0 B";
  const units = ["B", "KB", "MB", "GB"];
  const i = Math.min(
    units.length - 1,
    Math.floor(Math.log(bytes) / Math.log(1024))
  );
  const value = bytes / Math.pow(1024, i);
  return `${value.toFixed(i === 0 ? 0 : 1)} ${units[i]}`;
}

export function formatDate(iso: string): string {
  return new Date(iso).toLocaleDateString("en-US", {
    month: "short",
    day: "numeric",
    year: "numeric",
  });
}

export function formatCurrency(value: number, currency = "USD"): string {
  return new Intl.NumberFormat("en-US", {
    style: "currency",
    currency,
    maximumFractionDigits: value % 1 === 0 ? 0 : 2,
  }).format(value || 0);
}

// Compact "3d ago" / "in 2h" style relative time from an ISO string.
export function relativeTime(iso: string | null | undefined): string {
  if (!iso) return "—";
  const then = new Date(iso).getTime();
  const diff = then - Date.now();
  const abs = Math.abs(diff);
  const mins = Math.round(abs / 60000);
  const hrs = Math.round(abs / 3.6e6);
  const days = Math.round(abs / 8.64e7);
  const suffix = (n: number, u: string) => (diff < 0 ? `${n}${u} ago` : `in ${n}${u}`);
  if (mins < 1) return "just now";
  if (mins < 60) return suffix(mins, "m");
  if (hrs < 24) return suffix(hrs, "h");
  if (days < 30) return suffix(days, "d");
  return formatDate(iso);
}
