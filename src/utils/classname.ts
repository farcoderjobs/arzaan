import { ClassValue } from "clsx";

export function cn(...classes: ClassValue[]): string {
  return classes.filter(Boolean).join(" ");
}
