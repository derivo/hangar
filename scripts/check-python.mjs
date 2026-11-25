// Part of `pnpm lint`: the proxy bay's mitmdump addon must compile (ADR 0049).
// compile() instead of `python -m py_compile`, which would leave __pycache__ behind.
import { execFileSync } from 'node:child_process';

const files = ['bays/proxy/addon/hangar_proxy.py'];
const code = 'import sys\nfor f in sys.argv[1:]: compile(open(f, "rb").read(), f, "exec")';
const python = ['python3', 'python'].find((cmd) => {
  try {
    execFileSync(cmd, ['--version'], { stdio: 'ignore' });
    return true;
  } catch {
    return false;
  }
});
if (!python) {
  console.error('check-python: no python3 or python on PATH');
  process.exit(1);
}
execFileSync(python, ['-c', code, ...files], { stdio: 'inherit' });
