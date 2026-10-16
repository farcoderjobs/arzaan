import { Metadata } from "next";
import { redirect } from "next/navigation";
import { requireSessionUser } from "@/lib/session";
import { hasPermission } from "@/lib/authorization";
import { PERMISSIONS } from "@/lib/permissions";

export const metadata: Metadata = { title: "Permissions" };

/**
 * The permission matrix lives in /roles. /permissions redirects there so both
 * URLs resolve to the same matrix UI.
 */
export default async function PermissionsPage() {
  const user = await requireSessionUser();
  if (!(await hasPermission(user, PERMISSIONS.roles.view))) {
    redirect("/dashboard");
  }
  redirect("/roles");
}
