import { mkdtempSync, readdirSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { pushOutboxTransport } from "./push.server";

describe("the push outbox", () => {
  it("writes the message to the outbox instead of sending it when there are no VAPID keys", async () => {
    const directory = mkdtempSync(join(tmpdir(), "push-outbox-"));

    const outcome = await pushOutboxTransport(directory).send(
      {
        endpoint: "https://push.example.com/abc",
        p256dh: "key",
        auth: "secret",
      },
      {
        title: "Sam replied to your comment on Lesson 3",
        body: "Test Course",
        tag: "thread:7",
        url: "/courses/test-course/lessons/1#comment-7",
      }
    );

    expect(outcome).toBe("delivered");
    const files = readdirSync(directory);
    expect(files).toHaveLength(1);
    const written = JSON.parse(readFileSync(join(directory, files[0]), "utf8"));
    expect(written).toMatchObject({
      endpoint: "https://push.example.com/abc",
      title: "Sam replied to your comment on Lesson 3",
      body: "Test Course",
      tag: "thread:7",
      url: "/courses/test-course/lessons/1#comment-7",
    });
  });
});
