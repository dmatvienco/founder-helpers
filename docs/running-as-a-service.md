# Running the daemon as a service

`fh daemon` runs in the foreground. Pick your supervisor:

## pm2 (any OS, simplest)

```bash
npm i -g pm2
pm2 start fh -- daemon --name my-team
pm2 save && pm2 startup   # follow its instructions for boot persistence
```

## tmux / screen (any OS, zero setup)

```bash
tmux new -s team 'fh daemon'
```

## systemd user unit (Linux)

`~/.config/systemd/user/founder-helpers.service`:

```ini
[Unit]
Description=founder-helpers daemon
After=network-online.target

[Service]
WorkingDirectory=/path/to/your/project
ExecStart=/usr/bin/env fh daemon
Restart=on-failure
RestartSec=15

[Install]
WantedBy=default.target
```

```bash
systemctl --user enable --now founder-helpers
loginctl enable-linger $USER   # keep it alive without an open session
```

## launchd (macOS)

`~/Library/LaunchAgents/dev.founder-helpers.plist` with
`ProgramArguments = [fh, daemon]`, `WorkingDirectory = <project>`,
`RunAtLoad = true`, `KeepAlive = true`, then
`launchctl load -w ~/Library/LaunchAgents/dev.founder-helpers.plist`.

## Task Scheduler (Windows)

```powershell
schtasks /Create /TN "founder-helpers" /SC ONLOGON /TR `
  "powershell -WindowStyle Hidden -Command `"cd C:\path\to\project; fh daemon`""
```

Add a second hourly trigger with "do not start a new instance" as a watchdog.

Notes: one daemon per project (the lockfile enforces it); the daemon exits
cleanly on SIGTERM/Ctrl+C; logs rotate in the state dir (`fh logs -f`).
