// PROTOTYPE — throwaway. The three notification UI variants.
//   A: bell in the sidebar header, popover dropdown of the newest few, "See all" page.
//   B: "Notifications" nav item with badge, opens a right-hand slide-over drawer
//      (Unread / All tabs, Today / Earlier groups, per-row read toggle). No page.
//   C: "Inbox" nav item with badge, links to a full two-pane inbox page
//      (category filters, list left, detail right; opening an item marks it read).
import { useEffect, useRef, useState } from "react";
import { NavLink, useNavigate } from "react-router";
import { Bell, CheckCheck, Inbox, X } from "lucide-react";
import { cn } from "~/lib/utils";
import {
  isToday,
  timeAgo,
  useNotificationsPrototype,
  type NotificationKind,
  type ProtoNotification,
} from "./store";
import { KindIcon, PushBadge, UnreadBadge, useVariant } from "./shared";

const navClass = ({ isActive }: { isActive: boolean }) =>
  cn(
    "flex items-center gap-3 rounded-md px-3 py-2 text-sm font-medium transition-colors",
    isActive
      ? "bg-sidebar-accent text-sidebar-accent-foreground"
      : "text-sidebar-foreground/70 hover:bg-sidebar-accent hover:text-sidebar-accent-foreground"
  );

function useOpen(n: ProtoNotification, after?: () => void) {
  const navigate = useNavigate();
  const { markRead } = useNotificationsPrototype();
  return () => {
    markRead(n.id);
    after?.();
    navigate(n.href);
  };
}

/* ───────────────────────── Variant A ───────────────────────── */

export function RowA({ n, onDone }: { n: ProtoNotification; onDone: () => void }) {
  const open = useOpen(n, onDone);
  return (
    <button
      onClick={open}
      className={cn(
        "flex w-full gap-3 px-4 py-3 text-left hover:bg-accent",
        !n.read && "bg-primary/5"
      )}
    >
      <KindIcon kind={n.kind} className="mt-0.5 shrink-0 text-muted-foreground" />
      <div className="min-w-0 flex-1">
        <div className={cn("text-sm", !n.read ? "font-semibold" : "text-muted-foreground")}>{n.title}</div>
        {n.snippet && <div className="truncate text-xs text-muted-foreground">{n.snippet}</div>}
        <div className="mt-0.5 text-xs text-muted-foreground">{timeAgo(n.minutesAgo)}</div>
      </div>
      {!n.read && <span className="mt-1.5 size-2 shrink-0 rounded-full bg-blue-600" />}
    </button>
  );
}

export function BellDropdownA() {
  const { items, unreadCount, markAllRead } = useNotificationsPrototype();
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!open) return;
    const onDown = (e: MouseEvent) => {
      if (ref.current && !ref.current.contains(e.target as Node)) setOpen(false);
    };
    const onKey = (e: KeyboardEvent) => e.key === "Escape" && setOpen(false);
    document.addEventListener("mousedown", onDown);
    document.addEventListener("keydown", onKey);
    return () => {
      document.removeEventListener("mousedown", onDown);
      document.removeEventListener("keydown", onKey);
    };
  }, [open]);

  return (
    <div ref={ref} className="relative ml-auto">
      <button
        onClick={() => setOpen((o) => !o)}
        className="relative rounded-md p-1.5 text-sidebar-foreground/70 hover:bg-sidebar-accent"
        title="Notifications"
      >
        <Bell className="size-5" />
        <UnreadBadge count={unreadCount} className="absolute -right-1 -top-1" />
      </button>
      {open && (
        <div className="absolute left-full top-0 z-50 ml-3 w-96 overflow-hidden rounded-lg border bg-popover text-popover-foreground shadow-xl">
          <div className="flex items-center justify-between border-b px-4 py-2.5">
            <span className="font-semibold">Notifications</span>
            <button
              onClick={markAllRead}
              disabled={unreadCount === 0}
              className="text-xs text-primary hover:underline disabled:text-muted-foreground disabled:no-underline"
            >
              Mark all read
            </button>
          </div>
          <div className="max-h-[420px] divide-y overflow-y-auto">
            {items.length === 0 ? (
              <div className="p-6 text-center text-sm text-muted-foreground">You're all caught up.</div>
            ) : (
              items.slice(0, 6).map((n) => <RowA key={n.id} n={n} onDone={() => setOpen(false)} />)
            )}
          </div>
          <NavLink
            to="/notifications"
            onClick={() => setOpen(false)}
            className="block border-t px-4 py-2.5 text-center text-sm text-primary hover:bg-accent"
          >
            See all notifications
          </NavLink>
        </div>
      )}
    </div>
  );
}

/** Variant A's "See all" page: a plain flat list, same rows. */
export function FullListA() {
  const { items, unreadCount, markAllRead } = useNotificationsPrototype();
  return (
    <div className="mx-auto max-w-2xl p-8">
      <div className="mb-4 flex items-center justify-between">
        <h1 className="text-2xl font-bold">Notifications</h1>
        <button onClick={markAllRead} disabled={unreadCount === 0} className="text-sm text-primary hover:underline disabled:text-muted-foreground">
          Mark all read
        </button>
      </div>
      <div className="divide-y overflow-hidden rounded-lg border">
        {items.map((n) => <RowA key={n.id} n={n} onDone={() => {}} />)}
      </div>
    </div>
  );
}

