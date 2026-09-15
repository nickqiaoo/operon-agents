/**
 * A configured endpoint, end to end: `providers.toml` → the engine asks the endpoint what it
 * serves → the picker offers those models → a switch resolves one.
 *
 * The endpoint is a real HTTP server on a loopback port, so the `/models` request, its headers and
 * its response shape are exercised rather than mocked.
 */

import assert from 'node:assert/strict';
import { createServer, type Server } from 'node:http';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';

import { createLocalHarness, createModelRuntimeFromConfig, defineModel, loadProviderConfigs, parseModelsResponse, providersConfigPath } from 'operon-agents';

import { buildModelCatalog } from '../src/utils/model-catalog.ts';

interface FakeEndpoint {
  readonly url: string;
  readonly requests: { path: string; authorization: string | undefined }[];
  close(): Promise<void>;
}

/** An OpenAI-compatible `/models` endpoint that records what was asked of it. */
async function startEndpoint(modelIds: readonly string[], status = 200): Promise<FakeEndpoint> {
  const requests: { path: string; authorization: string | undefined }[] = [];
  const server: Server = createServer((req, res) => {
    requests.push({ path: req.url ?? '', authorization: req.headers.authorization });
    if (status !== 200) {
      res.writeHead(status).end('nope');
      return;
    }
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ object: 'list', data: modelIds.map((id) => ({ id, object: 'model' })) }));
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const address = server.address();
  if (address === null || typeof address === 'string') throw new Error('no port');
  return {
    url: `http://127.0.0.1:${String(address.port)}/v1`,
    requests,
    close: () => new Promise<void>((resolve) => server.close(() => resolve())),
  };
}

async function withHome(run: (homeDir: string) => Promise<void>): Promise<void> {
  const homeDir = await mkdtemp(join(tmpdir(), 'operon-providers-'));
  try {
    await run(homeDir);
  } finally {
    await rm(homeDir, { recursive: true, force: true });
  }
}

test('a `/models` response is read for its ids, and anything else yields none', () => {
  assert.deepEqual(parseModelsResponse({ data: [{ id: 'a' }, { id: 'b' }] }), ['a', 'b']);
  // Entries without a usable id are skipped rather than becoming blank models.
  assert.deepEqual(parseModelsResponse({ data: [{ id: '' }, {}, { id: 'c' }] }), ['c']);
  for (const body of [undefined, null, {}, { data: 'nope' }, []]) {
    assert.deepEqual(parseModelsResponse(body), [], JSON.stringify(body));
  }
});

test('a missing providers.toml is the normal case, not an error', async () => {
  await withHome(async (homeDir) => {
    assert.deepEqual(await loadProviderConfigs(homeDir), { providers: {}, warnings: [] });
  });
});

test('a malformed providers.toml warns and is ignored rather than stopping startup', async () => {
  await withHome(async (homeDir) => {
    await writeFile(providersConfigPath(homeDir), '[providers.broken]\nnot_base_url = 1\n');
    const loaded = await loadProviderConfigs(homeDir);
    assert.deepEqual(loaded.providers, {});
    assert.equal(loaded.warnings.length, 1);
    assert.match(loaded.warnings[0] ?? '', /providers\.toml/);
  });
});

test('a configured endpoint is asked what it serves, and those models become selectable', async () => {
  const endpoint = await startEndpoint(['qwen3-coder', 'llama-3.3-70b']);
  try {
    await withHome(async (homeDir) => {
      await writeFile(
        providersConfigPath(homeDir),
        [
          '[providers.local]',
          `base_url = "${endpoint.url}"`,
          'api_key = "local-secret"',
          'context_window = 128000',
          '',
          '[providers.local.models."qwen3-coder"]',
          'name = "Qwen3 Coder"',
          'context_window = 262144',
          'reasoning = true',
        ].join('\n'),
      );

      const warnings: string[] = [];
      const runtime = await createModelRuntimeFromConfig({ homeDir, onWarning: (m) => warnings.push(m) });
      assert.deepEqual(warnings, []);

      // The endpoint was actually called, with the configured key.
      assert.equal(endpoint.requests.length, 1);
      assert.equal(endpoint.requests[0]?.path, '/v1/models');
      assert.equal(endpoint.requests[0]?.authorization, 'Bearer local-secret');

      const catalog = await buildModelCatalog([], runtime);
      const coder = catalog['local/qwen3-coder'];
      const llama = catalog['local/llama-3.3-70b'];
      assert.ok(coder !== undefined, 'the endpoint model should be offered');
      assert.ok(llama !== undefined, 'every model the endpoint reported should be offered');
      // Per-model config wins over the provider defaults; a model with no entry takes the defaults.
      assert.equal(coder.displayName, 'Qwen3 Coder');
      assert.equal(coder.contextWindow, 262_144);
      assert.equal(coder.reasoning, true);
      assert.equal(llama.displayName, 'llama-3.3-70b');
      assert.equal(llama.contextWindow, 128_000);
      assert.equal(llama.reasoning, false);

      // And the model resolves, which is what a /model switch does.
      const model = defineModel({ provider: 'local', model: 'qwen3-coder', runtime });
      assert.equal(model.contextWindow, 262_144);
      assert.equal(model.provider, 'local');
    });
  } finally {
    await endpoint.close();
  }
});

