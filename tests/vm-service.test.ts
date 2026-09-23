import assert from "node:assert/strict";
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { once } from "node:events";
import test from "node:test";
import { AcquireIndeterminateError, VmService, VmServiceError, type VmLease } from "../src/vm-service.js";

const lease: VmLease = {
  vm: "pilot-test-abc123", purpose: "test", image: "ubuntu2404", image_kind: "linux", env: null,
  state: "running", created_at: 1000, ttl_expires_at: 4600, grace_until: null, warned: false,
  ip: "192.168.64.10", cpu: null, memory_mb: null, disk_gb: null,
};
async function server(t: test.TestContext, handler: (req: IncomingMessage, res: ServerResponse) => void) {
  const instance = createServer(handler);
  instance.listen(0, "127.0.0.1");
  await once(instance, "listening");
  t.after(() => { instance.closeAllConnections(); instance.close(); });
  const address = instance.address();
  assert(address && typeof address !== "string");
  return `http://127.0.0.1:${address.port}`;
}
function json(res: ServerResponse, body: unknown) { res.setHeader("content-type", "application/json"); res.end(JSON.stringify(body)); }

test("loopback origins only; bounded positive configuration", () => {
  assert.equal(new VmService().baseUrl, "http://localhost:6240");
  for (const url of ["http://example.com", "http://192.0.2.1:6240", "http://localhost/path", "http://a@localhost", "file:///etc/passwd", "http://localhost?x=1"]) {
    assert.throws(() => new VmService(url), /loopback/);
  }
  assert.equal(new VmService("http://[::1]:6240/").baseUrl, "http://[::1]:6240");
  assert.throws(() => new VmService({ timeoutMs: 0 }), /positive/);
});

test('application discovery uses only GET /applications and forwards cancellation', async t => {
  const paths: string[] = [];
  const catalog = { schemaVersion: 1, images: [] };
  const url = await server(t, (req, res) => {
    paths.push(`${req.method} ${req.url}`);
    json(res, catalog);
  });
  const client = new VmService(url);
  assert.deepEqual(await client.applications(), catalog);
  assert.deepEqual(paths, ['GET /applications']);
  const abort = new AbortController(); abort.abort();
  await assert.rejects(client.applications({ signal: abort.signal }));
  assert.deepEqual(paths, ['GET /applications']);
});

test("actual endpoint paths, request bodies, and daemon response shapes", async t => {
  const requests: { path: string; method: string; body: unknown }[] = [];
  const responses: Record<string, unknown> = {
    "/health": { ok: true, service: "vm-service" },
    "/images": { images: {}, capacity: { macos_running: 0, macos_limit: 2 } },
    "/vms": { vms: { [lease.vm]: { ...lease, ttl_hours_remaining: 1, actually_running: true } }, limits: { max_macos_running: 2, grace_hours: 6 }, pilot_repo: "/pilot", port: 6240 },
    "/acquire": lease,
    [`/vms/${lease.vm}`]: { ...lease, ttl_hours_remaining: 1, actually_running: true },
    [`/vms/${lease.vm}/exec`]: { vm: lease.vm, rc: 7, output: "combined stderr and stdout" },
    [`/vms/${lease.vm}/push`]: { vm: lease.vm, pushed: "/local", to: "/remote" },
    [`/vms/${lease.vm}/pull`]: { vm: lease.vm, pulled: "/remote", to: "/local" },
    [`/vms/${lease.vm}/heartbeat`]: { ...lease, ttl_hours_remaining: 1 },
    [`/vms/${lease.vm}/release`]: { vm: lease.vm, released: true, reason: "done" },
  };
  const baseUrl = await server(t, (req, res) => {
    let body = "";
    req.on("data", chunk => { body += chunk; });
    req.on("end", () => {
      requests.push({ path: req.url!, method: req.method!, body: body ? JSON.parse(body) : undefined });
      json(res, responses[req.url!]);
    });
  });
  const client = new VmService(baseUrl);
  assert.equal((await client.health()).ok, true);
  assert.deepEqual((await client.images()).images, {});
  assert.equal((await client.list()).vms[lease.vm]?.ip, lease.ip);
  assert.deepEqual(await client.acquire({ purpose: "test", image: "ubuntu2404", env: "none" }), lease);
  assert.equal((await client.get(lease.vm)).actually_running, true);
  assert.equal((await client.exec(lease.vm, { script: "exit 7", timeout: 20 })).rc, 7);
  assert.equal((await client.push(lease.vm, { local_path: "/local", remote_path: "/remote" })).pushed, "/local");
  assert.equal((await client.pull(lease.vm, { local_path: "/local", remote_path: "/remote" })).pulled, "/remote");
  assert.equal((await client.heartbeat(lease.vm, { ttl_hours: 2 })).ttl_hours_remaining, 1);
  assert.equal((await client.release(lease.vm, { reason: "done" })).released, true);
  assert.deepEqual(requests.map(r => r.path), Object.keys(responses));
  assert.deepEqual(requests[5]?.body, { script: "exit 7", timeout: 20 });
  assert.equal(requests[3]?.method, "POST");
  assert.throws(() => client.exec("../bad", { argv: ["true"] }), /Invalid VM/);
});

