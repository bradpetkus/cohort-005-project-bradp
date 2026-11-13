// Which bell rows deserve a toast after a poll. Pure and client-safe, so the
// live bell can call it in the browser and tests can drive it directly.

type PolledRow = { id: number; lastEventAt: string; unread: boolean };

export function arrivedSince<T extends PolledRow>(seen: PolledRow[], next: T[]): T[] {
  // A bundle keeps its id when a new event merges in, so compare the latest
  // event time too.
  const seenAt = new Map(seen.map((r) => [r.id, r.lastEventAt]));
  return next.filter((r) => r.unread && seenAt.get(r.id) !== r.lastEventAt);
}
