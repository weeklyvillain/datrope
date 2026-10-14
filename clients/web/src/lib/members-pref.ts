const KEY = "datrope.members";
const store = (): Storage | undefined => {
  try { return typeof window === "undefined" ? undefined : window.localStorage; } catch { return undefined; }
};

/** Whether the docked member list is shown (wide windows). Default: shown. */
export function readMembersPref(s: Pick<Storage, "getItem"> | undefined = store()): boolean {
  try { return s?.getItem(KEY) !== "0"; } catch { return true; }
}
export function writeMembersPref(open: boolean, s: Pick<Storage, "setItem"> | undefined = store()): void {
  try { s?.setItem(KEY, open ? "1" : "0"); } catch { /* private mode: not remembered */ }
}
