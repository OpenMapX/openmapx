# `docker compose ps --format json` captures

Real output, byte for byte, of the command the operations agent runs for
`stack.status`. Compose changed the format in 2.21.0: before, one array on one
line (`[]` for an empty stack); since, one object per line (nothing for an
empty stack).

| File                         | Compose | Stack                                 |
| ---------------------------- | ------- | ------------------------------------- |
| `compose-5.6.1.stdout`       | 5.6.1   | the stack below                       |
| `compose-5.6.1-empty.stdout` | 5.6.1   | a project with no containers          |
| `compose-2.21.0.stdout`      | 2.21.0  | the stack below                       |
| `compose-2.20.3.stdout`      | 2.20.3  | the stack below                       |
| `compose-2.20.3-empty.stdout`| 2.20.3  | a project with no containers          |

The stack, `compose.yml` in an empty directory:

```yaml
name: omx-ps-probe
services:
  web:
    image: busybox:1.37
    command: ["sleep", "3600"]
  worker:
    image: busybox:1.37
    command: ["sleep", "3600"]
  crashloop:
    image: busybox:1.37
    command: ["false"]
    restart: always
  oneshot:
    image: busybox:1.37
    command: ["true"]
  pending:
    image: busybox:1.37
    command: ["sleep", "3600"]
```

```sh
docker compose up -d web worker crashloop oneshot
docker compose create pending
docker compose pause worker
docker compose ps --format json > compose-5.6.1.stdout
docker compose -p omx-ps-empty -f compose.yml ps --format json > compose-5.6.1-empty.stdout
```

`oneshot` has exited and `pending` was only created, so `ps` without `--all`
leaves both out, as it leaves out such containers for the agent. The earlier Compose
binaries come from `docker/compose-bin:v2.20.3` and `docker/compose-bin:v2.21.0`,
run as `./docker-compose ps --format json` against the same daemon.
