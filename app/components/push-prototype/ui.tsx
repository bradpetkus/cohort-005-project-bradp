// PROTOTYPE — throwaway. Three variants for turning on phone (web) push, on the real
// app via ?variant=A|B|C. The bell is the decided dropdown from "Prototype: In-app
// notification bell and list"; the Notifications card is mounted on /settings.
//
//   A "Bell strip"   — a standing "Get these on your phone" strip at the top of the bell
//                      dropdown (until on, or "Not now"). /settings: a This-device
//                      switch row + other devices + event toggles.
//   B "Settings home"— no proactive prompt anywhere. The bell footer links to /settings,
//                      whose Notifications card leads with a big phone-push panel
//                      (iPhone steps inline, no modal) and a device table.
//   C "Just in time" — nothing until the first push-worthy Notification arrives while
//                      push is off; then a one-off card tied to that Notification asks.
//                      /settings is event-toggles first, with a compact device footer.
import { useEffect, useRef, useState } from "react";
import { Link, useNavigate, useSearchParams } from "react-router";
import {
  Bell,
  BellRing,
  ChevronLeft,
  ChevronRight,
  Lock,
  MonitorSmartphone,
  PlusSquare,
  Share,
  Smartphone,
  X,
} from "lucide-react";
import { cn } from "~/lib/utils";
import { Button } from "~/components/ui/button";
import { Card, CardContent, CardHeader } from "~/components/ui/card";
import { useNotificationsPrototype } from "~/components/notifications-prototype/store";
import { RowA } from "~/components/notifications-prototype/variants";
import { UnreadBadge } from "~/components/notifications-prototype/shared";
import {
  DEVICE_ENVS,
  PUSH_EVENT_LABELS,
  pushEventsFor,
  usePushPrototype,
  type DeviceEnv,
  type ThisDeviceStatus,
} from "./store";
import type { UserRole } from "~/db/schema";

export const VARIANTS = [
  { key: "A", name: "Bell strip" },
  { key: "B", name: "Settings home" },
  { key: "C", name: "Just in time" },
] as const;
type VariantKey = (typeof VARIANTS)[number]["key"];
const STORAGE_KEY = "push-proto-variant";

export function useVariant(): VariantKey {
  const [params] = useSearchParams();
  const fromUrl = params.get("variant");
  const [stored, setStored] = useState<VariantKey>("A");
  useEffect(() => {
    if (fromUrl && VARIANTS.some((v) => v.key === fromUrl)) {
      localStorage.setItem(STORAGE_KEY, fromUrl);
      setStored(fromUrl as VariantKey);
    } else {
      const s = localStorage.getItem(STORAGE_KEY);
      if (s && VARIANTS.some((v) => v.key === s)) setStored(s as VariantKey);
    }
  }, [fromUrl]);
  return (VARIANTS.some((v) => v.key === fromUrl) ? fromUrl : stored) as VariantKey;
}

function Toggle({ on, onClick, disabled }: { on: boolean; onClick: () => void; disabled?: boolean }) {
  return (
    <button
      type="button"
      role="switch"
      aria-checked={on}
      disabled={disabled}
      onClick={onClick}
      className={cn(
        "relative inline-flex h-5 w-9 shrink-0 items-center rounded-full transition-colors disabled:opacity-40",
        on ? "bg-primary" : "bg-muted-foreground/30"
      )}
    >
      <span className={cn("inline-block size-4 rounded-full bg-white shadow transition-transform", on ? "translate-x-4" : "translate-x-0.5")} />
    </button>
  );
}

function turnOnLabel(status: ThisDeviceStatus) {
  if (status === "needs-home-screen") return "Show me how";
  if (status === "blocked") return "How to unblock";
  return "Turn on";
}

/* ───────────────────────── Bell (decided design + per-variant prompt) ───────────────────────── */

