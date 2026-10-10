import { useCallback, useEffect, useState } from "react";
import { Button } from "@/components/ui/button";
import { Card } from "@/components/ui/card";
import { Label } from "@/components/ui/label";
import { NativeSelect, NativeSelectOption } from "@/components/ui/native-select";
import { RadioGroup, RadioGroupItem } from "@/components/ui/radio-group";
import { Slider } from "@/components/ui/slider";
import { Switch } from "@/components/ui/switch";
import { cn } from "@/lib/utils";
import {
  captureOptions, chainOptions, setInputDevice, setInputMode, setNoise, setOutputDevice, setPttKey, setVadAuto,
  setVadThreshold, useAudioPrefs, type InputMode, type NoiseMode, type PttKey,
} from "../../voice/audio-prefs";
import { createMicTest, type Meter, type MicTest } from "../../voice/mic-processor";
import { canPickOutput } from "../../voice/output";
import { useVoice, voice } from "../../voice/voice";

type Reading = Meter & { enhancedFailed: boolean };

const modes: { value: InputMode; title: string; hint: string }[] = [
  { value: "vad", title: "Voice activity", hint: "Your mic opens when you speak louder than the sensitivity." },
  { value: "ptt", title: "Push to talk", hint: "Hold a key to talk. Works while Datrope is the active tab." },
];
const noises: { value: NoiseMode; title: string; hint: string }[] = [
  { value: "off", title: "Off", hint: "Send your mic as it is." },
  { value: "standard", title: "Standard", hint: "Built into your browser. Filters steady background noise." },
  { value: "enhanced", title: "Enhanced", hint: "Removes keyboard typing and other noise. Uses a bit more CPU." },
];

/** The browser's audio devices, refreshed when one is plugged in or out. Labels are empty until the mic is allowed. */
function useDevices() {
  const [list, setList] = useState<MediaDeviceInfo[]>([]);
  const refresh = useCallback(() => {
    navigator.mediaDevices?.enumerateDevices().then(setList, () => setList([]));
  }, []);
  useEffect(() => {
    refresh();
    navigator.mediaDevices?.addEventListener("devicechange", refresh);
    return () => navigator.mediaDevices?.removeEventListener("devicechange", refresh);
  }, [refresh]);
  const real = (kind: MediaDeviceKind) => list.filter((d) => d.kind === kind && d.deviceId !== "default" && d.deviceId !== "communications");
  return { inputs: real("audioinput"), outputs: real("audiooutput"), labelled: list.some((d) => d.label !== ""), refresh };
}

/** Reads `source` every animation frame while it is set. */
function useReading(source: (() => Reading | undefined) | undefined): Reading | undefined {
  const [reading, setReading] = useState<Reading>();
  useEffect(() => {
    if (!source) return setReading(undefined);
    let frame = 0;
    const tick = () => {
      setReading(source());
      frame = requestAnimationFrame(tick);
    };
    tick();
    return () => cancelAnimationFrame(frame);
  }, [source]);
  return reading;
}

const pct = (db: number) => `${Math.min(100, Math.max(0, db + 100))}%`;

/** The mic level, green while the mic is open, with a marker at the threshold. */
function LevelMeter({ reading, thresholdDb }: { reading?: Reading; thresholdDb?: number }) {
  const db = reading?.db ?? -100;
  return (
    <div className="relative h-2 overflow-hidden rounded-full bg-muted" role="meter" aria-label="Microphone level"
      aria-valuemin={-100} aria-valuemax={0} aria-valuenow={Math.round(db)}>
      <div className={cn("h-full transition-[width] duration-75", reading?.open ? "bg-online" : "bg-muted-foreground/40")} style={{ width: pct(db) }} />
      {thresholdDb !== undefined && <div className="absolute inset-y-0 w-0.5 bg-foreground" style={{ left: pct(thresholdDb) }} aria-hidden />}
    </div>
  );
}

const keyLabel = (e: KeyboardEvent) => (e.key === " " ? "Space" : e.key.length === 1 ? e.key.toUpperCase() : e.key);

