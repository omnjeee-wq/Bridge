import { getJvmManager, getJvmWorkerUrl, isJvmEnabled } from "./jvm-manager.js";

type QueryLike = { query: Record<string, unknown> };

function queryString(query: Record<string, unknown>) {
  const params = new URLSearchParams();
  for (const [key, value] of Object.entries(query)) {
    if (typeof value === "string" && value) params.set(key, value);
  }
  const encoded = params.toString();
  return encoded ? `?${encoded}` : "";
}

export function jvmRuntimeConfigured() {
  return isJvmEnabled();
}

export async function requestJvmRuntime(
  pathname: string,
  request: QueryLike,
): Promise<Record<string, unknown> | null> {
  if (!isJvmEnabled()) return null;

  const manager = getJvmManager();
  const state = manager.getState();
  if (state.status !== "running") return null;

  const url = getJvmWorkerUrl();
  if (!url) return null;

  try {
    const configuredTimeout = Number(process.env.MURPH_JVM_TIMEOUT_MS);
    const timeoutMs =
      Number.isFinite(configuredTimeout) && configuredTimeout > 0
        ? configuredTimeout
        : pathname.startsWith("/stream/")
          ? 90_000
          : 30_000;
    const response = await fetch(`${url}${pathname}${queryString(request.query)}`, {
      signal: AbortSignal.timeout(timeoutMs),
      headers: { accept: "application/json" },
    });
    if (!response.ok) return null;
    const payload = (await response.json()) as unknown;
    return payload && typeof payload === "object" ? (payload as Record<string, unknown>) : null;
  } catch {
    return null;
  }
}