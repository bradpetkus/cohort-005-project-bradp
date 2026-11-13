import { and, eq } from "drizzle-orm";
import {
  pushPreferences,
  pushSubscriptions,
  users,
  PushEventType,
} from "~/db/schema";
import { defaultPushTransport, type PushTransport } from "~/lib/push.server";
import { pushEventTypesFor as pushEventTypesForRole } from "~/lib/push";
import type { Db, PushMessage } from "./core.server";

// ─── Push settings ───
// Devices are a person's push subscriptions. Every function here acts only on
// the given person's own data.

export type NewPushSubscription = {
  endpoint: string;
  p256dh: string;
  auth: string;
  deviceName: string;
};

// Saves this browser's subscription for the person. An endpoint belongs to
// one browser, so saving it again (new keys, or another person signed in on
// the same browser) moves it to this person.
export function savePushSubscription(
  db: Db,
  userId: number,
  subscription: NewPushSubscription,
  now: Date
): void {
  db.insert(pushSubscriptions)
    .values({ userId, ...subscription, createdAt: now.toISOString() })
    .onConflictDoUpdate({
      target: pushSubscriptions.endpoint,
      set: {
        userId,
        p256dh: subscription.p256dh,
        auth: subscription.auth,
        deviceName: subscription.deviceName,
      },
    })
    .run();
}

export type PushPreferences = Record<PushEventType, boolean>;

// Every event type is on unless the person muted it. Muting stops only the
// phone buzz; the bell still gets everything.
export function getPushPreferences(db: Db, userId: number): PushPreferences {
  const muted = new Set(
    db
      .select({ eventType: pushPreferences.eventType })
      .from(pushPreferences)
      .where(eq(pushPreferences.userId, userId))
      .all()
      .map((row) => row.eventType)
  );
  const on = (eventType: PushEventType) => !muted.has(eventType);
  return {
    [PushEventType.Reply]: on(PushEventType.Reply),
    [PushEventType.Question]: on(PushEventType.Question),
    [PushEventType.Announcement]: on(PushEventType.Announcement),
    [PushEventType.RefundDecision]: on(PushEventType.RefundDecision),
    [PushEventType.RefundRequest]: on(PushEventType.RefundRequest),
  };
}

// One choice per event type, applying to all of the person's devices.
export function setPushPreference(
  db: Db,
  userId: number,
  eventType: PushEventType,
  enabled: boolean
): void {
  if (enabled) {
    db.delete(pushPreferences)
      .where(
        and(
          eq(pushPreferences.userId, userId),
          eq(pushPreferences.eventType, eventType)
        )
      )
      .run();
  } else {
    db.insert(pushPreferences)
      .values({ userId, eventType })
      .onConflictDoNothing()
      .run();
  }
}

export type PushDevice = {
  id: number;
  endpoint: string;
  deviceName: string;
  createdAt: string;
};

export function listPushDevices(db: Db, userId: number): PushDevice[] {
  return db
    .select({
      id: pushSubscriptions.id,
      endpoint: pushSubscriptions.endpoint,
      deviceName: pushSubscriptions.deviceName,
      createdAt: pushSubscriptions.createdAt,
    })
    .from(pushSubscriptions)
    .where(eq(pushSubscriptions.userId, userId))
    .orderBy(pushSubscriptions.id)
    .all();
}

// Removes one of the person's devices: this browser (by endpoint) or one from
// the device list (by id, "Stop sending").
export function removePushSubscription(
  db: Db,
  userId: number,
  device: { endpoint: string } | { id: number }
): void {
  const match =
    "endpoint" in device
      ? eq(pushSubscriptions.endpoint, device.endpoint)
      : eq(pushSubscriptions.id, device.id);
  db.delete(pushSubscriptions)
    .where(and(eq(pushSubscriptions.userId, userId), match))
    .run();
}

// What the Notifications card on /settings shows a person: their devices and
// one switch per push event type their role can receive. The switches can
// only be used once at least one device is on.
export type PushSettings = {
  devices: PushDevice[];
  events: { eventType: PushEventType; enabled: boolean }[];
  canChooseEvents: boolean;
};

export function getPushSettings(db: Db, userId: number): PushSettings {
  const user = db
    .select({ role: users.role })
    .from(users)
    .where(eq(users.id, userId))
    .get();
  const devices = listPushDevices(db, userId);
  const preferences = getPushPreferences(db, userId);
  const eventTypes = user ? pushEventTypesForRole(user.role) : [];
  return {
    devices,
    events: eventTypes.map((eventType) => ({
      eventType,
      enabled: preferences[eventType],
    })),
    canChooseEvents: devices.length > 0,
  };
}

// The push sent to the device that has just turned push on.
export function testPushMessage(userId: number, endpoint: string): PushMessage {
  return {
    userId,
    title: "Phone notifications are on",
    body: "This is what Cadence notifications look like.",
    tag: "test",
    url: "/",
    endpoint,
  };
}

// ─── Delivering push ───

export type DeliveryReport = {
  delivered: number;
  gone: number;
  failed: number;
};

// Sends each message to every device of its recipient (or only the one it
// names) and deletes devices the push service reports gone (404/410).
// Failures are logged and never thrown, so push never fails the person's
// action.
export async function deliverPushMessages(
  db: Db,
  messages: PushMessage[],
  transport: PushTransport = defaultPushTransport()
): Promise<DeliveryReport> {
  const report: DeliveryReport = { delivered: 0, gone: 0, failed: 0 };

  for (const message of messages) {
    const devices = db
      .select()
      .from(pushSubscriptions)
      .where(
        and(
          eq(pushSubscriptions.userId, message.userId),
          message.endpoint === undefined
            ? undefined
            : eq(pushSubscriptions.endpoint, message.endpoint)
        )
      )
      .all();
    const payload = {
      title: message.title,
      body: message.body,
      tag: message.tag,
      url: message.url,
    };

    const outcomes = await Promise.all(
      devices.map(async (device) => {
        try {
          return await transport.send(device, payload);
        } catch (error) {
          console.error(`Push to device ${device.id} failed`, error);
          return "failed" as const;
        }
      })
    );

    outcomes.forEach((outcome, i) => {
      report[outcome] += 1;
      if (outcome === "gone") {
        db.delete(pushSubscriptions)
          .where(eq(pushSubscriptions.id, devices[i].id))
          .run();
      }
    });
  }

  if (report.failed > 0) {
    console.error(`${report.failed} push message(s) could not be delivered`);
  }
  return report;
}
