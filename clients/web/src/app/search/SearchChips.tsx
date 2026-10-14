import { operatorValue, setOperator, sidebarChannelIds, type PublicUser, type SearchFilters } from "@datrope/core";
import { ChevronDown, X } from "lucide-react";
import { forwardRef, useId, type ComponentProps } from "react";
import { useShallow } from "zustand/react/shallow";
import { displayName, useApp } from "../../session";
import { UserAvatar } from "@/components/user-avatar";
import { Button } from "@/components/ui/button";
import { BareButton } from "@/components/bare-button";
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuTrigger } from "@/components/ui/dropdown-menu";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";
import { cn } from "@/lib/utils";

const chipClass = "inline-flex h-[26px] items-center gap-1 rounded-full border px-2 text-xs outline-none focus-visible:ring-2 focus-visible:ring-ring";
const offClass = "border-border text-muted-foreground hover:text-foreground";
const onClass = "border-primary bg-[color-mix(in_srgb,var(--primary)_12%,transparent)] text-primary";

/** A small rounded filter button that forwards its ref, for dropdown and popover triggers. */
const Chip = forwardRef<HTMLButtonElement, ComponentProps<"button"> & { on?: boolean }>(({ on = false, className, children, ...props }, ref) => (
  <BareButton ref={ref} className={cn(chipClass, on ? onClass : offClass, className)} {...props}>
    {children}<ChevronDown className="size-3" aria-hidden />
  </BareButton>
));
Chip.displayName = "Chip";

/** The filter chips under the search panel's header. Each one edits the query text. Labels come from
 *  the server's resolved filters, else from the query while it loads. */
export function SearchChips({ query, filters, onChange }: { query: string; filters?: SearchFilters; onChange: (q: string) => void }) {
  return (
    <div className="flex flex-none flex-wrap gap-1.5 border-b px-4 py-2.5">
      <FromChip query={query} from={filters?.from} onChange={onChange} />
      <InChip query={query} filters={filters} onChange={onChange} />
      <HasChip query={query} has={filters?.has} onChange={onChange} />
      <DateChip query={query} filters={filters} onChange={onChange} />
    </div>
  );
}

function FromChip({ query, from, onChange }: { query: string; from?: PublicUser; onChange: (q: string) => void }) {
  const username = operatorValue(query, "from");
  const member = useApp((s) => (from || !username ? undefined
    : Object.values(s.server?.members ?? {}).find((m) => m.user.username.toLowerCase() === username.toLowerCase())?.user));
  const user = from ?? member;
  const members = useApp(useShallow((s) => Object.values(s.server?.members ?? {}).map((m) => m.user)));
  if (username) {
    return (
      <span className={cn(chipClass, onClass)}>
        {user && <UserAvatar user={user} size="xs" />}
        From: {user ? displayName(user) : username}
        <BareButton aria-label="Remove from filter" className="ml-0.5 rounded-full hover:text-foreground"
          onClick={() => onChange(setOperator(query, "from", null))}>
          <X className="size-3" aria-hidden />
        </BareButton>
      </span>
    );
  }
  const sorted = [...members].sort((a, b) => displayName(a).localeCompare(displayName(b)));
  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild><Chip>From</Chip></DropdownMenuTrigger>
      <DropdownMenuContent align="start" className="max-h-72 overflow-y-auto">
        {sorted.map((u) => (
          <DropdownMenuItem key={u.id} onSelect={() => onChange(setOperator(query, "from", u.username))}>
            <UserAvatar user={u} size="xs" />{displayName(u)}
          </DropdownMenuItem>
        ))}
      </DropdownMenuContent>
    </DropdownMenu>
  );
}

