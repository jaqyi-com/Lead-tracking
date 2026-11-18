"use client";
import { useState, Suspense } from "react";
import { useRouter, useSearchParams } from "next/navigation";
import { post, ApiError } from "@/lib/api";

const ERRORS: Record<string, string> = {
  no_account: "No active account for that Google address. Ask an admin to add you.",
  domain: "Use your company Google Workspace account.",
  state: "Sign-in link expired. Try again.",
  expired: "Sign-in link expired. Try again.",
  oauth: "Google sign-in was cancelled.",
};

function LoginForm() {
  const router = useRouter();
  const params = useSearchParams();
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [code, setCode] = useState("");
  const [step, setStep] = useState<"password" | "totp">("password");
  const [error, setError] = useState<string | null>(params.get("error") ? (ERRORS[params.get("error")!] ?? "Sign-in failed") : null);
  const [busy, setBusy] = useState(false);

  const submit = async (e: React.FormEvent) => {
    e.preventDefault();
    setBusy(true);
    setError(null);
    try {
      if (step === "password") {
        const r = await post<{ totpRequired: boolean }>("/api/auth/login", { email, password });
        if (r.totpRequired) {
          setStep("totp");
          return;
        }
      } else {
        await post("/api/auth/totp", { code });
      }
      router.replace("/inbox");
    } catch (err) {
      setError(err instanceof ApiError ? err.message : "Sign-in failed");
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="flex min-h-full items-center justify-center px-4 py-12">
      <div className="w-full max-w-sm">
        <div className="mb-8 flex items-center gap-3">
          <img src="/icon.svg" alt="" className="h-9 w-9" />
          <div>
            <h1 className="text-lg font-semibold">Doott Lead OS</h1>
            <p className="text-sm text-slate-500">Every enquiry, one owner, one timeline.</p>
          </div>
        </div>
        <form onSubmit={submit} className="card space-y-4 p-6">
          {step === "password" ? (
            <>
              <div>
                <label className="label" htmlFor="email">Work email</label>
                <input id="email" className="input" type="email" autoComplete="username" value={email} onChange={(e) => setEmail(e.target.value)} required autoFocus />
              </div>
              <div>
                <label className="label" htmlFor="password">Password</label>
                <input id="password" className="input" type="password" autoComplete="current-password" value={password} onChange={(e) => setPassword(e.target.value)} required />
              </div>
            </>
          ) : (
            <div>
              <label className="label" htmlFor="code">6-digit code from your authenticator app</label>
              <input id="code" className="input text-center font-mono text-lg tracking-widest" inputMode="numeric" pattern="\d{6}" maxLength={6} value={code} onChange={(e) => setCode(e.target.value)} required autoFocus />
            </div>
          )}
          {error && <p className="rounded-md bg-red-50 px-3 py-2 text-sm text-red-700 dark:bg-red-950 dark:text-red-200">{error}</p>}
          <button className="btn-primary w-full" disabled={busy}>
            {busy ? "Signing in…" : step === "password" ? "Sign in" : "Verify"}
          </button>
          {step === "password" && (
            <a href="/api/auth/google" className="btn w-full">
              Sign in with Google Workspace
            </a>
          )}
        </form>
      </div>
    </div>
  );
}

export default function LoginPage() {
  return (
    <Suspense>
      <LoginForm />
    </Suspense>
  );
}
