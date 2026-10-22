# rippel

A self-hosted studio over ComfyUI. This is a monorepo:

- `apps/api`: Fastify and TypeScript
- `apps/web`: React and Vite
- `apps/agent/go`: the machine agent
- `apps/tray`: the Tauri Windows tray
- `packages/shared`: the types both sides use

**Read `docs/DEVELOPMENT.md` before changing anything.** It covers where things run and the change → test → push → deploy loop. It also covers releasing the agent and the mistakes not to repeat.

The short version:

- **Where to work:** make changes on the dev box checkout, test them, and push to GitHub `master`.
- **Deploying:** pull and restart on the **lilypad** VM (`ssh lilypad`, `~/rippel`). Never edit lilypad's checkout.
- **Checks to run:**
  - after changing shared types: `npm run build -w @comfy/shared`
  - in the web app: `npx tsc -b`, not `tsc -p .`
- **Plans:** write a plan in `docs/plans/` for anything bigger than a fix.
