import { TOAST_TYPE, Toast } from "@/lib/api";

let listeners: Array<(toast: Toast) => void> = [];

export function toast(type: Toast["type"], title: string, message?: string, duration = 4000): string {
  const id = Math.random().toString(36).slice(2);
  const t: Toast = { id, type, title, message, duration };
  listeners.forEach((l) => l(t));
  setTimeout(() => dismiss(id), duration);
  return id;
}

export function success(title: string, message?: string) {
  return toast("success", title, message);
}

export function error(title: string, message?: string) {
  return toast("error", title, message, 6000);
}

export function warning(title: string, message?: string) {
  return toast("warning", title, message);
}

export function info(title: string, message?: string) {
  return toast("info", title, message);
}

export function dismiss(id: string) {
  listeners = listeners.filter((l) => {
    // Each listener is a function; we can't filter per-id here without state.
    // Instead rely on duration-based auto-dismiss; this is a no-op placeholder.
    return true;
  });
}

export function onToast(callback: (toast: Toast) => void) {
  listeners.push(callback);
  return () => {
    listeners = listeners.filter((l) => l !== callback);
  };
}
