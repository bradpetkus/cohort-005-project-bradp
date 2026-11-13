import { useEffect, useRef, useState } from "react";
import { useFetcher, useSubmit } from "react-router";
import { toast } from "sonner";
import { NotificationBell } from "~/components/notification-bell";
import { arrivedSince } from "~/lib/bell-poll";
import type { BellRow } from "~/lib/notifications.server";
import type { loader } from "~/routes/api.notifications";

// Keeps the bell current while someone sits on a page. The layout loader
// still supplies fresh data on every navigation and action; between those,
// this polls the cheap `api/notifications` loader and toasts new arrivals.
// No SSE or websockets, and never an interval revalidation of the layout.

export const POLL_INTERVAL_MS = 45_000;
// More arrivals than this in one poll get a single summary toast.
const MAX_TOASTS = 3;

type Bell = { unreadCount: number; rows: BellRow[] };

export function LiveBell({ unreadCount, rows }: Bell) {
  const poll = useFetcher<typeof loader>();
  const submit = useSubmit();
  const [bell, setBell] = useState<Bell>({ unreadCount, rows });
  // What the person has already been shown. Rows the layout loader rendered
  // count as seen, so they never toast.
  const seen = useRef<BellRow[]>(rows);

  // Fresh data from the layout loader (navigation or action).
  useEffect(() => {
    seen.current = rows;
    setBell({ unreadCount, rows });
  }, [unreadCount, rows]);

  // Fresh data from a poll.
  useEffect(() => {
    const polled = poll.data;
    if (!polled) return;
    const arrived = arrivedSince(seen.current, polled.rows);
    seen.current = polled.rows;
    setBell(polled);

    if (arrived.length > MAX_TOASTS) {
      toast(`${arrived.length} new notifications`, {
        description: "Open the bell to see them.",
      });
      return;
    }
    for (const row of arrived) {
      toast(row.title, {
        description: row.snippet,
        action: {
          label: "Open",
          // Marks the row read and goes to its source, like clicking it in
          // the bell.
          onClick: () =>
            submit(
              { intent: "mark-read", notificationId: row.id },
              { method: "post", action: "/api/notifications" }
            ),
        },
      });
    }
  }, [poll.data, submit]);

  // Poll on an interval, skipping ticks while the tab is hidden. Check once
  // straight away when the tab comes back.
  const load = useRef(poll.load);
  load.current = poll.load;
  const busy = poll.state !== "idle";
  const busyRef = useRef(busy);
  busyRef.current = busy;
  useEffect(() => {
    function tick() {
      if (document.hidden || busyRef.current) return;
      load.current("/api/notifications");
    }
    const id = window.setInterval(tick, POLL_INTERVAL_MS);
    document.addEventListener("visibilitychange", tick);
    return () => {
      window.clearInterval(id);
      document.removeEventListener("visibilitychange", tick);
    };
  }, []);

  return <NotificationBell unreadCount={bell.unreadCount} rows={bell.rows} />;
}
