import { readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const SRC = fileURLToPath(new URL("../..", import.meta.url));
const ALLOWED = [join(SRC, "components", "ui"), join(SRC, "components", "icons")];

function* files(dir: string): Generator<string> {
  for (const name of readdirSync(dir)) {
    const p = join(dir, name);
    if (statSync(p).isDirectory()) yield* files(p);
    else if (/\.tsx?$/.test(name)) yield p;
  }
}

describe("icon imports", () => {
  it("app code imports icons from @/components/icons, not lucide-react", () => {
    const offenders = [...files(SRC)].filter((f) => !ALLOWED.some((a) => f.startsWith(a)) && readFileSync(f, "utf8").includes('from "lucide-react"'));
    expect(offenders).toEqual([]);
  });
});
