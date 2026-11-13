import { useEffect, useState } from "react";
import { useFetcher } from "react-router";
import { toast } from "sonner";
import { AlertTriangle, Bell, Megaphone } from "lucide-react";
import { AnnouncementTargetKind } from "~/db/schema";
import type {
  action as announcementsAction,
  loader as announcementsLoader,
} from "~/routes/instructor.$courseId.announcements";
import { Button } from "~/components/ui/button";
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "~/components/ui/card";
import { Textarea } from "~/components/ui/textarea";
import { cn } from "~/lib/utils";

const NOTE_MAX = 280;

export type AnnouncementTargetOption = {
  kind: AnnouncementTargetKind;
  lessonId: number;
  title: string;
  moduleTitle: string;
};

type Props = {
  courseId: number;
  // Every lesson in course order, each followed by its quiz if it has one.
  targets: AnnouncementTargetOption[];
};

function keyOf(target: { kind: AnnouncementTargetKind; lessonId: number }) {
  return `${target.kind}:${target.lessonId}`;
}

function students(n: number) {
  return `${n} ${n === 1 ? "Student" : "Students"}`;
}

export function AnnouncementsTab({ courseId, targets }: Props) {
  const resource = `/instructor/${courseId}/announcements`;
  const historyFetcher = useFetcher<typeof announcementsLoader>();
  const previewFetcher = useFetcher<typeof announcementsLoader>();
  const sendFetcher = useFetcher<typeof announcementsAction>();

  const [step, setStep] = useState<1 | 2 | 3>(1);
  const [selectedKey, setSelectedKey] = useState<string | null>(null);
  const [note, setNote] = useState("");
  const [showWho, setShowWho] = useState(false);

  const selected = targets.find((t) => keyOf(t) === selectedKey) ?? null;

  // The sent history. It reloads after a send, like every loaded fetcher.
  useEffect(() => {
    if (historyFetcher.state === "idle" && !historyFetcher.data) {
      historyFetcher.load(resource);
    }
  }, [historyFetcher, resource]);

  // The review step's reach and preview.
  useEffect(() => {
    if (step !== 3 || !selected) return;
    const search = new URLSearchParams({
      kind: selected.kind,
      lessonId: String(selected.lessonId),
      note,
    });
    previewFetcher.load(`${resource}?${search}`);
    // Reload only when the inputs change, not on every fetcher update.
  }, [step, selected?.kind, selected?.lessonId, note, resource]);

  // A failed send throws, so the course page's error boundary shows why.
  useEffect(() => {
    if (sendFetcher.state !== "idle" || !sendFetcher.data) return;
    toast.success(
      `Announcement sent to ${students(sendFetcher.data.reachedCount)}.`
    );
    setStep(1);
    setSelectedKey(null);
    setNote("");
    setShowWho(false);
  }, [sendFetcher.state, sendFetcher.data]);

  const preview = step === 3 ? previewFetcher.data?.preview : null;
  const history = historyFetcher.data?.history ?? [];
  const sending = sendFetcher.state !== "idle";

  function send() {
    if (!selected) return;
    sendFetcher.submit(
      { kind: selected.kind, lessonId: String(selected.lessonId), note },
      { method: "post", action: resource }
    );
  }

  return (
    <div className="grid gap-6 lg:grid-cols-[1fr_1fr]">
      <Card>
        <CardHeader>
          <CardTitle>New Announcement</CardTitle>
          <CardDescription>
            Point every enrolled Student at a lesson or quiz.
          </CardDescription>
        </CardHeader>
        <CardContent className="space-y-4">
          <ol className="flex gap-2 text-xs">
            {(["What", "Note", "Review & send"] as const).map((label, i) => (
              <li
                key={label}
                className={cn(
                  "rounded-full px-2.5 py-1",
                  step === i + 1
                    ? "bg-primary text-primary-foreground"
                    : "bg-muted text-muted-foreground"
                )}
              >
                {i + 1} {label}
              </li>
            ))}
          </ol>

          {step === 1 && (
            <div className="max-h-72 space-y-1 overflow-y-auto rounded-md border p-2">
              {targets.length === 0 && (
                <p className="p-2 text-sm text-muted-foreground">
                  This course has no lessons yet.
                </p>
              )}
              {targets.map((target) => {
                const key = keyOf(target);
                const isQuiz = target.kind === AnnouncementTargetKind.Quiz;
                return (
                  <label
                    key={key}
                    className={cn(
                      "flex cursor-pointer items-center gap-2 rounded px-2 py-1.5 text-sm hover:bg-muted",
                      isQuiz && "pl-8",
                      selectedKey === key && "bg-muted"
                    )}
                  >
                    <input
                      type="radio"
                      name="announcement-target"
                      value={key}
                      checked={selectedKey === key}
                      onChange={() => setSelectedKey(key)}
                    />
                    <span className="flex-1">
                      {isQuiz ? `Quiz: ${target.title}` : target.title}
                    </span>
                    {!isQuiz && (
                      <span className="text-xs text-muted-foreground">
                        {target.moduleTitle}
                      </span>
                    )}
                  </label>
                );
              })}
            </div>
          )}

          {step === 2 && (
            <div className="space-y-1">
              <Textarea
                value={note}
                maxLength={NOTE_MAX}
                onChange={(e) => setNote(e.target.value)}
                placeholder="Optional note, e.g. “This one unlocks the project in Module 3.”"
              />
              <p className="text-right text-xs text-muted-foreground">
                {note.length}/{NOTE_MAX}
              </p>
            </div>
          )}

          {step === 3 && selected && (
            <div className="space-y-4">
              {!preview ? (
                <p className="text-sm text-muted-foreground">Loading…</p>
              ) : (
                <>
                  {preview.lastAnnounced && (
                    <div className="flex items-start gap-2 rounded-md border border-amber-300 bg-amber-50 p-3 text-sm text-amber-900">
                      <AlertTriangle className="mt-0.5 size-4 shrink-0" />
                      <span>
                        Already announced{" "}
                        {new Date(
                          preview.lastAnnounced.sentAt
                        ).toLocaleDateString()}{" "}
                        to {students(preview.lastAnnounced.reachedCount)}.
                      </span>
                    </div>
                  )}

                  <div className="rounded-md bg-muted/60 p-3 text-sm">
                    <p>
                      Reaches{" "}
                      <strong>{students(preview.recipients.length)}</strong>{" "}
                      with a current Enrollment;{" "}
                      {preview.lapsedCount === 1
                        ? "1 Lapsed Student is"
                        : `${preview.lapsedCount} Lapsed Students are`}{" "}
                      left out.
                    </p>
                    {preview.recipients.length > 0 && (
                      <button
                        type="button"
                        className="mt-1 text-xs text-primary hover:underline"
                        onClick={() => setShowWho((v) => !v)}
                      >
                        {showWho ? "Hide who" : "Show who"}
                      </button>
                    )}
                    {showWho && (
                      <ul className="mt-2 columns-2 text-xs">
                        {preview.recipients.map((r) => (
                          <li key={r.id}>{r.name}</li>
                        ))}
                      </ul>
                    )}
                  </div>

                  <div className="space-y-2">
                    <p className="text-xs font-medium uppercase text-muted-foreground">
                      What Students see
                    </p>
                    <div className="flex gap-3 rounded-md border bg-primary/5 p-3">
                      <Bell className="mt-0.5 size-4 shrink-0 text-muted-foreground" />
                      <div className="min-w-0">
                        <p className="text-sm font-semibold">
                          {preview.bellRow.title}
                        </p>
                        <p className="truncate text-xs text-muted-foreground">
                          {preview.bellRow.snippet}
                        </p>
                        <p className="text-xs text-muted-foreground">
                          just now
                        </p>
                      </div>
                    </div>
                    <div className="rounded-xl bg-neutral-900 p-3 text-white">
                      <p className="text-[11px] text-white/60">Cadence</p>
                      <p className="text-sm font-medium">
                        {preview.push.title}
                      </p>
                      {preview.push.body && (
                        <p className="text-sm">{preview.push.body}</p>
                      )}
                      <p className="mt-1 text-[11px] text-white/50">
                        Lock screen: the note is never shown here
                      </p>
                    </div>
                  </div>
                </>
              )}
            </div>
          )}

          <div className="flex justify-between">
            <Button
              variant="ghost"
              disabled={step === 1 || sending}
              onClick={() => setStep((s) => (s === 3 ? 2 : 1))}
            >
              Back
            </Button>
            {step < 3 ? (
              <Button
                disabled={!selected}
                onClick={() => setStep((s) => (s === 1 ? 2 : 3))}
              >
                Next
              </Button>
            ) : (
              <Button
                disabled={!preview || preview.recipients.length === 0 || sending}
                onClick={send}
              >
                <Megaphone className="size-4" />
                Send to {students(preview?.recipients.length ?? 0)}
              </Button>
            )}
          </div>
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle>Sent</CardTitle>
        </CardHeader>
        <CardContent>
          {history.length === 0 ? (
            <p className="text-sm text-muted-foreground">Nothing sent yet.</p>
          ) : (
            <ul className="divide-y">
              {history.map((a) => (
                <li key={a.id} className="py-3 text-sm">
                  <p className="font-medium">
                    {a.targetKind === AnnouncementTargetKind.Quiz
                      ? `Quiz: ${a.subjectTitle}`
                      : a.subjectTitle}
                  </p>
                  {a.note && (
                    <p className="text-muted-foreground">“{a.note}”</p>
                  )}
                  <p className="text-xs text-muted-foreground">
                    {new Date(a.sentAt).toLocaleString()} · reached{" "}
                    {students(a.reachedCount)}
                  </p>
                </li>
              ))}
            </ul>
          )}
        </CardContent>
      </Card>
    </div>
  );
}
