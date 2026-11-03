import { Metadata } from "next";
import { redirect } from "next/navigation";
import { requireSessionUser } from "@/lib/session";

import { EmployeePurchasesClient } from "./employee-purchases-client";

export const metadata: Metadata = { title: "Employee purchases" };

export default async function EmployeePurchasesPage() {
  const user = await requireSessionUser();
  if (
    !user.permissions.includes("employee_purchases.view") &&
    !user.permissions.includes("payroll.view")
  ) {
    redirect("/dashboard");
  }
  return <EmployeePurchasesClient />;
}
