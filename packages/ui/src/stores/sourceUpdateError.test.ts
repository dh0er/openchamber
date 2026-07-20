import { describe, expect, test } from 'bun:test';
import type { UpdateProgress } from '@/lib/desktop';
import {
  getSourceUpdateReportError,
  resolveSourceUpdateCheckError,
} from './sourceUpdateError';

const failedProgress: UpdateProgress = {
  downloaded: 0,
  event: 'Failed',
  report: {
    summary: 'Rebase stopped because conflicts require manual resolution',
    stage: 'rebase',
    conflictFiles: ['packages/ui/src/example.ts'],
  },
};

describe('source update errors', () => {
  test('keeps the source failure report authoritative after a transient check failure', () => {
    expect(resolveSourceUpdateCheckError(
      failedProgress,
      new Error('Temporary update check failure'),
    )).toBe(failedProgress.report?.summary);
  });

  test('clears successful check errors unless a source failure report remains', () => {
    expect(getSourceUpdateReportError(failedProgress)).toBe(failedProgress.report?.summary);
    expect(getSourceUpdateReportError({ downloaded: 0, event: 'Started' })).toBeNull();
    expect(getSourceUpdateReportError(null)).toBeNull();
  });

  test('uses the transient check error when no source report exists', () => {
    expect(resolveSourceUpdateCheckError(null, new Error('Check failed'))).toBe('Check failed');
    expect(resolveSourceUpdateCheckError(null, 'failed')).toBe('Failed to check for updates');
  });
});
