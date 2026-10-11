import { beforeAll, describe, expect, it } from "vitest";
import { guessLanguage, highlighter, loadHighlighter } from "./highlighter";

describe("highlighter", () => {
  beforeAll(async () => {
    await loadHighlighter();
  });

  it("is available synchronously once loaded", () => {
    expect(highlighter()).not.toBeNull();
  });

  it.each(["ts", "tsx", "go", "py", "rs", "json", "yaml", "sh", "powershell", "dockerfile", "toml", "html", "sql"])(
    "registers %s", (lang) => {
      expect(highlighter()!.registered(lang)).toBe(true);
    });

  it.each([
    ["typescript", "interface User { id: string; name?: string }\nexport function greet(u: User): string {\n  return `hi ${u.name ?? u.id}`;\n}"],
    ["go", "package main\n\nimport \"fmt\"\n\nfunc main() {\n\tfmt.Println(\"hello\")\n}"],
    ["python", "def greet(name: str) -> str:\n    return f\"hi {name}\"\n\nif __name__ == \"__main__\":\n    print(greet('bob'))"],
    ["json", "{\n  \"name\": \"datrope\",\n  \"private\": true,\n  \"version\": \"1.0.0\"\n}"],
  ])("guesses %s confidently", (lang, code) => {
    expect(guessLanguage(code)).toEqual({ lang, confident: true });
  });

  it("is not confident about prose", () => {
    expect(guessLanguage("Hej! Vi ses imorgon vid sju, ta med snacks och spel.")?.confident ?? false).toBe(false);
  });
});
