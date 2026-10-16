import { Metadata } from "next";
import { requireSessionUser } from "@/lib/session";
import { SuppliersClient } from "./suppliers-client";

export const metadata: Metadata = { title: "Suppliers" };

export default async function SuppliersPage() {
  const user = await requireSessionUser();
  const canCreate = user.permissions.includes("suppliers.create");
  const canDelete = user.permissions.includes("suppliers.delete");
  return <SuppliersClient user={user} canCreate={canCreate} canDelete={canDelete} />;
}
