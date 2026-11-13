# Research: Web push options for a web app on phones

Ticket: [#2](https://github.com/bradpetkus/cohort-005-project-bradp/issues/2) (child of map [#1](https://github.com/bradpetkus/cohort-005-project-bradp/issues/1)). Researched 2026-11-13.

**Question.** How can the Cadence web app (React Router 8 framework mode, Node, SQLite via Drizzle, no native app) make a Student's, Instructor's or Platform Admin's phone buzz? We compare third-party providers (OneSignal, Firebase Cloud Messaging) with the standard Web Push API and self-managed VAPID keys (the `web-push` npm package).

## TL;DR

- Every option uses the same browser plumbing underneath: a **service worker**, the W3C **Push API** and **Notifications API**, and the browser vendor's push service (Apple's `*.push.apple.com` for Safari, Google's for Chrome, Mozilla's for Firefox). Providers do not get around any platform limits. They only wrap subscription storage, sending, and dashboards.
- **iPhone limit, which applies to every option:** iOS/iPadOS **16.4+**, and the user must **Add to Home Screen** and open the app from that icon. A Safari tab cannot ask for permission. You also need a web app manifest with `display: standalone` (or `fullscreen`), and the permission request must come from a tap.
- **Cost:** `web-push` (MPL-2.0) is free, and so are the browser push services. FCM is listed as "No-cost". OneSignal's Free plan is $0 but caps each send at 10,000 web subscribers, and its Growth plan is $19/mo plus $0.004 per web push subscriber.
- **Recommendation:** use the **standard Web Push API with VAPID via `web-push`**. Store subscriptions in a Drizzle table keyed to the user and send from the existing Node server. It costs nothing, sends no user data to a third party, and needs little code. The iOS Home Screen requirement is the real product cost, and no provider removes it.

## How web push works (common to all options)

