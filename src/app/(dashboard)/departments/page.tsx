import { Metadata } from "next";
import { requireSessionUser } from "@/lib/session";
import { DepartmentsClient } from "./departments-client";

export const metadata: Metadata = { title: "Departments" };

export default async function DepartmentsPage() {
  const user = await requireSessionUser();
  const canCreate = user.permissions.includes("departments.create");
  const canUpdate = user.permissions.includes("departments.update");
  const canDeactivate = user.permissions.includes("departments.deactivate");
  return (
    <DepartmentsClient
      user={user}
      canCreate={canCreate}
      canUpdate={canUpdate}
      canDeactivate={canDeactivate}
    />
  );
}
