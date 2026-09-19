import { NextResponse } from "next/server"

export function requireAdmin(request: Request): NextResponse | null {
  const expected = process.env.ADMIN_KEY?.trim()
  if (!expected) return null

  const header = request.headers.get("x-admin-key")?.trim()
  const cookie = request.headers
    .get("cookie")
    ?.split(";")
    .map((part) => part.trim())
    .find((part) => part.startsWith("admin_key="))
    ?.slice("admin_key=".length)

  if (header === expected || cookie === expected) return null

  return NextResponse.json(
    { error: "Private admin interface. Public Telegram cannot authorize this." },
    { status: 401 },
  )
}