function BellStripA() {
  const push = usePushPrototype();
  if (push.status === "on" || push.promptDismissed) return null;
  const iphoneTab = push.status === "needs-home-screen";
  return (
    <div className="flex items-start gap-3 border-b bg-blue-50 px-4 py-3 text-sm dark:bg-blue-950/40">
      <Smartphone className="mt-0.5 size-4 shrink-0 text-blue-600" />
      <div className="flex-1">
        <div className="font-medium">
          {iphoneTab ? "Get these on your iPhone" : push.status === "blocked" ? "Notifications are blocked in this browser" : "Get these on your phone"}
        </div>
        <div className="text-xs text-muted-foreground">
          {iphoneTab
            ? "Add Cadence to your Home Screen first. It takes a few seconds."
            : "Replies, Announcements and refund decisions, even when Cadence is closed."}
        </div>
        <div className="mt-2 flex gap-2">
          <Button size="sm" onClick={push.startTurnOn}>{turnOnLabel(push.status)}</Button>
          <Button size="sm" variant="ghost" onClick={push.dismissPrompt}>Not now</Button>
        </div>
      </div>
    </div>
  );
}

export function PushBell() {
  const variant = useVariant();
  const push = usePushPrototype();
  const { items, unreadCount, markAllRead } = useNotificationsPrototype();
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!open) return;
    const onDown = (e: MouseEvent) => {
      if (ref.current && !ref.current.contains(e.target as Node)) setOpen(false);
    };
    document.addEventListener("mousedown", onDown);
    return () => document.removeEventListener("mousedown", onDown);
  }, [open]);

  return (
    <div ref={ref} className="relative ml-auto">
      <button onClick={() => setOpen((o) => !o)} className="relative rounded-md p-1.5 text-sidebar-foreground/70 hover:bg-sidebar-accent" title="Notifications">
        <Bell className="size-5" />
        <UnreadBadge count={unreadCount} className="absolute -right-1 -top-1" />
        {variant === "A" && push.status !== "on" && !push.promptDismissed && (
          <span className="absolute -bottom-0.5 -right-0.5 size-2 rounded-full bg-blue-600 ring-2 ring-sidebar" title="Phone notifications are off" />
        )}
      </button>
      {open && (
        <div className="absolute left-full top-0 z-50 ml-3 w-96 overflow-hidden rounded-lg border bg-popover text-popover-foreground shadow-xl">
          <div className="flex items-center justify-between border-b px-4 py-2.5">
            <span className="font-semibold">Notifications</span>
            <button onClick={markAllRead} disabled={unreadCount === 0} className="text-xs text-primary hover:underline disabled:text-muted-foreground disabled:no-underline">
              Mark all read
            </button>
          </div>
          {variant === "A" && <BellStripA />}
          <div className="max-h-[420px] divide-y overflow-y-auto">
            {items.map((n) => <RowA key={n.id} n={n} onDone={() => setOpen(false)} />)}
          </div>
          {variant === "B" && (
            <Link to="/settings#notifications" onClick={() => setOpen(false)} className="flex items-center justify-center gap-1.5 border-t px-4 py-2.5 text-sm text-primary hover:bg-accent">
              <Smartphone className="size-4" />
              {push.status === "on" ? "Phone notifications: on" : "Get these on your phone"} →
            </Link>
          )}
        </div>
      )}
    </div>
  );
}

/* ───────────────────────── C: just-in-time ask ───────────────────────── */

