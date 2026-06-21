import { NextResponse } from "next/server";
import * as XLSX from "xlsx";

// Generates the marketing-revenue import template on the fly so it always
// matches the parser's expected columns (Date / Channel / Revenue). Gated by
// the portal middleware. Sample rows are illustrative — replace with your data.
export async function GET() {
  const sample = [
    { Date: "2026-01-08", Channel: "Google Ads", Revenue: 5200 },
    { Date: "2026-01-15", Channel: "Facebook", Revenue: 3100 },
    { Date: "2026-01-22", Channel: "Referral", Revenue: 2400 },
    { Date: "2026-02-03", Channel: "Google Ads", Revenue: 6100 },
    { Date: "2026-02-12", Channel: "Direct Mail", Revenue: 1800 },
    { Date: "2026-02-20", Channel: "Referral", Revenue: 2900 },
  ];

  const ws = XLSX.utils.json_to_sheet(sample, {
    header: ["Date", "Channel", "Revenue"],
  });
  ws["!cols"] = [{ wch: 14 }, { wch: 22 }, { wch: 12 }];

  const wb = XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(wb, ws, "Revenue");
  const buf = XLSX.write(wb, { type: "buffer", bookType: "xlsx" }) as Buffer;

  return new NextResponse(new Uint8Array(buf), {
    headers: {
      "Content-Type":
        "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
      "Content-Disposition":
        'attachment; filename="gbtn-marketing-revenue-template.xlsx"',
      "Cache-Control": "no-store",
    },
  });
}
