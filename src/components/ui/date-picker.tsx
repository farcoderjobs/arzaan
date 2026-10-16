"use client";

import { cn } from "@/utils/classname";
import * as React from "react";

interface DatePickerProps {
  value?: string;
  onChange: (value: string) => void;
  label?: string;
  error?: string;
  placeholder?: string;
  min?: string;
  max?: string;
  className?: string;
}

export function DatePicker({
  value,
  onChange,
  label,
  error,
  placeholder,
  min,
  max,
  className,
}: DatePickerProps) {
  return (
    <div>
      {label && <label className="mb-1 block text-sm font-medium text-slate-700">{label}</label>}
      <input
        type="date"
        value={value ?? ""}
        onChange={(e) => onChange(e.target.value)}
        placeholder={placeholder}
        min={min}
        max={max}
        className={cn(
          "w-full rounded-lg border border-slate-300 bg-white px-3 py-2 text-sm shadow-sm transition focus:border-blue-500 focus:outline-none focus:ring-2 focus:ring-blue-500 focus:ring-offset-1",
          error ? "border-red-500" : "focus:border-slate-400",
          className
        )}
      />
      {error && <p className="mt-1 text-sm text-red-600">{error}</p>}
    </div>
  );
}
