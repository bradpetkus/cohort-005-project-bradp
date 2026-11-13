import { useEffect, useRef, useState } from "react";
import { Form, useFetcher } from "react-router";
import {
  Bell,
  CornerDownRight,
  HelpCircle,
  Megaphone,
  Receipt,
  ShoppingCart,
  Smartphone,
  Ticket,
  UserMinus,
  UserPlus,
} from "lucide-react";
import { NotificationType } from "~/db/schema";
import type { BellRow } from "~/lib/notifications.server";
import { cn, formatRelativeTime } from "~/lib/utils";

// The bell in the sidebar header. Its count and rows come from the app layout
// loader, so they refresh on every navigation and action.

const ICONS: Record<NotificationType, typeof Bell> = {
  [NotificationType.Reply]: CornerDownRight,
  [NotificationType.Question]: HelpCircle,
  [NotificationType.Announcement]: Megaphone,
  [NotificationType.RefundDecision]: Receipt,
  [NotificationType.RefundRequest]: Receipt,
  [NotificationType.Purchase]: ShoppingCart,
  [NotificationType.EnrollmentGained]: UserPlus,
  [NotificationType.EnrollmentEnded]: UserMinus,
  [NotificationType.SeatClaimed]: Ticket,
};

export function UnreadBadge({
  count,
  className,
}: {
  count: number;
  className?: string;
}) {
  if (count <= 0) return null;
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

export function NotificationBell({
  unreadCount,
  rows,
}: {
  unreadCount: number;
  rows: BellRow[];
}) {
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLDivElement>(null);
  const markAll = useFetcher();

  useEffect(() => {
    if (!open) return;
    function onMouseDown(event: MouseEvent) {
      if (ref.current && !ref.current.contains(event.target as Node)) {
        setOpen(false);
      }
    }
    function onKeyDown(event: KeyboardEvent) {
      if (event.key === "Escape") setOpen(false);
    }
    document.addEventListener("mousedown", onMouseDown);
    document.addEventListener("keydown", onKeyDown);
    return () => {
      document.removeEventListener("mousedown", onMouseDown);
      document.removeEventListener("keydown", onKeyDown);
    };
  }, [open]);

  return (
    <div ref={ref} className="relative">
      <button
        type="button"
        onClick={() => setOpen((o) => !o)}
        aria-label={
          unreadCount > 0
            ? `Notifications, ${unreadCount} unread`
            : "Notifications"
        }
        aria-expanded={open}
        aria-haspopup="true"
        className="relative rounded-md p-1.5 text-sidebar-foreground/70 hover:bg-sidebar-accent hover:text-sidebar-accent-foreground"
      >
        <Bell className="size-5" />
        <UnreadBadge count={unreadCount} className="absolute -right-1 -top-1" />
      </button>

      {open && (
        <div className="absolute left-full top-0 z-50 ml-3 w-96 overflow-hidden rounded-lg border bg-popover text-popover-foreground shadow-xl">
          <div className="flex items-center justify-between border-b px-4 py-3">
            <h2 className="text-sm font-semibold">Notifications</h2>
            <markAll.Form method="post" action="/api/notifications">
              <input type="hidden" name="intent" value="mark-all-read" />
              <button
                type="submit"
                disabled={unreadCount === 0}
                className="text-xs text-primary hover:underline disabled:pointer-events-none disabled:opacity-50"
              >
                Mark all read
              </button>
            </markAll.Form>
          </div>

          {rows.length === 0 ? (
            <p className="px-4 py-10 text-center text-sm text-muted-foreground">
              You're all caught up.
            </p>
          ) : (
            <ul className="max-h-[420px] divide-y overflow-y-auto">
              {rows.map((row) => (
                <li key={row.id}>
                  <BellRowItem row={row} onOpen={() => setOpen(false)} />
                </li>
              ))}
            </ul>
          )}
        </div>
      )}
    </div>
  );
}

// Submitting marks the row read and redirects to its source.
function BellRowItem({ row, onOpen }: { row: BellRow; onOpen: () => void }) {
  const Icon = ICONS[row.type];
  return (
    <Form method="post" action="/api/notifications" onSubmit={onOpen}>
      <input type="hidden" name="intent" value="mark-read" />
      <input type="hidden" name="notificationId" value={row.id} />
      <button
        type="submit"
        className={cn(
          "flex w-full items-start gap-3 px-4 py-3 text-left hover:bg-muted/60",
          row.unread && "bg-primary/5"
        )}
      >
        <Icon className="mt-0.5 size-4 shrink-0 text-muted-foreground" />
        <span className="min-w-0 flex-1">
          <span
            className={cn(
              "block text-sm",
              row.unread ? "font-semibold" : "text-muted-foreground"
            )}
          >
            {row.title}
          </span>
          <span className="block truncate text-xs text-muted-foreground">
            {row.snippet}
          </span>
          <span className="mt-1 flex items-center gap-2 text-[11px] text-muted-foreground">
            <span suppressHydrationWarning>
              {formatRelativeTime(row.lastEventAt)}
            </span>
            {row.pushed && (
              <span
                className="inline-flex items-center gap-0.5"
                title="Also sent as phone push"
              >
                <Smartphone className="size-3" />
                push
              </span>
            )}
          </span>
        </span>
        {row.unread && (
          <span
            className="mt-1.5 size-2 shrink-0 rounded-full bg-blue-600"
            aria-label="Unread"
          />
        )}
      </button>
    </Form>
  );
}
