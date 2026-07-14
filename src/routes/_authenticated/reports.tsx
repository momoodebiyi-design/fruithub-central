import { createFileRoute } from "@tanstack/react-router";

export const Route = createFileRoute("/_authenticated/reports")({
  component: () => (
    <div className="space-y-4">
      <h1 className="text-2xl font-semibold tracking-tight">Reports</h1>
      <div className="bg-card rounded-lg ring-1 ring-black/5 p-8 text-sm text-muted-foreground">
        Advanced reports and CSV exports arrive in the next release. Basic KPIs are live on the Dashboard.
      </div>
    </div>
  ),
});
