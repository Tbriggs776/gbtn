"use client";

import { Analytics } from "@vercel/analytics/next";

// A signing link's path segment is the capability itself (/sign/<token>), so it
// must never reach Vercel Analytics. beforeSend is a function prop, which can't
// cross from the server root layout into a client component — hence this
// wrapper. The Next adapter already reports the route as /sign/[token]; this
// redacts the URL too.
export function SiteAnalytics() {
  return (
    <Analytics
      beforeSend={(event) => ({
        ...event,
        url: event.url.replace(/\/sign\/[^/?#]+/, "/sign/[token]"),
      })}
    />
  );
}