test("bounded HTTP errors preserve status, do not auto retry", async t => {
  let count = 0;
  const client = new VmService(await server(t, (_req, res) => { count++; res.writeHead(409); res.end("x".repeat(50_000)); }));
  await assert.rejects(client.acquire({ purpose: "test" }), (error: unknown) => {
    assert(error instanceof VmServiceError);
    assert.equal(error.status, 409);
    assert.equal(error.responseBody?.length, 4096);
    assert(error.message.length < 4300);
    return true;
  });
  assert.equal(count, 1);
});

test("invalid JSON, oversized success, and redirects are rejected", async t => {
  const baseUrl = await server(t, (req, res) => {
    if (req.url === "/health") res.end("not json");
    else if (req.url === "/vms") res.end("x".repeat(1000));
    else { res.writeHead(302, { location: "http://example.com" }); res.end(); }
  });
  const client = new VmService({ baseUrl, maxResponseBytes: 100 });
  await assert.rejects(client.health(), /invalid JSON/);
  await assert.rejects(client.list(), /exceeds 100/);
  await assert.rejects(client.images(), /request failed/);
});

test("deadlines bound stalled response bodies and caller abort works", async t => {
  const baseUrl = await server(t, (_req, res) => { res.writeHead(200); res.write("{"); });
  const client = new VmService({ baseUrl, timeoutMs: 50 });
  await assert.rejects(client.health(), /timed out/);
  const controller = new AbortController();
  const request = client.list({ signal: controller.signal, timeoutMs: 1000 });
  controller.abort(new Error("caller stopped"));
  await assert.rejects(request, /caller stopped/);
});

test("acquire ignores cancellation after dispatch and returns lease for tracked cleanup", async t => {
  const controller = new AbortController();
  let calls = 0;
  const client = new VmService(await server(t, (_req, res) => {
    calls++;
    controller.abort(new Error("cancelled while provisioning"));
    setTimeout(() => json(res, lease), 30);
  }));
  const result = await client.acquire({ purpose: "test" }, { signal: controller.signal });
  assert.deepEqual(result, lease);
  assert.equal(calls, 1);
  await assert.rejects(client.acquire({ purpose: "test" }, { signal: controller.signal }), /cancelled while provisioning/);
  assert.equal(calls, 1);
});

test("lost acquire response is explicitly indeterminate; malformed lease is not trusted", async t => {
  const baseUrl = await server(t, (_req, res) => { json(res, { vm: "pilot-only-name" }); });
  await assert.rejects(new VmService(baseUrl).acquire({ purpose: "test" }), (error: unknown) => {
    assert(error instanceof AcquireIndeterminateError);
    assert.equal(error.purpose, "test");
    return true;
  });
  const stalled = await server(t, () => {});
  await assert.rejects(new VmService({ baseUrl: stalled, acquireTimeoutMs: 30 }).acquire({ purpose: "test" }), AcquireIndeterminateError);
});
