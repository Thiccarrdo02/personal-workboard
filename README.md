# My Workboard

A personal task manager built around one screen of client boards, optimised for **Desktop (PC & Mac)**, **Laptop** and **Mobile (iPhone & Android)**, with cross-device sync.

---

## Live Deployment

- **Production URL**: [https://personal-todo-manager.vercel.app](https://personal-todo-manager.vercel.app)
- **Vercel Project Dashboard**: [https://vercel.com/razas-projects-07cc30b5/personal-todo-manager](https://vercel.com/razas-projects-07cc30b5/personal-todo-manager)
- **GitHub Repository**: [https://github.com/Thiccarrdo02/personal-workboard](https://github.com/Thiccarrdo02/personal-workboard)

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
- **Morning digest** via Telegram and/or email, sent daily at ~8:00 AM IST.
- **Views**: Board (by client), **Kanban** (by status, drag between columns) and **Focus** (urgent + in progress only).
- **Dark mode** (auto / light / dark), category colours, collapsible and re-orderable categories.
- **Keyboard first**: `J/K` move, `Space` status, `E` edit, `D` due date, `Shift+↑/↓` reorder, `?` for the full list.
- **Phone app**: bottom navigation, bottom sheets, touch drag handles, installable with a proper icon, opens offline.

---

## Multi-Device Sync (Phone, PC & Laptop)

Open the app on any device and enter your PIN — that's it. Every change saves on the device instantly (works offline) and syncs in the background.

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

## Morning Digest Setup (optional)

In Vercel → Project → Settings → Environment Variables:

| Variable | Purpose |
| --- | --- |
| `CRON_SECRET` | Any long random string; authorises the daily schedule |
| `TELEGRAM_BOT_TOKEN` | From `@BotFather` → `/newbot` |
| `TELEGRAM_CHAT_ID` | Message your bot, then use **More → Morning digest → Find my Telegram chat ID** |
| `RESEND_API_KEY`, `DIGEST_EMAIL_TO` | Optional email delivery via [resend.com](https://resend.com) (`DIGEST_EMAIL_FROM` optional) |

Redeploy after adding them. The schedule lives in `vercel.json` (`30 2 * * *` UTC = 8:00 AM IST); the free plan may deliver it up to an hour late. Use **Send test now** in the app to try it.

---

## Running Locally

```bash
npm run dev
```
Runs at `http://localhost:8123` with throwaway storage in `.data/` and the test PIN from `scripts/dev.js` — it never touches the real cloud board.

```bash
npm start
```
Runs at `http://localhost:8000` using `.env.local` (real `APP_PASSWORD`, `GITHUB_TOKEN`, `GIST_ID`).

```bash
npm test
```
Unit tests for dates, quick-add parsing, recurrence, sync merging, reports and the sync API.

### Project layout

```
public/          static app served by Vercel's CDN
  index.html, styles.css, sw.js, manifest.webmanifest, icons/
  js/core.js     pure logic shared with the server (dates, parsing, merge, reports)
  js/store.js    state, undo, actions, sync client
  js/ui.js       rendering: board, kanban, focus, Today strip, menus
  js/sheets.js   task details, quick add, archive, report, digest, backup
  js/main.js     lock screen, keyboard shortcuts, startup
api/             auth.js, sync.js, digest.js (routed by server.js)
lib/             env.js, auth.js, storage.js (GitHub Gist or local file)
```

---

## Deploying Updates to Vercel

```bash
npx vercel --prod
```
or connect this Git repository to your [Vercel Dashboard](https://vercel.com/new).
