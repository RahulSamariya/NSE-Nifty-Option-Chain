# Refreshing the Excel export from the snapshot API

The **Download Excel** button produces a genuine `.xlsx` with three sheets
(`Summary`, `Option Chain`, `Raw Data`) built from the newest validated NSE
snapshot stored in Supabase. It exports **every strike in the snapshot**, not
just the ATM window shown in the browser.

That file is a **point-in-time snapshot**. A plain `.xlsx` downloaded from a
browser cannot rewrite itself, and this project does **not** ship a hidden
database connection inside the file. If you want a workbook that refreshes in
place, connect it to the read-only snapshot API with **Power Query**, which is
what this guide does.

> **What refresh means here.** `Data > Refresh All` re-queries this dashboard's
> API, which re-reads the stored Supabase row. It does **not** contact NSE. Only
> the Python worker (`worker/bridge_worker.py`) fetches NSE, and only while it is
> running. If the worker has stopped, refreshing the workbook returns the same
> old snapshot, and the `status` column says `Last Close` or `Stale` - it never
> pretends to be live.

## 1. Start the dashboard

```bash
cd web
npm run dev        # http://localhost:3000
# or, for a production build:
npm run build && npm start
```

The API needs read credentials in the server environment:

```ini
SUPABASE_URL=https://<project>.supabase.co
SUPABASE_ANON_KEY=<anon public key>
# or the NEXT_PUBLIC_* equivalents used by the dashboard
```

Only the **anon** key is used. The API never reads or returns a service-role key.

Check it quickly in a browser:

- <http://localhost:3000/api/option-chain?symbol=NIFTY&expiry=27-Oct-2026&format=json>
- <http://localhost:3000/api/option-chain?symbol=NIFTY&expiry=27-Oct-2026&format=csv>

If the expiry is unknown, omit it and the API returns the newest snapshot for
that symbol: `/api/option-chain?symbol=NIFTY&format=csv`.

## 2. Create the three parameters

In Excel: **Data > Get Data > From Other Sources > Blank Query**, then
**Home > Manage Parameters > New Parameter**. Create them as **Text**:

| Name | Example value | Notes |
| --- | --- | --- |
| `BaseUrl` | `http://localhost:3000` | origin only, no trailing slash; use your deployed https origin if hosted |
| `pSymbol` | `NIFTY` | `NIFTY`, `BANKNIFTY`, `FINNIFTY` |
| `pExpiry` | `27-Oct-2026` | must match the snapshot expiry exactly, e.g. `27-Oct-2026` |

Rename the queries `BaseUrl`, `pSymbol`, `pExpiry` so the query below resolves
them as steps.

## 3. Recommended query: CSV

CSV repeats the snapshot metadata on every row (`symbol`, `expiry`, `spot`,
`pcr`, `max_pain`, `total_ce_oi`, `total_pe_oi`, `nse_timestamp`,
`snapshot_updated_at`, `status`), so a single table is enough for pivots.

Open **Data > Get Data > From Other Sources > Blank Query**, then
**Home > Advanced Editor** and paste:

```m
let
    Url = BaseUrl & "/api/option-chain?symbol=" & pSymbol
        & "&expiry=" & pExpiry & "&format=csv",

    // ManualStatusHandling lets us read the HTTP status instead of getting an
    // opaque "DataFormat.Error" when the snapshot is missing (404) or the API
    // cannot reach Supabase (502/503).
    Response = Web.Contents(
        BaseUrl,
        [
            RelativePath = "/api/option-chain",
            Query = [ symbol = pSymbol, expiry = pExpiry, format = "csv" ],
            ManualStatusHandling = { 400, 404, 502, 503 }
        ]
    ),
    Status = Value.Metadata(Response)[Response.Status],
    Body = if Status = 200 then Response
        else error Error.Record(
            "NSE snapshot API",
            "HTTP " & Text.From(Status) & " - see " & Url,
            "404 = no snapshot for that symbol/expiry, 503 = read credentials missing, 502 = snapshot unreadable"
        ),

    Source = Csv.Document(
        Body,
        [ Delimiter = ",", Encoding = 65001, QuoteStyle = QuoteStyle.Csv ]
    ),
    Promoted = Table.PromoteHeaders(Source, [ PromoteAllScalars = true ]),

    // Only the metadata columns are text; everything else (STRIKE, CE_*, PE_*)
    // is numeric, so Excel can sort, filter and chart it.
    TextColumns = { "symbol", "expiry", "nse_timestamp", "snapshot_updated_at", "status" },
    Typed = Table.TransformColumnTypes(
        Promoted,
        List.Transform(
            Table.ColumnNames(Promoted),
            each { _, if List.Contains(TextColumns, _) then type text else type number }
        )
    )
in
    Typed
```

Name the query `NseOptionChain`, then **Close & Load To... > Table** on a new
worksheet.

## 4. Alternative query: JSON

Use this if you want the snapshot metrics once, rather than repeated per row.
It returns the same data as `meta`, `fields` and `chain`.

