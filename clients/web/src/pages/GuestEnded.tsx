import { AuthLayout, ServerShowcase } from "./AuthLayout";
import { useServerPreview } from "./use-server-preview";

/** Where a guest lands when their access ends (expired, kicked or banned). */
export function GuestEnded() {
  const preview = useServerPreview();
  return (
    <AuthLayout title="Your guest access has ended" aside={<ServerShowcase preview={preview} />}>
      <p className="text-muted-foreground">Thanks for visiting. Ask for a new invite if you'd like to come back.</p>
    </AuthLayout>
  );
}
