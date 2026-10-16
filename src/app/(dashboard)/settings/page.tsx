import { Metadata } from "next";
import { redirect } from "next/navigation";
import { requireSessionUser } from "@/lib/session";
import { hasPermission } from "@/lib/authorization";
import { PERMISSIONS } from "@/lib/permissions";
import { SettingsClient } from "./settings-client";

export const metadata: Metadata = { title: "Settings" };

export default async function SettingsPage() {
  const user = await requireSessionUser();
  if (!(await hasPermission(user, PERMISSIONS.settings.view))) {
    redirect("/dashboard");
  }
  const canManage = await hasPermission(user, PERMISSIONS.settings.manage);
  return <SettingsClient canManage={canManage} />;
}