1. The client registers a service worker. On user action it calls `Notification.requestPermission()` and then `pushManager.subscribe({ userVisibleOnly: true, applicationServerKey: <VAPID public key> })`. ([WebKit: Meet Web Push](https://webkit.org/blog/12945/meet-web-push/), [MDN Push API](https://developer.mozilla.org/en-US/docs/Web/API/Push_API))
2. The browser returns a `PushSubscription`: an `endpoint` URL on the vendor's push service plus `keys.p256dh` and `keys.auth`. The client posts this to our server. ([web-push README](https://github.com/web-push-libs/web-push))
3. To notify, the server encrypts a payload and POSTs it to the endpoint, signed with the VAPID private key. The service worker's `push` handler calls `showNotification()`.
4. The endpoint is a secret capability URL. Anyone who has it can push to that device, so store it as sensitive data. ([MDN Push API](https://developer.mozilla.org/en-US/docs/Web/API/Push_API))
5. Every push must show a notification. Safari: "Violations of the `userVisibleOnly` promise will result in a push subscription being revoked." Silent or background pushes are not allowed. ([WebKit: Meet Web Push](https://webkit.org/blog/12945/meet-web-push/))

## Platform support

| Platform | Support | Notes / source |
| --- | --- | --- |
| iPhone / iPad | iOS/iPadOS 16.4+, **Home Screen web apps only** | Manifest `display` must be `standalone` or `fullscreen`. Permission must come from a user gesture. Delivered via APNs, and no Apple Developer membership is needed. ([WebKit: Web Push for Web Apps on iOS and iPadOS](https://webkit.org/blog/13878/web-push-for-web-apps-on-ios-and-ipados/)) |
| iPhone: install UX | No install prompt | There is no `beforeinstallprompt` on iOS, so the app must show "Share > Add to Home Screen" instructions. If the user taps "Don't Allow", iOS won't ask again until they remove and re-add the icon. Removing the icon deletes the subscription. On iOS 26+ "Open as Web App" is the default when adding to the Home Screen. ([OneSignal: Web push for iOS](https://documentation.onesignal.com/docs/web-push-for-ios)) |
| iPhone: EU | Still works | Apple planned to drop Home Screen web apps in the EU in iOS 17.4, then reversed that on 2024-03-01. (Press coverage of Apple's statement: [MacRumors](https://www.macrumors.com/2024/03/01/apple-walks-back-decision-to-disable-eu-web-apps/)) |
| iPhone: Declarative Web Push | iOS/iPadOS 18.4+, macOS Safari 18.5 | Optional JSON payload format (`"web_push"` key plus a `notification` object) that the browser shows without running service-worker JavaScript. Older browsers fall back to the service worker. Standards-track proposal, not final. ([WebKit: Meet Declarative Web Push](https://webkit.org/blog/16535/meet-declarative-web-push/), [WebKit: Safari 18.4](https://webkit.org/blog/16574/digital-credentials-api/)) |
| Android | Chrome, Firefox, Samsung Internet support it | Works from a normal browser tab. No install needed. ([caniuse: Push API](https://caniuse.com/push-api)) |
| Desktop | Chrome 50+, Edge 17+, Firefox 44+, Safari 16+ on macOS 13+ | Safari on macOS does not need a Home Screen install. ([caniuse](https://caniuse.com/push-api), [WebKit: Meet Web Push](https://webkit.org/blog/12945/meet-web-push/)) |

Overall, caniuse reports about 97% global support (full plus partial). iOS is listed as "partial" because of the Home Screen restriction.

## Option comparison

### A. Standard Web Push + VAPID (`web-push` npm)

- **What it is:** a Node library that encrypts payloads and signs requests to any browser's push service. API: `generateVAPIDKeys()`, `setVapidDetails(subject, publicKey, privateKey)`, `sendNotification(subscription, payload, { TTL, urgency, topic })`. It rejects with a `statusCode` that callers can inspect. ([README](https://github.com/web-push-libs/web-push))
- **Version/licence:** 4.0.0, MPL-2.0, `node >= 16`, four small deps (`asn1.js`, `http_ece`, `https-proxy-agent`, `jws`). ([package.json](https://raw.githubusercontent.com/web-push-libs/web-push/master/package.json))
- **Cost:** $0. The vendor push services charge nothing. (Apple needs no developer membership: [WebKit](https://webkit.org/blog/12945/meet-web-push/).)
- **Server work (all ours):**
  - One VAPID key pair in env vars.
  - A `push_subscriptions` table (userId, endpoint unique, p256dh, auth, userAgent, createdAt, lastSuccessAt) plus a migration.
  - Subscribe and unsubscribe actions.
  - A send helper that fans out to all of a user's devices. It deletes a row when the push service returns 404/410. This is standard Push protocol behaviour; the README doesn't spell it out but exposes `statusCode`.
  - Optionally, a small retry or queue for bulk sends.
- **Client work:** `public/sw.js` (push and notificationclick handlers), `public/manifest.webmanifest`, the `<link rel="manifest">` and `apple-touch-icon` in `root.tsx`, a "Turn on notifications" button, and an iOS "Add to Home Screen" hint. Cadence currently has neither a manifest nor a service worker (`public/` holds only `favicon.svg` and `images/`).
- **Privacy:** subscriptions and notification content stay on our server and go only to the browser vendor's push service. Payloads are end-to-end encrypted to the device (the library uses `http_ece`), so even the push service can't read them.
- **Effort:** small to medium, about 1–2 days for a working vertical slice. No new vendor account.
- **Downsides:** no dashboard, analytics or segmentation, and we build our own delivery bookkeeping.

### B. Firebase Cloud Messaging (FCM) for web

- **Cost:** "No-cost" on both Spark and Blaze plans. ([Firebase pricing](https://firebase.google.com/pricing))
- **How it works:** the client loads the Firebase JS SDK and needs a `firebase-messaging-sw.js` at the domain root. VAPID keys are generated or imported in the Firebase console. The client calls `register()` and sends the resulting **Firebase Installation ID** to our server. `getToken()` is now deprecated. ([FCM web client](https://firebase.google.com/docs/cloud-messaging/js/client))
- **Server work:** we still store FIDs per user in our DB. Sending uses the `firebase-admin` SDK with a Google service-account credential. Multicast handles up to 500 targets per call. ([Admin SDK send](https://firebase.google.com/docs/cloud-messaging/send/admin-sdk))
- **iOS:** FCM rides the same Push API, so the same 16.4+ Home Screen rules apply. FCM's web docs have no iOS-specific notes.
- **Privacy:** Google acts as a processor under the Firebase Data Processing and Security Terms. Installation IDs are kept until we delete them. FCM is a "global" service, so data may be processed in any Google location. ([Firebase privacy](https://firebase.google.com/support/privacy))
- **Effort:** medium. It adds a Google Cloud project, service-account secrets, the Firebase SDK on the client and `firebase-admin` on the server. It doesn't remove our own storage of per-user IDs. Its main value is for apps that also ship native Android/iOS apps, which Cadence doesn't have.

### C. OneSignal

- **Cost:** Free $0, with "Max 10,000 subscribers per send". Growth is $19/mo plus **$0.004 per web push subscriber**. Professional and Enterprise are custom-priced. ([OneSignal pricing](https://onesignal.com/pricing))
- **How it works:** host `OneSignalSDKWorker.js` at the site root, add the OneSignal SDK script, and call `OneSignal.login(<our user id>)` to link devices to our user (External ID). Send via `POST https://api.onesignal.com/notifications` with an App API key. ([Web push quickstart](https://documentation.onesignal.com/docs/web-push-quickstart))
- **iOS:** the same 16.4+ Home Screen rules, and the same need for our own manifest. It has a ready-made permission "slidedown". ([Web push for iOS](https://documentation.onesignal.com/docs/web-push-for-ios))
- **Server work:** minimal. OneSignal stores subscriptions, and we only call their REST API by external ID. We get a dashboard, analytics, segmentation and email/SMS channels.
- **Privacy:** the SDK collects IP, device/browser data, pages visited, session data, and IP-inferred location. OneSignal is "primarily a data processor", but its policy also lists its own uses such as inferences/predictive models, cross-device identity resolution, and ad-performance analysis. It also says it may use cookies to track across websites. ([OneSignal privacy policy](https://onesignal.com/privacy_policy)) For a learning platform with students this needs a DPA and privacy-notice review.
- **Effort:** low to medium for code, but it adds a third-party script to every page plus a vendor account. Costs scale per subscriber on paid plans.

### Others (not evaluated in depth)

Hosted web-push services (e.g. Pushpad) and notification-orchestration platforms (e.g. Knock, Novu) exist. They sit on top of the same Push API and have the same iOS limits. Their main value is multi-channel workflows and dashboards. They weren't researched against primary sources here.

## Side-by-side

| | `web-push` + VAPID | FCM | OneSignal |
| --- | --- | --- | --- |
| Cost (small/medium) | $0 | $0 | $0 (≤10k per send) → $19/mo + $0.004/subscriber |
| iOS | 16.4+, Home Screen only | same | same |
| Android / desktop | All major browsers | same | same |
| Subscription storage | Our SQLite (Drizzle table) | Our DB stores FIDs; Google stores installs | OneSignal stores; we map by external ID |
| Sending | `web-push` from Node | `firebase-admin` + service account | REST API + API key |
| Third-party data sharing | None beyond browser push service (payload E2E encrypted) | Google (processor, global) | OneSignal (processor plus own analytics uses) |
| Extra client JS | Our ~50-line `sw.js` | Firebase SDK + `firebase-messaging-sw.js` | OneSignal SDK on every page + worker |
| Dashboard/analytics | None | Firebase console | Rich |
| Integration effort | ~1–2 days | ~2 days, plus GCP setup | ~1 day, plus vendor/DPA setup |

## Recommendation

**Use the standard Web Push API with self-managed VAPID keys and the `web-push` npm package.**

Why:

- A provider doesn't fix the hard part: iOS 16.4+ with a Home Screen install, a manifest and a tap-to-enable button. Every option has to solve it in our own UI.
- It is free, with no per-subscriber pricing.
- It has the best privacy story. Student data stays in our SQLite, and payloads are end-to-end encrypted.
- It fits the stack. It needs one Drizzle table, a resource route or action for subscribe/unsubscribe, and a send helper called wherever in-app notifications are created.
- FCM only pays off if Cadence later ships native apps. OneSignal only pays off if we want a marketing dashboard and multi-channel campaigns, and it costs money plus third-party tracking.

Implementation notes for the follow-on tickets:

- Add `manifest.webmanifest` (`display: "standalone"`, 192/512 PNG icons) and a 180×180 `apple-touch-icon`.
- Register `/sw.js` from the client. Always call `showNotification` in the `push` handler (Safari revokes otherwise).
- Show the enable button only when push is supported. On iOS Safari tabs, show Add to Home Screen instructions instead.
- Prune subscriptions on 404/410. Set `TTL` and `urgency` per notification type. Use `topic` to collapse repeated notifications.
- Consider sending Declarative Web Push-shaped payloads (`web_push` + `notification`) so iOS 18.4+ can show notifications even if the service worker fails. Older browsers still use the service worker.
