import type { PresenceStatus } from "@datrope/core";
import { Plus, X } from "lucide-react";
import { useId, useRef, useState } from "react";
import { Button } from "@/components/ui/button";
import { Card } from "@/components/ui/card";
import { ErrorText } from "@/components/error-text";
import { Field, FieldLabel } from "@/components/ui/field";
import { Input } from "@/components/ui/input";
import { FormField } from "@/components/form-field";
import { NativeSelect, NativeSelectOption } from "@/components/ui/native-select";
import { Textarea } from "@/components/ui/textarea";
import { UserAvatar } from "@/components/user-avatar";
import { useSubmit } from "@/hooks/use-submit";
import { avatarColor } from "@/lib/avatar-color";
import { isHttpsLink } from "@/lib/social";
import { choosePresence, client, roleColor, useApp } from "../../session";
import { ProfileCard } from "../people/ProfileCard";
import { AvatarCropDialog } from "./AvatarCropDialog";
import { checkAvatarFile, checkBannerFile } from "./avatar";

const ABOUT_MAX = 190;
const LINKS_MAX = 5;
const LINK_MAX_LENGTH = 200;

/** The trimmed, non-empty links, or an error when one is not a full https:// link. */
function cleanLinks(links: string[]): string[] {
  const out = links.map((l) => l.trim()).filter(Boolean);
  if (out.some((l) => Array.from(l).length > LINK_MAX_LENGTH || !isHttpsLink(l))) throw new Error("Use a full https:// link");
  return out;
}

/** Limits to `max` characters (code points), not UTF-16 units. */
const limit = (v: string, max: number) => Array.from(v).slice(0, max).join("");

