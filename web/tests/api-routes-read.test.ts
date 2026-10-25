import { beforeEach, describe, expect, it, vi } from "vitest";
import type { Mock } from "vitest";

vi.mock("@/lib/option-chain-server", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/option-chain-server")>();
  return {
    ...actual,
    createReadClient: vi.fn(),
    loadExpiries: vi.fn(),
    loadHistory: vi.fn(),
  };
});

const { GET: EXPIRIES } = await import("@/app/api/option-chain/expiries/route");
const { GET: HISTORY } = await import("@/app/api/option-chain/history/route");
const { GET: HEALTH } = await import("@/app/api/health/route");
const { createReadClient, loadExpiries, loadHistory, SnapshotQueryError } = await import(
  "@/lib/option-chain-server"
);

const mockClient = createReadClient as unknown as Mock;
const mockExpiries = loadExpiries as unknown as Mock;
const mockHistory = loadHistory as unknown as Mock;

function fakeSupabase(result: { data: unknown; error: null | { message: string } }) {
  return {
    from: vi.fn().mockReturnValue({
      select: vi.fn().mockReturnValue({
        order: vi.fn().mockReturnValue({
          limit: vi.fn().mockResolvedValue(result),
        }),
      }),
    }),
  };
}

beforeEach(() => {
  mockClient.mockReset().mockReturnValue({ from: vi.fn() });
  mockExpiries.mockReset();
  mockHistory.mockReset();
});

describe("GET /api/option-chain/expiries", () => {
  it("validates the symbol", async () => {
    const response = await EXPIRIES(new Request("http://localhost/api/option-chain/expiries"));
    expect(response.status).toBe(400);
    await expect(response.json()).resolves.toMatchObject({ error: { code: "missing_symbol" } });
    expect(mockClient).not.toHaveBeenCalled();
  });

  it("returns 503 without read credentials", async () => {
    mockClient.mockReturnValue(null);
    const response = await EXPIRIES(
      new Request("http://localhost/api/option-chain/expiries?symbol=NIFTY"),
    );
    expect(response.status).toBe(503);
  });

  it("returns 404 when the symbol has no stored data", async () => {
    mockExpiries.mockResolvedValue([]);
    const response = await EXPIRIES(
      new Request("http://localhost/api/option-chain/expiries?symbol=FINNIFTY"),
    );
    expect(response.status).toBe(404);
    await expect(response.json()).resolves.toMatchObject({ error: { code: "no_snapshot" } });
  });

  it("returns the real expiries and marks the newest one", async () => {
    mockExpiries.mockResolvedValue([
      { expiry: "27-Oct-2026", nse_timestamp: "23-Oct-2026 15:40:00", snapshot_updated_at: "2026-10-25T09:00:00Z" },
      { expiry: "03-Nov-2026", nse_timestamp: "23-Oct-2026 15:40:00", snapshot_updated_at: "2026-10-25T08:00:00Z" },
    ]);
    const response = await EXPIRIES(
      new Request("http://localhost/api/option-chain/expiries?symbol=nifty"),
    );
    expect(response.status).toBe(200);
    expect(mockExpiries).toHaveBeenCalledWith(expect.anything(), "NIFTY");
    const body = await response.json();
    expect(body.symbol).toBe("NIFTY");
    expect(body.newest).toBe("27-Oct-2026");
    expect(body.expiries).toHaveLength(2);
    expect(JSON.stringify(body)).not.toMatch(/service_role|sb_secret/i);
  });

  it("hides database details on failure", async () => {
    const spy = vi.spyOn(console, "error").mockImplementation(() => {});
    mockExpiries.mockRejectedValue(new SnapshotQueryError("connect ECONNREFUSED 10.0.0.1"));
    const response = await EXPIRIES(
      new Request("http://localhost/api/option-chain/expiries?symbol=NIFTY"),
    );
    expect(response.status).toBe(502);
    const text = await response.text();
    expect(text).toContain("database_error");
    expect(text).not.toContain("ECONNREFUSED");
    spy.mockRestore();
  });
});

