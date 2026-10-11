import { unwrap, type ContainerInfo, type SystemStats } from "@datrope/core";
import { useCallback, useEffect, useRef, useState } from "react";
import { ErrorText } from "@/components/error-text";
import { RefButton } from "@/components/ref-button";
import {
  AlertDialog, AlertDialogAction, AlertDialogCancel, AlertDialogContent, AlertDialogDescription,
  AlertDialogFooter, AlertDialogHeader, AlertDialogTitle, AlertDialogTrigger,
} from "@/components/ui/alert-dialog";
import { Badge } from "@/components/ui/badge";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Progress } from "@/components/ui/progress";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { formatBytes, formatDuration } from "@/lib/system";
import { client, errorText } from "@/session";
import { Sparkline } from "./Sparkline";

const POLL_MS = 5000;

/** Host and container metrics (instance admin). Polls while open, 5 s after each response. */
export function System() {
  const [stats, setStats] = useState<SystemStats>();
  const [error, setError] = useState<string>();
  const live = useRef(true);
  const seq = useRef(0);
  const timer = useRef<ReturnType<typeof setTimeout>>();

  const load = useCallback(async () => {
    clearTimeout(timer.current);
    const id = ++seq.current;
    try {
      const s = await unwrap(client.api.GET("/api/admin/system/stats"));
      if (live.current && id === seq.current) { setStats(s); setError(undefined); }
    } catch (e) {
      if (live.current && id === seq.current) setError(errorText(e));
    } finally {
      if (live.current && id === seq.current) timer.current = setTimeout(() => void load(), POLL_MS);
    }
  }, []);

  useEffect(() => {
    live.current = true;
    void load();
    return () => { live.current = false; clearTimeout(timer.current); };
  }, [load]);

  const restart = async (service: string) => {
    let failed: string | undefined;
    try {
      await unwrap(client.api.POST("/api/admin/system/containers/{service}/restart", { params: { path: { service } } }));
    } catch (e) {
      failed = errorText(e);
    }
    await load();
    if (failed && live.current) setError(failed);
  };

  return (
    <>
      <ErrorText error={error} />
      {stats && <SystemView stats={stats} onRestart={(s) => void restart(s)} />}
    </>
  );
}

function Meter({ title, value, detail, series }: { title: string; value: number; detail: string; series: number[] }) {
  return (
    <Card className="gap-2 py-4">
      <CardHeader className="px-4"><CardTitle className="text-sm">{title}</CardTitle></CardHeader>
      <CardContent className="grid gap-2 px-4">
        <div className="flex items-baseline justify-between gap-2">
          <span className="text-2xl font-semibold tabular-nums">{Math.round(value)}%</span>
          <span className="text-xs text-muted-foreground">{detail}</span>
        </div>
        <Progress value={value} aria-label={`${title} ${Math.round(value)}%`} />
        <Sparkline values={series} max={100} />
      </CardContent>
    </Card>
  );
}

const pct = (used: number, total: number) => (total > 0 ? (used / total) * 100 : 0);

