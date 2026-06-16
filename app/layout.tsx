import type { Metadata } from "next";
import { Inter } from "next/font/google";
import { Analytics } from "@vercel/analytics/next";
import "./globals.css";
import { site } from "@/lib/site";

const inter = Inter({
  subsets: ["latin"],
  display: "swap",
  variable: "--font-inter",
});

export const metadata: Metadata = {
  metadataBase: new URL(site.url),
  title: {
    default: `${site.name} · Fractional CFO & Value Creation`,
    template: `%s · ${site.name}`,
  },
  description:
    "Operator-grade fractional CFO led by Tyler Briggs, who scaled a PE-backed platform from $30M to $100M+. The private-equity value-creation playbook, applied to your business.",
  keywords: [
    "fractional CFO",
    "value creation",
    "private equity CFO",
    "FP&A",
    "M&A advisory",
    "home services CFO",
    "EBITDA growth",
    "Tyler Briggs",
  ],
  openGraph: {
    title: `${site.name} · Fractional CFO & Value Creation`,
    description:
      "The private-equity value-creation playbook, applied to your business. Led by an operator who scaled a PE-backed platform past $100M.",
    url: site.url,
    siteName: site.name,
    type: "website",
  },
  twitter: {
    card: "summary_large_image",
    title: `${site.name} · Fractional CFO & Value Creation`,
    description:
      "Operator-grade fractional CFO. The PE value-creation playbook, applied to your business.",
  },
};

export default function RootLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  return (
    <html lang="en" className={inter.variable}>
      <body className="min-h-screen antialiased">
        {children}
        <Analytics />
      </body>
    </html>
  );
}
