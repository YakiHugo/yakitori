# 0022: Store the User Model Preference in config.toml

## Status

Accepted on 2026-08-13. Amends decision 0018.

## Context

Decision 0018 made model selection a next-Turn input and froze the chosen
target in `turn.started.executionContext`. The GUI initially kept a per-Session
choice only in localStorage and treated the last started Turn as the model
picker's effective value. That made the picker describe history after a user
had already chosen a different target for the next Turn. A new Session could
also display one default while its first admitted Input omitted the selection
and ran on another.

The user default must survive server and desktop restarts without becoming
Session journal state. Existing Sessions must retain their own current target
instead of changing when the user later changes the global default.

## Decision

The server owns `{YAKITORI_HOME ?? ~/.yakitori}/config.toml`. The only Yakitori
keys are `provider`, `model`, optional `effort`, and optional `speed`. Reads
treat a missing or malformed file as an absent preference; malformed content
is warned about rather than failing provider discovery. Writes preserve
unknown TOML entries and replace the file atomically through a temporary file
in the same directory.

`GET /providers` exposes the file value as optional `userPreference` while its
existing defaults remain the process/application fallback. `PUT
/user-preference` validates a registered provider and non-empty strings, but
accepts an arbitrary model slug. Startup environment variables do not rewrite
the file.

The GUI calls the per-Session localStorage entry the Session current setting.
The picker and admission resolve the next-Turn target in this order:

1. Session current setting.
2. User preference from `GET /providers`.
3. Process/application default from `GET /providers`.

Selecting a model updates the Session current setting immediately and then
persists the same value through `PUT /user-preference`. Admission always stamps
the resolved target when one is available.

When selecting an existing Session without a localStorage entry, the GUI
performs `RestoreFromThread`: replayed `turn.started.executionContext` facts
hydrate the Session current setting, with the latest started Turn winning.
This is a one-way reconstruction from read-only history. It does not update
the user preference file, and later global preference changes do not replace
the restored Session setting.

## Consequences

- The picker describes next-Turn intent rather than the last completed Turn.
- New Sessions start from a durable user preference, while resumed Sessions
  retain their reconstructed or explicitly selected current target.
- Session facts, kernel model-selection contracts, model-directory snapshots,
  and Runtime's inherit-last-Turn safety net remain unchanged.
- The GUI remains the only owner of Session current persistence; the server
  does not add mutable Session-level settings.
