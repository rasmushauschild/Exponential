# Exponential

A deliberately simple planning app: the master plan on top, this week underneath.

## Run in development

```bash
npm install
npm run dev
```

This starts Vite and opens the Electron window with hot reload.

## Build installers

```bash
npm run dist:mac   # → release/*.dmg
npm run dist:win   # → release/*.exe (run on Windows, or on a Mac with Wine)
```

## Google sign-in and Calendar (one-time setup)

The desktop app asks you to sign in with Google on first launch. It uses the account for your
name and photo, your email, and read-only Google Calendar access for the **Calendar** toggle.
Google requires every app to have its own OAuth client, so — once, for the whole team:

1. Go to <https://console.cloud.google.com/> and create a project (e.g. "Exponential").
2. **APIs & Services → Library** → enable **Google Calendar API**.
3. **APIs & Services → OAuth consent screen** → Internal (if you're on Google Workspace)
   or External, fill in the app name, add the scopes `openid`, `email`, `profile`,
   `…/auth/calendar.readonly`.
4. **APIs & Services → Credentials → Create credentials → OAuth client ID**,
   application type **Desktop app**. Copy the client ID and client secret.
5. Put them in `electron/google.client.json` (copy `google.client.example.json`). The file is
   git-ignored and gets bundled into the installers, so teammates just click **Continue with Google**.
   Without the file, the sign-in screen asks for the two values instead.

Everyone on the team uses the same client; each person signs in with their own Google account. Teammates' calendars show up when they have shared
their calendar with you (inside one Workspace this is usually on by default
for free/busy or full details).

Credentials and tokens are stored in the app's user-data folder
(`~/Library/Application Support/Exponential/` on macOS, `%APPDATA%\Exponential\` on Windows).

## Where planning data lives

In Supabase (`supabase/schema.sql` is the whole database: tables, row-level security,
realtime). The app signs in to Supabase with the Google ID token, loads one team at a time,
writes every edit as row changes, and reloads on realtime events so everyone sees the same
plan. The browser preview (`npx vite`) has no Google sign-in and falls back to a local
workspace in localStorage with sample data.

Setup once per Supabase project: run `supabase/schema.sql` in the SQL editor, and under
Authentication → Sign In / Providers → Google add the OAuth client ID to *Authorized Client IDs*.

## Interactions

| Where | Action |
| --- | --- |
| Master plan | Pinch (or ⌘/Ctrl + scroll) to zoom, scroll sideways or drag empty space to pan, scroll vertically when the rows overflow |
| Anywhere | Shift/⌘-click projects, deadlines and tasks to select several; Backspace/Delete removes them, Escape clears the selection |
| Master plan | Drag the blue week band to choose the week shown below |
| Master plan | Drag a project to move it (left/right = dates, up/down = row); drag either end to stretch it |
| Master plan | Click a project or deadline star to open its details on the right; drag a star to move a deadline |
| Master plan | Hover empty space to see a ghost bar; click to create a one-week project and type its name. Hover the top (deadline) row and click to add a deadline the same way |
| Divider | Drag the handle between the panels to rebalance them |
| Week | Pick a teammate at the top right; only your own tasks are editable |
| Week | Click a task's status dot: to do / in progress / needs review / completed / cancelled |
| Week | Drag a task's block to another day, or drag either end to stretch it over several days |
| Week | The floating **+ Add task** button (bottom right) creates a **backlog** task with no date: it shows faded at the bottom of every week until you click a day on its row to schedule it (or click a day in the empty area to create a dated task directly) |
| Week | **Calendar** toggle shows Google Calendar events for the selected person |
| Master plan | Hover a week near the bottom edge for its "Retro · Week N" pill; click it to open that week's retro |
| Week | Swipe sideways on the trackpad to go to the previous/next week (the master plan band follows) |
| Week | Pick a teammate and add tasks to *their* week — they show up dashed with an "added by" chip |
| Details | Edit title, dates, colour/status; notes are rich text stored as Markdown (headings, bullets, todos, bold/italic, pasted images) — the **Markdown** button shows the source |
| Details | **Send to Agent** copies the item (title, properties, notes) as one Markdown document to the clipboard |
| Week | Drag a task's title up or down to reorder tasks that share a day |
| Layout | Drag the gaps between panels; proportions are remembered on this machine |
| Details | Assign people to a project (avatars show on the bar); set a task's owner; when status is "Needs review", pick who reviews |
| Inbox | Left sidebar: tasks added for you, review requests, owner hand-offs, changes to projects you're on |
| Anywhere | ⌘Z / ⌘⇧Z (Ctrl on Windows) undo and redo — 100 steps |

## Menu-bar widget (macOS)

While the app is running, a chevron sits in the menu bar. Clicking it drops down the week
panel on its own — same tasks, days, teammates, drag and status controls — with a fresh task
ready to type into. **Open app** brings up the main window; clicking a task opens it there.
Closing the main window keeps the app and the widget running. Edits in either window show up
in the other immediately.

## Teams

The sidebar (collapsed to icons; hover to expand) lists your teams — click one to switch,
hover it and click the cog for its settings. Each team has its own people, master plan,
weeks, retros and inbox. On the settings page moderators can rename the team, pick its icon,
edit the retro questions, add and remove people, and promote or demote moderators.

## Not done yet

- Offline cache (the app needs a connection to open a team).
