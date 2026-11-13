import { data } from "react-router";
import { z } from "zod";
import type { Route } from "./+types/api.push";
import { db } from "~/db";
import { getCurrentUserId } from "~/lib/session";
import { parseFormData } from "~/lib/validation";
import {
  deliverPushMessages,
  listPushDevices,
  removePushSubscription,
  savePushSubscription,
  setPushPreference,
  testPushMessage,
} from "~/lib/notifications.server";
import { PushEventType } from "~/db/schema";
import { deviceNameFromUserAgent } from "~/lib/push";

// Phone push devices for the signed-in person. Every intent acts only on the
// person's own subscriptions.
const endpoint = z.string().url().max(2048);

const pushActionSchema = z.discriminatedUnion("intent", [
  // Saves this browser's subscription.
  z.object({
    intent: z.literal("save"),
    endpoint,
    p256dh: z.string().min(1).max(512),
    auth: z.string().min(1).max(512),
  }),
  // Removes this browser (endpoint) or a listed device (deviceId).
  z.object({ intent: z.literal("remove"), endpoint }),
  z.object({
    intent: z.literal("remove-device"),
    deviceId: z.coerce.number().int().positive(),
  }),
  // Sends a test push to this browser.
  z.object({ intent: z.literal("test"), endpoint }),
  // Whether this browser's subscription is stored for the person.
  z.object({ intent: z.literal("status"), endpoint }),
  // Turns one push event type on or off for all of the person's devices.
  z.object({
    intent: z.literal("preference"),
    eventType: z.nativeEnum(PushEventType),
    enabled: z.enum(["true", "false"]).transform((value) => value === "true"),
  }),
]);

export async function action({ request }: Route.ActionArgs) {
  const userId = await getCurrentUserId(request);
  if (!userId) {
    throw data("Select a user from the DevUI panel.", { status: 401 });
  }

  const parsed = parseFormData(await request.formData(), pushActionSchema);
  if (!parsed.success) {
    throw data("Invalid request", { status: 400 });
  }
  const input = parsed.data;

  switch (input.intent) {
    case "save":
      savePushSubscription(
        db,
        userId,
        {
          endpoint: input.endpoint,
          p256dh: input.p256dh,
          auth: input.auth,
          deviceName: deviceNameFromUserAgent(request.headers.get("user-agent")),
        },
        new Date()
      );
      return { ok: true };

    case "remove":
      removePushSubscription(db, userId, { endpoint: input.endpoint });
      return { ok: true };

    case "remove-device":
      removePushSubscription(db, userId, { id: input.deviceId });
      return { ok: true };

    case "test": {
      const report = await deliverPushMessages(db, [
        testPushMessage(userId, input.endpoint),
      ]);
      return { ok: report.delivered > 0 };
    }

    case "preference":
      setPushPreference(db, userId, input.eventType, input.enabled);
      return { ok: true };

    case "status":
      return {
        stored: listPushDevices(db, userId).some(
          (device) => device.endpoint === input.endpoint
        ),
      };
  }
}
