import { createFileRoute } from "@tanstack/react-router";

export const Route = createFileRoute("/_authenticated/procurement")({
  component: () => <Placeholder title="Procurement" note="Purchase orders and supplier management arrive in the next release." />,
});
export const Route2 = null;

function Placeholder({ title, note }: { title: string; note: string }) {
  return (
    <div className="space-y-4">
      <h1 className="text-2xl font-semibold tracking-tight">{title}</h1>
      <div className="bg-card rounded-lg ring-1 ring-black/5 p-8 text-sm text-muted-foreground">{note}</div>
    </div>
  );
}
