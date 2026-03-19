import { spawnSync } from "child_process"
import { Platform } from "@wox-launcher/wox-plugin"

export type AwakeBackend = "caffeinate" | "systemd-inhibit" | "powershell"

export interface ParsedDuration {
  durationMs: number
  label: string
}

export interface AwakeRequest {
  durationMs: number | null
  keepDisplayAwake: boolean
}

export interface BackendResolution {
  available: boolean
  backend?: AwakeBackend
  command?: string
  reason?: string
  supportsDisplayAwake: boolean
}

export interface LaunchPlan {
  backend: AwakeBackend
  command: string
  args: string[]
  supportsDisplayAwake: boolean
}

export interface AwakeSession {
  backend: AwakeBackend
  platform: Platform
  startedAt: number
  endsAt: number | null
  keepDisplayAwake: boolean
  supportsDisplayAwake: boolean
}

const MINUTE_MS = 60 * 1000
const HOUR_MS = 60 * MINUTE_MS
const DAY_MS = 24 * HOUR_MS

export function detectPlatform(nodePlatform: string = process.platform): Platform {
  if (nodePlatform === "win32") {
    return "windows"
  }

  if (nodePlatform === "darwin") {
    return "darwin"
  }

  return "linux"
}

export function commandExists(command: string, nodePlatform: string = process.platform): boolean {
  const checker = nodePlatform === "win32" ? "where" : "which"
  const result = spawnSync(checker, [command], { stdio: "ignore" })
  return result.status === 0
}

export function resolveBackend(platform: Platform, nodePlatform: string = process.platform): BackendResolution {
  if (platform === "darwin") {
    if (!commandExists("caffeinate", nodePlatform)) {
      return {
        available: false,
        reason: "caffeinate is not available on this macOS system.",
        supportsDisplayAwake: true
      }
    }

    return {
      available: true,
      backend: "caffeinate",
      command: "caffeinate",
      supportsDisplayAwake: true
    }
  }

  if (platform === "windows") {
    if (commandExists("powershell.exe", nodePlatform)) {
      return {
        available: true,
        backend: "powershell",
        command: "powershell.exe",
        supportsDisplayAwake: true
      }
    }

    if (commandExists("pwsh.exe", nodePlatform)) {
      return {
        available: true,
        backend: "powershell",
        command: "pwsh.exe",
        supportsDisplayAwake: true
      }
    }

    return {
      available: false,
      reason: "PowerShell is required on Windows to keep the system awake.",
      supportsDisplayAwake: true
    }
  }

  if (!commandExists("systemd-inhibit", nodePlatform)) {
    return {
      available: false,
      reason: "systemd-inhibit is required on Linux to block suspend and idle sleep.",
      supportsDisplayAwake: false
    }
  }

  return {
    available: true,
    backend: "systemd-inhibit",
    command: "systemd-inhibit",
    supportsDisplayAwake: false
  }
}

export function buildLaunchPlan(platform: Platform, request: AwakeRequest, parentPid: number, resolvedBackend?: BackendResolution): LaunchPlan {
  const backend = resolvedBackend || resolveBackend(platform)
  if (!backend.available || !backend.backend || !backend.command) {
    throw new Error(backend.reason || "No supported awake backend is available.")
  }

  const durationSeconds = request.durationMs === null ? 0 : Math.max(1, Math.ceil(request.durationMs / 1000))
  const normalizedParentPid = Math.max(0, Math.trunc(parentPid))

  if (backend.backend === "caffeinate") {
    const args = ["-i", "-w", String(parentPid)]
    if (request.keepDisplayAwake) {
      args.splice(1, 0, "-d")
    }
    if (durationSeconds > 0) {
      args.splice(args.length - 2, 0, "-t", String(durationSeconds))
    }
    return {
      backend: backend.backend,
      command: backend.command,
      args,
      supportsDisplayAwake: backend.supportsDisplayAwake
    }
  }

  if (backend.backend === "powershell") {
    const script = [
      `$parentPid = ${normalizedParentPid}`,
      `$durationSeconds = ${durationSeconds}`,
      `$keepDisplay = ${request.keepDisplayAwake ? "$true" : "$false"}`,
      "Add-Type -TypeDefinition 'using System; using System.Runtime.InteropServices; public static class AwakeNative { [DllImport(\"kernel32.dll\", SetLastError=true)] public static extern uint SetThreadExecutionState(uint esFlags); }'",
      "$ES_CONTINUOUS = [uint32]2147483648",
      "$ES_SYSTEM_REQUIRED = [uint32]1",
      "$ES_DISPLAY_REQUIRED = [uint32]2",
      "$flags = $ES_CONTINUOUS -bor $ES_SYSTEM_REQUIRED",
      "if ($keepDisplay) { $flags = $flags -bor $ES_DISPLAY_REQUIRED }",
      "$startedAt = Get-Date",
      "try {",
      "  while ($true) {",
      "    if (-not (Get-Process -Id $parentPid -ErrorAction SilentlyContinue)) { break }",
      "    if ($durationSeconds -gt 0 -and ((Get-Date) -ge $startedAt.AddSeconds($durationSeconds))) { break }",
      "    [AwakeNative]::SetThreadExecutionState($flags) | Out-Null",
      "    Start-Sleep -Seconds 15",
      "  }",
      "} finally {",
      "  [AwakeNative]::SetThreadExecutionState($ES_CONTINUOUS) | Out-Null",
      "}"
    ].join("; ")

    return {
      backend: backend.backend,
      command: backend.command,
      args: ["-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass", "-Command", script],
      supportsDisplayAwake: backend.supportsDisplayAwake
    }
  }

  const script = [
    'parent_pid="$1"',
    'duration_seconds="$2"',
    "started_at=$(date +%s)",
    'while kill -0 "$parent_pid" 2>/dev/null; do',
    '  if [ "$duration_seconds" -gt 0 ]; then',
    "    now=$(date +%s)",
    '    if [ $((now - started_at)) -ge "$duration_seconds" ]; then',
    "      exit 0",
    "    fi",
    "  fi",
    "  sleep 15",
    "done"
  ].join("; ")

  return {
    backend: backend.backend,
    command: backend.command,
    args: ["--why", "Keep system awake from Wox.Plugin.Awake", "--mode", "block", "--what", "idle:sleep", "sh", "-c", script, "sh", String(parentPid), String(durationSeconds)],
    supportsDisplayAwake: backend.supportsDisplayAwake
  }
}

