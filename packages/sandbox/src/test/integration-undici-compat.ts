/** Verify undici 8 fetch can use the framework's undici 7 proxy dispatcher. */
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { createServer } from 'node:http';
import { connect } from 'node:net';
const coreRequire = createRequire(new URL('../../../agents-core/package.json', import.meta.url));
const sdkRequire = createRequire(createRequire(import.meta.url).resolve('e2b'));
const seven = coreRequire('undici');
const eight = sdkRequire('undici');
const upstream = createServer((_request, response) => { response.end('proxy-compatible'); });
await new Promise<void>(resolve => upstream.listen(0, '127.0.0.1', resolve));
const upstreamAddress = upstream.address(); assert.ok(upstreamAddress && typeof upstreamAddress === 'object');
let tunnels = 0;
const proxy = createServer();
proxy.on('connect', (_request, downstream, head) => {
  tunnels++;
  const socket = connect(upstreamAddress.port, '127.0.0.1', () => {
    downstream.write('HTTP/1.1 200 Connection Established\r\n\r\n');
    if (head.length) socket.write(head);
    downstream.pipe(socket); socket.pipe(downstream);
  });
  downstream.on('error', () => socket.destroy());
  downstream.on('close', () => socket.destroy());
  socket.on('error', () => downstream.destroy());
});
await new Promise<void>(resolve => proxy.listen(0, '127.0.0.1', resolve));
const proxyAddress = proxy.address(); assert.ok(proxyAddress && typeof proxyAddress === 'object');
const previous = seven.getGlobalDispatcher();
const agent = new seven.ProxyAgent(`http://127.0.0.1:${proxyAddress.port}`);
try {
  seven.setGlobalDispatcher(agent);
  const response = await eight.fetch(`http://127.0.0.1:${upstreamAddress.port}/`);
  assert.equal(await response.text(), 'proxy-compatible'); assert.equal(tunnels, 1);
  console.log('undici 8 fetch with undici 7 global ProxyAgent passed');
} finally {
  seven.setGlobalDispatcher(previous);
  await agent.close();
  await new Promise<void>(resolve => proxy.close(() => resolve()));
  await new Promise<void>(resolve => upstream.close(() => resolve()));
}
