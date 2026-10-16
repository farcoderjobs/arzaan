import { Metadata } from "next";
import { requireSessionUser } from "@/lib/session";
import { CategoriesClient } from "./categories-client";

export const metadata: Metadata = { title: "Categories" };

export default async function CategoriesPage() {
  const user = await requireSessionUser();
  const canCreate = user.permissions.includes("categories.create");
  const canDelete = user.permissions.includes("categories.delete");
  return <CategoriesClient user={user} canCreate={canCreate} canDelete={canDelete} />;
}