/* ───────────────────────── Variant B ───────────────────────── */

function RowB({ n, onDone }: { n: ProtoNotification; onDone: () => void }) {
  const open = useOpen(n, onDone);
  const { markRead, markUnread } = useNotificationsPrototype();
  return (
    <div className="group flex items-start gap-3 rounded-lg p-3 hover:bg-accent">
      <div className={cn("flex size-9 shrink-0 items-center justify-center rounded-full", n.read ? "bg-muted" : "bg-primary/15 text-primary")}>
        <KindIcon kind={n.kind} />
      </div>
      <button onClick={open} className="min-w-0 flex-1 text-left">
        <div className={cn("text-sm", !n.read && "font-semibold")}>{n.title}</div>
        {n.snippet && <div className="mt-0.5 line-clamp-2 text-xs text-muted-foreground">{n.snippet}</div>}
        <div className="mt-1 flex items-center gap-2 text-xs text-muted-foreground">
          {timeAgo(n.minutesAgo)} {n.push && <PushBadge />}
        </div>
      </button>
      <button
        onClick={() => (n.read ? markUnread(n.id) : markRead(n.id))}
        title={n.read ? "Mark as unread" : "Mark as read"}
        className="mt-1 flex size-5 shrink-0 items-center justify-center rounded-full hover:bg-muted-foreground/20"
      >
        <span className={cn("size-2.5 rounded-full", n.read ? "border border-muted-foreground/40 opacity-0 group-hover:opacity-100" : "bg-blue-600")} />
      </button>
    </div>
  );
}

export function NavDrawerB() {
  const { items, unreadCount, markAllRead } = useNotificationsPrototype();
  const [open, setOpen] = useState(false);
  const [tab, setTab] = useState<"unread" | "all">("unread");

  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => e.key === "Escape" && setOpen(false);
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, [open]);

  const shown = tab === "unread" ? items.filter((n) => !n.read) : items;
  const today = shown.filter((n) => isToday(n.minutesAgo));
  const earlier = shown.filter((n) => !isToday(n.minutesAgo));
  const close = () => setOpen(false);

  return (
    <>
      <button onClick={() => setOpen(true)} className={navClass({ isActive: open }) + " w-full"}>
        <Bell className="size-4" />
        Notifications
        <UnreadBadge count={unreadCount} className="ml-auto" />
      </button>
      {open && (
        <div className="fixed inset-0 z-50">
          <div className="absolute inset-0 bg-black/30" onClick={close} />
          <aside className="absolute right-0 top-0 flex h-full w-[420px] flex-col border-l bg-background shadow-2xl">
            <div className="flex items-center gap-2 border-b px-5 py-4">
              <h2 className="text-lg font-semibold">Notifications</h2>
              <button onClick={close} className="ml-auto rounded-md p-1 hover:bg-accent"><X className="size-5" /></button>
            </div>
            <div className="flex items-center gap-1 border-b px-5 py-2">
              {(["unread", "all"] as const).map((t) => (
                <button
                  key={t}
                  onClick={() => setTab(t)}
                  className={cn("rounded-full px-3 py-1 text-sm capitalize", tab === t ? "bg-primary text-primary-foreground" : "hover:bg-accent")}
                >
                  {t}{t === "unread" && unreadCount > 0 ? ` (${unreadCount})` : ""}
                </button>
              ))}
              <button onClick={markAllRead} disabled={unreadCount === 0} className="ml-auto flex items-center gap-1 text-xs text-primary disabled:text-muted-foreground">
                <CheckCheck className="size-4" /> Mark all read
              </button>
            </div>
            <div className="flex-1 overflow-y-auto px-2 py-2">
              {shown.length === 0 && (
                <div className="p-10 text-center text-sm text-muted-foreground">
                  {tab === "unread" ? "No unread notifications. 🎉" : "Nothing here yet."}
                </div>
              )}
              {today.length > 0 && <div className="px-3 pb-1 pt-2 text-xs font-semibold uppercase tracking-wide text-muted-foreground">Today</div>}
              {today.map((n) => <RowB key={n.id} n={n} onDone={close} />)}
              {earlier.length > 0 && <div className="px-3 pb-1 pt-4 text-xs font-semibold uppercase tracking-wide text-muted-foreground">Earlier</div>}
              {earlier.map((n) => <RowB key={n.id} n={n} onDone={close} />)}
            </div>
          </aside>
        </div>
      )}
    </>
  );
}

/* ───────────────────────── Variant C ───────────────────────── */

export function InboxNavC() {
  const { unreadCount } = useNotificationsPrototype();
  return (
    <NavLink to="/notifications" className={navClass}>
      <Inbox className="size-4" />
      Inbox
      <UnreadBadge count={unreadCount} className="ml-auto" />
    </NavLink>
  );
}

