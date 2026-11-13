// PROTOTYPE — throwaway. Wayfinder ticket "Prototype: In-app notification bell and list".
// Question: how should in-app notifications look and behave (bell, unread count,
// list, click-through, marking read)? Three variants, switchable via ?variant=A|B|C.
// All state is in memory (React context at the layout level), so read state survives
// client-side navigation but resets on a full reload. Nothing touches the DB.

import { createContext, useContext, useState, type ReactNode } from "react";
import { toast } from "sonner";
import { UserRole } from "~/db/schema";

export type NotificationKind =
  | "reply"
  | "question"
  | "announcement"
  | "refund-decision"
  | "refund-request"
  | "purchase"
  | "enrollment-gained"
  | "enrollment-ended"
  | "seat-claimed";

export interface ProtoNotification {
  id: number;
  kind: NotificationKind;
  actor: string;
  title: string;
  snippet?: string;
  href: string;
  minutesAgo: number;
  read: boolean;
  push: boolean;
}

export interface SampleLinks {
  courseTitle: string;
  courseSlug: string;
  lessonTitle: string;
  lessonHref: string;
}

const FALLBACK_LINKS: SampleLinks = {
  courseTitle: "Intro to TypeScript",
  courseSlug: "",
  lessonTitle: "Generics",
  lessonHref: "/courses",
};

type Seed = Omit<ProtoNotification, "id" | "read"> & { read?: boolean };

function seedFor(
  role: UserRole | null,
  isTeamAdmin: boolean,
  l: SampleLinks
): Seed[] {
  if (role === UserRole.Instructor) {
    return [
      { kind: "question", actor: "Priya Shah", title: `New question on "${l.lessonTitle}"`, snippet: "Why does the generic constraint fail when I pass a union?", href: `${l.lessonHref}#comments`, minutesAgo: 4, push: true },
      { kind: "reply", actor: "Marcus Lee", title: `Marcus Lee replied in a thread you're in`, snippet: "Thanks, that fixed it! One more thing though…", href: `${l.lessonHref}#comments`, minutesAgo: 38, push: true },
      { kind: "enrollment-gained", actor: "Dana Ortiz", title: `Dana Ortiz enrolled in ${l.courseTitle}`, href: `/instructor`, minutesAgo: 95, push: false },
      { kind: "enrollment-gained", actor: "Acme Corp", title: `Sam Patel claimed a seat in ${l.courseTitle}`, href: `/instructor`, minutesAgo: 60 * 5, push: false, read: true },
      { kind: "enrollment-ended", actor: "Platform Admin", title: `Jo Kim's Enrollment in ${l.courseTitle} ended (refund approved)`, href: `/instructor`, minutesAgo: 60 * 26, push: false },
      { kind: "question", actor: "Leo Fischer", title: `New question on "${l.lessonTitle}"`, snippet: "Is there a recording of the live session?", href: `${l.lessonHref}#comments`, minutesAgo: 60 * 50, push: true, read: true },
    ];
  }
  if (role === UserRole.Admin) {
    return [
      { kind: "refund-request", actor: "Jo Kim", title: `Jo Kim requested a refund for ${l.courseTitle}`, snippet: "“The course wasn't what I expected.”", href: "/admin/refunds", minutesAgo: 12, push: true },
      { kind: "purchase", actor: "Acme Corp", title: `Acme Corp bought a 10-seat Team Licence for ${l.courseTitle}`, href: "/admin/courses", minutesAgo: 47, push: false },
      { kind: "purchase", actor: "Dana Ortiz", title: `Dana Ortiz bought ${l.courseTitle}`, href: "/admin/courses", minutesAgo: 95, push: false },
      { kind: "refund-request", actor: "Ravi Nair", title: `Ravi Nair requested a refund for ${l.courseTitle}`, href: "/admin/refunds", minutesAgo: 60 * 30, push: true, read: true },
      { kind: "purchase", actor: "Mei Chen", title: `Mei Chen bought ${l.courseTitle}`, href: "/admin/courses", minutesAgo: 60 * 72, push: false, read: true },
    ];
  }
  // Student (optionally also a Team Admin)
  const base: Seed[] = [
    { kind: "reply", actor: "Ada Instructor", title: `Your instructor replied to your comment`, snippet: "Good catch — the constraint needs `extends object` there.", href: `${l.lessonHref}#comments`, minutesAgo: 7, push: true },
    { kind: "announcement", actor: "Ada Instructor", title: `New lesson in ${l.courseTitle}: "${l.lessonTitle}"`, snippet: "This one's a big one — set aside an hour.", href: l.lessonHref, minutesAgo: 60 * 3, push: true },
    { kind: "reply", actor: "Marcus Lee", title: `Marcus Lee replied in a thread you're in`, snippet: "Same problem here, the fix above worked for me", href: `${l.lessonHref}#comments`, minutesAgo: 60 * 20, push: true, read: true },
    { kind: "refund-decision", actor: "Platform Admin", title: `Your refund request was declined`, snippet: "Note: more than 30 days since purchase.", href: "/dashboard", minutesAgo: 60 * 75, push: true, read: true },
  ];
  if (isTeamAdmin) {
    base.splice(1, 0, {
      kind: "seat-claimed", actor: "Sam Patel", title: `Sam Patel claimed a seat on your ${l.courseTitle} Team Licence`, snippet: "7 of 10 seats now claimed", href: "/team", minutesAgo: 25, push: false,
    });
  }
  return base;
}