function InChip({ query, filters, onChange }: { query: string; filters?: SearchFilters; onChange: (q: string) => void }) {
  const value = operatorValue(query, "in");
  const channels = useApp(useShallow((s) => sidebarChannelIds(s).map((id) => s.channels[id])
    .filter((c) => c && ["text", "voice", "webhook", "announcement", "forum", "gallery"].includes(c.type)).map((c) => c!.name)));
  const partners = useApp(useShallow((s) => {
    const seen = new Set<string>();
    const out: string[] = [];
    for (const id of s.dmIds) {
      for (const p of s.channels[id]?.participants ?? []) {
        if (p.id === s.me?.id || seen.has(p.id)) continue;
        seen.add(p.id);
        out.push(p.username);
      }
    }
    return out;
  }));
  const label = filters?.in_dm_with ? `In: DMs with ${displayName(filters.in_dm_with)}`
    : filters?.in_channel ? `In: #${filters.in_channel.name}`
    : value?.startsWith("@") ? `In: DMs with ${value.slice(1)}`
    : value ? `In: ${value.startsWith("#") ? value : `#${value}`}`
    : "In: any channel";
  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild><Chip on={!!value}>{label}</Chip></DropdownMenuTrigger>
      <DropdownMenuContent align="start" className="max-h-72 overflow-y-auto">
        <DropdownMenuItem onSelect={() => onChange(setOperator(query, "in", null))}>Any channel</DropdownMenuItem>
        {channels.map((name) => (
          <DropdownMenuItem key={`#${name}`} onSelect={() => onChange(setOperator(query, "in", `#${name}`))}>#{name}</DropdownMenuItem>
        ))}
        {partners.map((username) => (
          <DropdownMenuItem key={`@${username}`} onSelect={() => onChange(setOperator(query, "in", `@${username}`))}>@{username}</DropdownMenuItem>
        ))}
      </DropdownMenuContent>
    </DropdownMenu>
  );
}

function HasChip({ query, has, onChange }: { query: string; has?: string; onChange: (q: string) => void }) {
  const value = has ?? operatorValue(query, "has");
  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild><Chip on={!!value}>{value ? `Has: ${value}` : "Has"}</Chip></DropdownMenuTrigger>
      <DropdownMenuContent align="start">
        <DropdownMenuItem onSelect={() => onChange(setOperator(query, "has", null))}>Anything</DropdownMenuItem>
        <DropdownMenuItem onSelect={() => onChange(setOperator(query, "has", "link"))}>A link</DropdownMenuItem>
        <DropdownMenuItem onSelect={() => onChange(setOperator(query, "has", "file"))}>A file</DropdownMenuItem>
      </DropdownMenuContent>
    </DropdownMenu>
  );
}

function DateChip({ query, filters, onChange }: { query: string; filters?: SearchFilters; onChange: (q: string) => void }) {
  const before = filters?.before ?? operatorValue(query, "before");
  const after = filters?.after ?? operatorValue(query, "after");
  const id = useId();
  const label = before && after ? `After ${after}, before ${before}` : before ? `Before ${before}` : after ? `After ${after}` : "Date";
  return (
    <Popover>
      <PopoverTrigger asChild><Chip on={!!(before || after)}>{label}</Chip></PopoverTrigger>
      <PopoverContent align="start" className="grid w-64 gap-3">
        <div className="grid gap-1.5">
          <Label htmlFor={`${id}-before`}>Before</Label>
          <Input id={`${id}-before`} type="date" value={before ?? ""} onChange={(e) => onChange(setOperator(query, "before", e.target.value || null))} />
        </div>
        <div className="grid gap-1.5">
          <Label htmlFor={`${id}-after`}>After</Label>
          <Input id={`${id}-after`} type="date" value={after ?? ""} onChange={(e) => onChange(setOperator(query, "after", e.target.value || null))} />
        </div>
        <Button variant="ghost" size="sm" className="justify-self-start"
          onClick={() => onChange(setOperator(setOperator(query, "before", null), "after", null))}>Clear dates</Button>
      </PopoverContent>
    </Popover>
  );
}
