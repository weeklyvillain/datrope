import type { Category } from "@datrope/core";
import { useState } from "react";
import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { ErrorText } from "@/components/error-text";
import { FormField } from "@/components/form-field";
import { useSubmit } from "@/hooks/use-submit";
import { client } from "../../session";

/** Creates a category, or renames `category` when given. */
export function CategoryDialog({ category, onClose }: { category?: Category; onClose: () => void }) {
  const [name, setName] = useState(category?.name ?? "");
  const { busy, error, run } = useSubmit();
  return (
    <Dialog open onOpenChange={(open) => !open && onClose()}>
      <DialogContent aria-describedby={undefined} className="sm:max-w-[420px]">
        <DialogHeader>
          <DialogTitle>{category ? "Rename category" : "Create category"}</DialogTitle>
        </DialogHeader>
        <form className="grid gap-3" onSubmit={(e) => {
          e.preventDefault();
          void run(async () => {
            if (category) client.apply("CATEGORY_UPDATE", await client.updateCategory(category.id, { name }));
            else client.apply("CATEGORY_CREATE", await client.createCategory(name));
            onClose();
          });
        }}>
          <FormField label="Name" value={name} onChange={(e) => setName(e.target.value)} required maxLength={100} autoFocus />
          <ErrorText error={error} />
          <DialogFooter>
            <Button type="submit" disabled={busy}>{category ? "Save" : "Create"}</Button>
            <Button variant="outline" onClick={onClose}>Cancel</Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}

/** Confirms deleting a category; its channels move out of it. */
export function DeleteCategoryDialog({ category, onClose }: { category: Category; onClose: () => void }) {
  const { busy, error, run } = useSubmit();
  return (
    <Dialog open onOpenChange={(open) => !open && onClose()}>
      <DialogContent className="sm:max-w-[420px]">
        <DialogHeader>
          <DialogTitle>Delete category</DialogTitle>
          <DialogDescription>{`Delete ${category.name}? Its channels move out of the category.`}</DialogDescription>
        </DialogHeader>
        <ErrorText error={error} />
        <DialogFooter>
          <Button variant="destructive" disabled={busy} onClick={() => void run(async () => {
            await client.deleteCategory(category.id);
            client.apply("CATEGORY_DELETE", { id: category.id });
            onClose();
          })}>Delete</Button>
          <Button variant="outline" onClick={onClose}>Cancel</Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
