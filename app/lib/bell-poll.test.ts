import { describe, expect, it } from "vitest";
import { arrivedSince } from "./bell-poll";

type Row = { id: number; lastEventAt: string; unread: boolean };

function row(id: number, lastEventAt: string, unread = true): Row {
  return { id, lastEventAt, unread };
}

describe("arrivedSince", () => {
  it("returns an unread row the last poll had not seen", () => {
    const seen = [row(1, "2027-02-18T10:00:00.000Z")];
    const next = [
      row(2, "2027-02-18T10:05:00.000Z"),
      row(1, "2027-02-18T10:00:00.000Z"),
    ];
    expect(arrivedSince(seen, next).map((r) => r.id)).toEqual([2]);
  });

  it("returns a bundle that took in a new event since the last poll", () => {
    const seen = [row(1, "2027-02-18T10:00:00.000Z")];
    const next = [row(1, "2027-02-18T10:07:00.000Z")];
    expect(arrivedSince(seen, next).map((r) => r.id)).toEqual([1]);
  });

  it("never returns rows already seen", () => {
    const seen = [
      row(2, "2027-02-18T10:05:00.000Z"),
      row(1, "2027-02-18T10:00:00.000Z"),
    ];
    expect(arrivedSince(seen, seen)).toEqual([]);
  });

  it("skips new rows that are already read, such as ones opened in another tab", () => {
    const seen: Row[] = [];
    const next = [row(3, "2027-02-18T10:09:00.000Z", false)];
    expect(arrivedSince(seen, next)).toEqual([]);
  });
});
