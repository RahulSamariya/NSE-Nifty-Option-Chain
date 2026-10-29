/**
 * Representative NSE option-chain CSV fixtures.
 *
 * Shape A mirrors the real NSE option-chain export: metadata rows, a grouped
 * CALLS/PUTS marker row, calls left of the strike and mirrored puts on the
 * right, Indian thousands separators and "-" for absent values.
 */

/** Shape A: grouped CALLS/PUTS headers with metadata and Indian numerals. */
export const GROUPED_NIFTY_CSV = `Symbol,NIFTY
Expiry Date,29-Oct-2026
Last updated at,29-Oct-2026 15:30:00
Underlying Value,"26,418.85"
,,CALLS,,,,,,,,,PUTS,,,,,,,,,
OI,Chng in OI,Volume,IV,LTP,Chng,Bid Qty,Bid,Ask,Ask Qty,Strike Price,Bid Qty,Bid,Ask,Ask Qty,Chng,LTP,IV,Volume,Chng in OI,OI
"1,25,400","15,250","2,04,150",18.55,150.50,2.50,50,150.40,150.60,75,"26,000",40,40.10,40.30,60,-1.10,40.20,21.05,"9,800","-1,120","2,10,900"
"2,40,100","31,800","3,08,400",17.32,220.75,-0.40,40,220.65,220.85,60,"26,100",55,55.80,56.00,70,0.95,55.90,20.11,"12,400","3,100","3,05,200"
"3,90,500",-2100,"1,05,600",,105.00,,20,104.90,105.10,30,"26,200",25,,,,-,88.05,,"6,100",,"4,77,300"
"4,05,200","-9,450","2,10,300",11.25,12.25,-3.10,15,12.20,12.30,30,"26,300",35,5.40,5.55,45,-0.60,5.45,24.90,"2,300","-4,500","5,90,100"
`;

/** Shape B: single flat header row, duplicated field names around the strike. */
export const FLAT_DUP_HEADER_CSV = `Symbol,NIFTY
Expiry Date,29-Oct-2026
Underlying Value,26418.85
OI,Chng in OI,Volume,IV,LTP,Bid,Ask,Strike Price,Bid,Ask,LTP,IV,Volume,Chng in OI,OI
10000,500,2000,14.5,120.55,120.50,120.60,26300,30.20,30.35,30.25,16.10,1500,-200,9000
12000,700,2600,13.2,95.40,95.35,95.45,26400,45.10,45.25,45.15,15.80,2100,400,11000
`;

/** Shape C: CE_/PE_ prefixed headers, metadata present. */
export const PREFIXED_HEADERS_CSV = `Symbol,BANKNIFTY
Expiry Date,27-Nov-2026
Underlying Value,57210.50
Strike,CE OI,CE Volume,CE IV,CE LTP,PE OI,PE Volume,PE IV,PE LTP
57000,15000,3000,13.1,412.5,18000,2500,14.2,145.3
57200,22000,4100,12.4,260.2,14000,1900,15.0,205.1
`;

/** Missing IV on some rows: must import, and IV must stay absent (not zero). */
export const MISSING_IV_CSV = `Symbol,NIFTY
Expiry Date,29-Oct-2026
Underlying Value,26400.00
OI,Chng in OI,Volume,IV,LTP,Strike Price,LTP,IV,Volume,Chng in OI,OI
5000,100,900,-,110.55,26400,50.25,-,800,-50,4500
6100,200,1200,11.80,88.10,26500,70.40,12.60,950,150,5200
`;

/** Windows CRLF line endings and a UTF-8 BOM. */
export const CRLF_BOM_CSV = "\uFEFF" + FLAT_DUP_HEADER_CSV.replace(/\n/g, "\r\n");

/** A wrong file: comma-separated but not an option chain at all. */
export const NOT_A_CHAIN_CSV = `Date,Open,High,Low,Close
2026-10-27,26100,26300,26050,26250
2026-10-28,26250,26480,26200,26400
`;

/** Duplicate strike, identical rows: the duplicate is ignored with a warning. */
export const DUPLICATE_IDENTICAL_CSV = `Symbol,NIFTY
Expiry Date,29-Oct-2026
Underlying Value,26400
Strike,CE OI,PE OI
26400,5000,4500
26400,5000,4500
26500,6100,5200
`;

/** Duplicate strike with conflicting values: must be rejected. */
export const DUPLICATE_CONFLICT_CSV = `Symbol,NIFTY
Expiry Date,29-Oct-2026
Underlying Value,26400
Strike,CE OI,PE OI
26400,5000,4500
26400,9999,1111
26500,6100,5200
`;

/** Strikes present but every option cell blank: nothing usable to show. */
export const BLANK_OPTION_VALUES_CSV = `Symbol,NIFTY
Expiry Date,29-Oct-2026
Underlying Value,26400
Strike,CE OI,CE LTP,PE OI,PE LTP
26400,-,-,-,-
26500,-,-,-,-
`;

/** No strike column anywhere: rejected before any parsing. */
export const NO_STRIKE_COLUMN_CSV = `Contract,Bid,Ask
NIFTY-OCT,101.5,101.9
NIFTY-NOV,120.1,120.6
`;

/** Supported symbol is missing from the file entirely. */
export const NO_SYMBOL_CSV = `Expiry Date,29-Oct-2026
Underlying Value,26400
Strike,CE OI,PE OI
26400,5000,4500
`;

/** Underlying value absent: spot must not be invented. */
export const NO_SPOT_CSV = `Symbol,NIFTY
Expiry Date,29-Oct-2026
Strike,CE OI,PE OI
26400,5000,4500
`;

/** Expiry absent: contract cannot be identified. */
export const NO_EXPIRY_CSV = `Symbol,NIFTY
Underlying Value,26400
Strike,CE OI,PE OI
26400,5000,4500
`;

/** A symbol the dashboard does not serve. */
export const UNSUPPORTED_SYMBOL_CSV = `Symbol,MIDCPNIFTY
Expiry Date,29-Oct-2026
Underlying Value,12800
Strike,CE OI,PE OI
12800,5000,4500
`;

/** Empty and whitespace-only files. */
export const EMPTY_CSV = "";
export const WHITESPACE_CSV = "   \n\n  \n";
