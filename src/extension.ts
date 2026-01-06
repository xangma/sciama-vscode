import * as vscode from 'vscode';
import * as os from 'os';
import * as path from 'path';
import * as fs from 'fs/promises';
import { execFile } from 'child_process';
import { promisify } from 'util';

const execFileAsync = promisify(execFile);

interface SciamaConfig {
  loginHosts: string[];
  loginHostsCommand: string;
  loginHostsQueryHost: string;
  partitionCommand: string;
  partitionInfoCommand: string;
  qosCommand: string;
  accountCommand: string;
  user: string;
  identityFile: string;
  forwardAgent: boolean;
  requestTTY: boolean;
  moduleLoad: string;
  proxyCommand: string;
  proxyArgs: string[];
  extraSallocArgs: string[];
  promptForExtraSallocArgs: boolean;
  defaultPartition: string;
  defaultNodes: number;
  defaultTasksPerNode: number;
  defaultCpusPerTask: number;
  defaultTime: string;
  defaultMemoryMb: number;
  defaultGpuType: string;
  defaultGpuCount: number;
  sshHostPrefix: string;
  connectAfterCreate: boolean;
  openInNewWindow: boolean;
  remoteWorkspacePath: string;
  temporarySshConfigPath: string;
  restoreSshConfigAfterConnect: boolean;
  additionalSshOptions: Record<string, string>;
  sshQueryConfigPath: string;
  sshConnectTimeoutSeconds: number;
}

interface PartitionResult {
  partitions: string[];
  defaultPartition?: string;
}

interface PartitionInfo {
  name: string;
  nodes: number;
  cpus: number;
  memMb: number;
  gpuMax: number;
  gpuTypes: Record<string, number>;
  isDefault: boolean;
}

interface ClusterInfo {
  partitions: PartitionInfo[];
  defaultPartition?: string;
}

let outputChannel: vscode.OutputChannel | undefined;
let extensionStoragePath: string | undefined;
let extensionGlobalState: vscode.Memento | undefined;

export function activate(context: vscode.ExtensionContext): void {
  extensionStoragePath = context.globalStorageUri.fsPath;
  extensionGlobalState = context.globalState;
  const disposable = vscode.commands.registerCommand('sciamaSlurm.connect', () => {
    void connectCommand();
  });
  context.subscriptions.push(disposable);

  const viewProvider = new SlurmConnectViewProvider(context);
  context.subscriptions.push(
    vscode.window.registerWebviewViewProvider('sciamaSlurm.connectView', viewProvider)
  );
}

export function deactivate(): void {
  // No-op
}

function getOutputChannel(): vscode.OutputChannel {
  if (!outputChannel) {
    outputChannel = vscode.window.createOutputChannel('Sciama Slurm');
  }
  return outputChannel;
}

interface UiValues {
  loginHosts: string;
  loginHostsCommand: string;
  loginHostsQueryHost: string;
  partitionCommand: string;
  partitionInfoCommand: string;
  qosCommand: string;
  accountCommand: string;
  user: string;
  identityFile: string;
  moduleLoad: string;
  proxyCommand: string;
  proxyArgs: string;
  extraSallocArgs: string;
  promptForExtraSallocArgs: boolean;
  defaultPartition: string;
  defaultNodes: string;
  defaultTasksPerNode: string;
  defaultCpusPerTask: string;
  defaultTime: string;
  defaultMemoryMb: string;
  defaultGpuType: string;
  defaultGpuCount: string;
  sshHostPrefix: string;
  forwardAgent: boolean;
  requestTTY: boolean;
  connectAfterCreate: boolean;
  temporarySshConfigPath: string;
  restoreSshConfigAfterConnect: boolean;
  sshQueryConfigPath: string;
  openInNewWindow: boolean;
  remoteWorkspacePath: string;
}

function getConfig(): SciamaConfig {
  const cfg = vscode.workspace.getConfiguration('sciamaSlurm');
  const user = (cfg.get<string>('user') || '').trim();
  return {
    loginHosts: cfg.get<string[]>('loginHosts', []),
    loginHostsCommand: (cfg.get<string>('loginHostsCommand') || '').trim(),
    loginHostsQueryHost: (cfg.get<string>('loginHostsQueryHost') || '').trim(),
    partitionCommand: (cfg.get<string>('partitionCommand') || '').trim(),
    partitionInfoCommand: (cfg.get<string>('partitionInfoCommand') || '').trim(),
    qosCommand: (cfg.get<string>('qosCommand') || '').trim(),
    accountCommand: (cfg.get<string>('accountCommand') || '').trim(),
    user,
    identityFile: (cfg.get<string>('identityFile') || '').trim(),
    forwardAgent: cfg.get<boolean>('forwardAgent', true),
    requestTTY: cfg.get<boolean>('requestTTY', true),
    moduleLoad: (cfg.get<string>('moduleLoad') || '').trim(),
    proxyCommand: (cfg.get<string>('proxyCommand') || '').trim(),
    proxyArgs: cfg.get<string[]>('proxyArgs', []),
    extraSallocArgs: cfg.get<string[]>('extraSallocArgs', []),
    promptForExtraSallocArgs: cfg.get<boolean>('promptForExtraSallocArgs', false),
    defaultPartition: (cfg.get<string>('defaultPartition') || '').trim(),
    defaultNodes: cfg.get<number>('defaultNodes', 1),
    defaultTasksPerNode: cfg.get<number>('defaultTasksPerNode', 1),
    defaultCpusPerTask: cfg.get<number>('defaultCpusPerTask', 1),
    defaultTime: (cfg.get<string>('defaultTime') || '').trim(),
    defaultMemoryMb: cfg.get<number>('defaultMemoryMb', 0),
    defaultGpuType: (cfg.get<string>('defaultGpuType') || '').trim(),
    defaultGpuCount: cfg.get<number>('defaultGpuCount', 0),
    sshHostPrefix: (cfg.get<string>('sshHostPrefix') || '').trim(),
    connectAfterCreate: cfg.get<boolean>('connectAfterCreate', true),
    openInNewWindow: cfg.get<boolean>('openInNewWindow', false),
    remoteWorkspacePath: (cfg.get<string>('remoteWorkspacePath') || '').trim(),
    temporarySshConfigPath: (cfg.get<string>('temporarySshConfigPath') || '').trim(),
    restoreSshConfigAfterConnect: cfg.get<boolean>('restoreSshConfigAfterConnect', true),
    additionalSshOptions: cfg.get<Record<string, string>>('additionalSshOptions', {}),
    sshQueryConfigPath: (cfg.get<string>('sshQueryConfigPath') || '').trim(),
    sshConnectTimeoutSeconds: cfg.get<number>('sshConnectTimeoutSeconds', 15)
  };
}

function getConfigWithOverrides(overrides?: Partial<SciamaConfig>): SciamaConfig {
  const base = getConfig();
  if (!overrides) {
    return base;
  }
  return {
    ...base,
    ...overrides
  };
}

class SlurmConnectViewProvider implements vscode.WebviewViewProvider {
  private view?: vscode.WebviewView;

  constructor(private readonly context: vscode.ExtensionContext) {}

  resolveWebviewView(view: vscode.WebviewView): void {
    this.view = view;
    const webview = view.webview;
    webview.options = {
      enableScripts: true,
      localResourceRoots: [this.context.extensionUri]
    };

    webview.html = getWebviewHtml(webview);
    webview.onDidReceiveMessage(async (message) => {
      switch (message.command) {
        case 'ready': {
          const values = getUiValuesFromConfig(getConfig());
          const host = firstLoginHostFromInput(values.loginHosts);
          const cached = host ? getCachedClusterInfo(host) : undefined;
          webview.postMessage({
            command: 'load',
            values,
            clusterInfo: cached?.info,
            clusterInfoCachedAt: cached?.fetchedAt
          });
          break;
        }
        case 'save': {
          const target = message.target === 'workspace'
            ? vscode.ConfigurationTarget.Workspace
            : vscode.ConfigurationTarget.Global;
          const uiValues = message.values as UiValues;
          await updateConfigFromUi(uiValues, target);
          if (message.connect) {
            await connectCommand(buildOverridesFromUi(uiValues), { interactive: false });
          } else {
            void vscode.window.showInformationMessage('Sciama Slurm settings saved.');
          }
          break;
        }
        case 'getClusterInfo': {
          const uiValues = message.values as UiValues;
          await handleClusterInfoRequest(uiValues, webview);
          break;
        }
        case 'openSettings': {
          void vscode.commands.executeCommand('workbench.action.openSettings', 'sciamaSlurm');
          break;
        }
        default:
          break;
      }
    });
  }
}

