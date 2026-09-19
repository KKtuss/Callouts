export async function register() {
  if (process.env.NEXT_RUNTIME !== "nodejs") return
  try {
    const { startRuntime } = await import("@/engine/runtime")
    startRuntime()
  } catch (error) {
    console.error("[runtime] failed to start snapshot engine", error)
  }
}
