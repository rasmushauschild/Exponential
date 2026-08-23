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

Exponential signs people in with Google to get their name and photo, and reads
Google Calendar (read-only) for the **Calendar** toggle in the week panel.
Google requires every app to have its own OAuth client, so:

1. Go to <https://console.cloud.google.com/> and create a project (e.g. "Exponential").
2. **APIs & Services → Library** → enable **Google Calendar API**.
3. **APIs & Services → OAuth consent screen** → Internal (if you're on Google Workspace)
   or External, fill in the app name, add the scopes `openid`, `email`, `profile`,
   `…/auth/calendar.readonly`.
4. **APIs & Services → Credentials → Create credentials → OAuth client ID**,
   application type **Desktop app**. Copy the client ID and client secret.
5. In Exponential click **Sign in** (bottom-left), paste both, and sign in.
   Your browser opens, you approve, and the app picks it up.

Everyone on the team uses the same client ID/secret; each person signs in with
their own Google account. Teammates' calendars show up when they have shared
their calendar with you (inside one Workspace this is usually on by default
for free/busy or full details).

Credentials and tokens are stored in the app's user-data folder
(`~/Library/Application Support/Exponential/` on macOS, `%APPDATA%\Exponential\` on Windows).

## Where planning data lives

`exponential-data.json` in the same user-data folder. The first launch seeds a
few example projects, deadlines and tasks. Sharing this between teammates is the
next step (see below).

## Interactions

| Where | Action |
| --- | --- |
| Master plan | Pinch (or ⌘/Ctrl + scroll) to zoom, scroll or drag empty space to pan |
| Master plan | Drag the blue week band to choose the week shown below |
| Master plan | Drag a project to move it (left/right = dates, up/down = row); drag either end to stretch it |
| Master plan | Click a project or deadline star to open its details on the right; drag a star to move a deadline |
| Master plan | Hover empty space to see a ghost bar; click to create a one-week project and type its name |
| Divider | Drag the handle between the panels to rebalance them |
| Week | Pick a teammate at the top right; only your own tasks are editable |
| Week | Click a task's status dot: to do / in progress / needs review / completed / cancelled |
| Week | Drag a task's block to another day, or drag either end to stretch it over several days |
| Week | Hover the empty area under the tasks and click a day to create a task and type its name |
| Week | Swipe sideways on the trackpad to go to the previous/next week (the master plan band follows) |
| Week | **Calendar** toggle shows Google Calendar events for the selected person |
| Details | Edit title, dates, colour/status; notes support headings, bullets, checkboxes and images (paste or drop) |

## Not done yet

- Shared data between teammates (today each machine keeps its own file).
- A Team page for inviting people.
