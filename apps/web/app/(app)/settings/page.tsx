"use client";
import { Suspense, useState } from "react";
import { useSearchParams } from "next/navigation";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { ApiError, post } from "@/lib/api";
import { useMe } from "@/lib/hooks";
import { useToast } from "@/components/toast";

function urlBase64ToUint8Array(base64: string) {
  const padding = "=".repeat((4 - (base64.length % 4)) % 4);
  const raw = atob((base64 + padding).replace(/-/g, "+").replace(/_/g, "/"));
  return Uint8Array.from([...raw].map((c) => c.charCodeAt(0)));
}

function SettingsInner() {
  const me = useMe();
  const qc = useQueryClient();
  const toast = useToast();
  const params = useSearchParams();
  const [totp, setTotp] = useState<{ secret: string; otpauth: string } | null>(null);
  const [code, setCode] = useState("");

  const setup = useMutation({ mutationFn: () => post<{ secret: string; otpauth: string }>("/api/me/totp/setup"), onSuccess: setTotp });
  const enable = useMutation({
    mutationFn: () => post("/api/me/totp/enable", { code }),
    onSuccess: () => {
      toast("Two-factor authentication enabled");
      setTotp(null);
      qc.invalidateQueries({ queryKey: ["me"] });
    },
    onError: (e) => toast(e instanceof ApiError ? e.message : "Invalid code", "error"),
  });
  const disconnect = useMutation({ mutationFn: () => post("/api/integrations/gmail/disconnect"), onSuccess: () => qc.invalidateQueries({ queryKey: ["me"] }) });

  const enablePush = async () => {
    try {
      if (!("serviceWorker" in navigator) || !me.data?.vapidPublicKey) throw new Error("Push isn't configured on this server");
      const perm = await Notification.requestPermission();
      if (perm !== "granted") throw new Error("Notifications were blocked in the browser");
      const reg = await navigator.serviceWorker.register("/sw.js");
      const sub = await reg.pushManager.subscribe({ userVisibleOnly: true, applicationServerKey: urlBase64ToUint8Array(me.data.vapidPublicKey) });
      await post("/api/me/push-subscription", sub.toJSON());
      toast("Push notifications enabled on this device");
    } catch (e) {
      toast((e as Error).message, "error");
    }
  };

  if (!me.data) return null;
  return (
    <div className="h-full overflow-y-auto">
      <div className="mx-auto max-w-2xl space-y-4 p-4">
        <h1 className="page-title">Settings</h1>
        {params.get("totp") === "required" && !me.data.totpEnabled && (
          <p className="rounded-md bg-amber-50 p-3 text-sm text-amber-900">Admins must turn on two-factor authentication before using the app. Set it up below.</p>
        )}
        {params.get("gmail") === "connected" && <p className="rounded-md bg-emerald-50 p-3 text-sm text-emerald-800">Gmail connected. New mail to your address will appear in the inbox.</p>}

        <section className="card p-4">
          <h2 className="section-title">{me.data.name}</h2>
          <p className="text-sm text-ink-500">
            {me.data.email} · {me.data.role}
          </p>
        </section>

        <section className="card space-y-2 p-4">
          <h2 className="section-title">Gmail mailbox</h2>
          <p className="text-sm text-ink-600 dark:text-ink-300">Connect your work Gmail so clients who email you directly land in the inbox, and your replies go out from your own address (and appear in your Sent folder).</p>
          {me.data.mailbox && me.data.mailbox.status === "active" ? (
            <div className="flex items-center gap-2 text-sm">
              Connected: <b>{me.data.mailbox.email}</b>
              <button className="btn" onClick={() => disconnect.mutate()}>
                Disconnect
              </button>
            </div>
          ) : (
            <a className="btn-primary" href="/api/integrations/gmail/connect">
              Connect Gmail
            </a>
          )}
        </section>

        <section className="card space-y-2 p-4">
          <h2 className="section-title">Push notifications</h2>
          <p className="text-sm text-ink-600 dark:text-ink-300">Get new-lead and reply alerts on this device (works on Android and installed iOS web apps).</p>
          <button className="btn" onClick={enablePush}>
            Enable on this device
          </button>
        </section>

        <section className="card space-y-2 p-4">
          <h2 className="section-title">Two-factor authentication</h2>
          {me.data.totpEnabled ? (
            <p className="text-sm text-emerald-700">Enabled.</p>
          ) : (
            <>
              <p className="text-sm text-ink-600 dark:text-ink-300">Required for admins, recommended for everyone.</p>
              {!totp ? (
                <button className="btn" onClick={() => setup.mutate()}>
                  Set up authenticator app
                </button>
              ) : (
                <div className="space-y-2 text-sm">
                  <p>Add this key in Google Authenticator / 1Password / Authy, then enter the 6-digit code:</p>
                  <code className="block break-all rounded bg-ink-100 p-2 dark:bg-ink-800">{totp.secret}</code>
                  <a className="text-xs text-brand-600 underline" href={totp.otpauth}>
                    Open in authenticator app
                  </a>
                  <div className="flex gap-2">
                    <input className="input w-32 font-mono" inputMode="numeric" maxLength={6} value={code} onChange={(e) => setCode(e.target.value)} />
                    <button className="btn-primary" disabled={code.length !== 6} onClick={() => enable.mutate()}>
                      Verify & enable
                    </button>
                  </div>
                </div>
              )}
            </>
          )}
        </section>

        <section className="card p-4">
          <button
            className="btn"
            onClick={async () => {
              await post("/api/auth/logout");
              window.location.href = "/login";
            }}
          >
            Sign out
          </button>
        </section>
      </div>
    </div>
  );
}

export default function SettingsPage() {
  return (
    <Suspense>
      <SettingsInner />
    </Suspense>
  );
}
