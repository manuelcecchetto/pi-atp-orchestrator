# pi-atp-orchestrator

A standalone Pi extension for running ATP (Agent Task Protocol) plans directly inside Pi — no external runner process required.

## What it does

- Generates ATP v1.3 plans from bundled architect prompts.
- Lets the active Pi chat model act as orchestrator/judge.
- Spawns background Pi subprocesses as workers for individual READY nodes.
- Stores worker results as candidate fields in `.atp.json`.
- Requires the orchestrator to accept or reject each node before downstream nodes unlock.

## Requirements

- `pi` CLI installed.

This package is standalone: the ATP architect prompts are bundled in `./prompts/`. It does **not** require any separate ATP runner package or process.

If you intentionally want to use custom architect prompts, point the extension at a directory containing `ARCHITECT.md` and `MICRO_ARCHITECT.md`:

```bash
export PI_ATP_PROMPTS_DIR=/path/to/custom/prompts
```

## Install

```bash
pi install git:github.com/manuelcecchetto/pi-atp-orchestrator
```

Then reload Pi:

```text
/reload
```

For one-off testing without installing:

```bash
pi -e git:github.com/manuelcecchetto/pi-atp-orchestrator
```

## Commands

```text
/atp-plan [micro|macro] <brief>
/atp-on [planPath]
/atp-off
/atp-status [planPath]
```

Typical flow:

```text
/atp-plan micro Add a tiny README note and verify it
```

Review `.atp.json`, then let the orchestrator use:

```text
atp_activate
atp_spawn_ready
```

When a worker completion arrives, the orchestrator judges it with:

```text
atp_accept_node
```

or:

```text
atp_reject_node
```

## Tools

- `atp_create_plan`
- `atp_status`
- `atp_activate`
- `atp_spawn_node`
- `atp_spawn_ready`
- `atp_accept_node`
- `atp_reject_node`

## Safety model

- Planner subprocess gets read-only Pi tools (`read`, `grep`, `find`, `ls`).
- Worker subprocesses are told not to edit `.atp.json`.
- Worker subprocesses have ATP tools excluded to avoid recursive orchestration.
- The main orchestrator/judge is the only actor that accepts or rejects node completion.

## Validate locally

```bash
npm run validate
```

This runs a bundle check and a deterministic smoke test of the ATP claim → worker candidate → accept flow.

## Status

MVP. The local extension plumbing is smoke-tested; real-model behavior still depends on your Pi model configuration and the quality of the ATP plan.