export function parseDurationInput(input: string): ParsedDuration | null {
  const normalized = input.trim().toLowerCase()
  if (!normalized) {
    return null
  }

  const match = normalized.match(/^(\d+(?:\.\d+)?)\s*(m|min|mins|minute|minutes|h|hr|hrs|hour|hours|d|day|days)?$/)
  if (!match) {
    return null
  }

  const value = Number(match[1])
  if (!Number.isFinite(value) || value <= 0) {
    return null
  }

  const unit = match[2] || "m"
  let durationMs = value * MINUTE_MS

  if (unit === "h" || unit === "hr" || unit === "hrs" || unit === "hour" || unit === "hours") {
    durationMs = value * HOUR_MS
  } else if (unit === "d" || unit === "day" || unit === "days") {
    durationMs = value * DAY_MS
  }

  const roundedMs = Math.round(durationMs)
  return {
    durationMs: roundedMs,
    label: formatDuration(roundedMs)
  }
}

export function durationFromMinutes(minutes: number): number | null {
  if (!Number.isFinite(minutes) || minutes <= 0) {
    return null
  }

  return Math.round(minutes * MINUTE_MS)
}

export function formatDuration(durationMs: number): string {
  const totalMinutes = Math.max(1, Math.round(durationMs / MINUTE_MS))
  const days = Math.floor(totalMinutes / (24 * 60))
  const hours = Math.floor((totalMinutes % (24 * 60)) / 60)
  const minutes = totalMinutes % 60
  const parts: string[] = []

  if (days > 0) {
    parts.push(days === 1 ? "1 day" : `${days} days`)
  }
  if (hours > 0) {
    parts.push(hours === 1 ? "1 hour" : `${hours} hours`)
  }
  if (minutes > 0 && days === 0) {
    parts.push(minutes === 1 ? "1 minute" : `${minutes} minutes`)
  }

  if (parts.length === 0) {
    return "1 minute"
  }

  return parts.join(" ")
}

export function formatTime(timestamp: number): string {
  return new Date(timestamp).toLocaleTimeString([], {
    hour: "2-digit",
    minute: "2-digit"
  })
}

export function formatRemaining(endsAt: number, now: number = Date.now()): string {
  const remainingMs = Math.max(0, endsAt - now)
  if (remainingMs === 0) {
    return "less than a minute left"
  }

  return `${formatDuration(remainingMs)} left`
}

export function formatCountdown(endsAt: number, now: number = Date.now()): string {
  const totalSeconds = Math.max(0, Math.ceil((endsAt - now) / 1000))
  const hours = Math.floor(totalSeconds / 3600)
  const minutes = Math.floor((totalSeconds % 3600) / 60)
  const seconds = totalSeconds % 60

  const hoursText = String(hours).padStart(2, "0")
  const minutesText = String(minutes).padStart(2, "0")
  const secondsText = String(seconds).padStart(2, "0")

  return `${hoursText}:${minutesText}:${secondsText}`
}

export function describeBackend(backend: AwakeBackend): string {
  if (backend === "caffeinate") {
    return "caffeinate"
  }
  if (backend === "systemd-inhibit") {
    return "systemd-inhibit"
  }
  return "PowerShell"
}
