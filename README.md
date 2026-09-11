# My Workboard

A modern personal task manager optimized for **Desktop (PC & Mac)**, **Laptop**, and **Mobile (iPhone & Android)** with real-time cross-device synchronization and zero setup required.

---

## Live Deployment

- **Production URL**: [https://personal-todo-manager.vercel.app](https://personal-todo-manager.vercel.app)
- **Vercel Project Dashboard**: [https://vercel.com/razas-projects-07cc30b5/personal-todo-manager](https://vercel.com/razas-projects-07cc30b5/personal-todo-manager)
- **GitHub Repository**: [https://github.com/Thiccarrdo02/personal-workboard](https://github.com/Thiccarrdo02/personal-workboard)

---

## Multi-Device Sync (Phone, PC & Laptop)

You can run this app on your phone, laptop, and desktop PC simultaneously:

1. Open the app on your computer.
2. Click the **Sync** button in the top toolbar.
3. Enter your secret **Sync PIN** (or click **🎲 Random** to generate one) and click **Save & Sync**.
4. Open the web app on your phone or laptop, click **Sync**, enter the **exact same PIN**, and click **Save & Sync**.
5. All devices now stay automatically synchronized!

> [!NOTE]
> **Offline-First Resilience**: Tasks always save instantly to local storage first (0ms latency, works completely offline). When your device is connected, changes automatically sync in the background.

---

## Installing as a Native App on Your Phone

### iPhone (iOS Safari)
1. Open the URL in Safari.
2. Tap the **Share** button (the square with an arrow pointing up).
3. Scroll down and tap **Add to Home Screen**.
4. Tap **Add**. The app now appears on your home screen with its custom icon and runs in full-screen mode without Safari address bars!

### Android (Google Chrome)
1. Open the URL in Chrome.
2. Tap the three dots menu in the top-right corner.
3. Tap **Install app** or **Add to Home screen**.

---

## Running Locally

### Node.js
```bash
npm start
```
Runs at `http://localhost:8000` with the static server and the `/api/sync` endpoint active.

### Python
```bash
python server.py
# or double-click START-WINDOWS.bat / START-MAC.command
```

---

## Deploying Updates to Vercel

```bash
npx vercel
```
or connect this Git repository directly to your [Vercel Dashboard](https://vercel.com/new).

To connect free cloud persistence on Vercel:
1. Go to your Project on [vercel.com](https://vercel.com).
2. Click the **Storage** tab.
3. Click **Connect Store** -> **KV (Upstash)** (100% free tier, 10,000 requests/day).
4. Vercel automatically injects the KV credentials, giving your board permanent cloud storage.
