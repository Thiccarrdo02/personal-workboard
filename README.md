# ZAWISH Workboard

Personal task boards for the ZAWISH team, built around one screen of client boards, optimised for **Desktop (PC & Mac)**, **Laptop** and **Mobile (iPhone & Android)**, with cross-device sync. Each person signs in with their own 6-digit PIN and sees only their own board.

---

## Live Deployment

- **App**: [https://board.zawish.si](https://board.zawish.si) — Cloudflare Workers (free plan) + D1 database
- **Cloudflare**: Workers & Pages → `zawish-workboard` (D1 database `zawish-workboard`, APAC)
- **GitHub Repository**: [https://github.com/Thiccarrdo02/personal-workboard](https://github.com/Thiccarrdo02/personal-workboard)
- The old address (personal-todo-manager.vercel.app) is retired.

---

## Features

- **Due dates + Today strip** — overdue, due today and the next 7 days across every client, at the top of the board.
- **Quick add** (`N` or `Ctrl+K`, or the **+** button on phones) that understands plain English:
  `Send invoice fri 5pm ! #acme every month` → due Friday 5pm, urgent, in Acme, repeats monthly.
  Dates: `today`, `tmr`, `fri`, `next fri`, `next week`, `in 3 days`, `25 oct`, `25/10`. Times: `5pm`, `17:30`, `at 9am`.
  Repeats: `daily`, `weekly`, `monthly`, `every monday`, `every 2 weeks`, `every weekday`. Flags: `!` urgent, `#client`, `@waiting`.
- **Statuses**: To start → In progress → Done (click to cycle), plus **Waiting** (right-click / long-press the status, or press `W`) for work blocked on a client.
- **Task details**: notes with clickable links, a checklist, due date & time, repeat, category, and history (created / started / done).
- **Age warnings**: “In progress 18d” and “Waiting 4d” chips so stale work stands out.
- **Undo** for deletes, status changes, moves and archiving (toast + `Z` / `Ctrl+Z`).
- **Recurring tasks**: completing one creates the next occurrence automatically.
- **Archive** done tasks to keep the board clean; they still count in reports.
- **Weekly report** per client (done / in progress / waiting / coming up), ready to copy or share.
- **Morning digest on Telegram**, per person: each person links their own Telegram and picks the time (default 8:00), days (Mon–Sat by default) and detail (task names or counts only).
- **Owner pings on Telegram**: join requests arrive with Approve / Reject buttons, plus a note when someone joins with an invite or deletes their account.
- **Your data**: download everything kept about you, see signed-in devices and sign out the others, delete your own account (PIN required).
- **Views**: Board (by client), **Kanban** (by status, drag between columns) and **Focus** (urgent + in progress only).
- **Dark mode** (auto / light / dark), category colours, collapsible and re-orderable categories.
- **Keyboard first**: `J/K` move, `Space` status, `E` edit, `D` due date, `Shift+↑/↓` reorder, `?` for the full list.
- **Phone app**: bottom navigation, bottom sheets, touch drag handles, installable with a proper icon, opens offline.

---

## Signing in

- **Who's working?** Tap your name, enter your 6-digit PIN. With "Keep me signed in on this device" ticked you only do this once per device (sessions last 180 days while in use).
- **New people** get a one-time setup link (valid 24 hours) to choose their PIN. Easy PINs like `123456` are refused.
- **Wrong PINs**: 5 wrong tries lock that profile for 15 minutes (doubling each time); each network is limited to 30 tries per 15 minutes.
- **Sign out of this device** (More menu) also removes the local copy of the board, for shared computers.
- PINs are stored as HMAC-SHA256 with a per-person salt and a server secret (`PIN_PEPPER`), never as typed.
- Every API request is tied to one person's session and can only read or write that person's board.

## Multi-Device Sync (Phone, PC & Laptop)

Every change saves on the device instantly (works offline) and syncs in the background.

Each task carries its own change time, and the server only accepts a save that is based on the latest cloud version. When two devices edit at the same time, the later one receives the newer board, **merges it task by task**, and saves again — so edits on different devices never overwrite each other. Deleted tasks leave a short-lived marker so they don't come back from another device.

---

## Installing as an App on Your Phone

### iPhone (iOS Safari)
1. Open the URL in Safari.
2. Tap **Share** → **Add to Home Screen** → **Add**.

### Android (Google Chrome)
1. Open the URL in Chrome.
2. Tap **⋮** → **Install app** (or **Add to Home screen**).

The installed app opens full-screen and keeps working without a connection; changes upload when you're back online.

---

## Telegram setup (once, by the owner)

1. In Telegram, open `@BotFather`, send `/newbot`, name it **ZAWISH Workboard** and pick a username ending in `bot` (e.g. `ZawishWorkboardBot`).
2. Add the token as a secret (paste it when asked; it never goes in a file):
   ```bash
   npx wrangler secret put TELEGRAM_BOT_TOKEN
   ```
3. In the app: **More → Notifications → Activate bot**. This registers the webhook (`/api/telegram`, checked with the `TELEGRAM_WEBHOOK_SECRET` secret) and the bot's commands.
4. Everyone then taps **More → Notifications → Connect Telegram**, then **Start** in Telegram. `/stop` in the bot unlinks.

The cron in `wrangler.jsonc` runs every 15 minutes and sends each person's digest once a day, within two hours after their chosen time, in their own time zone (`DIGEST_TIMEZONE` is the fallback). Nothing is sent to anyone who hasn't connected. If someone blocks the bot, they're unlinked automatically.

---

## Running Locally

```bash
npm install
npm run db:local
npm run dev
```
Runs the real Cloudflare runtime at `http://localhost:8787` with a local database in `.wrangler/` and a dev-only `PIN_PEPPER` in `.dev.vars` (create it with any random 64-character string). It never touches the live board. Create a local profile and setup link with:

```bash
node scripts/admin.mjs setup-link --name "Your Name" --role owner
```

```bash
npm test
```
Unit tests for dates, quick-add parsing, recurrence and sync merging, plus Worker tests (PINs, lockouts, setup links, sessions, sync conflicts, isolation between people) against an in-memory SQLite database, with a fake Telegram API for the bot, pings and the digest schedule.

### Project layout

```
public/            static app served by Cloudflare (Workers Static Assets)
  index.html, styles.css, sw.js, manifest.webmanifest, _headers, icons/
  js/core.js       pure logic shared with the Worker (dates, parsing, merge, reports)
  js/store.js      state, undo, actions, per-person storage, sync client
  js/ui.js         rendering: board, kanban, focus, Today strip, menus
  js/sheets.js     task details, quick add, archive, report, team, notifications, your data, backup
  js/main.js       sign-in screen, keyboard shortcuts, startup
worker/            Cloudflare Worker: profiles, login, setup, team, me (export/devices/delete), sync,
                   notifications + Telegram webhook, digest cron every 15 min
migrations/        D1 schema
scripts/admin.mjs  create a person + one-time setup/reset link; import a board from the old Gist
wrangler.jsonc     Worker, D1, domain and cron config
```

---

## Admin

Add a person or reset a forgotten PIN (prints nothing secret; the link is written to `.data/setup-link.txt`):

```bash
node scripts/admin.mjs setup-link --name "Ali" --remote
```

Running it for someone who already has a PIN makes a **reset** link: choosing a new PIN signs them out everywhere else.

---

## Deploying

```bash
npx wrangler deploy
```
Schema changes: add a file to `migrations/` and run `npm run db:remote`.
