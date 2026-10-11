# Athenaeum Node backend for Vercel

This is a Node.js API for the existing Flutter/Firebase bookstore. It uses Vercel Functions and Firebase Admin SDK, not Firebase Cloud Functions. Firebase Auth, Realtime Database, Supabase covers and FCM remain in place. No Firebase Blaze deployment is required by this backend.

Vercel Hobby is a free tier for personal non-commercial projects, including this educational/demo use, with usage limits. A real commercial bookstore must use hosting with suitable commercial terms. Firebase/Supabase free quotas also apply. This package does not promise unlimited usage or zero cost on paid plans.

## Files

- `api/index.js`: authenticated POST API at `/api/index`.
- `api/health.js`: public health endpoint at `/api/health`.
- `lib/service.js`: admin actions, books, orders, review likes and FCM sending.
- `lib/http.js`: Firebase Bearer-token validation and HTTP error handling.
- `lib/firebase.js`: server credentials from Vercel environment variables.
- `scripts/set-admin.cjs`: one-time trusted admin-role setup on your computer.
- `database.rules.json`: paste into Firebase Realtime Database Rules.
- `.env.example`: variable-name examples only; no real credentials.
- `tests/service.test.js`: 15 backend unit tests using fake Firebase services.

## 1 Extract and create Git repository

Extract so the folder is named `backend_notifications`. Open a terminal inside that folder. Install Node.js 22 first if it is not installed.

```sh
npm install
npm test
git init
git add .
git commit -m "Add Athenaeum Vercel backend"
git branch -M main
git remote add origin https://github.com/YOUR_USERNAME/backend_notifications.git
git push -u origin main
```

Create an empty GitHub repository before adding the remote. Do not initialize it with another README. `.gitignore` excludes node_modules, .env and common service-account filenames, but keep every actual credential outside this folder regardless of filename.

This folder is the entire backend Git repo. Do not put the Flutter app/lib folder into this repo. The old Firebase Functions `backend` folder is no longer used for the migrated app. Do not deploy the old Firebase notification triggers alongside this API: doing so would duplicate announcements and pushes.

## 2 Get Firebase server credentials

Use the existing `athenaeum-8845d` project.

Firebase Console > Project settings > Service accounts > Firebase Admin SDK > Generate new private key. Save the downloaded JSON outside the Git repository, for example `C:\private\service-account.json`. Never paste it into Flutter, GitHub, this README or chat.

The complete downloaded JSON is the server credential. Its `project_id` must be `athenaeum-8845d`. If you use another project, use matching Firebase mobile configuration, database URL and credentials everywhere.

## 3 Import into Vercel

Vercel > Add New > Project > Import the GitHub repo.

- Framework Preset: Other.
- Root Directory: repo root (the folder containing package.json and api).
- Node version: 22.x, supplied in package.json.
- Install Command: npm install (default is fine).
- Build Command: no custom build command is needed.
- Output Directory: no custom output directory is needed.

Before deployment, add these environment variables for Production:

| Variable | Value |
| --- | --- |
| FIREBASE_SERVICE_ACCOUNT_JSON | Paste the complete downloaded service-account JSON as the value |
| FIREBASE_DATABASE_URL | https://athenaeum-8845d-default-rtdb.firebaseio.com |
| ALLOWED_ORIGINS | Leave unset for Android/iOS; for Flutter Web use its exact origin(s), separated by commas |

Do not surround the entire JSON with another pair of quotes. Keep the JSON's private_key newline escapes intact. The parser also supports literal escaped newline sequences. Environment variables are server-side only.

Deploy. If variables are added or changed afterwards, redeploy. Use the Production domain, not a temporary preview URL. Make the production API publicly reachable in Deployment Protection; API writes are protected by Firebase login tokens inside the code.

Open `https://YOUR-PROJECT.vercel.app/api/health` in a browser. Expected: `ok: true` and `configured: true`. Health only checks that the variable exists; authenticated API calls test whether the actual Firebase credential is valid. A 404 at `/` is normal because this project has API endpoints rather than a website homepage.

## 4 Assign admin role once

Register and email-verify the admin account using the Flutter app. With the credential still outside the repo, run locally from backend_notifications:

```sh
npm run set-admin -- "your-admin-email@example.com" "C:\private\service-account.json"
```

Use the account you own, not the example email. The account must already exist, be enabled and verified. Sign out/in after this script so the new `admin: true` claim reaches the Flutter app. There is no hardcoded admin password and no public API that lets a user grant themselves admin.