const CATEGORIES: { key: string; label: string; kinds: NotificationKind[] }[] = [
  { key: "all", label: "All", kinds: [] },
  { key: "discussion", label: "Discussion", kinds: ["reply", "question"] },
  { key: "course", label: "Course updates", kinds: ["announcement"] },
  { key: "billing", label: "Billing", kinds: ["refund-decision", "refund-request", "purchase"] },
  { key: "people", label: "People", kinds: ["enrollment-gained", "enrollment-ended", "seat-claimed"] },
];

export function InboxPageC() {
  const { items, unreadCount, markRead, markUnread, markAllRead } = useNotificationsPrototype();
  const navigate = useNavigate();
  const [cat, setCat] = useState("all");
  const [selectedId, setSelectedId] = useState<number | null>(null);

  const kinds = CATEGORIES.find((c) => c.key === cat)!.kinds;
  const shown = kinds.length ? items.filter((n) => kinds.includes(n.kind)) : items;
  const usedCats = CATEGORIES.filter((c) => c.key === "all" || items.some((n) => c.kinds.includes(n.kind)));
  const selected = items.find((n) => n.id === selectedId) ?? null;

  function select(n: ProtoNotification) {
    setSelectedId(n.id);
    markRead(n.id);
  }

  return (
    <div className="flex h-full flex-col">
      <div className="flex items-center gap-3 border-b px-6 py-4">
        <h1 className="text-xl font-bold">Inbox</h1>
        <span className="text-sm text-muted-foreground">{unreadCount} unread</span>
        <button onClick={markAllRead} disabled={unreadCount === 0} className="ml-auto flex items-center gap-1 rounded-md border px-3 py-1.5 text-sm hover:bg-accent disabled:opacity-50">
          <CheckCheck className="size-4" /> Mark all read
        </button>
      </div>
      <div className="flex min-h-0 flex-1">
        <div className="flex w-[380px] shrink-0 flex-col border-r">
          <div className="flex flex-wrap gap-1 border-b p-3">
            {usedCats.map((c) => {
              const u = items.filter((n) => !n.read && (c.kinds.length === 0 || c.kinds.includes(n.kind))).length;
              return (
                <button key={c.key} onClick={() => setCat(c.key)} className={cn("rounded-md px-2.5 py-1 text-xs", cat === c.key ? "bg-primary text-primary-foreground" : "bg-muted hover:bg-accent")}>
                  {c.label}{u > 0 && ` · ${u}`}
                </button>
              );
            })}
          </div>
          <div className="flex-1 overflow-y-auto">
            {shown.map((n) => (
              <button
                key={n.id}
                onClick={() => select(n)}
                className={cn(
                  "flex w-full gap-3 border-b px-4 py-3 text-left",
                  selectedId === n.id ? "bg-accent" : "hover:bg-accent/50",
                  !n.read && "border-l-4 border-l-blue-600"
                )}
              >
                <KindIcon kind={n.kind} className="mt-0.5 shrink-0 text-muted-foreground" />
                <div className="min-w-0 flex-1">
                  <div className="flex items-baseline gap-2">
                    <span className={cn("truncate text-sm", !n.read && "font-semibold")}>{n.actor}</span>
                    <span className="ml-auto shrink-0 text-xs text-muted-foreground">{timeAgo(n.minutesAgo)}</span>
                  </div>
                  <div className="truncate text-xs text-muted-foreground">{n.title}</div>
                </div>
              </button>
            ))}
          </div>
        </div>
        <div className="flex-1 overflow-y-auto p-8">
          {!selected ? (
            <div className="flex h-full items-center justify-center text-muted-foreground">Select a notification</div>
          ) : (
            <div className="max-w-xl">
              <div className="mb-2 flex items-center gap-2 text-sm text-muted-foreground">
                <KindIcon kind={selected.kind} /> {selected.actor} · {timeAgo(selected.minutesAgo)} {selected.push && <PushBadge />}
              </div>
              <h2 className="mb-4 text-xl font-semibold">{selected.title}</h2>
              {selected.snippet && <blockquote className="mb-6 border-l-4 pl-4 text-muted-foreground">{selected.snippet}</blockquote>}
              <div className="flex gap-2">
                <button onClick={() => navigate(selected.href)} className="rounded-md bg-primary px-4 py-2 text-sm text-primary-foreground hover:bg-primary/90">
                  Go to it →
                </button>
                <button onClick={() => markUnread(selected.id)} className="rounded-md border px-4 py-2 text-sm hover:bg-accent">
                  Mark unread
                </button>
              </div>
            </div>
          )}
        </div>
      </div>
    </div>
  );
}

/* ───────────────────────── Slots ───────────────────────── */

export function SidebarHeaderSlot() {
  return useVariant() === "A" ? <BellDropdownA /> : null;
}

export function SidebarNavSlot() {
  const v = useVariant();
  if (v === "B") return <NavDrawerB />;
  if (v === "C") return <InboxNavC />;
  return null;
}

export function NotificationsPageByVariant() {
  const v = useVariant();
  if (v === "C") return <InboxPageC />;
  if (v === "B")
    return (
      <div className="p-8 text-muted-foreground">
        Variant B has no page: notifications live in the drawer (sidebar → Notifications).
      </div>
    );
  return <FullListA />;
}
