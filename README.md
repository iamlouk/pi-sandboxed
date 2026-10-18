# pi-sandboxed

Container-based sandbox extension for [pi](https://github.com/earendil-works/pi) that runs all bash commands in isolated containers.
Supported container runtimes:

- **apple/container** (macOS): Apple's vz microVM container runtime
- **docker**: Any reachable Docker daemon via moby SDK

## Quick Start

```bash
# Clone or copy this directory
cd ~/dev/pi-sandboxed

# Install dependencies
npm install

# Run pi with sandbox enabled
pi --extension ~/dev/pi-sandboxed
```

## Configuration Files

Configuration files are merged with project-local settings taking precedence over global settings.

**Global config:** `~/.pi/agent/extensions/pi-sandboxed.json`

**Project config:** `<cwd>/.pi/pi-sandboxed.json`

Example `~/.pi/agent/extensions/pi-sandboxed.json`:

```json
{
  "enabled": true,
  "backend": "auto",
  "image": "alpine:latest",
  "dockerHost": "unix:///var/run/docker.sock",
  "timeout": 30
}
```

Example project-local `.pi/pi-sandboxed.json`:

```json
{
  "backend": "docker",
  "image": "ubuntu:latest",
  "timeout": 60,
  "hostTools": [
    { "name": "test", "command": "ninja test", "description": "Run the test suite on the host" }
  ]
}
```

## Configuration Options

| Option | Type | Default | Description |
|--------|------|---------|-------------|
| `enabled` | boolean | `true` | Enable/disable sandboxing |
| `backend` | string | `"auto"` | Backend to use: `"auto"`, `"apple"`, `"docker"` |
| `image` | string | `"alpine:latest"` | Container image to use |
| `dockerHost` | string | auto-detected | Docker socket path (for docker backend) |
| `timeout` | number | `30` | Command timeout in seconds |
| `networkIsolated` | boolean | `true` | **Network isolation**: If `true`, container has NO internet access (recommended for security) |
| `mounts` | object | `{}` | **Additional mounts**: Map of `hostPath: containerPath` to mount extra host directories into the container |
| `workdirMount` | string | `/workdir` | **Workdir mount point**: In-container path where the host cwd is mounted (also used as the container's working directory) |
| `hostTools` | array | `[]` | **Host tools**: User-authored allowlist of shell commands exposed to the LLM as custom tools that run on the **host**. See [Host Tools](#host-tools). |
| `startupCommand` | string | `""` | **Startup command**: Shell command run inside the container right after it starts (e.g. `"git config --global --add safe.directory /workdir"`). Runs as the container's default user with a 300s timeout; a non-zero exit fails sandbox initialization. |
| `startupCommandAsRoot` | string | `""` | **Root startup command**: Like `startupCommand` but always executed as in-container **root**; runs first. Use for package installs (`"apk add --no-cache git jq"`) — needs a non-isolated network. A non-zero exit fails sandbox initialization. |
| `runAsRoot` | boolean | `false` | **Run as root**: Run ALL commands in the container as root (uid 0) instead of the host user. Note: files created through the workdir mount will then be owned by root on the host — usually you want `startupCommandAsRoot` instead. |
| `dockerfile` | string | `""` | **Dockerfile**: Path to a Dockerfile to build and use instead of a prebuilt image (takes precedence over `image`, context = the Dockerfile's directory). The built image is cached under `pi-sandboxed-image:<sha>` keyed on the Dockerfile contents — unchanged Dockerfiles reuse the cached image on later sessions. Change the Dockerfile to rebuild, or delete the cached image (`container image rm` / `docker rmi`) to force a rebuild; changing only the build context does NOT trigger one. Builds use the `container` / `docker` CLI with a 15min timeout. |

## Environment Variables

| Variable | Description |
|----------|-------------|
| `PI_SANDBOX_BACKEND` | Override backend selection (same values as config) |
| `DOCKER_HOST` | Docker socket path (used by docker backend) |

## File Access Restrictions

When sandbox is enabled:
- **`read`/`write`/`edit` tools**: Operate on the **host filesystem**, so the extension rewrites container paths (e.g. `/workdir/foo`) to their host equivalents before the tool runs. Work for relative paths, `/workdir/*` paths, and paths under any other configured mount
- **Paths outside all mounts** (e.g. `../..` escapes or absolute container paths like `/etc`): BLOCKED - Must use `bash` tool to access
- **`bash` tool**: Works for all paths (runs in sandboxed container)

**Examples:**
```bash
# These work (relative or /workdir paths):
> read README.md              # Relative path -> host cwd/README.md
> read ./subdir/file.txt      # Relative path -> host cwd/subdir/file.txt
> read /workdir/config.json   # Rewritten to host cwd/config.json
> write new.txt "content"     # Relative path
> edit existing.txt           # Relative path

# These are blocked (outside all mounts):
> read /etc/passwd            # BLOCKED - use: bash "cat /etc/passwd"
> read /Users/lou/file.txt    # BLOCKED - use: bash "cat /Users/lou/file.txt"
> read ../../../etc/passwd    # BLOCKED - relative paths must stay inside a mount
> write /tmp/test.txt         # BLOCKED - use: bash "echo 'x' > /tmp/test.txt"
> edit /usr/local/config      # BLOCKED - use: bash "vi /usr/local/config"
```

**Important:** The LLM only sees `/workdir` as the container's root for file tools. It doesn't know the actual host path. Relative paths resolve to the mounted host directory. Since the mounts are bind mounts, writes through the host tools and through the container's `bash` hit the same data. The mount point is configurable via `workdirMount` in `pi-sandboxed.json`.

## Backend Selection

The extension tries backends in this order when `backend: "auto"`:

1. **apple** (macOS only): Uses `container` CLI (Apple's vz microVM runtime)
2. **docker**: Uses any reachable Docker daemon via `@moby/moby` SDK

### Apple Backend (macOS)

**Requirements:**
- macOS (Darwin)
- `container` CLI v1.3.1+ installed at `/usr/local/bin/container`

**Installation:**
```bash
# Install apple/container (if not already installed)
# On macOS Sonoma+, it may already be available
which container || echo "container CLI not found"
```

**Features:**
- Uses vz microVM for isolation
- ~1s container start time
- VirtioFS for fast file sharing

### Docker Backend

**Requirements:**
- Docker daemon running and reachable

**Supported configurations:**
- Default Unix socket: `/var/run/docker.sock`
- Docker Desktop macOS: `~/.docker/run/docker.sock`
- Docker Desktop Windows: `npipe:////./pipe/docker_engine`
- Custom via `DOCKER_HOST` environment variable

**Installation:**
```bash
# Linux: Install Docker
sudo apt-get install docker.io

# macOS: Install Docker Desktop
# or use OrbStack, Colima, etc.
```

## Host Tools

The `hostTools` config option lets **you** expose explicit shell commands to the LLM as custom tools that run on the **host** (outside the sandbox), e.g. to let the agent run `ninja test` without giving it general host access:

```json
{
  "hostTools": [
    { "name": "test", "command": "ninja test", "description": "Run the test suite" },
    { "name": "lint", "command": "npm run lint", "timeout": 60 }
  ]
}
```

Each entry supports:

| Field | Default | Description |
|-------|---------|-------------|
| `name` | (required) | Tool name exposed to the LLM (alphanumeric, dashes, underscores) |
| `command` | (required) | Shell command run on the host via `/bin/sh -c` |
| `description` | `Run \`<command>\` on the host.` | Tool description shown to the LLM |
| `cwd` | pi's host cwd | Working directory for the command (`~` expanded) |
| `timeout` | `120` | Timeout in seconds |

The list comes **solely from your config** — the agent cannot register new host tools at runtime, and it cannot edit the config to add itself tools (see below). Output is captured (stdout+stderr, truncated at 50 KB) and returned to the model with the exit code; timeouts and aborts kill the command.

## Config Protection

The pi-sandboxed config controls the security boundary (sandbox on/off, mounts, host tools), so the extension protects it from agent modification:

- **write/edit tools** are blocked from modifying the project `.pi/` dir and the global `~/.pi/agent/extensions/pi-sandboxed.json`, in every mode (sandbox on or off). Reading is allowed.
- **sandboxed bash** cannot touch the project `.pi/` dir: when the sandbox starts, `.pi` is overlay-mounted **read-only** into the container (docker: `:ro` bind; apple: `--read-only-path`).
- **Startup warning**: if `pi-sandboxed.json` exists but is not protected (e.g. sandbox disabled via `--no-sandbox` or config), a warning is shown at session start.

Note the agent can still *ask the user* to change the config — the user is the trust anchor for what goes into `hostTools`.

## How It Works

### Container Lifecycle

1. **session_start**: Extension initializes, selects backend, creates container
2. **Command execution**: Each bash command runs via `docker exec` / `container exec`
3. **session_shutdown**: Container is stopped and removed
4. **Stale cleanup**: On startup, containers from previous crashed sessions are removed

### Command Execution Flow

```
User runs: bash "ls -la"
    ↓
Extension intercepts via tool override
    ↓
Backend.exec() called with command
    ↓
Container exec (docker exec / container exec)
    ↓
Output streamed back to pi
    ↓
User sees results
```

### Filesystem Access

- Current directory is bind-mounted at `/workdir` in the container
- Commands run as the host user's UID/GID
- Read/write access follows container permissions
- Default image (alpine:latest) has minimal tools - install more as needed

