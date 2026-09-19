"use client"

let now = 0
const listeners = new Set<() => void>()
let timer: ReturnType<typeof setInterval> | null = null

function emit() {
  now = Date.now()
  for (const listener of listeners) listener()
}

function start() {
  if (timer) return
  now = Date.now()
  timer = setInterval(emit, 1000)
}

export function subscribeClock(onStoreChange: () => void) {
  start()
  listeners.add(onStoreChange)
  return () => {
    listeners.delete(onStoreChange)
  }
}

export function getClockSnapshot() {
  return now
}

export function getServerClockSnapshot() {
  return 0
}
