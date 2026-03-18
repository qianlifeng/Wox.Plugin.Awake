# Awake

Cross-platform Wox plugin to keep your computer awake and block idle sleep.

# Install

```
wpm install Awake
```

# Usage

```
awake
awake 30m
awake on 2h
awake off
awake status
```

`awake` shows the current status plus quick actions for common durations. By default it starts a 2 hour session unless you change the setting.

# Platform backends

- macOS: `caffeinate`
- Windows: PowerShell + `SetThreadExecutionState`
- Linux: `systemd-inhibit`
