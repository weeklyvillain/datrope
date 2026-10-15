import { ChevronRight, type AnimatedIcon } from "@/components/icons";
import type { ReactNode } from "react";
import { Link } from "react-router-dom";
import { cn } from "@/lib/utils";

export const ROW = "flex min-h-[48px] w-full items-center gap-3 border-b px-4 text-left text-sm";

export type SettingsRow = { id: string; label: string; icon: AnimatedIcon; to?: string; state?: unknown; value?: ReactNode; soon?: string };

/** 48 px rows: icon, label, optional current value, chevron. Rows without a destination are disabled. */
export function SettingsList({ rows, label }: { rows: SettingsRow[]; label: string }) {
  return (
    <nav aria-label={label}>
      {rows.map(({ id, label: text, icon: Icon, to, state, value, soon }) => {
        const body = (
          <>
            <Icon className="size-5 flex-none text-muted-foreground" aria-hidden />
            <span className="min-w-0 flex-1 truncate">{text}</span>
            {soon ? <span className="text-xs text-muted-foreground">{soon}</span>
              : <>{value && <span className="text-xs text-muted-foreground">{value}</span>}<ChevronRight className="size-4 flex-none text-muted-foreground" aria-hidden /></>}
          </>
        );
        return to && !soon
          ? <Link key={id} to={to} state={state} className={cn(ROW, "text-foreground active:bg-accent")}>{body}</Link>
          : <span key={id} aria-disabled="true" className={cn(ROW, "opacity-50")}>{body}</span>;
      })}
    </nav>
  );
}
