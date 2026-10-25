/**
 * Shared HTTP plumbing for the public read-only API: CORS, generic error
 * bodies, cache headers and per-instance rate limiting.
 */
import { LIMITS, clientKey, createRateLimiter } from "./rate-limit";

export const CORS_HEADERS: Record<string, string> = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "GET, OPTIONS",
  "Access-Control-Allow-Headers": "Content-Type",
};

const READ_LIMITER = createRateLimiter(LIMITS.read.limit, LIMITS.read.windowMs);
const EXPORT_LIMITER = createRateLimiter(LIMITS.export.limit, LIMITS.export.windowMs);

export interface ApiErrorBody {
  error: { code: string; message: string };
}

export function jsonError(
  status: number,
  code: string,
  message: string,
  headers: Record<string, string> = {},
): Response {
  return Response.json(
    { error: { code, message } } satisfies ApiErrorBody,
    {
      status,
      headers: {
        ...CORS_HEADERS,
        "Cache-Control": "no-store",
        "X-Content-Type-Options": "nosniff",
        ...headers,
      },
    },
  );
}

/**
 * Returns a 429 response when the caller exceeded its budget, otherwise null.
 * `bucket: "export"` is much tighter because workbook generation is expensive.
 */
export function enforceRateLimit(
  request: Request,
  bucket: "read" | "export" = "read",
): Response | null {
  const limiter = bucket === "export" ? EXPORT_LIMITER : READ_LIMITER;
  const result = limiter.check(clientKey(request));
  if (result.ok) return null;

  return jsonError(
    429,
    "rate_limited",
    `Too many requests. Try again in ${result.retryAfterSeconds}s.`,
    {
      "Retry-After": String(result.retryAfterSeconds),
      "X-RateLimit-Limit": String(result.limit),
      "X-RateLimit-Remaining": "0",
    },
  );
}

export function preflight(): Response {
  return new Response(null, { status: 204, headers: CORS_HEADERS });
}
