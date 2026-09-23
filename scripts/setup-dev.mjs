// Maintainer-only source dependency setup. End users load the committed bundles.
// Links a built relay-driver checkout (the recorded-execution and evidence
// substrate) into node_modules; its compiled code is bundled into dist/.
import { resolve, join } from 'node:path';
import { access, mkdir, realpath, symlink, lstat, readFile } from 'node:fs/promises';
const source = resolve(process.argv[2] ?? process.env.RELAY_DRIVER_SOURCE ?? '../relay-driver');
for (const name of ['core', 'host-sdk', 'remote-runtime']) {
  const target = await realpath(join(source, 'packages', name));
  const manifest = JSON.parse(await readFile(join(target, 'package.json'), 'utf8'));
  await access(join(target, manifest.main));
  const link = resolve('node_modules', '@wezzard', `relay-driver-${name}`);
  await mkdir(resolve('node_modules', '@wezzard'), { recursive: true });
  try { await lstat(link); if (await realpath(link) !== target) throw Error(`Refusing to replace existing dependency: ${link}`); }
  catch (e) { if (e.code !== 'ENOENT') throw e; await symlink(target, link, 'dir'); }
}
console.log('Linked built relay-driver source for development only. Consumers do not need this checkout.');
