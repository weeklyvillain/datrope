import { sidebarChannelIds } from "@datrope/core";
import { useEffect } from "react";
import { useLocation, useNavigate } from "react-router-dom";
import { emitPresent } from "@/app/chat-events";
import { isUnreadType } from "@/app/channel-types";
import { openShortcutSheet } from "@/components/shortcut-sheet";
import { isEditableTarget, isMac, isTypeToFocus, matchShortcut } from "@/lib/shortcuts";
import { isTouchOnly } from "@/lib/touch";
import { client, isUnread } from "@/session";
import { voice } from "@/voice/voice";

// Real layers only: a Radix tooltip also sits in a popper wrapper, and must not disable shortcuts.
const OPEN_LAYER = "[role=dialog],[role=alertdialog],[role=menu],[role=listbox]";
const hasOpenLayer = () =>
  !!document.querySelector(OPEN_LAYER) ||
  Array.from(document.querySelectorAll("[data-radix-popper-content-wrapper]")).some((w) => !w.querySelector("[role=tooltip]"));
const NAV = new Set(["channel-prev", "channel-next", "unread-prev", "unread-next"]);

/** Moves to the previous or next channel (or DM), optionally only unread ones, wrapping around. */
function step(pathname: string, dir: 1 | -1, unreadOnly: boolean): string | null {
  const s = client.store.getState();
  const dm = pathname.startsWith("/messages/");
  const ids = dm ? s.dmIds : sidebarChannelIds(s);
  const cur = ids.indexOf(pathname.split("/")[2] ?? "");
  const ok = (id: string) => !unreadOnly || ((dm || isUnreadType(s.channels[id]?.type)) && isUnread(s.readStates[id]));
  for (let n = 1; n <= ids.length; n++) {
    const i = cur < 0 ? (dir === 1 ? n - 1 : ids.length - n) : (((cur + dir * n) % ids.length) + ids.length) % ids.length;
    if (ids[i] && ids[i] !== ids[cur] && ok(ids[i])) return `${dm ? "/messages" : "/channels"}/${ids[i]}`;
  }
  return null;
}

function focusSearch(): boolean {
  const input = document.querySelector<HTMLInputElement>('input[aria-label="Search"]');
  if (input) {
    input.focus();
    return true;
  }
  const button = document.querySelector<HTMLButtonElement>('button[aria-label="Search"]');
  if (!button) return false;
  button.click();
  requestAnimationFrame(() => document.querySelector<HTMLInputElement>('input[aria-label="Search"]')?.focus());
  return true;
}

/** Desktop keyboard shortcuts (see lib/shortcuts.ts). Ctrl/Cmd+K lives in CommandPalette, message keys in MessageList. */
export function useShortcuts(enabled: boolean) {
  const nav = useNavigate();
  const { pathname } = useLocation();
  useEffect(() => {
    if (!enabled || isTouchOnly()) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.defaultPrevented || e.isComposing) return;
      const id = matchShortcut(e, isMac());
      if (id === "sheet") {
        e.preventDefault();
        return openShortcutSheet();
      }
      const target = e.target as HTMLElement | null;
      if (id) {
        if (hasOpenLayer()) return;
        if (NAV.has(id)) {
          // Editable fields keep Alt+arrows (word and paragraph moves), except the empty main message box.
          const box = target instanceof HTMLTextAreaElement && target.getAttribute("aria-label") === "Message" && target.value === "";
          if (isEditableTarget(target) && !box) return;
          const to = step(pathname, id.endsWith("next") ? 1 : -1, id.startsWith("unread"));
          if (!to) return;
          e.preventDefault();
          nav(to);
        } else if (id === "search") {
          if (focusSearch()) e.preventDefault();
        } else if (id === "mute" || id === "deafen") {
          const v = voice.store.getState();
          if (v.status === "idle") return;
          e.preventDefault();
          void (id === "mute" ? voice.setMuted(!v.muted) : voice.setDeafened(!v.deafened));
        }
        return;
      }
      if (hasOpenLayer()) return;
      if (isTypeToFocus(e, target)) {
        // The key lands in the box: focus it without preventing the keypress.
        document.querySelector<HTMLTextAreaElement>('textarea[aria-label="Message"]')?.focus();
      } else if (e.key === "Escape" && !e.ctrlKey && !e.metaKey && !e.altKey && !e.shiftKey) {
        const m = /^\/(?:channels|messages)\/([^/]+)/.exec(pathname);
        if (m && !target?.closest?.("input,textarea,select,[contenteditable],[data-message-row]")) emitPresent(m[1]);
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [enabled, pathname, nav]);
}
