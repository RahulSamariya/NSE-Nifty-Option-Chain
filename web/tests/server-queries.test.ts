import { describe, expect, it } from "vitest";
import type { SupabaseClient } from "@supabase/supabase-js";
import {
  MAX_CHAIN_STRIKES,
  MAX_EXPORT_STRIKES,
  SnapshotQueryError,
  loadExpiries,
  loadHistory,
} from "@/lib/option-chain-server";

type Result = { data: unknown; error: null | { message: string } };

interface Recorder {
  client: SupabaseClient;
  calls: Array<{ method: string; args: unknown[] }>;
  table: () => string;
}

/** Minimal PostgREST-style builder: records the chain, resolves with `result`. */
function fakeClient(result: Result): Recorder {
  const calls: Array<{ method: string; args: unknown[] }> = [];
  let table = "";

  const builder: Record<string, unknown> = {};
  for (const method of ["select", "eq", "in", "order", "limit"]) {
    builder[method] = (...args: unknown[]) => {
      calls.push({ method, args });
      return builder;
    };
  }
  builder.then = (
    onFulfilled: (value: Result) => unknown,
    onRejected?: (reason: unknown) => unknown,
  ) => Promise.resolve(result).then(onFulfilled, onRejected);

  const client = {
    from: (name: string) => {
      table = name;
      return builder;
    },
  } as unknown as SupabaseClient;

  return { client, calls, table: () => table };
}

describe("loadExpiries", () => {
  it("reads only expiries that exist for the symbol, newest first", async () => {
    const { client, calls, table } = fakeClient({
      data: [
        { expiry: "27-Oct-2026", nse_timestamp: "23-Oct-2026 15:40:00", updated_at: "2026-10-25T09:00:00Z" },
        { expiry: "27-Oct-2026", nse_timestamp: "23-Oct-2026 15:40:00", updated_at: "2026-10-24T09:00:00Z" },
        { expiry: "03-Nov-2026", nse_timestamp: "23-Oct-2026 15:40:00", updated_at: "2026-10-24T08:00:00Z" },
        { expiry: "", nse_timestamp: null, updated_at: "2026-10-24T07:00:00Z" },
        { expiry: "  ", nse_timestamp: null, updated_at: "2026-10-24T06:00:00Z" },
      ],
      error: null,
    });

    const expiries = await loadExpiries(client, "NIFTY");
    expect(table()).toBe("option_chain_live");
    expect(expiries).toEqual([
      {
        expiry: "27-Oct-2026",
        nse_timestamp: "23-Oct-2026 15:40:00",
        snapshot_updated_at: "2026-10-25T09:00:00Z",
      },
      {
        expiry: "03-Nov-2026",
        nse_timestamp: "23-Oct-2026 15:40:00",
        snapshot_updated_at: "2026-10-24T08:00:00Z",
      },
    ]);
    expect(calls.find((call) => call.method === "eq")?.args).toEqual(["symbol", "NIFTY"]);
    expect(calls.find((call) => call.method === "order")?.args).toEqual([
      "updated_at",
      { ascending: false },
    ]);
  });

  it("turns a database error into SnapshotQueryError", async () => {
    const { client } = fakeClient({ data: null, error: { message: "relation does not exist" } });
    await expect(loadExpiries(client, "NIFTY")).rejects.toBeInstanceOf(SnapshotQueryError);
  });

  it("returns an empty list when nothing is stored", async () => {
    const { client } = fakeClient({ data: null, error: null });
    await expect(loadExpiries(client, "FINNIFTY")).resolves.toEqual([]);
  });
});

describe("loadHistory", () => {
  it("queries both expiry spellings and returns oldest first", async () => {
    const { client, calls, table } = fakeClient({
      data: [
        { created_at: "2026-10-24T04:10:00Z", spot: 22600 },
        { created_at: "2026-10-24T04:05:00Z", spot: 22580 },
        { created_at: "2026-10-24T04:00:00Z", spot: 22500 },
      ],
      error: null,
    });

    const points = await loadHistory(client, "NIFTY", "7-Oct-2026", 3);
    expect(table()).toBe("option_chain_history");
    expect(calls.find((call) => call.method === "in")?.args).toEqual([
      "expiry",
      ["7-Oct-2026", "07-Oct-2026"],
    ]);
    expect(calls.find((call) => call.method === "order")?.args).toEqual([
      "created_at",
      { ascending: false },
    ]);
    expect(calls.find((call) => call.method === "limit")?.args).toEqual([3]);
    expect(points.map((point) => point.spot)).toEqual([22500, 22580, 22600]);
  });

  it("propagates query failures", async () => {
    const { client } = fakeClient({ data: null, error: { message: "timeout" } });
    await expect(loadHistory(client, "NIFTY", "27-Oct-2026", 60)).rejects.toBeInstanceOf(
      SnapshotQueryError,
    );
  });
});

describe("response-size guards", () => {
  it("keeps the export cap below the JSON cap", () => {
    expect(MAX_EXPORT_STRIKES).toBe(2000);
    expect(MAX_CHAIN_STRIKES).toBe(5000);
    expect(MAX_EXPORT_STRIKES).toBeLessThan(MAX_CHAIN_STRIKES);
  });
});
