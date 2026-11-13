import { PushEventType, UserRole } from "~/db/schema";

// Phone push rules shared by the server and the browser (no server imports).

// The push event types a person can receive, in the order the settings card
// lists them.
export function pushEventTypesFor(role: UserRole): PushEventType[] {
  switch (role) {
    case UserRole.Instructor:
      return [PushEventType.Reply, PushEventType.Question];
    case UserRole.Admin:
      return [PushEventType.RefundRequest, PushEventType.Reply];
    case UserRole.Student:
      return [
        PushEventType.Reply,
        PushEventType.Announcement,
        PushEventType.RefundDecision,
      ];
  }
}

export const PUSH_EVENT_LABELS: Record<PushEventType, string> = {
  [PushEventType.Reply]: "Replies in a comment thread you're in",
  [PushEventType.Question]: "New questions on your lessons",
  [PushEventType.Announcement]: "Announcements from your courses",
  [PushEventType.RefundDecision]: "Decisions on your Refund Requests",
  [PushEventType.RefundRequest]: "New Refund Requests",
};

// A readable device name such as "Chrome on Android", from a user agent.
export function deviceNameFromUserAgent(userAgent: string | null): string {
  const ua = userAgent ?? "";
  const os = /iPhone|iPod/.test(ua)
    ? "iPhone"
    : /iPad/.test(ua)
      ? "iPad"
      : /Android/.test(ua)
        ? "Android"
        : /Windows/.test(ua)
          ? "Windows"
          : /Macintosh|Mac OS X/.test(ua)
            ? "Mac"
            : /CrOS/.test(ua)
              ? "ChromeOS"
              : /Linux/.test(ua)
                ? "Linux"
                : null;
  const browser = /Edg\//.test(ua)
    ? "Edge"
    : /SamsungBrowser/.test(ua)
      ? "Samsung Internet"
      : /Firefox|FxiOS/.test(ua)
        ? "Firefox"
        : /Chrome|CriOS/.test(ua)
          ? "Chrome"
          : /Safari/.test(ua)
            ? "Safari"
            : null;

  // An iPhone or iPad Home Screen app has no browser name in its user agent.
  if ((os === "iPhone" || os === "iPad") && browser === null) {
    return `${os} (Home Screen app)`;
  }
  if (browser && os) return `${browser} on ${os}`;
  return browser ?? os ?? "Unknown device";
}
