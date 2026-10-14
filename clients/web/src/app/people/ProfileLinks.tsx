import { describeLink, isHttpsLink, linkIcon } from "@/lib/social";

/** A person's links: site icon, name and host. Only https URLs become anchors. */
export function ProfileLinks({ links }: { links: string[] }) {
  const safe = links.filter(isHttpsLink);
  if (safe.length === 0) return null;
  return (
    <ul className="m-0 grid list-none gap-1 p-0">
      {safe.map((url, i) => {
        const { name, host, icon } = describeLink(url);
        const Icon = linkIcon(icon);
        return (
          <li key={`${i}-${url}`}>
            <a href={url} target="_blank" rel="noopener noreferrer" aria-label={`${name} on ${host}`}
              className="flex min-w-0 items-center gap-2 rounded-sm text-sm text-foreground outline-none hover:underline focus-visible:ring-2 focus-visible:ring-ring">
              <Icon className="size-4 shrink-0 text-muted-foreground" />
              <span className="shrink-0">{name}</span>
              <span className="truncate text-muted-foreground">{host}</span>
            </a>
          </li>
        );
      })}
    </ul>
  );
}
