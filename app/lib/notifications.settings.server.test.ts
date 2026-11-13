import { describe, it, expect, beforeEach } from "vitest";
import { createTestDb, seedBaseData } from "~/test/setup";
import * as schema from "~/db/schema";
import { PushEventType, UserRole } from "~/db/schema";
import {
  deliverPushMessages,
  getPushSettings,
  listBell,
  recordNotificationEvent,
  removePushSubscription,
  savePushSubscription,
  setPushPreference,
} from "./notifications.server";
import type { PushPayload, PushTransport } from "./push.server";

// The Notifications card on /settings (#21): what it shows for a person and
// what its controls change.

type TestDb = ReturnType<typeof createTestDb>;

const NOW = new Date(2026, 9, 6, 12, 0, 0);

let db: TestDb;
let base: ReturnType<typeof seedBaseData>;

beforeEach(() => {
  db = createTestDb();
  base = seedBaseData(db);
});

function addPerson(name: string, role: UserRole) {
  return db
    .insert(schema.users)
    .values({ name, email: `${name.toLowerCase()}@example.com`, role })
    .returning()
    .get();
}

function addDevice(userId: number, name = "Chrome on Android") {
  const endpoint = `https://push.example.com/${userId}/${Math.random()}`;
  savePushSubscription(
    db,
    userId,
    { endpoint, p256dh: "p256dh-key", auth: "auth-secret", deviceName: name },
    NOW
  );
  return endpoint;
}

describe("Push me about", () => {
  it("offers a Student replies, Announcements and refund decisions, all on", () => {
    const ana = addPerson("Ana", UserRole.Student);

    expect(getPushSettings(db, ana.id).events).toEqual([
      { eventType: PushEventType.Reply, enabled: true },
      { eventType: PushEventType.Announcement, enabled: true },
      { eventType: PushEventType.RefundDecision, enabled: true },
    ]);
  });

  it("offers an Instructor replies and new questions, all on", () => {
    expect(getPushSettings(db, base.instructor.id).events).toEqual([
      { eventType: PushEventType.Reply, enabled: true },
      { eventType: PushEventType.Question, enabled: true },
    ]);
  });

  it("offers a Platform Admin new Refund Requests and replies, all on", () => {
    const pat = addPerson("Pat", UserRole.Admin);

    expect(getPushSettings(db, pat.id).events).toEqual([
      { eventType: PushEventType.RefundRequest, enabled: true },
      { eventType: PushEventType.Reply, enabled: true },
    ]);
  });

  it("shows a muted event type switched off, and only for that person", () => {
    const ana = addPerson("Ana", UserRole.Student);
    const bo = addPerson("Bo", UserRole.Student);

    setPushPreference(db, ana.id, PushEventType.Announcement, false);

    expect(getPushSettings(db, ana.id).events).toEqual([
      { eventType: PushEventType.Reply, enabled: true },
      { eventType: PushEventType.Announcement, enabled: false },
      { eventType: PushEventType.RefundDecision, enabled: true },
    ]);
    expect(
      getPushSettings(db, bo.id).events.every((event) => event.enabled)
    ).toBe(true);
  });

  it("can't be changed until the person has a device on", () => {
    const ana = addPerson("Ana", UserRole.Student);
    expect(getPushSettings(db, ana.id).canChooseEvents).toBe(false);

    addDevice(ana.id);

    expect(getPushSettings(db, ana.id).canChooseEvents).toBe(true);
  });
});

describe("muting an event type", () => {
  it("stops the push on every device but still puts the row in the bell, untagged", async () => {
    const ana = base.user;
    addDevice(ana.id, "Chrome on Android");
    addDevice(ana.id, "Chrome on Windows");
    setPushPreference(db, ana.id, PushEventType.Reply, false);
    const { pushMessages } = replyTo(ana.id, addPerson("Sam", UserRole.Student).id);
    const { transport, sent } = recordingTransport();

    await deliverPushMessages(db, pushMessages, transport);

    expect(sent).toEqual([]);
    expect(listBell(db, ana.id)).toEqual([
      expect.objectContaining({ unread: true, pushed: false }),
    ]);
  });

  it("pushes to every device again once switched back on", async () => {
    const ana = base.user;
    addDevice(ana.id, "Chrome on Android");
    addDevice(ana.id, "Chrome on Windows");
    setPushPreference(db, ana.id, PushEventType.Reply, false);
    setPushPreference(db, ana.id, PushEventType.Reply, true);
    const { pushMessages } = replyTo(ana.id, addPerson("Sam", UserRole.Student).id);
    const { transport, sent } = recordingTransport();

    await deliverPushMessages(db, pushMessages, transport);

    expect(sent).toHaveLength(2);
    expect(listBell(db, ana.id)[0].pushed).toBe(true);
  });
});

describe("Stop sending", () => {
  it("removes that device from the person's list and stops pushing to it", async () => {
    const ana = base.user;
    addDevice(ana.id, "Chrome on Android");
    const laptop = addDevice(ana.id, "Chrome on Windows");
    const [phone] = getPushSettings(db, ana.id).devices;

    removePushSubscription(db, ana.id, { id: phone.id });
    const { pushMessages } = replyTo(ana.id, addPerson("Sam", UserRole.Student).id);
    const { transport, sent } = recordingTransport();
    await deliverPushMessages(db, pushMessages, transport);

    expect(getPushSettings(db, ana.id).devices).toEqual([
      expect.objectContaining({ deviceName: "Chrome on Windows" }),
    ]);
    expect(sent.map((s) => s.endpoint)).toEqual([laptop]);
  });

  it("can't stop someone else's device", () => {
    const ana = addPerson("Ana", UserRole.Student);
    const bo = addPerson("Bo", UserRole.Student);
    addDevice(bo.id);
    const [bosDevice] = getPushSettings(db, bo.id).devices;

    removePushSubscription(db, ana.id, { id: bosDevice.id });

    expect(getPushSettings(db, bo.id).devices).toHaveLength(1);
  });

  it("greys the switches out again once the last device is stopped", () => {
    const ana = addPerson("Ana", UserRole.Student);
    addDevice(ana.id);
    const [phone] = getPushSettings(db, ana.id).devices;

    removePushSubscription(db, ana.id, { id: phone.id });

    expect(getPushSettings(db, ana.id).canChooseEvents).toBe(false);
  });
});

// A reply from `replierId` on a fresh question by `authorId`.
function replyTo(authorId: number, replierId: number) {
  const module = db
    .insert(schema.modules)
    .values({ courseId: base.course.id, title: "Basics", position: 1 })
    .returning()
    .get();
  const lesson = db
    .insert(schema.lessons)
    .values({ moduleId: module.id, title: "Lesson 3", position: 1 })
    .returning()
    .get();
  const question = db
    .insert(schema.comments)
    .values({ lessonId: lesson.id, userId: authorId, parentId: null, body: "How?" })
    .returning()
    .get();
  const answer = db
    .insert(schema.comments)
    .values({
      lessonId: lesson.id,
      userId: replierId,
      parentId: question.id,
      body: "Like this.",
    })
    .returning()
    .get();
  return recordNotificationEvent(
    db,
    { type: "comment_reply", commentId: answer.id },
    NOW
  );
}

function recordingTransport() {
  const sent: { endpoint: string; payload: PushPayload }[] = [];
  const transport: PushTransport = {
    async send(target, payload) {
      sent.push({ endpoint: target.endpoint, payload });
      return "delivered";
    },
  };
  return { transport, sent };
}
