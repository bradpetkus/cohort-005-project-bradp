# Research: Delivering in-app notifications in React Router + SQLite

Ticket: [#3](https://github.com/bradpetkus/cohort-005-project-bradp/issues/3) (child of map [#1](https://github.com/bradpetkus/cohort-005-project-bradp/issues/1)).

**Question.** How should in-app notifications reach a user who is on Cadence? Compare four options: loader revalidation on navigation, interval polling, Server-Sent Events (SSE), and websockets. For each, cover the fit with React Router's model, the load on one SQLite file, and the complexity.

**Constraint from the user.** Polling on navigation plus a light interval is acceptable. True real-time is not required.

## What the codebase already has

- **React Router 8.3.0, framework mode with SSR.** `package.json` pins `react-router`, `@react-router/dev`, `@react-router/node` and `@react-router/serve` to 8.3.0.
- **Stock server.** `npm start` runs `react-router-serve ./build/server/index.js`, with no custom server file. The installed `@react-router/serve/dist/cli.js` builds a plain Express app: `compression()`, static assets, `morgan`, then `app.all("/{*splat}", createRequestHandler(...))`, then `app.listen`. There is no hook for attaching a websocket upgrade handler.
- **A layout loader that wraps every signed-in page.** `app/routes/layout.app.tsx` is the `layout(...)` parent of almost all routes in `app/routes.ts`. Its loader already loads `currentUser`, and the component renders the `Sidebar` and a `<Toaster position="bottom-right" richColors closeButton />` from `sonner`. This is the natural home for an unread count or badge, and it already mounts the toast host.
- **The layout loader is not cheap.** It runs `getAllUsers()`, `isTeamAdmin()`, and for up to 3 recent courses it calls `getCompletedLessonCount`, `getTotalLessonCount` and `calculateProgress`, each of which re-queries modules and lessons. That is a dozen or more synchronous queries per run. This matters for any option that re-runs it on a timer.
- **SQLite via better-sqlite3 and Drizzle, in WAL mode.** `app/db/index.ts` opens `data.db` lazily and sets `journal_mode = WAL` and `foreign_keys = ON`. better-sqlite3 is synchronous, so each query blocks the Node event loop while it runs.
- **Established fetcher-plus-toast pattern.** `app/components/comment-thread.tsx` and `app/routes/admin.categories.tsx` watch `fetcher.state`/`fetcher.data` in an effect and call `toast.success`/`toast.error`. A notifications poller can follow the same pattern.
- **Existing resource routes.** `api/switch-user`, `api/logout`, `api/video-tracking` and `api/set-dev-country` in `app/routes.ts` show the convention for a JSON endpoint such as `api/notifications`.
- **Existing index convention.** `app/db/schema.ts` declares indexes inline, for example `index("lesson_progress_user_lesson_idx").on(table.userId, table.lessonId)`.

## How React Router revalidates (primary sources)

- **On navigation and after actions, for free.** "In framework mode with SSR, route loaders are automatically revalidated after all navigations and form submissions." ([Route Module, `shouldRevalidate`](https://reactrouter.com/start/framework/route-module)). The Revalidation Optimization guide adds: "active loaders are revalidated on navigations and successful submissions", and "Failed submissions returning a 4xx/5xx status do not trigger revalidations by default." ([Optimize Revalidation](https://reactrouter.com/how-to/optimize-revalidation))
- **Opting out is per route.** `shouldRevalidate` "allows you to opt out of revalidation for **this route's** loader. It does not skip parent or sibling loaders." ([Route Module](https://reactrouter.com/start/framework/route-module))
- **`useRevalidator` exists for timers and focus.** Its purpose is to "Revalidate the data on the page for reasons outside of normal data mutations like `Window` focus or polling on an interval." It acts on "the data on the page", meaning the active route loaders, not one chosen loader. ([useRevalidator](https://reactrouter.com/api/hooks/useRevalidator))
- **`fetcher.load` is separate from navigation.** "`fetcher.load` only revalidates by default after action submissions and explicit `useRevalidator` calls, not on search-param or param-driven navigations." ([Optimize Revalidation](https://reactrouter.com/how-to/optimize-revalidation)). Fetchers "track their own, independent state" ([useFetcher](https://reactrouter.com/api/hooks/useFetcher)).
- **Resource routes.** "A route becomes a resource route by convention when its module exports a loader or action but does not export a default component." A resource route can return any `Response` ([Resource Routes](https://reactrouter.com/how-to/resource-routes)). The docs show no streaming or SSE example.

## Option comparison

### 1. Loader revalidation on navigation (unread count in the layout loader)

- **Fit:** Native. Add `unreadCount` (and maybe the latest few items) to the `layout.app.tsx` loader return. It refreshes on every navigation and after every successful `Form`/`fetcher.submit`, with no client code. Marking items as read through an action refreshes the badge automatically.
- **SQLite cost:** One indexed `count(*)` per navigation, added to a loader that already runs a dozen-plus queries. With an index on `(user_id, read_at)` this is a B-tree range count, which is negligible. WAL means these reads do not block writers ([SQLite WAL](https://www.sqlite.org/wal.html)).
- **Complexity:** Minimal, a few lines in a loader that already exists.
- **Gap:** A user sitting idle on one page (for example, watching a lesson video) sees nothing until they navigate or submit.

### 2a. Interval polling with `useRevalidator`

- **Fit:** Officially sanctioned for "polling on an interval" ([useRevalidator](https://reactrouter.com/api/hooks/useRevalidator)).
- **SQLite cost:** This is the problem. It re-runs every active loader: the heavy layout loader (all users, team-admin check, per-course progress) plus the child page loader. At a 30-second interval per open tab, that is the full page's query load every 30 seconds just to check one count. Because better-sqlite3 is synchronous, that work also occupies the event loop. You can trim it with `shouldRevalidate` on each route, but that has to be repeated per route because skipping a child "does not skip any ancestor routes" ([Optimize Revalidation](https://reactrouter.com/how-to/optimize-revalidation)).
- **Complexity:** Low code, but high hidden cost, and it can disturb page state (for example, loader data under a form being edited changes mid-edit).

### 2b. Interval polling with `useFetcher().load` on a resource route (recommended interval mechanism)

- **Fit:** Good. Add a resource route `api/notifications` whose loader returns `{ unreadCount, latest }` for the session user. Mount one component in `layout.app.tsx` that calls `fetcher.load("/api/notifications")` on a `setInterval` (for example 30 to 60 seconds). It reruns only that one loader, and per the docs it also refreshes automatically after action submissions ([Optimize Revalidation](https://reactrouter.com/how-to/optimize-revalidation)). This mirrors the existing fetcher-plus-`toast` effect pattern in `comment-thread.tsx`. When the count goes up, call `toast(...)` from `sonner`, whose `<Toaster>` is already mounted.
- **SQLite cost:** One indexed count, plus optionally a `LIMIT 5` select, per tab per interval. For example, 200 open tabs at 60 seconds is about 3 tiny reads per second, well within what a WAL-mode SQLite file handles. Pause the interval while `document.hidden` is true to cut idle-tab load.
- **Complexity:** Low. One resource route, one small client component, and one index. Nothing changes on the server.

### 3. Server-Sent Events

- **Fit:** Possible but off the paved path. A resource route could return a `Response` wrapping a `ReadableStream` with `Content-Type: text/event-stream`, but the React Router docs give no SSE or streaming example for resource routes ([Resource Routes](https://reactrouter.com/how-to/resource-routes)). The data would also bypass loaders and revalidation, so the badge state would live in a separate client store.
- **Server/infra gotchas, verified in the installed source:**
  - `react-router-serve` applies `compression()` to every response. The `compression` package compresses any type matching `compressible`'s `/^text\/|.../` (so `text/event-stream` qualifies) and only skips when `Cache-Control` contains `no-transform` (`node_modules/compression/index.js`, `shouldTransform`). Without `Cache-Control: no-transform`, events can sit in the gzip buffer instead of reaching the browser.
  - Over HTTP/1.1, browsers cap SSE at 6 connections per browser and domain, shared across tabs, and Chrome and Firefox have marked this "Won't fix" ([MDN: Using server-sent events](https://developer.mozilla.org/en-US/docs/Web/API/Server-sent_events/Using_server-sent_events)). A user with several Cadence tabs could starve their own normal requests.
  - EventSource reconnects automatically ([MDN](https://developer.mozilla.org/en-US/docs/Web/API/Server-sent_events/Using_server-sent_events)), which is nice, but the server still needs a push trigger. Either an in-process `EventEmitter` fires on insert, which works only while there is exactly one Node process, or each open stream polls SQLite on its own timer. The second gives the same database cost as 2b, plus one long-lived connection per tab.
- **SQLite cost:** Same as polling if the server polls. Lower only with in-process pub/sub, which assumes one process.
- **Complexity:** Medium. You need stream lifecycle and abort handling, the compression header, a client store, and connection-limit care.

### 4. Websockets

- **Fit:** Poor. Websockets need an HTTP `upgrade` handler on the Node server. The stock `react-router-serve` (`@react-router/serve/dist/cli.js`) exposes no such hook, so you would have to replace it with a custom Express server (`@react-router/express` `createRequestHandler` plus a `ws` server) and wire the same into `react-router dev`. Data flows entirely outside loaders and actions.
- **SQLite cost:** Same story as SSE. Pushing needs in-process pub/sub or per-connection polling.
- **Complexity:** Highest. You need a custom server, a new dependency, authenticating the socket from the session cookie, reconnect logic, and a client store. The bidirectional channel buys nothing, because notifications only flow server to client and "read" actions are already handled by normal actions.

## Summary table

| Option | Fit with RR model | SQLite load | Complexity | Latency |
| --- | --- | --- | --- | --- |
| Layout loader on navigation | Native | ~0 (1 indexed count per nav) | Very low | Next nav or action |
| `useRevalidator` interval | Sanctioned, but reruns all loaders | High (full layout and page loaders per tick) | Low code, hidden cost | Interval |
| `fetcher.load` interval on resource route | Native, isolated | Low (1 indexed count per tab per tick) | Low | Interval |
| SSE | Off-path (raw `Response` stream) | Same as polling unless in-process pub/sub | Medium; compression and 6-connection gotchas | Near real-time |
| Websockets | Requires replacing `react-router-serve` | Same as SSE | High | Real-time |

## Recommendation

Use a **hybrid of options 1 and 2b**:

1. Put `unreadCount` in the `app/routes/layout.app.tsx` loader so the sidebar badge refreshes for free on every navigation and after every action, including "mark as read".
2. Add a resource route `api/notifications` (registered in `app/routes.ts` next to the other `api/*` routes) that returns the unread count and the newest few items for the session user.
3. Mount one small poller component in `layout.app.tsx` that calls `fetcher.load("/api/notifications")` every 30 to 60 seconds, skips ticks while `document.hidden`, and fires a `sonner` `toast(...)` when it sees items newer than the last one seen. The `<Toaster>` is already mounted there.
4. Index the notifications table on `(userId, readAt)`, or on `(userId, createdAt)` if you need ordering, following the inline `index(...)` convention in `app/db/schema.ts`.

Avoid `useRevalidator` for the interval, because it would re-run the heavy layout loader on every tick. Defer SSE and websockets. Both cost more for real-time delivery the user has said is not needed, and both fight the stock `react-router-serve` setup (compression buffering, no upgrade hook). If real-time is wanted later, only the transport behind step 3 changes: swap it for an SSE resource route sent with `Cache-Control: no-transform`, and keep steps 1, 2 and 4.
