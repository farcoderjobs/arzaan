"use client";

import { useState, useRef, useCallback } from "react";
import { cn } from "@/utils/classname";
import { Search, X } from "@/components/ui/icons";

interface SearchInputProps {
  value: string;
  onChange: (value: string) => void;
  onSearch?: (value: string) => void;
  placeholder?: string;
  debounceMs?: number;
  className?: string;
  loading?: boolean;
}

export function SearchInput({
  value,
  onChange,
  onSearch,
  placeholder = "Search...",
  debounceMs = 300,
  className,
  loading,
}: SearchInputProps) {
  const [local, setLocal] = useState(value);
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);

  const scheduleSearch = useCallback(() => {
    if (timer.current) clearTimeout(timer.current);
    timer.current = setTimeout(() => {
      onSearch?.(local || "");
    }, debounceMs);
  }, [local, debounceMs, onSearch]);

  const [prevValue, setPrevValue] = useState(value);
  if (prevValue !== value) {
    setPrevValue(value);
    setLocal(value);
  }

  const handleChange = (e: React.ChangeEvent<HTMLInputElement>) => {
    const next = e.target.value;
    setLocal(next);
    onChange(next);
    if (onSearch) scheduleSearch();
  };

  const clear = () => {
    setLocal("");
    onChange("");
    if (onSearch) onSearch("");
  };

  return (
    <div className={cn("relative", className)}>
      <Search className="pointer-events-none absolute start-3 top-1/2 h-4 w-4 -translate-y-1/2 text-slate-400" />
      <input
        type="text"
        value={local}
        onChange={handleChange}
        placeholder={placeholder}
        className="w-full rounded-xl border border-slate-300 bg-white py-2.5 pe-9 ps-9 text-sm shadow-sm transition placeholder:text-slate-400 focus:border-blue-500 focus:outline-none focus:ring-2 focus:ring-blue-500/20"
      />
      {local && (
        <button
          type="button"
          onClick={clear}
          className="absolute end-2.5 top-1/2 -translate-y-1/2 rounded-md p-0.5 text-slate-400 transition hover:text-slate-600"
          aria-label="Clear search"
        >
          <X className="h-4 w-4" />
        </button>
      )}
      {loading && <span className="absolute end-3 top-1/2 h-4 w-4 -translate-y-1/2 animate-spin rounded-full border-2 border-current border-t-transparent" />}
    </div>
  );
}
