import type { Element, ElementContent } from "hast";
import ReactMarkdown, { type Components } from "react-markdown";
import remarkGfm from "remark-gfm";
import { useMemo, useState, type ReactNode } from "react";
import { MentionTrigger } from "@/app/people/MentionTrigger";
import { CodeBlock } from "@/components/code-block";
import { client, useApp } from "@/session";
import { remarkChat, type ChatOptions } from "./remarkChat";
import { useEmojiData } from "./emoji-data";

// Everything else (headings, images, tables, rules, raw HTML) renders as its text.
const ALLOWED = ["p", "br", "strong", "em", "del", "code", "pre", "blockquote", "ul", "ol", "li", "a", "span", "img", "mark"];

export function Spoiler({ children }: { children?: ReactNode }) {
  const [shown, setShown] = useState(false);
  return (
    <span className="spoiler" data-shown={shown || undefined} role="button" tabIndex={0} aria-expanded={shown}
      aria-label={shown ? undefined : "Spoiler, select to show"}
      onClick={() => setShown(true)}
      onKeyDown={(e) => {
        if (e.key === "Enter" || e.key === " ") {
          e.preventDefault();
          setShown(true);
        }
      }}>
      {children}
    </span>
  );
}

// The text of a HAST subtree (a code block's content, whatever plugins wrapped it in).
const textOf = (n: ElementContent): string =>
  n.type === "text" ? n.value : n.type === "element" ? n.children.map(textOf).join("") : "";

// ```lang blocks: the language is the code element's "language-x" class.
function codeOf(pre: Element | undefined): { code: string; lang?: string } {
  const code = pre?.children.find((c): c is Element => c.type === "element" && c.tagName === "code");
  const cls = (code?.properties.className as string[] | undefined)?.find((c) => c.startsWith("language-"));
  const text = code ? code.children.map(textOf).join("") : "";
  return { code: text.endsWith("\n") ? text.slice(0, -1) : text, lang: cls?.slice("language-".length) };
}

const components: Components = {
  pre: ({ node }) => <CodeBlock {...codeOf(node)} />,
  a: ({ node: _n, ...p }) => <a {...p} target="_blank" rel="noopener noreferrer" />,
  // Only our custom emoji are images; a Markdown image shows its alt text.
  img: ({ node: _n, ...p }) =>
    (p as Record<string, unknown>)["data-emoji"] === "custom" ? <img {...p} className="emoji" loading="lazy" /> : <>{p.alt}</>,
  span: ({ node: _n, className, children, ...p }) => {
    if (className === "spoiler") return <Spoiler>{children}</Spoiler>;
    const userId = (p as Record<string, unknown>)["data-user-id"];
    if (className === "mention" && typeof userId === "string") {
      return <MentionTrigger userId={userId} me={"data-me" in p}>{children}</MentionTrigger>;
    }
    return <span className={className} {...p}>{children}</span>;
  },
};

// One-line rendering (a channel topic in a header): inline formatting only, no links or spoiler buttons.
const INLINE_ALLOWED = ["strong", "em", "del", "code", "span", "img", "mark"];
const inlineComponents: Components = {
  ...components,
  span: ({ node: _n, className, children, ...p }) => <span className={className} {...p}>{children}</span>,
};

/** Renders message Markdown with the given emoji and mention lookups. `inline` flattens it to one line of inline formatting.
 *  `highlight` marks those search terms. */
export function MarkdownView({ text, options: base, inline = false, highlight }: {
  text: string; options: ChatOptions; inline?: boolean; highlight?: string[];
}) {
  const options = highlight ? { ...base, highlight } : base;
  if (inline) {
    return (
      <span className="chat-md">
        <ReactMarkdown remarkPlugins={[remarkGfm, [remarkChat, options]]} allowedElements={INLINE_ALLOWED} unwrapDisallowed skipHtml
          components={inlineComponents}>
          {text.replace(/\s*\n\s*/g, " ")}
        </ReactMarkdown>
      </span>
    );
  }
  return (
    <div className="chat-md">
      <ReactMarkdown remarkPlugins={[remarkGfm, [remarkChat, options]]} allowedElements={ALLOWED} unwrapDisallowed skipHtml
        components={components}>
        {text}
      </ReactMarkdown>
    </div>
  );
}

/** Renders a message's content. `mentions` are the user IDs the server parsed from it;
 *  when given, only those users are highlighted. */
export function Markdown({ text, mentions, everyone = false, inline, highlight }: {
  text: string; mentions?: string[]; everyone?: boolean; inline?: boolean; highlight?: string[];
}) {
  const emoji = useApp((s) => s.emoji);
  const members = useApp((s) => s.server?.members);
  const meId = useApp((s) => s.me?.id);
  const data = useEmojiData();
  const mentionKey = mentions?.join(",");
  const highlightKey = highlight?.join(" ");
  const options = useMemo<ChatOptions>(() => {
    const mentioned = mentionKey === undefined ? null : new Set(mentionKey.split(","));
    return {
      custom: new Map(Object.values(emoji).map((e) => [e.name.toLowerCase(), { id: e.id, url: client.url(e.url) }])),
      shortcodes: data?.byShortcode ?? null,
      users: new Map(Object.values(members ?? {})
        .filter((m) => !mentioned || mentioned.has(m.user.id))
        .map((m) => [m.user.username.toLowerCase(), { id: m.user.id, name: m.user.display_name }])),
      meId,
      everyone,
      highlight: highlightKey ? highlightKey.split(" ") : undefined,
    };
  }, [emoji, members, meId, data, mentionKey, highlightKey, everyone]);
  return <MarkdownView text={text} options={options} inline={inline} />;
}
