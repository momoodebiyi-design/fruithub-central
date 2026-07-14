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

export const CAN_MANAGE_SHOPS: AppRole[] = [
  "super_admin",
  "management",
  "operations_manager",
];

export const CAN_DISPATCH: AppRole[] = [
  "super_admin",
  "management",
  "operations_manager",
  "inventory_officer",
];

export const CAN_APPROVE_REQUESTS: AppRole[] = [
  "super_admin",
  "management",
  "operations_manager",
  "inventory_officer",
];

export function hasAny(userRoles: AppRole[], allowed: AppRole[]): boolean {
  return userRoles.some((r) => allowed.includes(r));
}

