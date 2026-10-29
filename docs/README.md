# Documentation index

Everything written down lives in this folder. There is no second docs directory.

## Current system

| File | Scope |
| --- | --- |
| [lama-clean.md](lama-clean.md) | The TypeScript manager in `src/` + `web/`: commands, design rules, transport rules, security, verification. |
| [../README.md](../README.md) | Entry point: architecture, CLI, configuration, surfaces, gateway wiring, live check results. |

## Legacy (reference only)

The zero-dependency JS manager in `server/` is not part of the running system. These files describe
it so the old behaviour and decisions stay auditable; they do not describe `src/`.

| File | Scope |
| --- | --- |
| [legacy-server-manager.md](legacy-server-manager.md) | Layout, routes, `lamactl`, env keys of `server/server.mjs`. Its `/admin` now returns `410`. |
| [legacy-protocols.md](legacy-protocols.md) | Transport and wire details: HTTP/UDS/HTTPS, engine flags, gateway notes. |
| [legacy-audit.md](legacy-audit.md) | Audit of what was tried and what failed while the legacy manager was live. |

## Rules

- New documentation goes in this folder, next to the thing it describes.
- A doc that describes removed code says so in its first paragraph.
- A claim about live behaviour belongs in the README table only after a probe; otherwise label it
  `NOT_TESTED` or `UNVERIFIED`.