export function JustInTimeAskC() {
  const variant = useVariant();
  const push = usePushPrototype();
  const { items } = useNotificationsPrototype();
  const seenMax = useRef<number | null>(null);
  const [asking, setAsking] = useState<{ title: string } | null>(null);

  useEffect(() => {
    const max = Math.max(0, ...items.map((n) => n.id));
    if (seenMax.current === null) {
      seenMax.current = max;
      return;
    }
    if (max > seenMax.current) {
      const fresh = items.find((n) => n.id === max);
      seenMax.current = max;
      if (variant === "C" && fresh?.push && push.status !== "on" && !push.justInTimeShown) {
        setAsking({ title: fresh.title });
        push.markJustInTimeShown();
      }
    }
  });

  if (variant !== "C" || !asking || push.status === "on") return null;
  return (
    <div className="fixed bottom-20 right-6 z-[90] w-96 rounded-lg border bg-popover p-4 shadow-2xl">
      <button onClick={() => setAsking(null)} className="absolute right-2 top-2 rounded p-1 text-muted-foreground hover:bg-accent">
        <X className="size-4" />
      </button>
      <div className="flex gap-3">
        <BellRing className="mt-0.5 size-5 shrink-0 text-primary" />
        <div>
          <div className="text-xs text-muted-foreground">Just now</div>
          <div className="text-sm font-medium">{asking.title}</div>
          <div className="mt-3 text-sm">
            {push.status === "needs-home-screen"
              ? "Want things like this to buzz your iPhone? Add Cadence to your Home Screen and we can send them."
              : push.status === "blocked"
                ? "This browser blocks Cadence's notifications. Unblock them to get things like this on your phone."
                : "Want things like this to buzz your phone, even when Cadence is closed?"}
          </div>
          <div className="mt-3 flex gap-2">
            <Button size="sm" onClick={() => { push.startTurnOn(); setAsking(null); }}>
              {push.status === "off" ? "Turn on phone notifications" : turnOnLabel(push.status)}
            </Button>
            <Button size="sm" variant="ghost" onClick={() => setAsking(null)}>Not now</Button>
          </div>
          <div className="mt-2 text-[11px] text-muted-foreground">We'll only ask once. You can always turn it on in Settings.</div>
        </div>
      </div>
    </div>
  );
}

/* ───────────────────────── Overlays (shared by all variants) ───────────────────────── */

export function PushOverlays() {
  const push = usePushPrototype();
  return (
    <>
      {push.browserPromptOpen && (
        // Fake browser permission prompt, anchored under the address bar like Chrome's.
        <div className="fixed left-4 top-2 z-[120] w-80 rounded-lg border bg-white p-4 text-zinc-900 shadow-2xl">
          <div className="mb-1 text-[10px] uppercase tracking-wide text-fuchsia-600">simulated browser prompt</div>
          <div className="text-sm"><b>{location.host}</b> wants to</div>
          <div className="mt-2 flex items-center gap-2 text-sm"><Bell className="size-4" /> Show notifications</div>
          <div className="mt-4 flex justify-end gap-2">
            <button onClick={() => push.answerBrowserPrompt(false)} className="rounded-full border px-4 py-1 text-sm">Block</button>
            <button onClick={() => push.answerBrowserPrompt(true)} className="rounded-full bg-blue-600 px-4 py-1 text-sm text-white">Allow</button>
          </div>
        </div>
      )}
      {push.homeScreenGuideOpen && (
        <Modal title="Get Cadence notifications on your iPhone" onClose={push.closeOverlays}>
          <HomeScreenSteps />
        </Modal>
      )}
      {push.blockedHelpOpen && (
        <Modal title="Notifications are blocked" onClose={push.closeOverlays}>
          <BlockedSteps />
        </Modal>
      )}
    </>
  );
}

function Modal({ title, onClose, children }: { title: string; onClose: () => void; children: React.ReactNode }) {
  return (
    <div className="fixed inset-0 z-[110] flex items-end justify-center bg-black/40 sm:items-center" onClick={onClose}>
      <div className="w-full max-w-md rounded-t-2xl bg-background p-6 shadow-2xl sm:rounded-2xl" onClick={(e) => e.stopPropagation()}>
        <div className="mb-4 flex items-start justify-between">
          <h2 className="text-lg font-semibold">{title}</h2>
          <button onClick={onClose} className="rounded p-1 hover:bg-accent"><X className="size-4" /></button>
        </div>
        {children}
      </div>
    </div>
  );
}

