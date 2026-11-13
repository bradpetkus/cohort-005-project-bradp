// PROTOTYPE — throwaway. Wayfinder ticket "Prototype: Sending an Announcement".
// Three variants of where/how an Instructor sends an Announcement, mounted on the
// existing /instructor/:courseId page and switched via ?variant=A|B|C.
//   A: "Send Announcement" button in the course header → modal composer
//   B: megaphone action on every lesson row → right-hand side panel, lesson preselected
//   C: a new "Announcements" tab: step-by-step composer + history of sent Announcements
// Sending is a stub: it only appends to in-memory state. Never merge to main.
import { createContext, useContext, useEffect, useState } from "react";
import { useNavigate, useSearchParams } from "react-router";
import { toast } from "sonner";
import {
  Bell,
  ChevronLeft,
  ChevronRight,
  Megaphone,
  Smartphone,
  X,
} from "lucide-react";
import { Button } from "~/components/ui/button";
import { Textarea } from "~/components/ui/textarea";
import { Card, CardContent, CardHeader } from "~/components/ui/card";

export type AnnouncementTarget = {
  key: string; // "lesson:12" | "quiz:4"
  kind: "lesson" | "quiz";
  title: string;
  lessonId: number;
  lessonTitle: string;
  moduleTitle: string;
};

type Sent = {
  target: AnnouncementTarget;
  note: string;
  reach: number;
  sentAt: Date;
};

type Ctx = {
  variant: string;
  courseTitle: string;
  instructorName: string;
  targets: AnnouncementTarget[];
  recipients: string[];
  lapsedCount: number;
  sent: Sent[];
  send: (target: AnnouncementTarget, note: string) => void;
  panelLessonId: number | null;
  setPanelLessonId: (id: number | null) => void;
};

const AnnouncementCtx = createContext<Ctx | null>(null);
const NOTE_MAX = 280;

function useAnn() {
  const ctx = useContext(AnnouncementCtx);
  if (!ctx) throw new Error("AnnouncementPrototype provider missing");
  return ctx;
}

export function useAnnouncementVariant() {
  const [params] = useSearchParams();
  return params.get("variant") ?? "A";
}

export function AnnouncementPrototype({
  courseTitle,
  instructorName,
  targets,
  recipients,
  lapsedCount,
  children,
}: {
  courseTitle: string;
  instructorName: string;
  targets: AnnouncementTarget[];
  recipients: string[];
  lapsedCount: number;
  children: React.ReactNode;
}) {
  const variant = useAnnouncementVariant();
  const [sent, setSent] = useState<Sent[]>([
    // a fake earlier Announcement so history (variant C) isn't empty
    ...(targets[0]
      ? [
          {
            target: targets[0],
            note: "Welcome! Start here and say hi in the comments.",
            reach: Math.max(recipients.length - 2, 0),
            sentAt: new Date(Date.now() - 1000 * 60 * 60 * 24 * 6),
          },
        ]
      : []),
  ]);
  const [panelLessonId, setPanelLessonId] = useState<number | null>(null);

  function send(target: AnnouncementTarget, note: string) {
    setSent((s) => [
      { target, note, reach: recipients.length, sentAt: new Date() },
      ...s,
    ]);
    toast.success(
      `Announcement sent to ${recipients.length} Students (prototype: nothing was really sent)`
    );
  }

  return (
    <AnnouncementCtx.Provider
      value={{
        variant,
        courseTitle,
        instructorName,
        targets,
        recipients,
        lapsedCount,
        sent,
        send,
        panelLessonId,
        setPanelLessonId,
      }}
    >
      {children}
      {variant === "B" && <VariantBPanel />}
      <PrototypeSwitcher
        variants={[
          ["A", "Header button + modal"],
          ["B", "Per-lesson action + side panel"],
          ["C", "Announcements tab + history"],
        ]}
      />
    </AnnouncementCtx.Provider>
  );
}

// ───────────────────────── shared bits ─────────────────────────

function TargetPicker({
  value,
  onChange,
  lockedLessonId,
}: {
  value: string;
  onChange: (key: string) => void;
  lockedLessonId?: number;
}) {
  const { targets } = useAnn();
  const shown = lockedLessonId
    ? targets.filter((t) => t.lessonId === lockedLessonId)
    : targets;
  const modules = [...new Set(shown.map((t) => t.moduleTitle))];
  return (
    <select
      className="w-full rounded-md border bg-background px-3 py-2 text-sm"
      value={value}
      onChange={(e) => onChange(e.target.value)}
    >
      {!lockedLessonId && <option value="">Choose a lesson or quiz…</option>}
      {modules.map((m) => (
        <optgroup key={m} label={m}>
          {shown
            .filter((t) => t.moduleTitle === m)
            .map((t) => (
              <option key={t.key} value={t.key}>
                {t.kind === "quiz" ? `   Quiz: ${t.title}` : t.title}
              </option>
            ))}
        </optgroup>
      ))}
    </select>
  );
}

