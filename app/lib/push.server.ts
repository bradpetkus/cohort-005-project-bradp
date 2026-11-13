import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { sendNotification, WebPushError } from "web-push";

// ─── Phone push transport ───
// A thin adapter, like the mailer's MailTransport. Web Push delivers every
// message when the VAPID keys are set. Without them (local dev, tests) each
// message is written to .push-outbox/ as a JSON file instead, so it can be
// read without sending anything.
//
// Environment:
//   VAPID_PUBLIC_KEY   the public key (also handed to the browser to subscribe)
//   VAPID_PRIVATE_KEY  the private key
//   VAPID_SUBJECT      a mailto: or https: contact (optional)
// Generate a key pair once per environment: `npx web-push generate-vapid-keys`.

// A browser's push subscription, as stored for a device.
export type PushTarget = {
  endpoint: string;
  p256dh: string;
  auth: string;
};

// What the service worker shows. Never contains comment text or notes.
export type PushPayload = {
  title: string;
  body: string;
  // Notification API tag: the bundle key, so bundled pushes replace each other.
  tag: string;
  // Internal path the notification opens.
  url: string;
};

// "gone": the push service says the subscription no longer exists (404/410).
export type PushOutcome = "delivered" | "gone" | "failed";

export interface PushTransport {
  send(target: PushTarget, payload: PushPayload): Promise<PushOutcome>;
}

export type VapidKeys = {
  publicKey: string;
  privateKey: string;
  subject: string;
};

const DEFAULT_SUBJECT = "mailto:hello@cadence.dev";

export function webPushTransport(vapid: VapidKeys): PushTransport {
  return {
    async send(target, payload) {
      try {
        await sendNotification(
          {
            endpoint: target.endpoint,
            keys: { p256dh: target.p256dh, auth: target.auth },
          },
          JSON.stringify(payload),
          {
            vapidDetails: vapid,
            // Sent immediately; drop it if the device is offline for a day.
            TTL: 60 * 60 * 24,
            urgency: "high",
            timeout: 10_000,
          }
        );
        return "delivered";
      } catch (error) {
        if (
          error instanceof WebPushError &&
          (error.statusCode === 404 || error.statusCode === 410)
        ) {
          return "gone";
        }
        console.error("Push delivery failed", error);
        return "failed";
      }
    },
  };
}

export function pushOutboxTransport(directory: string): PushTransport {
  return {
    async send(target, payload) {
      mkdirSync(directory, { recursive: true });
      const file = join(
        directory,
        `${Date.now()}-${Math.random().toString(36).slice(2, 8)}.json`
      );
      writeFileSync(
        file,
        JSON.stringify({ endpoint: target.endpoint, ...payload }, null, 2)
      );
      return "delivered";
    },
  };
}

// The VAPID keys from the environment, or null when push isn't configured.
export function vapidKeysFromEnv(): VapidKeys | null {
  const publicKey = process.env.VAPID_PUBLIC_KEY;
  const privateKey = process.env.VAPID_PRIVATE_KEY;
  if (!publicKey || !privateKey) return null;
  return {
    publicKey,
    privateKey,
    subject: process.env.VAPID_SUBJECT || DEFAULT_SUBJECT,
  };
}

// The key the browser subscribes with, or null when push isn't configured.
export function vapidPublicKey(): string | null {
  return vapidKeysFromEnv()?.publicKey ?? null;
}

export function defaultPushTransport(): PushTransport {
  const vapid = vapidKeysFromEnv();
  return vapid ? webPushTransport(vapid) : pushOutboxTransport(".push-outbox");
}
