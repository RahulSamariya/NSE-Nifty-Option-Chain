import { beforeEach, describe, expect, it, vi } from "vitest";
import type { Mock } from "vitest";
import { getSnapshotFreshness } from "@/lib/market-status";
import { makeRecord } from "./fixtures";

vi.mock("@/lib/option-chain-server", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/option-chain-server")>();
  return {
    ...actual,
    createReadClient: vi.fn(),
    loadSnapshot: vi.fn(),
  };
});

const { GET } = await import("@/app/api/option-chain/route");
const { GET: EXPORT } = await import("@/app/api/option-chain/export/route");
const { createReadClient, loadSnapshot, SnapshotQueryError } = await import(
  "@/lib/option-chain-server"
);

const mockClient = createReadClient as unknown as Mock;
const mockLoad = loadSnapshot as unknown as Mock;

const sundayNoonIst = new Date("2026-10-25T06:30:00Z");

function loaded(overrides: Partial<ReturnType<typeof makeRecord>> = {}) {
  const record = makeRecord(overrides);
  return {
    record,
    freshness: getSnapshotFreshness(record.nse_timestamp, sundayNoonIst),
    readAt: sundayNoonIst,
  };
}

beforeEach(() => {
  mockClient.mockReset().mockReturnValue({ from: vi.fn() });
  mockLoad.mockReset();
});

describe("GET /api/option-chain", () => {
  it("rejects requests without a symbol before touching the database", async () => {
    const response = await GET(new Request("http://localhost/api/option-chain"));
    expect(response.status).toBe(400);
    await expect(response.json()).resolves.toMatchObject({
      error: { code: "missing_symbol" },
    });
    expect(mockClient).not.toHaveBeenCalled();
  });

  it("rejects bad expiries and formats with 400", async () => {
    const badExpiry = await GET(
      new Request("http://localhost/api/option-chain?symbol=NIFTY&expiry=31-Feb-2026"),
    );
    expect(badExpiry.status).toBe(400);
    const badFormat = await GET(
      new Request("http://localhost/api/option-chain?symbol=NIFTY&format=xlsx"),
    );
    expect(badFormat.status).toBe(400);
  });

  it("returns 503 when no read credentials are configured", async () => {
    mockClient.mockReturnValue(null);
    const response = await GET(new Request("http://localhost/api/option-chain?symbol=NIFTY"));
    expect(response.status).toBe(503);
    await expect(response.json()).resolves.toMatchObject({
      error: { code: "not_configured" },
    });
  });

  it("returns 404 when the symbol has no stored snapshot", async () => {
    mockLoad.mockResolvedValue(null);
    const response = await GET(
      new Request("http://localhost/api/option-chain?symbol=NIFTY&expiry=27-Oct-2026"),
    );
    expect(response.status).toBe(404);
    await expect(response.json()).resolves.toMatchObject({ error: { code: "no_snapshot" } });
  });

  it("returns 502 and a generic message for a database failure", async () => {
    const error = vi.spyOn(console, "error").mockImplementation(() => {});
    mockLoad.mockRejectedValue(new SnapshotQueryError("connect ECONNREFUSED 10.0.0.1:5432"));
    const response = await GET(new Request("http://localhost/api/option-chain?symbol=NIFTY"));
    expect(response.status).toBe(502);
    const body = await response.text();
    expect(body).toContain("database_error");
    expect(body).not.toContain("ECONNREFUSED");
    expect(body).not.toContain("10.0.0.1");
    error.mockRestore();
  });

  it("returns the full chain with honest freshness metadata", async () => {
    mockLoad.mockResolvedValue(loaded());
    const response = await GET(
      new Request("http://localhost/api/option-chain?symbol=NIFTY&expiry=27-Oct-2026"),
    );
    expect(response.status).toBe(200);
    expect(response.headers.get("Cache-Control")).toBe("no-store");
    expect(response.headers.get("X-Snapshot-Status")).toBe("Last Close");

    const body = await response.json();
    expect(body.meta.status).toBe("Last Close");
    expect(body.meta.nse_timestamp).toBe("23-Oct-2026 15:40:00");
    expect(body.meta.strike_count).toBe(3);
    expect(body.chain).toHaveLength(3);
    expect(body.fields).toContain("PE_ASK_QTY");
    expect(JSON.stringify(body)).not.toMatch(/service_role|sb_secret|SUPABASE_URL|SUPABASE_ANON_KEY/i);
  });

  it("serves the same snapshot as CSV", async () => {
    mockLoad.mockResolvedValue(loaded());
    const response = await GET(
      new Request("http://localhost/api/option-chain?symbol=NIFTY&expiry=27-Oct-2026&format=csv"),
    );
    expect(response.status).toBe(200);
    expect(response.headers.get("Content-Type")).toContain("text/csv");
    const csv = await response.text();
    expect(csv.split("\r\n").filter(Boolean)).toHaveLength(4);
    expect(csv).toContain("Last Close");
  });
});

describe("GET /api/option-chain/export", () => {
  it("does not build a workbook when the snapshot is missing", async () => {
    mockLoad.mockResolvedValue(null);
    const response = await EXPORT(
      new Request("http://localhost/api/option-chain/export?symbol=NIFTY&expiry=27-Oct-2026"),
    );
    expect(response.status).toBe(404);
  });

  it("downloads a real xlsx for the requested snapshot", async () => {
    mockLoad.mockResolvedValue(loaded());
    const response = await EXPORT(
      new Request("http://localhost:3000/api/option-chain/export?symbol=NIFTY&expiry=27-Oct-2026"),
    );
    expect(response.status).toBe(200);
    expect(response.headers.get("Content-Type")).toBe(
      "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
    );
    expect(response.headers.get("Content-Disposition")).toContain(
      'attachment; filename="NIFTY_27-Oct-2026_snapshot.xlsx"',
    );
    const bytes = new Uint8Array(await response.arrayBuffer());
    expect([...bytes.slice(0, 2)]).toEqual([0x50, 0x4b]);
  });

  it("passes the canonical expiry to the query", async () => {
    mockLoad.mockResolvedValue(loaded());
    await EXPORT(
      new Request("http://localhost/api/option-chain/export?symbol=nifty&expiry=7-oct-2026"),
    );
    expect(mockLoad).toHaveBeenCalledWith(expect.anything(), "NIFTY", "7-Oct-2026");
  });
});