async function connectCommand(
  overrides?: Partial<SciamaConfig>,
  options?: { interactive?: boolean }
): Promise<void> {
  const cfg = getConfigWithOverrides(overrides);
  const interactive = options?.interactive !== false;
  const log = getOutputChannel();
  log.clear();
  log.appendLine('Sciama Slurm connect started.');

  const loginHosts = await resolveLoginHosts(cfg);
  log.appendLine(`Login hosts resolved: ${loginHosts.join(', ') || '(none)'}`);
  if (loginHosts.length === 0) {
    void vscode.window.showErrorMessage('No login hosts available. Configure sciamaSlurm.loginHosts or loginHostsCommand.');
    return;
  }

  let loginHost: string | undefined;
  if (loginHosts.length === 1) {
    loginHost = loginHosts[0];
  } else if (interactive) {
    loginHost = await pickFromList('Select login host', loginHosts, true);
  } else {
    loginHost = loginHosts[0];
    log.appendLine(`Using first login host: ${loginHost}`);
  }
  if (!loginHost) {
    return;
  }

  let partition: string | undefined;
  let qos: string | undefined;
  let account: string | undefined;

  if (interactive) {
    const { partitions, defaultPartition } = await vscode.window.withProgress(
      {
        location: vscode.ProgressLocation.Notification,
        title: 'Querying Slurm resources',
        cancellable: false
      },
      async () => {
        const partitionResult = await queryPartitions(loginHost, cfg);
        return partitionResult;
      }
    );

    const partitionPick = await pickPartition(partitions, cfg.defaultPartition || defaultPartition);
    if (partitionPick === null) {
      return;
    }
    partition = partitionPick;

    qos = await pickOptionalValue('Select QoS (optional)', await querySimpleList(loginHost, cfg, cfg.qosCommand));
    account = await pickOptionalValue(
      'Select account (optional)',
      await querySimpleList(loginHost, cfg, cfg.accountCommand)
    );
  } else {
    partition = cfg.defaultPartition || undefined;
  }

  let nodes = cfg.defaultNodes;
  let tasksPerNode = cfg.defaultTasksPerNode;
  let cpusPerTask = cfg.defaultCpusPerTask;
  let time = cfg.defaultTime;
  let memoryMb = cfg.defaultMemoryMb;
  let gpuType = cfg.defaultGpuType;
  let gpuCount = cfg.defaultGpuCount;

  if (interactive) {
    const nodesInput = await promptNumber('Nodes', cfg.defaultNodes, 1);
    if (!nodesInput) {
      return;
    }
    nodes = nodesInput;

    const tasksInput = await promptNumber('Tasks per node', cfg.defaultTasksPerNode, 1);
    if (!tasksInput) {
      return;
    }
    tasksPerNode = tasksInput;

    const cpusInput = await promptNumber('CPUs per task', cfg.defaultCpusPerTask, 1);
    if (!cpusInput) {
      return;
    }
    cpusPerTask = cpusInput;

    const timeInput = await promptTime('Wall time', cfg.defaultTime || '01:00:00');
    if (!timeInput) {
      return;
    }
    time = timeInput;
  } else {
    if (!nodes || nodes < 1) {
      void vscode.window.showErrorMessage('Default nodes is not set. Fill it in the side panel or settings.');
      return;
    }
    if (!tasksPerNode || tasksPerNode < 1) {
      void vscode.window.showErrorMessage('Default tasks per node is not set. Fill it in the side panel or settings.');
      return;
    }
    if (!cpusPerTask || cpusPerTask < 1) {
      void vscode.window.showErrorMessage('Default CPUs per task is not set. Fill it in the side panel or settings.');
      return;
    }
    if (!time) {
      void vscode.window.showErrorMessage('Default wall time is not set. Fill it in the side panel or settings.');
      return;
    }
  }

  let extraArgs: string[] = [];
  if (interactive && cfg.promptForExtraSallocArgs) {
    const extra = await vscode.window.showInputBox({
      title: 'Extra salloc args (optional)',
      prompt: 'Example: --gres=gpu:1 --mem=32G',
      placeHolder: '--gres=gpu:1'
    });
    if (extra && extra.trim().length > 0) {
      extraArgs = splitArgs(extra.trim());
    }
  }

  const sallocArgs = buildSallocArgs({
    partition,
    nodes,
    tasksPerNode,
    cpusPerTask,
    time,
    memoryMb,
    gpuType,
    gpuCount,
    qos,
    account
  });
  const remoteCommand = buildRemoteCommand(cfg, [...sallocArgs, ...cfg.extraSallocArgs, ...extraArgs]);
  if (!remoteCommand) {
    void vscode.window.showErrorMessage('RemoteCommand is empty. Check sciamaSlurm.proxyCommand.');
    return;
  }

  const defaultAlias = buildDefaultAlias(cfg.sshHostPrefix || 'sciama', loginHost, partition, nodes, cpusPerTask);
  let alias = defaultAlias;
  if (interactive) {
    const aliasInput = await vscode.window.showInputBox({
      title: 'SSH host alias',
      value: defaultAlias,
      prompt: 'This name will appear in your SSH config and Remote-SSH hosts list.',
      validateInput: (value) => (value.trim().length === 0 ? 'Alias is required.' : undefined)
    });
    if (!aliasInput) {
      return;
    }
    alias = aliasInput.trim();
  }

  const hostEntry = buildHostEntry(alias.trim(), loginHost, cfg, remoteCommand);
  log.appendLine('Generated SSH host entry:');
  log.appendLine(hostEntry);

  let tempConfigPath: string | undefined;
  let previousRemoteConfig: string | undefined;

  try {
    tempConfigPath = await writeTemporarySshConfig(alias.trim(), hostEntry, cfg);
  } catch (error) {
    void vscode.window.showErrorMessage(`Failed to write temporary SSH config: ${formatError(error)}`);
    return;
  }

  await ensureRemoteSshSettings();
  const remoteCfg = vscode.workspace.getConfiguration('remote.SSH');
  previousRemoteConfig = remoteCfg.get<string>('configFile') || '';
  await remoteCfg.update('configFile', tempConfigPath, vscode.ConfigurationTarget.Global);
  await delay(300);
  await refreshRemoteSshHosts();

  if (cfg.connectAfterCreate) {
    const connected = await connectToHost(
      alias.trim(),
      cfg.openInNewWindow,
      cfg.remoteWorkspacePath
    );
    if (!connected) {
      void vscode.window.showWarningMessage(
        `SSH host "${alias.trim()}" created, but auto-connect failed. Use Remote-SSH to connect.`,
        'Show Output'
      ).then((selection) => {
        if (selection === 'Show Output') {
          getOutputChannel().show(true);
        }
      });
    }
  } else {
    void vscode.window.showInformationMessage(`SSH host "${alias.trim()}" created.`);
  }

  if (cfg.restoreSshConfigAfterConnect) {
    await delay(2000);
    const remoteCfg = vscode.workspace.getConfiguration('remote.SSH');
    const restored = previousRemoteConfig || undefined;
    await remoteCfg.update('configFile', restored, vscode.ConfigurationTarget.Global);
  }
}

