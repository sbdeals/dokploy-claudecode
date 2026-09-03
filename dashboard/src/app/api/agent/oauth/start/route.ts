import { startLogin } from "@/lib/agent/oauth";
import { sessionFromRequest, unauthorized } from "@/lib/session";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * POST -> { url }. Begins "Sign in with Claude": mints a PKCE challenge and
 * returns the Claude authorize URL for the user to open and approve.
 *
 * The proxy only proves a session cookie EXISTS; the sealed cookie is verified
 * here before a sign-in (whose result becomes the process-wide credential) can
 * be started.
 */
export async function POST(req: Request) {
  if (!sessionFromRequest(req)) return unauthorized();
  return Response.json(startLogin());
}
