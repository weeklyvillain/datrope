import { AuthLayout } from "./AuthLayout";

/** Where a guest lands when their access ends (expired, kicked or banned). */
export function GuestEnded() {
  return (
    <AuthLayout title="Your guest access has ended">
      <p className="text-muted-foreground">Thanks for visiting. Ask for a new invite if you'd like to come back.</p>
    </AuthLayout>
  );
}