async function resolveLoginHosts(cfg: SciamaConfig): Promise<string[]> {
  let hosts = cfg.loginHosts.slice();
  if (cfg.loginHostsCommand) {
    let queryHost: string | undefined = cfg.loginHostsQueryHost || hosts[0];
    if (!queryHost) {
      queryHost = await vscode.window.showInputBox({
        title: 'Login host for discovery',
        prompt: 'Enter a login host to run the loginHostsCommand on.'
      });
    }
    if (queryHost) {
      try {
        const output = await runSshCommand(queryHost, cfg, cfg.loginHostsCommand);
        const discovered = parseSimpleList(output);
        if (discovered.length > 0) {
          hosts = discovered;
        }
      } catch (error) {
        void vscode.window.showWarningMessage(`Failed to query login hosts: ${formatError(error)}`);
      }
    }
  }

  hosts = uniqueList(hosts);
  if (hosts.length === 0) {
    const manual = await vscode.window.showInputBox({
      title: 'Login host',
      prompt: 'Enter a login host'
    });
    if (manual) {
      hosts = [manual.trim()];
    }
  }
  return hosts;
}

async function queryPartitions(loginHost: string, cfg: SciamaConfig): Promise<PartitionResult> {
  if (!cfg.partitionCommand) {
    return { partitions: [] };
  }
  try {
    const output = await runSshCommand(loginHost, cfg, cfg.partitionCommand);
    return parsePartitionOutput(output);
  } catch (error) {
    void vscode.window.showWarningMessage(`Failed to query partitions: ${formatError(error)}`);
    return { partitions: [] };
  }
}

async function querySimpleList(loginHost: string, cfg: SciamaConfig, command: string): Promise<string[]> {
  if (!command) {
    return [];
  }
  try {
    const output = await runSshCommand(loginHost, cfg, command);
    return parseSimpleList(output);
  } catch (error) {
    void vscode.window.showWarningMessage(`Failed to query resources: ${formatError(error)}`);
    return [];
  }
}

async function handleClusterInfoRequest(values: UiValues, webview: vscode.Webview): Promise<void> {
  const overrides = buildOverridesFromUi(values);
  const cfg = getConfigWithOverrides(overrides);
  const loginHosts = parseListInput(values.loginHosts);
  const log = getOutputChannel();

  if (loginHosts.length === 0) {
    const message = 'Enter a login host before fetching cluster info.';
    void vscode.window.showErrorMessage(message);
    webview.postMessage({ command: 'clusterInfoError', message });
    return;
  }

  const loginHost = loginHosts[0];
  log.appendLine(`Fetching cluster info from ${loginHost}...`);

  try {
    const info = await fetchClusterInfo(loginHost, cfg);
    cacheClusterInfo(loginHost, info);
    webview.postMessage({ command: 'clusterInfo', info });
  } catch (error) {
    const message = formatError(error);
    void vscode.window.showErrorMessage(`Failed to fetch cluster info: ${message}`);
    webview.postMessage({ command: 'clusterInfoError', message });
  }
}

async function fetchClusterInfo(loginHost: string, cfg: SciamaConfig): Promise<ClusterInfo> {
  const commands = [
    cfg.partitionInfoCommand,
    'sinfo -h -N -o "%P|%n|%c|%m|%G"',
    'sinfo -h -o "%P|%D|%c|%m|%G"'
  ].filter(Boolean);

  let lastInfo: ClusterInfo = { partitions: [] };
  const log = getOutputChannel();
  for (const command of commands) {
    log.appendLine(`Cluster info command: ${command}`);
    const output = await runSshCommand(loginHost, cfg, command);
    const info = parsePartitionInfoOutput(output);
    lastInfo = info;
    const maxFields = getMaxFieldCount(output);
    const outputHasGpu = output.includes('gpu:');
    const hasGpu = info.partitions.some((partition) => partition.gpuMax > 0);
    log.appendLine(`Cluster info fields: ${maxFields}, partitions: ${info.partitions.length}, outputHasGpu: ${outputHasGpu}, hasGpu: ${hasGpu}`);
    if (outputHasGpu && !hasGpu) {
      log.appendLine('GPU data present but parse yielded none; trying next command.');
      continue;
    }
    if (maxFields < 5) {
      continue;
    }
    if (hasMeaningfulClusterInfo(info)) {
      return info;
    }
  }
  return lastInfo;
}

function hasMeaningfulClusterInfo(info: ClusterInfo): boolean {
  if (!info.partitions || info.partitions.length === 0) {
    return false;
  }
  return info.partitions.some((partition) =>
    partition.cpus > 0 || partition.memMb > 0 || partition.gpuMax > 0
  );
}

function getMaxFieldCount(output: string): number {
  const lines = output.split(/\r?\n/).filter((line) => line.trim().length > 0);
  let max = 0;
  for (const line of lines) {
    const count = line.split('|').length;
    if (count > max) {
      max = count;
    }
  }
  return max;
}

function parsePartitionInfoOutput(output: string): ClusterInfo {
  const lines = output.split(/\r?\n/).map((line) => line.trim()).filter(Boolean);
  const partitions = new Map<string, PartitionInfo>();
  const nodeSets = new Map<string, Set<string>>();
  let defaultPartition: string | undefined;

  for (const line of lines) {
    const fields = line.split('|').map((value) => value.trim());
    if (fields.length < 3) {
      continue;
    }
    const rawName = fields[0];
    const field1 = fields[1] || '';
    const field2 = fields[2] || '';
    const field3 = fields[3] || '';
    const field4 = fields[4] || '';
    if (!rawName) {
      continue;
    }

    const isField1Numeric = /^\d/.test(field1);
    const nodeName = !isField1Numeric && field1 ? field1 : undefined;
    const nodesCount = isField1Numeric ? parseNumericField(field1) : 0;
    const cpusRaw = field2;
    const memRaw = field3;
    const gresRaw = field4;
    const cpus = parseNumericField(cpusRaw.includes('/') ? cpusRaw.split('/').pop() || '' : cpusRaw);
    const memMb = parseNumericField(memRaw);
    const gresInfo = parseGresInfo(gresRaw || '');

    const partitionNames = rawName.split(',').map((part) => part.trim()).filter(Boolean);
    for (const partitionName of partitionNames) {
      const isDefault = partitionName.includes('*');
      const name = partitionName.replace(/\*/g, '');
      if (isDefault && !defaultPartition) {
        defaultPartition = name;
      }

      const existing = partitions.get(name) || {
        name,
        nodes: 0,
        cpus: 0,
        memMb: 0,
        gpuMax: 0,
        gpuTypes: {},
        isDefault
      };

      if (nodeName) {
        if (!nodeSets.has(name)) {
          nodeSets.set(name, new Set());
        }
        nodeSets.get(name)?.add(nodeName);
      } else if (nodesCount) {
        existing.nodes = Math.max(existing.nodes, nodesCount);
      }

      existing.cpus = Math.max(existing.cpus, cpus);
      existing.memMb = Math.max(existing.memMb, memMb);
      existing.gpuMax = Math.max(existing.gpuMax, gresInfo.gpuMax);
      for (const [type, count] of Object.entries(gresInfo.gpuTypes)) {
        const current = existing.gpuTypes[type] || 0;
        existing.gpuTypes[type] = Math.max(current, count);
      }
      existing.isDefault = existing.isDefault || isDefault;

      partitions.set(name, existing);
    }
  }

  for (const [name, info] of partitions) {
    const set = nodeSets.get(name);
    if (set && set.size > 0) {
      info.nodes = set.size;
    }
  }

  const list = Array.from(partitions.values()).sort((a, b) => a.name.localeCompare(b.name));
  return { partitions: list, defaultPartition };
}

function parseGresInfo(raw: string): { gpuMax: number; gpuTypes: Record<string, number> } {
  const result: { gpuMax: number; gpuTypes: Record<string, number> } = {
    gpuMax: 0,
    gpuTypes: {}
  };
  if (!raw) {
    return result;
  }
  const tokens = raw.split(',').map((token) => token.trim()).filter(Boolean);
  for (const token of tokens) {
    if (!token.includes('gpu')) {
      continue;
    }
    const cleaned = token.replace(/\(.*?\)/g, '');
    const parts = cleaned.split(':').map((part) => part.trim()).filter(Boolean);
    if (parts.length === 0 || parts[0] !== 'gpu') {
      continue;
    }
    let type = '';
    let count = 0;
    if (parts.length === 2) {
      if (/^\d+$/.test(parts[1])) {
        count = Number(parts[1]);
      } else {
        type = parts[1];
      }
    } else if (parts.length >= 3) {
      type = parts[1];
      if (/^\d+$/.test(parts[2])) {
        count = Number(parts[2]);
      }
    }
    if (count <= 0) {
      continue;
    }
    result.gpuMax = Math.max(result.gpuMax, count);
    const key = type || '';
    const existing = result.gpuTypes[key] || 0;
    result.gpuTypes[key] = Math.max(existing, count);
  }
  return result;
}

