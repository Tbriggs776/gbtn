# Growth by the Numbers

Marketing site for **Growth by the Numbers (GBTN)** — Tyler Briggs' fractional CFO &
value-creation practice. Built with Next.js (App Router) + Tailwind CSS v4,
designed for deployment on Vercel.

## Stack

- **Next.js 15** (App Router, React 19, static export of all routes)
- **Tailwind CSS v4** (CSS-first config in `app/globals.css`)
- **TypeScript**

## Develop

```bash
npm install
npm run dev      # http://localhost:3000
npm run build    # production build
```

## Project structure

```
app/
  layout.tsx        Root layout, nav + footer, global metadata
  page.tsx          Home
  about/            About / track record (the trust engine)
  services/         3-tier service matrix + engagement model
  results/          Outcome / case-study cards
  contact/          Contact details + inquiry form
  sitemap.ts        Generated sitemap
  robots.ts         robots.txt
  icon.svg          Favicon
components/
  ui.tsx            Primitives (Container, Section, Button, Card, etc.)
  sections.tsx      Reusable blocks (StatBar, LogoWall, ProcessSteps, CtaBand)
  site-nav.tsx      Header / mobile nav
  site-footer.tsx   Footer
  contact-form.tsx  Inquiry form (currently mailto-based)
lib/
  site.ts           ★ Single source of truth for all site copy & data
```

## Editing content

Almost all copy — services, stats, track record, results, contact details —
lives in [`lib/site.ts`](lib/site.ts). Edit there and it propagates across pages.

## Open TODOs (search the codebase for `TODO:`)

- Confirm final **domain** and public **email** (`lib/site.ts`).
- Add Tyler's **headshot** to `/public` and swap the placeholder in `app/about/page.tsx`.
- Confirm realized **exit outcomes** (acquirer / value / multiple) for the About page.
- Add **Calendly** link (`site.founder.calendly`) to enable the booking embed on Contact.
- Replace the **placeholder testimonial** on the home page with a real, attributed quote.
- Wire the contact form to a real endpoint (e.g. Formspree) to replace the mailto fallback.

## Deploy

Push to GitHub and import the repo in Vercel (zero-config for Next.js), or run
`vercel` from the project root.
