import { Search } from "lucide-react";
import { useId } from "react";
import { ActionSheet } from "@/components/action-sheet";
import { Input } from "@/components/ui/input";
import { NativeSelect, NativeSelectOption } from "@/components/ui/native-select";
import { Toggle } from "@/components/ui/toggle";
import type { PostSort } from "./filter";

const chip = "h-9 rounded-full px-4 text-[13px] font-normal text-muted-foreground data-[state=on]:border-foreground data-[state=on]:font-semibold data-[state=on]:text-foreground";

/** Phone version of the forum's filter bar: search, tag chips and sort in a bottom sheet. */
export function ForumFilterSheet({ open, onOpenChange, query, onQuery, tag, onTag, tags, sort, onSort }: {
  open: boolean; onOpenChange: (open: boolean) => void;
  query: string; onQuery: (q: string) => void;
  tag: string | null; onTag: (t: string | null) => void; tags: string[];
  sort: PostSort; onSort: (s: PostSort) => void;
}) {
  const sortId = useId();
  return (
    <ActionSheet open={open} onOpenChange={onOpenChange} title="Filter posts" role="group">
      <div className="flex flex-col gap-4 p-2">
        <div className="relative">
          <Search className="pointer-events-none absolute top-1/2 left-3 size-4 -translate-y-1/2 text-muted-foreground" aria-hidden />
          <Input className="min-h-[44px] pl-9" type="search" value={query} onChange={(e) => onQuery(e.target.value)}
            placeholder="Search posts" aria-label="Search posts" />
        </div>
        <div role="group" aria-label="Filter by tag" className="flex flex-wrap gap-2">
          <Toggle variant="outline" size="sm" className={chip} pressed={tag === null} onPressedChange={() => onTag(null)}>All</Toggle>
          {tags.map((t) => (
            <Toggle key={t} variant="outline" size="sm" className={chip} pressed={tag === t} onPressedChange={(on) => onTag(on ? t : null)}>{t}</Toggle>
          ))}
        </div>
        <div className="flex items-center gap-3">
          <label htmlFor={sortId} className="text-[13px] text-muted-foreground">Sort</label>
          <NativeSelect id={sortId} value={sort} onChange={(e) => onSort(e.target.value as PostSort)}>
            <NativeSelectOption value="activity">Latest activity</NativeSelectOption>
            <NativeSelectOption value="newest">Newest</NativeSelectOption>
            <NativeSelectOption value="replies">Most replies</NativeSelectOption>
          </NativeSelect>
        </div>
      </div>
    </ActionSheet>
  );
}
