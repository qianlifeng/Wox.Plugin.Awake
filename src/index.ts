import { ChildProcess, spawn } from "child_process"
import { randomUUID } from "crypto"
import { ActionContext, Context, Plugin, PluginInitParams, PublicAPI, Query, Result, ResultAction } from "@wox-launcher/wox-plugin"
import { AwakeRequest, AwakeSession, buildLaunchPlan, detectPlatform, formatCountdown, formatTime, parseDurationInput, resolveBackend } from "./awake"

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
let currentStatusResultId: string | null = null
let currentSettings = {
  keepDisplayAwake: false
}

function currentIcon(): typeof ACTIVE_ICON {
  return awakeSession === null ? IDLE_ICON : ACTIVE_ICON
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

async function updateResult(ctx: Context, resultId: string): Promise<void> {
  const currentResult = await api.GetUpdatableResult(ctx, resultId)
  if (currentResult === null) {
    return
  }

  const statusResult = await buildStatusResult(ctx, resolveBackend(detectPlatform()), resultId)
  await api.UpdateResult(ctx, {
    Id: resultId,
    Title: statusResult.Title,
    SubTitle: statusResult.SubTitle,
    Icon: statusResult.Icon,
    Tails: statusResult.Tails,
    Actions: statusResult.Actions
  })
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
    if (apiContext !== null && currentStatusResultId !== null) {
      await updateResult(apiContext, currentStatusResultId)
    }
  })

  await safeLog(ctx, "Info", `Started awake session with backend ${plan.backend}`)
  return awakeSession
}

