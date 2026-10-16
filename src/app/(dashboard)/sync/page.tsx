import { Metadata } from "next";
import { requireSessionUser } from "@/lib/session";
import { hasPermission } from "@/lib/authorization";
import { PERMISSIONS } from "@/lib/permissions";
import { redirect } from "next/navigation";
import { SyncClient } from "./sync-client";

export const metadata: Metadata = { title: "Sync Center" };

/**
 * Sync Center — shows the offline queue (IndexedDB) and lets authorized
 * users force/retry synchronization. Viewing requires sales.view; acting
 * (sync now / retry) requires sales.create.
 */
export default async function SyncPage() {
  const user = await requireSessionUser();
  if (!(await hasPermission(user, PERMISSIONS.sales.view))) {
    redirect("/dashboard");
  }
  const canSync = await hasPermission(user, PERMISSIONS.sales.create);
  return <SyncClient canSync={canSync} />;
}
