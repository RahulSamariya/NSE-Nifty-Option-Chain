import type { Metadata } from "next";
import { StatusView } from "@/components/StatusView";

export const metadata: Metadata = {
  title: "System Status — NSE Option Chain Collector",
  description:
    "Live health of the NSE option-chain collector: last database write, snapshot freshness, market session and per-symbol status.",
};

/**
 * Server shell around the client status view: the page itself is static, and
 * all data is read client-side from GET /api/health so it always reflects the
 * collector's current state rather than a build-time snapshot.
 */
export default function StatusPage() {
  return <StatusView />;
}
