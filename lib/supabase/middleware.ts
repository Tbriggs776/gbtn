import { createServerClient } from "@supabase/ssr";
import { NextResponse, type NextRequest } from "next/server";
import { SUPABASE_ANON_KEY, SUPABASE_URL, isSupabaseConfigured } from "./config";

// Refreshes the auth session on every request and guards /portal/*.
export async function updateSession(request: NextRequest) {
  let supabaseResponse = NextResponse.next({ request });

  const path = request.nextUrl.pathname;
  const isPortal = path.startsWith("/portal");

  // Before keys are configured: let the marketing site work; send portal hits
  // to /login (which renders a "not configured yet" notice).
  if (!isSupabaseConfigured) {
    if (isPortal) {
      const url = request.nextUrl.clone();
      url.pathname = "/login";
      return NextResponse.redirect(url);
    }
    return supabaseResponse;
  }

  const supabase = createServerClient(SUPABASE_URL, SUPABASE_ANON_KEY, {
    cookies: {
      getAll() {
        return request.cookies.getAll();
      },
      setAll(cookiesToSet) {
        cookiesToSet.forEach(({ name, value }) =>
          request.cookies.set(name, value)
        );
        supabaseResponse = NextResponse.next({ request });
        cookiesToSet.forEach(({ name, value, options }) =>
          supabaseResponse.cookies.set(name, value, options)
        );
      },
    },
  });

  // IMPORTANT: getUser() revalidates the token with Supabase Auth. Do not put
  // logic between createServerClient and getUser().
  const {
    data: { user },
  } = await supabase.auth.getUser();

  if (!user && isPortal) {
    const url = request.nextUrl.clone();
    url.pathname = "/login";
    url.searchParams.set("redirect", path);
    return NextResponse.redirect(url);
  }

  // Signed-in users shouldn't sit on the login page.
  if (user && path === "/login") {
    const url = request.nextUrl.clone();
    url.pathname = "/portal";
    url.search = "";
    return NextResponse.redirect(url);
  }

  return supabaseResponse;
}
