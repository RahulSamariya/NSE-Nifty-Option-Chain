"use client";

import React, { useCallback, useRef, useState } from "react";
import {
  AlertCircle,
  CheckCircle2,
  Download,
  FileText,
  Loader2,
  Upload,
} from "lucide-react";
import {
  SUPPORTED_SYMBOLS,
  parseNseOptionChainCsv,
  type CsvImportMeta,
} from "@/lib/nse-csv-import";
import type { OptionChainRecord } from "@/types/option-chain";

/** Only CSV text is accepted; nothing here ever leaves the browser. */
const ACCEPTED_EXTENSIONS = [".csv", ".txt"];

interface ImportCsvPanelProps {
  onImport: (record: OptionChainRecord, meta: CsvImportMeta) => void;
  /** True while the dashboard is showing an imported snapshot. */
  hasImport: boolean;
  onClear: () => void;
  /** Disables the picker while an export or import is in flight. */
  busy?: boolean;
}

type PanelState =
  | { phase: "idle" }
  | { phase: "parsing"; fileName: string }
  | { phase: "success"; meta: CsvImportMeta }
  | { phase: "error"; fileName: string; message: string };

function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(2)} MB`;
}

function formatIst(iso: string): string {
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return iso;
  return date.toLocaleString("en-GB", {
    timeZone: "Asia/Kolkata",
    hour12: false,
    day: "2-digit",
    month: "short",
    year: "numeric",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
  });
}

export function ImportCsvPanel({
  onImport,
  hasImport,
  onClear,
  busy = false,
}: ImportCsvPanelProps) {
  const inputRef = useRef<HTMLInputElement>(null);
  const [state, setState] = useState<PanelState>({ phase: "idle" });
  const [isDragging, setIsDragging] = useState(false);

  // The panel is the only control that clears the import, so its own handler
  // resets the banner; no effect is needed to track the parent's flag.
  const handleClear = () => {
    setState({ phase: "idle" });
    onClear();
  };

  const handleFile = useCallback(
    async (file: File) => {
      const extension = file.name.slice(file.name.lastIndexOf(".")).toLowerCase();
      if (!ACCEPTED_EXTENSIONS.includes(extension)) {
        setState({
          phase: "error",
          fileName: file.name,
          message:
            `"${file.name}" is not a CSV file. Save the option chain from the NSE ` +
            "option chain page as CSV and upload that file.",
        });
        return;
      }

      setState({ phase: "parsing", fileName: file.name });
      // Yield a frame so the loading state paints before the synchronous parse.
      await new Promise((resolve) => setTimeout(resolve, 0));

      let text: string;
      try {
        text = await file.text();
      } catch {
        setState({
          phase: "error",
          fileName: file.name,
          message: "The file could not be read. Try downloading it again from NSE.",
        });
        return;
      }

      const result = parseNseOptionChainCsv(text, {
        fileName: file.name,
        fileSize: file.size,
      });

      if (!result.ok) {
        setState({ phase: "error", fileName: file.name, message: result.error });
        return;
      }

      setState({ phase: "success", meta: result.meta });
      onImport(result.record, result.meta);
    },
    [onImport],
  );

  const onDrop = (event: React.DragEvent) => {
    event.preventDefault();
    setIsDragging(false);
    if (busy || state.phase === "parsing") return;
    const file = event.dataTransfer.files?.[0];
    if (file) void handleFile(file);
  };

  return (
    <section
      aria-labelledby="csv-import-title"
      className="rounded-xl border border-zinc-800 bg-zinc-900/50 p-4"
    >
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div>
          <h2
            id="csv-import-title"
            className="flex items-center gap-2 text-sm font-bold text-zinc-100"
          >
            <FileText className="h-4 w-4 text-emerald-400" />
            Import NSE CSV
          </h2>
          <p className="mt-1 text-xs text-zinc-400">
            Download the option chain CSV from the NSE option chain page, then drop it here.
            The file is parsed in this browser and is never uploaded to any server.
          </p>
        </div>
        {hasImport && (
          <button
            type="button"
            onClick={handleClear}
            className="rounded-md border border-zinc-700 bg-zinc-900 px-3 py-1.5 text-xs font-semibold text-zinc-300 transition-colors hover:bg-zinc-800"
          >
            Clear imported snapshot
          </button>
        )}
      </div>

      {/* Drop zone + picker */}
      <div
        onDragOver={(event) => {
          event.preventDefault();
          setIsDragging(true);
        }}
        onDragLeave={() => setIsDragging(false)}
        onDrop={onDrop}
        className={`mt-3 flex flex-col items-center justify-center gap-2 rounded-lg border-2 border-dashed px-4 py-6 text-center transition-colors ${
          isDragging
            ? "border-emerald-500 bg-emerald-500/10"
            : "border-zinc-700 bg-zinc-950/40"
        }`}
      >
        {state.phase === "parsing" ? (
          <Loader2 className="h-6 w-6 animate-spin text-emerald-400" />
        ) : (
          <Upload className="h-6 w-6 text-zinc-500" />
        )}
        <p className="text-xs text-zinc-300">
          {state.phase === "parsing"
            ? `Parsing ${state.fileName}…`
            : "Drag a CSV file here, or"}
        </p>
        <button
          type="button"
          onClick={() => inputRef.current?.click()}
          disabled={busy || state.phase === "parsing"}
          className="rounded-md bg-emerald-500/10 border border-emerald-500/40 px-3 py-1.5 text-xs font-semibold text-emerald-300 transition-colors hover:bg-emerald-500/20 disabled:opacity-50"
        >
          Choose CSV file
        </button>
        <input
          ref={inputRef}
          type="file"
          accept=".csv,.txt,text/csv"
          className="sr-only"
          onChange={(event) => {
            const file = event.target.files?.[0];
            if (file) void handleFile(file);
            // Allow re-picking the same file after a failure.
            event.target.value = "";
          }}
        />
        <p className="text-[11px] text-zinc-500">
          Supported: {SUPPORTED_SYMBOLS.join(", ")} · .csv · parsed in-browser only
        </p>
      </div>

      {/* Result states */}
      {state.phase === "error" && (
        <div
          role="alert"
          className="mt-3 flex items-start gap-3 rounded-lg border border-rose-900/70 bg-rose-950/30 p-3 text-xs text-rose-200"
        >
          <AlertCircle className="mt-0.5 h-4 w-4 shrink-0" />
          <div>
            <p className="font-semibold">Could not import {state.fileName}</p>
            <p className="mt-1 text-rose-200/85">{state.message}</p>
            <p className="mt-1 text-rose-200/70">
              The previously displayed snapshot has been kept. No values were changed.
            </p>
          </div>
        </div>
      )}

      {state.phase === "success" && (
        <div
          role="status"
          className="mt-3 rounded-lg border border-emerald-500/30 bg-emerald-500/10 p-3 text-xs text-emerald-200"
        >
          <p className="flex items-center gap-2 font-semibold">
            <CheckCircle2 className="h-4 w-4" />
            Imported {state.meta.fileName} · {formatBytes(state.meta.fileSize)}
          </p>
          <div className="mt-2 grid grid-cols-2 gap-x-4 gap-y-1 sm:grid-cols-4">
            <div>
              <span className="text-emerald-300/70">Symbol</span>
              <p className="font-semibold text-emerald-100">{state.meta.symbol}</p>
            </div>
            <div>
              <span className="text-emerald-300/70">Expiry</span>
              <p className="font-semibold text-emerald-100">{state.meta.expiry}</p>
            </div>
            <div>
              <span className="text-emerald-300/70">Strikes</span>
              <p className="font-semibold text-emerald-100">{state.meta.rowCount}</p>
            </div>
            <div>
              <span className="text-emerald-300/70">Spot</span>
              <p className="font-semibold text-emerald-100">{state.meta.spot.toLocaleString("en-IN")}</p>
            </div>
            <div>
              <span className="text-emerald-300/70">Imported at</span>
              <p className="font-semibold text-emerald-100">{formatIst(state.meta.importedAt)} IST</p>
            </div>
            <div className="col-span-2 sm:col-span-3">
              <span className="text-emerald-300/70">Exchange timestamp</span>
              <p className="font-semibold text-emerald-100">
                {state.meta.exchangeTimestamp ?? "Not present in the file — import time shown instead"}
              </p>
            </div>
          </div>
          {state.meta.warnings.length > 0 && (
            <ul className="mt-2 list-disc pl-5 text-[11px] text-emerald-300/80">
              {state.meta.warnings.map((warning) => (
                <li key={warning}>{warning}</li>
              ))}
            </ul>
          )}
        </div>
      )}

      <p className="mt-3 text-[11px] leading-relaxed text-zinc-500">
        <Download className="mr-1 inline h-3 w-3" />
        After a successful import, use <strong className="text-zinc-300">Download Excel</strong> to
        build a formatted .xlsx in this browser from the imported snapshot. Nothing is sent to a
        server, and no account or API key is needed.
      </p>
    </section>
  );
}
