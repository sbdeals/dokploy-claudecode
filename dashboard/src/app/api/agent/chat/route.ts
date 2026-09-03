import type Anthropic from "@anthropic-ai/sdk";
import { isAgentConfigured } from "@/lib/agent/client";
import { runAgentTurn, type AgentEvent } from "@/lib/agent/run";
import { sessionKey } from "@/lib/agent/store";
import { sessionFromRequest, unauthorized } from "@/lib/session";
import { SSE_HEADERS } from "@/lib/sse";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/** Coerce the client payload into Anthropic message params (user/assistant text). */
function toMessages(raw: unknown): Anthropic.MessageParam[] {
  if (!Array.isArray(raw)) return [];
  const out: Anthropic.MessageParam[] = [];
  for (const m of raw) {
    if (!m || typeof m !== "object") continue;
    const role = (m as { role?: unknown }).role;
    const content = (m as { content?: unknown }).content;
    if ((role === "user" || role === "assistant") && typeof content === "string" && content.trim()) {
      out.push({ role, content });
    }
  }
  return out;
}

/**
 * POST /api/agent/chat  { messages: [{role, content}, ...] }
 * -> SSE stream of the assistant turn: text deltas, tool activity, staged
 *    signals, then a final `done` event.
 */
export async function POST(req: Request) {
  // The proxy only proves a session cookie EXISTS. Verify it before spending
  // the (shared, process-wide) agent credential on this caller.
  const session = sessionFromRequest(req);
  if (!session) return unauthorized();

  if (!isAgentConfigured()) {
    return Response.json(
      { error: "No Anthropic API key configured — add one at the top of the Agent panel." },
      { status: 503 }
    );
  }

  let messages: Anthropic.MessageParam[] = [];
  try {
    const body = await req.json();
    messages = toMessages((body as { messages?: unknown }).messages);
  } catch {
    return Response.json({ error: "Invalid JSON body." }, { status: 400 });
  }
  if (messages.length === 0) {
    return Response.json({ error: "No messages provided." }, { status: 400 });
  }

  const key = sessionKey(session);
  const encoder = new TextEncoder();

  const stream = new ReadableStream({
    async start(controller) {
      const emit = (e: AgentEvent) => {
        controller.enqueue(encoder.encode(`data: ${JSON.stringify(e)}\n\n`));
      };
      try {
        await runAgentTurn(messages, key, emit);
      } catch (e) {
        emit({ type: "error", error: e instanceof Error ? e.message : String(e) });
      } finally {
        emit({ type: "done" });
        controller.close();
      }
    },
  });

  return new Response(stream, { headers: SSE_HEADERS });
}
