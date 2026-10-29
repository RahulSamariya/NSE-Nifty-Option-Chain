import { describe, expect, it } from "vitest";
import JSZip from "jszip";
import {
  buildLocalCsvSetupZipBlob,
  buildSetupZipBlob,
  generateBatchLauncher,
  generateLocalCsvReadme,
  generateLocalCsvSetupScript,
  generatePowerShellSetupScript,
  generateReadme,
  type LocalCsvSetupConfig,
  type SetupPackageConfig,
} from "@/lib/excel-setup-package";

const sampleConfig: SetupPackageConfig = {
  baseUrl: "https://nse-options.example.com",
  symbol: "BANKNIFTY",
  expiry: "27-Oct-2026",
  strikeRange: "20",
  fields: "oi,volume,ltp",
  refreshMinutes: 15,
  autoRefresh: true,
  targetPath: "C:\\Users\\trader\\Documents\\MyOptionChain.xlsx",
};

const localConfig: LocalCsvSetupConfig = {
  symbol: "NIFTY",
  expiry: "29-Oct-2026",
  refreshMinutes: 5,
  autoRefresh: true,
  csvPath: "C:\\Users\\trader\\Documents\\NIFTY_chain.csv",
  targetPath: "C:\\Users\\trader\\Documents\\MyLocalChain.xlsx",
};

describe("excel-setup-package", () => {
  it("generates a valid batch launcher forwarding CLI parameters", () => {
    const bat = generateBatchLauncher();
    expect(bat).toContain("powershell.exe -NoProfile -ExecutionPolicy Bypass");
    expect(bat).toContain("Setup-NSE-Excel.ps1\" %*");
  });

  it("generates a hardened PowerShell setup script with embedded config, M-code, FastCombine, and ListObjects", () => {
    const ps1 = generatePowerShellSetupScript(sampleConfig);
    expect(ps1).toContain("https://nse-options.example.com");
    expect(ps1).toContain("BANKNIFTY");
    expect(ps1).toContain("27-Oct-2026");
    expect(ps1).toContain("SettingsTable");
    expect(ps1).toContain("NseOptionChain");
    expect(ps1).toContain("NseOptionChainRaw");
    expect(ps1).toContain("Queries.FastCombine = $true");
    expect(ps1).toContain("ListObjects.Add(0, $connChain");
    expect(ps1).toContain("ListObjects.Add(0, $connRaw");
    expect(ps1).toContain("OptionChainTable");
    expect(ps1).toContain("RawDataTable");
    expect(ps1).toContain("AddOrUpdateQuery");
    expect(ps1).toContain("RefreshOnFileOpen = $true");
    expect(ps1).toContain("RefreshPeriod = $refreshMinutes");
    expect(ps1).toContain("PreserveFormatting = $true");
    expect(ps1).toContain("New-Object -ComObject Excel.Application");
    expect(ps1).toContain("NSE_Option_Chain_$symbol.xlsx");
    expect(ps1).toContain("OptionChainTable[symbol]");
    expect(ps1).toContain("OptionChainTable[spot]");
    expect(ps1).toContain("OptionChainTable[pcr]");
  });

  it("generates clear setup documentation in README.txt", () => {
    const readme = generateReadme(sampleConfig);
    expect(readme).toContain("Setup-NSE-Excel.bat");
    expect(readme).toContain("https://nse-options.example.com/api/option-chain");
    expect(readme).toContain("MyOptionChain.xlsx");
    expect(readme).toContain("15 min");
    expect(readme).toContain("FastCombine");
    expect(readme).toContain("OptionChainTable");
  });

  it("bundles all required setup assets into a valid zip archive", async () => {
    const blob = await buildSetupZipBlob(sampleConfig);
    expect(blob.size).toBeGreaterThan(500);

    const arrayBuffer = await blob.arrayBuffer();
    const zip = await JSZip.loadAsync(arrayBuffer);

    const fileNames = Object.keys(zip.files);
    expect(fileNames).toContain("Setup-NSE-Excel.bat");
    expect(fileNames).toContain("Setup-NSE-Excel.ps1");
    expect(fileNames).toContain("config.json");
    expect(fileNames).toContain("README.txt");

    const configContent = await zip.file("config.json")?.async("string");
    expect(configContent).toBeDefined();
    const parsed = JSON.parse(configContent!);
    expect(parsed.baseUrl).toBe("https://nse-options.example.com");
    expect(parsed.symbol).toBe("BANKNIFTY");
    expect(parsed.expiry).toBe("27-Oct-2026");
    expect(parsed.strikeRange).toBe("20");
    expect(parsed.fields).toBe("oi,volume,ltp");
    expect(parsed.refreshMinutes).toBe(15);
    expect(parsed.autoRefresh).toBe(true);
    expect(parsed.targetPath).toBe("C:\\Users\\trader\\Documents\\MyOptionChain.xlsx");
  });
});

