import { describe, expect, it } from "vitest";
import { createRateLimiter, clientKey } from "@/lib/rate-limit";

function clock(start = 0) {
  let current = start;
  return {
    now: () => current,
    advance: (ms: number) => {
      current += ms;
    },
  };
}

describe("createRateLimiter", () => {
  it("allows exactly the configured budget per window", () => {
    const time = clock();
    const limiter = createRateLimiter(3, 60_000, time.now);

    expect(limiter.check("a").ok).toBe(true);
    expect(limiter.check("a").remaining).toBe(1);
    const blocked = limiter.check("b");
    expect(blocked.remaining).toBe(2);
    expect(blocked.ok).toBe(true);

    expect(limiter.check("a").ok).toBe(true);
    const over = limiter.check("a");
    expect(over.ok).toBe(false);
    expect(over.remaining).toBe(0);
    expect(over.retryAfterSeconds).toBe(60);
    // "b" had a different budget, still fine
    expect(limiter.check("b").ok).toBe(true);
  });

  it("resets once the window elapses", () => {
    const time = clock();
    const limiter = createRateLimiter(2, 1_000, time.now);
    limiter.check("k");
    limiter.check("k");
    expect(limiter.check("k").ok).toBe(false);

    time.advance(999);
    expect(limiter.check("k").ok).toBe(false);
    time.advance(1);
    expect(limiter.check("k").ok).toBe(true);
  });

  it("reports a shrinking retry-after value", () => {
    const time = clock();
    const limiter = createRateLimiter(1, 10_000, time.now);
    limiter.check("k");
    time.advance(4_000);
    expect(limiter.check("k").retryAfterSeconds).toBe(6);
  });

  it("prunes expired windows instead of growing forever", () => {
    const time = clock();
    const limiter = createRateLimiter(1, 1_000, time.now);
    for (let i = 0; i < 500; i += 1) limiter.check(`key-${i}`);
    expect(limiter.size()).toBe(500);

    time.advance(1_000);
    limiter.prune();
    expect(limiter.size()).toBe(0);
  });
});

describe("clientKey", () => {
  it("uses the first x-forwarded-for hop", () => {
    const request = new Request("http://localhost/x", {
      headers: { "x-forwarded-for": "203.0.113.9, 10.0.0.1" },
    });
    expect(clientKey(request)).toBe("203.0.113.9");
  });

  it("falls back to x-real-ip and then to a shared local bucket", () => {
    expect(
      clientKey(new Request("http://localhost/x", { headers: { "x-real-ip": "198.51.100.4" } })),
    ).toBe("198.51.100.4");
    expect(clientKey(new Request("http://localhost/x"))).toBe("local");
  });
});
