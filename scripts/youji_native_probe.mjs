import { createRequire } from 'node:module';
import { pathToFileURL } from 'node:url';
import path from 'node:path';
const root = createRequire(path.resolve('web/package.json'));
const chains = {
  rolldown: ['vite', 'rolldown'],
  oxide: ['@tailwindcss/vite', '@tailwindcss/oxide'],
  lightningcss: ['vite', 'lightningcss'],
};
try {
  let resolver = root;
  let target;
  const chain = chains[process.argv[2]];
  if (!chain) process.exit(99);
  for (const name of chain) {
    target = resolver.resolve(name);
    resolver = createRequire(target);
  }
  await import(pathToFileURL(target).href);
  process.exit(0);
} catch (error) {
  const code = error?.code;
  process.exit(['MODULE_NOT_FOUND', 'ERR_MODULE_NOT_FOUND'].includes(code) ? 21
    : ['EACCES', 'EPERM', 'ENOENT'].includes(code) ? 23
    : code === 'ERR_DLOPEN_FAILED' || /native binding|\.node|DLL/i.test(String(error?.message)) ? 22 : 29);
}
