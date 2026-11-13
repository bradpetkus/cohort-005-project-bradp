import { data } from "react-router";
import { z } from "zod";
import type { Route } from "./+types/instructor.$courseId.announcements";
import { db } from "~/db";
import { AnnouncementTargetKind } from "~/db/schema";
import { requireStaff } from "~/lib/access.server";
import {
  ANNOUNCEMENT_NOTE_MAX,
  listAnnouncements,
  previewAnnouncement,
  sendAnnouncement,
} from "~/lib/notifications.server";
import { parseFormData, parseParams } from "~/lib/validation";

// The Announcements tab on the Instructor course page. Same access as that
// page: the course's own Instructor, or a Platform Admin, for this course only.

const paramsSchema = z.object({ courseId: z.coerce.number().int().positive() });

const targetSchema = z.object({
  kind: z.nativeEnum(AnnouncementTargetKind),
  lessonId: z.coerce.number().int().positive(),
  note: z
    .string()
    .trim()
    .max(
      ANNOUNCEMENT_NOTE_MAX,
      `The note can be at most ${ANNOUNCEMENT_NOTE_MAX} characters.`
    )
    .optional()
    .transform((note) => note || null),
});

// The sent history, plus the review-step preview when a target is given.
export async function loader({ params, request }: Route.LoaderArgs) {
  const { courseId } = parseParams(params, paramsSchema);
  const access = await requireStaff(request, courseId);
  const senderId = access.userId;
  if (senderId === null) {
    throw data("Select a user from the DevUI panel.", { status: 401 });
  }

  const history = listAnnouncements(db, courseId);

  const search = new URL(request.url).searchParams;
  if (!search.has("lessonId")) return { history, preview: null };

  const target = targetSchema.safeParse(Object.fromEntries(search));
  if (!target.success) throw data("Invalid target.", { status: 400 });

  const preview = previewAnnouncement(db, {
    courseId,
    senderId,
    target: { kind: target.data.kind, lessonId: target.data.lessonId },
    note: target.data.note,
  });
  if (!preview.ok) throw data(preview.error, { status: preview.status });

  return { history, preview };
}

export async function action({ params, request }: Route.ActionArgs) {
  const { courseId } = parseParams(params, paramsSchema);
  const access = await requireStaff(request, courseId);
  const senderId = access.userId;
  if (senderId === null) {
    throw data("Select a user from the DevUI panel.", { status: 401 });
  }

  const parsed = parseFormData(await request.formData(), targetSchema);
  if (!parsed.success) {
    return data(
      {
        ok: false as const,
        error: Object.values(parsed.errors)[0] ?? "Invalid input.",
      },
      { status: 400 }
    );
  }

  const result = sendAnnouncement(
    db,
    {
      courseId,
      senderId,
      target: { kind: parsed.data.kind, lessonId: parsed.data.lessonId },
      note: parsed.data.note,
    },
    new Date()
  );
  if (!result.ok) {
    return data(
      { ok: false as const, error: result.error },
      { status: result.status }
    );
  }
  // Push for Announcements is delivered from here once #22 lands.
  return { ok: true as const, reachedCount: result.reachedCount };
}
