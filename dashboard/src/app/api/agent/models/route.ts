/**
 * GET /api/agent/models -> the model ids the current provider/endpoint can
 * serve, so the panel's Model dropdown is always up to date.
 *
 *  - anthropic: the static catalog (AGENT_MODELS).
 *  - openai-compatible: the endpoint's own GET /v1/models, fetched server-side
 *    with the stored key (never exposed to the browser). Bounded by a timeout so
 *    a slow endpoint can't hang the request; on any failure we return an empty
 *    list + a note, and the UI falls back to the preset's curated suggestions.
 */
import { getOpenAI } from "@/lib/agent/client";
import { AGENT_MODELS, resolveAgentKey, resolveProvider } from "@/lib/agent/key-store";
import { sessionFromRequest, unauthorized } from "@/lib/session";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const MODELS_TIMEOUT_MS = Number(process.env.AGENT_MODELS_TIMEOUT_MS) || 10_000;

function withTimeout<T>(p: Promise<T>, ms: number): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const t = setTimeout(() => reject(new Error(`Listing models timed out after ${ms}ms`)), ms);
    p.then(
      (v) => {
        clearTimeout(t);
        resolve(v);
      },
      (e) => {
        clearTimeout(t);
        reject(e);
      },
    );
  });
}

export async function GET(req: Request) {
  // The proxy only proves a session cookie EXISTS; verify it (the stored key
  // is sent to whatever endpoint this lists models from).
  if (!sessionFromRequest(req)) return unauthorized();

  if (resolveProvider() === "anthropic") {
    return Response.json({
      provider: "anthropic",
      dynamic: false,
      models: AGENT_MODELS.map((m) => ({ id: m.id, label: m.label })),
    });
  }

  // OpenAI-compatible: ask the endpoint what it serves.
  if (!resolveAgentKey()) {
    return Response.json({ provider: "openai", dynamic: true, models: [], error: "No API key set yet." });
  }
  try {
    const client = getOpenAI();
    const list = await withTimeout(client.models.list(), MODELS_TIMEOUT_MS);
    const ids = Array.from(new Set((list.data ?? []).map((m) => m.id)))
      .filter(Boolean)
      .sort((a, b) => a.localeCompare(b));
    return Response.json({
      provider: "openai",
      dynamic: true,
      models: ids.map((id) => ({ id, label: id })),
    });
  } catch (e) {
    // Endpoint has no /models, rejected the key, or timed out — the UI falls
    // back to the preset's curated suggestions and its custom-id input.
    return Response.json({
      provider: "openai",
      dynamic: true,
      models: [],
      error: e instanceof Error ? e.message : String(e),
    });
  }
}