describe("local-csv setup package (zero-cost workflow)", () => {
  it("generates a PowerShell script with no URL, no localhost, no baseUrl and no web calls", () => {
    const ps1 = generateLocalCsvSetupScript(localConfig);
    expect(ps1).not.toMatch(/https?:\/\//);
    expect(ps1).not.toContain("localhost");
    expect(ps1).not.toContain("baseUrl");
    expect(ps1).not.toContain("/api/");
    expect(ps1).not.toContain("Supabase");
    expect(ps1).not.toMatch(/Invoke-WebRequest|Invoke-RestMethod|WebClient|Start-BitsTransfer/);
    // Refresh is honestly described as a reread of the same file.
    expect(ps1).toContain("does NOT fetch fresh data from NSE");
    expect(ps1).toContain("Refreshing rereads that file only; it does not contact NSE.");
  });

  it("requires an explicit CSV path and never invents one", () => {
    const ps1 = generateLocalCsvSetupScript(localConfig);
    expect(ps1).toContain('[ERROR] No CSV file path was provided.');
    expect(ps1).toContain("This setup needs an explicit local CSV path and will not invent one.");
    expect(ps1).toContain("Test-Path -LiteralPath $CsvPath -PathType Leaf");
    expect(ps1).toContain("[ERROR] The CSV file does not exist:");
    expect(ps1).toContain("Read-Host");
    // A configured path is embedded so first run can be unattended.
    expect(ps1).toContain('$CsvPath = "C:\\Users\\trader\\Documents\\NIFTY_chain.csv"');
    expect(ps1).toContain("NIFTY_chain.csv");

    // With no path supplied, no absolute default is written into the script.
    const noPath = generateLocalCsvSetupScript({ ...localConfig, csvPath: undefined });
    expect(noPath).not.toMatch(/\$CsvPath = "C:/);
    expect(noPath).toContain('[ERROR] No CSV file path was provided.');
    expect(noPath).toContain("Read-Host");
  });

  it("embeds Power Query M that guards the path, schema and expiry", () => {
    const ps1 = generateLocalCsvSetupScript(localConfig);
    // Path guard
    expect(ps1).toContain("File.Contents(CheckedPath)");
    expect(ps1).toContain('No CSV file path is configured.');
    // Quote characters inside the embedded M are backtick-escaped for PowerShell.
    expect(ps1).toContain('otherwise error `"Could not read the CSV file at: `"');
    // Schema guard: a rewritten export fails loudly instead of loading junk.
    expect(ps1).toContain("RequiredCols = {");
    expect(ps1).toContain("missing required column(s)");
    expect(ps1).toContain('Re-export the option chain from the dashboard so the header row matches.');
    // Contract guard: an expiry no longer present is reported, not silently empty.
    expect(ps1).toContain("No rows in ");
    expect(ps1).toContain("The file may cover a different contract; update the Settings sheet");
    // Reads the workbook's own Settings table for symbol/expiry.
    expect(ps1).toContain('[Name=`"SettingsTable`"]');
    expect(ps1).toContain('Text.Upper([symbol]) = EffectiveSymbol');
  });

  it("loads results into replace-not-append Excel tables with interval refresh", () => {
    const ps1 = generateLocalCsvSetupScript(localConfig);
    expect(ps1).toContain("Queries.FastCombine = $true");
    expect(ps1).toContain("AddOrUpdateQuery $wb \"LocalCsvOptionChain\"");
    expect(ps1).toContain("AddOrUpdateQuery $wb \"LocalCsvOptionChainRaw\"");
    expect(ps1).toContain("ListObjects.Add(0, $connChain");
    expect(ps1).toContain("ListObjects.Add(0, $connRaw");
    expect(ps1).toContain('OptionChainTable');
    expect(ps1).toContain('RawDataTable');
    expect(ps1).toContain("RefreshOnFileOpen = $true");
    expect(ps1).toContain("RefreshPeriod = $refreshMinutes");
    expect(ps1).toContain("PreserveFormatting = $true");
    expect(ps1).toContain("New-Object -ComObject Excel.Application");
    expect(ps1).toContain("NSE_Option_Chain_LocalCsv_$symbol.xlsx");
    // Settings table rows drive symbol, expiry and refresh interval.
    expect(ps1).toContain('@("CsvPath", $CsvPath');
    expect(ps1).toContain('@("Symbol", $symbol');
    expect(ps1).toContain('@("Expiry", $expiry');
    expect(ps1).toContain('@("RefreshIntervalMinutes", [string]$refreshMinutes');
  });

  it("documents the workflow and refresh limitations honestly", () => {
    const readme = generateLocalCsvReadme(localConfig);
    expect(readme).toContain("Setup-NSE-Excel.bat");
    expect(readme).toContain("C:\\Users\\trader\\Documents\\NIFTY_chain.csv");
    expect(readme).toContain("NIFTY");
    expect(readme).toContain("29-Oct-2026");
    expect(readme).toContain("Data > Refresh All rereads the SAME local CSV file");
    expect(readme).toContain("It does NOT download new data from NSE");
    expect(readme).toContain("It is not a market data feed.");
    expect(readme).toContain("Excel for the web and Excel on Mac do not run this COM automation");
    expect(readme).toContain("No macros or VBA (.xlsm)");
    // No URL may appear in the local-CSV documentation either.
    expect(readme).not.toMatch(/https?:\/\//);
    expect(readme).not.toContain("localhost");
  });

  it("bundles the local-CSV assets with a config that has no baseUrl", async () => {
    const blob = await buildLocalCsvSetupZipBlob(localConfig);
    expect(blob.size).toBeGreaterThan(500);

    const zip = await JSZip.loadAsync(await blob.arrayBuffer());
    const fileNames = Object.keys(zip.files);
    expect(fileNames).toContain("Setup-NSE-Excel.bat");
    expect(fileNames).toContain("Setup-NSE-Excel.ps1");
    expect(fileNames).toContain("config.json");
    expect(fileNames).toContain("README.txt");

    const parsed = JSON.parse((await zip.file("config.json")!.async("string"))!);
    expect(parsed.source).toBe("local-csv");
    expect(parsed.csvPath).toBe("C:\\Users\\trader\\Documents\\NIFTY_chain.csv");
    expect(parsed.symbol).toBe("NIFTY");
    expect(parsed.expiry).toBe("29-Oct-2026");
    expect(parsed.baseUrl).toBeUndefined();

    // The launcher must not promise hosted/live data for a local file package.
    const bat = await zip.file("Setup-NSE-Excel.bat")!.async("string");
    expect(bat).toContain("local option chain CSV file");
    expect(bat).not.toContain("live hosted");
  });

  it("keeps an empty csvPath in config so first run prompts instead of guessing", async () => {
    const blob = await buildLocalCsvSetupZipBlob({
      ...localConfig,
      csvPath: undefined,
    });
    const zip = await JSZip.loadAsync(await blob.arrayBuffer());
    const parsed = JSON.parse((await zip.file("config.json")!.async("string"))!);
    expect(parsed.csvPath).toBe("");
    expect(parsed.baseUrl).toBeUndefined();
  });
});
