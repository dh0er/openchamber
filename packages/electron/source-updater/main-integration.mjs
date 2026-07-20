import fs from 'node:fs';
import path from 'node:path';

import { createSourceUpdater, sourceUpdatePipelineStages } from './index.mjs';
import { SOURCE_UPDATE_RESOURCE_DIRECTORY } from './contracts.mjs';

const SOURCE_UPDATE_STAGES = Object.freeze([
  'verify',
  'fetch',
  'verify-bundle',
  'rebase',
  ...sourceUpdatePipelineStages,
  'prepare-installer',
  'ready',
]);

const readBoundedString = (value, maxLength) => {
  if (typeof value !== 'string') return undefined;
  const trimmed = value.trim();
  if (!trimmed) return undefined;
  return trimmed.length > maxLength
    ? `${trimmed.slice(0, Math.max(0, maxLength - 1))}…`
    : trimmed;
};

const readConflictFiles = (value) => {
  if (!Array.isArray(value)) return [];
  return value
    .filter((entry) => typeof entry === 'string')
    .map((entry) => entry.trim().replaceAll('\\', '/'))
    .filter((entry) => (
      entry.length > 0
      && entry.length <= 300
      && !path.posix.isAbsolute(entry)
      && !/^[A-Za-z]:\//.test(entry)
      && !entry.startsWith('../')
    ))
    .slice(0, 100);
};

export const isPackagedSourceUpdateBuild = ({
  resourcesPath,
  platform = process.platform,
  statSync = fs.statSync,
} = {}) => {
  if (platform !== 'win32' || !resourcesPath || !path.isAbsolute(resourcesPath)) return false;
  try {
    return statSync(path.join(resourcesPath, SOURCE_UPDATE_RESOURCE_DIRECTORY)).isDirectory();
  } catch {
    return false;
  }
};

export const mapSourceUpdateProgress = (stage, event = 'Progress') => {
  const normalizedStage = readBoundedString(stage, 100) || 'unknown';
  const stageIndex = SOURCE_UPDATE_STAGES.indexOf(normalizedStage);
  const step = stageIndex >= 0 ? stageIndex + 1 : 0;
  return {
    event,
    data: {
      downloaded: step,
      total: SOURCE_UPDATE_STAGES.length,
      phase: normalizedStage,
      step,
      stepCount: SOURCE_UPDATE_STAGES.length,
    },
  };
};

export const mapSourceUpdateFailure = (error) => {
  const cancelled = error?.code === 'PROCESS_ABORTED';
  const rawReport = error?.report && typeof error.report === 'object' && !Array.isArray(error.report)
    ? error.report
    : {};
  const summary = (cancelled ? 'Source update preparation was cancelled.' : undefined)
    || readBoundedString(rawReport.summary, 1_000)
    || readBoundedString(error?.message, 1_000)
    || 'The source update stopped unexpectedly.';
  const stage = readBoundedString(rawReport.stage, 100)
    || readBoundedString(error?.code, 100)
    || 'unknown';
  const report = {
    summary,
    stage,
    conflictFiles: readConflictFiles(rawReport.conflictFiles ?? rawReport.conflictedFiles),
  };
  const patchSubject = readBoundedString(rawReport.patchSubject, 500);
  const reportFile = readBoundedString(rawReport.reportFile, 200);
  const logTail = readBoundedString(rawReport.logTail ?? rawReport.details, 16_000);
  if (patchSubject) report.patchSubject = patchSubject;
  if (reportFile) report.reportPath = reportFile;
  if (logTail) report.logTail = logTail;

  const progress = mapSourceUpdateProgress(stage, 'Failed');
  return {
    ...progress,
    data: {
      ...progress.data,
      message: summary,
      report,
    },
  };
};

export const sourceUpdateTerminalResult = (progress) => ({
  ok: progress?.event !== 'Failed',
  progress,
});

const sourceUpdateInfo = (pendingUpdate, available = true) => ({
  available,
  currentVersion: pendingUpdate.currentVersion,
  version: pendingUpdate.currentVersion,
  updateKind: 'source-rebase',
  currentRevision: pendingUpdate.currentUpstreamSha,
  targetRevision: pendingUpdate.targetUpstreamSha,
  prepared: available && pendingUpdate.downloaded === true,
  body: null,
  date: null,
});

const safeNotify = (callback, value) => {
  try {
    callback?.(value);
  } catch {
    // Main-process progress observers must not change update state.
  }
};

