import type { ReactNode } from "react";

/** The `<ul>` of stacked rows, for rows that need their own hooks (compose with `StackedRow`). */
export function StackedList({ label, children }: { label: string; children: ReactNode }) {
  return <ul aria-label={label} className="grid divide-y rounded-xl border bg-card">{children}</ul>;
}

/** One phone row: a primary line, a muted secondary line, actions on the right and optional content below. */
export function StackedRow({ primary, secondary, actions, below }: {
  primary: ReactNode; secondary?: ReactNode; actions?: ReactNode; below?: ReactNode;
}) {
  return (
    <li className="px-4 py-2">
      <div className="flex min-h-[56px] items-center gap-3">
        <div className="min-w-0 flex-1">
          <div className="min-w-0 font-medium">{primary}</div>
          {secondary && <div className="min-w-0 text-sm text-muted-foreground">{secondary}</div>}
        </div>
        {actions && <div className="flex flex-none items-center gap-2">{actions}</div>}
      </div>
      {below}
    </li>
  );
}

/** Phone replacement for an admin table: one stacked row per item. */
export function StackedRows<T>({ items, getKey, primary, secondary, actions, label }: {
  items: T[];
  getKey: (item: T) => string;
  primary: (item: T) => ReactNode;
  secondary?: (item: T) => ReactNode;
  actions?: (item: T) => ReactNode;
  label: string;
}) {
  return (
    <StackedList label={label}>
      {items.map((item) => (
        <StackedRow key={getKey(item)} primary={primary(item)} secondary={secondary?.(item)} actions={actions?.(item)} />
      ))}
    </StackedList>
  );
}