describe("GET /api/option-chain/history", () => {
  it("requires an expiry and rejects bad limits", async () => {
    const missing = await HISTORY(
      new Request("http://localhost/api/option-chain/history?symbol=NIFTY"),
    );
    expect(missing.status).toBe(400);
    await expect(missing.json()).resolves.toMatchObject({ error: { code: "missing_expiry" } });

    const badLimit = await HISTORY(
      new Request("http://localhost/api/option-chain/history?symbol=NIFTY&expiry=27-Oct-2026&limit=999"),
    );
    expect(badLimit.status).toBe(400);
    await expect(badLimit.json()).resolves.toMatchObject({ error: { code: "invalid_limit" } });
    expect(mockHistory).not.toHaveBeenCalled();
  });

  it("returns an empty series without inventing points", async () => {
    mockHistory.mockResolvedValue([]);
    const response = await HISTORY(
      new Request("http://localhost/api/option-chain/history?symbol=NIFTY&expiry=27-Oct-2026"),
    );
    expect(response.status).toBe(200);
    const body = await response.json();
    expect(body.points).toEqual([]);
    expect(body.meta.count).toBe(0);
    expect(mockHistory).toHaveBeenCalledWith(expect.anything(), "NIFTY", "27-Oct-2026", 60);
  });

  it("passes through stored points", async () => {
    mockHistory.mockResolvedValue([
      { created_at: "2026-10-24T04:00:00Z", spot: 22500 },
      { created_at: "2026-10-24T04:05:00Z", spot: 22600 },
    ]);
    const response = await HISTORY(
      new Request("http://localhost/api/option-chain/history?symbol=NIFTY&expiry=27-Oct-2026&limit=2"),
    );
    const body = await response.json();
    expect(body.meta.count).toBe(2);
    expect(body.points[1].spot).toBe(22600);
    expect(response.headers.get("Cache-Control")).toBe("no-store");
  });
});

describe("GET /api/health", () => {
  it("reports 503 when the deployment has no credentials", async () => {
    mockClient.mockReturnValue(null);
    const response = await HEALTH(new Request("http://localhost/api/health"));
    expect(response.status).toBe(503);
    await expect(response.json()).resolves.toMatchObject({ error: { code: "not_configured" } });
  });

  it("summarises stored freshness without leaking credentials", async () => {
    mockClient.mockReturnValue(
      fakeSupabase({
        data: [
          {
            symbol: "NIFTY",
            expiry: "27-Oct-2026",
            spot: "22600.5",
            nse_timestamp: "23-Oct-2026 15:40:00",
            updated_at: "2026-10-25T09:00:00Z",
          },
        ],
        error: null,
      }),
    );

    const response = await HEALTH(new Request("http://localhost/api/health"));
    expect(response.status).toBe(200);
    const body = await response.json();
    expect(body.symbols).toHaveLength(1);
    expect(body.symbols[0].symbol).toBe("NIFTY");
    expect(body.symbols[0].spot).toBe(22600.5);
    expect(["Live", "Last Close", "Stale", "Unavailable"]).toContain(body.symbols[0].status);
    expect(["never", "running", "delayed", "stalled"]).toContain(body.worker.state);
    expect(JSON.stringify(body)).not.toMatch(/test-anon|service_role|sb_secret|supabase\.co/i);
    expect(response.headers.get("Cache-Control")).toBe("no-store");
  });

  it("marks a write within ten minutes as a running worker", async () => {
    const recent = new Date(Date.now() - 90_000).toISOString();
    mockClient.mockReturnValue(
      fakeSupabase({
        data: [
          {
            symbol: "NIFTY",
            expiry: "27-Oct-2026",
            spot: 22600.5,
            nse_timestamp: "23-Oct-2026 15:40:00",
            updated_at: recent,
          },
        ],
        error: null,
      }),
    );

    const body = await (await HEALTH(new Request("http://localhost/api/health"))).json();
    expect(body.worker.state).toBe("running");
    expect(body.worker.seconds_since_write).toBeGreaterThanOrEqual(89);
    expect(body.worker.seconds_since_write).toBeLessThanOrEqual(120);
    expect(body.database).toEqual({ reachable: true, rows: 1 });
  });

  it("returns an honest unavailable health when nothing is stored", async () => {
    mockClient.mockReturnValue(fakeSupabase({ data: [], error: null }));

    const response = await HEALTH(new Request("http://localhost/api/health"));
    expect(response.status).toBe(200);
    const body = await response.json();
    expect(body.status).toBe("unavailable");
    expect(body.symbols).toEqual([]);
    expect(body.worker.state).toBe("never");
  });

  it("returns 502 without exposing the database error text", async () => {
    const spy = vi.spyOn(console, "error").mockImplementation(() => {});
    mockClient.mockReturnValue(
      fakeSupabase({ data: null, error: { message: "password authentication failed for user postgres" } }),
    );

    const response = await HEALTH(new Request("http://localhost/api/health"));
    expect(response.status).toBe(502);
    const text = await response.text();
    expect(text).not.toContain("password authentication");
    spy.mockRestore();
  });
});
