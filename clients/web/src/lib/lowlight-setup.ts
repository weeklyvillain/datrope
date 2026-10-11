import dockerfile from "highlight.js/lib/languages/dockerfile";
import powershell from "highlight.js/lib/languages/powershell";
import { common, createLowlight } from "lowlight";

// lowlight's common set (ts/js incl. tsx/jsx, go, python, rust, java, kotlin, c, cpp, csharp, json,
// yaml, ini/toml, sql, bash/shell, xml/html, css, scss, markdown, diff, lua, php, ruby, swift, ...)
// plus a few the chat sees often.
export const lowlight = createLowlight(common);
lowlight.register({ dockerfile, powershell });
