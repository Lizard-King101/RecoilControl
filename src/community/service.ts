import { createServer } from 'node:http';
import { randomBytes } from 'node:crypto';
import { maxPackageBytes, validateGamePack } from './package';
import type { PackRepository } from './repository';

/** Loopback development service. Hosted authentication/ownership is a separate adapter. */
export async function startLibraryService(repository: PackRepository, port = 0, token = randomBytes(32).toString('hex')) {
  let url = '';
  let mutation = Promise.resolve<unknown>(undefined);
  const serialize = <T>(task: () => Promise<T>) => { const result = mutation.then(task); mutation = result.catch(() => {}); return result; };
  const server = createServer(async (req, res) => {
    const send = (status: number, body: unknown) => { res.writeHead(status, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff' }); res.end(JSON.stringify(body)); };
    if (!url || req.headers.host !== new URL(url).host || req.headers.origin || req.headers.authorization !== `Bearer ${token}`) { req.resume(); send(403, { error: 'Library access denied.' }); return; }
    const path = new URL(req.url ?? '/', url).pathname, match = /^\/v1\/packs\/([a-f0-9]{64})$/.exec(path);
    try {
      if (req.method === 'GET' && path === '/v1/packs') { send(200, { packs: await repository.list() }); return; }
      if (req.method === 'GET' && match) { const row = await repository.get(match[1]); send(row ? 200 : 404, row ?? { error: 'Pack not found.' }); return; }
      if (req.method === 'DELETE' && match) { await serialize(() => repository.remove(match[1])); send(200, { removed: true }); return; }
      if (req.method !== 'POST' || path !== '/v1/packs') { req.resume(); send(404, { error: 'Unknown library route.' }); return; }
      if (req.headers['content-type'] !== 'application/json') { req.resume(); send(415, { error: 'Send a JSON game pack.' }); return; }
      if (Number(req.headers['content-length']) > maxPackageBytes) { req.resume(); send(413, { error: 'Game packs must be smaller than 2 MB.' }); return; }
      let length = 0; const chunks: Buffer[] = [];
      for await (const chunk of req) { length += chunk.length; if (length <= maxPackageBytes) chunks.push(chunk); }
      if (length > maxPackageBytes) { send(413, { error: 'Game packs must be smaller than 2 MB.' }); return; }
      const pack = validateGamePack(JSON.parse(Buffer.concat(chunks).toString('utf8')));
      send(201, await serialize(() => repository.publish(pack)));
    } catch (error) { if (!res.headersSent) send(400, { error: error instanceof Error ? error.message : 'Library request failed.' }); }
  });
  server.requestTimeout = 10000; server.headersTimeout = 10000; server.setTimeout(15000);
  await new Promise<void>((resolve, reject) => { server.once('error', reject); server.listen(port, '127.0.0.1', resolve); });
  const address = server.address(); if (!address || typeof address === 'string') throw new Error('Library did not start.');
  url = `http://127.0.0.1:${address.port}`;
  return { url, token, close: () => { server.closeAllConnections(); server.close(); } };
}
export async function libraryRequest<T = unknown>(service: { url: string; token: string }, path: string, method = 'GET', body?: unknown): Promise<T> {
  if (!/^\/v1\/packs(?:\/[a-f0-9]{64})?$/.test(path)) throw new Error('Invalid library route.');
  const response = await fetch(`${service.url}${path}`, { method, headers: { Authorization: `Bearer ${service.token}`, ...(body === undefined ? {} : { 'Content-Type': 'application/json' }) }, body: body === undefined ? undefined : JSON.stringify(body), signal: AbortSignal.timeout(10000), redirect: 'error' });
  const result = await response.json();
  if (!response.ok) throw new Error(result && typeof result === 'object' && 'error' in result ? String(result.error) : 'Library request failed.');
  return result as T;
}