```m
let
    Url = BaseUrl & "/api/option-chain?symbol=" & pSymbol
        & "&expiry=" & pExpiry & "&format=json",

    Response = Web.Contents(
        BaseUrl,
        [
            RelativePath = "/api/option-chain",
            Query = [ symbol = pSymbol, expiry = pExpiry, format = "json" ],
            ManualStatusHandling = { 400, 404, 502, 503 }
        ]
    ),
    Status = Value.Metadata(Response)[Response.Status],
    Json = if Status = 200 then Json.Document(Response)
        else error Error.Record(
            "NSE snapshot API",
            "HTTP " & Text.From(Status) & " - see " & Url,
            "404 = no snapshot for that symbol/expiry, 503 = read credentials missing, 502 = snapshot unreadable"
        ),

    FieldNames = List.Distinct(Json[fields]),
    Rows = Table.FromList(Json[chain], Splitter.SplitByNothing(), { "Record" }),
    Expanded = Table.ExpandRecordColumn(
        Rows, "Record", FieldNames, FieldNames, MissingField.UseNull
    ),

    // Attach the snapshot metadata once per row so the table is self-describing.
    MetaColumns = {
        { "snapshot_symbol", each Json[meta][symbol], type text },
        { "snapshot_expiry", each Json[meta][expiry], type text },
        { "snapshot_spot", each Json[meta][spot], type number },
        { "snapshot_pcr", each Json[meta][pcr], type number },
        { "snapshot_max_pain", each Json[meta][max_pain], type number },
        { "snapshot_total_ce_oi", each Json[meta][total_ce_oi], type number },
        { "snapshot_total_pe_oi", each Json[meta][total_pe_oi], type number },
        { "nse_timestamp", each Json[meta][nse_timestamp], type text },
        { "snapshot_updated_at", each Json[meta][snapshot_updated_at], type text },
        { "snapshot_status", each Json[meta][status], type text },
        { "strike_count", each Json[meta][strike_count], type number }
    ],
    WithMeta = List.Accumulate(
        MetaColumns, Expanded,
        (state, column) => Table.AddColumn(state, column{0}, column{1}, column{2})
    )
in
    WithMeta
```

## 5. Credentials

The API is public read-only, so no credentials are needed at the Excel end:

1. When Excel asks, choose **Anonymous** authentication.
2. If asked about privacy levels, **Ignore** is fine for a localhost API (or
   organise the file into a single privacy level).

Do not add your Supabase URL or keys to a Power Query query - the dashboard
server already holds the anon key, and credentials inside a workbook get shared
with the file.

## 6. Refresh

- **Data > Refresh All** (or **Refresh** in the Queries & Connections pane)
  re-runs the query and reloads the table.
- Change `pSymbol` / `pExpiry` in **Data > Queries & Connections** and refresh to
  switch instrument or expiry - no new workbook needed.
- **Data > Queries & Connections > Properties** lets you set *Refresh every N
  minutes*, but keep it slower than the worker interval (60 s by default) and
  remember the page's own auto-polls are separate.
- Refreshing while the market is closed returns the same close snapshot; the
  `status` column will read `Last Close`. That is honest, not a failure.

### Power BI / Power Automate / scheduled refresh

The same `Web.Contents` queries work in Power BI Desktop. For a scheduled refresh
in the Power BI service or Power Automate, the API must be reachable from
Microsoft's cloud, which means deploying `web/` (for example to Vercel) and
setting `SUPABASE_URL` + `SUPABASE_ANON_KEY` there. `http://localhost:3000` is
only reachable from your own machine.

## 7. What does not refresh

Inside the downloaded `_snapshot.xlsx`:

- `Summary` and `Raw Data` are frozen point-in-time records, including the
  `Snapshot status` cell. They are useful as an audit trail and will not change.
- Only a table created by Power Query (as above) refreshes.
- If you want a live summary, build it on a new sheet with normal formulas over
  the `NseOptionChain` table, e.g.
  `=INDEX(NseOptionChain[nse_timestamp],1)` or a `MAXIFS`/`XLOOKUP` over
  `STRIKE` values, instead of relying on the generated Summary sheet.

## 8. Troubleshooting

| Symptom | Cause / fix |
| --- | --- |
| `HTTP 404` | No snapshot for that symbol/expiry. Check the expiry string and that the worker has pushed data. |
| `HTTP 503` | `SUPABASE_URL` / `SUPABASE_ANON_KEY` are not set in the server environment. |
| `HTTP 502` | Supabase was unreachable, or the stored row is incomplete. The dashboard logs the real error server-side. |
| `HTTP 400` | Bad `symbol`, `expiry` or `format` in the query. |
| `DataSource.Error` / connection refused | The dashboard is not running, or `BaseUrl` points at the wrong port. |
| Table is empty | The API returned a snapshot with no strikes - treat it as broken data, not a market event. |
| Numbers show as text | A stray character in a numeric column; delete the query and re-paste the code above. |
| Status says `Stale` | The stored snapshot is older than the current session, or its NSE timestamp is outside trading hours. Start the worker to get fresh data. |