function parseNumericField(value: string): number {
  const match = value.match(/\d+/);
  if (!match) {
    return 0;
  }
  return Number(match[0]) || 0;
}

async function runSshCommand(host: string, cfg: SciamaConfig, command: string): Promise<string> {
  const args: string[] = [];
  if (cfg.sshQueryConfigPath) {
    args.push('-F', expandHome(cfg.sshQueryConfigPath));
  }
  args.push('-T', '-o', 'BatchMode=yes', '-o', `ConnectTimeout=${cfg.sshConnectTimeoutSeconds}`);
  if (cfg.identityFile) {
    args.push('-i', expandHome(cfg.identityFile));
  }
  const target = cfg.user ? `${cfg.user}@${host}` : host;
  args.push(target, command);

  const { stdout } = await execFileAsync('ssh', args, { timeout: cfg.sshConnectTimeoutSeconds * 1000 });
  return stdout.trim();
}

function parsePartitionOutput(output: string): PartitionResult {
  const tokens = output.split(/\s+/).map((token) => token.trim()).filter(Boolean);
  const partitions: string[] = [];
  let defaultPartition: string | undefined;

  for (const token of tokens) {
    const isDefault = token.includes('*');
    const cleaned = token.replace(/\*/g, '');
    if (!cleaned) {
      continue;
    }
    if (isDefault && !defaultPartition) {
      defaultPartition = cleaned;
    }
    if (!partitions.includes(cleaned)) {
      partitions.push(cleaned);
    }
  }

  return { partitions, defaultPartition };
}

function parseSimpleList(output: string): string[] {
  return uniqueList(
    output
      .split(/\s+/)
      .map((value) => value.trim())
      .filter(Boolean)
  );
}

async function pickFromList(title: string, items: string[], allowManual: boolean): Promise<string | undefined> {
  const picks: vscode.QuickPickItem[] = items.map((item) => ({ label: item }));
  if (allowManual) {
    picks.unshift({ label: 'Enter manually' });
  }

  const picked = await vscode.window.showQuickPick(picks, {
    title,
    placeHolder: items.length ? 'Select an item' : 'Enter a value'
  });

  if (!picked) {
    return undefined;
  }

  if (allowManual && picked.label === 'Enter manually') {
    const manual = await vscode.window.showInputBox({ title, prompt: 'Enter value' });
    return manual?.trim() || undefined;
  }

  return picked.label;
}

async function pickPartition(
  partitions: string[],
  defaultPartition?: string
): Promise<string | undefined | null> {
  if (partitions.length === 0) {
    const manual = await vscode.window.showInputBox({
      title: 'Partition (optional)',
      prompt: 'Enter partition or leave blank to use cluster default'
    });
    if (manual === undefined) {
      return null;
    }
    return manual.trim() || undefined;
  }

  const picks: vscode.QuickPickItem[] = [
    {
      label: 'Use cluster default',
      description: defaultPartition ? `(${defaultPartition})` : undefined
    },
    ...partitions.map((partition) => ({
      label: partition,
      description: partition === defaultPartition ? 'default' : undefined
    }))
  ];

  const picked = await vscode.window.showQuickPick(picks, {
    title: 'Select partition',
    placeHolder: 'Choose a partition'
  });

  if (!picked) {
    return null;
  }

  if (picked.label === 'Use cluster default') {
    return undefined;
  }

  return picked.label;
}

async function pickOptionalValue(title: string, items: string[]): Promise<string | undefined> {
  if (items.length === 0) {
    return undefined;
  }

  const picks: vscode.QuickPickItem[] = [
    { label: 'None' },
    ...items.map((item) => ({ label: item }))
  ];
  const picked = await vscode.window.showQuickPick(picks, {
    title,
    placeHolder: 'Select a value'
  });
  if (!picked || picked.label === 'None') {
    return undefined;
  }
  return picked.label;
}

async function promptNumber(title: string, defaultValue: number, minValue: number): Promise<number | undefined> {
  const value = await vscode.window.showInputBox({
    title,
    value: String(defaultValue),
    validateInput: (input) => {
      const parsed = Number(input);
      if (!Number.isInteger(parsed) || parsed < minValue) {
        return `Enter an integer >= ${minValue}.`;
      }
      return undefined;
    }
  });
  if (!value) {
    return undefined;
  }
  return Number(value);
}

async function promptTime(title: string, defaultValue: string): Promise<string | undefined> {
  const timePattern = /^(\d+-)?\d{1,2}:\d{2}:\d{2}$/;
  const value = await vscode.window.showInputBox({
    title,
    value: defaultValue,
    prompt: 'HH:MM:SS or D-HH:MM:SS',
    validateInput: (input) => (timePattern.test(input) ? undefined : 'Invalid time format.')
  });
  return value?.trim() || undefined;
}

function buildSallocArgs(params: {
  partition?: string;
  nodes: number;
  tasksPerNode: number;
  cpusPerTask: number;
  time: string;
  memoryMb?: number;
  gpuType?: string;
  gpuCount?: number;
  qos?: string;
  account?: string;
}): string[] {
  const args: string[] = [];
  if (params.partition) {
    args.push(`--partition=${params.partition}`);
  }
  args.push(`--nodes=${params.nodes}`);
  args.push(`--ntasks-per-node=${params.tasksPerNode}`);
  args.push(`--cpus-per-task=${params.cpusPerTask}`);
  args.push(`--time=${params.time}`);
  if (params.qos) {
    args.push(`--qos=${params.qos}`);
  }
  if (params.account) {
    args.push(`--account=${params.account}`);
  }
  if (params.memoryMb && params.memoryMb > 0) {
    args.push(`--mem=${params.memoryMb}`);
  }
  if (params.gpuCount && params.gpuCount > 0) {
    const type = params.gpuType ? params.gpuType.trim() : '';
    const gres = type ? `gpu:${type}:${params.gpuCount}` : `gpu:${params.gpuCount}`;
    args.push(`--gres=${gres}`);
  }
  return args;
}

function buildRemoteCommand(cfg: SciamaConfig, sallocArgs: string[]): string {
  const proxyParts = [cfg.proxyCommand, ...cfg.proxyArgs.filter(Boolean)];
  const proxyCommand = proxyParts.filter(Boolean).join(' ').trim();
  if (!proxyCommand) {
    return '';
  }
  const sallocFlags = sallocArgs.map((arg) => `--salloc-arg=${arg}`);
  const fullProxyCommand = [proxyCommand, ...sallocFlags].join(' ').trim();
  if (cfg.moduleLoad) {
    return `${cfg.moduleLoad} && ${fullProxyCommand}`.trim();
  }
  return fullProxyCommand;
}

function buildDefaultAlias(
  prefix: string,
  loginHost: string,
  partition: string | undefined,
  nodes: number,
  cpusPerTask: number
): string {
  const hostShort = loginHost.split('.')[0];
  const pieces = [prefix || 'sciama', hostShort];
  if (partition) {
    pieces.push(partition);
  }
  pieces.push(`${nodes}n`, `${cpusPerTask}c`);
  return pieces.join('-').replace(/[^a-zA-Z0-9_-]/g, '-');
}

