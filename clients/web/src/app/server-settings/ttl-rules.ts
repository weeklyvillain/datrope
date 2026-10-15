const MB = 1024 * 1024;
export type TTLRule = { min_bytes: number; ttl_hours: number };
export type Row = { mb: number; days: number };

export const rowsFromRules = (rules: TTLRule[]): Row[] =>
  rules.map((r) => ({ mb: Math.round(r.min_bytes / MB), days: Math.max(1, Math.round(r.ttl_hours / 24)) }));

export const rulesFromRows = (rows: Row[]): TTLRule[] => rows.map((r) => ({ min_bytes: r.mb * MB, ttl_hours: r.days * 24 }));

/** Why these rows can't be saved, or null. */
export function rowsError(rows: Row[]): string | null {
  if (rows.length > 5) return "At most 5 rules.";
  if (rows.some((r) => !(r.mb >= 1))) return "Sizes start at 1 MB.";
  if (rows.some((r) => !(r.days >= 1))) return "Keep files at least 1 day.";
  if (rows.some((r) => r.days > 365)) return "Keep files at most 365 days.";
  if (rows.some((r) => !Number.isInteger(r.mb) || !Number.isInteger(r.days))) return "Use whole numbers.";
  if (new Set(rows.map((r) => r.mb)).size !== rows.length) return "Each size can have only one rule.";
  return null;
}
