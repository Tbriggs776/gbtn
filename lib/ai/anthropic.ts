import "server-only";
import Anthropic from "@anthropic-ai/sdk";
import { readPlatformSecret } from "@/lib/integrations/platform-secrets";

// The one place the Anthropic key is used. The key comes from Vault (never an
// env var, never the browser); if it isn't configured, callers fall back to the
// deterministic briefing. Model per the current guidance: claude-opus-5.

export const BRIEFING_MODEL = "claude-opus-5";

export type AiResult =
  | { ok: true; text: string; model: string }
  | { ok: false; reason: "no_key" | "refused" | "error"; message: string };

async function client(): Promise<Anthropic | null> {
  const key = await readPlatformSecret("anthropic");
  if (!key) return null;
  return new Anthropic({ apiKey: key });
}

/**
 * One completion. Thinking is on by default on opus-5 and counts toward
 * max_tokens, so max_tokens is generous relative to the visible output.
 * No temperature/budget_tokens — both 400 on opus-5.
 */
export async function generate(
  system: string,
  prompt: string,
  maxTokens = 6000
): Promise<AiResult> {
  const c = await client();
  if (!c) return { ok: false, reason: "no_key", message: "No Anthropic key configured." };

  try {
    const msg = await c.messages.create({
      model: BRIEFING_MODEL,
      max_tokens: maxTokens,
      system,
      messages: [{ role: "user", content: prompt }],
    });

    if (msg.stop_reason === "refusal") {
      return { ok: false, reason: "refused", message: "The model declined to answer." };
    }
    const text = msg.content
      .filter((b): b is Anthropic.TextBlock => b.type === "text")
      .map((b) => b.text)
      .join("\n")
      .trim();
    if (!text) return { ok: false, reason: "error", message: "Empty response." };
    return { ok: true, text, model: msg.model };
  } catch (e) {
    // Surface a short message to the admin (bad key, wrong model, rate limit);
    // detail stays server-side.
    console.error("anthropic.generate:", e);
    const message =
      e instanceof Anthropic.AuthenticationError
        ? "The Anthropic key was rejected (401)."
        : e instanceof Anthropic.NotFoundError
          ? `Model ${BRIEFING_MODEL} not available for this key (404).`
          : e instanceof Anthropic.RateLimitError
            ? "Rate limited by Anthropic (429) — try again shortly."
            : e instanceof Anthropic.APIError
              ? `Anthropic API error (${e.status}).`
              : "Could not reach Anthropic.";
    return { ok: false, reason: "error", message };
  }
}

/** The CFO briefing. Kept as its own name because that's how callers read. */
export async function generateBriefing(system: string, prompt: string): Promise<AiResult> {
  return generate(system, prompt);
}

/** A trivial call to validate the stored key, for the admin "Test" button. */
export async function testAnthropicKey(): Promise<AiResult> {
  return generate("Reply with exactly the word: OK", "Say OK.", 64);
}