## 5 Apply database rules

Open `database.rules.json` from this ZIP, copy the complete contents and paste into Firebase Console > Realtime Database > Rules > Publish. No Firebase CLI or paid functions deployment is required.

Use this updated file, not open `.read/.write: true` rules. It intentionally prevents direct client writes to books and order status: the Vercel API must handle those writes so its notification sending runs. The same file fixes owner review-edit permission checks at the proper review-parent path.

The Firebase Admin SDK bypasses database rules; the API independently validates revoked tokens, verified/active accounts, trusted admin claims, quantities and catalog prices.

## 6 Connect Flutter

Copy the full replacement Dart files from the supplied Flutter copy-paste code and replace pubspec.yaml. Run `flutter pub get`.

In `lib/services/api_service.dart` change ONE line:

```dart
static const baseUrl = 'https://YOUR-PROJECT.vercel.app';
```

Example: if Vercel gives `https://athenaeum-api.vercel.app`, paste exactly that origin. Do not append `/api` or a trailing slash.

All writes go to `POST <baseUrl>/api/index`, with an action field. The client sends the signed-in user's Firebase ID token in `Authorization: Bearer ...`. The server verifies it, including revocation.

| Action | Purpose |
| --- | --- |
| manageUser | Edit/disable/enable/delete a user |
| sendAnnouncement | Announcement inbox record and public FCM push |
| saveBook | Add/update a book, inbox announcement and public push |
| deleteBook | Delete a book and notify readers |
| createOrder | Trusted price/stock validation, atomic checkout and owner push |
| updateOrderStatus | Update status and notify only order owner |
| likeReview | One like per account |
| retryNotifications | Admin retries up to 20 pending pushes |

`notification_service.dart` and `notifications_screen.dart` keep receiving FCM and reading the Firebase inbox as before. Keep the previously supplied fix `import 'package:firebase_core/firebase_core.dart' show Firebase;` in notification_service.dart.

## 7 Android/iOS notifications still need native setup

Keep the Android notification icon `ic_stat_book`, manifest notification metadata/permissions and Gradle desugaring settings from your earlier guide. Allow notifications on the phone. Firebase Cloud Messaging API must be enabled for the project; if Firebase/Google Cloud shows it disabled, enable it. On iOS upload APNs credentials and configure Xcode push capabilities.

Signing into the verified Flutter app registers the device token and subscribes to `athenaeum_readers`. That public topic is only for catalog/news. Orders use individual owner tokens. Direct changes through Firebase Console do not automatically push in this Vercel architecture. Make book/order changes through the updated Admin app.

The server awaits its FCM calls before returning, rather than relying on a background task that might stop when the request ends. If sending fails, the data change stays saved, a pending queue record remains and Admin gets a warning. Use Retry pending notifications. This is a manual retry mechanism, not an always-running worker or automatic cron. Successful retries can occasionally duplicate pushes after ambiguous network failures; this is not an exactly-once delivery guarantee.

Notifications support normal closed-app, background and lock-screen conditions after setup. Android Force stop blocks delivery until reopen. Permission/network/OS restrictions can prevent or delay delivery.

## Testing and limitations

15 unit tests cover authorization, atomic checkout, authoritative totals, checkout request deduplication, admin actions, catalog pushes, private owner pushes, like deduplication and delivery failure handling. JavaScript/Dart syntax and SDK module loading were checked. No live Vercel deployment, Flutter build or real phone test was performed here.

- Root database transactions provide atomic stock/order writes for this small eProject. They read the full database and can become inefficient as its data grows. Use a dedicated inventory/order service for a large store.
- Checkout uses the existing 8 percent estimated tax. This is app configuration, not a statement about tax law. No real payment gateway/courier API is included.
- Checkout deduplication uses a request ID; the supplied Flutter service retains it during an app session when a request fails. After a timeout or app restart, check order history before trying again.
- Book images retain the previous Supabase upload plus small inline-cover fallback. Avoid giant inline images because both Vercel payload and Firebase quota limits apply.
- No backend rate-limiting infrastructure is included. Monitor platform usage for a public deployment.
- Sent pushQueue records remain for diagnostics. Remove older sent records periodically from Firebase Console to avoid indefinite growth; retain pending entries until retry/discard.

Official references:
https://vercel.com/docs/functions/runtimes/node-js
https://vercel.com/docs/plans/hobby
https://firebase.google.com/docs/auth/admin/verify-id-tokens
https://firebase.google.com/docs/cloud-messaging/flutter/receive-messages
