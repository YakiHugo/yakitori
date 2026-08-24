# Yakitori

Yakitori is a from-scratch local coding-agent harness and GUI. The current
priority is one reliable Mate with one inspectable execution lane, solid tools,
permissions, persistence, recovery, and a task workbench. Persistent-memory
Mates collaborating in shared Rooms are the later product direction, not an
implemented capability.

The project learns from public coding-agent implementations while building its
runtime and product boundaries directly. It does not wrap an existing agent
framework.

## Local development

Yakitori requires Node.js 24 or newer and pnpm 11.7.0.

```sh
pnpm install
pnpm dev:desktop
```

`pnpm dev:desktop` runs the Electron shell with Vite HMR and a dedicated local
server. To run the server and GUI in a browser instead:

```sh
pnpm dev
```

Open `http://127.0.0.1:5173?api=http://127.0.0.1:4141`. The default faux
provider requires no credentials.

For a network provider, copy `.env.example` to the gitignored `.env`, select a
provider and model, and add only the credentials you use. Real process
environment variables override `.env`.

Run the desktop app with production-style bundles:

```sh
pnpm start:desktop
```

## Verification

Run the full local check:

```sh
pnpm check
```

Build the GUI or desktop bundle explicitly:

```sh
pnpm build:gui
pnpm build:desktop
```

`package.json` is authoritative for all development, test, build, and packaging
scripts. `.env.example` and the corresponding source boundaries are
authoritative for configuration.
