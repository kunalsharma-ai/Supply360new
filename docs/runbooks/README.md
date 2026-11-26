# Supply360 runbooks

| Runbook | Use it when |
|---|---|
| [deployment.md](deployment.md) | Shipping a release to staging or production (needs an approved change) |
| [operations.md](operations.md) | Day-to-day checks: health, metrics, scheduler, logs, scaling |
| [incidents.md](incidents.md) | Something is wrong: triage, kill switches, communication |
| [key-rotation.md](key-rotation.md) | Rotating the field encryption key, session secret, metrics token or integration secrets |
| [backup-restore.md](backup-restore.md) | Taking backups, restoring, and the quarterly restore drill |

Ground rules that hold in every runbook:

- **Nothing reaches production without a named approver.** CI never deploys; the release workflow only builds images.
- **No real invitations without approval.** Projects start in manual mode (`/automation`); switching a
  live project to semi or auto is a recorded decision.
- Supply360 never edits MADP, SampTrek or a panel's data, never credits wallets and never fabricates dispositions.
  If a fix seems to need any of that, stop and escalate to the owning team.
- Never paste secrets into tickets, chat or logs. Every script here prints counts, not values.
