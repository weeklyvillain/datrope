import { useState } from "react";
import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { addServer } from "./rail-api";

export function AddServerForm({ onAdded }: { onAdded: () => void }) {
  const [address, setAddress] = useState("");
  const [error, setError] = useState<string>();
  const [busy, setBusy] = useState(false);

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    setBusy(true);
    setError(undefined);
    try {
      await addServer(address);
      setAddress("");
      onAdded();
    } catch (err) {
      setError(typeof err === "string" ? err : "Couldn't add the server.");
    } finally {
      setBusy(false);
    }
  }

  return (
    <form onSubmit={(e) => void submit(e)} className="grid gap-3">
      <div className="grid gap-1.5">
        <Label htmlFor="server-address">Server address</Label>
        <Input id="server-address" autoFocus placeholder="chat.example.com" value={address}
          onChange={(e) => setAddress(e.target.value)} aria-invalid={!!error} aria-describedby={error ? "server-address-error" : undefined} />
        {error && <p id="server-address-error" role="alert" className="m-0 text-sm text-destructive">{error}</p>}
      </div>
      <Button type="submit" disabled={busy || !address.trim()}>{busy ? "Checking…" : "Add server"}</Button>
    </form>
  );
}

export function AddServerDialog({ open, onOpenChange }: { open: boolean; onOpenChange: (open: boolean) => void }) {
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-sm">
        <DialogHeader>
          <DialogTitle>Add a server</DialogTitle>
          <DialogDescription>Enter the address of a Datrope server. You sign in on the next screen.</DialogDescription>
        </DialogHeader>
        <AddServerForm onAdded={() => onOpenChange(false)} />
      </DialogContent>
    </Dialog>
  );
}
