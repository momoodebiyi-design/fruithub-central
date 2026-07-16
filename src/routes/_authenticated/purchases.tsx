import { createFileRoute } from "@tanstack/react-router";

export const Route = createFileRoute("/_authenticated/purchases")({
  component: PurchasesPage,
});

function PurchasesPage() {
  return (
    <div className="space-y-4">
      <div>
        <h1 className="text-2xl font-semibold tracking-tight">Purchases</h1>
        <p className="text-sm text-muted-foreground mt-1">
          Purchase orders for raw materials, packaging and consumables. Creating a PO does not
          affect stock; receiving lines posts IN movements to the ledger.
        </p>
      </div>
      <div className="rounded-lg border bg-card p-10 text-center text-sm text-muted-foreground">
        Purchases UI coming in the next iteration. Tables and receive RPC are already in place.
      </div>
    </div>
  );
}
