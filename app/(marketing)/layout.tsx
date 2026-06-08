import { SiteNav } from "@/components/site-nav";
import { SiteFooter } from "@/components/site-footer";

// Public marketing chrome (header + footer). The portal and login pages live
// outside this group and render without it.
export default function MarketingLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  return (
    <>
      <SiteNav />
      <main>{children}</main>
      <SiteFooter />
    </>
  );
}
