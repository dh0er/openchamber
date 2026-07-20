import assert from 'node:assert/strict';
import test from 'node:test';

import {
  createSourceUpdateMainController,
  isPackagedSourceUpdateBuild,
  mapSourceUpdateFailure,
  mapSourceUpdateProgress,
  sourceUpdateStageCount,
  sourceUpdateTerminalResult,
} from './main-integration.mjs';

test('detects the packaged Windows source-update resource directory', () => {
  let requestedPath = null;
  const detected = isPackagedSourceUpdateBuild({
    resourcesPath: 'C:\\Program Files\\OpenChamber\\resources',
    platform: 'win32',
    statSync: (candidate) => {
      requestedPath = candidate;
      return { isDirectory: () => true };
    },
  });

  assert.equal(detected, true);
  assert.match(requestedPath, /source-update$/);
  assert.equal(isPackagedSourceUpdateBuild({
    resourcesPath: 'C:\\Program Files\\OpenChamber\\resources',
    platform: 'darwin',
    statSync: () => {
      throw new Error('must not inspect resources');
    },
  }), false);
});

test('maps source-update stages to stable renderer progress', () => {
  const progress = mapSourceUpdateProgress('rebase');
  assert.deepEqual(progress, {
    event: 'Progress',
    data: {
      downloaded: 4,
      total: sourceUpdateStageCount,
      phase: 'rebase',
      step: 4,
      stepCount: sourceUpdateStageCount,
    },
  });
  assert.deepEqual(sourceUpdateTerminalResult(progress), { ok: true, progress });
});

test('maps only bounded sanitized source-update failure fields', () => {
  const progress = mapSourceUpdateFailure({
    code: 'REBASE_CONFLICT',
    message: 'Rebase stopped',
    report: {
      stage: 'rebase',
      summary: 'Custom changes conflict with upstream.',
      conflictFiles: ['packages/ui/a.ts', '../outside.txt', 'C:\\outside.txt'],
      patchSubject: 'feat: custom provider instances',
      reportFile: 'report-123.json',
      logTail: 'CONFLICT (content)',
      secretInternalField: 'must not cross IPC',
    },
  });

  assert.equal(progress.event, 'Failed');
  assert.deepEqual(progress.data.report, {
    summary: 'Custom changes conflict with upstream.',
    stage: 'rebase',
    conflictFiles: ['packages/ui/a.ts'],
    patchSubject: 'feat: custom provider instances',
    reportPath: 'report-123.json',
    logTail: 'CONFLICT (content)',
  });
  assert.deepEqual(sourceUpdateTerminalResult(progress), { ok: false, progress });
});

test('binds prepared state and installation to the exact checked upstream SHA', async () => {
  const scheduledTargets = [];
  const updater = {
    check: async () => ({
      available: true,
      currentVersion: '1.0.0',
      currentUpstreamSha: '0'.repeat(40),
      latestUpstreamSha: 'a'.repeat(40),
    }),
    readPreparedUpdate: async () => ({ upstreamSha: 'a'.repeat(40) }),
    prepare: async () => {},
    scheduleInstallAndRelaunch: async ({ expectedUpstreamSha }) => {
      scheduledTargets.push(expectedUpstreamSha);
      return { scheduled: true };
    },
  };
  const controller = createSourceUpdateMainController({ updater });

  const first = await controller.check();
  assert.equal(first.prepared, true);
  assert.equal(controller.hasPreparedUpdate(), true);
  await controller.scheduleInstallAndRelaunch();
  assert.deepEqual(scheduledTargets, ['a'.repeat(40)]);
  assert.equal((await controller.check()).targetRevision, 'a'.repeat(40));

  const staleController = createSourceUpdateMainController({
    updater: {
      ...updater,
      check: async () => ({
        available: true,
        currentVersion: '1.0.0',
        currentUpstreamSha: '0'.repeat(40),
        latestUpstreamSha: 'b'.repeat(40),
      }),
    },
  });
  const stale = await staleController.check();
  assert.equal(stale.targetRevision, 'b'.repeat(40));
  assert.equal(stale.prepared, false);
  assert.equal(staleController.hasPreparedUpdate(), false);
});

test('returns a terminal failure report even when the progress event is missed', async () => {
  const updater = {
    check: async () => ({
      available: true,
      currentVersion: '1.0.0',
      currentUpstreamSha: '0'.repeat(40),
      latestUpstreamSha: 'a'.repeat(40),
    }),
    readPreparedUpdate: async () => null,
    prepare: async () => {
      const error = new Error('Custom changes conflict with upstream.');
      error.code = 'REBASE_CONFLICT';
      error.report = {
        summary: error.message,
        stage: 'rebase',
        conflictFiles: ['packages/electron/main.mjs'],
        logTail: 'CONFLICT (content)',
      };
      throw error;
    },
    scheduleInstallAndRelaunch: async () => {},
  };
  const controller = createSourceUpdateMainController({ updater });
  await controller.check();

  const result = await controller.prepare();
  assert.equal(result.ok, false);
  assert.equal(result.progress.event, 'Failed');
  assert.deepEqual(result.progress.data.report.conflictFiles, ['packages/electron/main.mjs']);
  assert.equal(controller.hasPreparedUpdate(), false);
});

