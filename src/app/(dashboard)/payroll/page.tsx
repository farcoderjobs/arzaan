import { Metadata } from "next";
import { requireSessionUser } from "@/lib/session";
import { redirect } from "next/navigation";
import { PayrollClient } from "./payroll-client";

export const metadata: Metadata = { title: "Payroll" };

export default async function PayrollPage() {
  const user = await requireSessionUser();
  if (!user.permissions.includes("payroll.view")) redirect("/dashboard");
  return <PayrollClient canManage={user.permissions.includes("payroll.manage")} />;
}
