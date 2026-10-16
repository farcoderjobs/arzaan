import { cn } from "@/utils/classname";
import { Button } from "@/components/ui/button";
import { useT } from "@/i18n/client";

interface ErrorStateProps {
  title?: string;
  message: string;
  retry?: () => void;
  className?: string;
}

export function ErrorState({ title, message, retry, className }: ErrorStateProps) {
  const t = useT();
  return (
    <div className={cn("rounded-lg border border-red-200 bg-red-50 p-6 text-center", className)}>
      <div className="mx-auto flex h-12 w-12 items-center justify-center rounded-full bg-red-100 text-2xl">!</div>
      <p className="mt-3 text-sm font-semibold text-red-800">{title ?? t.common.errorTitle}</p>
      <p className="mt-1 text-sm text-red-600">{message}</p>
      {retry && (
        <div className="mt-4">
          <Button variant="secondary" onClick={retry}>
            {t.common.retry}
          </Button>
        </div>
      )}
    </div>
  );
}
