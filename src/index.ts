import { ChildProcess, spawn } from "child_process"
import { Context, MRUData, Plugin, PluginInitParams, PublicAPI, Query, Result, ResultAction } from "@wox-launcher/wox-plugin"
import { AwakeRequest, AwakeSession, buildLaunchPlan, detectPlatform, formatCountdown, formatTime, parseDurationInput, resolveBackend } from "./awake"

const STATUS_RESULT_ID = "awake-status"
const MRU_STATUS_RESULT_ID = "awake-mru-status"
const MRU_KIND_CONTEXT_KEY = "kind"
const MRU_STATUS_CONTEXT_VALUE = "status"
const ACTIVE_ICON = {
  ImageType: "relative" as const,
  ImageData: "images/app.svg"
}
const IDLE_ICON = {
  ImageType: "relative" as const,
  ImageData: "images/light_off.svg"
}

let api: PublicAPI
let apiContext: Context | null = null
let awakeProcess: ChildProcess | null = null
let awakeSession: AwakeSession | null = null
let awakeRunId = 0
let countdownTimer: NodeJS.Timeout | null = null
let currentSettings = {
  keepDisplayAwake: false
}

function currentIcon(): typeof ACTIVE_ICON {
  return awakeSession === null ? IDLE_ICON : ACTIVE_ICON
}

function buildStatusMRUContext(): Record<string, string> {
  return {
    [MRU_KIND_CONTEXT_KEY]: MRU_STATUS_CONTEXT_VALUE
  }
}

function isStatusMRUContext(contextData: Record<string, string> | undefined): boolean {
  return contextData?.[MRU_KIND_CONTEXT_KEY] === MRU_STATUS_CONTEXT_VALUE
}

function boolFromSetting(value: string, defaultValue: boolean): boolean {
  const normalized = value.trim().toLowerCase()
  if (!normalized) {
    return defaultValue
  }

  return normalized === "true" || normalized === "1" || normalized === "yes" || normalized === "on"
}

async function getKeepDisplayAwake(ctx: Context): Promise<boolean> {
  const raw = await api.GetSetting(ctx, "keepDisplayAwake")
  return boolFromSetting(raw, false)
}

async function t(ctx: Context, key: string, vars: Record<string, string> = {}): Promise<string> {
  let raw = key
  try {
    raw = await api.GetTranslation(ctx, key)
  } catch {
    raw = key
  }

  let result = raw
  for (const name in vars) {
    if (Object.prototype.hasOwnProperty.call(vars, name)) {
      result = result.replace(new RegExp(`\\{${name}\\}`, "g"), vars[name])
    }
  }

  return result
}

async function formatLocalizedDuration(ctx: Context, durationMs: number): Promise<string> {
  const totalMinutes = Math.max(1, Math.round(durationMs / (60 * 1000)))
  const days = Math.floor(totalMinutes / (24 * 60))
  const hours = Math.floor((totalMinutes % (24 * 60)) / 60)
  const minutes = totalMinutes % 60
  const parts: string[] = []

  if (days > 0) {
    parts.push(await t(ctx, days === 1 ? "duration_day_one" : "duration_day_other", { count: String(days) }))
  }

  if (hours > 0) {
    parts.push(await t(ctx, hours === 1 ? "duration_hour_one" : "duration_hour_other", { count: String(hours) }))
  }

  if (minutes > 0 && days === 0) {
    parts.push(await t(ctx, minutes === 1 ? "duration_minute_one" : "duration_minute_other", { count: String(minutes) }))
  }

  if (parts.length === 0) {
    return t(ctx, "duration_minute_one", { count: "1" })
  }

  return parts.join(await t(ctx, "duration_joiner"))
}

async function backendUnavailableMessage(ctx: Context): Promise<string> {
  const platform = detectPlatform()
  if (platform === "darwin") {
    return t(ctx, "backend_unavailable_darwin")
  }
  if (platform === "windows") {
    return t(ctx, "backend_unavailable_windows")
  }
  return t(ctx, "backend_unavailable_linux")
}

