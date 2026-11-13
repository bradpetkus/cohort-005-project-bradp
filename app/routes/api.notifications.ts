import { data, redirect } from "react-router";
import { z } from "zod";
import type { Route } from "./+types/api.notifications";
import { db } from "~/db";
import { getCurrentUserId } from "~/lib/session";
import { parseFormData } from "~/lib/validation";
import {
  markAllNotificationsRead,
  markNotificationRead,
} from "~/lib/notifications.server";

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
  const userId = await getCurrentUserId(request);
  if (!userId) {
    throw data("Select a user from the DevUI panel.", { status: 401 });
  }

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
