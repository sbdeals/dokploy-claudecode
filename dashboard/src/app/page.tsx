import { unstable_rethrow } from "next/navigation";

import { loadWorkspace, inferEdges } from "@/lib/dokploy";
import { ensureCollector } from "@/lib/collector";
import { Workspace } from "@/components/Workspace";
import { LogoutButton } from "@/components/LogoutButton";

// Always fetch fresh state from Dokploy.
export const dynamic = "force-dynamic";

export default async function Page() {
  // Start the background metrics/logs collector on first workspace load. Lazy
  // singleton — safe to call on every request (see lib/collector.ts).
  ensureCollector();

  let result: Awaited<ReturnType<typeof loadWorkspace>> | null = null;
  let message: string | null = null;
  try {
    result = await loadWorkspace();
  } catch (e) {
    // Let framework control-flow errors (e.g. redirect to /login on an expired
    // session) propagate instead of rendering them as an error panel.
    unstable_rethrow(e);
    message = e instanceof Error ? e.message : String(e);
  }

  if (result) {
    return (
      <>
        <LogoutButton />
        <Workspace
          services={result.services}
          projects={result.projects}
          edges={inferEdges(result.services)}
        />
      </>
    );
  }

  // The user IS signed in here (a rejected session redirects to /login above);
  // the failure is between this server and the Dokploy API. The env admin
  // credentials are not involved — they only power the health probe and the
  // background collector — so don't send people to check them.
  return (
    <>
      <LogoutButton />
      <div className="mx-auto max-w-2xl px-6 py-24">
        <div className="rounded-2xl border border-[var(--color-danger)]/40 bg-[var(--color-danger-soft)] p-6">
          <h1 className="text-lg font-semibold text-[var(--color-danger)]">
            Couldn&apos;t reach Dokploy
          </h1>
          <p className="mt-2 text-sm text-[var(--color-fg-muted)]">
            The dashboard couldn&apos;t talk to the Dokploy API with your session. Check that Dokploy
            is running and that <code className="font-mono">DOKPLOY_URL</code> points at it — set it
            with <code className="font-mono">switchyard config</code> for the managed container, or in{" "}
            <code className="font-mono">.env.local</code> when running from source. If Dokploy is up,
            sign out and back in at <code className="font-mono">/login</code>.
          </p>
          <pre className="mt-4 overflow-x-auto rounded-lg bg-[var(--color-bg-elevated)] p-3 font-mono text-xs text-[var(--color-fg-muted)]">
            {message}
          </pre>
        </div>
      </div>
    </>
  );
}
