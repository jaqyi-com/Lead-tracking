export class ApiError extends Error {
  constructor(
    public status: number,
    public code: string,
    message: string,
    public details?: unknown,
  ) {
    super(message);
  }
}

export async function api<T = any>(path: string, init: RequestInit & { json?: unknown } = {}): Promise<T> {
  const { json, ...rest } = init;
  const res = await fetch(path, {
    credentials: "include",
    ...rest,
    headers: { ...(json !== undefined ? { "Content-Type": "application/json" } : {}), ...(rest.headers ?? {}) },
    body: json !== undefined ? JSON.stringify(json) : rest.body,
  });
  if (res.status === 401 && typeof window !== "undefined" && !path.startsWith("/api/auth") && !window.location.pathname.startsWith("/login")) {
    window.location.href = "/login";
  }
  const text = await res.text();
  const data = text ? safeJson(text) : null;
  if (!res.ok) {
    const d = (data ?? {}) as { error?: string; message?: string; details?: unknown };
    // Production requires admins to enable 2FA before anything else works.
    if (d.error === "totp_setup_required" && typeof window !== "undefined" && !window.location.pathname.startsWith("/settings")) {
      window.location.href = "/settings?totp=required";
    }
    throw new ApiError(res.status, d.error ?? "error", d.message ?? `Request failed (${res.status})`, d.details);
  }
  return data as T;
}

function safeJson(t: string) {
  try {
    return JSON.parse(t);
  } catch {
    return t;
  }
}

export const post = <T = any>(path: string, json?: unknown) => api<T>(path, { method: "POST", json: json ?? {} });
export const patch = <T = any>(path: string, json: unknown) => api<T>(path, { method: "PATCH", json });
export const del = <T = any>(path: string) => api<T>(path, { method: "DELETE" });

export async function upload(file: File): Promise<{ id: string; filename: string; mime: string; size: number }> {
  const fd = new FormData();
  fd.append("file", file);
  const r = await api<{ attachment: { id: string; filename: string; mime: string; size: number } }>("/api/attachments", { method: "POST", body: fd });
  return r.attachment;
}
