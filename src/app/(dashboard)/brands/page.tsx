import { Metadata } from "next";
import { requireSessionUser } from "@/lib/session";
import { BrandsClient } from "./brands-client";

export const metadata: Metadata = { title: "Brands" };

export default async function BrandsPage() {
  const user = await requireSessionUser();
  const canCreate = user.permissions.includes("brands.create");
  const canDelete = user.permissions.includes("brands.delete");
  return <BrandsClient user={user} canCreate={canCreate} canDelete={canDelete} />;
}