/** A button that records the next key press as the push-to-talk key; Escape cancels. */
function KeyCapture({ value, onChange }: { value: PttKey; onChange: (k: PttKey) => void }) {
  const [listening, setListening] = useState(false);
  useEffect(() => {
    if (!listening) return;
    const onKey = (e: KeyboardEvent) => {
      e.preventDefault();
      e.stopPropagation(); // capture phase on window: Escape must not close the dialog
      if (e.code !== "Escape") onChange({ code: e.code, label: keyLabel(e) });
      setListening(false);
    };
    window.addEventListener("keydown", onKey, true);
    return () => window.removeEventListener("keydown", onKey, true);
  }, [listening, onChange]);
  return (
    <Button variant="outline" aria-label={`Push-to-talk key, ${value.label}`} onClick={() => setListening(true)} className="min-w-28">
      {listening ? "Press a key…" : value.label}
    </Button>
  );
}

function Choices<T extends string>({ name, label, value, options, onChange }: {
  name: string; label: string; value: T; options: { value: T; title: string; hint: string }[]; onChange: (v: T) => void;
}) {
  return (
    <RadioGroup aria-label={label} value={value} onValueChange={(v) => onChange(v as T)} className="gap-2">
      {options.map((o) => (
        <Label key={o.value} htmlFor={`${name}-${o.value}`}
          className={cn("flex cursor-pointer items-start gap-3 rounded-lg border p-3", value === o.value && "border-primary bg-primary/8")}>
          <RadioGroupItem id={`${name}-${o.value}`} value={o.value} className="mt-0.5" aria-labelledby={`${name}-${o.value}-title`} aria-describedby={`${name}-${o.value}-hint`} />
          <div className="grid gap-0">
            <span id={`${name}-${o.value}-title`} className="font-medium">{o.title}</span>
            <span id={`${name}-${o.value}-hint`} className="text-sm font-normal text-muted-foreground">{o.hint}</span>
          </div>
        </Label>
      ))}
    </RadioGroup>
  );
}

