import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { EventEmitter, getEventListeners } from 'node:events';
import test from 'node:test';

import {
  createCommandRunner,
  terminateChildProcessTree,
} from './process-runner.mjs';

const isProcessAlive = (pid) => {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    if (error?.code === 'ESRCH') return false;
    if (error?.code === 'EPERM') return true;
    throw error;
  }
};

const killIfAlive = (pid) => {
  if (!Number.isSafeInteger(pid) || pid <= 0 || !isProcessAlive(pid)) return;
  try {
    process.kill(pid, 'SIGKILL');
  } catch (error) {
    if (error?.code !== 'ESRCH') throw error;
  }
};

test('captures only a bounded tail and never invokes a shell', async () => {
  const run = createCommandRunner();
  const result = await run(process.execPath, ['-e', "process.stdout.write('a'.repeat(4096)); process.stderr.write('tail')"], {
    maxOutputBytes: 64,
  });
  assert.equal(result.code, 0);
  assert.equal(result.truncated, true);
  assert.ok(result.stdout.length <= 64);
  assert.equal(result.stderr, 'tail');
});

test('uses hidden detached taskkill without a shell for Windows process trees', () => {
  const childKillSignals = [];
  const child = {
    pid: 4312,
    kill: (signal) => childKillSignals.push(signal),
  };
  const killer = new EventEmitter();
  let unrefCount = 0;
  killer.unref = () => {
    unrefCount += 1;
  };
  const environment = { SystemRoot: 'C:\\Windows', PATH: 'test-path' };
  let invocation;

  const returned = terminateChildProcessTree(child, {
    platform: 'win32',
    environment,
    spawnImpl: (executable, args, options) => {
      invocation = { executable, args, options };
      return killer;
    },
  });

  assert.equal(returned, killer);
  assert.deepEqual(invocation, {
    executable: 'C:\\Windows\\System32\\taskkill.exe',
    args: ['/PID', '4312', '/T', '/F'],
    options: {
      shell: false,
      windowsHide: true,
      detached: true,
      stdio: 'ignore',
      env: environment,
    },
  });
  assert.equal(unrefCount, 1);
  assert.deepEqual(childKillSignals, []);

  killer.emit('error', new Error('taskkill unavailable'));
  assert.deepEqual(childKillSignals, ['SIGKILL']);
});

test('falls back to a direct kill when taskkill exits unsuccessfully', () => {
  const childKillSignals = [];
  const child = {
    pid: 4313,
    kill: (signal) => childKillSignals.push(signal),
  };
  const killer = new EventEmitter();
  killer.unref = () => {};
  terminateChildProcessTree(child, {
    platform: 'win32',
    environment: { SystemRoot: 'C:\\Windows' },
    spawnImpl: () => killer,
  });

  killer.emit('exit', 1);
  assert.deepEqual(childKillSignals, ['SIGKILL']);
});

test('rejects a pre-aborted command without spawning or retaining a listener', async () => {
  const controller = new AbortController();
  controller.abort();
  let spawnCount = 0;
  const run = createCommandRunner({
    spawnImpl: () => {
      spawnCount += 1;
      throw new Error('must not spawn');
    },
  });

  await assert.rejects(
    run(process.execPath, ['-e', 'process.exit(0)'], { signal: controller.signal }),
    (error) => error?.code === 'PROCESS_ABORTED',
  );
  assert.equal(spawnCount, 0);
  assert.equal(getEventListeners(controller.signal, 'abort').length, 0);
});

test('cleans child, stream, and abort listeners after success', async () => {
  const child = new EventEmitter();
  child.stdout = new EventEmitter();
  child.stderr = new EventEmitter();
  child.kill = () => true;
  const controller = new AbortController();
  const run = createCommandRunner({ spawnImpl: () => child });

  const pending = run('fake-command', [], {
    signal: controller.signal,
    timeoutMs: 10_000,
  });
  assert.equal(getEventListeners(controller.signal, 'abort').length, 1);
  child.stdout.emit('data', Buffer.from('ok'));
  child.emit('close', 0, null);

  const result = await pending;
  assert.equal(result.stdout, 'ok');
  assert.equal(getEventListeners(controller.signal, 'abort').length, 0);
  assert.equal(child.listenerCount('error'), 0);
  assert.equal(child.listenerCount('close'), 0);
  assert.equal(child.stdout.listenerCount('data'), 0);
  assert.equal(child.stderr.listenerCount('data'), 0);
});