function buildHostEntry(alias: string, loginHost: string, cfg: SciamaConfig, remoteCommand: string): string {
  const lines: string[] = [];
  lines.push(`# Generated by Sciama Slurm Connect on ${new Date().toISOString()}`);
  lines.push(`Host ${alias}`);
  lines.push(`  HostName ${loginHost}`);
  if (cfg.user) {
    lines.push(`  User ${cfg.user}`);
  }
  if (cfg.requestTTY) {
    lines.push('  RequestTTY yes');
  }
  if (cfg.forwardAgent) {
    lines.push('  ForwardAgent yes');
  }
  if (cfg.identityFile) {
    lines.push(`  IdentityFile ${cfg.identityFile}`);
  }
  lines.push(`  RemoteCommand ${remoteCommand}`);

  const extraKeys = Object.keys(cfg.additionalSshOptions || {}).sort();
  for (const key of extraKeys) {
    const value = cfg.additionalSshOptions[key];
    if (value !== undefined && value !== null && String(value).length > 0) {
      lines.push(`  ${key} ${value}`);
    }
  }

  return `${lines.join('\n')}\n`;
}

async function writeTemporarySshConfig(
  alias: string,
  entry: string,
  cfg: SciamaConfig
): Promise<string> {
  const basePath = cfg.temporarySshConfigPath
    ? expandHome(cfg.temporarySshConfigPath)
    : path.join(extensionStoragePath || os.tmpdir(), 'sciama-ssh-config');
  const dir = path.dirname(basePath);
  await fs.mkdir(dir, { recursive: true });
  const content = `# Temporary SSH config generated by Sciama Slurm Connect\n${entry}`;
  await fs.writeFile(basePath, content, 'utf8');
  return basePath;
}

async function ensureRemoteSshSettings(): Promise<void> {
  const remoteCfg = vscode.workspace.getConfiguration('remote.SSH');
  const enableRemoteCommand = remoteCfg.get<boolean>('enableRemoteCommand', false);
  if (!enableRemoteCommand) {
    const enable = await vscode.window.showWarningMessage(
      'Remote.SSH: Enable Remote Command is disabled. This is required for Slurm proxying.',
      'Enable',
      'Ignore'
    );
    if (enable === 'Enable') {
      await remoteCfg.update('enableRemoteCommand', true, vscode.ConfigurationTarget.Global);
    }
  }
}

async function refreshRemoteSshHosts(): Promise<void> {
  const commands = [
    'opensshremotes.refresh',
    'opensshremotes.refreshExplorer',
    'remote-ssh.refresh'
  ];
  for (const command of commands) {
    try {
      await vscode.commands.executeCommand(command);
      return;
    } catch {
      // ignore
    }
  }
}

async function connectToHost(
  alias: string,
  openInNewWindow: boolean,
  remoteWorkspacePath?: string
): Promise<boolean> {
  const remoteExtension = vscode.extensions.getExtension('ms-vscode-remote.remote-ssh');
  if (!remoteExtension) {
    return false;
  }
  const log = getOutputChannel();
  await remoteExtension.activate();
  const availableCommands = await vscode.commands.getCommands(true);
  const sshCommands = availableCommands.filter((command) =>
    /ssh|openssh/i.test(command)
  );
  log.appendLine(`Available SSH commands: ${sshCommands.join(', ') || '(none)'}`);

  const trimmedPath = remoteWorkspacePath?.trim();
  if (trimmedPath) {
    const normalizedPath = trimmedPath.startsWith('/') ? trimmedPath : `/${trimmedPath}`;
    try {
      const remoteUri = vscode.Uri.parse(
        `vscode-remote://ssh-remote+${encodeURIComponent(alias)}${normalizedPath}`
      );
      log.appendLine(`Opening remote folder: ${remoteUri.toString()}`);
      await vscode.commands.executeCommand('vscode.openFolder', remoteUri, openInNewWindow);
      return true;
    } catch (error) {
      log.appendLine(`Failed to open folder via vscode.openFolder: ${formatError(error)}`);
      // Fall through to connect without a folder.
    }
  }

  if (openInNewWindow) {
    const commandCandidates: Array<[string, unknown]> = [
      ['opensshremotes.openEmptyWindow', { host: alias, newWindow: true }],
      ['opensshremotes.openEmptyWindow', { host: alias }],
      ['remote-ssh.connectToHost', alias],
      ['opensshremotes.connectToHost', { host: alias }],
      ['remote-ssh.openEmptyWindow', alias],
      ['remote-ssh.openEmptyWindowInCurrentWindow', alias]
    ];
    for (const [command, args] of commandCandidates) {
      try {
        log.appendLine(`Trying command: ${command}`);
        await vscode.commands.executeCommand(command, args);
        log.appendLine(`Command succeeded: ${command}`);
        return true;
      } catch (error) {
        log.appendLine(`Command failed: ${command} -> ${formatError(error)}`);
        // try next command
      }
    }
    return false;
  }

  try {
    const commandCandidates: Array<[string, unknown]> = [
      ['opensshremotes.openEmptyWindowInCurrentWindow', { host: alias }],
      ['opensshremotes.openEmptyWindow', { host: alias, newWindow: false }],
      ['opensshremotes.openEmptyWindow', { host: alias }],
      ['remote-ssh.connectToHost', alias],
      ['opensshremotes.connectToHost', { host: alias }],
      ['remote-ssh.openEmptyWindowInCurrentWindow', alias],
      ['remote-ssh.openEmptyWindow', alias]
    ];
    for (const [command, args] of commandCandidates) {
      try {
        log.appendLine(`Trying command: ${command}`);
        await vscode.commands.executeCommand(command, args);
        log.appendLine(`Command succeeded: ${command}`);
        return true;
      } catch (error) {
        log.appendLine(`Command failed: ${command} -> ${formatError(error)}`);
        // try next command
      }
    }
    return false;
  } finally {
    // No-op
  }
}

function getUiValuesFromConfig(cfg: SciamaConfig): UiValues {
  return {
    loginHosts: cfg.loginHosts.join('\n'),
    loginHostsCommand: cfg.loginHostsCommand || '',
    loginHostsQueryHost: cfg.loginHostsQueryHost || '',
    partitionCommand: cfg.partitionCommand || '',
    partitionInfoCommand: cfg.partitionInfoCommand || '',
    qosCommand: cfg.qosCommand || '',
    accountCommand: cfg.accountCommand || '',
    user: cfg.user || '',
    identityFile: cfg.identityFile || '',
    moduleLoad: cfg.moduleLoad || '',
    proxyCommand: cfg.proxyCommand || '',
    proxyArgs: cfg.proxyArgs.join('\n'),
    extraSallocArgs: cfg.extraSallocArgs.join('\n'),
    promptForExtraSallocArgs: cfg.promptForExtraSallocArgs,
    defaultPartition: cfg.defaultPartition || '',
    defaultNodes: String(cfg.defaultNodes),
    defaultTasksPerNode: String(cfg.defaultTasksPerNode),
    defaultCpusPerTask: String(cfg.defaultCpusPerTask),
    defaultTime: cfg.defaultTime || '',
    defaultMemoryMb: cfg.defaultMemoryMb ? String(cfg.defaultMemoryMb) : '',
    defaultGpuType: cfg.defaultGpuType || '',
    defaultGpuCount: cfg.defaultGpuCount ? String(cfg.defaultGpuCount) : '',
    sshHostPrefix: cfg.sshHostPrefix || '',
    forwardAgent: cfg.forwardAgent,
    requestTTY: cfg.requestTTY,
    connectAfterCreate: cfg.connectAfterCreate,
    openInNewWindow: cfg.openInNewWindow,
    remoteWorkspacePath: cfg.remoteWorkspacePath || '',
    temporarySshConfigPath: cfg.temporarySshConfigPath || '',
    restoreSshConfigAfterConnect: cfg.restoreSshConfigAfterConnect,
    sshQueryConfigPath: cfg.sshQueryConfigPath || ''
  };
}

