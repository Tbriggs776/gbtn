import { site, services, audiences, faqs, trackRecord } from "@/lib/site";

// ───────────────────────────────────────────────────────────────────────────
// schema.org JSON-LD for the public site. Search engines and AI assistants
// read these graphs to learn who the firm is, who leads it and what it sells,
// so every value comes from lib/site.ts rather than being restated here.
// ───────────────────────────────────────────────────────────────────────────

const orgId = `${site.url}/#organization`;
const founderId = `${site.url}/#founder`;
const websiteId = `${site.url}/#website`;

const sameAs = [site.founder.linkedin, site.founder.youtube].filter(Boolean);

export function organizationGraph() {
  return {
    "@context": "https://schema.org",
    "@graph": [
      {
        "@type": ["ProfessionalService", "Organization"],
        "@id": orgId,
        name: site.name,
        alternateName: site.shortName,
        legalName: site.legalName,
        url: site.url,
        logo: `${site.url}/brand/logo/mark-cream-navy.svg`,
        image: `${site.url}/brand/social/og-card-1200x630.png`,
        description:
          "Fractional CFO and scale-consulting firm that installs financial ops, metrics, and a weekly operating cadence for founder-led and PE-backed companies.",
        slogan: site.tagline,
        email: site.founder.email,
        telephone: site.founder.phoneHref.replace("tel:", ""),
        address: {
          "@type": "PostalAddress",
          addressRegion: "AZ",
          addressCountry: "US",
        },
        areaServed: { "@type": "Country", name: "United States" },
        founder: { "@id": founderId },
        sameAs,
        knowsAbout: [
          "Fractional CFO services",
          "Financial planning and analysis (FP&A)",
          "Private equity value creation",
          "EBITDA growth",
          "13-week cash flow forecasting",
          "Mergers and acquisitions integration",
          "Home services and HVAC finance",
          "KPI dashboards and board reporting",
        ],
        audience: audiences.map((a) => ({
          "@type": "BusinessAudience",
          audienceType: a.title,
          description: a.body,
        })),
        hasOfferCatalog: {
          "@type": "OfferCatalog",
          name: "Fractional CFO engagements",
          itemListElement: services.map((s) => ({
            "@type": "Offer",
            itemOffered: {
              "@type": "Service",
              name: s.title,
              description: s.summary,
              url: `${site.url}/services#${s.id}`,
            },
          })),
        },
      },
      {
        "@type": "Person",
        "@id": founderId,
        name: site.founder.name,
        jobTitle: site.founder.title,
        worksFor: { "@id": orgId },
        url: `${site.url}/about`,
        image: `${site.url}/headshot-a.jpg`,
        sameAs: [site.founder.linkedin],
        alumniOf: { "@type": "CollegeOrUniversity", name: "University of Phoenix" },
        hasCredential: {
          "@type": "EducationalOccupationalCredential",
          name: "QuickBooks ProAdvisor",
        },
        hasOccupation: trackRecord.map((t) => ({
          "@type": "Role",
          roleName: t.role,
          description: `${t.company} (${t.backer}), ${t.period}`,
        })),
      },
      {
        "@type": "WebSite",
        "@id": websiteId,
        url: site.url,
        name: site.name,
        publisher: { "@id": orgId },
        inLanguage: "en-US",
      },
    ],
  };
}

export function servicesGraph() {
  return {
    "@context": "https://schema.org",
    "@graph": services.map((s) => ({
      "@type": "Service",
      "@id": `${site.url}/services#${s.id}`,
      name: s.title,
      serviceType: "Fractional CFO services",
      description: `${s.summary} Typical timeline: ${s.timeline}. ${s.forWho}`,
      provider: { "@id": orgId },
      areaServed: { "@type": "Country", name: "United States" },
    })),
  };
}

export function faqGraph() {
  return {
    "@context": "https://schema.org",
    "@type": "FAQPage",
    mainEntity: faqs.map((f) => ({
      "@type": "Question",
      name: f.q,
      acceptedAnswer: { "@type": "Answer", text: f.a },
    })),
  };
}
