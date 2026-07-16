import { createFileRoute } from "@tanstack/react-router";

export const Route = createFileRoute("/_authenticated/sales")({
  component: SalesPage,
});

function SalesPage() {
  return (
    <div className="space-y-4">
      <div>
        <h1 className="text-2xl font-semibold tracking-tight">Sales orders</h1>
        <p className="text-sm text-muted-foreground mt-1">
          Customer-linked sales orders. Fulfilling an order posts stock-out movements to the ledger;
          voiding posts reversing movements instead of deleting history.
        </p>
      </div>
      <div className="rounded-lg border bg-card p-10 text-center text-sm text-muted-foreground">
        Sales orders UI coming in the next iteration. Tables and fulfil / void RPCs are already in place.
      </div>
    </div>
  );
}