test('does not replace the checked target while its source build is running', async () => {
  let finishPrepare;
  let checkCalls = 0;
  const updater = {
    check: async () => {
      checkCalls += 1;
      return {
        available: true,
        currentVersion: '1.0.0',
        currentUpstreamSha: '0'.repeat(40),
        latestUpstreamSha: checkCalls === 1 ? 'a'.repeat(40) : 'b'.repeat(40),
      };
    },
    readPreparedUpdate: async () => null,
    prepare: async () => new Promise((resolve) => {
      finishPrepare = resolve;
    }),
    scheduleInstallAndRelaunch: async () => {},
  };
  const controller = createSourceUpdateMainController({ updater });
  await controller.check();
  const preparing = controller.prepare();

  const whilePreparing = await controller.check();
  assert.equal(whilePreparing.targetRevision, 'a'.repeat(40));
  assert.equal(checkCalls, 1);

  finishPrepare();
  const result = await preparing;
  assert.equal(result.ok, true);
  assert.equal(controller.hasPreparedUpdate(), true);
});

test('cancels the active source preparation through its AbortSignal', async () => {
  let receivedSignal;
  const updater = {
    check: async () => ({
      available: true,
      currentVersion: '1.0.0',
      currentUpstreamSha: '0'.repeat(40),
      latestUpstreamSha: 'a'.repeat(40),
    }),
    readPreparedUpdate: async () => null,
    prepare: async ({ signal }) => {
      receivedSignal = signal;
      await new Promise((resolve, reject) => {
        signal.addEventListener('abort', () => reject(new Error('cancelled')), { once: true });
      });
    },
    scheduleInstallAndRelaunch: async () => {},
  };
  const controller = createSourceUpdateMainController({ updater });
  await controller.check();

  const preparing = controller.prepare();
  const cancellation = controller.cancelPreparation();
  assert.equal(receivedSignal.aborted, true);
  assert.equal(await cancellation, true);
  const result = await preparing;
  assert.equal(result.ok, false);
  assert.equal(controller.hasPreparedUpdate(), false);
  assert.equal(await controller.cancelPreparation(), false);
});

test('does not let an older update check overwrite a completed preparation', async () => {
  let releaseSecondCheck;
  let checkCalls = 0;
  const updater = {
    check: async () => {
      checkCalls += 1;
      if (checkCalls === 2) {
        await new Promise((resolve) => {
          releaseSecondCheck = resolve;
        });
      }
      return {
        available: true,
        currentVersion: '1.0.0',
        currentUpstreamSha: '0'.repeat(40),
        latestUpstreamSha: 'a'.repeat(40),
      };
    },
    readPreparedUpdate: async () => null,
    prepare: async () => {},
    scheduleInstallAndRelaunch: async () => {},
  };
  const controller = createSourceUpdateMainController({ updater });
  await controller.check();

  const staleCheck = controller.check();
  const prepared = await controller.prepare();
  assert.equal(prepared.ok, true);
  releaseSecondCheck();

  const checked = await staleCheck;
  assert.equal(checked.prepared, true);
  assert.equal(controller.hasPreparedUpdate(), true);
});

test('does not let an older available result overwrite a newer no-update check', async () => {
  let releaseOlderCheck;
  let checkCalls = 0;
  const availableResult = {
    available: true,
    currentVersion: '1.0.0',
    currentUpstreamSha: '0'.repeat(40),
    latestUpstreamSha: 'a'.repeat(40),
  };
  const updater = {
    check: async () => {
      checkCalls += 1;
      if (checkCalls === 2) {
        await new Promise((resolve) => {
          releaseOlderCheck = resolve;
        });
        return availableResult;
      }
      if (checkCalls === 3) return { ...availableResult, available: false };
      return availableResult;
    },
    readPreparedUpdate: async () => null,
    prepare: async () => {},
    scheduleInstallAndRelaunch: async () => {},
  };
  const controller = createSourceUpdateMainController({ updater });
  await controller.check();

  const olderCheck = controller.check();
  const newerCheck = await controller.check();
  assert.equal(newerCheck.available, false);
  releaseOlderCheck();

  const staleResult = await olderCheck;
  assert.equal(staleResult.available, false);
  assert.equal(controller.hasPreparedUpdate(), false);
});
