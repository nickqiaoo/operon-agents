/** Opt-in real SDK validation; creates and always destroys one temporary sandbox. */
import assert from 'node:assert/strict';
import { Sandbox } from 'e2b';
import { E2BEnvironment } from '../e2b/environment.ts';
import { wrapForTaskLog, BackgroundManager, StoreBackgroundTaskPersistence, MemoryStore } from 'operon-agents-core';
const config = process.argv[2];
if (config) process.loadEnvFile(config);
assert.ok(process.env.E2B_API_KEY, 'E2B_API_KEY must be configured');
const sandbox = await Sandbox.create({ timeoutMs: 120_000 });
console.log('Created temporary E2B sandbox');
try {
  const env = new E2BEnvironment(sandbox);
  await env.files.writeFiles([{ path: '/tmp/environment-test/a.txt', data: 'hello' }, { path: '/tmp/environment-test/b.bin', data: new Uint8Array([0, 255, 1]) }]);
  assert.equal((await env.files.read('/tmp/environment-test/a.txt', { range: { offset: 1, length: 2 } })).toString(), 'el');
  assert.equal((await env.files.read('/tmp/environment-test/b.bin')).toString('hex'), '00ff01');
  assert.equal((await env.files.list('/tmp/environment-test', { depth: 2 })).length, 2);
  await env.files.rename('/tmp/environment-test/a.txt', '/tmp/environment-test/renamed.txt');
  assert.equal(await env.files.exists('/tmp/environment-test/renamed.txt'), true);
  const stream = await env.files.readStream('/tmp/environment-test/renamed.txt');
  assert.equal(await new Response(stream).text(), 'hello');
  const events: string[] = [];
  assert.ok(env.files.watchDir);
  const watch = await env.files.watchDir('/tmp/environment-test', event => { events.push(event.name); });
  await env.files.write('/tmp/environment-test/watched.txt', 'watched');
  for (let i = 0; i < 20 && !events.some(name => name.includes('watched.txt')); i++) await new Promise(resolve => setTimeout(resolve, 100));
  await watch.stop(); assert.ok(events.some(name => name.includes('watched.txt')));
  assert.ok(env.pty);
  let terminal = '';
  const pty = await env.pty.create({ cols: 80, rows: 24, onData: bytes => { terminal += Buffer.from(bytes).toString(); } });
  await pty.resize({ cols: 100, rows: 30 });
  await pty.sendInput("printf 'pty-%s\\n' ok; exit 0\n");
  assert.equal((await pty.wait()).exitCode, 0); assert.ok(terminal.includes('pty-ok'));
  assert.ok(await env.sandbox.uploadUrl('/tmp/environment-test/upload'));
  assert.ok(await env.sandbox.downloadUrl('/tmp/environment-test/renamed.txt'));
  console.log('Native file stream, watch, PTY and transfer URLs passed');
  const nonzero = await env.commands.run('printf out; printf err >&2; exit 3');
  assert.equal(nonzero.exitCode, 3); assert.equal(nonzero.stdout, 'out'); assert.equal(nonzero.stderr, 'err');
  const stdin = await env.commands.run('cat', { stdin: 'hello stdin\n', timeoutMs: 10_000 });
  assert.equal(stdin.stdout, 'hello stdin\n'); assert.equal(stdin.exitCode, 0);
  const timeout = await env.commands.run('sleep 30', { timeoutMs: 100 });
  assert.equal(timeout.timedOut, true); assert.equal(timeout.terminated, true);
  assert.equal(await env.sandbox.setTimeout(120_000), true);
  assert.equal((await env.sandbox.getInfo()).id, sandbox.sandboxId);
  const metrics = await env.sandbox.getMetrics();
  if (metrics) assert.ok(metrics.cpuCount > 0 && metrics.memTotal > 0);
  console.log('Files, command results, stdin, timeout and renewal passed');
  const live = await env.commands.start('printf BEFORE; sleep 1; printf after; sleep 2', { retainOutput: false });
  const pid = live.pid;
  assert.ok((await env.commands.list()).some(p => p.pid === pid));
  await new Promise(resolve => setTimeout(resolve, 200));
  await live.disconnect();
  let reconnected = '';
  const connected = await env.commands.connect(pid, { onStdout: data => { reconnected += data; }, retainOutput: false });
  await connected.wait(); assert.ok(reconnected.includes('after'));
  console.log('Disconnect and reconnect passed; prior output replayed:', reconnected.includes('BEFORE'));
  let output = '';
  const logged = await env.commands.start("printf first; sleep 0.1; printf last; exit 3", { outputFile: '/tmp/environment-test/task.log', retainOutput: false, onStdout: data => { output += data; } });
  assert.equal((await logged.wait()).exitCode, 3);
  assert.equal(output, 'firstlast');
  assert.equal((await env.files.read('/tmp/environment-test/task.log.exit')).toString(), '3');
  const detach = new AbortController();
  const attachedManager = new BackgroundManager();
  const attached = await attachedManager.runCommandAttached(async ({ onStart, onOutput }) => {
    const handle = await env.commands.start('printf before; sleep 1; printf after', { outputFile: '/tmp/environment-test/detach.log', retainOutput: false, onStdout: onOutput });
    await onStart?.(handle);
    setTimeout(() => detach.abort(), 50);
    const result = await handle.wait();
    return { ...result, timedOut: false, terminated: false, truncated: false };
  }, 'detach smoke', 'detach smoke', { environment: env, logPath: '/tmp/environment-test/detach.log', foregroundSignal: new AbortController().signal, detachSignal: detach.signal, onLive: () => {} });
  assert.equal(attached.kind, 'detached');
  if (attached.kind === 'detached') assert.equal((await attachedManager.wait(attached.taskId, 10_000))?.status, 'completed');
  console.log('Foreground detach retained lifecycle ownership');
  const persistence = new StoreBackgroundTaskPersistence(new MemoryStore());
  const durable = await env.commands.start('sleep 20', { outputFile: '/tmp/environment-test/recover.log', retainOutput: false });
  await persistence.writeTask({ schemaVersion: 2, revision: 1, taskId: 'bash-real-recovery', kind: 'process', command: 'sleep 20', description: 'recovery smoke', status: 'running', startedAt: Date.now(), endedAt: null, exitCode: null, outputRef: { kind: 'file', path: '/tmp/environment-test/recover.log' }, process: { pid: durable.pid, sandboxId: env.sandbox.id } });
  await durable.disconnect();
  const restored = new BackgroundManager();
  restored.attach({ environment: new E2BEnvironment(sandbox), persistence });
  await restored.loadFromDisk(); await restored.reconcile();
  assert.equal(restored.getTask('bash-real-recovery')?.status, 'running');
  assert.equal((await restored.stop('bash-real-recovery'))?.status, 'killed');
  console.log('Real E2B background recovery preserved taskId and stopped the reconnected command');
  console.log('Durable streaming and exit sidecar passed');
  let busybox = (await env.commands.run('command -v busybox || true')).stdout.trim();
  if (!busybox) {
    const installed = await env.commands.run('sudo apt-get update -qq && sudo apt-get install -y -qq busybox', { timeoutMs: 60_000, maxOutputBytes: 1024 });
    assert.equal(installed.exitCode, 0, 'BusyBox test dependency must install in the disposable sandbox');
    busybox = '/bin/busybox';
  }
  for (const command of ['true', 'false', 'exit 3']) {
    const path = '/tmp/environment-test/busybox.log';
    const result = await env.commands.run([busybox, 'sh', '-c', wrapForTaskLog(command, path)]);
    assert.equal(Number((await env.files.read(`${path}.exit`)).toString()), result.exitCode);
  }
  const signalLog = '/tmp/environment-test/busybox-signal.log';
  const killedShell = await env.commands.start([busybox, 'sh', '-c', wrapForTaskLog('sleep 20', signalLog)], { retainOutput: false });
  await env.commands.run(['kill', '-TERM', String(killedShell.pid)]);
  await killedShell.wait();
  if (await env.files.exists(`${signalLog}.exit`)) assert.notEqual((await env.files.read(`${signalLog}.exit`)).toString(), '0');
  console.log('BusyBox sh exit trap and termination passed');
  // Validate tee beyond pipe capacity while the SDK client is disconnected.
  const script = "python3 -c 'import sys,time; time.sleep(0.4); sys.stdout.write(\"x\" * 2097152)'";
  const tee = await sandbox.commands.run(wrapForTaskLog(script, '/tmp/environment-test/tee.log', undefined, true), { background: true, timeoutMs: 0, retainOutput: false });
  await tee.disconnect();
  let finished = false;
  for (let attempt = 0; attempt < 30; attempt++) {
    if (await sandbox.files.exists('/tmp/environment-test/tee.log.exit')) { finished = true; break; }
    await new Promise(resolve => setTimeout(resolve, 200));
  }
  assert.equal(finished, true, 'tee must finish without a connected SDK client');
  assert.equal((await sandbox.files.getInfo('/tmp/environment-test/tee.log')).size, 2097152);
  assert.equal(await sandbox.files.read('/tmp/environment-test/tee.log.exit'), '0');
  console.log('Disconnected tee drained 2 MiB successfully');
} finally {
  await sandbox.kill();
  console.log('Destroyed temporary E2B sandbox');
}