function NoteField({
  note,
  setNote,
}: {
  note: string;
  setNote: (n: string) => void;
}) {
  return (
    <div>
      <Textarea
        placeholder="Optional note, e.g. “This one unlocks the project in Module 3.”"
        value={note}
        maxLength={NOTE_MAX}
        onChange={(e) => setNote(e.target.value)}
        rows={3}
      />
      <div className="mt-1 text-right text-xs text-muted-foreground">
        {note.length}/{NOTE_MAX}
      </div>
    </div>
  );
}

function ReachLine({ expandable = false }: { expandable?: boolean }) {
  const { recipients, lapsedCount } = useAnn();
  const [open, setOpen] = useState(false);
  return (
    <div className="rounded-md bg-muted/60 p-3 text-sm">
      <div>
        Reaches <strong>{recipients.length} Students</strong> with a current
        Enrollment.
        {lapsedCount > 0 && (
          <span className="text-muted-foreground">
            {" "}
            {lapsedCount} Lapsed {lapsedCount === 1 ? "Student is" : "Students are"}{" "}
            left out.
          </span>
        )}
      </div>
      <div className="mt-1 text-xs text-muted-foreground">
        In-app for everyone; push to anyone who has it on for Announcements.
      </div>
      {expandable && (
        <>
          <button
            className="mt-2 text-xs text-blue-600 hover:underline"
            onClick={() => setOpen((o) => !o)}
          >
            {open ? "Hide" : "Show"} who
          </button>
          {open && (
            <ul className="mt-2 max-h-40 columns-2 overflow-auto text-xs">
              {recipients.map((r) => (
                <li key={r}>{r}</li>
              ))}
            </ul>
          )}
        </>
      )}
    </div>
  );
}

function Preview({
  target,
  note,
}: {
  target: AnnouncementTarget | undefined;
  note: string;
}) {
  const { courseTitle, instructorName } = useAnn();
  const where = target
    ? target.kind === "quiz"
      ? `the quiz “${target.title}”`
      : `“${target.title}”`
    : "…";
  return (
    <div className="space-y-2">
      <div className="text-xs font-medium uppercase text-muted-foreground">
        What Students see
      </div>
      <div className="flex gap-3 rounded-md border bg-blue-50/50 p-3 text-sm dark:bg-blue-950/20">
        <Bell className="mt-0.5 size-4 shrink-0 text-blue-600" />
        <div className="min-w-0">
          <div className="font-semibold">
            {instructorName} pointed you to {where}
          </div>
          <div className="truncate text-muted-foreground">
            {note || courseTitle}
          </div>
          <div className="text-xs text-muted-foreground">just now · 📱 push</div>
        </div>
      </div>
      <div className="flex gap-3 rounded-xl bg-neutral-900 p-3 text-sm text-white">
        <Smartphone className="mt-0.5 size-4 shrink-0" />
        <div>
          <div className="font-semibold">Cadence · {courseTitle}</div>
          <div className="text-neutral-300">
            New Announcement: {target ? target.title : "…"}
          </div>
          <div className="mt-1 text-[10px] text-neutral-500">
            Lock screen: note is never shown here
          </div>
        </div>
      </div>
    </div>
  );
}

function Composer({
  lockedLessonId,
  onSent,
  showReachList,
}: {
  lockedLessonId?: number;
  onSent?: () => void;
  showReachList?: boolean;
}) {
  const { targets, send, recipients } = useAnn();
  const first = lockedLessonId
    ? targets.find((t) => t.lessonId === lockedLessonId)?.key ?? ""
    : "";
  const [key, setKey] = useState(first);
  const [note, setNote] = useState("");
  useEffect(() => setKey(first), [first]);
  const target = targets.find((t) => t.key === key);
  return (
    <div className="space-y-4">
      <TargetPicker value={key} onChange={setKey} lockedLessonId={lockedLessonId} />
      <NoteField note={note} setNote={setNote} />
      <ReachLine expandable={showReachList} />
      <Preview target={target} note={note} />
      <Button
        className="w-full"
        disabled={!target || recipients.length === 0}
        onClick={() => {
          if (!target) return;
          send(target, note);
          setNote("");
          onSent?.();
        }}
      >
        <Megaphone className="size-4" />
        Send to {recipients.length} Students
      </Button>
    </div>
  );
}

