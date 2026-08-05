import { Lock, Factory } from "lucide-react";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";

export function ShopOperationsPaused() {
  return (
    <div className="max-w-2xl space-y-4">
      <div>
        <h1 className="text-2xl font-semibold tracking-tight">Shop stock tools paused</h1>
        <p className="text-sm text-muted-foreground mt-1">
          Daily counts and replenishment are temporarily unavailable during the factory-first pilot.
        </p>
      </div>
      <Card>
        <CardHeader>
          <CardTitle className="text-base flex items-center gap-2">
            <Lock className="size-4 text-brand-orange" /> Why this is paused
          </CardTitle>
        </CardHeader>
        <CardContent className="space-y-3 text-sm text-muted-foreground">
          <p>
            Shop balances cannot be trusted until sales automatically reduce stock through the
            planned point-of-sale workflow. Existing history is preserved for audit purposes.
          </p>
          <p className="flex items-start gap-2 text-foreground">
            <Factory className="size-4 mt-0.5 text-brand-orange shrink-0" />
            Factory inventory, production, dispatches, returns, purchasing and reports remain
            available.
          </p>
        </CardContent>
      </Card>
    </div>
  );
}
