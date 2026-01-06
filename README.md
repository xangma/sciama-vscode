# Sciama Slurm Connect (VS Code extension)

This extension helps users allocate Slurm resources on SCIAMA and connect VS Code Remote-SSH through a compute node. It discovers partitions (and optionally QoS/accounts), builds the `RemoteCommand` for `vscode-shell-proxy.py`, creates a temporary SSH host entry, and optionally connects right away.

## Requirements
- VS Code with **Remote - SSH** installed.
- SSH keys configured for the cluster (agent forwarding recommended).
- `vscode-shell-proxy.py` available on the login nodes (via module load or PATH).

## Quick start
1. Install dependencies and build:
   ```bash
   npm install
   npm run compile
   ```
2. Configure settings (example below) or use the **Sciama Slurm** activity bar view.
3. In the side view, fill in login host, username, and identity file, click **Get cluster info**, select resources, then **Save + Connect**.

The command will query the login host, prompt for resources, create a temporary SSH config entry, and connect. Your main SSH config is not modified.

## Example settings (SCIAMA)
```json
{
  "sciamaSlurm.loginHosts": [
    "hostname1.com",
  ],
  "sciamaSlurm.loginHostsCommand": "",
  "sciamaSlurm.moduleLoad": "module load anaconda3/2024.02",
  "sciamaSlurm.proxyCommand": "python vscode-shell-proxy.py",
  "sciamaSlurm.identityFile": "~/.ssh/id_rsa",
  "sciamaSlurm.defaultNodes": 1,
  "sciamaSlurm.defaultTasksPerNode": 1,
  "sciamaSlurm.defaultCpusPerTask": 8,
  "sciamaSlurm.defaultTime": "24:00:00"
}
```

## Discover login hosts
If your cluster can return login hosts via a command, set:
```json
{
  "sciamaSlurm.loginHostsCommand": "your-command-here",
  "sciamaSlurm.loginHostsQueryHost": "hostname1.com"
}
```
The command should output hostnames separated by whitespace or newlines.

## Notes
- Ensure **Remote.SSH: Enable Remote Command** is enabled (the extension will prompt to enable it).
- This extension uses a temporary SSH config for each connection and does not modify your main SSH config.
- Use `sciamaSlurm.openInNewWindow` to control whether the connection opens in a new window (default: false).
- Set `sciamaSlurm.remoteWorkspacePath` to open a specific remote folder. Leave it empty to connect without opening a folder.
- `sciamaSlurm.partitionInfoCommand` controls how cluster info is fetched (default: `sinfo -h -N -o "%P|%n|%c|%m|%G"`).
- To add GPUs or other flags, use `sciamaSlurm.extraSallocArgs` (e.g. `["--gres=gpu:1"]`).
