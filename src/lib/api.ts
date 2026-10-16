export type ApiSuccess<T = unknown> = {
  success: true;
  data: T;
  message?: string;
};

export type ApiError = {
  success: false;
  error: {
    code: string;
    message: string;
    details?: Record<string, unknown>;
  };
};

export type ApiResponse<T = unknown> = ApiSuccess<T> | ApiError;

export function success<T>(data: T, message?: string): ApiSuccess<T> {
  return { success: true, data, message };
}

export function apiError(code: string, message: string, details?: Record<string, unknown>): ApiError {
  return { success: false, error: { code, message, details } };
}

export function unauthorized(message = "Authentication required"): ApiError {
  return apiError("UNAUTHORIZED", message);
}

export function forbidden(message = "You do not have permission to perform this action"): ApiError {
  return apiError("FORBIDDEN", message);
}

export function notFound(message = "Resource not found"): ApiError {
  return apiError("NOT_FOUND", message);
}

export function badRequest(message: string, details?: Record<string, unknown>): ApiError {
  return apiError("BAD_REQUEST", message, details);
}

export function serverError(message = "An internal error occurred"): ApiError {
  return apiError("INTERNAL_ERROR", message);
}

export function isApiError(res: ApiResponse): res is ApiError {
  return res.success === false;
}

/**
 * Extracts a human-readable message from an API error payload. Handles both the
 * structured `{ error: { message } }` shape and legacy `{ error: "string" }`
 * responses, falling back to `fallback` when neither is present.
 */
export function apiErrorMessage(payload: unknown, fallback: string): string {
  const err = (payload as { error?: unknown } | null)?.error;
  if (typeof err === "string" && err.trim()) return err;
  if (err && typeof err === "object") {
    const message = (err as { message?: unknown }).message;
    if (typeof message === "string" && message.trim()) return message;
  }
  return fallback;
}

export const TOAST_TYPE = {
  success: "success",
  error: "error",
  warning: "warning",
  info: "info",
} as const;

export type ToastType = (typeof TOAST_TYPE)[keyof typeof TOAST_TYPE];

export interface Toast {
  id: string;
  type: ToastType;
  title: string;
  message?: string;
  duration?: number;
}
