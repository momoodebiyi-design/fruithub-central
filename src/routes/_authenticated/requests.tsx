import { createFileRoute, redirect } from "@tanstack/react-router";

// Preserve old bookmarks while keeping Replenishment as the only operational name.
export const Route = createFileRoute("/_authenticated/requests")({
  beforeLoad: () => {
    throw redirect({ to: "/replenishment" });
  },
});