// ───────────────────────── Variant A ─────────────────────────
// Button in the course header stats row → centred modal.

export function VariantAHeaderButton() {
  const { variant } = useAnn();
  const [open, setOpen] = useState(false);
  if (variant !== "A") return null;
  return (
    <>
      <Button size="sm" onClick={() => setOpen(true)}>
        <Megaphone className="size-4" />
        Send Announcement
      </Button>
      {open && (
        <div
          className="fixed inset-0 z-50 flex items-center justify-center bg-black/40 p-4"
          onClick={() => setOpen(false)}
        >
          <div
            className="max-h-[90vh] w-full max-w-lg overflow-auto rounded-lg bg-background p-6 shadow-xl"
            onClick={(e) => e.stopPropagation()}
          >
            <div className="mb-4 flex items-center justify-between">
              <h2 className="text-lg font-semibold">Send an Announcement</h2>
              <button onClick={() => setOpen(false)}>
                <X className="size-4" />
              </button>
            </div>
            <Composer onSent={() => setOpen(false)} />
          </div>
        </div>
      )}
    </>
  );
}

// ───────────────────────── Variant B ─────────────────────────
// Megaphone on every lesson row → right side panel with that lesson locked in
// (choose lesson or its quiz), recipient list visible.

export function VariantBLessonButton({ lessonId }: { lessonId: number }) {
  const { variant, setPanelLessonId } = useAnn();
  if (variant !== "B") return null;
  return (
    <Button
      variant="ghost"
      size="sm"
      title="Announce this lesson"
      className="h-6 w-6 p-0 text-muted-foreground hover:text-blue-600"
      onClick={() => setPanelLessonId(lessonId)}
    >
      <Megaphone className="size-3.5" />
    </Button>
  );
}

function VariantBPanel() {
  const { panelLessonId, setPanelLessonId, targets, sent } = useAnn();
  if (panelLessonId == null) return null;
  const lesson = targets.find((t) => t.lessonId === panelLessonId);
  const already = sent.filter((s) => s.target.lessonId === panelLessonId);
  return (
    <div className="fixed inset-y-0 right-0 z-50 w-full max-w-md overflow-auto border-l bg-background p-6 shadow-2xl">
      <div className="mb-1 flex items-center justify-between">
        <h2 className="text-lg font-semibold">Announce “{lesson?.lessonTitle}”</h2>
        <button onClick={() => setPanelLessonId(null)}>
          <X className="size-4" />
        </button>
      </div>
      <p className="mb-4 text-xs text-muted-foreground">{lesson?.moduleTitle}</p>
      {already.length > 0 && (
        <div className="mb-4 rounded-md border border-amber-300 bg-amber-50 p-2 text-xs text-amber-900 dark:bg-amber-950/30 dark:text-amber-200">
          Already announced {already[0].sentAt.toLocaleDateString()} to{" "}
          {already[0].reach} Students.
        </div>
      )}
      <Composer
        lockedLessonId={panelLessonId}
        showReachList
        onSent={() => setPanelLessonId(null)}
      />
    </div>
  );
}

// ───────────────────────── Variant C ─────────────────────────
// A dedicated "Announcements" tab: numbered steps on the left, history on the right.

export function VariantCTabContent() {
  const { sent } = useAnn();
  return (
    <div className="grid gap-6 lg:grid-cols-[1fr_1fr]">
      <Card>
        <CardHeader>
          <h2 className="text-lg font-semibold">New Announcement</h2>
          <p className="text-sm text-muted-foreground">
            Point every enrolled Student at a lesson or quiz.
          </p>
        </CardHeader>
        <CardContent>
          <SteppedComposer />
        </CardContent>
      </Card>
      <Card>
        <CardHeader>
          <h2 className="text-lg font-semibold">Sent</h2>
        </CardHeader>
        <CardContent>
          {sent.length === 0 ? (
            <p className="text-sm text-muted-foreground">Nothing sent yet.</p>
          ) : (
            <ul className="divide-y">
              {sent.map((s, i) => (
                <li key={i} className="py-3 text-sm">
                  <div className="font-medium">
                    {s.target.kind === "quiz" ? "Quiz: " : ""}
                    {s.target.title}
                  </div>
                  {s.note && (
                    <div className="text-muted-foreground">“{s.note}”</div>
                  )}
                  <div className="text-xs text-muted-foreground">
                    {s.sentAt.toLocaleString()} · reached {s.reach} Students
                  </div>
                </li>
              ))}
            </ul>
          )}
        </CardContent>
      </Card>
    </div>
  );
}

