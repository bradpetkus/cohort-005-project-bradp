import { data, redirect } from "react-router";
import { z } from "zod";
import type { Route } from "./+types/api.notifications";
import { db } from "~/db";
import { getCurrentUserId } from "~/lib/session";
import { requireUserId } from "~/lib/access.server";
import { parseFormData } from "~/lib/validation";
import {
  getUnreadCount,
  listBell,
  markAllNotificationsRead,
  markNotificationRead,
} from "~/lib/notifications.server";

// The live bell polls this for the signed-in person's own count and rows. It
// is cheap on purpose: never poll the layout loader instead.
export async function loader({ request }: Route.LoaderArgs) {
  const userId = await getCurrentUserId(request);
  // Returned, not thrown: a thrown error from a fetcher would replace the page
  // with the error boundary just because a background poll lost its session.
  if (!userId) return data(null, { status: 401 });
  return {
    unreadCount: getUnreadCount(db, userId),
    rows: listBell(db, userId),
  };
}

// Read state for the signed-in person's own bell. Submitting either intent
// revalidates the layout loader, so the badge updates.
const notificationActionSchema = z.discriminatedUnion("intent", [
  z.object({
    intent: z.literal("mark-read"),
    notificationId: z.coerce.number().int().positive(),
  }),
  z.object({ intent: z.literal("mark-all-read") }),
]);

export async function action({ request }: Route.ActionArgs) {
  const userId = await requireUserId(request);

  const parsed = parseFormData(await request.formData(), notificationActionSchema);
  if (!parsed.success) {
    throw data("Invalid request", { status: 400 });
  }

  const now = new Date();

  if (parsed.data.intent === "mark-read") {
    const destination = markNotificationRead(
      db,
      userId,
      parsed.data.notificationId,
      now
    );
    if (destination === null) {
      throw data("Notification not found", { status: 404 });
    }
    // Marking a row read always goes to its source.
    return redirect(destination);
  }

  markAllNotificationsRead(db, userId, now);
  return { ok: true };
}
