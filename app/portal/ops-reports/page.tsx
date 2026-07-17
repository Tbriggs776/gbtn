import { redirect } from "next/navigation";

// The section has no landing page of its own — it opens on the first report.
export default async function OpsReportsIndex({
  searchParams,
}: {
  searchParams: Promise<{ client?: string }>;
}) {
  const { client } = await searchParams;
  redirect(`/portal/ops-reports/install-pipeline${client ? `?client=${client}` : ""}`);
}
