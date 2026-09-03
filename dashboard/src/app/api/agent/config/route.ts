import { agentModel } from "@/lib/agent/client";
import {
  AGENT_MODELS,
  isLoginCredential,
  looksLikeAnthropicKey,
  maskKey,
  resolveAgentKey,
  resolveBaseUrl,
  resolveProvider,
  setBaseUrl,
  setProvider,
  setRuntimeKey,
  setRuntimeModel,
} from "@/lib/agent/key-store";
import { sessionFromRequest, unauthorized } from "@/lib/session";
export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * Suggested OpenAI-compatible endpoints + a few tool-capable models. These are
 * hints only — the UI lets the user type any base URL and model id. Model ids
 * drift over time, so treat the lists as starting points, not a guarantee.
 */
const PROVIDER_PRESETS = [
  {
    id: "openrouter",
    label: "OpenRouter",
    baseUrl: "https://openrouter.ai/api/v1",
    keyHint: "sk-or-…",
    models: [
      "nousresearch/hermes-4-405b",
      "deepseek/deepseek-chat",
      "qwen/qwen3-235b-a22b",
      "meta-llama/llama-3.3-70b-instruct",
      "openai/gpt-4o-mini",
    ],
  },
  {
    id: "groq",
    label: "Groq",
    baseUrl: "https://api.groq.com/openai/v1",
    keyHint: "gsk_…",
    models: ["llama-3.3-70b-versatile", "moonshotai/kimi-k2-instruct"],
  },
  {
    id: "moonshot",
    label: "Moonshot (Kimi)",
    baseUrl: "https://api.moonshot.ai/v1",
    keyHint: "sk-…",
    models: ["moonshot-v1-8k", "moonshot-v1-32k", "moonshot-v1-128k", "kimi-latest", "kimi-k2-0711-preview"],
  },
  {
    id: "together",
    label: "Together",
    baseUrl: "https://api.together.xyz/v1",
    keyHint: "",
    models: ["deepseek-ai/DeepSeek-V3", "meta-llama/Llama-3.3-70B-Instruct-Turbo"],
  },
  {
    id: "openai",
    label: "OpenAI",
    baseUrl: "https://api.openai.com/v1",
    keyHint: "sk-…",
    models: ["gpt-4o-mini", "gpt-4o"],
  },
  { id: "custom", label: "Custom / other", baseUrl: "", keyHint: "", models: [] },
] as const;

// The proxy only checks that a session cookie EXISTS. The agent credential
// store is process-wide (one key for every user of this dashboard), so each
// handler below opens and verifies the sealed cookie before touching it — a
// forged `switchyard_session=x` must not be able to set the key everyone uses.

function status() {
  const resolved = resolveAgentKey();
  return {
    configured: resolved !== null,
    source: resolved?.source ?? null,
    masked: resolved ? maskKey(resolved.key) : null,
    // True when the credential came from "Sign in with Claude" (a refreshable
    // subscription login) rather than a pasted key/token.
    loginActive: resolved !== null && isLoginCredential(),
    provider: resolveProvider(),
    baseUrl: resolveBaseUrl(),
    model: agentModel(),
    models: AGENT_MODELS, // Anthropic catalog (dropdown for the anthropic provider)
    presets: PROVIDER_PRESETS, // OpenAI-compatible suggestions
  };
}

/** GET -> credential + provider status (never the key itself). */
export async function GET(req: Request) {
  if (!sessionFromRequest(req)) return unauthorized();
  return Response.json(status());
}

/**
 * POST accepts, one at a time:
 *  { provider }  -> switch "anthropic" | "openai" (clears the model)
 *  { baseUrl }   -> set/clear the OpenAI-compatible endpoint
 *  { model }     -> set the model (validated vs catalog for anthropic; free-text for openai)
 *  { key }       -> store a pasted key (sk-ant-… enforced only for anthropic)
 *  { clear: true } -> drop the UI-set credential
 * All take effect immediately, no restart.
 */
export async function POST(req: Request) {
  if (!sessionFromRequest(req)) return unauthorized();

  let body: { key?: unknown; model?: unknown; provider?: unknown; baseUrl?: unknown; clear?: unknown };
  try {
    body = await req.json();
  } catch {
    return Response.json({ error: "Invalid JSON body." }, { status: 400 });
  }

  if (body.clear === true) {
    setRuntimeKey(null);
    return Response.json(status());
  }

  if (typeof body.provider === "string") {
    if (body.provider !== "anthropic" && body.provider !== "openai") {
      return Response.json({ error: "Unknown provider." }, { status: 400 });
    }
    setProvider(body.provider);
    return Response.json(status());
  }

  if (typeof body.baseUrl === "string") {
    const url = body.baseUrl.trim();
    if (url && !/^https?:\/\//i.test(url)) {
      return Response.json({ error: "Base URL must start with http(s)://." }, { status: 400 });
    }
    setBaseUrl(url || null);
    return Response.json(status());
  }

  if (typeof body.model === "string") {
    const model = body.model.trim();
    if (!model) return Response.json({ error: "Model can't be empty." }, { status: 400 });
    // Anthropic model must be from the catalog; OpenAI-compatible is free-text.
    if (resolveProvider() === "anthropic" && !AGENT_MODELS.some((m) => m.id === model)) {
      return Response.json({ error: "Unknown model." }, { status: 400 });
    }
    setRuntimeModel(model);
    return Response.json(status());
  }

  const key = typeof body.key === "string" ? body.key.trim() : "";
  if (resolveProvider() === "anthropic") {
    if (!looksLikeAnthropicKey(key)) {
      return Response.json(
        { error: "That doesn't look like an Anthropic key (expected sk-ant-…)." },
        { status: 400 },
      );
    }
  } else if (key.length < 8) {
    return Response.json({ error: "Enter the provider's API key." }, { status: 400 });
  }
  setRuntimeKey(key);
  return Response.json(status());
}
