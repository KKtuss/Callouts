import { ignoreInboundUpdate } from "@/telegram/commands"

export const dynamic = "force-dynamic"

/**
 * If a Telegram webhook is accidentally pointed here, drop every update.
 * The public bot has no command surface.
 */
export async function POST(request: Request) {
  let update: unknown = null
  try {
    update = await request.json()
  } catch {
    await request.text()
  }
  return Response.json(ignoreInboundUpdate(update))
}

export async function GET() {
  return Response.json({
    ok: true,
    mode: "broadcast-only",
    commands: [],
    note: "Inbound Telegram traffic is ignored. Configure the bot as a channel publisher, not a control bot.",
  })
}
