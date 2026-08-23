import { PortalHeader, PortalShell } from "@/components/portal/ui";
import { CrmNav } from "@/components/portal/crm/crm-nav";
import { TwilioForm, CallRailForm } from "@/components/portal/crm/settings-forms";
import { Badge } from "@/components/portal/crm/ui";
import { platformIntegrationInfo } from "@/lib/integrations/platform-secrets";
import { appBaseUrl } from "@/lib/crm/comms";

export default async function CrmSettings() {
  const [twilio, callrail, anthropic] = await Promise.all([
    platformIntegrationInfo("twilio"),
    platformIntegrationInfo("callrail"),
    platformIntegrationInfo("anthropic"),
  ]);
  const base = appBaseUrl();

  const webhooks = [
    { label: "Inbound SMS", url: `${base}/api/twilio/sms` },
    { label: "SMS/Call status callback", url: `${base}/api/twilio/status` },
    { label: "Inbound voice", url: `${base}/api/twilio/voice` },
    { label: "Resend email events", url: `${base}/api/resend/webhook` },
    { label: "Unsubscribe", url: `${base}/api/unsubscribe?c=<contactId>` },
  ];

  return (
    <PortalShell wide>
      <PortalHeader title="CRM Settings" subtitle="Connect Twilio, CallRail, and review your webhook URLs." />
      <CrmNav />

      <div className="mt-6 grid gap-5 lg:grid-cols-2">
        <TwilioForm configured={twilio.configured} />
        <CallRailForm configured={callrail.configured} />
      </div>

      <div className="mt-5 grid gap-5 lg:grid-cols-2">
        <div className="rounded-2xl border border-line bg-white p-6 ring-soft">
          <div className="flex items-center justify-between">
            <h2 className="text-base font-bold text-ink">AI assistant</h2>
            <Badge tone={anthropic.configured ? "green" : "neutral"}>
              {anthropic.configured ? "Connected" : "Not configured"}
            </Badge>
          </div>
          <p className="mt-1 text-sm text-muted">
            Summaries, next-best-action, lead scoring, reply drafting, and the SMS auto-responder use the platform
            Anthropic key. Configure it under Admin → Integrations.
          </p>
        </div>

        <div className="rounded-2xl border border-line bg-white p-6 ring-soft">
          <h2 className="text-base font-bold text-ink">Webhook URLs</h2>
          <p className="mt-1 mb-3 text-sm text-muted">
            Point Twilio Messaging &amp; Voice webhooks here. In Resend, add the email-events endpoint and set
            RESEND_WEBHOOK_SECRET in Vercel.
          </p>
          <ul className="flex flex-col gap-2">
            {webhooks.map((w) => (
              <li key={w.label} className="flex flex-col gap-0.5">
                <span className="text-xs font-semibold text-muted">{w.label}</span>
                <code className="block overflow-x-auto rounded-lg bg-paper-soft px-3 py-2 text-xs text-ink">{w.url}</code>
              </li>
            ))}
          </ul>
        </div>
      </div>
    </PortalShell>
  );
}
