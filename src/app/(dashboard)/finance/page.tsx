import { Metadata } from "next";
import { requireSessionUser } from "@/lib/session";
import { FinanceClient } from "./finance-client";

export const metadata: Metadata = { title: "Finance" };

export default async function FinancePage() {
  const user = await requireSessionUser();
  return (
    <FinanceClient
      canViewExpenses={user.permissions.includes("expenses.view")}
      canCreateExpense={user.permissions.includes("expenses.create")}
      canUpdateExpense={user.permissions.includes("expenses.update")}
      canDeleteExpense={user.permissions.includes("expenses.delete")}
      canViewCustomerPayments={user.permissions.includes("customers.view")}
      canCreateCustomerPayment={user.permissions.includes("customers.payment")}
      canViewSupplierPayments={user.permissions.includes("suppliers.view")}
      canCreateSupplierPayment={user.permissions.includes("suppliers.payment")}
      canViewCashTransactions={user.permissions.includes("cash_register.view")}
    />
  );
}
