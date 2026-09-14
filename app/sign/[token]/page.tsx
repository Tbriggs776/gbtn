import type { Metadata } from "next";
import { unstable_rethrow } from "next/navigation";
import { SigningFlow } from "@/components/esign/signing-flow";
import { loadSigningView } from "@/lib/esign/engine";
import { TOKEN_RE, type SigningView } from "@/lib/esign/types";

export const dynamic = "force-dynamic";

export const metadata: Metadata = {
  title: "Review & sign",
  robots: {
    index: false,
    follow: false,
    nocache: true,
    googleBot: { index: false, follow: false },
  },
  referrer: "no-referrer",
};

export default async function SignPage({
  params,
}: {
  params: Promise<{ token: string }>;
}) {
  const { token } = await params;

  // Shape check first: a junk path never reaches the engine and is never echoed
  // back into the client payload. (loadSigningView repeats the check itself.)
  if (!TOKEN_RE.test(token)) {
    return <SigningFlow token="" initial={{ state: "invalid" }} />;
  }

  // Pure read — no viewed/expired writes — so mail scanners and link unfurlers
  // fetching this page leave no evidence. "viewed" is recorded only when the
  // signer clicks "Review the document".
  let view: SigningView;
  try {
    view = await loadSigningView(token);
  } catch (e) {
    unstable_rethrow(e);
    // Contracted never to throw. If it does, say so plainly rather than blanking
    // the page (there is no error.tsx) or calling a live link invalid.
    console.error("[esign] sign page load failed", e instanceof Error ? e.name : "error");
    return (
      <section className="rounded-2xl border border-line bg-white p-5 text-center sm:p-6">
        <h1 className="text-xl font-bold tracking-tight text-ink">
          We couldn&apos;t load this document right now.
        </h1>
        <p className="mt-2 text-sm text-muted">
          Refresh the page in a moment. If it keeps happening, contact GBTN.
        </p>
      </section>
    );
  }

  return <SigningFlow token={token} initial={view} />;
}
