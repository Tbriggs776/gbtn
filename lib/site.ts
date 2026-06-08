// ───────────────────────────────────────────────────────────────────────────
// Growth by the Numbers - central content config.
// Edit copy here and it propagates across the whole site.
// ───────────────────────────────────────────────────────────────────────────

export const site = {
  name: "Growth by the Numbers",
  shortName: "GBTN",
  tagline:
    "Build a finance engine your team actually uses, and that sponsors trust.",
  domain: "growthbythenumbers.com",
  url: "https://growthbythenumbers.com",
  founder: {
    name: "Tyler Briggs",
    title: "Founder, President & CFO",
    location: "Arizona · Remote nationwide",
    email: "tyler.briggs@outlook.com",
    phone: "480.407.8503",
    phoneHref: "tel:+14804078503",
    linkedin: "https://www.linkedin.com/in/tylermarkbriggs",
    youtube: "https://www.youtube.com/@Growthbythenumbers",
    calendly: "", // TODO: add scheduling link
  },
} as const;

export const nav = [
  { label: "About", href: "/about" },
  { label: "Services", href: "/services" },
  { label: "Results", href: "/results" },
  { label: "Contact", href: "/contact" },
] as const;

// Top-line credibility stats (founder's resume figures).
export const stats = [
  { value: "$1B+", label: "In acquisitions I've led" },
  { value: "$5B+", label: "In exits I've led" },
  { value: "$30M → $100M+", label: "Revenue scaled as President & CFO" },
  { value: "18%", label: "Annualized EBITDA growth driven" },
  { value: "20+", label: "M&A deals, diligence to integration" },
  { value: "12+ yrs", label: "Inside PE-backed & founder-led operators" },
] as const;

// Logos / platforms the founder has operated inside (real associations).
export const platforms = [
  { name: "Semper Fi Heating & Cooling", note: "Pulte Capital-backed" },
  { name: "Panoramic Health", note: "Audax-backed" },
  { name: "OfferPad", note: "PE-backed iBuyer" },
  { name: "Window Rock Capital", note: "Family office" },
  { name: "Copper Mountain Capital", note: "Founder" },
] as const;

// ── The method: 3 levers + 7 metrics (from the book) ────────────────────────
export const levers = [
  {
    num: "01",
    title: "Revenue Growth",
    body: "Real, organic growth from a healthier pipeline and a better mix, not one-time spikes that break your systems and margins.",
  },
  {
    num: "02",
    title: "Margin Expansion",
    body: "More profit from every dollar of revenue: pricing discipline, labor productivity, material control, and smarter overhead.",
  },
  {
    num: "03",
    title: "Team Leverage",
    body: "More output from the same people. Revenue up, headcount flat: the sign of a business that actually scales.",
  },
] as const;

export const metrics = [
  "Revenue growth rate",
  "Gross margin %",
  "EBITDA margin %",
  "Billable utilization %",
  "Revenue per employee",
  "Customer concentration %",
  "Cash conversion cycle",
] as const;

