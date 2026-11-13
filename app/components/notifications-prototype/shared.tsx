// PROTOTYPE — throwaway. Shared bits for the notification bell prototype.
import { useEffect, useState } from "react";
import { useNavigate, useSearchParams } from "react-router";
import {
  ChevronLeft,
  ChevronRight,
  CornerDownRight,
  HelpCircle,
  Megaphone,
  Receipt,
  ShoppingCart,
  UserMinus,
  UserPlus,
  Ticket,
  Smartphone,
} from "lucide-react";
import { cn } from "~/lib/utils";
import { useNotificationsPrototype, type NotificationKind } from "./store";

export const VARIANTS = [
  { key: "A", name: "Bell + dropdown" },
  { key: "B", name: "Nav item + slide-over drawer" },
  { key: "C", name: "Inbox page (two-pane)" },
] as const;
export type VariantKey = (typeof VARIANTS)[number]["key"];

const STORAGE_KEY = "notif-proto-variant";

/** ?variant= wins; otherwise remember the last choice so it survives click-throughs. */
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

export function KindIcon({ kind, className }: { kind: NotificationKind; className?: string }) {
  const c = cn("size-4", className);
  switch (kind) {
    case "reply": return <CornerDownRight className={c} />;
    case "question": return <HelpCircle className={c} />;
    case "announcement": return <Megaphone className={c} />;
    case "refund-decision":
    case "refund-request": return <Receipt className={c} />;
    case "purchase": return <ShoppingCart className={c} />;
    case "enrollment-gained": return <UserPlus className={c} />;
    case "enrollment-ended": return <UserMinus className={c} />;
    case "seat-claimed": return <Ticket className={c} />;
  }
}

export function PushBadge() {
  return (
    <span title="Also sent as phone push" className="inline-flex items-center gap-0.5 text-[10px] text-muted-foreground">
      <Smartphone className="size-3" /> push
    </span>
  );
}

export function UnreadBadge({ count, className }: { count: number; className?: string }) {
  if (count === 0) return null;
  return (
    <span
      className={cn(
        "inline-flex min-w-5 items-center justify-center rounded-full bg-red-600 px-1.5 text-[11px] font-semibold leading-5 text-white",
        className
      )}
    >
      {count > 9 ? "9+" : count}
    </span>
  );
}

/** Floating variant switcher. Never rendered in production builds. */
export function PrototypeSwitcher() {
  const variant = useVariant();
  const navigate = useNavigate();
  const [params] = useSearchParams();
  const store = useNotificationsPrototype();
  const idx = VARIANTS.findIndex((v) => v.key === variant);

  function go(delta: number) {
    const next = VARIANTS[(idx + delta + VARIANTS.length) % VARIANTS.length];
    const p = new URLSearchParams(params);
    p.set("variant", next.key);
    navigate({ search: p.toString() }, { replace: true, preventScrollReset: true });
  }

  useEffect(() => {
    function onKey(e: KeyboardEvent) {
      const t = e.target as HTMLElement | null;
      if (t && (t.tagName === "INPUT" || t.tagName === "TEXTAREA" || t.isContentEditable)) return;
      if (e.key === "ArrowLeft") go(-1);
      if (e.key === "ArrowRight") go(1);
    }
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  });

  if (import.meta.env.PROD) return null;

  return (
    <div className="fixed bottom-4 left-1/2 z-[100] flex -translate-x-1/2 items-center gap-2 rounded-full bg-zinc-900 px-2 py-1.5 text-sm text-white shadow-2xl ring-2 ring-fuchsia-500">
      <button onClick={() => go(-1)} className="rounded-full p-1 hover:bg-white/15" title="Previous variant (←)">
        <ChevronLeft className="size-4" />
      </button>
      <span className="font-mono">
        {variant} <span className="text-white/60">({VARIANTS[idx].name})</span>
      </span>
      <button onClick={() => go(1)} className="rounded-full p-1 hover:bg-white/15" title="Next variant (→)">
        <ChevronRight className="size-4" />
      </button>
      <span className="mx-1 h-4 w-px bg-white/30" />
      <span className="font-mono text-xs text-white/70">
        unread {store.unreadCount}/{store.items.length}
      </span>
      <button onClick={store.simulateNew} className="rounded-full bg-fuchsia-600 px-2 py-0.5 text-xs hover:bg-fuchsia-500" title="Pretend the poll just found a new Notification">
        + simulate arrival
      </button>
      <button onClick={store.reset} className="rounded-full px-2 py-0.5 text-xs text-white/70 hover:bg-white/15">
        reset
      </button>
    </div>
  );
}
