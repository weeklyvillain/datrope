import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { NativeSelect } from "./native-select";

describe("NativeSelect", () => {
  it("is 16px on phones so iOS does not zoom", () => {
    const html = renderToStaticMarkup(<NativeSelect aria-label="x"><option>a</option></NativeSelect>);
    expect(html).toContain("text-[16px]");
    expect(html).toContain("md:text-sm");
  });
});
