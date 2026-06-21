import { type NextRequest, NextResponse } from "next/server";
import type { EmailOtpType } from "@supabase/supabase-js";
import { createClient } from "@/lib/supabase/server";
import { sendEmail, emailLayout } from "@/lib/email";

// Handles BOTH email-link flows so a single redirect target works everywhere:
//   • ?token_hash=&type=   → verifyOtp  (magic links / invites, cross-device safe)
//   • ?code=               → exchangeCodeForSession (PKCE, same-device)
export async function GET(request: NextRequest) {
  const { searchParams, origin } = request.nextUrl;
  const tokenHash = searchParams.get("token_hash");
  const type = searchParams.get("type") as EmailOtpType | null;
  const code = searchParams.get("code");
  const next = searchParams.get("next") ?? "/portal";

  const supabase = await createClient();

  if (tokenHash && type) {
    const { data, error } = await supabase.auth.verifyOtp({
      type,
      token_hash: tokenHash,
    });
    if (!error) {
      // Security notification: the email address change just completed.
      if (type === "email_change" && data.user?.email) {
        const email = data.user.email;
        const html = emailLayout({
          heading: "Your email address was changed",
          bodyHtml: `The email address on your Growth by the Numbers account was changed to <strong style="color:#11294a">${email}</strong>. If this was you, no action is needed.
            <div style="font-size:14px;line-height:1.6;color:#3a4252;background:#fbf8f2;border-left:3px solid #9e2335;border-radius:0 8px 8px 0;padding:14px 16px;margin:22px 0 0;"><strong style="color:#11294a;">Didn't make this change?</strong> Contact us immediately at tyler@tylermbriggs.com.</div>`,
        });
        try {
          await sendEmail({
            to: email,
            subject: "Your email address was changed · Growth by the Numbers",
            html,
          });
        } catch {
          /* non-fatal: the change still succeeded */
        }
      }
      return NextResponse.redirect(`${origin}${next}`);
    }
  } else if (code) {
    const { error } = await supabase.auth.exchangeCodeForSession(code);
    if (!error) return NextResponse.redirect(`${origin}${next}`);
  }

  return NextResponse.redirect(`${origin}/login?error=auth`);
}
