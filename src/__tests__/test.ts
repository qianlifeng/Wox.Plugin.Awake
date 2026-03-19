import { Context, PublicAPI, Query, WoxImage } from "@wox-launcher/wox-plugin"
import { buildLaunchPlan } from "../awake"
import { plugin } from "../index"

test("query returns status result", async () => {
  const ctx = {} as Context
  const query = {
    Id: "1",
    Env: { ActiveWindowTitle: "", ActiveWindowPid: 0, ActiveBrowserUrl: "", ActiveWindowIcon: {} as WoxImage },
    RawQuery: "awake",
    Selection: { Type: "text", Text: "", FilePaths: [] },
    Type: "input",
    Search: "",
    TriggerKeyword: "awake",
    Command: "",
    IsGlobalQuery(): boolean {
      return false
    }
  } as Query

  await plugin.init(ctx, {
    PluginDirectory: "",
    API: {
      GetSetting: async () => "false",
      GetTranslation: async (_: Context, key: string) => key,
      Log: (_: Context, level: "Info" | "Error" | "Debug" | "Warning", message: string) => {
        console.log(level, message)
      },
      OnMRURestore: async () => {},
      OnUnload: async () => {}
    } as unknown as PublicAPI
  })
  const results = await plugin.query(ctx, query)
  expect(results.length).toBeGreaterThan(0)
  expect(results[0]?.Id).toBe("awake-status")
})

test("windows launch plan inlines powershell parameters", () => {
  const plan = buildLaunchPlan(
    "windows",
    {
      durationMs: 90 * 1000,
      keepDisplayAwake: true
    },
    4321,
    {
      available: true,
      backend: "powershell",
      command: "powershell.exe",
      supportsDisplayAwake: true
    }
  )

  expect(plan.command).toBe("powershell.exe")
  expect(plan.args).toHaveLength(6)
  expect(plan.args[4]).toBe("-Command")
  expect(plan.args[5]).toContain("$parentPid = 4321")
  expect(plan.args[5]).toContain("$durationSeconds = 90")
  expect(plan.args[5]).toContain("$keepDisplay = $true")
  expect(plan.args[5]).toContain("$ES_CONTINUOUS = [uint32]2147483648")
  expect(plan.args[5]).toContain("$ES_SYSTEM_REQUIRED = [uint32]1")
  expect(plan.args[5]).toContain("$ES_DISPLAY_REQUIRED = [uint32]2")
  expect(plan.args[5]).not.toContain("$args[0]")
})
