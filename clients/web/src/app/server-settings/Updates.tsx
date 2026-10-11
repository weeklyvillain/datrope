import { unwrap, type SystemUpdates } from "@datrope/core";
import { useEffect, useRef, useState } from "react";
import { ErrorText } from "@/components/error-text";
import { RefButton } from "@/components/ref-button";
import {
  AlertDialog, AlertDialogAction, AlertDialogCancel, AlertDialogContent, AlertDialogDescription,
  AlertDialogFooter, AlertDialogHeader, AlertDialogTitle, AlertDialogTrigger,
} from "@/components/ui/alert-dialog";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader } from "@/components/ui/card";
import { Spinner } from "@/components/ui/spinner";
import { useSubmit } from "@/hooks/use-submit";
import { classifyPollError, needsRebuild, nextPoll, type JobView, type PollResult } from "@/lib/system";
import { client } from "@/session";

const JOB_POLL_MS = 1000;
const JOB_KEY = "datrope.updateJob"; // lets a reload during the server restart find the job again

function readJobId(): string | undefined {
  try { return sessionStorage.getItem(JOB_KEY) ?? undefined; } catch { return undefined; }
}
function writeJobId(id: string | undefined) {
  try { if (id) sessionStorage.setItem(JOB_KEY, id); else sessionStorage.removeItem(JOB_KEY); } catch { /* storage blocked */ }
}

