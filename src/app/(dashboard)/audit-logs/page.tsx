import { Metadata } from "next";
import { requireSessionUser } from "@/lib/session";
import { hasPermission } from "@/lib/authorization";
import { PERMISSIONS } from "@/lib/permissions";
import { redirect } from "next/navigation";
import { AuditLogsClient } from "./audit-logs-client";

export const metadata: Metadata = { title: "Audit Logs" };

export default async function AuditLogsPage() {
  const user = await requireSessionUser();
  if (!(await hasPermission(user, PERMISSIONS.auditLogs.view))) {
    redirect("/dashboard");
  }
  return <AuditLogsClient />;
}
