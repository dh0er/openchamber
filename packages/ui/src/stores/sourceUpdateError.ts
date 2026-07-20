import type { UpdateProgress } from '@/lib/desktop';

export function getSourceUpdateReportError(progress: UpdateProgress | null): string | null {
  return progress?.report?.summary ?? null;
}

export function resolveSourceUpdateCheckError(
  progress: UpdateProgress | null,
  error: unknown,
): string {
  return getSourceUpdateReportError(progress)
    ?? (error instanceof Error ? error.message : 'Failed to check for updates');
}
