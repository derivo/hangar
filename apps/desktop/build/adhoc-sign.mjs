// afterPack hook. Without a certificate (no CSC_LINK) Electron's binary keeps only its
// linker signature, which does not cover the bundle: macOS then calls the downloaded app
// "damaged" with no way to open it. An ad-hoc signature turns that into "unidentified
// developer" (Privacy & Security → Open Anyway). Real signing, if configured, runs after.
import { execFileSync } from 'node:child_process';
import { join } from 'node:path';

export default async ({ electronPlatformName, appOutDir, packager }) => {
  if (electronPlatformName !== 'darwin' || process.env.CSC_LINK) return;
  const app = join(appOutDir, `${packager.appInfo.productFilename}.app`);
  execFileSync('codesign', ['--force', '--deep', '--sign', '-', app], { stdio: 'inherit' });
};
