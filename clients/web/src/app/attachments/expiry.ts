type FileState = { expires_at?: string | null; keep?: boolean; expired?: boolean };
const HOUR = 3_600_000;

export function expiresLabel(iso: string, now: number): string {
  const left = Date.parse(iso) - now;
  if (left < HOUR) return "Expires within the hour";
  const hours = Math.floor(left / HOUR);
  if (hours < 48) return `Expires in ${hours} hour${hours === 1 ? "" : "s"}`;
  return `Expires in ${Math.round(hours / 24)} days`;
}

/** What can be done to a message's files: keep the expiring ones, let kept ones expire, remove the live ones. */
export function fileFlags(atts: FileState[]) {
  const live = atts.filter((a) => !a.expired);
  return {
    expiring: live.some((a) => !!a.expires_at && !a.keep),
    kept: live.some((a) => !!a.keep),
    removable: live.length > 0,
  };
}
