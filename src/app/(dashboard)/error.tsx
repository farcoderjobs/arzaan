"use client";

import { useEffect } from "react";
import { databaseUnavailableMessage, isDatabaseUnavailable } from "@/lib/db-errors";

/**
 * Segment error boundary for the whole dashboard.
 *
 * Server components that talk to MongoDB throw here when the database is not
 * running. Showing a plain, actionable screen (instead of Next.js's generic
 * error page, or a /login redirect loop) is what keeps an offline shop
 * understandable: the local server is up, only its database needs starting.
 */
export default function DashboardError({
  error,
  reset,
}: {
  error: Error & { digest?: string };
  reset: () => void;
}) {
  const offline = isDatabaseUnavailable(error);
  const localStartExample = 'mongod --dbpath "C:\\\\data\\\\db" --replSet rs0';

  useEffect(() => {
    console.error("[dashboard] render failed", error);
  }, [error]);

  return (
    <div className="mx-auto flex min-h-[60vh] max-w-xl flex-col items-center justify-center text-center">
      <span className="mb-4 flex h-12 w-12 items-center justify-center rounded-full bg-amber-100 text-2xl">
        {offline ? "🗄️" : "⚠️"}
      </span>
      <h1 className="text-xl font-semibold text-slate-900">
        {offline ? "Local database is offline" : "This page could not load"}
      </h1>
      <p className="mt-2 text-sm text-slate-600">
        {offline ? databaseUnavailableMessage() : error.message || "An unexpected error occurred."}
      </p>
      {offline && (
        <pre className="mt-4 w-full overflow-x-auto rounded-lg bg-slate-900 px-4 py-3 text-start text-xs text-slate-100">
          {localStartExample}
        </pre>
      )}
      <button
        onClick={reset}
        className="mt-6 rounded-lg bg-blue-600 px-4 py-2 text-sm font-semibold text-white hover:bg-blue-700"
      >
        Try again
      </button>
    </div>
  );
}
