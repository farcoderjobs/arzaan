import { Metadata } from "next";
import { requireSessionUser } from "@/lib/session";
import { CashRegisterClient } from "./cash-register-client";

export const metadata: Metadata = { title: "Cash Register" };

export default async function CashRegisterPage() {
  const user = await requireSessionUser();
  return (
    <CashRegisterClient
      canOpen={user.permissions.includes("cash_register.open")}
      canClose={user.permissions.includes("cash_register.close")}
    />
  );
}
