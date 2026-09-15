import { Great_Vibes } from "next/font/google";

// The typed-signature face (addendum C23). ONE next/font object loading every
// Great Vibes subset, so the browser preview can draw whatever the server-side
// stamp (lib/esign/fonts/great-vibes.ts, the same family) accepts. Self-hosted
// at build time: no runtime request to Google. Used by app/sign/layout.tsx (the
// --font-signature variable) and TypedSignaturePreview.
export const greatVibes = Great_Vibes({
  weight: "400",
  subsets: ["latin", "latin-ext", "cyrillic", "cyrillic-ext", "greek-ext", "vietnamese"],
  display: "swap",
  variable: "--font-signature",
});
