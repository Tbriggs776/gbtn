"use client";

import { useActionState, useState, useTransition } from "react";
import { setAnthropicKeyAction, testAnthropicKeyAction, type IntegrationState } from "@/app/portal/admin/integrations-actions";

export function Integrations({
  anthropic,
}: {
  anthropic: { configured: boolean; hint: string | null; updatedAt: string | null };
}) {
  const [state, action, pending] = useActionState<IntegrationState, FormData>(setAnthropicKeyAction, {});
  const [test, setTest] = useState<IntegrationState | null>(null);
  const [testing, startTest] = useTransition();

  return (
    <section className="rounded-2xl border border-line bg-white p-6 ring-card">
      <div className="flex items-baseline justify-between">
        <h2 className="text-lg font-bold text-ink">Integrations</h2>
        <span className="text-xs text-muted-soft">Platform-wide · GBTN account</span>
      </div>

      <div className="mt-5 rounded-xl border border-line p-4">
        <div className="flex items-center gap-2">
          <span className="text-sm font-semibold text-ink">Anthropic (AI CFO briefing)</span>
          {anthropic.configured ? (
            <span className="rounded bg-brand-50 px-1.5 py-0.5 text-[10px] font-semibold uppercase tracking-wide text-brand-700">
              Connected · ····{anthropic.hint}
            </span>
          ) : (
            <span className="rounded bg-stone-100 px-1.5 py-0.5 text-[10px] font-semibold uppercase tracking-wide text-stone-600">
              Not connected
            </span>
          )}
        </div>
        <p className="mt-1 text-sm text-muted">
          One key powers the AI summary on every client&apos;s CFO Briefing. The key is encrypted in the vault and
          never shown again — paste a new one to rotate it.
        </p>

        <form action={action} className="mt-3 flex flex-wrap items-center gap-2">
          <input
            type="password"
            name="key"
            autoComplete="off"
            placeholder="sk-ant-…"
            className="w-72 rounded-md border border-line px-3 py-2 text-sm text-ink placeholder:text-muted-soft focus:border-ink focus:outline-none"
          />
          <button
            type="submit"
            disabled={pending}
            className="rounded-md bg-ink px-4 py-2 text-sm font-semibold text-cream transition-colors hover:bg-ink-soft disabled:opacity-60"
          >
            {pending ? "Saving…" : anthropic.configured ? "Replace key" : "Save key"}
          </button>
          <button
            type="button"
            disabled={testing || !anthropic.configured}
            onClick={() => startTest(async () => setTest(await testAnthropicKeyAction()))}
            className="rounded-md border border-line px-4 py-2 text-sm font-semibold text-ink transition-colors hover:bg-paper-soft disabled:opacity-50"
          >
            {testing ? "Testing…" : "Test"}
          </button>
        </form>

        {state.error ? <p className="mt-2 text-sm text-red-600">{state.error}</p> : null}
        {state.ok && state.message ? <p className="mt-2 text-sm text-brand-700">{state.message}</p> : null}
        {test?.error ? <p className="mt-2 text-sm text-red-600">Test: {test.error}</p> : null}
        {test?.ok && test.message ? <p className="mt-2 text-sm text-brand-700">Test: {test.message}</p> : null}

        <p className="mt-3 text-xs text-muted-soft">
          Get a key at console.anthropic.com → API Keys. The briefing costs a few cents per generation and only runs
          when you click Generate on a client&apos;s CFO Briefing tab.
        </p>
      </div>
    </section>
  );
}
