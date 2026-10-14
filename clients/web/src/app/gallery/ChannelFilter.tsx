import { Check, ChevronDown } from "lucide-react";
import { useMemo, useState } from "react";
import { Command, CommandEmpty, CommandGroup, CommandInput, CommandItem, CommandList } from "@/components/ui/command";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";
import { RefButton } from "@/components/ref-button";
import { cn } from "@/lib/utils";
import { useApp } from "../../session";
import { BareButton } from "@/components/bare-button";

const LISTED = new Set(["text", "announcement", "forum", "gallery", "voice", "webhook"]);

/** "In channel": pick any number of channels; none picked means every channel. */
export function ChannelFilter({ value, onChange }: { value: string[]; onChange: (ids: string[]) => void }) {
  const [open, setOpen] = useState(false);
  const channels = useApp((s) => s.channels);
  const order = useApp((s) => s.server?.channelIds);
  const options = useMemo(() => (order ?? []).map((id) => channels[id]).filter((c) => c && LISTED.has(c.type)), [order, channels]);
  const label = value.length === 0 ? "All" : value.length === 1 ? `#${channels[value[0]]?.name ?? "1 channel"}` : `${value.length} channels`;
  const toggle = (id: string) => onChange(value.includes(id) ? value.filter((x) => x !== id) : [...value, id]);
  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger asChild>
        <RefButton variant="outline" size="sm" aria-label={`In channel: ${label}`}
          className={cn("h-7 gap-1.5 rounded-full text-ui font-normal", value.length > 0 && "border-primary bg-primary/10 text-primary")}>
          In channel: {label}<ChevronDown className="size-3.5" />
        </RefButton>
      </PopoverTrigger>
      <PopoverContent align="end" className="w-60 p-0">
        <Command>
          <CommandInput placeholder="Find a channel" aria-label="Find a channel" />
          <CommandList>
            <CommandEmpty>No channel.</CommandEmpty>
            <CommandGroup>
              {options.map((c) => (
                <CommandItem key={c.id} value={`${c.name} ${c.id}`} onSelect={() => toggle(c.id)} data-checked={value.includes(c.id)} aria-checked={value.includes(c.id)}>
                  <Check className={cn("size-4", !value.includes(c.id) && "invisible")} />#{c.name}
                </CommandItem>
              ))}
            </CommandGroup>
          </CommandList>
          {value.length > 0 && (
            <BareButton className="w-full border-t px-3 py-2 text-left text-sm text-muted-foreground hover:text-foreground"
              onClick={() => onChange([])}>Clear selection</BareButton>
          )}
        </Command>
      </PopoverContent>
    </Popover>
  );
}