// ── Productized engagements (the real GBTN offer ladder) ────────────────────
export const services = [
  {
    id: "profit",
    tier: "Diagnostic",
    eyebrow: "Start here",
    title: "Profit by the Numbers",
    timeline: "2-4 weeks",
    price: "$7.5k-$25k",
    summary:
      "A fast, forensic read on where margin and cash are leaking, and the prioritized plan to stop it. Most clients see measurable improvement inside 30 days.",
    deliverables: [
      "Margin bridge + root-cause driver tree (price / mix / labor / material / overhead)",
      "13-week cash forecast baseline + working-capital opportunities",
      "KPI scorecard against the 7 metrics that run your business",
      "Top-10 action plan with owners, timing, and expected impact",
      "Leadership- and sponsor-ready readout",
    ],
    forWho: "Operators who need clarity on margin and cash, fast.",
  },
  {
    id: "scale",
    tier: "Build + Cadence",
    eyebrow: "Build the engine",
    title: "Scale by the Numbers",
    timeline: "6-12 weeks + retainer",
    price: "$15k build + $6-15k/mo",
    summary:
      "The planning and reporting cadence your leadership runs every week, not just month-end financials. We install the operating system and the rhythm that makes it stick.",
    deliverables: [
      "Budget + rolling forecast (best / base / downside)",
      "Unit economics by branch / crew / channel",
      "Monthly close cadence + leadership pack",
      "Weekly KPI dashboard + decision rhythm",
      "Pricing + compensation alignment workshop",
    ],
    forWho: "Growth-stage operators ready for a repeatable operating system.",
  },
  {
    id: "institutional",
    tier: "PE-Ready Platform",
    eyebrow: "Institutional grade",
    title: "Institutional-Grade Scale",
    timeline: "3-6+ months",
    price: "$15k-$35k/mo + projects",
    summary:
      "The full investor-grade finance stack (board reporting, controls, systems, and M&A integration) so value creation becomes repeatable and the platform is ready for its next phase.",
    deliverables: [
      "Board / IC pack with KPI bridges and cohort views",
      "Controls, policy library, and approval matrix",
      "ERP / BI build leadership (selection to implementation)",
      "M&A diligence + 30/60/90 integration playbook",
      "Lender package + covenant-ready reporting",
    ],
    forWho: "PE-backed platforms preparing for a recap, add-ons, or exit.",
  },
] as const;

// Common add-on sprints.
export const addOns = [
  { name: "13-week cash forecast + cash war room", range: "$2.5k-$6k" },
  { name: "Pricing & gross-margin reset sprint", range: "$5k-$12k" },
  { name: "AP/AR cleanup + collections playbook", range: "$3k-$10k" },
  { name: "Job / branch profitability build", range: "$5k-$15k" },
  { name: "Vendor negotiation sprint", range: "$3k-$8k + savings share" },
  { name: "Post-acquisition integration sprint (30/60/90)", range: "$7.5k-$20k" },
] as const;

// Who GBTN serves: two related audiences.
export const audiences = [
  {
    title: "Founder-led operators",
    body: "Home & field services and multi-location businesses ($5M-$150M) where execution and unit economics decide whether growth turns into profit.",
    points: ["HVAC, plumbing, electrical, roofing, landscaping", "Multi-location & regional branch models", "Asset-heavy, job-level profitability"],
  },
  {
    title: "PE-backed platforms",
    body: "Sponsors and portfolio CEOs who need investor-grade visibility, covenant-ready cash, and repeatable value-creation workstreams across a roll-up.",
    points: ["Roll-up & integration-heavy platforms", "Board / IC reporting and KPI bridges", "Recap, add-on, or exit readiness"],
  },
] as const;

// "How it works": 3-step engagement.
export const process = [
  {
    step: "01",
    title: "Diagnostic",
    body: "We start with a forensic look at your numbers, systems, and goals: a margin bridge, a cash map, and a clear read on what's working and what's leaking.",
  },
  {
    step: "02",
    title: "Build the cadence",
    body: "I install the financial infrastructure that fits your stage (forecast, unit economics, KPI dashboard) and the weekly rhythm your team runs on.",
  },
  {
    step: "03",
    title: "Drive the numbers",
    body: "Hands-on partnership. We run the cadence, make decisions on real data, and compound margin and cash quarter over quarter.",
  },
] as const;

