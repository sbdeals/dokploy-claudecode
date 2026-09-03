import type { Metadata } from "next";
import { cookies } from "next/headers";
import { redirect } from "next/navigation";

import { SESSION_COOKIE, openSession } from "@/lib/session";
import { LoginForm } from "./LoginForm";

// Reads the session cookie, so it must render per request.
export const dynamic = "force-dynamic";

export const metadata: Metadata = { title: "Sign in" };

export default async function LoginPage() {
  // Already signed in? Skip the form.
  const store = await cookies();
  if (openSession(store.get(SESSION_COOKIE)?.value)) {
    redirect("/");
  }

  // The heading follows the form's sign-in / create-account mode, so the whole
  // header (mark + title + hint) lives in the client form component.
  return (
    <main className="flex min-h-full items-center justify-center px-6 py-16">
      <div className="w-full max-w-sm">
        <LoginForm />
      </div>
    </main>
  );
}
