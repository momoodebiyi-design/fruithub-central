import { createFileRoute } from "@tanstack/react-router";

export const Route = createFileRoute("/_authenticated/recipes")({
  component: RecipesPage,
});

function RecipesPage() {
  return (
    <div className="space-y-4">
      <div>
        <h1 className="text-2xl font-semibold tracking-tight">Recipes / BOM</h1>
        <p className="text-sm text-muted-foreground mt-1">
          Draft BOM framework. Ingredient quantities and yields will be filled in and approved before
          production is allowed to auto-deduct stock. This module is being built out next.
        </p>
      </div>
      <div className="rounded-lg border bg-card p-10 text-center text-sm text-muted-foreground">
        Recipes UI coming in the next iteration. Schema and approval RPC are already in place.
      </div>
    </div>
  );
}
