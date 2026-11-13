// PROTOTYPE — throwaway. Wayfinder ticket "Prototype: Turning on phone notifications".
// Question: when and how does Cadence ask someone to turn on push; what does an iPhone
// user in a Safari tab see; how is an enabled device shown; how is push turned off?
// Three variants via ?variant=A|B|C on the real app (bell + /settings).
// Everything is simulated in memory: the "browser" (device type + permission) is a
// control in the floating bar. No service worker, no real permission prompt, no DB.

import { createContext, useContext, useState, type ReactNode } from "react";
import { toast } from "sonner";
import { UserRole } from "~/db/schema";

export type DeviceEnv = "desktop" | "android" | "iphone-tab" | "iphone-app";
export const DEVICE_ENVS: { key: DeviceEnv; label: string; deviceName: string }[] = [
  { key: "desktop", label: "Desktop Chrome", deviceName: "Chrome on Windows" },
  { key: "android", label: "Android Chrome", deviceName: "Chrome on Android" },
  { key: "iphone-tab", label: "iPhone · Safari tab", deviceName: "Safari on iPhone" },
  { key: "iphone-app", label: "iPhone · Home Screen app", deviceName: "iPhone (Home Screen app)" },
];

export type Permission = "default" | "granted" | "denied";

export interface Device {
  id: number;
  name: string;
  since: string;
  thisDevice: boolean;
}

export type PushEventType = "reply" | "question" | "announcement" | "refund-decision" | "refund-request";
export const PUSH_EVENT_LABELS: Record<PushEventType, string> = {
  reply: "Replies in a comment thread you're in",
  question: "New questions on your lessons",
  announcement: "Announcements from your courses",
  "refund-decision": "Decisions on your Refund Requests",
  "refund-request": "New Refund Requests",
};

export function pushEventsFor(role: UserRole | null): PushEventType[] {
  if (role === UserRole.Instructor) return ["reply", "question"];
  if (role === UserRole.Admin) return ["refund-request", "reply"];
  return ["reply", "announcement", "refund-decision"];
}

interface State {
  env: DeviceEnv;
  // Browser permission per env (each env is a separate browser).
  permission: Record<DeviceEnv, Permission>;
  // Cadence-side subscription for the env's browser.
  subscribed: Record<DeviceEnv, boolean>;
  otherDevices: Device[];
  promptDismissed: boolean; // "Not now" on a proactive prompt
  justInTimeShown: boolean; // C: the one-off ask after a push-worthy arrival
  eventsOn: Record<PushEventType, boolean>;
  // Overlays
  browserPromptOpen: boolean;
  homeScreenGuideOpen: boolean;
  blockedHelpOpen: boolean;
}

const initial = (): State => ({
  env: "desktop",
  permission: { desktop: "default", android: "default", "iphone-tab": "default", "iphone-app": "default" },
  subscribed: { desktop: false, android: false, "iphone-tab": false, "iphone-app": false },
  otherDevices: [],
  promptDismissed: false,
  justInTimeShown: false,
  eventsOn: { reply: true, question: true, announcement: true, "refund-decision": true, "refund-request": true },
  browserPromptOpen: false,
  homeScreenGuideOpen: false,
  blockedHelpOpen: false,
});

export type ThisDeviceStatus =
  | "on"
  | "off" // can be turned on with one tap
  | "needs-home-screen" // iPhone in a Safari tab
  | "blocked"; // permission denied in browser settings

function envInfo(env: DeviceEnv) {
  return DEVICE_ENVS.find((d) => d.key === env)!;
}

interface Store extends State {
  status: ThisDeviceStatus;
  devices: Device[]; // this device (if on) + other devices
  anyDeviceOn: boolean;
  setEnv: (e: DeviceEnv) => void;
  setPermission: (p: Permission) => void;
  /** The tap that starts turning push on for this device. */
  startTurnOn: () => void;
  answerBrowserPrompt: (allow: boolean) => void;
  turnOffThisDevice: () => void;
  removeDevice: (id: number) => void;
  addOtherDevice: () => void;
  dismissPrompt: () => void;
  markJustInTimeShown: () => void;
  toggleEvent: (e: PushEventType) => void;
  closeOverlays: () => void;
  reset: () => void;
}

