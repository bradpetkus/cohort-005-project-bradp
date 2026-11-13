import {
  AnnouncementTargetKind,
  NotificationType,
  type notifications,
} from "~/db/schema";

// ─── How each Notification type reads ───
// One definition per type: what its stored `detail` means, and its bell
// title, bell snippet and lock-screen push text. Push text never includes
// comment text, an Announcement note or a decision note.

export type NotificationRow = typeof notifications.$inferSelect;

// Whether a reply is on the recipient's own top-level comment, or in a thread
// they've replied in.
export type ReplyDetail = "own_comment" | "thread";
export type RefundDecisionDetail = "approved" | "declined";
export type EnrollmentVia = "purchase" | "seat";
// Null for an Individual Purchase.
export type PurchaseDetail = "team_licence" | null;

// What `detail` holds for each type. The column is free text, so it is
// written from these types and parsed back into them at the read boundary.
export type DetailFor = {
  [NotificationType.Reply]: ReplyDetail;
  [NotificationType.Question]: null;
  [NotificationType.Announcement]: AnnouncementTargetKind;
  [NotificationType.RefundDecision]: RefundDecisionDetail;
  [NotificationType.RefundRequest]: null;
  [NotificationType.Purchase]: PurchaseDetail;
  [NotificationType.EnrollmentGained]: EnrollmentVia;
  [NotificationType.EnrollmentEnded]: null;
  [NotificationType.SeatClaimed]: null;
};

// A stored row whose `detail` has been parsed for its type.
type ParsedRow<T extends NotificationType> = Omit<
  NotificationRow,
  "type" | "detail"
> & { type: T; detail: DetailFor[T] };

type Text = { title: string; body: string };

type Definition<T extends NotificationType> = {
  parseDetail: (raw: string | null) => DetailFor[T];
  title: (row: ParsedRow<T>) => string;
  snippet: (row: ParsedRow<T>) => string;
  push: (row: ParsedRow<T>) => Text;
};

const noDetail = () => null;
const courseSnippet = (row: { courseTitle: string | null }) =>
  row.courseTitle ?? "";
const noteSnippet = (row: {
  note: string | null;
  courseTitle: string | null;
}) => row.note ?? row.courseTitle ?? "";

// The bell row title, shared by the bell and the review step's preview.
export function announcementBellTitle(
  senderName: string,
  kind: AnnouncementTargetKind,
  subjectTitle: string
): string {
  return kind === AnnouncementTargetKind.Quiz
    ? `${senderName} pointed you to the quiz “${subjectTitle}”`
    : `${senderName} pointed you to “${subjectTitle}”`;
}

// The lock-screen push for an Announcement. It says only what and where,
// never the note (PRD #12, "Push content and privacy"). The review step
// previews it, and push delivery (#22) sends it.
export function announcementPushText(
  subjectTitle: string,
  courseTitle: string
): Text {
  return {
    title: `New Announcement: ${subjectTitle} · ${courseTitle}`,
    body: "",
  };
}

function replyTitle(row: ParsedRow<NotificationType.Reply>) {
  const own = row.detail === "own_comment";
  const where = own
    ? `your comment on ${row.subjectTitle}`
    : `a thread you're in on ${row.subjectTitle}`;
  if (row.eventCount > 1) {
    return `${row.eventCount} new replies ${own ? "on" : "in"} ${where}`;
  }
  return `${row.actorName} replied ${own ? "to" : "in"} ${where}`;
}

function questionTitle(row: ParsedRow<NotificationType.Question>) {
  if (row.eventCount > 1) {
    return `${row.eventCount} new questions on ${row.subjectTitle}`;
  }
  return `${row.actorName} asked a question on ${row.subjectTitle}`;
}

function announcementTitle(row: ParsedRow<NotificationType.Announcement>) {
  return announcementBellTitle(
    row.actorName ?? "",
    row.detail,
    row.subjectTitle ?? ""
  );
}

function refundRequestTitle(row: ParsedRow<NotificationType.RefundRequest>) {
  return `${row.actorName} requested a refund for ${row.courseTitle}`;
}

function refundDecisionTitle(row: ParsedRow<NotificationType.RefundDecision>) {
  return `Your Refund Request for ${row.courseTitle} was ${row.detail}`;
}

