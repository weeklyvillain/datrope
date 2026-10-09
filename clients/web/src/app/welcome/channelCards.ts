export type WelcomeBlock = { kind: "markdown"; text: string } | { kind: "card"; name: string; description: string };

const CARD = /^\[\[channel:([^"\]]+?) "([^"]*)"\]\]$/;

/** Splits a welcome page into Markdown blocks and channel cards (one card per line). */
export function parseChannelCards(markdown: string): WelcomeBlock[] {
  const out: WelcomeBlock[] = [];
  let text: string[] = [];
  const flush = () => {
    if (text.length > 0) out.push({ kind: "markdown", text: text.join("\n") });
    text = [];
  };
  for (const line of markdown.split("\n")) {
    const m = CARD.exec(line.trim());
    if (m) {
      flush();
      out.push({ kind: "card", name: m[1].trim(), description: m[2] });
    } else {
      text.push(line);
    }
  }
  flush();
  return out;
}
