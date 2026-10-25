import { beforeEach, describe, expect, it, vi } from "vitest";
import type { Mock } from "vitest";
import ExcelJS from "exceljs";
import { getSnapshotFreshness } from "@/lib/market-status";
import { makeRecord, makeStrike } from "./fixtures";

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

  it("narrows the chain to the requested strike range", async () => {
    const wide = Array.from({ length: 41 }, (_, index) => makeStrike(19000 + index * 50));
    mockLoad.mockResolvedValue(loaded({ spot: 20000, raw_data: wide }));

    const full = await GET(
      new Request("http://localhost/api/option-chain?symbol=NIFTY&expiry=27-Oct-2026"),
    );
    const fullBody = await full.json();
    expect(fullBody.chain).toHaveLength(41);
    expect(full.headers.get("X-Strike-Total")).toBe("41");

    const narrow = await GET(
      new Request(
        "http://localhost/api/option-chain?symbol=NIFTY&expiry=27-Oct-2026&range=10",
      ),
    );
    const narrowBody = await narrow.json();
    expect(narrowBody.chain).toHaveLength(21);
    expect(narrowBody.chain[0].STRIKE).toBe(19500);
    expect(narrowBody.chain.at(-1).STRIKE).toBe(20500);
    expect(narrow.headers.get("X-Strike-Range")).toBe("10");
    expect(narrow.headers.get("X-Strike-Count")).toBe("21");
    expect(narrow.headers.get("X-Strike-Total")).toBe("41");
    expect(narrowBody.meta.strikes_returned).toBe(21);
    expect(narrowBody.meta.field_groups).toEqual([
      "oi",
      "oi_change",
      "volume",
      "iv",
      "ltp",
      "price_change",
      "bid_ask",
    ]);
  });

  it("returns only the selected field groups", async () => {
    mockLoad.mockResolvedValue(loaded());
    const response = await GET(
      new Request("http://localhost/api/option-chain?symbol=NIFTY&expiry=27-Oct-2026&fields=ltp"),
    );
    const body = await response.json();
    expect(body.fields).toEqual(["STRIKE", "CE_LTP", "PE_LTP"]);
    expect(Object.keys(body.chain[0]).sort()).toEqual(["CE_LTP", "PE_LTP", "STRIKE"]);
    expect(body.meta.fields_label).toBe("LTP");
  });

  it("applies range and fields to CSV columns and rows", async () => {
    const wide = Array.from({ length: 41 }, (_, index) => makeStrike(19000 + index * 50));
    mockLoad.mockResolvedValue(loaded({ spot: 20000, raw_data: wide }));

    const response = await GET(
      new Request(
        "http://localhost/api/option-chain?symbol=NIFTY&expiry=27-Oct-2026&format=csv&range=10&fields=oi,ltp",
      ),
    );
    expect(response.status).toBe(200);
    const lines = (await response.text()).split("\r\n").filter(Boolean);
    expect(lines).toHaveLength(22);
    const header = lines[0].split(",");
    expect(header).toContain("STRIKE");
    expect(header).toContain("CE_OI");
    expect(header).toContain("PE_LTP");
    expect(header).not.toContain("CE_IV");
    expect(header).not.toContain("CE_BID");
  });

  it("rejects an oversized snapshot instead of streaming it", async () => {
    const spy = vi.spyOn(console, "error").mockImplementation(() => {});
    const huge = Array.from({ length: 5001 }, (_, index) => makeStrike(10000 + index));
    mockLoad.mockResolvedValue(loaded({ raw_data: huge }));

    const response = await GET(
      new Request("http://localhost/api/option-chain?symbol=NIFTY&expiry=27-Oct-2026"),
    );
    expect(response.status).toBe(413);
    await expect(response.json()).resolves.toMatchObject({
      error: { code: "snapshot_too_large" },
    });
    spy.mockRestore();
  });

  it("returns CORS headers and answers preflight", async () => {
    mockLoad.mockResolvedValue(loaded());
    const response = await GET(
      new Request("http://localhost/api/option-chain?symbol=NIFTY&expiry=27-Oct-2026"),
    );
    expect(response.headers.get("Access-Control-Allow-Origin")).toBe("*");

    const { OPTIONS } = await import("@/app/api/option-chain/route");
    const preflight = OPTIONS();
    expect(preflight.status).toBe(204);
    expect(preflight.headers.get("Access-Control-Allow-Methods")).toBe("GET, OPTIONS");
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

  it("builds the workbook from the selected range and fields", async () => {
    const wide = Array.from({ length: 41 }, (_, index) => makeStrike(19000 + index * 50));
    mockLoad.mockResolvedValue(loaded({ spot: 20000, raw_data: wide }));

    const response = await EXPORT(
      new Request(
        "http://localhost/api/option-chain/export?symbol=NIFTY&expiry=27-Oct-2026&range=10&fields=ltp",
      ),
    );
    expect(response.status).toBe(200);
    expect(response.headers.get("Content-Disposition")).toContain(
      'filename="NIFTY_27-Oct-2026_atm10_snapshot.xlsx"',
    );
    expect(response.headers.get("X-Strike-Count")).toBe("21");
    expect(response.headers.get("X-Strike-Total")).toBe("41");

    const workbook = new ExcelJS.Workbook();
    await workbook.xlsx.load((await response.arrayBuffer()) as never);

    const chain = workbook.getWorksheet("Option Chain")!;
    expect(chain.rowCount).toBe(22);
    expect(chain.columnCount).toBe(3);
    expect(chain.getCell(1, 1).value).toBe("Strike");
    expect(chain.getCell(1, 2).value).toBe("CE LTP");
    expect(chain.getCell(2, 1).value).toBe(19500);
    expect(chain.getCell(22, 1).value).toBe(20500);

    // The raw sheet is never trimmed: it keeps every strike and every field.
    const raw = workbook.getWorksheet("Raw Data")!;
    expect(raw.rowCount).toBe(42);

    const summary = workbook.getWorksheet("Summary")!;
    const values = new Map<string, ExcelJS.CellValue>();
    summary.eachRow((row) => {
      const label = row.getCell(1).value;
      if (typeof label === "string") values.set(label, row.getCell(2).value);
    });
    expect(values.get("Strike range")).toBe("ATM +/- 10 strikes");
    expect(values.get("Import fields")).toBe("LTP");
    expect(values.get("Strikes exported")).toBe(21);
    expect(values.get("Strikes in raw data")).toBe(41);
  });

  it("refuses to build an oversized workbook", async () => {
    const spy = vi.spyOn(console, "error").mockImplementation(() => {});
    const huge = Array.from({ length: 2001 }, (_, index) => makeStrike(10000 + index));
    mockLoad.mockResolvedValue(loaded({ raw_data: huge }));

    const response = await EXPORT(
      new Request("http://localhost/api/option-chain/export?symbol=NIFTY&expiry=27-Oct-2026"),
    );
    expect(response.status).toBe(413);
    await expect(response.json()).resolves.toMatchObject({
      error: { code: "snapshot_too_large" },
    });
    spy.mockRestore();
  });

  it("rate-limits workbook generation harder than reads", async () => {
    const { enforceRateLimit } = await import("@/lib/api-response");
    const request = new Request("http://localhost/api/option-chain/export", {
      headers: { "x-forwarded-for": "203.0.113.77" },
    });

    const responses = [];
    for (let index = 0; index < 13; index += 1) {
      responses.push(enforceRateLimit(request, "export"));
    }
    expect(responses.slice(0, 12).every((response) => response === null)).toBe(true);
    const blocked = responses[12];
    expect(blocked?.status).toBe(429);
    expect(blocked?.headers.get("Retry-After")).toBeTruthy();
    await expect(blocked?.json()).resolves.toMatchObject({ error: { code: "rate_limited" } });
    // Read budget is separate and still available.
    expect(enforceRateLimit(request, "read")).toBeNull();
  });
});
