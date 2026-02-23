#!/usr/bin/env node

const { spawnSync } = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');
const Module = require('module');
const { pathToFileURL } = require('url');

const repoRoot = path.resolve(__dirname, '..');

function parseArgs(argv) {
  const opts = {
    out: path.join(repoRoot, 'media', 'slurm-connect-ui.png'),
    width: 440,
    height: 1200,
    waitMs: 300,
    skipInstall: false,
    fullPage: false
  };

  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === '--out') {
      const value = argv[i + 1];
      if (!value) {
        throw new Error('Missing value for --out');
      }
      opts.out = path.resolve(process.cwd(), value);
      i += 1;
      continue;
    }
    if (arg === '--viewport') {
      const value = argv[i + 1];
      if (!value || !value.includes('x')) {
        throw new Error('Expected --viewport WIDTHxHEIGHT (for example 1280x2200)');
      }
      const [widthRaw, heightRaw] = value.split('x');
      const width = Number(widthRaw);
      const height = Number(heightRaw);
      if (!Number.isFinite(width) || !Number.isFinite(height) || width <= 0 || height <= 0) {
        throw new Error('Invalid --viewport value');
      }
      opts.width = Math.floor(width);
      opts.height = Math.floor(height);
      i += 1;
      continue;
    }
    if (arg === '--wait-ms') {
      const value = Number(argv[i + 1]);
      if (!Number.isFinite(value) || value < 0) {
        throw new Error('Expected non-negative number for --wait-ms');
      }
      opts.waitMs = Math.floor(value);
      i += 1;
      continue;
    }
    if (arg === '--skip-install') {
      opts.skipInstall = true;
      continue;
    }
    if (arg === '--full-page') {
      opts.fullPage = true;
      continue;
    }
    if (arg === '--help' || arg === '-h') {
      console.log(
        'Usage: node scripts/capture-webview-screenshot.js [--out <file>] [--viewport <WxH>] [--wait-ms <ms>] [--skip-install] [--full-page]'
      );
      process.exit(0);
    }
    throw new Error(`Unknown argument: ${arg}`);
  }

  return opts;
}

function run(cmd, args, options = {}) {
  const result = spawnSync(cmd, args, {
    cwd: options.cwd,
    encoding: 'utf8',
    stdio: options.stdio || 'pipe'
  });
  if (result.status !== 0) {
    const details = [
      `Command failed: ${[cmd, ...args].join(' ')}`,
      result.stdout || '',
      result.stderr || ''
    ]
      .join('\n')
      .trim();
    throw new Error(details);
  }
  return result;
}

function canRun(cmd, args) {
  const result = spawnSync(cmd, args, { encoding: 'utf8', stdio: 'pipe' });
  return result.status === 0;
}

function resolvePlaywrightCli() {
  const candidates = [
    { cmd: 'npx', prefix: ['--no-install', 'playwright'] },
    { cmd: 'playwright', prefix: [] },
    { cmd: 'npx', prefix: ['--yes', 'playwright'] }
  ];
  for (const candidate of candidates) {
    if (canRun(candidate.cmd, [...candidate.prefix, '--version'])) {
      return candidate;
    }
  }
  throw new Error('Could not find Playwright CLI. Install it (npm or pip) and rerun.');
}

function loadSnapshotRenderer() {
  const extensionPath = path.join(repoRoot, 'out', 'extension.js');
  const originalLoad = Module._load;

  Module._load = function patchedLoad(request, parent, isMain) {
    if (request === 'vscode') {
      return {};
    }
    return originalLoad(request, parent, isMain);
  };

  try {
    const extensionModule = require(extensionPath);
    if (typeof extensionModule.renderWebviewHtmlForSnapshot !== 'function') {
      throw new Error('renderWebviewHtmlForSnapshot export is missing. Run npm run compile and verify src/extension.ts changes.');
    }
    return extensionModule.renderWebviewHtmlForSnapshot;
  } finally {
    Module._load = originalLoad;
  }
}

function main() {
  const opts = parseArgs(process.argv.slice(2));

  console.log('Compiling extension...');
  run('npm', ['run', 'compile'], { cwd: repoRoot, stdio: 'inherit' });

  const renderWebviewHtmlForSnapshot = loadSnapshotRenderer();
  const html = renderWebviewHtmlForSnapshot({
    cspSource: 'https://snapshot.invalid',
    nonce: 'slurm-connect-snapshot'
  });

  const htmlPath = path.join(os.tmpdir(), 'slurm-connect-webview-snapshot.html');
  fs.writeFileSync(htmlPath, html, 'utf8');
  fs.mkdirSync(path.dirname(opts.out), { recursive: true });

  const cli = resolvePlaywrightCli();
  if (!opts.skipInstall) {
    console.log('Ensuring Playwright Chromium is installed...');
    run(cli.cmd, [...cli.prefix, 'install', 'chromium'], { cwd: repoRoot, stdio: 'inherit' });
  }

  console.log('Capturing screenshot...');
  const screenshotArgs = [
    ...cli.prefix,
    'screenshot',
    '--browser',
    'chromium',
    '--viewport-size',
    `${opts.width},${opts.height}`,
    '--wait-for-timeout',
    String(opts.waitMs),
    '--color-scheme',
    'light',
    pathToFileURL(htmlPath).href,
    opts.out
  ];
  if (opts.fullPage) {
    screenshotArgs.splice(screenshotArgs.length - 2, 0, '--full-page');
  }
  run(
    cli.cmd,
    screenshotArgs,
    { cwd: repoRoot, stdio: 'inherit' }
  );

  console.log(`Screenshot written to ${opts.out}`);
}

try {
  main();
} catch (error) {
  console.error(error instanceof Error ? error.message : String(error));
  process.exit(1);
}
