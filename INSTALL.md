# Installing Meet Assistant

There are two parts. The browser extension shows a side panel with the
transcript and answers. The optional overlay app shows answers in a
see-through window in the middle of your screen.

You need your own **OpenAI API key** (https://platform.openai.com/api-keys).

## 1. The extension (Chrome, Brave, Edge or Chromium)

1. Unzip `meet-assistant.zip` somewhere permanent, e.g. `~/meet-assistant`.
   Don't delete the folder later, because the browser loads the extension from it.
2. Open `chrome://extensions` (in Brave: `brave://extensions`).
3. Turn on **Developer mode** (top right).
4. Click **Load unpacked** and choose the `meet-assistant/extension` folder.
5. Pin the extension and click its icon to open the side panel.
6. In **Settings**, paste your OpenAI API key and click **Save**.
7. Tick the consent box, then click **Start assistant**. The first time, a tab
   opens to ask for microphone access. Click **Allow**.

The extension ID should show as `dglakmhgmicankdjhkigdbkdlbfigeea`.

## 2. The overlay app (optional)

Needs Node.js 18 or newer (https://nodejs.org). Run `node -v` to check.

### Windows

1. Open the `meet-assistant\overlay` folder in File Explorer.
2. Double-click **`install-host.cmd`**. It installs the app's packages and
   lets the extension start the overlay. Wait until it says **Done**, then
   press a key to close it.
   (Or from PowerShell: `cd meet-assistant\overlay; .\install-host.cmd`.
   Don't run `install-host.sh`, which is the Linux version.)
3. **Quit the browser completely and reopen it.** Closing the window isn't
   enough: Chrome and Brave keep running in the system tray, so right-click
   the tray icon and choose Exit, or end it in Task Manager.
4. Click **Overlay: OFF** in the side panel to turn it on.

If you move the folder later, run `install-host.cmd` again.

### Linux

```bash
cd ~/meet-assistant/overlay
./install-host.sh
```

Then quit the browser completely, reopen it, and click **Overlay: OFF**.
If the overlay doesn't appear and `overlay/overlay.log` says *"SUID sandbox
helper binary … not configured correctly"*, run:

```bash
sudo chown root:root node_modules/electron/dist/chrome-sandbox
sudo chmod 4755 node_modules/electron/dist/chrome-sandbox
```

### Starting it by hand

If the button doesn't work, you can always start the overlay yourself:

```bash
cd meet-assistant/overlay
npm install             # first time only
npm start               # Windows / macOS
npm run start:wayland   # Linux
```

If something goes wrong, look at `overlay/overlay.log`.

### Listen mode (optional)

The overlay can also listen to your microphone by itself, without the
extension. Copy `overlay/.env.example` to `overlay/.env` and put your API key
in it. Then press `Ctrl+Shift+L` or use the tray icon.

## Keyboard shortcuts (overlay)

| Shortcut | Action |
|---|---|
| `Ctrl+Shift+L` | Start / stop listen mode |
| `Ctrl+Shift+A` | Answer the last thing heard |
| `Ctrl+Shift+H` | Hide / show the overlay |
| `Ctrl+Shift+M` | Move the overlay |
| `Ctrl+Shift+Up/Down` | Scroll a long answer |

## Privacy note

On Linux, the overlay and side panel **are visible when you share your entire
screen**. Share a single tab or window instead.
