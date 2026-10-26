import { AlarmClock } from "@/components/icons";
import { SidePanel } from "../side-panel/SidePanel";
import { ReminderList } from "./ReminderList";

/** My pending reminders in the side panel. */
export function RemindersPanel({ onClose }: { onClose: () => void }) {
  return (
    <SidePanel title="Reminders" icon={<AlarmClock />} onClose={onClose}>
      <ReminderList />
    </SidePanel>
  );
}
