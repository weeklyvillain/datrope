import { Perm, emojiList, hasPerm, type PublicUser } from "@datrope/core";
import { useMemo, type ReactNode } from "react";
import { useShallow } from "zustand/react/shallow";
import { displayName, useApp, usePerms } from "@/session";
import { cn } from "@/lib/utils";
import { rank, type Trigger } from "./autocomplete";
import type { Command } from "./commands";
import { useEmojiData } from "./emoji-data";
import { sizedImage } from "@/lib/sized-image";

export type Suggestion = { id: string; insert: string; icon: ReactNode; text: string; hint?: string };

const MAX = 8;

/** The commands, members or emoji matching the composer's current `/`, `@` or `:` trigger.
 *  `commands` are the ones available here (see availableCommands). */
export function useSuggestions(channelId: string, trigger: Trigger | null, commands: Command[]): Suggestion[] {
  const users = useApp(useShallow((s): PublicUser[] => {
    const ch = s.channels[channelId];
    return ch?.type === "dm" ? ch.participants ?? [] : Object.values(s.server?.members ?? {}).map((m) => m.user);
  }));
  const canPingEveryone = hasPerm(usePerms(channelId), Perm.MentionEveryone);
  const custom = useApp(useShallow(emojiList));
  const data = useEmojiData();
  const shortcodes = useMemo(() => (data?.list ?? []).flatMap((e) => e.shortcodes.map((key) => ({ key, emoji: e.emoji }))), [data]);

  return useMemo(() => {
    if (!trigger) return [];
    const q = trigger.query;
    if (trigger.kind === "command") {
      const entries = commands.map((c) => ({ key: c.name, c }));
      // A bare "/" lists every command in registry order; rank would stop at 8.
      return (q ? rank(q, entries) : entries).map(({ c }) => ({
        id: `command-${c.name}`, insert: `/${c.name} `, text: `/${c.name}${c.args ? ` ${c.args}` : ""}`, hint: c.description,
        icon: <span className="grid size-6 place-items-center rounded-md bg-muted text-xs font-semibold" aria-hidden="true">/</span>,
      }));
    }
    if (trigger.kind === "mention") {
      const byUsername = rank(q, users.map((u) => ({ key: u.username, u })));
      const byName = rank(q, users.filter((u) => u.display_name).map((u) => ({ key: u.display_name!, u })));
      const seen = new Set<string>();
      const everyone: Suggestion[] = canPingEveryone && "everyone".startsWith(q.toLowerCase()) ? [{
        id: "everyone", insert: "@everyone ", text: "@everyone", hint: "Notify everyone who can read this channel",
        icon: <span className="grid size-6 place-items-center rounded-full bg-muted text-xs font-semibold" aria-hidden="true">@</span>,
      }] : [];
      return [...everyone, ...[...byUsername, ...byName].filter(({ u }) => !seen.has(u.id) && !!seen.add(u.id)).map(({ u }) => ({
        id: `user-${u.id}`, insert: `@${u.username} `, text: displayName(u), hint: `@${u.username}`,
        icon: <span className="grid size-6 place-items-center rounded-full bg-muted text-[10px] font-semibold" aria-hidden="true">
          {displayName(u).slice(0, 2).toUpperCase()}
        </span>,
      }))].slice(0, MAX);
    }
    const fromServer = rank(q, custom.map((e) => ({ key: e.name, e }))).map(({ e }): Suggestion => ({
      id: `custom-${e.id}`, insert: `:${e.name}: `, text: `:${e.name}:`,
      icon: <img {...sizedImage(e.url, 24)} alt="" className="size-6 object-contain" />,
    }));
    const fromUnicode = rank(q, shortcodes).map((s): Suggestion => ({
      id: `unicode-${s.key}`, insert: s.emoji, text: `:${s.key}:`, icon: <span className="text-xl leading-none">{s.emoji}</span>,
    }));
    return [...fromServer, ...fromUnicode].slice(0, MAX);
  }, [trigger, users, custom, shortcodes, commands, canPingEveryone]);
}

const LABELS: Record<Trigger["kind"], string> = {
  mention: "Member suggestions",
  emoji: "Emoji suggestions",
  command: "Command suggestions",
};

/** The suggestion list above the composer. Focus stays in the message box, which
 *  points at the active option with aria-activedescendant. */
export function Autocomplete({ id, kind, items, active, onPick, onHover }: {
  id: string; kind: Trigger["kind"]; items: Suggestion[]; active: number;
  onPick: (s: Suggestion) => void; onHover: (i: number) => void;
}) {
  return (
    <ul id={id} role="listbox" aria-label={LABELS[kind]}
      className="absolute inset-x-0 bottom-full z-20 mb-1 list-none rounded-lg border bg-popover p-1 text-popover-foreground shadow-md">
      {items.map((s, i) => (
        <li key={s.id} id={`${id}-${i}`} role="option" aria-selected={i === active}
          className={cn("flex cursor-pointer items-center gap-2 rounded-md px-2 py-1.5 text-sm", i === active && "bg-accent text-accent-foreground")}
          onMouseDown={(e) => e.preventDefault()} onMouseEnter={() => onHover(i)} onClick={() => onPick(s)}>
          {s.icon}
          <span className="truncate">{s.text}</span>
          {s.hint && <span className="truncate text-muted-foreground">{s.hint}</span>}
        </li>
      ))}
    </ul>
  );
}
