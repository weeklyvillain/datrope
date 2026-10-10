/** 0 (under 8 characters) to 4, from length and character variety. */
export function passwordStrength(pw: string) {
  if (pw.length < 8) return 0;
  const kinds = [/[a-z]/, /[A-Z]/, /\d/, /[^A-Za-z0-9]/].filter((r) => r.test(pw)).length;
  return Math.min(4, 1 + Number(pw.length >= 12) + Number(kinds >= 2) + Number(kinds >= 3 || pw.length >= 16));
}

export const STRENGTH_LABELS = ["Too short", "Weak", "Okay", "Good", "Strong"];
