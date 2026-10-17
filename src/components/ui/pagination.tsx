"use client";

import { cn } from "@/utils/classname";
import * as React from "react";

export function ChevronLeft({ className, size = 20, ...props }: { className?: string; size?: number }) {
  return (
    <svg className={cn("h-5 w-5", className)} fill="none" viewBox="0 0 24 24" stroke="currentColor" {...props}>
      <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M15 19l-7-7 7-7" />
    </svg>
  );
}

export function ChevronRight({ className, size = 20, ...props }: { className?: string; size?: number }) {
  return (
    <svg className={cn("h-5 w-5", className)} fill="none" viewBox="0 0 24 24" stroke="currentColor" {...props}>
      <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M9 5l7 7-7 7" />
    </svg>
  );
}

interface PaginationProps {
  page: number;
  totalPages: number;
  totalItems: number;
  itemsPerPage: number;
  onPageChange: (page: number) => void;
  className?: string;
  showPerPage?: boolean;
  perPageOptions?: number[];
}

export function Pagination({
  page,
  totalPages,
  totalItems,
  itemsPerPage,
  onPageChange,
  className,
  showPerPage = false,
  perPageOptions = [10, 20, 50],
}: PaginationProps) {
  const pages = React.useMemo(() => {
    const arr: Array<number | "..."> = [];
    let start = Math.max(1, page - 2);
    let end = Math.min(totalPages, page + 2);

    if (end - start < 4) {
      if (start === 1) end = Math.min(totalPages, start + 4);
      else start = Math.max(1, end - 4);
    }

    for (let i = 1; i <= totalPages; i++) {
      if (i === start || (i >= start && i <= end)) {
        arr.push(i);
      } else if (arr[arr.length - 1] !== "...") {
        arr.push("...");
      }
    }
    return arr;
  }, [page, totalPages]);

  return (
    <div className={cn("flex flex-col-reverse gap-3 sm:flex-row sm:items-center sm:justify-between", className)}>
      <div className="flex flex-wrap items-center gap-2 text-xs text-slate-500 sm:text-sm">
        <span>
          Showing {(page - 1) * itemsPerPage + 1}–{Math.min(page * itemsPerPage, totalItems)} of {totalItems}
        </span>
        {showPerPage && (
          <select
            value={itemsPerPage}
            onChange={(e) => {
              const newPer = Number(e.target.value);
              const newPage = Math.min(page, Math.ceil(totalItems / newPer) || 1);
              onPageChange(newPage);
            }}
            className="rounded-lg border border-slate-300 bg-white px-2 py-1 text-xs focus:outline-none focus:ring-2 focus:ring-blue-500/30 sm:text-sm"
          >
            {perPageOptions.map((opt) => (
              <option key={opt} value={opt}>
                {opt} per page
              </option>
            ))}
          </select>
        )}
      </div>

      <nav className="flex items-center justify-center gap-0.5 self-center sm:justify-end" aria-label="Pagination">
        <button
          onClick={() => onPageChange(Math.max(1, page - 1))}
          disabled={page <= 1}
          className="rounded-lg p-1.5 text-sm transition hover:bg-slate-100 disabled:cursor-not-allowed disabled:opacity-40"
          aria-label="Previous page"
        >
          <ChevronLeft className="h-4 w-4" />
        </button>

        {pages.map((p, i) =>
          p === "..." ? (
            <span key={`ellipsis-${i}`} className="px-1.5 text-slate-400">
              …
            </span>
          ) : (
            <button
              key={p}
              onClick={() => onPageChange(p as number)}
              aria-current={p === page ? "page" : undefined}
              className={cn(
                "min-w-8 rounded-lg px-2 py-1 text-sm font-medium transition",
                p === page
                  ? "bg-blue-600 text-white shadow-sm"
                  : "text-slate-600 hover:bg-slate-100"
              )}
            >
              {p}
            </button>
          )
        )}

        <button
          onClick={() => onPageChange(Math.min(totalPages, page + 1))}
          disabled={page >= totalPages}
          className="rounded-lg p-1.5 text-sm transition hover:bg-slate-100 disabled:cursor-not-allowed disabled:opacity-40"
          aria-label="Next page"
        >
          <ChevronRight className="h-4 w-4" />
        </button>
      </nav>
    </div>
  );
}
