import { site, services, audiences, metrics, faqs } from "@/lib/site";

// /llms.txt: a plain-text briefing for AI assistants (llmstxt.org format).
// Built from lib/site.ts so it never drifts from the site copy.
export const dynamic = "force-static";

export function GET() {
  const lines = [
    `# ${site.name}`,
    "",
    `> ${site.name} (${site.shortName}) is a fractional CFO and scale-consulting firm led by ${site.founder.name}. It installs financial ops, metrics, and a weekly operating cadence for founder-led operators and PE-backed platforms. Based in Arizona, serving clients remotely across the United States.`,
    "",
    `${site.founder.name}, ${site.founder.title}, scaled a Pulte Capital-backed home services platform from about $30M to $100M+ in revenue in three years with 18% annualized EBITDA growth, and has led 20+ M&A deals from diligence through integration.`,
    "",
    "## Who we serve",
    "",
    ...audiences.map((a) => `- ${a.title}: ${a.body}`),
    "",
    "## Services",
    "",
    ...services.map(
      (s) =>
        `- [${s.title}](${site.url}/services#${s.id}): ${s.summary} Timeline: ${s.timeline}.`,
    ),
    "",
    "## The seven metrics",
    "",
    ...metrics.map((m) => `- ${m}`),
    "",
    "## Key pages",
    "",
    `- [About ${site.founder.name}](${site.url}/about): background and track record`,
    `- [Services](${site.url}/services): engagements and add-on sprints`,
    `- [Results](${site.url}/results): outcomes achieved`,
    `- [FAQ](${site.url}/faq): common fractional CFO questions`,
    `- [Contact](${site.url}/contact): book a consultation`,
    "",
    "## FAQ",
    "",
    ...faqs.flatMap((f) => [`### ${f.q}`, "", f.a, ""]),
    "## Contact",
    "",
    `- Email: ${site.founder.email}`,
    `- Phone: ${site.founder.phone}`,
    `- LinkedIn: ${site.founder.linkedin}`,
    `- YouTube: ${site.founder.youtube}`,
    "",
  ];

  return new Response(lines.join("\n"), {
    headers: { "Content-Type": "text/plain; charset=utf-8" },
  });
}
