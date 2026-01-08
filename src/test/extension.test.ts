import * as assert from 'assert';
import {
  buildHostEntry,
  buildTemporarySshConfigContent,
  formatSshConfigValue
} from '../utils/sshConfig';
import { parsePartitionInfoOutput } from '../utils/clusterInfo';

function testFormatSshConfigValue(): void {
  assert.strictEqual(formatSshConfigValue('simple'), 'simple');
  assert.strictEqual(formatSshConfigValue('path with space'), '"path with space"');
  assert.strictEqual(formatSshConfigValue('"already quoted"'), '"already quoted"');

  const windowsPath = 'C:\\Users\\Test User\\id_rsa';
  assert.strictEqual(
    formatSshConfigValue(windowsPath),
    '"C:\\\\Users\\\\Test User\\\\id_rsa"'
  );
}

function testBuildHostEntryQuotes(): void {
  const cfg = {
    user: '',
    requestTTY: false,
    forwardAgent: false,
    identityFile: '/Users/Test User/.ssh/id_rsa',
    additionalSshOptions: {
      LocalCommand: 'echo hello world'
    }
  };

  const entry = buildHostEntry('alias', 'login.example.com', cfg, 'echo hi');
  assert.ok(entry.includes('IdentityFile "/Users/Test User/.ssh/id_rsa"'));
  assert.ok(entry.includes('LocalCommand "echo hello world"'));
}

function testBuildTemporarySshConfigContentIncludes(): void {
  const content = buildTemporarySshConfigContent('Host alias\n  HostName login', [
    '/Users/Test User/.ssh/config'
  ]);
  assert.ok(content.includes('Include "/Users/Test User/.ssh/config"'));
}

function testParsePartitionInfoOutputNodeNames(): void {
  const output = 'gpu*|2gpu-01|64|128000|gpu:a100:4';
  const info = parsePartitionInfoOutput(output);
  assert.strictEqual(info.partitions[0].nodes, 1);

  const outputWithCount = 'cpu|10|32|64000|';
  const infoWithCount = parsePartitionInfoOutput(outputWithCount);
  assert.strictEqual(infoWithCount.partitions[0].nodes, 10);
}

function run(): void {
  testFormatSshConfigValue();
  testBuildHostEntryQuotes();
  testBuildTemporarySshConfigContentIncludes();
  testParsePartitionInfoOutputNodeNames();
  console.log('extension tests passed');
}

run();
