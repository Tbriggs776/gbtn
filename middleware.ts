import { NextResponse, type NextRequest } from "next/server";

// Lightweight, Edge-safe gate for /portal/*. This file imports nothing beyond
// next/server on purpose: any import that transitively touches @supabase/* pulls
// Node-only APIs the Edge runtime rejects at deploy. The authoritative session
// check runs server-side in app/portal/layout.tsx via requireSession(); this is
// just a fast first gate. NEXT_PUBLIC_* env vars are inlined at build time.
export function middleware(request: NextRequest) {
  const { pathname } = request.nextUrl;

  const configured = Boolean(
    process.env.NEXT_PUBLIC_SUPABASE_URL &&
      process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY
  );

  if (!configured) {
    const url = request.nextUrl.clone();
    url.pathname = "/login";
    url.search = "";
    return NextResponse.redirect(url);
  }

  const hasAuthCookie = request.cookies
    .getAll()
    .some((c) => c.name.startsWith("sb-") && c.name.includes("-auth-token"));

  if (!hasAuthCookie) {
    const url = request.nextUrl.clone();
    url.pathname = "/login";
    url.searchParams.set("redirect", pathname);
    return NextResponse.redirect(url);
  }

  return NextResponse.next();
}

export const config = {
  // Only guard the portal. Marketing and auth routes skip middleware entirely.
  matcher: ["/portal/:path*"],
};
