import type { ReactNode } from "react";
import { AppearanceSettings } from "./AppearanceSettings";
import { ConnectionsSettings } from "./ConnectionsSettings";
import { NotificationSettings } from "./NotificationSettings";
import { ProfileSettings } from "./ProfileSettings";
import { SessionsSettings } from "./SessionsSettings";
import { VoiceSettings } from "./VoiceSettings";
import { SECTION_META, visibleSections as visible, type SectionMeta } from "./sections-meta";

export type Section = SectionMeta & { body: () => ReactNode };
export { GROUPS, type Group } from "./sections-meta";

const BODIES: Record<Section["id"], () => ReactNode> = {
  profile: () => <ProfileSettings />,
  connections: () => <ConnectionsSettings />,
  sessions: () => <SessionsSettings />,
  notifications: () => <NotificationSettings />,
  voice: () => <VoiceSettings />,
  appearance: () => <AppearanceSettings />,
};

export const SECTIONS: Section[] = SECTION_META.map((m) => ({ ...m, body: BODIES[m.id] }));
export const visibleSections = (me: { guest: boolean; admin: boolean }): Section[] => visible(me, SECTIONS);