// Founder career timeline / track record.
export const trackRecord = [
  {
    company: "Semper Fi Heating & Cooling",
    role: "President & Chief Financial Officer",
    period: "2022-2025",
    backer: "Pulte Capital",
    sector: "Home Services / HVAC",
    highlight:
      "Scaled the platform from ~$30M to $100M+ in revenue in three years while driving 18% annualized EBITDA growth.",
    points: [
      "Led 10+ M&A transactions from diligence through post-close integration, exceeding pro-forma targets.",
      "Built the finance function from the ground up: FP&A, KPI dashboards, SOPs, and operating cadence.",
      "Negotiated banking, insurance, and vendor terms for $2M+ in annual savings.",
      "Partnered directly with the board and PE sponsor on capital allocation and exit planning.",
    ],
  },
  {
    company: "Panoramic Health",
    role: "Financial Integrations Manager",
    period: "2021-2022",
    backer: "Audax Private Equity",
    sector: "Healthcare Platform",
    highlight:
      "Drove financial integration across a fast-acquiring, PE-backed nephrology platform.",
    points: [
      "Integrated 5+ simultaneous practice acquisitions inside 12 months.",
      "Built KPI frameworks and dashboards that cut post-integration variance ~20%.",
      "Served as a key execution partner to platform leadership during rapid roll-up activity.",
    ],
  },
  {
    company: "OfferPad",
    role: "Property Success Manager",
    period: "2017-2018",
    backer: "PE-backed iBuyer (later public)",
    sector: "Real Estate / PropTech",
    highlight:
      "Operated inside one of the original iBuyer platforms at national scale.",
    points: [
      "Built national holding procedures for 500+ properties per month.",
      "Partnered with PE leadership to sharpen acquisition modeling and decision support.",
    ],
  },
  {
    company: "Window Rock Capital Partners",
    role: "Associate",
    period: "2012-2015",
    backer: "Family Office Investment Arm",
    sector: "Real Estate / Funds",
    highlight:
      "Cut my teeth on the capital side: REIT accounting and fund structuring.",
    points: [
      "Supported capital raises exceeding $100M and $50M+ in new investor commitments.",
      "Developed underwriting criteria and acquisition models aligned to fund return targets.",
    ],
  },
  {
    company: "Copper Mountain Capital",
    role: "Founder",
    period: "2014-2021",
    backer: "Independent Advisory",
    sector: "Multi-Industry",
    highlight:
      "Founded an advisory practice, the forerunner to Growth by the Numbers.",
    points: [
      "Delivered accounting, FP&A, and fund structuring across $200M+ in aggregate deal value.",
      "Advised ownership teams on acquisition modeling, capital raising, and performance tracking.",
    ],
  },
] as const;

// Hard-outcome case study cards.
export const results = [
  {
    metric: "$30M → $100M+",
    title: "From regional contractor to platform",
    sector: "PE-backed home services",
    body: "As President & CFO, professionalized finance and operating discipline to triple-plus revenue in three years, turning a founder-led business into an institutional-grade platform.",
  },
  {
    metric: "18%",
    title: "EBITDA growth, every year",
    sector: "Home services",
    body: "FP&A infrastructure, KPI dashboards, and SOPs created the visibility and accountability that compounded margin year over year.",
  },
  {
    metric: "20+ deals",
    title: "Acquisitions that actually integrate",
    sector: "Healthcare & home services",
    body: "Across two PE-backed platforms, led M&A from target evaluation through the post-close integration where most deals lose their synergies.",
  },
  {
    metric: "$2M+",
    title: "Found in the cost structure",
    sector: "Multi-entity operator",
    body: "Renegotiated banking, insurance, and vendor agreements, with annual savings that dropped straight to EBITDA and enterprise value.",
  },
] as const;

// What makes GBTN different.
export const differentiators = [
  {
    title: "Operator-first",
    body: "I translate finance into daily actions for GMs, dispatch, sales, and production, not slide decks nobody opens.",
  },
  {
    title: "PE-fluent",
    body: "IC-level models, KPI bridges, covenant reporting, and value-creation workstreams sponsors actually trust.",
  },
  {
    title: "I've actually done it",
    body: "I sat in the President and CFO seats of PE-backed companies and scaled one past $100M. This isn't theory.",
  },
  {
    title: "Hands-on, not hand-off",
    body: "I build the models and the cadence myself. When you hire Growth by the Numbers, you get me, the operator.",
  },
] as const;

// The book.
export const book = {
  title: "Growth by the Numbers",
  subtitle: "The operator's system for turning gut into truth.",
  blurb:
    "The seven metrics, the weekly cadence, and the 90-day operating transformation that move smart, hardworking operators off gut instinct and onto a system that compounds.",
} as const;

// The podcast.
export const podcast = {
  name: "Building a Budget",
  blurb:
    "Straight-talk finance for operators: how to read your numbers and use them to run a better business.",
} as const;
