import { createFileRoute, Outlet } from "@tanstack/react-router";
import { ShopOperationsPaused } from "@/components/ShopOperationsPaused";
import { SHOP_STOCK_WORKFLOWS_ENABLED } from "@/lib/features";

export const Route = createFileRoute("/_authenticated/shop-counts")({
  component: () => (SHOP_STOCK_WORKFLOWS_ENABLED ? <Outlet /> : <ShopOperationsPaused />),
});