async function updateConfigFromUi(values: UiValues, target: vscode.ConfigurationTarget): Promise<void> {
  const cfg = vscode.workspace.getConfiguration('sciamaSlurm');

  const updates: Array<[string, unknown]> = [
    ['loginHosts', parseListInput(values.loginHosts)],
    ['loginHostsCommand', values.loginHostsCommand.trim()],
    ['loginHostsQueryHost', values.loginHostsQueryHost.trim()],
    ['partitionCommand', values.partitionCommand.trim()],
    ['partitionInfoCommand', values.partitionInfoCommand.trim()],
    ['qosCommand', values.qosCommand.trim()],
    ['accountCommand', values.accountCommand.trim()],
    ['user', values.user.trim()],
    ['identityFile', values.identityFile.trim()],
    ['moduleLoad', values.moduleLoad.trim()],
    ['proxyCommand', values.proxyCommand.trim()],
    ['proxyArgs', parseListInput(values.proxyArgs)],
    ['extraSallocArgs', parseListInput(values.extraSallocArgs)],
    ['promptForExtraSallocArgs', Boolean(values.promptForExtraSallocArgs)],
    ['defaultPartition', values.defaultPartition.trim()],
    ['defaultNodes', parseNumberValue(values.defaultNodes, 1)],
    ['defaultTasksPerNode', parseNumberValue(values.defaultTasksPerNode, 1)],
    ['defaultCpusPerTask', parseNumberValue(values.defaultCpusPerTask, 1)],
    ['defaultTime', values.defaultTime.trim()],
    ['defaultMemoryMb', parseNumberValue(values.defaultMemoryMb, 0)],
    ['defaultGpuType', values.defaultGpuType.trim()],
    ['defaultGpuCount', parseNumberValue(values.defaultGpuCount, 0)],
    ['sshHostPrefix', values.sshHostPrefix.trim()],
    ['forwardAgent', Boolean(values.forwardAgent)],
    ['requestTTY', Boolean(values.requestTTY)],
    ['connectAfterCreate', Boolean(values.connectAfterCreate)],
    ['openInNewWindow', Boolean(values.openInNewWindow)],
    ['remoteWorkspacePath', values.remoteWorkspacePath.trim()],
    ['temporarySshConfigPath', values.temporarySshConfigPath.trim()],
    ['restoreSshConfigAfterConnect', Boolean(values.restoreSshConfigAfterConnect)],
    ['sshQueryConfigPath', values.sshQueryConfigPath.trim()]
  ];

  for (const [key, value] of updates) {
    await cfg.update(key, value, target);
  }
}

function expandHome(input: string): string {
  if (!input) {
    return input;
  }
  if (input.startsWith('~')) {
    return path.join(os.homedir(), input.slice(1));
  }
  return input;
}

function uniqueList(values: string[]): string[] {
  const seen = new Set<string>();
  const result: string[] = [];
  for (const value of values) {
    if (!seen.has(value)) {
      seen.add(value);
      result.push(value);
    }
  }
  return result;
}