async function buildStatusResult(ctx: Context, backend = resolveBackend(detectPlatform()), resultId: string): Promise<Result> {
  currentStatusResultId = resultId
  const unavailable = awakeSession === null && !backend.available
  const actions: ResultAction[] = []
  const statusMRUContext = {
    [MRU_KIND_CONTEXT_KEY]: MRU_STATUS_CONTEXT_VALUE
  }

  if (!unavailable) {
    if (awakeSession === null) {
      actions.push({
        Name: await t(ctx, "action_start"),
        IsDefault: true,
        PreventHideAfterAction: true,
        ContextData: statusMRUContext,
        Action: async (innerCtx: Context, actionContext: ActionContext) => {
          await runStart(
            innerCtx,
            {
              durationMs: null,
              keepDisplayAwake: currentSettings.keepDisplayAwake
            },
            actionContext.ResultId
          )
        }
      })
      actions.push({
        Name: await t(ctx, "action_start_indefinitely"),
        PreventHideAfterAction: true,
        ContextData: statusMRUContext,
        Action: async (innerCtx: Context, actionContext: ActionContext) => {
          await runStart(
            innerCtx,
            {
              durationMs: null,
              keepDisplayAwake: currentSettings.keepDisplayAwake
            },
            actionContext.ResultId
          )
        }
      })
    } else {
      actions.push({
        Name: await t(ctx, "action_stop"),
        IsDefault: true,
        PreventHideAfterAction: true,
        ContextData: statusMRUContext,
        Action: async (innerCtx: Context, actionContext: ActionContext) => {
          await runStop(innerCtx, actionContext.ResultId)
        }
      })
      actions.push({
        Name: await t(ctx, "action_restart"),
        PreventHideAfterAction: true,
        ContextData: statusMRUContext,
        Action: async (innerCtx: Context, actionContext: ActionContext) => {
          await runStart(
            innerCtx,
            {
              durationMs: null,
              keepDisplayAwake: currentSettings.keepDisplayAwake
            },
            actionContext.ResultId
          )
        }
      })
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

function restartCountdownTimer(): void {
  stopCountdownTimer()
  if (awakeSession === null || awakeSession.endsAt === null || apiContext === null || currentStatusResultId === null) {
    return
  }

  countdownTimer = setInterval(() => {
    if (apiContext !== null && currentStatusResultId !== null) {
      void updateResult(apiContext, currentStatusResultId)
    }
  }, 1000)
}

async function runStart(ctx: Context, request: AwakeRequest, resultId: string): Promise<void> {
  const backend = resolveBackend(detectPlatform())
  if (!backend.available) {
    await api.Notify(ctx, await backendUnavailableMessage(ctx))
    return
  }

  try {
    const session = await startAwakeSession(ctx, request)
    currentStatusResultId = resultId
    restartCountdownTimer()

    const durationText = session.endsAt === null ? await t(ctx, "until_you_stop_it") : await formatLocalizedDuration(ctx, session.endsAt - session.startedAt)
    let notification = await t(ctx, "notify_started", { duration: durationText })
    if (request.keepDisplayAwake && !session.supportsDisplayAwake) {
      notification = `${notification} ${await t(ctx, "notify_display_not_supported")}`
    }

    await api.Notify(ctx, notification)
    await updateResult(ctx, resultId)
  } catch (error) {
    const message = error instanceof Error ? error.message : await t(ctx, "notify_unable_to_start")
    await safeLog(ctx, "Error", message)
    await api.Notify(ctx, message)
  }
}

async function runStop(ctx: Context, resultId: string): Promise<void> {
  currentStatusResultId = resultId
  const stopped = await cleanupAwakeProcess(ctx)
  await api.Notify(ctx, stopped ? await t(ctx, "notify_stopped") : await t(ctx, "notify_already_idle"))
  await updateResult(ctx, resultId)
}

async function buildResults(ctx: Context, query: Query): Promise<Result[]> {
  currentSettings = {
    keepDisplayAwake: await getKeepDisplayAwake(ctx)
  }

  const command = (query.Command || "").trim().toLowerCase()
  const search = query.Search.trim().toLowerCase()
  const parsedDuration = parseDurationInput(search)
  const backend = resolveBackend(detectPlatform())
  const resultId = randomUUID()
  let result: Result

  if (!search && !command) {
    result = await buildStatusResult(ctx, backend, resultId)
  } else if (command === "off" || command === "stop" || search === "off" || search === "stop") {
    result = {
      Id: resultId,
      Title: await t(ctx, "stop_title"),
      SubTitle: await t(ctx, "stop_subtitle"),
      Icon: currentIcon(),
      Actions: [
        {
          Name: await t(ctx, "action_stop"),
          IsDefault: true,
          PreventHideAfterAction: true,
          Action: async (innerCtx: Context, actionContext: ActionContext) => {
            await runStop(innerCtx, actionContext.ResultId)
          }
        }
      ]
    }
  } else if (command === "toggle" || search === "toggle") {
    result = {
      Id: resultId,
      Title: awakeSession === null ? await t(ctx, "toggle_start_title") : await t(ctx, "toggle_stop_title"),
      SubTitle: awakeSession === null ? await t(ctx, "toggle_start_subtitle") : await t(ctx, "toggle_stop_subtitle"),
      Icon: currentIcon(),
      Actions: [
        {
          Name: await t(ctx, "action_toggle"),
          IsDefault: true,
          PreventHideAfterAction: true,
          Action: async (innerCtx: Context, actionContext: ActionContext) => {
            if (awakeSession !== null) {
              await runStop(innerCtx, actionContext.ResultId)
              return
            }

            await runStart(
              innerCtx,
              {
                durationMs: null,
                keepDisplayAwake: currentSettings.keepDisplayAwake
              },
              actionContext.ResultId
            )
          }
        }
      ]
    }
  } else if (command === "on") {
    const durationMs = parsedDuration === null ? null : parsedDuration.durationMs
    result = {
      Id: resultId,
      Title: durationMs === null ? await t(ctx, "start_until_stopped_title") : await t(ctx, "start_for_duration_title", { duration: await formatLocalizedDuration(ctx, durationMs) }),
      SubTitle: awakeSession === null ? await t(ctx, "start_new_subtitle") : await t(ctx, "start_replace_subtitle"),
      Icon: currentIcon(),
      Actions: [
        {
          Name: await t(ctx, "action_start"),
          IsDefault: true,
          PreventHideAfterAction: true,
          Action: async (innerCtx: Context, actionContext: ActionContext) => {
            await runStart(
              innerCtx,
              {
                durationMs,
                keepDisplayAwake: currentSettings.keepDisplayAwake
              },
              actionContext.ResultId
            )
          }
        }
      ]
    }
  } else if (parsedDuration !== null) {
    result = {
      Id: resultId,
      Title: await t(ctx, "start_for_duration_title", { duration: await formatLocalizedDuration(ctx, parsedDuration.durationMs) }),
      SubTitle: awakeSession === null ? await t(ctx, "start_new_subtitle") : await t(ctx, "start_replace_subtitle"),
      Icon: currentIcon(),
      Actions: [
        {
          Name: await t(ctx, "action_start"),
          IsDefault: true,
          PreventHideAfterAction: true,
          Action: async (innerCtx: Context, actionContext: ActionContext) => {
            await runStart(
              innerCtx,
              {
                durationMs: parsedDuration.durationMs,
                keepDisplayAwake: currentSettings.keepDisplayAwake
              },
              actionContext.ResultId
            )
          }
        }
      ]
    }
  } else {
    result = await buildStatusResult(ctx, backend, resultId)
  }

  restartCountdownTimer()
  return [result]
}

export const plugin: Plugin = {
  init: async (ctx: Context, initParams: PluginInitParams) => {
    api = initParams.API
    apiContext = ctx
    await api.OnUnload(ctx, async unloadCtx => {
      await cleanupAwakeProcess(unloadCtx)
    })
    await api.OnMRURestore(ctx, async (restoreCtx, mruData) => {
      if (!isStatusMRUContext(mruData.ContextData)) {
        return null
      }

      currentSettings = {
        keepDisplayAwake: await getKeepDisplayAwake(restoreCtx)
      }
      const resultId = randomUUID()
      const result = await buildStatusResult(restoreCtx, resolveBackend(detectPlatform()), resultId)
      restartCountdownTimer()
      return result
    })
    await safeLog(ctx, "Info", "Awake plugin initialized")
  },

  query: async (ctx: Context, query: Query): Promise<Result[]> => {
    return buildResults(ctx, query)
  }
}
