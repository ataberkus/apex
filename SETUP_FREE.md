# Apex: continue without paid services

Current policy is `offline-only`: paid evals are disabled. No API key or cloud account is needed for the commands below. Historical model spend remains $0.002482108; this continuation adds $0. The unused earlier budget is frozen.

## Run the free checks

After installing the dependencies in README.md, run inside the Apex folder:

```bash
bun run check
bun run test
bun run micro
bun run preflight
```

The micro gate exercises Pi's actual tools, accounting and a temporary local service, without a model. The service check proves survival after the native tool host exits; model-directed service management remains unmeasured. It cleans up its own fixture and reports unsupported platforms as SKIP.

Preflight only checks installed versions and the local Docker engine. It does not install software, pull images, launch containers, contact providers or use remote Docker contexts. It returns JSON and exit 2 when a required component is missing; `tooling-ready` means installed tooling only. This build workspace has no Docker engine, so its readiness report is blocked.

## A local Windows route

Use WSL2 and Docker Engine inside Ubuntu for Linux benchmark containers. This combines Microsoft's WSL guidance with Docker's Ubuntu instructions; the combined setup has not been executed on your machine or validated here. It needs no paid sandbox subscription. Native Windows containers are outside this setup.

In administrator PowerShell, following [Microsoft's WSL instructions](https://learn.microsoft.com/en-us/windows/wsl/install):

```powershell
wsl --list --online
wsl --install -d Ubuntu-24.04
wsl --list --verbose
```

Restart if prompted and create the Ubuntu user when first launching it. Confirm that Ubuntu uses WSL version 2. If Ubuntu is already installed, inspect its version before changing anything.

Inside Ubuntu, follow Docker's [official Ubuntu repository installation](https://docs.docker.com/engine/install/ubuntu/) to install Docker Engine and its Compose plugin. This route uses the community engine directly. Then check or start the local service:

```bash
sudo systemctl status docker
# If it is stopped:
sudo systemctl start docker
docker version
docker info --format '{{.OSType}}'
docker compose version
```

The engine must report `linux`. Harbor needs engine access without an interactive sudo prompt. Docker documents [user access setup](https://docs.docker.com/engine/install/linux-postinstall/); membership in the docker group grants root-level privileges. If systemctl is unavailable, consult Microsoft's [WSL systemd setup](https://learn.microsoft.com/en-us/windows/wsl/systemd). Keep the WSL session running while using the engine.

## Install Apex tooling inside Ubuntu

Keep Apex in the Linux filesystem, for example `~/apex`, and work from that folder. Install [Bun](https://bun.sh/docs/installation) >=1.4.3 (`curl -fsSL https://bun.sh/install | bash`), Python >=3.12, and [uv](https://docs.astral.sh/uv/getting-started/installation/); Node is not needed. Install Git, Bash, ripgrep and fd/fdfind through the distribution packages. README.md gives the exact Pi and Harbor installation commands, including the source commit pin.

Repeat the four free checks above. Components checked by preflight must pass; additional Git/Bash/uv/rg/fd dependencies are checked during installation and the other gates. Preflight makes no hardware capacity or benchmark readiness guarantee.

## What still needs model execution

Muse Spark 1.3 Contributor inference is priced usage. There is no verified free quota for that model in this build, so no model calls or Harbor agent baselines will run under the current instruction. MAIN/FAST remain the selected Muse model at xhigh. Do not switch to another model or enable paid execution just to obtain a score.

Free work can continue on deterministic fixtures, trace analysis, source audits and reproducibility. Real pass rate, confidence intervals and dollars per solved task remain pending until model execution is explicitly authorized again.