/** Your profile: avatar, text fields and a live preview of the card others see. */
export function ProfileSettings() {
  const statusId = useId();
  const aboutId = useId();
  const me = useApp((s) => s.me);
  const presence = useApp((s) => s.presence);
  const [name, setName] = useState(me?.display_name ?? "");
  const [pronouns, setPronouns] = useState(me?.pronouns ?? "");
  const [customStatus, setCustomStatus] = useState(me?.custom_status ?? "");
  const [about, setAbout] = useState(me?.about_me ?? "");
  const [links, setLinks] = useState<string[]>(me?.links ?? []);
  const [file, setFile] = useState<File>();
  const [bannerFile, setBannerFile] = useState<File>();
  const [fileError, setFileError] = useState<string>();
  const [bannerError, setBannerError] = useState<string>();
  const input = useRef<HTMLInputElement>(null);
  const bannerInput = useRef<HTMLInputElement>(null);
  const sv = useApp((s) => s.server);
  const [saved, setSaved] = useState(false);
  const save = useSubmit();
  const remove = useSubmit();
  const removeBanner = useSubmit();

  if (!me) return null;
  return (
    <div className="grid gap-6 min-[760px]:grid-cols-[minmax(0,1fr)_300px]">
      <Card role="region" aria-label="Profile" className="gap-3 p-4">
        <h3>Profile</h3>
        <div className="grid gap-1">
          <div className="aspect-[3/1] w-full max-w-sm overflow-hidden rounded-md" style={{ background: roleColor(sv, me.id) ?? avatarColor(me.id) }}>
            {me.banner_url && <img src={client.url(me.banner_url)} alt="" className="size-full object-cover" />}
          </div>
          <div className="flex flex-wrap items-center gap-2">
            <Button size="sm" variant="outline" onClick={() => bannerInput.current?.click()}>Change banner</Button>
            {me.banner_url && (
              <Button size="sm" variant="ghost" disabled={removeBanner.busy} onClick={() => void removeBanner.run(async () => { await client.removeBanner(); })}>Remove banner</Button>
            )}
            <span className="text-xs text-muted-foreground">PNG, JPEG, WebP or GIF, up to 5 MB.</span>
          </div>
          <input ref={bannerInput} type="file" hidden accept="image/png,image/jpeg,image/webp,image/gif" aria-label="Choose a banner image"
            onChange={(e) => {
              const f = e.target.files?.[0];
              e.target.value = "";
              if (!f) return;
              const problem = checkBannerFile(f);
              setBannerError(problem ?? undefined);
              if (!problem) setBannerFile(f);
            }} />
        </div>
        <ErrorText error={bannerError} />
        <ErrorText error={removeBanner.error} />
        <div className="flex items-center gap-4">
          <UserAvatar user={me} size="xl" />
          <div className="grid gap-1">
            <div className="flex gap-2">
              <Button size="sm" variant="outline" onClick={() => input.current?.click()}>Change avatar</Button>
              {me.avatar_url && (
                <Button size="sm" variant="ghost" disabled={remove.busy} onClick={() => void remove.run(async () => { await client.removeAvatar(); })}>Remove</Button>
              )}
            </div>
            <span className="text-xs text-muted-foreground">PNG, JPEG, WebP or GIF, up to 2 MB.</span>
          </div>
          <input ref={input} type="file" hidden accept="image/png,image/jpeg,image/webp,image/gif" aria-label="Choose an avatar image"
            onChange={(e) => {
              const f = e.target.files?.[0];
              e.target.value = "";
              if (!f) return;
              const problem = checkAvatarFile(f);
              setFileError(problem ?? undefined);
              if (!problem) setFile(f);
            }} />
        </div>
        <ErrorText error={fileError} />
        <ErrorText error={remove.error} />
        <form className="grid gap-3" noValidate onSubmit={(e) => {
          e.preventDefault();
          setSaved(false);
          void save.run(async () => {
            const clean = cleanLinks(links);
            await client.updateMe({ display_name: name, pronouns, custom_status: customStatus, about_me: about, links: clean });
            setLinks(clean);
            setSaved(true);
            setTimeout(() => setSaved(false), 2500);
          });
        }}>
          <div className="flex flex-wrap gap-2">
            <FormField className="w-auto min-w-48 flex-1" label="Display name" value={name} onChange={(e) => setName(limit(e.target.value, 32))} required />
            <FormField className="w-auto min-w-48 flex-1" label="Pronouns" placeholder="they/them" value={pronouns} onChange={(e) => setPronouns(limit(e.target.value, 40))} />
          </div>
          <FormField label="Custom status" placeholder="What are you up to?" value={customStatus} onChange={(e) => setCustomStatus(limit(e.target.value, 80))} />
          <Field>
            <FieldLabel htmlFor={aboutId}>About me</FieldLabel>
            <Textarea id={aboutId} value={about} aria-describedby={`${aboutId}-count`}
              onChange={(e) => setAbout(limit(e.target.value, ABOUT_MAX))} />
            <span id={`${aboutId}-count`} className="text-right text-xs text-muted-foreground">{Array.from(about).length} / {ABOUT_MAX}</span>
          </Field>
          <fieldset className="grid gap-2 border-0 p-0">
            <legend className="mb-1 p-0 text-sm font-medium">Links</legend>
            {links.map((l, i) => (
              <div key={i} className="flex items-center gap-2">
                <Input aria-label={`Link ${i + 1}`} type="url" inputMode="url" placeholder="https://" value={l}
                  onChange={(e) => setLinks(links.map((x, j) => (j === i ? e.target.value : x)))} />
                <Button type="button" size="icon" variant="ghost" aria-label={`Remove link ${i + 1}`}
                  onClick={() => setLinks(links.filter((_, j) => j !== i))}><X aria-hidden /></Button>
              </div>
            ))}
            {links.length < LINKS_MAX && (
              <Button type="button" size="sm" variant="outline" className="w-fit" onClick={() => setLinks([...links, ""])}><Plus aria-hidden />Add link</Button>
            )}
          </fieldset>
          <Field>
            <FieldLabel htmlFor={statusId}>Status</FieldLabel>
            <NativeSelect id={statusId} value={presence} onChange={(e) => choosePresence(e.target.value as PresenceStatus)}>
              <NativeSelectOption value="online">Online</NativeSelectOption>
              <NativeSelectOption value="idle">Idle</NativeSelectOption>
              <NativeSelectOption value="invisible">Invisible (appear offline)</NativeSelectOption>
            </NativeSelect>
          </Field>
          <ErrorText error={save.error} />
          <div className="flex items-center gap-3">
            <Button type="submit" disabled={save.busy}>Save</Button>
            <span role="status" className="text-sm text-muted-foreground">{saved ? "Saved" : ""}</span>
          </div>
        </form>
      </Card>

      <div className="grid content-start gap-2">
        <p className="m-0 text-xs font-semibold uppercase tracking-wide text-muted-foreground">Preview</p>
        <div className="overflow-hidden rounded-xl border bg-popover">
          <ProfileCard variant="popover" userId={me.id} preview={{ display_name: name, pronouns, custom_status: customStatus, about_me: about, links }} />
        </div>
        <p className="m-0 text-xs text-muted-foreground">The banner takes your highest role colour, or your initials colour if you have no coloured role.</p>
      </div>

      {file && <AvatarCropDialog file={file} onClose={() => setFile(undefined)} onDone={() => setFile(undefined)} />}
      {bannerFile && <AvatarCropDialog file={bannerFile} kind="banner" onClose={() => setBannerFile(undefined)} onDone={() => setBannerFile(undefined)} />}
    </div>
  );
}
