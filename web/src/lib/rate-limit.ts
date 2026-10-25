/**
 * Small in-process rate limiter for the public read endpoints.
 *
 * This protects a single server instance from a runaway tab or a trivial script.
 * It is deliberately not a distributed limiter: on a multi-instance deployment
 * each instance counts separately. See docs/HOSTED_DEPLOYMENT.md for the
 * recommended shared limiter when you need a hard global cap.
 */

export interface RateLimitResult {
  ok: boolean;
  limit: number;
  remaining: number;
  /** Seconds until the current window resets (0 when allowed and fresh). */
  retryAfterSeconds: number;
}

interface Window {
  count: number;
  resetAt: number;
}

export interface RateLimiter {
  check(key: string): RateLimitResult;
  /** Visible for tests and for the occasional sweep on long-running servers. */
  prune(now?: number): void;
  size(): number;
}

const MAX_TRACKED_KEYS = 10_000;

export function createRateLimiter(
  limit: number,
  windowMs: number,
  now: () => number = Date.now,
): RateLimiter {
  const windows = new Map<string, Window>();

  function prune(current: number = now()): void {
    for (const [key, entry] of windows) {
      if (entry.resetAt <= current) windows.delete(key);
    }
    if (windows.size <= MAX_TRACKED_KEYS) return;

    // Still too many keys: drop the oldest windows to bound memory.
    const ordered = [...windows.entries()].sort((a, b) => a[1].resetAt - b[1].resetAt);
    for (const [key] of ordered.slice(0, ordered.length - MAX_TRACKED_KEYS)) {
      windows.delete(key);
    }
  }

  return {
    check(key: string): RateLimitResult {
      const current = now();
      prune(current);

      const entry = windows.get(key);
      if (!entry || entry.resetAt <= current) {
        windows.set(key, { count: 1, resetAt: current + windowMs });
        return { ok: true, limit, remaining: limit - 1, retryAfterSeconds: 0 };
      }

      entry.count += 1;
      const retryAfterSeconds = Math.max(1, Math.ceil((entry.resetAt - current) / 1000));
      if (entry.count > limit) {
        return { ok: false, limit, remaining: 0, retryAfterSeconds };
      }
      return {
        ok: true,
        limit,
        remaining: Math.max(0, limit - entry.count),
        retryAfterSeconds: 0,
      };
    },
    prune,
    size() {
      return windows.size;
    },
  };
}

/** Best-effort client identity behind a proxy (Vercel sets x-forwarded-for). */
export function clientKey(request: Request): string {
  const forwarded = request.headers.get("x-forwarded-for");
  if (forwarded) {
    const first = forwarded.split(",")[0]?.trim();
    if (first) return first;
  }
  return request.headers.get("x-real-ip")?.trim() || "local";
}

export const LIMITS = {
  /** Snapshot reads (JSON/CSV/history/expiries). */
  read: { limit: 120, windowMs: 60_000 },
  /** Workbook generation is CPU and bandwidth heavy. */
  export: { limit: 12, windowMs: 60_000 },
} as const;
