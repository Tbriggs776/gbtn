import Link from "next/link";
import { notFound } from "next/navigation";
import { createClient } from "@/lib/supabase/server";
import { PortalShell } from "@/components/portal/ui";
import { ContactWorkspace } from "@/components/portal/crm/contact-workspace";
import {
  getContact,
  getContactTimeline,
  getContactTasks,
  getContactDeals,
  getContactCases,
  getLastEnrollment,
} from "@/lib/crm/service";
import { contactName, contactInitials } from "@/lib/crm/types";

export default async function ContactDetail({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const db = await createClient();
  const contact = await getContact(db, id);
  if (!contact) notFound();

  const [timeline, tasks, deals, cases, lastEnrollment] = await Promise.all([
    getContactTimeline(db, id),
    getContactTasks(db, id),
    getContactDeals(db, id),
    getContactCases(db, id),
    getLastEnrollment(db, id),
  ]);

  return (
    <PortalShell wide>
      <Link href="/portal/crm/contacts" className="text-sm text-muted hover:text-ink">
        ← All contacts
      </Link>
      <div className="mt-4 flex flex-wrap items-center gap-4 border-b border-line pb-6">
        <span className="grid h-14 w-14 shrink-0 place-items-center rounded-full bg-gradient-brand text-lg font-bold text-white">
          {contactInitials(contact)}
        </span>
        <div className="min-w-0">
          <h1 className="text-2xl font-bold tracking-tight text-ink">{contactName(contact)}</h1>
          <p className="mt-0.5 text-sm text-muted">
            {[contact.title, contact.company?.name].filter(Boolean).join(" · ") || "—"}
          </p>
        </div>
        <div className="ml-auto flex flex-wrap gap-3 text-sm">
          {contact.email ? (
            <a href={`mailto:${contact.email}`} className="text-brand-700 hover:underline">
              {contact.email}
            </a>
          ) : null}
          {contact.phone ? <span className="text-muted">{contact.phone}</span> : null}
        </div>
      </div>

      <ContactWorkspace
        contact={contact}
        timeline={timeline}
        tasks={tasks}
        deals={deals}
        cases={cases}
        lastEnrollment={lastEnrollment}
      />
    </PortalShell>
  );
}
