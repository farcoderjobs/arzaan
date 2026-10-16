"use client";

import { useEffect, useState, useCallback } from "react";
import type { Toast } from "@/lib/api";
import { onToast } from "@/utils/toast";
import { cn } from "@/utils/classname";

function ToastItem({ toast, onDismiss }: { toast: Toast; onDismiss: () => void }) {
  useEffect(() => {
    if (toast.duration && toast.duration > 0) {
      const id = setTimeout(onDismiss, toast.duration);
      return () => clearTimeout(id);
    }
  }, [toast.duration, onDismiss]);

  const colors: Record<string, string> = {
    success: "border-green-500 bg-green-50 text-green-800",
    error: "border-red-500 bg-red-50 text-red-800",
    warning: "border-amber-500 bg-amber-50 text-amber-800",
    info: "border-blue-500 bg-blue-50 text-blue-800",
  };

  return (
    <div className={cn("flex items-start gap-3 rounded-lg border p-4 shadow-md transition-all", colors[toast.type] || "")}>
      <div className="mt-0.5 flex h-6 w-6 shrink-0 items-center justify-center rounded-full text-sm font-bold">
        {toast.type === "success" && "✓"}
        {toast.type === "error" && "✕"}
        {toast.type === "warning" && "⚠"}
        {toast.type === "info" && "i"}
      </div>
      <div className="flex-1">
        <p className="font-semibold">{toast.title}</p>
        {toast.message && <p className="mt-1 text-sm opacity-80">{toast.message}</p>}
      </div>
      <button onClick={onDismiss} className="cursor-pointer text-current opacity-60 hover:opacity-100">
        ✕
      </button>
    </div>
  );
}

export function ToastContainer() {
  const [toasts, setToasts] = useState<Toast[]>([]);

  const add = useCallback((t: Toast) => setToasts((prev) => [...prev, t]), []);
  const remove = useCallback((id: string) => setToasts((prev) => prev.filter((t) => t.id !== id)), []);

  // Subscribe to the toast emitter — without this, toast() calls notify
  // nobody and every success/error message is silently dropped.
  useEffect(() => onToast(add), [add]);

  return (
    <div className="fixed bottom-4 right-4 z-50 flex max-h-96 w-96 flex-col gap-2 overflow-auto">
      {toasts.map((t) => (
        <ToastItem key={t.id} toast={t} onDismiss={() => remove(t.id)} />
      ))}
    </div>
  );
}
