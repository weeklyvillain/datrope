import { useEffect, useState, type ReactNode } from "react";
import { ServerIconImage } from "@/components/logo";
import { Card } from "@/components/ui/card";

const ICON = "/api/server/icon";

export function AuthLayout({ title, children }: { title: string; children: ReactNode }) {
  // The instance's icon when one is uploaded; the Datrope mark otherwise (404) or on error.
  const [icon, setIcon] = useState<string>();
  useEffect(() => {
    let cancelled = false;
    fetch(ICON, { method: "HEAD" })
      .then((r) => !cancelled && r.ok && setIcon(ICON))
      .catch(() => undefined);
    return () => {
      cancelled = true;
    };
  }, []);
  return (
    <main className="grid min-h-screen place-items-center p-4">
      <Card className="w-full max-w-[400px] gap-4 p-6">
        <ServerIconImage src={icon} size={48} />
        <h1 className="text-xl">{title}</h1>
        {children}
      </Card>
    </main>
  );
}