async function safeLog(ctx: Context, level: "Info" | "Error" | "Debug" | "Warning", message: string): Promise<void> {
  try {
    await api.Log(ctx, level, message)
  } catch {
    // Ignore logging failures to keep the plugin responsive.
  }
}

function stopCountdownTimer(): void {
  if (countdownTimer !== null) {
    clearInterval(countdownTimer)
    countdownTimer = null
  }
}

async function buildStatusTails(ctx: Context, session: AwakeSession | null, now: number = Date.now()): Promise<Result["Tails"]> {
  if (session === null) {
    return [{ Type: "text", Text: await t(ctx, "status_idle_short") }]
  }

  if (session.endsAt === null) {
    return [
      { Type: "text", Text: await t(ctx, "status_active_short") },
      { Type: "text", Text: await t(ctx, "until_stopped_short") }
    ]
  }

  return [
    { Type: "text", Text: await t(ctx, "status_active_short") },
    { Type: "text", Text: formatCountdown(session.endsAt, now) }
  ]
}

async function formatSessionSummary(ctx: Context, session: AwakeSession): Promise<string> {
  const displayText = session.keepDisplayAwake && session.supportsDisplayAwake ? await t(ctx, "display_awake") : await t(ctx, "display_may_sleep")

  if (session.endsAt === null) {
    return t(ctx, "session_summary_indefinite", {
      startedAt: formatTime(session.startedAt),
      display: displayText
    })
  }

  return t(ctx, "session_summary_timed", {
    endsAt: formatTime(session.endsAt),
    display: displayText
  })
}

function createAction(name: string, handler: (ctx: Context) => Promise<void>, isDefault: boolean = false, contextData?: Record<string, string>): ResultAction {
  return {
    Name: name,
    IsDefault: isDefault,
    PreventHideAfterAction: true,
    ContextData: contextData,
    Action: async (ctx: Context) => {
      await handler(ctx)
    }
  }
}

async function cleanupAwakeProcess(ctx: Context): Promise<boolean> {
  if (awakeProcess === null) {
    return false
  }

  const currentProcess = awakeProcess
  awakeRunId += 1
  awakeProcess = null
  awakeSession = null
  stopCountdownTimer()

  if (!currentProcess.killed) {
    currentProcess.kill()
  }

  await safeLog(ctx, "Info", "Stopped awake session")
  return true
}

async function startAwakeSession(ctx: Context, request: AwakeRequest): Promise<AwakeSession> {
  const platform = detectPlatform()
  const plan = buildLaunchPlan(platform, request, process.pid)

  await cleanupAwakeProcess(ctx)

  const child = spawn(plan.command, plan.args, {
    stdio: "ignore",
    windowsHide: true
  })

  const runId = awakeRunId + 1
  awakeRunId = runId
  awakeProcess = child

  const startedAt = Date.now()
  awakeSession = {
    backend: plan.backend,
    platform,
    startedAt,
    endsAt: request.durationMs === null ? null : startedAt + request.durationMs,
    keepDisplayAwake: request.keepDisplayAwake,
    supportsDisplayAwake: plan.supportsDisplayAwake
  }

  child.once("error", async error => {
    if (awakeRunId !== runId) {
      return
    }
    awakeProcess = null
    awakeSession = null
    stopCountdownTimer()
    await safeLog(ctx, "Error", `Failed to start awake session: ${error.message}`)
  })

  child.once("exit", async (code, signal) => {
    if (awakeRunId !== runId) {
      return
    }
    awakeProcess = null
    awakeSession = null
    stopCountdownTimer()
    await safeLog(ctx, "Info", `Awake session exited with code=${String(code)} signal=${String(signal)}`)
    if (apiContext !== null) {
      await pushStatusUpdate(apiContext)
    }
  })

  await safeLog(ctx, "Info", `Started awake session with backend ${plan.backend}`)
  return awakeSession
}