function simulatedArrival(role: UserRole | null, l: SampleLinks): Seed {
  if (role === UserRole.Instructor)
    return { kind: "question", actor: "New Student", title: `New question on "${l.lessonTitle}"`, snippet: "Just arrived via the 30-60s poll", href: `${l.lessonHref}#comments`, minutesAgo: 0, push: true };
  if (role === UserRole.Admin)
    return { kind: "refund-request", actor: "New Buyer", title: `New Buyer requested a refund for ${l.courseTitle}`, snippet: "Just arrived via the 30-60s poll", href: "/admin/refunds", minutesAgo: 0, push: true };
  return { kind: "reply", actor: "Someone", title: `Someone replied in a thread you're in`, snippet: "Just arrived via the 30-60s poll", href: `${l.lessonHref}#comments`, minutesAgo: 0, push: true };
}

interface Store {
  items: ProtoNotification[];
  unreadCount: number;
  markRead: (id: number) => void;
  markUnread: (id: number) => void;
  markAllRead: () => void;
  simulateNew: () => void;
  reset: () => void;
}

const Ctx = createContext<Store | null>(null);

export function NotificationsPrototypeProvider({
  role,
  isTeamAdmin,
  links,
  children,
}: {
  role: UserRole | null;
  isTeamAdmin: boolean;
  links: SampleLinks | null;
  children: ReactNode;
}) {
  const l = links ?? FALLBACK_LINKS;
  const build = () =>
    seedFor(role, isTeamAdmin, l).map((s, i) => ({ ...s, id: i + 1, read: s.read ?? false }));
  const key = `${role}-${isTeamAdmin}`;
  const [state, setState] = useState({ key, items: build() });
  // Re-seed when the DevUI switches user.
  const items = state.key === key ? state.items : build();
  if (state.key !== key) setState({ key, items });

  const set = (fn: (items: ProtoNotification[]) => ProtoNotification[]) =>
    setState((s) => ({ ...s, items: fn(s.items) }));

  const store: Store = {
    items,
    unreadCount: items.filter((n) => !n.read).length,
    markRead: (id) => set((xs) => xs.map((n) => (n.id === id ? { ...n, read: true } : n))),
    markUnread: (id) => set((xs) => xs.map((n) => (n.id === id ? { ...n, read: false } : n))),
    markAllRead: () => set((xs) => xs.map((n) => ({ ...n, read: true }))),
    simulateNew: () => {
      const seed = simulatedArrival(role, l);
      set((xs) => [{ ...seed, id: Math.max(0, ...xs.map((n) => n.id)) + 1, read: false }, ...xs]);
      toast(seed.title, { description: seed.snippet });
    },
    reset: () => setState({ key, items: build() }),
  };

  return <Ctx.Provider value={store}>{children}</Ctx.Provider>;
}

export function useNotificationsPrototype() {
  const s = useContext(Ctx);
  if (!s) throw new Error("NotificationsPrototypeProvider missing");
  return s;
}

export function timeAgo(minutes: number) {
  if (minutes < 1) return "just now";
  if (minutes < 60) return `${minutes}m ago`;
  if (minutes < 60 * 24) return `${Math.floor(minutes / 60)}h ago`;
  return `${Math.floor(minutes / 60 / 24)}d ago`;
}

export function isToday(minutes: number) {
  return minutes < 60 * 24;
}