/** The page body for given stats (rendered on its own in tests). */
export function SystemView({ stats, onRestart }: { stats: SystemStats; onRestart: (service: string) => void }) {
  const { host } = stats;
  const s = host.latest;
  const series = host.series ?? [];
  const figures: [string, string][] = [
    ["Host uptime", formatDuration(host.host_uptime_seconds)],
    ["Server uptime", formatDuration(host.process_uptime_seconds)],
    ["Database", formatBytes(host.database_bytes)],
    ["Uploaded files", formatBytes(host.files_bytes)],
    ["Connections", String(s?.connections ?? 0)],
    ["In voice", String(s?.in_voice ?? 0)],
  ];
  return (
    <>
      <section className="grid gap-3" aria-labelledby="host-h">
        <h3 id="host-h" className="text-sm font-semibold">Host</h3>
        {s ? (
          <div className="grid gap-3 sm:grid-cols-3">
            <Meter title="CPU" value={s.cpu_percent} detail="all cores" series={series.map((x) => x.cpu_percent)} />
            <Meter title="Memory" value={pct(s.mem_used, s.mem_total)} detail={`${formatBytes(s.mem_used)} of ${formatBytes(s.mem_total)}`}
              series={series.map((x) => pct(x.mem_used, x.mem_total))} />
            <Meter title="Disk" value={pct(s.disk_used, s.disk_total)} detail={`${formatBytes(s.disk_used)} of ${formatBytes(s.disk_total)}`}
              series={series.map((x) => pct(x.disk_used, x.disk_total))} />
          </div>
        ) : (
          <p className="text-muted-foreground">Collecting the first sample…</p>
        )}
        <dl className="grid grid-cols-2 gap-x-6 gap-y-2 sm:grid-cols-3 lg:grid-cols-6">
          {figures.map(([k, v]) => (
            <div key={k}>
              <dt className="text-xs text-muted-foreground">{k}</dt>
              <dd className="font-medium tabular-nums">{v}</dd>
            </div>
          ))}
        </dl>
      </section>

      <section className="grid gap-3" aria-labelledby="containers-h">
        <h3 id="containers-h" className="text-sm font-semibold">Containers</h3>
        {!stats.updater_configured ? (
          <p className="max-w-[68ch] text-muted-foreground">
            Container status and restarts need the updater. Set <code>DATROPE_UPDATER_TOKEN</code> in <code>deploy/.env</code>
            {" "}and run <code>docker compose up -d</code> once (see <code>deploy/README.md</code>).
          </p>
        ) : stats.updater_error ? (
          <p role="alert" className="text-destructive">The updater did not answer: {stats.updater_error}</p>
        ) : (
          <ContainerTable containers={stats.containers ?? []} onRestart={onRestart} />
        )}
      </section>
    </>
  );
}

function ContainerTable({ containers, onRestart }: { containers: ContainerInfo[]; onRestart: (service: string) => void }) {
  return (
    <Table>
      <TableHeader>
        <TableRow>
          <TableHead>Container</TableHead>
          <TableHead>Status</TableHead>
          <TableHead className="text-right">CPU</TableHead>
          <TableHead className="text-right">Memory</TableHead>
          <TableHead><span className="sr-only">Actions</span></TableHead>
        </TableRow>
      </TableHeader>
      <TableBody>
        {containers.map((c) => {
          const running = c.state === "running";
          return (
            <TableRow key={c.name}>
              <TableCell className="font-medium">{c.name}</TableCell>
              <TableCell>
                <Badge variant={running ? "secondary" : "destructive"}>{c.state}</Badge>
                <span className="ml-2 text-xs text-muted-foreground">{c.status}</span>
              </TableCell>
              <TableCell className="text-right tabular-nums">{running ? `${c.cpu_percent.toFixed(1)}%` : "–"}</TableCell>
              <TableCell className="text-right tabular-nums">{running ? formatBytes(c.mem_bytes) : "–"}</TableCell>
              <TableCell className="text-right">
                {c.service !== "updater" && (
                  <AlertDialog>
                    <AlertDialogTrigger asChild>
                      <RefButton variant="outline" size="sm" aria-label={`Restart ${c.service}`}>Restart</RefButton>
                    </AlertDialogTrigger>
                    <AlertDialogContent>
                      <AlertDialogHeader>
                        <AlertDialogTitle>Restart {c.service}?</AlertDialogTitle>
                        <AlertDialogDescription>
                          {c.service === "server"
                            ? "Everyone is disconnected for a few seconds and reconnects on their own."
                            : `The ${c.service} container stops and starts again.`}
                        </AlertDialogDescription>
                      </AlertDialogHeader>
                      <AlertDialogFooter>
                        <AlertDialogCancel>Cancel</AlertDialogCancel>
                        <AlertDialogAction onClick={() => onRestart(c.service)}>Restart</AlertDialogAction>
                      </AlertDialogFooter>
                    </AlertDialogContent>
                  </AlertDialog>
                )}
              </TableCell>
            </TableRow>
          );
        })}
      </TableBody>
    </Table>
  );
}
