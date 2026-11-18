"use client";
import { useState, Suspense } from "react";
import { useRouter, useSearchParams } from "next/navigation";
import { post, ApiError } from "@/lib/api";
import { Logo } from "@/components/logo";
import { IconArrowRight, IconBolt, IconClock, IconShield } from "@/components/icons";

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
    <div className="grid min-h-full bg-white lg:grid-cols-[1.05fr_1fr]">
      {/* Brand panel */}
      <section className="relative hidden overflow-hidden bg-brand-600 p-12 text-white lg:flex lg:flex-col">
        <div className="pointer-events-none absolute -right-32 -top-32 h-[28rem] w-[28rem] rounded-full bg-brand-500/60 blur-3xl" />
        <div className="pointer-events-none absolute -bottom-40 -left-24 h-[30rem] w-[30rem] rounded-full bg-brand-800/70 blur-3xl" />
        <div
          className="pointer-events-none absolute inset-0 opacity-[0.07]"
          style={{ backgroundImage: "radial-gradient(circle at 1px 1px, white 1px, transparent 0)", backgroundSize: "22px 22px" }}
        />
        <div className="relative">
          <Logo inverted />
        </div>
        <div className="relative mt-auto max-w-lg">
          <h1 className="font-display text-[44px] font-extrabold leading-[1.05] tracking-tight">
            Every enquiry.
            <br />
            One owner.
            <br />
            <span className="text-white/70">Answered in minutes.</span>
          </h1>
          <p className="mt-5 max-w-md text-[15px] leading-relaxed text-white/80">
            WhatsApp, email and portal leads land in one inbox, get routed to the right rep, and stay on one timeline the whole team can see.
          </p>
          <div className="mt-10 grid gap-3">
            {[
              { icon: IconBolt, t: "Leads captured in seconds", d: "WhatsApp, sales@, IndiaMART, website forms" },
              { icon: IconClock, t: "5-minute first response", d: "SLA clocks on business hours, with escalation" },
              { icon: IconShield, t: "Consent built in", d: "Opt-ins, opt-outs and DPDP rights on record" },
            ].map(({ icon: Icon, t, d }) => (
              <div key={t} className="flex items-center gap-4 rounded-2xl bg-white/10 p-4 ring-1 ring-white/15 backdrop-blur">
                <span className="flex h-10 w-10 shrink-0 items-center justify-center rounded-xl bg-white text-brand-600">
                  <Icon size={19} />
                </span>
                <span>
                  <span className="block text-sm font-semibold">{t}</span>
                  <span className="block text-xs text-white/70">{d}</span>
                </span>
              </div>
            ))}
          </div>
        </div>
        <p className="relative mt-10 text-xs text-white/60">© {new Date().getFullYear()} Doott · Internal use only</p>
      </section>

      {/* Form */}
      <section className="flex items-center justify-center px-6 py-12">
        <div className="w-full max-w-sm">
          <div className="mb-10 lg:hidden">
            <Logo />
          </div>
          <h2 className="font-display text-3xl font-bold tracking-tight text-ink-900">{step === "password" ? "Welcome back" : "Two-step verification"}</h2>
          <p className="mt-2 text-sm text-ink-500">{step === "password" ? "Sign in to your Doott sales workspace." : "Enter the 6-digit code from your authenticator app."}</p>

          <form onSubmit={submit} className="mt-8 space-y-5">
            {step === "password" ? (
              <>
                <div>
                  <label className="label" htmlFor="email">
                    Work email
                  </label>
                  <input id="email" className="input h-11" type="email" autoComplete="username" placeholder="you@doott.com" value={email} onChange={(e) => setEmail(e.target.value)} required autoFocus />
                </div>
                <div>
                  <label className="label" htmlFor="password">
                    Password
                  </label>
                  <input id="password" className="input h-11" type="password" autoComplete="current-password" placeholder="••••••••••" value={password} onChange={(e) => setPassword(e.target.value)} required />
                </div>
              </>
            ) : (
              <input
                id="code"
                className="input h-14 text-center font-mono text-2xl tracking-[0.5em]"
                inputMode="numeric"
                pattern="\d{6}"
                maxLength={6}
                placeholder="000000"
                value={code}
                onChange={(e) => setCode(e.target.value.replace(/\D/g, ""))}
                required
                autoFocus
                aria-label="6-digit code"
              />
            )}
            {error && <p className="rounded-lg border border-brand-200 bg-brand-50 px-3 py-2.5 text-sm font-medium text-brand-800">{error}</p>}
            <button className="btn-primary h-11 w-full text-[15px]" disabled={busy}>
              {busy ? "Signing in…" : step === "password" ? "Sign in" : "Verify"}
              {!busy && <IconArrowRight size={16} />}
            </button>
            {step === "password" && (
              <>
                <div className="flex items-center gap-3 text-xs text-ink-400">
                  <span className="h-px flex-1 bg-ink-200" />
                  or
                  <span className="h-px flex-1 bg-ink-200" />
                </div>
                <a href="/api/auth/google" className="btn h-11 w-full text-[15px]">
                  <svg width="18" height="18" viewBox="0 0 48 48" aria-hidden="true">
                    <path fill="#FFC107" d="M43.6 20.5H42V20H24v8h11.3C33.7 32.7 29.2 36 24 36c-6.6 0-12-5.4-12-12s5.4-12 12-12c3.1 0 5.8 1.2 7.9 3.1l5.7-5.7C34 6.1 29.3 4 24 4 12.9 4 4 12.9 4 24s8.9 20 20 20 20-8.9 20-20c0-1.3-.1-2.4-.4-3.5z" />
                    <path fill="#FF3D00" d="m6.3 14.7 6.6 4.8C14.7 15.1 19 12 24 12c3.1 0 5.8 1.2 7.9 3.1l5.7-5.7C34 6.1 29.3 4 24 4 16.3 4 9.7 8.3 6.3 14.7z" />
                    <path fill="#4CAF50" d="M24 44c5.2 0 9.9-2 13.4-5.2l-6.2-5.2C29.2 35.1 26.7 36 24 36c-5.2 0-9.6-3.3-11.3-7.9l-6.5 5C9.5 39.6 16.2 44 24 44z" />
                    <path fill="#1976D2" d="M43.6 20.5H42V20H24v8h11.3c-.8 2.2-2.2 4.2-4.1 5.6l6.2 5.2C37 39.2 44 34 44 24c0-1.3-.1-2.4-.4-3.5z" />
                  </svg>
                  Continue with Google Workspace
                </a>
              </>
            )}
            {step === "totp" && (
              <button type="button" className="btn-ghost w-full justify-center text-xs" onClick={() => setStep("password")}>
                Use a different account
              </button>
            )}
          </form>
        </div>
      </section>
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