function SteppedComposer() {
  const { targets, send, recipients } = useAnn();
  const [step, setStep] = useState(1);
  const [key, setKey] = useState("");
  const [note, setNote] = useState("");
  const target = targets.find((t) => t.key === key);
  const Step = ({ n, label }: { n: number; label: string }) => (
    <div
      className={`flex items-center gap-2 text-sm ${step === n ? "font-semibold" : "text-muted-foreground"}`}
    >
      <span
        className={`flex size-6 items-center justify-center rounded-full border text-xs ${step >= n ? "border-blue-600 bg-blue-600 text-white" : ""}`}
      >
        {n}
      </span>
      {label}
    </div>
  );
  return (
    <div className="space-y-4">
      <div className="flex gap-4">
        <Step n={1} label="What" />
        <Step n={2} label="Note" />
        <Step n={3} label="Review & send" />
      </div>
      {step === 1 && (
        <>
          <div className="max-h-72 space-y-1 overflow-auto rounded-md border p-2">
            {targets.map((t) => (
              <label
                key={t.key}
                className={`flex cursor-pointer items-center gap-2 rounded px-2 py-1 text-sm hover:bg-muted ${t.kind === "quiz" ? "pl-8" : ""} ${key === t.key ? "bg-blue-50 dark:bg-blue-950/30" : ""}`}
              >
                <input
                  type="radio"
                  checked={key === t.key}
                  onChange={() => setKey(t.key)}
                />
                {t.kind === "quiz" ? `Quiz: ${t.title}` : t.title}
                <span className="ml-auto text-xs text-muted-foreground">
                  {t.kind === "lesson" ? t.moduleTitle : ""}
                </span>
              </label>
            ))}
          </div>
          <Button disabled={!target} onClick={() => setStep(2)}>
            Next
          </Button>
        </>
      )}
      {step === 2 && (
        <>
          <NoteField note={note} setNote={setNote} />
          <div className="flex gap-2">
            <Button variant="outline" onClick={() => setStep(1)}>
              Back
            </Button>
            <Button onClick={() => setStep(3)}>Next</Button>
          </div>
        </>
      )}
      {step === 3 && (
        <>
          <ReachLine expandable />
          <Preview target={target} note={note} />
          <div className="flex gap-2">
            <Button variant="outline" onClick={() => setStep(2)}>
              Back
            </Button>
            <Button
              disabled={!target || recipients.length === 0}
              onClick={() => {
                if (!target) return;
                send(target, note);
                setKey("");
                setNote("");
                setStep(1);
              }}
            >
              <Megaphone className="size-4" />
              Send to {recipients.length} Students
            </Button>
          </div>
        </>
      )}
    </div>
  );
}

// ───────────────────────── switcher ─────────────────────────

function PrototypeSwitcher({ variants }: { variants: [string, string][] }) {
  const [params] = useSearchParams();
  const navigate = useNavigate();
  const current = params.get("variant") ?? variants[0][0];
  const idx = Math.max(
    0,
    variants.findIndex(([k]) => k === current)
  );
  function go(delta: number) {
    const next = variants[(idx + delta + variants.length) % variants.length][0];
    const p = new URLSearchParams(params);
    p.set("variant", next);
    navigate({ search: p.toString() }, { replace: true, preventScrollReset: true });
  }
  useEffect(() => {
    function onKey(e: KeyboardEvent) {
      const el = e.target as HTMLElement;
      if (
        el.closest("input, textarea, select, [contenteditable]") ||
        el.isContentEditable
      )
        return;
      if (e.key === "ArrowLeft") go(-1);
      if (e.key === "ArrowRight") go(1);
    }
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  });
  if (import.meta.env.PROD) return null;
  return (
    <div className="fixed bottom-4 left-1/2 z-[60] flex -translate-x-1/2 items-center gap-3 rounded-full bg-fuchsia-700 px-4 py-2 text-sm text-white shadow-lg">
      <button onClick={() => go(-1)} aria-label="Previous variant">
        <ChevronLeft className="size-4" />
      </button>
      <span>
        PROTOTYPE {variants[idx][0]} ({variants[idx][1]})
      </span>
      <button onClick={() => go(1)} aria-label="Next variant">
        <ChevronRight className="size-4" />
      </button>
    </div>
  );
}