async function buildStatusResult(ctx: Context, backend = resolveBackend(detectPlatform()), resultId: string = STATUS_RESULT_ID): Promise<Result> {
  const unavailable = awakeSession === null && !backend.available
  const actions: ResultAction[] = []
  const statusMRUContext = buildStatusMRUContext()

  if (!unavailable) {
    if (awakeSession === null) {
      actions.push(
        createAction(
          await t(ctx, "action_start"),
          async innerCtx => {
            await runStart(innerCtx, {
              durationMs: null,
              keepDisplayAwake: currentSettings.keepDisplayAwake
            })
          },
          true,
          statusMRUContext
        )
      )
      actions.push(
        createAction(
          await t(ctx, "action_start_indefinitely"),
          async innerCtx => {
            await runStart(innerCtx, {
              durationMs: null,
              keepDisplayAwake: currentSettings.keepDisplayAwake
            })
          },
          false,
          statusMRUContext
        )
      )
    } else {
      actions.push(createAction(await t(ctx, "action_stop"), runStop, true, statusMRUContext))
      actions.push(
        createAction(
          await t(ctx, "action_restart"),
          async innerCtx => {
            await runStart(innerCtx, {
              durationMs: null,
              keepDisplayAwake: currentSettings.keepDisplayAwake
            })
          },
          false,
          statusMRUContext
        )
      )
    }
  }

  return {
    Id: resultId,
    Title: awakeSession === null ? await t(ctx, "title_idle") : await t(ctx, "title_active"),
    SubTitle: unavailable ? await backendUnavailableMessage(ctx) : awakeSession === null ? await t(ctx, "subtitle_idle") : await formatSessionSummary(ctx, awakeSession),
    Icon: currentIcon(),
    Tails: unavailable ? [{ Type: "text", Text: await t(ctx, "status_unavailable_short") }] : await buildStatusTails(ctx, awakeSession),
    Actions: actions
  }
}

async function pushStatusUpdate(ctx: Context): Promise<void> {
  const statusResult = await buildStatusResult(ctx)
  await api.UpdateResult(ctx, {
    Id: STATUS_RESULT_ID,
    Title: statusResult.Title,
    SubTitle: statusResult.SubTitle,
    Icon: statusResult.Icon,
    Tails: statusResult.Tails,
    Actions: statusResult.Actions
  })
}

function restartCountdownTimer(): void {
  stopCountdownTimer()
  if (awakeSession === null || awakeSession.endsAt === null || apiContext === null) {
    return
  }

  countdownTimer = setInterval(() => {
    if (apiContext !== null) {
      void pushStatusUpdate(apiContext)
    }
  }, 1000)
}

async function runStart(ctx: Context, request: AwakeRequest): Promise<void> {
  const backend = resolveBackend(detectPlatform())
  if (!backend.available) {
    await api.Notify(ctx, await backendUnavailableMessage(ctx))
    return
  }

  try {
    const session = await startAwakeSession(ctx, request)
    restartCountdownTimer()

    const durationText = session.endsAt === null ? await t(ctx, "until_you_stop_it") : await formatLocalizedDuration(ctx, session.endsAt - session.startedAt)
    let notification = await t(ctx, "notify_started", { duration: durationText })
    if (request.keepDisplayAwake && !session.supportsDisplayAwake) {
      notification = `${notification} ${await t(ctx, "notify_display_not_supported")}`
    }

    await api.Notify(ctx, notification)
    await pushStatusUpdate(ctx)
  } catch (error) {
    const message = error instanceof Error ? error.message : await t(ctx, "notify_unable_to_start")
    await safeLog(ctx, "Error", message)
    await api.Notify(ctx, message)
  }
}

async function runStop(ctx: Context): Promise<void> {
  const stopped = await cleanupAwakeProcess(ctx)
  await api.Notify(ctx, stopped ? await t(ctx, "notify_stopped") : await t(ctx, "notify_already_idle"))
  await pushStatusUpdate(ctx)
}

async function runToggle(ctx: Context, keepDisplayAwake: boolean): Promise<void> {
  if (awakeSession !== null) {
    await runStop(ctx)
    return
  }

  await runStart(ctx, {
    durationMs: null,
    keepDisplayAwake
  })
}