test('an unreachable endpoint warns and leaves the rest of the runtime working', async () => {
  await withHome(async (homeDir) => {
    await writeFile(
      providersConfigPath(homeDir),
      ['[providers.dead]', 'base_url = "http://127.0.0.1:1/v1"', '[providers.dead.models."fallback"]', 'context_window = 8192'].join('\n'),
    );
    const warnings: string[] = [];
    const runtime = await createModelRuntimeFromConfig({ homeDir, refreshTimeoutMs: 2_000, onWarning: (m) => warnings.push(m) });
    assert.ok(warnings.some((m) => /dead/.test(m)), `expected a warning naming the provider, saw ${JSON.stringify(warnings)}`);
    // The model declared in the config still resolves: a dead endpoint must not lose what we know.
    assert.equal(defineModel({ provider: 'dead', model: 'fallback', runtime }).contextWindow, 8_192);
  });
});

test('fetch_models = false declares the list instead of asking', async () => {
  const endpoint = await startEndpoint(['should-not-be-fetched']);
  try {
    await withHome(async (homeDir) => {
      await writeFile(
        providersConfigPath(homeDir),
        [
          '[providers.declared]',
          `base_url = "${endpoint.url}"`,
          'fetch_models = false',
          '[providers.declared.models."fixed-1"]',
          'context_window = 32000',
        ].join('\n'),
      );
      const runtime = await createModelRuntimeFromConfig({ homeDir });
      assert.equal(endpoint.requests.length, 0, 'the endpoint must not be contacted');
      assert.equal(defineModel({ provider: 'declared', model: 'fixed-1', runtime }).contextWindow, 32_000);
    });
  } finally {
    await endpoint.close();
  }
});

test('an endpoint that answers with an error is reported, not silently empty', async () => {
  const endpoint = await startEndpoint([], 500);
  try {
    await withHome(async (homeDir) => {
      await writeFile(providersConfigPath(homeDir), ['[providers.broken]', `base_url = "${endpoint.url}"`].join('\n'));
      const warnings: string[] = [];
      await createModelRuntimeFromConfig({ homeDir, onWarning: (m) => warnings.push(m) });
      assert.ok(warnings.some((m) => /broken/.test(m) && /500/.test(m)), `expected the status in the warning, saw ${JSON.stringify(warnings)}`);
    });
  } finally {
    await endpoint.close();
  }
});

test('a harness built on the configured runtime can open a session on an endpoint model', async () => {
  const endpoint = await startEndpoint(['qwen3-coder']);
  try {
    await withHome(async (homeDir) => {
      const workDir = await mkdtemp(join(tmpdir(), 'operon-providers-work-'));
      await writeFile(providersConfigPath(homeDir), ['[providers.local]', `base_url = "${endpoint.url}"`].join('\n'));
      const modelRuntime = await createModelRuntimeFromConfig({ homeDir });
      const harness = await createLocalHarness({
        model: defineModel({ provider: 'local', model: 'qwen3-coder', runtime: modelRuntime }),
        homeDir,
        workDir,
        modelRuntime,
      });
      try {
        const session = await harness.createSession({ workDir });
        // The switch a /model pick performs, against a model no built-in catalog knows.
        session.setModel(defineModel({ provider: 'local', model: 'qwen3-coder', runtime: modelRuntime }));
        assert.equal(session.status.state, 'idle');
      } finally {
        await harness.close();
        await rm(workDir, { recursive: true, force: true });
      }
    });
  } finally {
    await endpoint.close();
  }
});
