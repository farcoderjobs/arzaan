import { Metadata } from "next";
import { requireSessionUser } from "@/lib/session";
import { CustomersClient } from "./customers-client";

export const metadata: Metadata = { title: "Customers" };

export default async function CustomersPage() {
  const user = await requireSessionUser();
  return (
    <CustomersClient
      canCreate={user.permissions.includes("customers.create")}
      canUpdate={user.permissions.includes("customers.update")}
      canDelete={user.permissions.includes("customers.delete")}
      canPayment={user.permissions.includes("customers.payment")}
    />
  );
}