test('ignores synchronous and asynchronous output observer failures', async () => {
  const run = createCommandRunner();
  let observations = 0;
  const result = await run(
    process.execPath,
    ['-e', "process.stdout.write('out'); process.stderr.write('err')"],
    {
      onOutput: ({ stream }) => {
        observations += 1;
        if (stream === 'stdout') return Promise.reject(new Error('async observer failure'));
        throw new Error('sync observer failure');
      },
    },
  );
  await new Promise((resolve) => setImmediate(resolve));

  assert.equal(result.code, 0);
  assert.equal(result.stdout, 'out');
  assert.equal(result.stderr, 'err');
  assert.equal(observations, 2);
});

test('aborts a running Node child with PROCESS_ABORTED and leaves no process behind', async () => {
  const controller = new AbortController();
  let childPid;
  const run = createCommandRunner({
    spawnImpl: (...args) => {
      const child = spawn(...args);
      childPid = child.pid;
      return child;
    },
  });
  const abortTimer = setTimeout(() => controller.abort(), 75);

  try {
    await assert.rejects(
      run(process.execPath, ['-e', 'setInterval(() => {}, 1_000)'], {
        signal: controller.signal,
        timeoutMs: 5_000,
      }),
      (error) => error?.code === 'PROCESS_ABORTED',
    );
    assert.ok(Number.isSafeInteger(childPid) && childPid > 0);
    assert.equal(isProcessAlive(childPid), false);
    assert.equal(getEventListeners(controller.signal, 'abort').length, 0);
  } finally {
    clearTimeout(abortTimer);
    killIfAlive(childPid);
  }
});

test('times out a running Node child with PROCESS_TIMEOUT and leaves no process behind', async () => {
  let childPid;
  const run = createCommandRunner({
    spawnImpl: (...args) => {
      const child = spawn(...args);
      childPid = child.pid;
      return child;
    },
  });

  try {
    await assert.rejects(
      run(process.execPath, ['-e', 'setInterval(() => {}, 1_000)'], { timeoutMs: 75 }),
      (error) => error?.code === 'PROCESS_TIMEOUT',
    );
    assert.ok(Number.isSafeInteger(childPid) && childPid > 0);
    assert.equal(isProcessAlive(childPid), false);
  } finally {
    killIfAlive(childPid);
  }
});

test('settles after the termination grace period even when a child never closes', async () => {
  const child = new EventEmitter();
  child.stdout = new EventEmitter();
  child.stderr = new EventEmitter();
  let stdoutDestroyed = false;
  let stderrDestroyed = false;
  let unrefCount = 0;
  child.stdout.destroy = () => { stdoutDestroyed = true; };
  child.stderr.destroy = () => { stderrDestroyed = true; };
  child.kill = () => false;
  child.unref = () => { unrefCount += 1; };
  const controller = new AbortController();
  const run = createCommandRunner({
    spawnImpl: () => child,
    terminateProcessTree: () => null,
  });

  const pending = run('C:\\private\\bun.exe', [], {
    signal: controller.signal,
    timeoutMs: 10_000,
    terminationGraceMs: 100,
  });
  controller.abort();

  await assert.rejects(
    pending,
    (error) => error?.code === 'PROCESS_ABORTED' && !error.message.includes('C:\\private'),
  );
  assert.equal(stdoutDestroyed, true);
  assert.equal(stderrDestroyed, true);
  assert.equal(unrefCount, 1);
  assert.equal(getEventListeners(controller.signal, 'abort').length, 0);
});
