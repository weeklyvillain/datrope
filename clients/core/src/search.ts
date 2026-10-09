export type SearchOperator = "from" | "in" | "has" | "before" | "after";

const token = (key: SearchOperator) => new RegExp(`(^|\\s)${key}:\\S*`, "gi");
const tidy = (s: string) => s.replace(/\s+/g, " ").trim();

/** Sets an operator in a search query (null or "" removes it), keeping the words and other operators. */
export function setOperator(query: string, key: SearchOperator, value: string | null): string {
  const rest = tidy(query.replace(token(key), " "));
  return value ? tidy(`${rest} ${key}:${value}`) : rest;
}

/** The value of an operator in a query (the last one wins, as on the server). */
export function operatorValue(query: string, key: SearchOperator): string | undefined {
  const all = [...query.matchAll(new RegExp(`(?:^|\\s)${key}:(\\S+)`, "gi"))];
  return all.at(-1)?.[1];
}

/** The query without any operators: "Clear filters". */
export function clearOperators(query: string): string {
  return tidy(query.split(/\s+/).filter((w) => !/^(from|in|has|before|after):/i.test(w)).join(" "));
}
