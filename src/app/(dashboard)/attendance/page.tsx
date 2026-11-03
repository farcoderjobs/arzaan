import { Metadata } from "next";
import { requireSessionUser } from "@/lib/session";
import { redirect } from "next/navigation";
import { AttendanceClient } from "./attendance-client";

export const metadata: Metadata = { title: "Attendance" };

export default async function AttendancePage() {
  const user = await requireSessionUser();
  if (!user.permissions.includes("attendance.view")) redirect("/dashboard");
  return <AttendanceClient />;
}
