export function isCalloutInCurrentWindow(
  capturedAt: string,
  lastSnapshotAt: string | null,
  startedAt: string,
): boolean {
  if (lastSnapshotAt) return capturedAt > lastSnapshotAt
  return capturedAt >= startedAt
}
