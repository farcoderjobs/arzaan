import { Metadata } from "next";
import { requireSessionUser } from "@/lib/session";
import { hasPermission } from "@/lib/authorization";
import { PERMISSIONS } from "@/lib/permissions";
import { redirect } from "next/navigation";
import { SyncClient } from "./sync-client";

export const metadata: Metadata = { title: "Sync Center" };

/**
 * Sync Center — the shop node's link to the online center.
 *
 * Everything shown here lives in the LOCAL database: pending changes, retry
 * attempts, conflicts and run history. Viewing requires sales.view; syncing and
 * retrying require sales.create; the full re-push (recovery after a center
 * restore) requires settings.manage.
 */
export default async function SyncPage() {
  const user = await requireSessionUser();
  if (!(await hasPermission(user, PERMISSIONS.sales.view))) {
    redirect("/dashboard");
  }
  const canSync = await hasPermission(user, PERMISSIONS.sales.create);
  const canManage = await hasPermission(user, PERMISSIONS.settings.manage);
  return <SyncClient canSync={canSync} canManage={canManage} />;
}
