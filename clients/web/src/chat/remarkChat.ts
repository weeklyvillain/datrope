// A remark plugin for chat syntax that Markdown lacks: ||spoilers||, :emoji:, @mentions and written times ("9pm").
// It rewrites text nodes only, never inside code or links.

import { splitHighlights } from "./highlight";
import { findTimes, resolveTime } from "@/lib/time-mention";

export type ChatOptions = {
  custom: Map<string, { id: string; url: string; srcSet?: string }>; // custom emoji by lower-cased name
  shortcodes: Map<string, string> | null; // Unicode emoji by lower-cased shortcode; null while loading
  users: Map<string, { id: string; name: string }>; // mentionable users by lower-cased username
  meId?: string;
  roles?: Map<string, { name: string; color?: string; me: boolean }>; // by role ID; me = it pinged me
  everyone?: boolean; // the message pinged @everyone: show it as a mention of me
  highlight?: string[]; // search terms to mark (outside spoilers, code and links)
  time?: { sentAt: string; tz?: string }; // the message's send time and sender zone: written times become chips
};

type Node = { type: string; value?: string; children?: Node[]; data?: Record<string, unknown> };

const SKIP = new Set(["code", "inlineCode", "link"]);
// Mentions follow the server's rule: preceded by start or a character that is not
// a letter, digit, "_", ".", "-" or "@"; names longer than 32 are not usernames.
const TOKEN = /(<@&\d{1,20}>|\|\|[\s\S]+?\|\||:[A-Za-z0-9_+-]{2,32}:|(?<![A-Za-z0-9_.@-])@[A-Za-z0-9_.-]{2,})/g;

const text = (value: string): Node => ({ type: "text", value });

function tokenNodes(token: string, o: ChatOptions): Node[] {
  if (token.startsWith("<@&")) {
    const id = token.slice(3, -1);
    const role = o.roles?.get(id);
    const props: Record<string, unknown> = { className: ["mention"] };
    if (role) {
      props["data-role-id"] = id;
      if (role.color) props.style = `color:${role.color}`;
      if (role.me) props["data-me"] = "";
    }
    return [{ type: "chatMention", data: { hName: "span", hProperties: props }, children: [text(role ? "@" + role.name : "@deleted-role")] }];
  }
  if (token.startsWith("||")) {
    return [{
      type: "chatSpoiler",
      data: { hName: "span", hProperties: { className: ["spoiler"] } },
      children: [text(token.slice(2, -2))],
    }];
  }
  if (token.startsWith(":")) {
    const name = token.slice(1, -1).toLowerCase();
    const custom = o.custom.get(name);
    if (custom) {
      return [{
        type: "chatEmoji",
        data: { hName: "img", hProperties: { src: custom.url, ...(custom.srcSet && { srcSet: custom.srcSet }), alt: token, className: ["emoji"], "data-emoji": "custom", draggable: false } },
      }];
    }
    const unicode = o.shortcodes?.get(name);
    return [text(unicode ?? token)];
  }
  // A mention: "@bob." ends a sentence, so trailing "." and "-" are not part of the name.
  const name = token.slice(1).replace(/[.-]+$/, "");
  if (o.everyone && name.toLowerCase() === "everyone") {
    const nodes: Node[] = [{ type: "chatMention", data: { hName: "span", hProperties: { className: ["mention"], "data-me": "" } }, children: [text("@everyone")] }];
    const rest = token.slice(1 + name.length);
    return rest ? [...nodes, text(rest)] : nodes;
  }
  const user = name.length >= 2 && name.length <= 32 ? o.users.get(name.toLowerCase()) : undefined;
  if (!user) return [text(token)];
  const nodes: Node[] = [{
    type: "chatMention",
    data: {
      hName: "span",
      hProperties: { className: ["mention"], "data-user-id": user.id, ...(user.id === o.meId ? { "data-me": "" } : {}) },
    },
    children: [text("@" + name)],
  }];
  const rest = token.slice(1 + name.length);
  if (rest) nodes.push(text(rest));
  return nodes;
}

function splitText(value: string, o: ChatOptions): Node[] | null {
  const out: Node[] = [];
  let last = 0;
  let changed = false;
  for (const m of value.matchAll(TOKEN)) {
    const nodes = tokenNodes(m[0], o);
    if (nodes.length === 1 && nodes[0].type === "text" && nodes[0].value === m[0]) continue; // unknown: leave as text
    if (m.index > last) out.push(text(value.slice(last, m.index)));
    out.push(...nodes);
    last = m.index + m[0].length;
    changed = true;
  }
  if (!changed) return null;
  if (last < value.length) out.push(text(value.slice(last)));
  return out;
}

/** Marks search terms in plain text nodes; other nodes (spoilers, mentions, emoji) are left alone. */
function highlight(nodes: Node[], terms: string[] | undefined): Node[] {
  if (!terms?.length) return nodes;
  return nodes.flatMap((n) => n.type !== "text" || !n.value ? [n]
    : splitHighlights(n.value, terms).map((p) => (p.mark
      ? { type: "chatMark", data: { hName: "mark" }, children: [text(p.text)] }
      : text(p.text))));
}

/** Wraps written times ("9pm", "21:00 CET") in plain text nodes; other nodes are left alone. */
function times(nodes: Node[], t: ChatOptions["time"]): Node[] {
  if (!t) return nodes;
  return nodes.flatMap((n) => {
    if (n.type !== "text" || !n.value) return [n];
    const out: Node[] = [];
    let last = 0;
    for (const m of findTimes(n.value)) {
      const at = resolveTime(m, t.sentAt, t.tz);
      if (!at) continue;
      const src = n.value.slice(m.index, m.index + m.length);
      if (m.index > last) out.push(text(n.value.slice(last, m.index)));
      out.push({ type: "chatTime", data: { hName: "span", hProperties: { className: ["time-mention"], "data-time": at.toISOString(), "data-src": src, "data-zone": m.zone ?? t.tz, ...(m.zone ? { "data-written": "" } : {}) } }, children: [text(src)] });
      last = m.index + m.length;
    }
    if (last === 0) return [n];
    if (last < n.value.length) out.push(text(n.value.slice(last)));
    return out;
  });
}

function walk(node: Node, o: ChatOptions) {
  if (!node.children) return;
  const next: Node[] = [];
  for (const child of node.children) {
    if (child.type === "text" && child.value) {
      next.push(...highlight(times(splitText(child.value, o) ?? [child], o.time), o.highlight));
      continue;
    } else if (!SKIP.has(child.type)) {
      walk(child, o);
    }
    next.push(child);
  }
  node.children = next;
}

/** The unified plugin; pass it to react-markdown as [remarkChat, options]. */
export function remarkChat(options: ChatOptions) {
  return (tree: Node) => walk(tree, options);
}
