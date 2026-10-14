import { useStore } from "zustand";
import { createStore } from "zustand/vanilla";
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Kbd, KbdGroup } from "@/components/ui/kbd";
import { OTHER_KEYS, SHORTCUTS, keyLabel } from "@/lib/shortcuts";

export const shortcutSheetStore = createStore<{ open: boolean }>(() => ({ open: false }));
export const openShortcutSheet = () => shortcutSheetStore.setState({ open: true });

const GROUPS = ["Navigation", "Messages", "Voice", "Help"] as const;

/** Ctrl/Cmd+/: every keyboard shortcut in one place. */
export function ShortcutSheet() {
  const open = useStore(shortcutSheetStore, (s) => s.open);
  const rows = [...SHORTCUTS, ...OTHER_KEYS];
  return (
    <Dialog open={open} onOpenChange={(o) => shortcutSheetStore.setState({ open: o })}>
      <DialogContent className="max-h-[85dvh] overflow-y-auto sm:max-w-[560px]">
        <DialogHeader>
          <DialogTitle>Keyboard shortcuts</DialogTitle>
          <DialogDescription>Work without the mouse.</DialogDescription>
        </DialogHeader>
        <div className="grid gap-5">
          {GROUPS.map((g) => (
            <section key={g} aria-label={g}>
              <h3 className="mb-2 text-xs font-semibold tracking-wide text-muted-foreground uppercase">{g}</h3>
              <dl className="grid gap-1.5">
                {rows.filter((r) => r.group === g).map((r) => (
                  <div key={r.label} className="flex items-center justify-between gap-4">
                    <dt className="text-sm">{r.label}</dt>
                    <dd><KbdGroup>{r.keys.map((k) => <Kbd key={k}>{keyLabel(k)}</Kbd>)}</KbdGroup></dd>
                  </div>
                ))}
              </dl>
            </section>
          ))}
        </div>
      </DialogContent>
    </Dialog>
  );
}
