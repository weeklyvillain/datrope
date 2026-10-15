import { SignalHigh, SignalLow, SignalMedium, SignalZero, type AnimatedIcon } from "@/components/icons";
import { useShallow } from "zustand/react/shallow";
import { voiceMembers } from "@datrope/core";
import { RefButton } from "@/components/ref-button";
import { UserAvatar } from "@/components/user-avatar";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { useUser } from "@/hooks/use-user";
import { cn } from "@/lib/utils";
import { useApp, userName } from "../../session";
import { estimateToYou, usePeerPing } from "../../voice/pings";
import type { Rating, Sample } from "../../voice/stats";
import { useVoice } from "../../voice/voice";
import { SignalBars } from "./SignalBars";

const LOOK: Record<Rating, { icon: AnimatedIcon; color: string; word: string }> = {
  good: { icon: SignalHigh, color: "text-online hover:text-online", word: "good" },
  ok: { icon: SignalMedium, color: "text-idle hover:text-idle", word: "okay" },
  poor: { icon: SignalLow, color: "text-destructive hover:text-destructive", word: "poor" },
  unknown: { icon: SignalZero, color: "text-muted-foreground", word: "measuring" },
};

/** Signal bars for my connection to the voice server; the popover has the last 30 s and the others' pings. */
export function ConnectionQuality() {
  const q = useVoice((v) => v.quality);
  const look = LOOK[q.rating];
  const Icon = look.icon;
  const ping = q.rttMs === undefined ? "" : `, ${Math.round(q.rttMs)} ms ping`;
  return (
    <Popover>
      <PopoverTrigger asChild>
        <RefButton variant="ghost" size="icon-sm" aria-label={`Connection quality: ${look.word}${ping}`} className={look.color}>
          <Icon />
        </RefButton>
      </PopoverTrigger>
      <PopoverContent className="w-80 p-3">
        <QualityPanel />
      </PopoverContent>
    </Popover>
  );
}

const METRICS: { key: keyof Sample; label: string; show: (v: number) => string }[] = [
  { key: "rttMs", label: "Ping", show: (v) => `${Math.round(v)} ms` },
  { key: "jitterMs", label: "Jitter", show: (v) => `${Math.round(v)} ms` },
  { key: "lossPct", label: "Packet loss", show: (v) => `${v.toFixed(1)} %` },
];

/** Mounted only while the popover is open: `history` changes every second. */
function QualityPanel() {
  const q = useVoice((v) => v.quality);
  const history = useVoice((v) => v.history);
  const channelId = useVoice((v) => v.channelId);
  const me = useApp((s) => s.me?.id);
  const others = useApp(useShallow((s) => (channelId ? voiceMembers(s, channelId) : []).filter((v) => v.user_id !== me).map((v) => v.user_id)));
  const look = LOOK[q.rating];
  const mine = q.rttMs === undefined ? undefined : Math.round(q.rttMs);
  return (
    <Tabs defaultValue="you">
      <TabsList>
        <TabsTrigger value="you">You</TabsTrigger>
        <TabsTrigger value="others">Others · {others.length}</TabsTrigger>
      </TabsList>
      <TabsContent value="you" className="grid gap-2">
        <p className="m-0 flex items-baseline gap-2">
          <span className={cn("text-2xl font-bold", look.color)}>{look.word[0].toUpperCase() + look.word.slice(1)}</span>
          {mine !== undefined && <span className="text-xs text-muted-foreground">{mine} ms to server</span>}
        </p>
        {METRICS.map(({ key, label, show }) => {
          const v = q[key];
          return (
            <div key={key} className="grid gap-1">
              <div className="flex items-baseline justify-between text-xs">
                <span className="text-muted-foreground">{label}</span>
                <span className="font-semibold tabular-nums">{v === undefined ? "—" : show(v)}</span>
              </div>
              <SignalBars values={history.map((s) => s[key])} metric={key} />
            </div>
          );
        })}
        <p className="m-0 text-xs text-muted-foreground">Last 30 seconds · connection to the voice server</p>
      </TabsContent>
      <TabsContent value="others">
        {others.length === 0 ? (
          <p className="m-0 py-2 text-sm text-muted-foreground">Nobody else is here yet</p>
        ) : (
          <ul className="m-0 grid list-none gap-1 p-0">
            {others.map((id) => <PeerRow key={id} userId={id} mine={mine} />)}
          </ul>
        )}
      </TabsContent>
    </Tabs>
  );
}

function PeerRow({ userId, mine }: { userId: string; mine?: number }) {
  const peer = usePeerPing(userId);
  const name = useApp((s) => userName(s, userId));
  const user = useUser(userId);
  return (
    <li className="flex items-center gap-2 py-1 text-sm">
      <UserAvatar user={user ?? { id: userId, username: name }} size="sm" />
      <span className="min-w-0 flex-1 truncate">{name}</span>
      <span className="text-xs text-muted-foreground tabular-nums">
        {peer === undefined ? "measuring…" : mine === undefined ? `${peer} ms` : `${peer} ms · ≈${estimateToYou(peer, mine)} ms to you`}
      </span>
    </li>
  );
}
