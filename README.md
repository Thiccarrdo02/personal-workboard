# My Workboard

A tiny personal task manager that runs locally in your browser. No account, no cloud database, no dependencies.

## Easiest start

### Mac
Double-click `START-MAC.command`.

If macOS blocks it the first time, right-click it and choose **Open**.

### Windows
Double-click `START-WINDOWS.bat`.

### Any computer with Python 3
Open Terminal / Command Prompt in this folder and run:

```bash
python3 server.py
```

The app opens automatically in your browser. It normally uses `http://127.0.0.1:8000` and will try the next free port if 8000 is already busy.

## What’s in this version

- All categories are visible on one dashboard.
- Cleaner visual separation with stronger card structure, dividers, spacing, and task row grouping.
- Click a category title to rename it.
- Click task text to edit it. Press Enter or click elsewhere to save.
- Click the status button to cycle: `NTS` → `WIP` → `DONE`.
- Click the `!` button to mark or unmark a task as **urgent**.
- Urgent tasks are highlighted with a subtle red treatment so they stand out immediately.
- Each category shows small summary pills for To Start, In Progress, Done, and Urgent.
- Categories automatically get an internal scrollbar when task lists grow longer.
- Add tasks with the input at the bottom of each category.
- Delete tasks or categories with the `×` control.
- Search across all work.
- Hide completed work when you want a cleaner active view.
- Add a new category with **+ Category**.
- Press `/` to jump straight to search.
- Use **Backup** to export/import a JSON backup.

## Storage

Changes save automatically to your browser's `localStorage` on this computer/browser. If browser data is cleared, the saved board can be lost, so use **Backup → Export backup** occasionally.
