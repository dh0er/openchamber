import { spawn } from 'node:child_process';
import path from 'node:path';

import { SourceUpdateError } from './contracts.mjs';

const killChildDirectly = (child) => {
  try {
    child?.kill?.('SIGKILL');
  } catch {
    // The process may already have exited between the liveness check and kill.
  }
};

export const terminateChildProcessTree = (child, {
  platform = process.platform,
  environment = process.env,
  spawnImpl = spawn,
} = {}) => {
  if (platform !== 'win32' || !Number.isSafeInteger(child?.pid) || child.pid <= 0) {
    killChildDirectly(child);
    return null;
  }
  const systemRoot = environment?.SystemRoot || environment?.SYSTEMROOT || process.env.SystemRoot;
  const taskkill = systemRoot
    ? path.win32.join(systemRoot, 'System32', 'taskkill.exe')
    : 'taskkill.exe';
  try {
    const killer = spawnImpl(taskkill, ['/PID', String(child.pid), '/T', '/F'], {
      shell: false,
      windowsHide: true,
      detached: true,
      stdio: 'ignore',
      env: environment,
    });
    let fallbackUsed = false;
    const fallback = () => {
      if (fallbackUsed) return;
      fallbackUsed = true;
      killChildDirectly(child);
    };
    killer.once?.('error', fallback);
    killer.once?.('exit', (code) => {
      if (code !== 0) fallback();
    });
    killer.unref?.();
    return killer;
  } catch {
    killChildDirectly(child);
    return null;
  }
};

const appendTail = (existing, chunk, limit) => {
  const combined = Buffer.concat([existing, Buffer.from(chunk)]);
  if (combined.length <= limit) return { value: combined, truncated: false };
  return { value: combined.subarray(combined.length - limit), truncated: true };
};

export const createCommandRunner = ({
  spawnImpl = spawn,
  terminateProcessTree = terminateChildProcessTree,
} = {}) => (
  executable,
  args,
  {
    cwd,
    env = process.env,
    timeoutMs = 120_000,
    maxOutputBytes = 64 * 1024,
    onOutput,
    signal,
    terminationGraceMs = 10_000,
  } = {},
) => new Promise((resolve, reject) => {
  if (signal?.aborted) {
    reject(new SourceUpdateError('PROCESS_ABORTED', 'Source update command was cancelled before it started.'));
    return;
  }
  let child;
  try {
    child = spawnImpl(executable, args, {
      cwd,
      env,
      shell: false,
      windowsHide: true,
      stdio: ['ignore', 'pipe', 'pipe'],
    });
  } catch (error) {
    reject(new SourceUpdateError('PROCESS_START_FAILED', `Unable to start ${executable}.`, { cause: error }));
    return;
  }

  let stdout = Buffer.alloc(0);
  let stderr = Buffer.alloc(0);
  let truncated = false;
  let settled = false;
  let terminationReason = null;
  let timer = null;
  let forceKillTimer = null;
  let terminationDeadlineTimer = null;
  let cleanedUp = false;

  const notifyOutput = (event) => {
    try {
      const observerResult = onOutput?.(event);
      if (observerResult && typeof observerResult.then === 'function') {
        Promise.resolve(observerResult).catch(() => {});
      }
    } catch {
      // Progress observers are informational and cannot fail the command.
    }
  };

  const onStdout = (chunk) => {
    const appended = appendTail(stdout, chunk, maxOutputBytes);
    stdout = appended.value;
    truncated ||= appended.truncated;
    notifyOutput({ stream: 'stdout', text: Buffer.from(chunk).toString('utf8') });
  };

  const onStderr = (chunk) => {
    const appended = appendTail(stderr, chunk, maxOutputBytes);
    stderr = appended.value;
    truncated ||= appended.truncated;
    notifyOutput({ stream: 'stderr', text: Buffer.from(chunk).toString('utf8') });
  };

  const onAbort = () => stopProcess('abort');

  const cleanup = () => {
    if (cleanedUp) return;
    cleanedUp = true;
    if (timer) clearTimeout(timer);
    if (forceKillTimer) clearTimeout(forceKillTimer);
    if (terminationDeadlineTimer) clearTimeout(terminationDeadlineTimer);
    signal?.removeEventListener?.('abort', onAbort);
    child.stdout?.off?.('data', onStdout);
    child.stderr?.off?.('data', onStderr);
    child.off?.('error', onChildError);
    child.off?.('close', onChildClose);
  };

  const stopProcess = (reason) => {
    if (settled || terminationReason) return;
    terminationReason = reason;
    try {
      terminateProcessTree(child, { environment: env });
    } catch {
      killChildDirectly(child);
    }
    const boundedTerminationGraceMs = Number.isFinite(terminationGraceMs)
      ? Math.max(100, Math.min(60_000, terminationGraceMs))
      : 10_000;
    forceKillTimer = setTimeout(
      () => killChildDirectly(child),
      Math.min(5_000, Math.max(50, Math.floor(boundedTerminationGraceMs / 2))),
    );
    forceKillTimer.unref?.();
    terminationDeadlineTimer = setTimeout(() => {
      if (settled) return;
      settled = true;
      killChildDirectly(child);
      child.stdout?.destroy?.();
      child.stderr?.destroy?.();
      child.unref?.();
      cleanup();
      child.once?.('error', () => {});
      reject(new SourceUpdateError(
        reason === 'timeout' ? 'PROCESS_TIMEOUT' : 'PROCESS_ABORTED',
        reason === 'timeout'
          ? 'Source update command exceeded its stage timeout.'
          : 'Source update command was cancelled.',
      ));
    }, boundedTerminationGraceMs);
    terminationDeadlineTimer.unref?.();
  };

  const onChildError = (error) => {
    if (settled) return;
    settled = true;
    cleanup();
    if (terminationReason === 'timeout') {
      reject(new SourceUpdateError('PROCESS_TIMEOUT', 'Source update command exceeded its stage timeout.', { cause: error }));
      return;
    }
    if (terminationReason === 'abort') {
      reject(new SourceUpdateError('PROCESS_ABORTED', 'Source update command was cancelled.', { cause: error }));
      return;
    }
    reject(new SourceUpdateError('PROCESS_START_FAILED', `Unable to start ${executable}.`, { cause: error }));
  };

  const onChildClose = (code, processSignal) => {
    if (settled) return;
    settled = true;
    cleanup();
    if (terminationReason === 'timeout') {
      reject(new SourceUpdateError('PROCESS_TIMEOUT', 'Source update command exceeded its stage timeout.'));
      return;
    }
    if (terminationReason === 'abort') {
      reject(new SourceUpdateError('PROCESS_ABORTED', 'Source update command was cancelled.'));
      return;
    }
    resolve({
      code: Number.isInteger(code) ? code : 1,
      signal: processSignal || null,
      stdout: stdout.toString('utf8'),
      stderr: stderr.toString('utf8'),
      truncated,
    });
  };

  child.stdout?.on('data', onStdout);
  child.stderr?.on('data', onStderr);
  child.once('error', onChildError);
  child.once('close', onChildClose);
  signal?.addEventListener?.('abort', onAbort, { once: true });
  timer = setTimeout(() => stopProcess('timeout'), timeoutMs);
  timer.unref?.();

  // Close the check/listener race if cancellation happened after spawn.
  if (signal?.aborted) onAbort();
});

export const assertCommandSucceeded = (result, label) => {
  if (result.code !== 0) {
    throw new SourceUpdateError('COMMAND_FAILED', `${label} failed with exit code ${result.code}.`);
  }
  return result;
};