export const createSourceUpdateMainController = ({
  resourcesPath,
  currentExecutablePath,
  logger,
  updater = createSourceUpdater({ resourcesPath, currentExecutablePath, logger }),
} = {}) => {
  let pendingUpdate = null;
  let activePreparation = null;
  let stateRevision = 0;
  let lastCheckInfo = null;

  const currentUpdateInfo = () => (
    pendingUpdate ? sourceUpdateInfo(pendingUpdate) : lastCheckInfo
  );

  const check = async () => {
    if (pendingUpdate?.preparing === true || pendingUpdate?.installScheduled === true) {
      return sourceUpdateInfo(pendingUpdate);
    }

    const revisionAtStart = stateRevision;
    const update = await updater.check();
    if (stateRevision !== revisionAtStart && currentUpdateInfo()) {
      return currentUpdateInfo();
    }
    if (!update.available) {
      pendingUpdate = null;
      stateRevision += 1;
      lastCheckInfo = sourceUpdateInfo({
        currentVersion: update.currentVersion,
        currentUpstreamSha: update.currentUpstreamSha,
        targetUpstreamSha: update.latestUpstreamSha,
        downloaded: false,
      }, false);
      return lastCheckInfo;
    }

    let preparedUpdate = null;
    try {
      preparedUpdate = await updater.readPreparedUpdate();
    } catch (error) {
      try {
        logger?.warn?.('[electron] ignoring invalid prepared source update', error);
      } catch {
        // Logging must not block a clean rebuild of invalid ready state.
      }
    }
    if (stateRevision !== revisionAtStart && currentUpdateInfo()) {
      return currentUpdateInfo();
    }
    pendingUpdate = {
      currentVersion: update.currentVersion,
      currentUpstreamSha: update.currentUpstreamSha,
      targetUpstreamSha: update.latestUpstreamSha,
      downloaded: preparedUpdate?.upstreamSha === update.latestUpstreamSha,
      preparing: false,
      installScheduled: false,
    };
    stateRevision += 1;
    lastCheckInfo = sourceUpdateInfo(pendingUpdate);
    return lastCheckInfo;
  };

  const prepare = async ({ onProgress } = {}) => {
    if (!pendingUpdate) throw new Error('No pending source update');
    if (pendingUpdate.preparing === true) throw new Error('A source update is already being prepared');
    if (pendingUpdate.installScheduled === true) throw new Error('The source update installation is already scheduled');

    const activeUpdate = pendingUpdate;
    const abortController = new AbortController();
    let resolveCompletion;
    const completion = new Promise((resolve) => {
      resolveCompletion = resolve;
    });
    activePreparation = { abortController, completion };
    activeUpdate.preparing = true;
    stateRevision += 1;
    safeNotify(onProgress, mapSourceUpdateProgress('verify', 'Started'));
    try {
      await updater.prepare({
        expectedUpstreamSha: activeUpdate.targetUpstreamSha,
        onProgress: ({ stage }) => safeNotify(onProgress, mapSourceUpdateProgress(stage)),
        signal: abortController.signal,
      });
      if (abortController.signal.aborted) throw new Error('Source update preparation was cancelled');
      activeUpdate.downloaded = true;
      stateRevision += 1;
      const finished = mapSourceUpdateProgress('ready', 'Finished');
      safeNotify(onProgress, finished);
      return sourceUpdateTerminalResult(finished);
    } catch (error) {
      activeUpdate.downloaded = false;
      stateRevision += 1;
      const failed = mapSourceUpdateFailure(error);
      safeNotify(onProgress, failed);
      return sourceUpdateTerminalResult(failed);
    } finally {
      activeUpdate.preparing = false;
      stateRevision += 1;
      resolveCompletion();
      if (activePreparation?.abortController === abortController) activePreparation = null;
    }
  };

  const hasPreparedUpdate = () => pendingUpdate?.downloaded === true;

  const cancelPreparation = async () => {
    const preparation = activePreparation;
    if (!preparation) return false;
    preparation.abortController.abort();
    await preparation.completion;
    return true;
  };

  const consumeInstallResult = async () => updater.consumeInstallResult();

  const scheduleInstallAndRelaunch = async () => {
    if (!pendingUpdate?.downloaded) {
      throw new Error('No source-built update is ready to install');
    }
    if (pendingUpdate.installScheduled === true) {
      throw new Error('The source update installation is already scheduled');
    }
    pendingUpdate.installScheduled = true;
    stateRevision += 1;
    try {
      return await updater.scheduleInstallAndRelaunch({
        expectedUpstreamSha: pendingUpdate.targetUpstreamSha,
      });
    } catch (error) {
      pendingUpdate.installScheduled = false;
      stateRevision += 1;
      throw error;
    }
  };

  return Object.freeze({
    cancelPreparation,
    check,
    consumeInstallResult,
    prepare,
    hasPreparedUpdate,
    scheduleInstallAndRelaunch,
  });
};

export const sourceUpdateStageCount = SOURCE_UPDATE_STAGES.length;
