"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import { money } from "@/lib/currency";
import { Table, EmptyState, Button, Input, Select, FormField } from "@/components/ui";
import { PageHeader, Breadcrumbs } from "@/components/layout";
import { error } from "@/utils/toast";
import { apiErrorMessage } from "@/lib/api";
import { cn } from "@/utils/classname";

interface ReportRow {
  key: string;
  name: string;
  grossSales: number;
  discounts: number;
  returns: number;
  netSales: number;
  cogs: number;
  profit: number;
  transactions: number;
  returnsCount: number;
  unassigned: boolean;
}

interface ReportPayload {
  summary: {
    grossSales: number;
    discounts: number;
    returns: number;
    netSales: number;
    netRevenue: number;
    cogs: number;
    profit: number;
    transactions: number;
    returnsCount: number;
  };
  rows: ReportRow[];
  sources: Array<{
    source: string;
    departmentName: string;
    quantity: number;
    revenue: number;
    cogs: number;
    profit: number;
  }>;
}

interface DepartmentOption {
  _id: string;
  name: string;
  employeeId: string | null;
}

interface EmployeeOption {
  _id: string;
  name: string;
}

function isoDate(value: Date): string {
  return value.toISOString().slice(0, 10);
}

export function DepartmentReportClient() {
  const today = useMemo(() => new Date(), []);
  const monthStart = useMemo(() => new Date(today.getFullYear(), today.getMonth(), 1), [today]);

  const [from, setFrom] = useState(isoDate(monthStart));
  const [to, setTo] = useState(isoDate(today));
  const [groupBy, setGroupBy] = useState("department");
  const [branchId, setBranchId] = useState("");
  const [branches, setBranches] = useState<Array<{ _id: string; name: string }>>([]);
  const [departmentId, setDepartmentId] = useState("");
  const [employeeId, setEmployeeId] = useState("");
  const [source, setSource] = useState("");
  const [departments, setDepartments] = useState<DepartmentOption[]>([]);
  const [employees, setEmployees] = useState<EmployeeOption[]>([]);
  const [loading, setLoading] = useState(true);
  const [report, setReport] = useState<ReportPayload | null>(null);

  useEffect(() => {
    const loadFilters = async () => {
      try {
        const res = await fetch("/api/departments?all=1");
        if (!res.ok) return;
        const data = await res.json();
        setDepartments(data.departments ?? []);
        setEmployees(data.employees ?? []);
        setBranches(data.branches ?? []);
      } catch {
        // filters are optional — the report still loads
      }
    };
    void loadFilters();
  }, []);

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const params = new URLSearchParams({ from, to, groupBy });
      if (branchId) params.set("branchId", branchId);
      if (departmentId) params.set("departmentId", departmentId);
      if (employeeId) params.set("employeeId", employeeId);
      if (source) params.set("source", source);
      const res = await fetch(`/api/reports/departments?${params}`);
      const data = await res.json();
      if (!res.ok) {
        error("Error", apiErrorMessage(data, "Failed to load the department report"));
        return;
      }
      setReport(data as ReportPayload);
    } catch {
      error("Error", "Failed to load the department report");
    } finally {
      setLoading(false);
    }
  }, [from, to, groupBy, branchId, departmentId, employeeId, source]);

  useEffect(() => {
    void (async () => {
      await load();
    })();
  }, [load]);

  const summary = report?.summary;

  const cards = [
    { label: "Gross sales", value: summary?.grossSales ?? 0 },
    { label: "Discounts", value: summary?.discounts ?? 0 },
    { label: "Returns", value: summary?.returns ?? 0 },
    { label: "Net sales", value: summary?.netSales ?? 0 },
    { label: "COGS", value: summary?.cogs ?? 0 },
    { label: "Profit", value: summary?.profit ?? 0 },
  ];

  const columns = [
    {
      key: "name",
      header: groupBy === "department" ? "Department" : groupBy === "employee" ? "Employee" : groupBy === "product" ? "Product" : "Day",
      render: (row: ReportRow) => (
        <span className={cn("font-medium", row.unassigned ? "text-amber-700" : "text-slate-900")}>
          {row.name}
          {row.unassigned ? <span className="ms-2 rounded-full bg-amber-100 px-2 py-0.5 text-[10px] uppercase">unassigned</span> : null}
        </span>
      ),
    },
    { key: "transactions", header: "Sales", render: (row: ReportRow) => row.transactions },
    { key: "gross", header: "Gross", render: (row: ReportRow) => money(row.grossSales) },
    { key: "discounts", header: "Discounts", render: (row: ReportRow) => money(row.discounts) },
    { key: "returns", header: "Returns", render: (row: ReportRow) => money(row.returns) },
    { key: "net", header: "Net sales", render: (row: ReportRow) => money(row.netSales) },
    { key: "cogs", header: "COGS", render: (row: ReportRow) => money(row.cogs) },
    {
      key: "profit",
      header: "Profit",
      render: (row: ReportRow) => (
        <span className={row.profit < 0 ? "text-red-600" : "font-medium text-emerald-700"}>{money(row.profit)}</span>
      ),
    },
  ];

  return (
    <div className="mx-auto max-w-6xl">
      <Breadcrumbs items={[{ label: "Reports", href: "/reports" }, { label: "Departments" }]} />
      <PageHeader
        title="Department report"
        description="Sales, discounts, returns and profit by department, employee, product or day."
        actions={
          <Button variant="secondary" onClick={() => void load()} loading={loading}>
            Refresh
          </Button>
        }
      />

      <div className="mb-5 rounded-xl border border-blue-200 bg-blue-50 p-4 text-xs text-slate-700">
        <p className="font-semibold text-slate-900">How each department is calculated</p>
        <ul className="mt-1 list-disc space-y-0.5 ps-4">
          <li>Every sold product line is credited to the department set on that product (Products → Department).</li>
          <li>Sale-level discounts, tax and the employee benefit are split across the lines by net value, so the department rows add up to the shop totals above.</li>
          <li>A returned product reduces the department that sold it; a line with no product department falls back to the cashier&apos;s department, otherwise it is shown as Unassigned.</li>
        </ul>
      </div>

      <div className="mb-6 grid gap-3 rounded-xl border border-slate-200 bg-white p-4 sm:grid-cols-2 lg:grid-cols-4 xl:grid-cols-7">
        <FormField label="From">
          <Input type="date" value={from} onChange={(e) => setFrom(e.target.value)} />
        </FormField>
        <FormField label="To">
          <Input type="date" value={to} onChange={(e) => setTo(e.target.value)} />
        </FormField>
        <FormField label="Group by">
          <Select
            value={groupBy}
            onChange={setGroupBy}
            options={[
              { value: "department", label: "Department" },
              { value: "employee", label: "Employee" },
              { value: "product", label: "Product" },
              { value: "day", label: "Day" },
            ]}
          />
        </FormField>
        <FormField label="Shop">
          <Select
            value={branchId}
            onChange={(v) => {
              setBranchId(v);
              setDepartmentId("");
              setEmployeeId("");
            }}
            options={[{ value: "", label: "All shops" }, ...branches.map((b) => ({ value: b._id, label: b.name }))]}
          />
        </FormField>
        <FormField label="Department">
          <Select
            value={departmentId}
            onChange={(v) => {
              setDepartmentId(v);
              const dept = departments.find((d) => d._id === v);
              setEmployeeId(dept?.employeeId ?? "");
            }}
            options={[{ value: "", label: "All departments" }, ...departments.map((d) => ({ value: d._id, label: d.name }))]}
          />
        </FormField>
        <FormField label="Employee">
          <Select
            value={employeeId}
            onChange={setEmployeeId}
            options={[{ value: "", label: "All employees" }, ...employees.map((e) => ({ value: e._id, label: e.name }))]}
          />
        </FormField>
        <FormField label="Purchase source">
          <Select
            value={source}
            onChange={setSource}
            options={[
              { value: "", label: "All stock" },
              { value: "import", label: "Import (China)" },
              { value: "local", label: "Local" },
            ]}
          />
        </FormField>
      </div>

      <div className="mb-6 grid gap-3 sm:grid-cols-2 lg:grid-cols-6">
        {cards.map((card) => (
          <div key={card.label} className="rounded-xl border border-slate-200 bg-white p-4">
            <p className="text-xs font-medium uppercase tracking-wide text-slate-500">{card.label}</p>
            <p className="mt-1 text-lg font-semibold text-slate-900">{money(card.value)}</p>
          </div>
        ))}
      </div>

      <Table
        columns={columns}
        data={report?.rows ?? []}
        keyExtractor={(row) => row.key}
        loading={loading}
        empty={<EmptyState label="No sales in this range" description="Adjust the dates or filters." />}
      />

      {report && report.sources.length > 0 ? (
        <div className="mt-6">
          <h2 className="mb-2 text-sm font-semibold text-slate-700">Purchase-source breakdown</h2>
          <Table
            columns={[
              {
                key: "source",
                header: "Source",
                render: (row: { source: string }) => (row.source === "import" ? "Import (China)" : "Local"),
              },
              {
                key: "department",
                header: "Department",
                render: (row: { departmentName: string }) => row.departmentName || "Shop",
              },
              { key: "quantity", header: "Units", render: (row: { quantity: number }) => row.quantity },
              { key: "revenue", header: "Revenue", render: (row: { revenue: number }) => money(row.revenue) },
              { key: "profit", header: "Profit", render: (row: { profit: number }) => money(row.profit) },
            ]}
            data={report.sources}
            keyExtractor={(row) => `${row.source}:${row.departmentName}`}
          />
          <p className="mt-2 text-xs text-slate-500">
            Item-level view: revenue is before sale-level discounts, so it never double counts a sale.
          </p>
        </div>
      ) : null}
    </div>
  );
}