export function VoiceSettings() {
  const p = useAudioPrefs((s) => s);
  const inCall = useVoice((v) => v.status === "connected");
  const devices = useDevices();
  const [blocked, setBlocked] = useState(false);
  const [testing, setTesting] = useState(false);
  const [test, setTest] = useState<MicTest>();
  const [testError, setTestError] = useState<string>();
  const [monitor, setMonitor] = useState(false);
  const standard = p.noise === "standard";

  async function allow() {
    try {
      const s = await navigator.mediaDevices.getUserMedia({ audio: true });
      for (const t of s.getTracks()) t.stop();
      setBlocked(false);
      devices.refresh();
    } catch {
      setBlocked(true);
    }
  }

  // A call takes over the mic: the test doesn't come back on by itself afterwards.
  useEffect(() => {
    if (inCall) setTesting(false);
  }, [inCall]);
  // The mic test: restarted when the device or the browser's noise suppression changes, stopped on leaving.
  useEffect(() => {
    if (!testing || inCall) return;
    let current: MicTest | undefined;
    let cancelled = false;
    setTestError(undefined);
    createMicTest(captureOptions(p) as MediaTrackConstraints, chainOptions(p), p.outputDeviceId).then((t) => {
      if (cancelled) return t.stop();
      current = t;
      setTest(t);
      devices.refresh(); // names are visible now
    }, () => {
      if (cancelled) return;
      setTesting(false);
      setTestError("Couldn't start your microphone.");
    });
    return () => {
      cancelled = true;
      current?.stop();
      setTest(undefined);
    };
  }, [testing, inCall, p.inputDeviceId, p.outputDeviceId, standard]); // other options apply without a restart
  useEffect(() => test?.chain.setOptions(chainOptions(p)), [test, p]);
  useEffect(() => test?.setMonitor(monitor), [test, monitor]);

  const source = useCallback((): Reading | undefined => {
    if (inCall) return voice.micMeter();
    return test ? { ...test.chain.meter(), enhancedFailed: test.chain.enhancedFailed } : undefined;
  }, [inCall, test]);
  const reading = useReading(inCall || test ? source : undefined);
  const has = (list: MediaDeviceInfo[], id: string) => list.some((d) => d.deviceId === id);

  return (
    <>
      <Card role="region" aria-label="Devices" className="gap-3 p-4">
        <h3>Devices</h3>
        <div className="grid gap-3 sm:grid-cols-2">
          <div className="grid gap-1.5">
            <Label htmlFor="input-device">Input device</Label>
            <NativeSelect id="input-device" className="w-full" value={has(devices.inputs, p.inputDeviceId) ? p.inputDeviceId : "default"}
              onChange={(e) => setInputDevice(e.target.value)}>
              <NativeSelectOption value="default">Default</NativeSelectOption>
              {devices.inputs.map((d, i) => <NativeSelectOption key={d.deviceId} value={d.deviceId}>{d.label || `Microphone ${i + 1}`}</NativeSelectOption>)}
            </NativeSelect>
          </div>
          {canPickOutput() && (
            <div className="grid gap-1.5">
              <Label htmlFor="output-device">Output device</Label>
              <NativeSelect id="output-device" className="w-full" value={has(devices.outputs, p.outputDeviceId) ? p.outputDeviceId : "default"}
                onChange={(e) => setOutputDevice(e.target.value)}>
                <NativeSelectOption value="default">Default</NativeSelectOption>
                {devices.outputs.map((d, i) => <NativeSelectOption key={d.deviceId} value={d.deviceId}>{d.label || `Speaker ${i + 1}`}</NativeSelectOption>)}
              </NativeSelect>
            </div>
          )}
        </div>
        {!devices.labelled && !blocked && (
          <div className="flex items-center gap-3">
            <p className="m-0 grow text-sm text-muted-foreground">Allow microphone access to see your devices' names.</p>
            <Button variant="outline" size="sm" onClick={() => void allow()}>Allow microphone access</Button>
          </div>
        )}
        {blocked && <p className="m-0 text-sm text-destructive" role="alert">Microphone blocked — allow it in your browser's site settings.</p>}
      </Card>

      <Card role="region" aria-label="Input mode" className="gap-3 p-4">
        <h3>Input mode</h3>
        <Choices name="input-mode" label="Input mode" value={p.mode} options={modes} onChange={setInputMode} />
        {p.mode === "vad" ? (
          <div className="grid gap-2">
            <div className="flex items-center gap-3">
              <Label htmlFor="vad-auto" className="grow font-medium">Automatically determine input sensitivity</Label>
              <Switch id="vad-auto" checked={p.vadAuto} onCheckedChange={setVadAuto} />
            </div>
            <LevelMeter reading={reading} thresholdDb={p.vadAuto ? reading?.thresholdDb : p.vadThresholdDb} />
            <Slider aria-label="Input sensitivity" min={-100} max={0} step={1} disabled={p.vadAuto}
              value={[p.vadAuto ? Math.round(reading?.thresholdDb ?? p.vadThresholdDb) : p.vadThresholdDb]}
              onValueChange={([db]) => setVadThreshold(db)} />
          </div>
        ) : (
          <div className="grid gap-2">
            <div className="flex items-center gap-3">
              <span className="grow font-medium">Push-to-talk key</span>
              <KeyCapture value={p.pttKey} onChange={setPttKey} />
            </div>
            <LevelMeter reading={reading} />
          </div>
        )}
        {inCall ? (
          <p className="m-0 text-sm text-muted-foreground">Showing your microphone in the call.</p>
        ) : (
          <div className="flex flex-wrap items-center gap-3">
            <Button variant="outline" size="sm" onClick={() => setTesting((t) => !t)}>{testing ? "Stop checking" : "Let's check"}</Button>
            {testing && (
              <Label htmlFor="mic-monitor" className="flex items-center gap-2 font-normal">
                <Switch id="mic-monitor" checked={monitor} onCheckedChange={setMonitor} />Hear yourself (use headphones)
              </Label>
            )}
            {testError && <span className="text-sm text-destructive" role="alert">{testError}</span>}
          </div>
        )}
      </Card>

      <Card role="region" aria-label="Noise suppression" className="gap-3 p-4">
        <h3>Noise suppression</h3>
        <Choices name="noise" label="Noise suppression" value={p.noise} options={noises} onChange={setNoise} />
        {p.noise === "enhanced" && reading?.enhancedFailed && (
          <p className="m-0 text-sm text-muted-foreground" role="status">Enhanced noise suppression isn't available in this browser. Choose Standard instead.</p>
        )}
      </Card>
    </>
  );
}
