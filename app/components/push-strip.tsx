import { useCallback, useEffect, useState } from "react";
import { Lock, PlusSquare, Share, Smartphone, X } from "lucide-react";
import { toast } from "sonner";
import { Button } from "~/components/ui/button";

// Turning on phone push from the bell. Device state comes from the browser:
// push support, permission, running from the Home Screen or not, iOS or not,
// and whether this browser's subscription is stored for the person.

export type PushDeviceStatus =
  | "loading"
  | "unsupported"
  | "needs-home-screen"
  | "blocked"
  | "off"
  | "on";

const HIDDEN_UNTIL_KEY = "cadence-push-strip-hidden-until";
const NOT_NOW_DAYS = 30;

function isIos() {
  const ua = navigator.userAgent;
  // iPadOS reports itself as a Mac with touch.
  return (
    /iPhone|iPad|iPod/.test(ua) ||
    (/Macintosh/.test(ua) && navigator.maxTouchPoints > 1)
  );
}

function isStandalone() {
  const nav = navigator as Navigator & { standalone?: boolean };
  return (
    window.matchMedia("(display-mode: standalone)").matches ||
    nav.standalone === true
  );
}

function pushSupported() {
  return (
    "serviceWorker" in navigator &&
    "PushManager" in window &&
    "Notification" in window
  );
}

function hiddenByNotNow() {
  try {
    const until = Number(localStorage.getItem(HIDDEN_UNTIL_KEY));
    return Number.isFinite(until) && until > Date.now();
  } catch {
    return false;
  }
}

function urlBase64ToUint8Array(base64: string) {
  const padded = (base64 + "=".repeat((4 - (base64.length % 4)) % 4))
    .replace(/-/g, "+")
    .replace(/_/g, "/");
  const raw = atob(padded);
  const bytes = new Uint8Array(raw.length);
  for (let i = 0; i < raw.length; i++) bytes[i] = raw.charCodeAt(i);
  return bytes;
}

async function postPush(fields: Record<string, string>) {
  const body = new FormData();
  for (const [key, value] of Object.entries(fields)) body.set(key, value);
  const response = await fetch("/api/push", { method: "POST", body });
  if (!response.ok) throw new Error(`Push request failed: ${response.status}`);
  return (await response.json()) as { ok?: boolean; stored?: boolean };
}

async function readStatus(): Promise<PushDeviceStatus> {
  if (isIos() && !isStandalone()) return "needs-home-screen";
  if (!pushSupported()) return "unsupported";
  if (Notification.permission === "denied") return "blocked";
  if (Notification.permission !== "granted") return "off";

  const registration = await navigator.serviceWorker.getRegistration();
  const subscription = await registration?.pushManager.getSubscription();
  if (!subscription) return "off";
  const { stored } = await postPush({
    intent: "status",
    endpoint: subscription.endpoint,
  });
  return stored ? "on" : "off";
}

// `publicKey` is the VAPID public key; without it push isn't configured and
// nothing is offered.
export function usePushDevice(publicKey: string | null) {
  const [status, setStatus] = useState<PushDeviceStatus>("loading");
  const [hidden, setHidden] = useState(true);

  useEffect(() => {
    if (!publicKey) {
      setStatus("unsupported");
      return;
    }
    setHidden(hiddenByNotNow());
    if (pushSupported()) {
      navigator.serviceWorker.register("/sw.js").catch((error) => {
        console.error("Service worker registration failed", error);
      });
    }
    let cancelled = false;
    readStatus()
      .then((next) => {
        if (!cancelled) setStatus(next);
      })
      .catch(() => {
        if (!cancelled) setStatus("off");
      });
    return () => {
      cancelled = true;
    };
  }, [publicKey]);

  const notNow = useCallback(() => {
    try {
      localStorage.setItem(
        HIDDEN_UNTIL_KEY,
        String(Date.now() + NOT_NOW_DAYS * 24 * 60 * 60 * 1000)
      );
    } catch {
      // Storage unavailable: hide for this page only.
    }
    setHidden(true);
  }, []);

  // Must run straight from the Turn on tap: browsers only show the
  // permission prompt for a user gesture.
  const turnOn = useCallback(async () => {
    if (!publicKey) return;
    const permission = await Notification.requestPermission();
    if (permission !== "granted") {
      setStatus(permission === "denied" ? "blocked" : "off");
      if (permission === "denied") {
        toast.error("Notifications blocked", {
          description: "You can unblock them in your browser's site settings.",
        });
      }
      return;
    }

    try {
      const registration = await navigator.serviceWorker.register("/sw.js");
      await navigator.serviceWorker.ready;
      const subscription =
        (await registration.pushManager.getSubscription()) ??
        (await registration.pushManager.subscribe({
          userVisibleOnly: true,
          applicationServerKey: urlBase64ToUint8Array(publicKey),
        }));
      const json = subscription.toJSON();
      await postPush({
        intent: "save",
        endpoint: subscription.endpoint,
        p256dh: json.keys?.p256dh ?? "",
        auth: json.keys?.auth ?? "",
      });
      setStatus("on");
      toast.success("Phone notifications are on for this device", {
        description: "We sent a test so you can see what they look like.",
      });
      await postPush({ intent: "test", endpoint: subscription.endpoint });
    } catch (error) {
      console.error("Turning on push failed", error);
      toast.error("Couldn't turn on phone notifications", {
        description: "Please try again.",
      });
    }
  }, [publicKey]);

  const waiting =
    !hidden &&
    (status === "off" ||
      status === "blocked" ||
      status === "needs-home-screen");

  return { status, waiting, turnOn, notNow };
}

