export type AppRole =
  | "super_admin"
  | "management"
  | "operations_manager"
  | "production"
  | "inventory_officer"
  | "procurement"
  | "admin"
  | "event_team"
  | "sales"
  | "shop_supervisor"
  | "readonly";

export const ROLE_LABELS: Record<AppRole, string> = {
  super_admin: "Super Admin",
  management: "Management",
  operations_manager: "Operations Manager",
  production: "Production",
  inventory_officer: "Inventory Officer",
  procurement: "Procurement",
  admin: "Admin",
  event_team: "Event Team",
  sales: "Sales",
  shop_supervisor: "Shop Supervisor",
  readonly: "Read-only",
};

export const ALL_ROLES: AppRole[] = [
  "super_admin",
  "admin",
  "management",
  "operations_manager",
  "inventory_officer",
  "procurement",
  "production",
  "event_team",
  "sales",
  "shop_supervisor",
  "readonly",
];

export const CAN_WRITE_INVENTORY: AppRole[] = [
  "super_admin",
  "admin",
  "management",
  "operations_manager",
  "inventory_officer",
];

export const CAN_RECORD_PRODUCTION: AppRole[] = [
  "super_admin",
  "admin",
  "management",
  "operations_manager",
  "production",
];

export const CAN_MANAGE_USERS: AppRole[] = ["super_admin", "admin"];
export const CAN_VIEW_AUDIT: AppRole[] = [
  "super_admin",
  "admin",
  "management",
  "operations_manager",
];

export const CAN_MANAGE_SHOPS: AppRole[] = ["super_admin", "management", "operations_manager"];

export const CAN_MANAGE_CLIENTS: AppRole[] = [
  "super_admin",
  "management",
  "operations_manager",
  "sales",
];

export const CAN_MANAGE_ASSORTMENT: AppRole[] = [
  "super_admin",
  "management",
  "operations_manager",
  "inventory_officer",
];

export const CAN_DISPATCH: AppRole[] = [
  "super_admin",
  "management",
  "operations_manager",
  "inventory_officer",
  "sales",
];

export const CAN_APPROVE_REQUESTS: AppRole[] = [
  "super_admin",
  "management",
  "operations_manager",
  "inventory_officer",
];

export const CAN_VIEW_ALL_SHOP_COUNTS: AppRole[] = [
  "super_admin",
  "admin",
  "management",
  "operations_manager",
  "inventory_officer",
  "production",
  "procurement",
];

export const CAN_MANAGE_SALES: AppRole[] = [
  "super_admin",
  "admin",
  "management",
  "operations_manager",
  "sales",
];
export const CAN_MANAGE_PURCHASES: AppRole[] = [
  "super_admin",
  "admin",
  "management",
  "operations_manager",
  "procurement",
];
export const CAN_REVIEW_PURCHASE_NEEDS: AppRole[] = [
  "super_admin",
  "management",
  "operations_manager",
  "inventory_officer",
];
export const CAN_APPROVE_PURCHASES: AppRole[] = ["super_admin", "management"];
export const CAN_RECEIVE_PURCHASES: AppRole[] = [
  "super_admin",
  "management",
  "operations_manager",
  "inventory_officer",
];
export const CAN_VIEW_PURCHASING: AppRole[] = Array.from(
  new Set([...CAN_MANAGE_PURCHASES, ...CAN_RECEIVE_PURCHASES]),
);
export const CAN_VIEW_REPORTS: AppRole[] = [
  "super_admin",
  "admin",
  "management",
  "operations_manager",
  "inventory_officer",
  "production",
  "procurement",
  "sales",
];
export const CAN_MANAGE_RECIPES: AppRole[] = [
  "super_admin",
  "admin",
  "management",
  "operations_manager",
  "production",
];
export const CAN_APPROVE_RECIPES: AppRole[] = ["super_admin", "management", "operations_manager"];
export const CAN_ADJUST_STOCK: AppRole[] = [
  "super_admin",
  "management",
  "operations_manager",
  "inventory_officer",
];

export const CAN_APPROVE_STOCKTAKES: AppRole[] = [
  "super_admin",
  "management",
  "operations_manager",
];

export function hasAny(userRoles: AppRole[], allowed: AppRole[]): boolean {
  return userRoles.some((r) => allowed.includes(r));
}

/** True if the user is only a shop supervisor (no elevated roles). */
export function isShopSupervisorOnly(roles: AppRole[]): boolean {
  return roles.length > 0 && roles.every((r) => r === "shop_supervisor");
}
