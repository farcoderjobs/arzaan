"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import { Button, Input, Select, FormField } from "@/components/ui";
import { PageHeader, Breadcrumbs } from "@/components/layout";
import { success, error } from "@/utils/toast";
import { apiErrorMessage } from "@/lib/api";
import { cn } from "@/utils/classname";

type AttendanceStatus = "absent" | "leave" | "rest" | "holiday";

interface RecordRow {
  dateKey: string;
  status: AttendanceStatus;
  note: string;
}

interface EmployeeAttendance {
  _id: string;
  name: string;
  email: string;
  records: RecordRow[];
  summary: {
    absentDays: number;
    leaveDays: number;
    restDays: number;
    weeklyRestDays: number;
    scheduledDays: number;
    unpaidAbsenceDays: number;
  };
}

interface AttendancePayload {
  period: string;
  days: string[];
  weeklyRestDates: string[];
  policy: { weeklyRestDay: number; allowanceDays: number };
  canManage: boolean;
  branch: { _id: string; name: string };
  branches: Array<{ _id: string; name: string }>;
  employees: EmployeeAttendance[];
}

function currentPeriod(): string {
  const now = new Date();
  return `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, "0")}`;
}

const WEEKDAYS = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];

export function AttendanceClient() {
  const [period, setPeriod] = useState(currentPeriod());
  const [branchId, setBranchId] = useState("");
  const [employeeId, setEmployeeId] = useState("");
  const [data, setData] = useState<AttendancePayload | null>(null);
  const [loading, setLoading] = useState(true);
  const [savingKey, setSavingKey] = useState<string | null>(null);
  const [note, setNote] = useState("");

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const params = new URLSearchParams({ period });
      if (branchId) params.set("branchId", branchId);
      if (employeeId) params.set("userId", employeeId);
      const res = await fetch(`/api/attendance?${params}`);
      const body = await res.json();
      if (!res.ok) {
        error("Error", apiErrorMessage(body, "Failed to load attendance"));
        return;
      }
      setData(body as AttendancePayload);
      if (!branchId && body.branch?._id) setBranchId(body.branch._id);
      if (!employeeId && body.employees?.[0]?._id) setEmployeeId(body.employees[0]._id);
    } catch {
      error("Error", "Failed to load attendance");
    } finally {
      setLoading(false);
    }
  }, [period, branchId, employeeId]);

  useEffect(() => {
    void (async () => {
      await load();
    })();
  }, [load]);

  const employee = useMemo(
    () => data?.employees.find((e) => e._id === employeeId) ?? data?.employees[0] ?? null,
    [data, employeeId]
  );

  const recordMap = useMemo(() => {
    const map = new Map<string, RecordRow>();
    for (const record of employee?.records ?? []) map.set(record.dateKey, record);
    return map;
  }, [employee]);

  const mark = async (dateKey: string, status: AttendanceStatus | "present") => {
    if (!employee) return;
    const key = `${employee._id}:${dateKey}`;
    setSavingKey(key);
    try {
      const res =
        status === "present"
          ? await fetch("/api/attendance", {
              method: "POST",
              headers: { "Content-Type": "application/json" },
              body: JSON.stringify({ action: "clear", userId: employee._id, date: dateKey }),
            })
          : await fetch("/api/attendance", {
              method: "POST",
              headers: { "Content-Type": "application/json" },
              body: JSON.stringify({ action: "mark", userId: employee._id, date: dateKey, status, note }),
            });
      const body = await res.json();
      if (!res.ok) {
        error("Error", apiErrorMessage(body, "Failed to save attendance"));
        return;
      }
      success("Saved", typeof body?.message === "string" ? body.message : "Attendance saved");
      setNote("");
      await load();
    } catch {
      error("Error", "Failed to save attendance");
    } finally {
      setSavingKey(null);
    }
  };

  return (
    <div className="mx-auto max-w-6xl">
      <Breadcrumbs items={[{ label: "Attendance" }]} />
      <PageHeader
        title="Attendance"
        description="Present by default. Mark absences and corrections here; every change is audited."
        actions={
          <Button variant="secondary" onClick={() => void load()} loading={loading}>
            Refresh
          </Button>
        }
      />

      <div className="mb-6 grid gap-3 rounded-xl border border-slate-200 bg-white p-4 sm:grid-cols-2 lg:grid-cols-4">
        <FormField label="Month">
          <Input type="month" value={period} onChange={(e) => setPeriod(e.target.value)} />
        </FormField>
        <FormField label="Shop">
          <Select
            value={branchId}
            onChange={(v) => {
              setBranchId(v);
              setEmployeeId("");
            }}
            options={(data?.branches ?? []).map((b) => ({ value: b._id, label: b.name }))}
          />
        </FormField>
        <FormField label="Employee">
          <Select
            value={employee?._id ?? ""}
            onChange={setEmployeeId}
            options={(data?.employees ?? []).map((e) => ({ value: e._id, label: e.name }))}
          />
        </FormField>
        <FormField label="Note for the next change">
          <Input value={note} onChange={(e) => setNote(e.target.value)} placeholder="e.g. sick, informed by phone" />
        </FormField>
      </div>

      {data ? (
        <p className="mb-4 text-sm text-slate-600">
          Weekly rest day: <strong>{WEEKDAYS[data.policy.weeklyRestDay]}</strong> · Non-penalty absence allowance:{" "}
          <strong>{data.policy.allowanceDays} days</strong> · Unpaid absence days this month:{" "}
          <strong>{employee?.summary.unpaidAbsenceDays ?? 0}</strong>
        </p>
      ) : null}

      <div className="overflow-x-auto rounded-xl border border-slate-200 bg-white">
        <table className="w-full border-collapse text-sm">
          <thead>
            <tr className="border-b border-slate-200 bg-slate-50">
              <th className="px-4 py-3 text-start text-[11px] font-semibold uppercase tracking-wider text-slate-500">Day</th>
              <th className="px-4 py-3 text-start text-[11px] font-semibold uppercase tracking-wider text-slate-500">Status</th>
              <th className="px-4 py-3 text-start text-[11px] font-semibold uppercase tracking-wider text-slate-500">Note</th>
              <th className="px-4 py-3 text-end text-[11px] font-semibold uppercase tracking-wider text-slate-500">Mark</th>
            </tr>
          </thead>
          <tbody>
            {(data?.days ?? []).map((dateKey) => {
              const date = new Date(`${dateKey}T00:00:00`);
              const isWeeklyRest = data?.weeklyRestDates.includes(dateKey) ?? false;
              const record = recordMap.get(dateKey);
              const status: AttendanceStatus | "present" = record?.status ?? "present";
              const key = `${employee?._id}:${dateKey}`;
              return (
                <tr key={dateKey} className={cn("border-b border-slate-100", isWeeklyRest && "bg-slate-50/70")}>
                  <td className="px-4 py-2.5">
                    <span className="font-medium text-slate-800">{dateKey.slice(8)}</span>{" "}
                    <span className="text-xs text-slate-500">{WEEKDAYS[date.getDay()]}</span>
                    {isWeeklyRest ? <span className="ms-2 text-xs text-slate-400">weekly rest</span> : null}
                  </td>
                  <td className="px-4 py-2.5">
                    <span
                      className={cn(
                        "rounded-full px-2 py-0.5 text-xs font-medium",
                        status === "present"
                          ? "bg-emerald-100 text-emerald-700"
                          : status === "absent"
                            ? "bg-red-100 text-red-700"
                            : status === "leave"
                              ? "bg-blue-100 text-blue-700"
                              : "bg-slate-200 text-slate-700"
                      )}
                    >
                      {status}
                    </span>
                  </td>
                  <td className="px-4 py-2.5 text-xs text-slate-500">{record?.note || "—"}</td>
                  <td className="px-4 py-2.5">
                    <div className="flex flex-wrap justify-end gap-1">
                      {data?.canManage ? (
                        <>
                          <Button size="sm" variant="secondary" disabled={savingKey === key} onClick={() => void mark(dateKey, "absent")}>
                            Absent
                          </Button>
                          <Button size="sm" variant="secondary" disabled={savingKey === key} onClick={() => void mark(dateKey, "leave")}>
                            Leave
                          </Button>
                          <Button size="sm" variant="ghost" disabled={savingKey === key || status === "present"} onClick={() => void mark(dateKey, "present")}>
                            Present
                          </Button>
                        </>
                      ) : (
                        <span className="text-xs text-slate-400">read-only</span>
                      )}
                    </div>
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>

      {employee ? (
        <div className="mt-4 grid gap-3 sm:grid-cols-4">
          <div className="rounded-xl border border-slate-200 bg-white p-4">
            <p className="text-xs uppercase text-slate-500">Absent</p>
            <p className="text-lg font-semibold">{employee.summary.absentDays}</p>
          </div>
          <div className="rounded-xl border border-slate-200 bg-white p-4">
            <p className="text-xs uppercase text-slate-500">Approved leave</p>
            <p className="text-lg font-semibold">{employee.summary.leaveDays}</p>
          </div>
          <div className="rounded-xl border border-slate-200 bg-white p-4">
            <p className="text-xs uppercase text-slate-500">Scheduled days</p>
            <p className="text-lg font-semibold">{employee.summary.scheduledDays}</p>
          </div>
          <div className="rounded-xl border border-slate-200 bg-white p-4">
            <p className="text-xs uppercase text-slate-500">Penalized absence</p>
            <p className="text-lg font-semibold">{employee.summary.unpaidAbsenceDays}</p>
          </div>
        </div>
      ) : null}
    </div>
  );
}