function splitArgs(input: string): string[] {
  return input.split(/\s+/).filter(Boolean);
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function parseListInput(input: string): string[] {
  return input
    .split(/[\s,]+/)
    .map((value) => value.trim())
    .filter(Boolean);
}

function firstLoginHostFromInput(input: string): string | undefined {
  const hosts = parseListInput(input);
  return hosts.length > 0 ? hosts[0] : undefined;
}

function getCachedClusterInfo(host: string): { info: ClusterInfo; fetchedAt: string } | undefined {
  if (!extensionGlobalState) {
    return undefined;
  }
  const cache = extensionGlobalState.get<Record<string, { info: ClusterInfo; fetchedAt: string }>>(
    'sciamaSlurm.clusterInfoCache'
  );
  return cache ? cache[host] : undefined;
}

function cacheClusterInfo(host: string, info: ClusterInfo): void {
  if (!extensionGlobalState) {
    return;
  }
  const cache =
    extensionGlobalState.get<Record<string, { info: ClusterInfo; fetchedAt: string }>>(
      'sciamaSlurm.clusterInfoCache'
    ) || {};
  cache[host] = { info, fetchedAt: new Date().toISOString() };
  void extensionGlobalState.update('sciamaSlurm.clusterInfoCache', cache);
}

function parseNumberValue(input: string, fallback: number): number {
  const parsed = Number(input);
  if (!Number.isFinite(parsed) || parsed <= 0) {
    return fallback;
  }
  return Math.floor(parsed);
}

function buildOverridesFromUi(values: UiValues): Partial<SciamaConfig> {
  return {
    loginHosts: parseListInput(values.loginHosts),
    loginHostsCommand: values.loginHostsCommand.trim(),
    loginHostsQueryHost: values.loginHostsQueryHost.trim(),
    partitionCommand: values.partitionCommand.trim(),
    partitionInfoCommand: values.partitionInfoCommand.trim(),
    qosCommand: values.qosCommand.trim(),
    accountCommand: values.accountCommand.trim(),
    user: values.user.trim(),
    identityFile: values.identityFile.trim(),
    moduleLoad: values.moduleLoad.trim(),
    proxyCommand: values.proxyCommand.trim(),
    proxyArgs: parseListInput(values.proxyArgs),
    extraSallocArgs: parseListInput(values.extraSallocArgs),
    promptForExtraSallocArgs: Boolean(values.promptForExtraSallocArgs),
    defaultPartition: values.defaultPartition.trim(),
    defaultNodes: parseNumberValue(values.defaultNodes, 1),
    defaultTasksPerNode: parseNumberValue(values.defaultTasksPerNode, 1),
    defaultCpusPerTask: parseNumberValue(values.defaultCpusPerTask, 1),
    defaultTime: values.defaultTime.trim(),
    defaultMemoryMb: parseNumberValue(values.defaultMemoryMb, 0),
    defaultGpuType: values.defaultGpuType.trim(),
    defaultGpuCount: parseNumberValue(values.defaultGpuCount, 0),
    sshHostPrefix: values.sshHostPrefix.trim(),
    forwardAgent: Boolean(values.forwardAgent),
    requestTTY: Boolean(values.requestTTY),
    connectAfterCreate: Boolean(values.connectAfterCreate),
    openInNewWindow: Boolean(values.openInNewWindow),
    remoteWorkspacePath: values.remoteWorkspacePath.trim(),
    temporarySshConfigPath: values.temporarySshConfigPath.trim(),
    restoreSshConfigAfterConnect: Boolean(values.restoreSshConfigAfterConnect),
    sshQueryConfigPath: values.sshQueryConfigPath.trim()
  };
}

function getWebviewHtml(webview: vscode.Webview): string {
  const nonce = String(Date.now());
  const csp = [
    "default-src 'none'",
    `style-src ${webview.cspSource} 'unsafe-inline'`,
    `script-src 'nonce-${nonce}'`
  ].join('; ');

  return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta http-equiv="Content-Security-Policy" content="${csp}">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>Sciama Slurm</title>
  <style>
    body { font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif; padding: 12px; color: #222; }
    h2 { font-size: 16px; margin: 0 0 12px 0; }
    .section { margin-bottom: 16px; }
    label { font-size: 12px; display: block; margin-bottom: 4px; }
    input, textarea, select, button { width: 100%; box-sizing: border-box; font-size: 12px; padding: 6px; }
    textarea { resize: vertical; min-height: 48px; }
    .row { display: flex; gap: 8px; }
    .row > div { flex: 1; }
    .checkbox { display: flex; align-items: center; gap: 6px; }
    .checkbox input { width: auto; }
    .buttons { display: flex; gap: 8px; }
    .buttons button { flex: 1; }
    .hint { font-size: 11px; color: #555; margin-top: 4px; }
    details summary { cursor: pointer; margin-bottom: 6px; }
  </style>
</head>
<body>
  <h2>Sciama Slurm</h2>

  <div class="section">
    <label for="loginHosts">Login host</label>
    <input id="loginHosts" type="text" placeholder="hostname1.com" />
    <label for="user">SSH user</label>
    <input id="user" type="text" />
    <label for="identityFile">Identity file</label>
    <input id="identityFile" type="text" />
    <div class="buttons" style="margin-top: 8px;">
      <button id="getClusterInfo">Get cluster info</button>
    </div>
    <div id="clusterStatus" class="hint"></div>
  </div>

  <div class="section">
    <label for="defaultPartition">Partition</label>
    <select id="defaultPartition" disabled></select>
    <div id="partitionMeta" class="hint"></div>
    <div class="row">
      <div>
        <label for="defaultNodes">Nodes</label>
        <select id="defaultNodes" disabled></select>
      </div>
      <div>
        <label for="defaultTasksPerNode">Tasks per node</label>
        <input id="defaultTasksPerNode" type="number" min="1" />
      </div>
    </div>
    <div class="row">
      <div>
        <label for="defaultCpusPerTask">CPUs per task</label>
        <select id="defaultCpusPerTask" disabled></select>
      </div>
      <div>
        <label for="defaultMemoryMb">Memory per node</label>
        <select id="defaultMemoryMb" disabled></select>
      </div>
    </div>
    <div class="row">
      <div>
        <label for="defaultGpuType">GPU type</label>
        <select id="defaultGpuType" disabled></select>
      </div>
      <div>
        <label for="defaultGpuCount">GPU count</label>
        <select id="defaultGpuCount" disabled></select>
      </div>
    </div>
    <label for="defaultTime">Wall time</label>
    <input id="defaultTime" type="text" />
  </div>

  <div class="section">
    <div class="checkbox">
      <input id="connectAfterCreate" type="checkbox" />
      <label for="connectAfterCreate">Connect after create</label>
    </div>
    <div class="checkbox">
      <input id="openInNewWindow" type="checkbox" />
      <label for="openInNewWindow">Open in new window</label>
    </div>
    <label for="remoteWorkspacePath">Remote folder to open (optional)</label>
    <input id="remoteWorkspacePath" type="text" placeholder="/home/user/project" />
  </div>

  <details class="section">
    <summary>Advanced settings</summary>
    <label for="loginHostsCommand">Login hosts command (optional)</label>
    <input id="loginHostsCommand" type="text" />
    <label for="loginHostsQueryHost">Login hosts query host (optional)</label>
    <input id="loginHostsQueryHost" type="text" />
    <label for="partitionInfoCommand">Partition info command</label>
    <input id="partitionInfoCommand" type="text" />
    <label for="partitionCommand">Partition list command</label>
    <input id="partitionCommand" type="text" />
    <label for="qosCommand">QoS command (optional)</label>
    <input id="qosCommand" type="text" />
    <label for="accountCommand">Account command (optional)</label>
    <input id="accountCommand" type="text" />
    <label for="moduleLoad">Module load</label>
    <input id="moduleLoad" type="text" />
    <label for="proxyCommand">Proxy command</label>
    <input id="proxyCommand" type="text" />
    <label for="proxyArgs">Proxy args (space or newline separated)</label>
    <textarea id="proxyArgs" rows="2"></textarea>
    <label for="extraSallocArgs">Extra salloc args</label>
    <textarea id="extraSallocArgs" rows="2"></textarea>
    <div class="checkbox">
      <input id="promptForExtraSallocArgs" type="checkbox" />
      <label for="promptForExtraSallocArgs">Prompt for extra salloc args</label>
    </div>
    <label for="sshHostPrefix">SSH host prefix</label>
    <input id="sshHostPrefix" type="text" />
    <label for="temporarySshConfigPath">Temporary SSH config path</label>
    <input id="temporarySshConfigPath" type="text" />
    <div class="checkbox">
      <input id="restoreSshConfigAfterConnect" type="checkbox" />
      <label for="restoreSshConfigAfterConnect">Restore Remote.SSH config after connect</label>
    </div>
    <label for="sshQueryConfigPath">SSH query config path</label>
    <input id="sshQueryConfigPath" type="text" />
    <div class="checkbox">
      <input id="forwardAgent" type="checkbox" />
      <label for="forwardAgent">Forward agent</label>
    </div>
    <div class="checkbox">
      <input id="requestTTY" type="checkbox" />
      <label for="requestTTY">Request TTY</label>
    </div>
    <label for="saveTarget">Save settings to</label>
    <select id="saveTarget">
      <option value="global">User settings</option>
      <option value="workspace">Workspace settings</option>
    </select>
    <div class="buttons" style="margin-top: 8px;">
      <button id="refresh">Reload saved values</button>
      <button id="openSettings">Open Settings</button>
    </div>
  </details>

  <div class="section">
    <div class="buttons" style="margin-top: 8px;">
      <button id="save">Save</button>
      <button id="connect">Save + Connect</button>
    </div>
    <div class="hint">Saved to user settings by default (change in Advanced).</div>
    <div class="hint">Connections use a temporary SSH config; your main SSH config is not modified.</div>
  </div>

  <script nonce="${nonce}">
    const vscode = acquireVsCodeApi();
    let clusterInfo = null;
    let lastValues = {};

    function setStatus(text, isError) {
      const el = document.getElementById('clusterStatus');
      if (!el) return;
      el.textContent = text || '';
      el.style.color = isError ? '#b00020' : '#555';
    }

    function formatMem(mb) {
      if (!mb || mb <= 0) return 'unknown';
      if (mb >= 1024) {
        const gb = mb / 1024;
        const fixed = Math.round(gb * 10) / 10;
        return fixed + ' GB';
      }
      return mb + ' MB';
    }

    function setSelectOptions(id, options, selectedValue) {
      const select = document.getElementById(id);
      if (!select) return;
      select.innerHTML = '';
      options.forEach((opt) => {
        const option = document.createElement('option');
        option.value = String(opt.value);
        option.textContent = opt.label;
        select.appendChild(option);
      });
      if (selectedValue !== undefined && selectedValue !== null && selectedValue !== '') {
        const desired = String(selectedValue);
        if (Array.from(select.options).some((opt) => opt.value === desired)) {
          select.value = desired;
        }
      }
      if (!select.value && select.options.length > 0) {
        select.value = select.options[0].value;
      }
    }

    function setResourceDisabled(disabled) {
      ['defaultPartition', 'defaultNodes', 'defaultCpusPerTask', 'defaultMemoryMb', 'defaultGpuType', 'defaultGpuCount'].forEach((id) => {
        const el = document.getElementById(id);
        if (el) el.disabled = disabled;
      });
      if (disabled) {
        setSelectOptions('defaultPartition', [{ value: '', label: 'Click Get cluster info' }], '');
        setSelectOptions('defaultNodes', [{ value: '', label: '-' }], '');
        setSelectOptions('defaultCpusPerTask', [{ value: '', label: '-' }], '');
        setSelectOptions('defaultMemoryMb', [{ value: '', label: 'Use default' }], '');
        setSelectOptions('defaultGpuType', [{ value: '', label: 'None' }], '');
        setSelectOptions('defaultGpuCount', [{ value: '0', label: '0' }], '0');
        const meta = document.getElementById('partitionMeta');
        if (meta) meta.textContent = '';
      }
    }

    function buildRangeOptions(maxValue) {
      const options = [];
      const max = Number(maxValue) || 0;
      if (!max) return options;
      const limit = Math.min(max, 128);
      for (let i = 1; i <= limit; i += 1) {
        options.push({ value: String(i), label: String(i) });
      }
      if (max > limit) {
        options.push({ value: String(max), label: String(max) + ' (max)' });
      }
      return options;
    }

    function buildMemoryOptions(maxMb) {
      const options = [{ value: '', label: 'Use default' }];
      const max = Number(maxMb) || 0;
      if (!max) return options;
      const maxOptions = 32;
      let step = 1024;
      const steps = Math.floor(max / step);
      if (steps > maxOptions) {
        step = Math.ceil(max / maxOptions / 1024) * 1024;
      }
      let added = false;
      for (let mb = step; mb <= max; mb += step) {
        options.push({ value: String(mb), label: formatMem(mb) });
        added = true;
      }
      if (!added) {
        options.push({ value: String(max), label: formatMem(max) });
      } else if (options[options.length - 1].value !== String(max)) {
        options.push({ value: String(max), label: formatMem(max) + ' (max)' });
      }
      return options;
    }

    function updatePartitionDetails() {
      if (!clusterInfo || !clusterInfo.partitions) return;
      const partitionSelect = document.getElementById('defaultPartition');
      const selected = partitionSelect ? partitionSelect.value : '';
      const chosen = clusterInfo.partitions.find((p) => p.name === selected) || clusterInfo.partitions[0];
      if (!chosen) return;

      const meta = document.getElementById('partitionMeta');
      if (meta) {
        const gpuSummary = (() => {
          if (!chosen.gpuMax || !chosen.gpuTypes || Object.keys(chosen.gpuTypes).length === 0) {
            return 'GPU: none';
          }
          const parts = Object.keys(chosen.gpuTypes)
            .sort()
            .map((key) => {
              const label = key ? key : 'gpu';
              return label + 'x' + chosen.gpuTypes[key];
            });
          return 'GPU: ' + parts.join(', ');
        })();
        meta.textContent =
          'Nodes: ' +
          chosen.nodes +
          ' | CPUs/node: ' +
          chosen.cpus +
          ' | Mem/node: ' +
          formatMem(chosen.memMb) +
          ' | ' +
          gpuSummary;
      }

      const preferredNodes = getValue('defaultNodes') || lastValues.defaultNodes;
      const preferredCpus = getValue('defaultCpusPerTask') || lastValues.defaultCpusPerTask;
      const preferredMem = getValue('defaultMemoryMb') || lastValues.defaultMemoryMb;

      setSelectOptions('defaultNodes', buildRangeOptions(chosen.nodes), preferredNodes);
      setSelectOptions('defaultCpusPerTask', buildRangeOptions(chosen.cpus), preferredCpus);
      setSelectOptions('defaultMemoryMb', buildMemoryOptions(chosen.memMb), preferredMem);

      const gpuTypes = chosen.gpuTypes || {};
      const gpuTypeKeys = Object.keys(gpuTypes);
      const preferredGpuType = getValue('defaultGpuType') || lastValues.defaultGpuType;
      const preferredGpuCount = getValue('defaultGpuCount') || lastValues.defaultGpuCount;

      const gpuTypeSelect = document.getElementById('defaultGpuType');
      const gpuCountSelect = document.getElementById('defaultGpuCount');
      if (gpuTypeKeys.length === 0) {
        setSelectOptions('defaultGpuType', [{ value: '', label: 'None' }], '');
        setSelectOptions('defaultGpuCount', [{ value: '0', label: '0' }], '0');
        if (gpuTypeSelect) gpuTypeSelect.disabled = true;
        if (gpuCountSelect) gpuCountSelect.disabled = true;
      } else {
        const typeOptions = [{ value: '', label: 'Any' }];
        gpuTypeKeys.sort().forEach((key) => {
          const label = key ? key : 'Generic';
          typeOptions.push({ value: key, label });
        });
        setSelectOptions('defaultGpuType', typeOptions, preferredGpuType);
        const selectedType = gpuTypeSelect ? gpuTypeSelect.value : '';
        const maxGpu = selectedType ? gpuTypes[selectedType] : chosen.gpuMax;
        const countOptions = [{ value: '0', label: '0' }, ...buildRangeOptions(maxGpu)];
        setSelectOptions('defaultGpuCount', countOptions, preferredGpuCount);
        if (gpuTypeSelect) gpuTypeSelect.disabled = false;
        if (gpuCountSelect) gpuCountSelect.disabled = false;
      }
    }

    function applyClusterInfo(info) {
      clusterInfo = info;
      if (!info || !info.partitions || info.partitions.length === 0) {
        setStatus('No partitions found.', true);
        setResourceDisabled(true);
        return;
      }
      setResourceDisabled(false);
      const options = info.partitions.map((partition) => ({
        value: partition.name,
        label: partition.isDefault ? partition.name + ' (default)' : partition.name
      }));
      setSelectOptions('defaultPartition', options, lastValues.defaultPartition || info.defaultPartition);
      updatePartitionDetails();
      setStatus('Loaded ' + info.partitions.length + ' partitions.', false);
    }

    function setValue(id, value) {
      const el = document.getElementById(id);
      if (!el) return;
      if (el.type === 'checkbox') {
        el.checked = Boolean(value);
      } else {
        el.value = value ?? '';
      }
    }

    function getValue(id) {
      const el = document.getElementById(id);
      if (!el) return '';
      if (el.type === 'checkbox') {
        return el.checked;
      }
      return el.value || '';
    }

    function gather() {
      return {
        loginHosts: getValue('loginHosts'),
        loginHostsCommand: getValue('loginHostsCommand'),
        loginHostsQueryHost: getValue('loginHostsQueryHost'),
        partitionCommand: getValue('partitionCommand'),
        partitionInfoCommand: getValue('partitionInfoCommand'),
        qosCommand: getValue('qosCommand'),
        accountCommand: getValue('accountCommand'),
        user: getValue('user'),
        identityFile: getValue('identityFile'),
        moduleLoad: getValue('moduleLoad'),
        proxyCommand: getValue('proxyCommand'),
        proxyArgs: getValue('proxyArgs'),
        extraSallocArgs: getValue('extraSallocArgs'),
        promptForExtraSallocArgs: getValue('promptForExtraSallocArgs'),
        defaultPartition: getValue('defaultPartition'),
        defaultNodes: getValue('defaultNodes'),
        defaultTasksPerNode: getValue('defaultTasksPerNode'),
        defaultCpusPerTask: getValue('defaultCpusPerTask'),
        defaultTime: getValue('defaultTime'),
        defaultMemoryMb: getValue('defaultMemoryMb'),
        defaultGpuType: getValue('defaultGpuType'),
        defaultGpuCount: getValue('defaultGpuCount'),
        sshHostPrefix: getValue('sshHostPrefix'),
        temporarySshConfigPath: getValue('temporarySshConfigPath'),
        restoreSshConfigAfterConnect: getValue('restoreSshConfigAfterConnect'),
        sshQueryConfigPath: getValue('sshQueryConfigPath'),
        forwardAgent: getValue('forwardAgent'),
        requestTTY: getValue('requestTTY'),
        connectAfterCreate: getValue('connectAfterCreate'),
        openInNewWindow: getValue('openInNewWindow'),
        remoteWorkspacePath: getValue('remoteWorkspacePath')
      };
    }

    window.addEventListener('message', (event) => {
      const message = event.data;
      if (message.command === 'load') {
        const values = message.values || {};
        lastValues = values;
        Object.keys(values).forEach((key) => setValue(key, values[key]));
        if (message.clusterInfo) {
          applyClusterInfo(message.clusterInfo);
          if (message.clusterInfoCachedAt) {
            const cachedAt = new Date(message.clusterInfoCachedAt).toLocaleString();
            setStatus('Loaded cached cluster info (' + cachedAt + ').', false);
          }
        } else {
          setResourceDisabled(true);
          setStatus('Click "Get cluster info" to populate partitions.', false);
        }
      } else if (message.command === 'clusterInfo') {
        applyClusterInfo(message.info);
      } else if (message.command === 'clusterInfoError') {
        setStatus(message.message || 'Failed to load cluster info.', true);
        setResourceDisabled(true);
      }
    });

    document.getElementById('getClusterInfo').addEventListener('click', () => {
      setStatus('Fetching cluster info...', false);
      vscode.postMessage({
        command: 'getClusterInfo',
        values: gather()
      });
    });

    document.getElementById('defaultPartition').addEventListener('change', () => {
      updatePartitionDetails();
    });

    document.getElementById('defaultGpuType').addEventListener('change', () => {
      updatePartitionDetails();
    });

    document.getElementById('save').addEventListener('click', () => {
      vscode.postMessage({
        command: 'save',
        values: gather(),
        target: document.getElementById('saveTarget').value,
        connect: false
      });
    });
    document.getElementById('connect').addEventListener('click', () => {
      vscode.postMessage({
        command: 'save',
        values: gather(),
        target: document.getElementById('saveTarget').value,
        connect: true
      });
    });
    document.getElementById('refresh').addEventListener('click', () => {
      vscode.postMessage({ command: 'ready' });
    });
    document.getElementById('openSettings').addEventListener('click', () => {
      vscode.postMessage({ command: 'openSettings' });
    });

    vscode.postMessage({ command: 'ready' });
  </script>
</body>
</html>`;
}

function formatError(error: unknown): string {
  if (error instanceof Error) {
    return error.message;
  }
  return String(error);
}
