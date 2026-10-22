import { SiteNav } from "@/components/site-nav";
import { SiteFooter } from "@/components/site-footer";
import { JsonLd } from "@/components/json-ld";
import { organizationGraph } from "@/lib/structured-data";

// Public marketing chrome (header + footer). The portal and login pages live
// outside this group and render without it. Every marketing page also carries
// the firm's Organization / Person / WebSite JSON-LD for search and AI readers.
export default function MarketingLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  return (
    <>
      <JsonLd data={organizationGraph()} />
      <SiteNav />
      <main>{children}</main>
      <SiteFooter />
    </>
  );
}
