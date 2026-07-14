import { createFileRoute } from "@tanstack/react-router";

export const Route = createFileRoute("/_authenticated/events")({
  component: () => (
    <div className="space-y-4">
      <h1 className="text-2xl font-semibold tracking-tight">Events</h1>
      <div className="bg-card rounded-lg ring-1 ring-black/5 p-8 text-sm text-muted-foreground">
        Event planning, tasks, and post-event reporting arrive in the next release.
      </div>
    </div>
  ),
});
