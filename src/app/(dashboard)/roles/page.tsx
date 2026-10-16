import { Metadata } from "next";
import { requireSessionUser } from "@/lib/session";
import { hasPermission } from "@/lib/authorization";
import { PERMISSIONS } from "@/lib/permissions";
import { RolesClient } from "./roles-client";

export const metadata: Metadata = { title: "Roles" };

export default async function RolesPage() {
  const user = await requireSessionUser();
  const canManage = await hasPermission(user, PERMISSIONS.roles.manage);
  return <RolesClient canManage={canManage} />;
}