export function HomeScreenSteps({ compact }: { compact?: boolean }) {
  const steps = [
    { icon: <Share className="size-4" />, text: <>Tap <b>Share</b> in Safari's toolbar.</> },
    { icon: <PlusSquare className="size-4" />, text: <>Choose <b>Add to Home Screen</b>, then <b>Add</b>.</> },
    { icon: <Smartphone className="size-4" />, text: <>Open <b>Cadence</b> from your Home Screen and tap <b>Turn on</b> again.</> },
  ];
  return (
    <div className={cn("space-y-3", compact && "text-sm")}>
      {!compact && (
        <p className="text-sm text-muted-foreground">
          iPhone only sends web notifications to apps on your Home Screen. Cadence isn't in the App Store; you add it straight from Safari.
        </p>
      )}
      <ol className="space-y-2">
        {steps.map((s, i) => (
          <li key={i} className="flex items-center gap-3">
            <span className="flex size-7 shrink-0 items-center justify-center rounded-full bg-muted text-xs font-semibold">{i + 1}</span>
            <span className="text-muted-foreground">{s.icon}</span>
            <span className="text-sm">{s.text}</span>
          </li>
        ))}
      </ol>
      <p className="text-xs text-muted-foreground">Needs iOS 16.4 or later.</p>
    </div>
  );
}

function BlockedSteps() {
  return (
    <div className="space-y-3 text-sm">
      <p className="text-muted-foreground">You (or your browser) blocked notifications for Cadence. Only you can undo that, in the browser:</p>
      <ol className="list-decimal space-y-1 pl-5">
        <li>Click the <Lock className="inline size-3.5" /> lock icon next to the address.</li>
        <li>Set <b>Notifications</b> to <b>Allow</b>.</li>
        <li>Come back here and tap <b>Turn on</b>.</li>
      </ol>
    </div>
  );
}

/* ───────────────────────── /settings Notifications card ───────────────────────── */

function DeviceList({ dense }: { dense?: boolean }) {
  const push = usePushPrototype();
  const others = push.devices.filter((d) => !d.thisDevice);
  if (others.length === 0) return dense ? null : <p className="text-sm text-muted-foreground">No other devices.</p>;
  return (
    <ul className="divide-y rounded-md border">
      {others.map((d) => (
        <li key={d.id} className="flex items-center justify-between px-3 py-2 text-sm">
          <span className="flex items-center gap-2">
            <MonitorSmartphone className="size-4 text-muted-foreground" />
            {d.name} <span className="text-xs text-muted-foreground">· on since {d.since}</span>
          </span>
          <button onClick={() => push.removeDevice(d.id)} className="text-xs text-red-600 hover:underline">Stop sending</button>
        </li>
      ))}
    </ul>
  );
}

function EventToggles({ role, disabled }: { role: UserRole | null; disabled?: boolean }) {
  const push = usePushPrototype();
  return (
    <ul className="space-y-2">
      {pushEventsFor(role).map((e) => (
        <li key={e} className="flex items-center justify-between gap-3 text-sm">
          <span className={cn(disabled && "text-muted-foreground")}>{PUSH_EVENT_LABELS[e]}</span>
          <Toggle on={push.eventsOn[e]} onClick={() => push.toggleEvent(e)} disabled={disabled} />
        </li>
      ))}
    </ul>
  );
}

function statusText(status: ThisDeviceStatus) {
  switch (status) {
    case "on": return "On";
    case "off": return "Off";
    case "needs-home-screen": return "Needs Home Screen";
    case "blocked": return "Blocked in browser";
  }
}

function SettingsCardA({ role }: { role: UserRole | null }) {
  const push = usePushPrototype();
  const env = DEVICE_ENVS.find((d) => d.key === push.env)!;
  return (
    <Card id="notifications" className="mt-8 max-w-md">
      <CardHeader>
        <h2 className="text-lg font-semibold">Notifications</h2>
        <p className="text-sm text-muted-foreground">Everything always shows in the bell. Choose what also buzzes your phone.</p>
      </CardHeader>
      <CardContent className="space-y-5">
        <div>
          <div className="mb-2 text-xs font-medium uppercase tracking-wide text-muted-foreground">This device</div>
          <div className="flex items-center justify-between rounded-md border px-3 py-2">
            <div className="text-sm">
              <div className="font-medium">{env.deviceName}</div>
              <div className="text-xs text-muted-foreground">{statusText(push.status)}</div>
            </div>
            {push.status === "on" || push.status === "off" ? (
              <Toggle on={push.status === "on"} onClick={push.status === "on" ? push.turnOffThisDevice : push.startTurnOn} />
            ) : (
              <Button size="sm" variant="outline" onClick={push.startTurnOn}>{turnOnLabel(push.status)}</Button>
            )}
          </div>
        </div>
        <div>
          <div className="mb-2 text-xs font-medium uppercase tracking-wide text-muted-foreground">Other devices</div>
          <DeviceList />
        </div>
        <div>
          <div className="mb-2 text-xs font-medium uppercase tracking-wide text-muted-foreground">Push me about</div>
          <EventToggles role={role} disabled={!push.anyDeviceOn} />
          {!push.anyDeviceOn && <p className="mt-2 text-xs text-muted-foreground">Turn on a device to choose what buzzes it.</p>}
        </div>
      </CardContent>
    </Card>
  );
}

function SettingsCardB({ role }: { role: UserRole | null }) {
  const push = usePushPrototype();
  const on = push.status === "on";
  return (
    <Card id="notifications" className="mt-8 max-w-2xl overflow-hidden">
      <div className={cn("p-6", on ? "bg-green-50 dark:bg-green-950/30" : "bg-blue-50 dark:bg-blue-950/30")}>
        <div className="flex items-start gap-4">
          <div className={cn("flex size-12 shrink-0 items-center justify-center rounded-full", on ? "bg-green-600" : "bg-blue-600")}>
            <Smartphone className="size-6 text-white" />
          </div>
          <div className="flex-1">
            <h2 className="text-lg font-semibold">
              {on ? "Phone notifications are on for this device" : "Get Cadence notifications on your phone"}
            </h2>
            {push.status === "needs-home-screen" ? (
              <div className="mt-3"><HomeScreenSteps compact /></div>
            ) : push.status === "blocked" ? (
              <div className="mt-3"><BlockedSteps /></div>
            ) : (
              <p className="mt-1 text-sm text-muted-foreground">
                {on ? "Turning it off only stops the buzz. Everything still shows in the bell." : "Buzz this phone or computer for replies, Announcements and decisions, even when Cadence is closed."}
              </p>
            )}
            <div className="mt-4">
              {on ? (
                <Button variant="outline" onClick={push.turnOffThisDevice}>Turn off for this device</Button>
              ) : push.status === "off" ? (
                <Button onClick={push.startTurnOn}>Turn on for this device</Button>
              ) : null}
            </div>
          </div>
        </div>
      </div>
      <CardContent className="grid gap-6 p-6 sm:grid-cols-2">
        <div>
          <h3 className="mb-2 font-semibold">Your devices</h3>
          {push.devices.length === 0 ? (
            <p className="text-sm text-muted-foreground">None yet.</p>
          ) : (
            <table className="w-full text-sm">
              <tbody className="divide-y">
                {push.devices.map((d) => (
                  <tr key={d.id}>
                    <td className="py-2">{d.name}{d.thisDevice && <span className="ml-1 rounded bg-muted px-1 text-[10px]">this device</span>}</td>
                    <td className="py-2 text-right">
                      <button onClick={() => push.removeDevice(d.id)} className="text-xs text-red-600 hover:underline">Remove</button>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
        </div>
        <div>
          <h3 className="mb-2 font-semibold">Push me about</h3>
          <EventToggles role={role} disabled={!push.anyDeviceOn} />
        </div>
      </CardContent>
    </Card>
  );
}

function SettingsCardC({ role }: { role: UserRole | null }) {
  const push = usePushPrototype();
  const others = push.devices.filter((d) => !d.thisDevice).length;
  return (
    <Card id="notifications" className="mt-8 max-w-md">
      <CardHeader>
        <h2 className="text-lg font-semibold">Notifications</h2>
      </CardHeader>
      <CardContent className="space-y-4">
        <div>
          <div className="mb-2 text-sm font-medium">Push to my phone when…</div>
          <EventToggles role={role} />
        </div>
        <div className="flex items-center justify-between border-t pt-3 text-sm">
          <span className="text-muted-foreground">
            This device: <b className="text-foreground">{statusText(push.status)}</b>
            {others > 0 && <> · {others} other device{others > 1 ? "s" : ""}</>}
          </span>
          {push.status === "on" ? (
            <button onClick={push.turnOffThisDevice} className="text-primary hover:underline">Turn off</button>
          ) : (
            <button onClick={push.startTurnOn} className="text-primary hover:underline">{turnOnLabel(push.status)}</button>
          )}
        </div>
        {others > 0 && (
          <details className="text-sm">
            <summary className="cursor-pointer text-muted-foreground">Manage other devices</summary>
            <div className="mt-2"><DeviceList dense /></div>
          </details>
        )}
      </CardContent>
    </Card>
  );
}

export function PushSettingsCard({ role }: { role: UserRole | null }) {
  const v = useVariant();
  if (v === "B") return <SettingsCardB role={role} />;
  if (v === "C") return <SettingsCardC role={role} />;
  return <SettingsCardA role={role} />;
}

/* ───────────────────────── Floating switcher + simulator ───────────────────────── */

export function PushPrototypeSwitcher() {
  const variant = useVariant();
  const navigate = useNavigate();
  const [params] = useSearchParams();
  const push = usePushPrototype();
  const notifs = useNotificationsPrototype();
  const idx = VARIANTS.findIndex((v) => v.key === variant);

  function go(delta: number) {
    const next = VARIANTS[(idx + delta + VARIANTS.length) % VARIANTS.length];
    const p = new URLSearchParams(params);
    p.set("variant", next.key);
    navigate({ search: p.toString(), hash: location.hash }, { replace: true, preventScrollReset: true });
  }

  useEffect(() => {
    function onKey(e: KeyboardEvent) {
      const t = e.target as HTMLElement | null;
      if (t && (t.tagName === "INPUT" || t.tagName === "TEXTAREA" || t.tagName === "SELECT" || t.isContentEditable)) return;
      if (e.key === "ArrowLeft") go(-1);
      if (e.key === "ArrowRight") go(1);
    }
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  });

  if (import.meta.env.PROD) return null;

  return (
    <div className="fixed bottom-4 left-1/2 z-[100] flex -translate-x-1/2 items-center gap-2 whitespace-nowrap rounded-full bg-zinc-900 px-2 py-1.5 text-sm text-white shadow-2xl ring-2 ring-fuchsia-500">
      <button onClick={() => go(-1)} className="rounded-full p-1 hover:bg-white/15" title="Previous variant (←)"><ChevronLeft className="size-4" /></button>
      <span className="font-mono">{variant} <span className="text-white/60">({VARIANTS[idx].name})</span></span>
      <button onClick={() => go(1)} className="rounded-full p-1 hover:bg-white/15" title="Next variant (→)"><ChevronRight className="size-4" /></button>
      <span className="mx-1 h-4 w-px bg-white/30" />
      <select value={push.env} onChange={(e) => push.setEnv(e.target.value as DeviceEnv)} className="rounded bg-zinc-800 px-1 py-0.5 text-xs" title="Pretend to be this browser">
        {DEVICE_ENVS.map((d) => <option key={d.key} value={d.key}>{d.label}</option>)}
      </select>
      <span className="font-mono text-xs text-white/70" title="Browser permission · Cadence status">
        perm:{push.permission[push.env]} · {push.status}
      </span>
      <button onClick={() => push.setPermission(push.permission[push.env] === "denied" ? "default" : "denied")} className="rounded-full px-2 py-0.5 text-xs text-white/70 hover:bg-white/15" title="Flip browser-level block">
        {push.permission[push.env] === "denied" ? "unblock" : "block in browser"}
      </button>
      <button onClick={push.addOtherDevice} className="rounded-full px-2 py-0.5 text-xs text-white/70 hover:bg-white/15">+ other device</button>
      <button onClick={notifs.simulateNew} className="rounded-full bg-fuchsia-600 px-2 py-0.5 text-xs hover:bg-fuchsia-500" title="A push-worthy Notification arrives">+ arrival</button>
      <button onClick={() => { push.reset(); notifs.reset(); }} className="rounded-full px-2 py-0.5 text-xs text-white/70 hover:bg-white/15">reset</button>
    </div>
  );
}