const Ctx = createContext<Store | null>(null);
let nextId = 100;

export function PushPrototypeProvider({ children }: { children: ReactNode }) {
  const [s, setS] = useState<State>(initial);
  const set = (patch: Partial<State> | ((s: State) => Partial<State>)) =>
    setS((prev) => ({ ...prev, ...(typeof patch === "function" ? patch(prev) : patch) }));

  const perm = s.permission[s.env];
  const status: ThisDeviceStatus =
    s.env === "iphone-tab"
      ? "needs-home-screen"
      : perm === "denied"
        ? "blocked"
        : s.subscribed[s.env] && perm === "granted"
          ? "on"
          : "off";

  const thisDevice: Device[] =
    status === "on" ? [{ id: 0, name: envInfo(s.env).deviceName, since: "today", thisDevice: true }] : [];
  // Other envs that are subscribed show up as "other devices" too.
  const otherEnvDevices: Device[] = DEVICE_ENVS.filter(
    (d) => d.key !== s.env && s.subscribed[d.key] && s.permission[d.key] === "granted"
  ).map((d, i) => ({ id: 50 + i, name: d.deviceName, since: "earlier today", thisDevice: false }));
  const devices = [...thisDevice, ...otherEnvDevices, ...s.otherDevices];

  const store: Store = {
    ...s,
    status,
    devices,
    anyDeviceOn: devices.length > 0,
    setEnv: (env) => set({ env, browserPromptOpen: false, homeScreenGuideOpen: false, blockedHelpOpen: false }),
    setPermission: (p) =>
      set((st) => ({
        permission: { ...st.permission, [st.env]: p },
        subscribed: p === "granted" ? st.subscribed : { ...st.subscribed, [st.env]: false },
      })),
    startTurnOn: () => {
      if (status === "needs-home-screen") return set({ homeScreenGuideOpen: true });
      if (status === "blocked") return set({ blockedHelpOpen: true });
      if (perm === "granted") {
        set((st) => ({ subscribed: { ...st.subscribed, [st.env]: true } }));
        toast.success("Phone notifications are on for this device");
        return;
      }
      set({ browserPromptOpen: true });
    },
    answerBrowserPrompt: (allow) => {
      set((st) => ({
        browserPromptOpen: false,
        permission: { ...st.permission, [st.env]: allow ? "granted" : "denied" },
        subscribed: { ...st.subscribed, [st.env]: allow },
      }));
      if (allow) toast.success("Phone notifications are on for this device", { description: "We sent a test so you can see what they look like." });
      else toast.error("Notifications blocked", { description: "You can unblock them in your browser's site settings." });
    },
    turnOffThisDevice: () => {
      set((st) => ({ subscribed: { ...st.subscribed, [st.env]: false } }));
      toast("Phone notifications are off for this device", { description: "You'll still see everything in the bell." });
    },
    removeDevice: (id) => {
      const d = devices.find((x) => x.id === id);
      if (!d) return;
      if (d.thisDevice) return store.turnOffThisDevice();
      const env = DEVICE_ENVS.find((e) => e.deviceName === d.name)?.key;
      set((st) => ({
        otherDevices: st.otherDevices.filter((x) => x.id !== id),
        subscribed: env && id >= 50 && id < 100 ? { ...st.subscribed, [env]: false } : st.subscribed,
      }));
      toast(`Stopped sending to ${d.name}`);
    },
    addOtherDevice: () =>
      set((st) => ({
        otherDevices: [...st.otherDevices, { id: nextId++, name: "Pixel 8 (Chrome)", since: "Oct 2", thisDevice: false }],
      })),
    dismissPrompt: () => set({ promptDismissed: true }),
    markJustInTimeShown: () => set({ justInTimeShown: true }),
    toggleEvent: (e) => set((st) => ({ eventsOn: { ...st.eventsOn, [e]: !st.eventsOn[e] } })),
    closeOverlays: () => set({ browserPromptOpen: false, homeScreenGuideOpen: false, blockedHelpOpen: false }),
    reset: () => setS(initial()),
  };

  return <Ctx.Provider value={store}>{children}</Ctx.Provider>;
}

export function usePushPrototype() {
  const s = useContext(Ctx);
  if (!s) throw new Error("PushPrototypeProvider missing");
  return s;
}
