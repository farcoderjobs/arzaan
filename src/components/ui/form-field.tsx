"use client";

import { forwardRef, useId } from "react";
import { cn } from "@/utils/classname";

interface FieldProps {
  label?: string;
  error?: string;
  hint?: string;
  required?: boolean;
  children: React.ReactNode;
}

export const FormField = forwardRef<HTMLDivElement, FieldProps>(
  function FormField({ label, error, hint, required, children, ...rest }, ref) {
    const id = useId();
    return (
      <div ref={ref} {...rest}>
        {label && (
          <label htmlFor={id} className="mb-1.5 block text-sm font-medium text-slate-700">
            {label}
            {required && <span className="ms-1 text-red-500">*</span>}
          </label>
        )}
        {children}
        {error && <p className="mt-1 text-sm text-red-600">{error}</p>}
        {hint && !error && <p className="mt-1 text-xs text-slate-500">{hint}</p>}
      </div>
    );
  }
);

const CONTROL_CLASS =
  "w-full rounded-xl border border-slate-300 bg-white px-3 py-2.5 text-sm shadow-sm transition placeholder:text-slate-400 focus:border-blue-500 focus:outline-none focus:ring-2 focus:ring-blue-500/20 disabled:cursor-not-allowed disabled:bg-slate-50 disabled:text-slate-500";

interface InputProps extends React.InputHTMLAttributes<HTMLInputElement> {
  error?: string;
}

export const Input = forwardRef<HTMLInputElement, InputProps>(function Input({ className, error, ...props }, ref) {
  return (
    <input
      ref={ref}
      className={cn(
        CONTROL_CLASS,
        error ? "border-red-500 focus:border-red-500 focus:ring-red-500/20" : "",
        className
      )}
      {...props}
    />
  );
});

interface SelectProps extends Omit<React.SelectHTMLAttributes<HTMLSelectElement>, "onChange" | "value"> {
  error?: string;
  options: Array<{ value: string; label: string }>;
  placeholder?: string;
  value?: string;
  /** Called with the selected option value (not the raw event). */
  onChange?: (value: string) => void;
}

export const Select = forwardRef<HTMLSelectElement, SelectProps>(function Select({ className, error, options, placeholder, value, onChange, disabled, ...props }, ref) {
  return (
    <select
      ref={ref}
      value={value ?? ""}
      disabled={disabled}
      onChange={onChange ? (e) => onChange(e.target.value) : undefined}
      className={cn(
        CONTROL_CLASS,
        error ? "border-red-500 focus:border-red-500 focus:ring-red-500/20" : "",
        className
      )}
      {...props}
    >
      {placeholder && <option value="">{placeholder}</option>}
      {options.map((opt) => (
        <option key={opt.value} value={opt.value}>
          {opt.label}
        </option>
      ))}
    </select>
  );
});

interface TextareaProps extends React.TextareaHTMLAttributes<HTMLTextAreaElement> {
  error?: string;
}

export const Textarea = forwardRef<HTMLTextAreaElement, TextareaProps>(function Textarea({ className, error, ...props }, ref) {
  return (
    <textarea
      ref={ref}
      className={cn(
        CONTROL_CLASS,
        error ? "border-red-500 focus:border-red-500 focus:ring-red-500/20" : "",
        className
      )}
      {...props}
    />
  );
});

interface CheckboxProps extends React.InputHTMLAttributes<HTMLInputElement> {
  label?: string;
}

export const Checkbox = forwardRef<HTMLInputElement, CheckboxProps>(function Checkbox({ className, label, ...props }, ref) {
  return (
    <label className="flex items-center gap-2 text-sm text-slate-700">
      <input
        ref={ref}
        type="checkbox"
        className={cn("h-4 w-4 rounded border-slate-300 text-blue-600 focus:ring-blue-500/40", className)}
        {...props}
      />
      {label}
    </label>
  );
});
