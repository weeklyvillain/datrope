import { NotesPane } from "./notes/NotesPane";
import { ReminderList } from "./reminders/ReminderList";

const HEADING = "flex-none px-4 pt-3 text-xs font-semibold tracking-wide text-muted-foreground uppercase";

/** The sidebar's Me tab: what I keep for myself, my reminders above my notes. */
export function MePane({ noteId }: { noteId?: string }) {
  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <section aria-labelledby="me-reminders" className="flex max-h-[40%] flex-none flex-col border-b">
        <h2 id="me-reminders" className={HEADING}>Reminders</h2>
        <ReminderList />
      </section>
      <section aria-labelledby="me-notes" className="flex min-h-0 flex-1 flex-col">
        <h2 id="me-notes" className={HEADING}>Notes</h2>
        <NotesPane activeId={noteId} />
      </section>
    </div>
  );
}