async function buildStartResult(ctx: Context, durationMs: number | null, keepDisplayAwake: boolean, resultId: string = STATUS_RESULT_ID): Promise<Result> {
  const title = durationMs === null ? await t(ctx, "start_until_stopped_title") : await t(ctx, "start_for_duration_title", { duration: await formatLocalizedDuration(ctx, durationMs) })
  const subTitle = awakeSession === null ? await t(ctx, "start_new_subtitle") : await t(ctx, "start_replace_subtitle")

  return {
    Id: resultId,
    Title: title,
    SubTitle: subTitle,
    Icon: currentIcon(),
    Actions: [
      createAction(
        await t(ctx, "action_start"),
        async innerCtx => {
          await runStart(innerCtx, {
            durationMs,
            keepDisplayAwake
          })
        },
        true
      )
    ]
  }
}

async function buildStopResult(ctx: Context, resultId: string = STATUS_RESULT_ID): Promise<Result> {
  return {
    Id: resultId,
    Title: await t(ctx, "stop_title"),
    SubTitle: await t(ctx, "stop_subtitle"),
    Icon: currentIcon(),
    Actions: [createAction(await t(ctx, "action_stop"), runStop, true)]
  }
}

async function buildToggleResult(ctx: Context, keepDisplayAwake: boolean, resultId: string = STATUS_RESULT_ID): Promise<Result> {
  return {
    Id: resultId,
    Title: awakeSession === null ? await t(ctx, "toggle_start_title") : await t(ctx, "toggle_stop_title"),
    SubTitle: awakeSession === null ? await t(ctx, "toggle_start_subtitle") : await t(ctx, "toggle_stop_subtitle"),
    Icon: currentIcon(),
    Actions: [
      createAction(
        await t(ctx, "action_toggle"),
        async innerCtx => {
          await runToggle(innerCtx, keepDisplayAwake)
        },
        true
      )
    ]
  }
}

async function restoreMRUResult(ctx: Context, mruData: MRUData): Promise<Result | null> {
  if (!isStatusMRUContext(mruData.ContextData)) {
    return null
  }

  currentSettings = {
    keepDisplayAwake: await getKeepDisplayAwake(ctx)
  }
  return buildStatusResult(ctx, resolveBackend(detectPlatform()), MRU_STATUS_RESULT_ID)
}

async function buildResults(ctx: Context, query: Query): Promise<Result[]> {
  currentSettings = {
    keepDisplayAwake: await getKeepDisplayAwake(ctx)
  }

  restartCountdownTimer()

  const command = (query.Command || "").trim().toLowerCase()
  const search = query.Search.trim().toLowerCase()
  const parsedDuration = parseDurationInput(search)
  const backend = resolveBackend(detectPlatform())

  if (!search && !command) {
    return [await buildStatusResult(ctx, backend)]
  }

  if (command === "off" || command === "stop" || search === "off" || search === "stop") {
    return [await buildStopResult(ctx)]
  }

  if (command === "toggle" || search === "toggle") {
    return [await buildToggleResult(ctx, currentSettings.keepDisplayAwake)]
  }

  if (command === "on") {
    return [await buildStartResult(ctx, parsedDuration === null ? null : parsedDuration.durationMs, currentSettings.keepDisplayAwake)]
  }

  if (parsedDuration !== null) {
    return [await buildStartResult(ctx, parsedDuration.durationMs, currentSettings.keepDisplayAwake)]
  }

  return [await buildStatusResult(ctx, backend)]
}

export const plugin: Plugin = {
  init: async (ctx: Context, initParams: PluginInitParams) => {
    api = initParams.API
    apiContext = ctx
    await api.OnUnload(ctx, async unloadCtx => {
      await cleanupAwakeProcess(unloadCtx)
    })
    await api.OnMRURestore(ctx, async (restoreCtx, mruData) => {
      return restoreMRUResult(restoreCtx, mruData)
    })
    await safeLog(ctx, "Info", "Awake plugin initialized")
  },

  query: async (ctx: Context, query: Query): Promise<Result[]> => {
    return buildResults(ctx, query)
  }
}
