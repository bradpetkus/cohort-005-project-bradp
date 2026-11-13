import { useState } from "react";
import { useFetcher, useRevalidator } from "react-router";
import { MonitorSmartphone } from "lucide-react";
import { toast } from "sonner";
import { Button } from "~/components/ui/button";
import { Card, CardContent, CardHeader } from "~/components/ui/card";
import {
  HomeScreenSteps,
  UnblockSteps,
  usePushDevice,
  type PushDeviceStatus,
} from "~/components/push-strip";
import type { PushEventType } from "~/db/schema";
import { PUSH_EVENT_LABELS } from "~/lib/push";

// The Notifications card on /settings: this device, other devices, and which
// push event types buzz the person's phone. Everything always shows in the
// bell; these controls only affect push.

type Device = { id: number; endpoint: string; deviceName: string; createdAt: string };

export type NotificationsCardProps = {
  // VAPID public key; null when phone push isn't configured.
  pushPublicKey: string | null;
  devices: Device[];
  events: { eventType: PushEventType; enabled: boolean }[];
  canChooseEvents: boolean;
};

const STATUS_TEXT: Record<PushDeviceStatus, string> = {
  loading: "Checking…",
  unsupported: "Not supported in this browser",
  "needs-home-screen": "Needs Home Screen",
  blocked: "Blocked in browser",
  off: "Off",
  on: "On",
};

export function NotificationsCard({
  pushPublicKey,
  devices,
  events,
  canChooseEvents,
}: NotificationsCardProps) {
  const push = usePushDevice(pushPublicKey);
  const revalidator = useRevalidator();
  const [steps, setSteps] = useState<"home-screen" | "blocked" | null>(null);

  const thisDevice = devices.find((d) => d.endpoint === push.endpoint);
  const otherDevices = devices.filter((d) => d !== thisDevice);

  async function toggleThisDevice() {
    if (push.status === "on") await push.turnOff();
    else await push.turnOn();
    void revalidator.revalidate();
  }

  return (
    <Card id="notifications" className="mt-8 max-w-md">
      <CardHeader>
        <h2 className="text-lg font-semibold">Notifications</h2>
        <p className="text-sm text-muted-foreground">
          Everything always shows in the bell. Choose what also buzzes your
          phone.
        </p>
      </CardHeader>
      <CardContent className="space-y-6">
        <section>
          <SectionLabel>This device</SectionLabel>
          <div className="flex items-center justify-between gap-3 rounded-md border p-3">
            <div className="min-w-0">
              <p className="truncate text-sm font-medium">
                {thisDevice?.deviceName ?? "This browser"}
              </p>
              <p className="text-xs text-muted-foreground">
                {STATUS_TEXT[push.status]}
              </p>
            </div>
            {(push.status === "on" || push.status === "off") && (
              <Toggle
                checked={push.status === "on"}
                label="Phone notifications on this device"
                onChange={() => void toggleThisDevice()}
              />
            )}
            {push.status === "needs-home-screen" && (
              <Button
                size="sm"
                variant="outline"
                onClick={() => setSteps("home-screen")}
              >
                Show me how
              </Button>
            )}
            {push.status === "blocked" && (
              <Button
                size="sm"
                variant="outline"
                onClick={() => setSteps("blocked")}
              >
                How to unblock
              </Button>
            )}
          </div>
        </section>

        <section>
          <SectionLabel>Other devices</SectionLabel>
          {otherDevices.length === 0 ? (
            <p className="text-sm text-muted-foreground">No other devices.</p>
          ) : (
            <ul className="divide-y rounded-md border">
              {otherDevices.map((device) => (
                <OtherDeviceRow key={device.id} device={device} />
              ))}
            </ul>
          )}
        </section>

        <section>
          <SectionLabel>Push me about</SectionLabel>
          <ul className="space-y-3">
            {events.map((event) => (
              <EventRow
                key={event.eventType}
                eventType={event.eventType}
                enabled={event.enabled}
                disabled={!canChooseEvents}
              />
            ))}
          </ul>
          {!canChooseEvents && (
            <p className="mt-3 text-xs text-muted-foreground">
              Turn on a device to choose what buzzes it.
            </p>
          )}
        </section>
      </CardContent>

      {steps === "home-screen" && (
        <HomeScreenSteps onClose={() => setSteps(null)} />
      )}
      {steps === "blocked" && <UnblockSteps onClose={() => setSteps(null)} />}
    </Card>
  );
}

function SectionLabel({ children }: { children: React.ReactNode }) {
  return (
    <h3 className="mb-2 text-xs font-medium uppercase tracking-wide text-muted-foreground">
      {children}
    </h3>
  );
}

function OtherDeviceRow({ device }: { device: Device }) {
  const fetcher = useFetcher<{ ok?: boolean }>();
  const stopping = fetcher.state !== "idle";

  return (
    <li className="flex items-center gap-3 p-3 text-sm">
      <MonitorSmartphone className="size-4 shrink-0 text-muted-foreground" />
      <div className="min-w-0 flex-1">
        <span className="font-medium">{device.deviceName}</span>
        <span className="text-muted-foreground" suppressHydrationWarning>
          {" "}
          · on since {new Date(device.createdAt).toLocaleDateString()}
        </span>
      </div>
      <button
        type="button"
        disabled={stopping}
        className="shrink-0 text-xs font-medium text-red-600 hover:underline disabled:opacity-50"
        onClick={() => {
          void fetcher
            .submit(
              { intent: "remove-device", deviceId: String(device.id) },
              { method: "post", action: "/api/push" }
            )
            .then(() => toast.success(`Stopped sending to ${device.deviceName}`));
        }}
      >
        {stopping ? "Stopping…" : "Stop sending"}
      </button>
    </li>
  );
}

function EventRow({
  eventType,
  enabled,
  disabled,
}: {
  eventType: PushEventType;
  enabled: boolean;
  disabled: boolean;
}) {
  const fetcher = useFetcher<{ ok?: boolean }>();
  // Show the switch where it's going while the change is saved.
  const pending = fetcher.formData?.get("enabled");
  const checked = pending === undefined || pending === null ? enabled : pending === "true";
  const label = PUSH_EVENT_LABELS[eventType];

  return (
    <li className="flex items-center justify-between gap-3 text-sm">
      <span className={disabled ? "text-muted-foreground" : undefined}>
        {label}
      </span>
      <Toggle
        checked={checked}
        disabled={disabled}
        label={label}
        onChange={(next) =>
          void fetcher.submit(
            { intent: "preference", eventType, enabled: String(next) },
            { method: "post", action: "/api/push" }
          )
        }
      />
    </li>
  );
}

function Toggle({
  checked,
  disabled = false,
  label,
  onChange,
}: {
  checked: boolean;
  disabled?: boolean;
  label: string;
  onChange: (next: boolean) => void;
}) {
  return (
    <button
      type="button"
      role="switch"
      aria-checked={checked}
      aria-label={label}
      disabled={disabled}
      onClick={() => onChange(!checked)}
      className={`relative inline-flex h-5 w-9 shrink-0 items-center rounded-full transition-colors disabled:cursor-not-allowed disabled:opacity-40 ${
        checked ? "bg-primary" : "bg-muted-foreground/30"
      }`}
    >
      <span
        className={`inline-block size-4 rounded-full bg-background shadow transition-transform ${
          checked ? "translate-x-4" : "translate-x-0.5"
        }`}
      />
    </button>
  );
}
