import { toJsxRuntime, type Jsx } from "hast-util-to-jsx-runtime";
import { Check, Copy } from "lucide-react";
import { useMemo, useState, type ReactNode } from "react";
import { Fragment, jsx, jsxs } from "react/jsx-runtime";
import { Button } from "@/components/ui/button";
import { useHighlighter } from "@/lib/highlighter";
import { cn } from "@/lib/utils";

// Highlighting a huge text freezes the page; past this it renders as plain text.
const MAX_HIGHLIGHT_CHARS = 100_000;

/** A block of code, syntax-highlighted when its language is known, with a copy button. */
export function CodeBlock({ code, lang, lineNumbers = false, title, actions, copyText, className }: {
  code: string; lang?: string; lineNumbers?: boolean; title?: ReactNode; actions?: ReactNode; copyText?: string; className?: string;
}) {
  const hl = useHighlighter();
  const known = !!hl && !!lang && code.length <= MAX_HIGHLIGHT_CHARS && hl.registered(lang);
  // HAST to React elements: tokens become spans, nothing is parsed as HTML.
  const body = useMemo(
    () => (known ? toJsxRuntime(hl.highlight(lang, code), { Fragment, jsx: jsx as Jsx, jsxs: jsxs as Jsx }) : code),
    // `known` is derived from hl, lang and code.
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [hl, lang, code],
  );
  const count = lineNumbers ? code.split("\n").length : 0;
  return (
    <div className={cn("code-block overflow-hidden rounded-lg border bg-sidebar text-ui", className)}>
      <div className="flex items-center gap-2 border-b bg-card py-1 pl-3 pr-1 text-xs text-muted-foreground">
        <span className="flex min-w-0 flex-1 items-center gap-2">{title ?? lang ?? "text"}</span>
        {actions}
        <CopyButton text={copyText ?? code} />
      </div>
      <div className="flex overflow-x-auto" tabIndex={0}>
        {count > 0 && (
          <pre aria-hidden="true" className="select-none border-r px-3 py-2.5 text-right text-muted-foreground">
            {Array.from({ length: count }, (_, i) => i + 1).join("\n")}
          </pre>
        )}
        <pre className="flex-1 px-3 py-2.5"><code className={known ? `hljs language-${lang}` : undefined}>{body}</code></pre>
      </div>
    </div>
  );
}

function CopyButton({ text }: { text: string }) {
  const [copied, setCopied] = useState(false);
  return (
    <Button variant="ghost" size="icon-xs" aria-label="Copy code" title={copied ? "Copied" : "Copy code"}
      onClick={() => {
        void navigator.clipboard?.writeText(text).then(() => {
          setCopied(true);
          setTimeout(() => setCopied(false), 1500);
        }).catch(() => undefined);
      }}>
      {copied ? <Check /> : <Copy />}
    </Button>
  );
}