export type PushDevice = ReturnType<typeof usePushDevice>;

// The small blue dot on the bell while the strip is waiting.
export function PushWaitingDot({ push }: { push: PushDevice }) {
  if (!push.waiting) return null;
  return (
    <span
      className="absolute -bottom-0.5 -right-0.5 size-2 rounded-full bg-blue-600 ring-2 ring-sidebar"
      title="Phone notifications are off"
    />
  );
}

// "Get these on your phone", at the top of the bell dropdown.
export function PushStrip({ push }: { push: PushDevice }) {
  const [steps, setSteps] = useState<"home-screen" | "blocked" | null>(null);
  if (!push.waiting && steps === null) return null;

  const { status } = push;
  const heading =
    status === "needs-home-screen"
      ? "Get these on your iPhone"
      : status === "blocked"
        ? "Notifications are blocked in this browser"
        : "Get these on your phone";
  const subline =
    status === "needs-home-screen"
      ? "Add Cadence to your Home Screen first. It takes a few seconds."
      : status === "blocked"
        ? "Only you can unblock them, in your browser's settings."
        : "Replies and other things that need you, even when Cadence is closed.";

  function onPrimary() {
    if (status === "needs-home-screen") setSteps("home-screen");
    else if (status === "blocked") setSteps("blocked");
    else void push.turnOn();
  }

  return (
    <>
      {push.waiting && (
        <div className="flex gap-3 border-b bg-blue-50 px-4 py-3 text-sm dark:bg-blue-950/40">
          <Smartphone className="mt-0.5 size-4 shrink-0 text-blue-600" />
          <div className="min-w-0 flex-1">
            <p className="font-medium">{heading}</p>
            <p className="mt-0.5 text-xs text-muted-foreground">{subline}</p>
            <div className="mt-2 flex gap-2">
              <Button size="sm" onClick={onPrimary}>
                {status === "needs-home-screen"
                  ? "Show me how"
                  : status === "blocked"
                    ? "How to unblock"
                    : "Turn on"}
              </Button>
              <Button size="sm" variant="ghost" onClick={push.notNow}>
                Not now
              </Button>
            </div>
          </div>
        </div>
      )}

      {steps === "home-screen" && (
        <StepsModal
          title="Get Cadence notifications on your iPhone"
          intro="iPhone only sends web notifications to apps on your Home Screen. Cadence isn't in the App Store; you add it straight from Safari."
          steps={[
            { icon: Share, text: "Tap Share in Safari's toolbar." },
            { icon: PlusSquare, text: "Choose Add to Home Screen, then Add." },
            {
              icon: Smartphone,
              text: "Open Cadence from your Home Screen and tap Turn on again.",
            },
          ]}
          footer="Needs iOS 16.4 or later."
          onClose={() => setSteps(null)}
        />
      )}
      {steps === "blocked" && (
        <StepsModal
          title="Notifications are blocked"
          intro="You (or your browser) blocked notifications for Cadence. Only you can undo that, in the browser:"
          steps={[
            {
              icon: Lock,
              text: "Click the lock or site-settings icon next to the address.",
            },
            { icon: Smartphone, text: "Set Notifications to Allow." },
            { icon: PlusSquare, text: "Come back here and tap Turn on." },
          ]}
          onClose={() => setSteps(null)}
        />
      )}
    </>
  );
}

function StepsModal({
  title,
  intro,
  steps,
  footer,
  onClose,
}: {
  title: string;
  intro: string;
  steps: { icon: typeof Share; text: string }[];
  footer?: string;
  onClose: () => void;
}) {
  return (
    <div
      className="fixed inset-0 z-[60] flex items-end justify-center bg-black/40 sm:items-center"
      role="dialog"
      aria-modal="true"
      aria-label={title}
    >
      <div className="w-full max-w-sm rounded-t-xl bg-popover p-5 text-popover-foreground shadow-xl sm:rounded-xl">
        <div className="flex items-start justify-between gap-4">
          <h3 className="text-base font-semibold">{title}</h3>
          <button
            type="button"
            onClick={onClose}
            aria-label="Close"
            className="rounded-md p-1 text-muted-foreground hover:bg-muted"
          >
            <X className="size-4" />
          </button>
        </div>
        <p className="mt-2 text-sm text-muted-foreground">{intro}</p>
        <ol className="mt-4 space-y-3">
          {steps.map(({ icon: Icon, text }, i) => (
            <li key={text} className="flex items-center gap-3 text-sm">
              <span className="flex size-6 shrink-0 items-center justify-center rounded-full bg-primary text-xs font-semibold text-primary-foreground">
                {i + 1}
              </span>
              <Icon className="size-4 shrink-0 text-muted-foreground" />
              <span>{text}</span>
            </li>
          ))}
        </ol>
        {footer && (
          <p className="mt-4 text-xs text-muted-foreground">{footer}</p>
        )}
        <Button className="mt-5 w-full" onClick={onClose}>
          Got it
        </Button>
      </div>
    </div>
  );
}
