import Link from "next/link";
import { cn } from "@/utils/classname";
import { ChevronRight } from "@/components/ui/icons";

interface BreadcrumbItem {
  label: string;
  href?: string;
}

interface BreadcrumbsProps {
  items: BreadcrumbItem[];
  className?: string;
}

export function Breadcrumbs({ items, className }: BreadcrumbsProps) {
  return (
    <nav aria-label="Breadcrumb" className={cn("flex items-center gap-1 text-sm", className)}>
      {items.map((item, index) => {
        const isLast = index === items.length - 1;
        return (
          <span key={index} className="flex items-center gap-1">
            {index > 0 && <ChevronRight className="h-4 w-4 text-slate-400" />}
            {isLast ? (
              <span className="font-medium text-slate-900">{item.label}</span>
            ) : item.href ? (
              <Link href={item.href} className="text-slate-500 hover:text-slate-700">
                {item.label}
              </Link>
            ) : (
              <span className="text-slate-400">{item.label}</span>
            )}
          </span>
        );
      })}
    </nav>
  );
}
