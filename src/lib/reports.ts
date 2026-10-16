import { NextResponse } from "next/server";

/** Shared helpers for report API routes. */

export type ReportRange = { from: Date; to: Date };

/** Parses ?period=day|week|month|custom or ?from/&to into an inclusive UTC range. Defaults to the last 30 days. */
export function parseReportRange(searchParams: URLSearchParams): ReportRange {
  const period = searchParams.get("period")?.trim() ?? "";
  const now = new Date();

  if (period === "day") {
    const from = new Date(now);
    from.setUTCHours(0, 0, 0, 0);
    return { from, to: now };
  }
  if (period === "week") {
    const from = new Date(now);
    from.setUTCDate(from.getUTCDate() - 6);
    from.setUTCHours(0, 0, 0, 0);
    return { from, to: now };
  }
  if (period === "month") {
    const from = new Date(now);
    from.setUTCDate(1);
    from.setUTCHours(0, 0, 0, 0);
    return { from, to: now };
  }

  const fromParam = searchParams.get("from")?.trim() ?? "";
  const toParam = searchParams.get("to")?.trim() ?? "";
  if (fromParam || toParam) {
    const from = fromParam ? new Date(fromParam) : new Date(0);
    const to = toParam ? new Date(`${toParam}T23:59:59.999Z`) : now;
    if (!Number.isNaN(from.getTime()) && !Number.isNaN(to.getTime())) {
      return { from, to };
    }
  }

  const fallbackFrom = new Date(now);
  fallbackFrom.setUTCDate(fallbackFrom.getUTCDate() - 29);
  fallbackFrom.setUTCHours(0, 0, 0, 0);
  return { from: fallbackFrom, to: now };
}

export function parsePage(searchParams: URLSearchParams): { page: number; perPage: number; skip: number } {
  const page = Math.max(1, Number(searchParams.get("page") ?? 1));
  const perPage = Math.min(200, Math.max(1, Number(searchParams.get("perPage") ?? 15)));
  return { page, perPage, skip: (page - 1) * perPage };
}

/** Safe date window for $match on a timestamp field. */
export function dateWindow(range: ReportRange, field = "createdAt") {
  return { [field]: { $gte: range.from, $lte: range.to } };
}

export function escapeRegex(input: string): string {
  return input.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/** Streams a CSV response with BOM for Excel compatibility. */
export function csvResponse(filename: string, rows: Array<Array<string | number>>): NextResponse {
  const escapeCell = (v: string | number) => {
    const s = String(v ?? "");
    return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
  };
  const body = rows.map((row) => row.map(escapeCell).join(",")).join("\r\n");
  return new NextResponse("\uFEFF" + body, {
    headers: {
      "Content-Type": "text/csv; charset=utf-8",
      "Content-Disposition": `attachment; filename="${filename}"`,
    },
  });
}

/** Groups documents into UTC day buckets via $dateToString. */
export function dayGroup(sumFields: Array<{ field: string; alias: string }>, countAlias = "count") {
  const group: Record<string, unknown> = {
    _id: { $dateToString: { format: "%Y-%m-%d", date: "$createdAt" } },
    [countAlias]: { $sum: 1 },
  };
  for (const f of sumFields) group[f.alias] = { $sum: f.field };
  return { $group: group };
}

// NOTE: the approved-returns (refund) aggregation helpers live in
// `@/lib/report-returns` — this module stays free of mongoose/model imports
// because the pure-function unit tests import it directly.