function purchaseTitle(row: ParsedRow<NotificationType.Purchase>) {
  if (row.eventCount > 1) return `${row.eventCount} new Purchases`;
  return row.detail === "team_licence"
    ? `${row.actorName} bought a Team Licence for ${row.courseTitle}`
    : `${row.actorName} bought ${row.courseTitle}`;
}

function enrollmentGainedTitle(
  row: ParsedRow<NotificationType.EnrollmentGained>
) {
  return row.eventCount > 1
    ? `${row.eventCount} new Students on ${row.courseTitle}`
    : `${row.actorName} enrolled in ${row.courseTitle}`;
}

function enrollmentEndedTitle(
  row: ParsedRow<NotificationType.EnrollmentEnded>
) {
  return `${row.actorName} left ${row.courseTitle} after a refund`;
}

function seatClaimedTitle(row: ParsedRow<NotificationType.SeatClaimed>) {
  return row.eventCount > 1
    ? `${row.eventCount} seats claimed on ${row.courseTitle}`
    : `${row.actorName} claimed a seat on ${row.courseTitle}`;
}

// Push text for types whose push is their bell title and course.
function titleAndCourse<T extends NotificationType>(
  title: (row: ParsedRow<T>) => string
) {
  return (row: ParsedRow<T>): Text => ({
    title: title(row),
    body: row.courseTitle ?? "",
  });
}

const DEFINITIONS: { [T in NotificationType]: Definition<T> } = {
  [NotificationType.Reply]: {
    parseDetail: (raw) => (raw === "own_comment" ? "own_comment" : "thread"),
    title: replyTitle,
    snippet: courseSnippet,
    push: titleAndCourse(replyTitle),
  },
  [NotificationType.Question]: {
    parseDetail: noDetail,
    title: questionTitle,
    snippet: courseSnippet,
    push: titleAndCourse(questionTitle),
  },
  [NotificationType.Announcement]: {
    parseDetail: (raw) =>
      raw === AnnouncementTargetKind.Quiz
        ? AnnouncementTargetKind.Quiz
        : AnnouncementTargetKind.Lesson,
    title: announcementTitle,
    snippet: noteSnippet,
    // The same text the review step previews.
    push: (row) =>
      announcementPushText(row.subjectTitle ?? "", row.courseTitle ?? ""),
  },
  [NotificationType.RefundDecision]: {
    parseDetail: (raw) => (raw === "declined" ? "declined" : "approved"),
    title: refundDecisionTitle,
    snippet: noteSnippet,
    push: (row) => ({
      title: `Your Refund Request was ${row.detail}`,
      body: row.courseTitle ?? "",
    }),
  },
  [NotificationType.RefundRequest]: {
    parseDetail: noDetail,
    title: refundRequestTitle,
    snippet: courseSnippet,
    push: titleAndCourse(refundRequestTitle),
  },
  [NotificationType.Purchase]: {
    parseDetail: (raw) => (raw === "team_licence" ? "team_licence" : null),
    title: purchaseTitle,
    snippet: courseSnippet,
    push: titleAndCourse(purchaseTitle),
  },
  [NotificationType.EnrollmentGained]: {
    parseDetail: (raw) => (raw === "seat" ? "seat" : "purchase"),
    title: enrollmentGainedTitle,
    snippet: courseSnippet,
    push: titleAndCourse(enrollmentGainedTitle),
  },
  [NotificationType.EnrollmentEnded]: {
    parseDetail: noDetail,
    title: enrollmentEndedTitle,
    snippet: courseSnippet,
    push: titleAndCourse(enrollmentEndedTitle),
  },
  [NotificationType.SeatClaimed]: {
    parseDetail: noDetail,
    title: seatClaimedTitle,
    snippet: courseSnippet,
    push: titleAndCourse(seatClaimedTitle),
  },
};

export type DisplayedRow = { title: string; snippet: string; push: Text };

// Parses the row's `detail` for its type, then renders it.
export function displayRow<T extends NotificationType>(
  row: NotificationRow & { type: T }
): DisplayedRow {
  const definition: Definition<T> = DEFINITIONS[row.type];
  const parsed: ParsedRow<T> = {
    ...row,
    detail: definition.parseDetail(row.detail),
  };
  return {
    title: definition.title(parsed),
    snippet: definition.snippet(parsed),
    push: definition.push(parsed),
  };
}