/** Server and yt-dlp updates (instance admin). */
export function Updates() {
  const [updates, setUpdates] = useState<SystemUpdates>();
  const [jobId, setJobId] = useState<string | undefined>(readJobId);
  const [job, setJob] = useState<JobView>();
  const { busy, error, run } = useSubmit();

  const load = () => run(async () => setUpdates(await unwrap(client.api.GET("/api/admin/system/updates"))));
  useEffect(() => {
    void load();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // Follow the log of the job until it ends, through the server restart. One request in flight at
  // a time: the next tick is scheduled only after the previous response (or failure).
  useEffect(() => {
    if (!jobId) return;
    let view: JobView = { phase: "running", lines: [], next: 0 };
    setJob(view);
    let live = true;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const tick = async () => {
      let result: PollResult;
      try {
        result = {
          log: await unwrap(client.api.GET("/api/admin/system/jobs/{id}", {
            params: { path: { id: jobId }, query: { after: view.next } },
          })),
        };
      } catch (e) {
        result = classifyPollError(e);
      }
      if (!live) return;
      view = nextPoll(view, result);
      setJob(view);
      if (view.phase === "succeeded") {
        writeJobId(undefined);
        // Check rather than read: the update changed the checkout, and maybe yt-dlp's state.
        void run(async () => {
          const u = await unwrap(client.api.POST("/api/admin/system/updates/check"));
          setUpdates(u);
          const sha = u.server.status?.deployed || u.server.status?.current;
          if (sha) setJob((j) => (j ? { ...j, sha } : j));
        });
        return;
      }
      if (view.phase === "failed") {
        writeJobId(undefined);
        void load();
        return;
      }
      timer = setTimeout(() => void tick(), JOB_POLL_MS);
    };
    void tick();
    return () => { live = false; clearTimeout(timer); };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [jobId]);

  return (
    <>
      <ErrorText error={error} />
      {updates && (
        <UpdatesView
          updates={updates}
          busy={busy}
          job={job}
          onCheck={() => void run(async () => setUpdates(await unwrap(client.api.POST("/api/admin/system/updates/check"))))}
          onUpdateServer={() => void run(async () => {
            const { job_id } = await unwrap(client.api.POST("/api/admin/system/updates/server"));
            writeJobId(job_id);
            setJobId(job_id);
          })}
          onUpdateYtDlp={() => void run(async () => {
            const ytdlp = await unwrap(client.api.POST("/api/admin/system/updates/ytdlp"));
            setUpdates((u) => (u ? { ...u, ytdlp } : u));
          })}
        />
      )}
    </>
  );
}

const short = (sha: string) => sha.slice(0, 7);
const plural = (n: number, word: string) => `${n} ${word}${n === 1 ? "" : "s"}`;

export function UpdatesView({ updates, busy, job, onCheck, onUpdateServer, onUpdateYtDlp }: {
  updates: SystemUpdates;
  busy: boolean;
  job: JobView | undefined;
  onCheck: () => void;
  onUpdateServer: () => void;
  onUpdateYtDlp: () => void;
}) {
  const srv = updates.server;
  const st = srv.status;
  const commits = st?.commits ?? [];
  const y = updates.ytdlp;
  const ytNewer = !!y.latest && !!y.installed && y.latest !== y.installed;
  const jobRunning = job?.phase === "running" || job?.phase === "restarting";
  const rebuild = needsRebuild(st);
  return (
    <>
      <div>
        <Button variant="outline" size="sm" disabled={busy || jobRunning} onClick={onCheck}>Check now</Button>
      </div>

      <Card className="gap-3 py-4" aria-labelledby="srv-h">
        <CardHeader className="px-4"><h3 id="srv-h" className="text-sm font-semibold">Server</h3></CardHeader>
        <CardContent className="grid gap-3 px-4 [&>*]:min-w-0">
          {!srv.configured ? (
            <p className="max-w-[68ch] text-muted-foreground">
              Updating from here needs the updater. Set <code>DATROPE_UPDATER_TOKEN</code> in <code>deploy/.env</code> and
              run <code>docker compose up -d</code> once (see <code>deploy/README.md</code>).
            </p>
          ) : srv.error ? (
            <p role="alert" className="text-destructive">The updater did not answer: {srv.error}</p>
          ) : st?.error && !st.current ? (
            <p role="alert" className="text-destructive">{st.error}</p>
          ) : st?.checked_at ? (
            <>
              <p>
                Running <code>{short(st.deployed || st.current)}</code>
                {st.behind > 0
                  ? <> · <strong>{plural(st.behind, "commit")} behind</strong> <code>{short(st.latest)}</code></>
                  : !st.error && !rebuild && " · Up to date"}
                <span className="text-muted-foreground"> · checked {new Date(st.checked_at).toLocaleString()}</span>
              </p>
              {rebuild && (
                <p>Checkout is at <code>{short(st.current)}</code>, containers run <code>{short(st.deployed ?? "")}</code></p>
              )}
              {st.error && <p role="alert" className="text-destructive">{st.error}</p>}
              {commits.length > 0 && (
                <ul className="grid max-h-64 gap-1 overflow-y-auto text-sm">
                  {commits.map((c) => (
                    <li key={c.sha} className="flex gap-2">
                      <code className="text-muted-foreground">{short(c.sha)}</code>
                      <span className="min-w-0 flex-1 truncate">{c.subject}</span>
                      <span className="text-xs text-muted-foreground">{c.author} · {new Date(c.date).toLocaleDateString()}</span>
                    </li>
                  ))}
                </ul>
              )}
              {(st.behind > 0 || rebuild) && !jobRunning && (
                <AlertDialog>
                  <AlertDialogTrigger asChild>
                    <RefButton className="justify-self-start" disabled={busy}>
                      {st.behind > 0 ? "Update server" : "Rebuild and restart"}
                    </RefButton>
                  </AlertDialogTrigger>
                  <AlertDialogContent>
                    <AlertDialogHeader>
                      <AlertDialogTitle>{st.behind > 0 ? "Update the server?" : "Rebuild the server?"}</AlertDialogTitle>
                      <AlertDialogDescription>
                        {st.behind > 0 ? `Pulls ${plural(st.behind, "commit")}, rebuilds` : "Rebuilds"} and restarts everything.
                        Building takes a few minutes; everyone is disconnected for a moment at the end. If the pull fails
                        nothing changes. If the build fails, the old containers keep running and you can try again.
                      </AlertDialogDescription>
                    </AlertDialogHeader>
                    <AlertDialogFooter>
                      <AlertDialogCancel>Cancel</AlertDialogCancel>
                      <AlertDialogAction onClick={onUpdateServer}>{st.behind > 0 ? "Update" : "Rebuild"}</AlertDialogAction>
                    </AlertDialogFooter>
                  </AlertDialogContent>
                </AlertDialog>
              )}
            </>
          ) : (
            <p className="text-muted-foreground">Not checked yet.</p>
          )}
          {job && <JobLog job={job} />}
        </CardContent>
      </Card>

      <Card className="gap-3 py-4" aria-labelledby="yt-h">
        <CardHeader className="px-4"><h3 id="yt-h" className="text-sm font-semibold">yt-dlp</h3></CardHeader>
        <CardContent className="grid gap-3 px-4 [&>*]:min-w-0">
          {!y.available ? (
            <p className="text-muted-foreground">This server has no yt-dlp, so the music bot only plays uploaded tracks.</p>
          ) : !y.checked_at ? (
            <p className="text-muted-foreground">Not checked yet.</p>
          ) : (
            <p>
              Installed <code>{y.installed || "unknown"}</code>
              {y.latest && <> · latest <code>{y.latest}</code></>}
              {y.latest && !ytNewer && " · Up to date"}
            </p>
          )}
          {y.error && <p role="alert" className="text-destructive">{y.error}</p>}
          {y.pinned ? (
            <p className="text-muted-foreground">This binary is managed by DATROPE_YTDLP and is not updated here.</p>
          ) : ytNewer && (
            <Button className="justify-self-start" disabled={busy} onClick={onUpdateYtDlp}>Update yt-dlp</Button>
          )}
        </CardContent>
      </Card>
    </>
  );
}

function JobLog({ job }: { job: JobView }) {
  const end = useRef<HTMLSpanElement>(null);
  useEffect(() => end.current?.scrollIntoView({ block: "nearest" }), [job.lines.length]);
  const updated = job.sha ? `Updated to ${short(job.sha)}` : "Updated";
  const label = { running: "Updating…", restarting: "Restarting…", succeeded: updated, failed: "Update failed" }[job.phase];
  const busy = job.phase === "running" || job.phase === "restarting";
  return (
    <div className="grid min-w-0 gap-2">
      <p role="status" className={job.phase === "failed" ? "text-destructive" : undefined}>
        {busy && <Spinner className="mr-2 inline size-4" />}
        {job.message ?? label}
      </p>
      {job.phase === "succeeded" && (
        <div className="flex flex-wrap items-center gap-2 text-muted-foreground">
          Reload the page to load the new version.
          <Button variant="outline" size="sm" onClick={() => window.location.reload()}>Reload</Button>
        </div>
      )}
      <pre aria-label="Update log" className="max-h-80 overflow-auto rounded-md border bg-muted p-3 font-mono text-xs">
        {job.lines.join("\n")}
        <span ref={end} />
      </pre>
    </div>
  );
}