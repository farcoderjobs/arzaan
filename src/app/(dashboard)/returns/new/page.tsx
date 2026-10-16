import { Metadata } from "next";
import { requireSessionUser } from "@/lib/session";
import { redirect } from "next/navigation";
import { NewReturnClient } from "./new-return-client";

export const metadata: Metadata = { title: "New Return" };

export default async function NewReturnPage() {
  const user = await requireSessionUser();
  if (!user.permissions.includes("sales.refund")) {
    redirect("/returns");
  }
  return <NewReturnClient />;
}
