# Smart Day: your personal to-do + calendar + Gmail assistant

Runs free inside **your own Google account** (Google Apps Script). There's no server and no subscription, and your email never leaves Google.

## What it does

| | |
|---|---|
| ✉️ **Reads your Gmail** every 5 min (read-only) | Finds exams, deadlines, interviews, assessments, meetings and their dates |
| ✅ **Important → added automatically** | Mail from your college domain, or with words like *exam / deadline / interview*, goes straight onto your calendar and to-do list. You get a notification with an **Undo** button |
| 🤔 **Not sure → asks you** | Other dated emails send a notification with **Add / Ignore** buttons. They also wait in the **Review** tab, where you can fix the date or block the sender |
| 💼 **Job and internship alerts** | Reads Internshala, Unstop, LinkedIn, Naukri… alert emails and pings you when one **matches your skills**. Save it, mark it applied, or put the apply-by date on your calendar |
| 📋 **To-do list** | Type naturally, e.g. *"Submit DBMS assignment tomorrow 5pm"* or *"Pay fees by 30/10"*. The date gets picked up automatically. Reminder before it's due |
| 📅 **Calendar** | Month view of your Google Calendar + Smart Day events + to-dos (exam dates, deadlines, company applications) |
| ☀️ **Morning summary** | A 7 AM notification: today's events, what's due, what's overdue, upcoming exams, new openings |

---

## Setup (about 10 minutes, easiest on a laptop)

### 1. Create the project
1. Go to **https://script.google.com** → **New project**. Rename it **Smart Day**.
2. Click **⚙ Project Settings** → tick **"Show appsscript.json manifest file in editor"**.
   Also check the **Time zone** (default is India / Asia/Kolkata).
3. Back in the **Editor**:
   - Open `appsscript.json` → replace everything with this folder's `appsscript.json`.
   - Open `Code.gs` → replace everything with this folder's `Code.gs`.
   - Click **+ → HTML**, name it exactly `Index`, and paste in `Index.html`.
4. Press **Ctrl+S** to save.

### 2. Run setup once
1. In the function dropdown at the top, choose **`setup`** → **Run**.
2. Google asks for permission. Because this is your own personal app, Google shows *"Google hasn't verified this app"*.
   Click **Advanced → Go to Smart Day (unsafe) → Allow**. It's safe: it's your code, running in your account.
3. Open **Execution log**. It should say "Setup done".

This creates a **"Smart Day data"** Google Sheet (your database), a **"Smart Day"** calendar, and the 15-minute and morning timers.

### 3. Make it an app
1. **Deploy → New deployment** → gear icon → **Web app**.
2. *Execute as:* **Me**. *Who has access:* **Only myself**. Click **Deploy**.
3. Copy the **Web app URL**.

### 4. Put it on your phone's home screen
- **Android (Chrome):** open the URL (signed into the same Google account) → ⋮ menu → **Add to Home screen**.
- **iPhone (Safari):** open the URL → Share button → **Add to Home Screen**.

### 5. Turn on notifications (Telegram)
1. In Telegram, search **@BotFather** (blue tick) → Start → send `/newbot` → choose a name and a username ending in `bot` → copy the **token**.
2. Open your new bot (the `t.me/…` link) and press **Start**.
3. In Smart Day: **⚙ Settings → Bot token** → paste → **Connect Telegram**. You'll get a "connected" message.
4. In the **Google Calendar** app, make sure the **Smart Day** calendar is turned on (Android: Settings → your account → Smart Day → Sync), and add the Calendar widget to your home screen.

### 6. Personalise it (⚙ Settings in the app)
- **Your skills**, e.g. `Python, React, Java, Data Analysis, UI/UX`. Openings are matched against these.
- **Important senders**: your college email domain (e.g. `@abc.ac.in`), placement cell, professors.
- **Important words**: anything that should always count as important.

### 7. Using two Gmail accounts
**Emails:** in your *second* Gmail, open ⚙ → See all settings → **Forwarding and POP/IMAP** → *Add a forwarding address*. Enter your main address and confirm the link Google emails to it. Then choose **"Forward a copy… keep Gmail's copy in the Inbox"** → Save. Smart Day now sees mail from both accounts.

**Calendars:** in your *second* account, open Google Calendar on the web → ⚙ Settings → click your calendar on the left → **Share with specific people** → add your main address. Then in Smart Day, go to **⚙ Settings → "Also show these calendars"**, enter the second Gmail address, and Save.
Smart Day shows every calendar that is ticked in your main account's Google Calendar, each in its own colour, and includes them in the morning summary.

### 8. Turn on job alerts on the platforms
Smart Day reads the alert **emails**, because Internshala and Unstop have no public API, so switch the alerts on:
- **Internshala** → Preferences / Notifications → email alerts for your skills, location, and internship type.
- **Unstop** → Profile → Preferences → pick your interests and opportunity types, and keep email notifications on.
- **LinkedIn** → Jobs → *Set alert* for each role you want.

---

## Updating the code later
Edit the files, then **Deploy → Manage deployments → ✏️ → Version: New version → Deploy**. The URL stays the same.

## Good to know
- **Privacy:** Gmail access is *read-only*. Everything is stored in your Drive (the "Smart Day data" sheet) and your Calendar.
  Notification text (email subjects) is sent to you through your own Telegram bot. Keep the bot token private.
- **Detection is rule-based**, not perfect. Use the Review tab to correct dates. Use *Never from this sender* to block noisy senders, and change *Auto-add score* to make it more or less eager.
- New emails are picked up within **5 minutes**. Tap ↻ in the app to check right now.
- The very first scan looks back 3 days and doesn't send notifications, so you won't get a burst of old alerts.
