import { Children, forwardRef, type ComponentProps, type ReactNode } from "react";
import { ProfilePopover } from "./ProfilePopover";

const MentionButton = forwardRef<HTMLButtonElement, ComponentProps<"button">>((props, ref) => (
  <button ref={ref} type="button" {...props} />
));
MentionButton.displayName = "MentionButton";

/** An `@name` mention (`children`) that opens that person's profile popover. `me` keeps the `data-me` styling hook.
 */
export function MentionTrigger({ userId, me, children }: { userId: string; me?: boolean; children?: ReactNode }) {
  // Someone who left the server is not in the store: the mention text still names them.
  const name = Children.toArray(children).filter((c) => typeof c === "string").join("").replace(/^@/, "");
  return (
    <ProfilePopover userId={userId} fallback={{ id: userId, username: name, display_name: "", custom_status: "" }}>
      <MentionButton className="mention" data-me={me ? "" : undefined}>{children}</MentionButton>
    </ProfilePopover>
  );
}
