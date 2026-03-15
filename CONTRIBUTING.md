# Contributing to whip-whep-client

Thank you for considering contributing! This guide follows the conventions used by
[Vite](https://github.com/vitejs/vite) and [Nuxt](https://github.com/nuxt/nuxt).

## Table of Contents

- [Development Setup](#development-setup)
- [Project Structure](#project-structure)
- [Commit Convention](#commit-convention)
- [Pull Request Guidelines](#pull-request-guidelines)
- [Releasing](#releasing)

---

## Development Setup

**Prerequisites:** Node.js ≥ 20, npm ≥ 10.

```bash
git clone https://github.com/your-org/whip-whep-client.git
cd whip-whep-client
npm install
```

| Command                 | Description                              |
|-------------------------|------------------------------------------|
| `npm run build`         | Build `dist/` with tsup                  |
| `npm run build:watch`   | Rebuild on file change                   |
| `npm test`              | Run unit tests (Vitest)                  |
| `npm run test:watch`    | Watch mode                               |
| `npm run test:coverage` | Coverage report                          |
| `npm run typecheck`     | TypeScript type check (no emit)          |
| `npm run lint`          | ESLint                                   |
| `npm run lint:fix`      | ESLint with auto-fix                     |
| `npm run format`        | Prettier format                          |
| `npm run format:check`  | Prettier check (used in CI)              |

---

## Project Structure

```
src/
  core/         BaseClient, shared types, custom errors
  whip/         WHIPClient (publisher)
  whep/         WHEPClient (viewer)
  utils/        Pure SDP and ICE helper functions
tests/          Vitest unit tests mirroring src/
examples/       Self-contained HTML demo pages
```

---

## Commit Convention

We follow [Conventional Commits](https://www.conventionalcommits.org/).

```
<type>(<scope>): <subject>

[optional body]

[optional footer(s)]
```

### Types

| Type       | When to use                                      |
|------------|--------------------------------------------------|
| `feat`     | A new feature                                    |
| `fix`      | A bug fix                                        |
| `perf`     | Performance improvement                          |
| `refactor` | Code change that is neither feat nor fix         |
| `test`     | Adding or correcting tests                       |
| `docs`     | Documentation only changes                       |
| `build`    | Build system / external dependency changes       |
| `ci`       | CI configuration changes                         |
| `chore`    | Other changes that don't modify src or test files|

### Examples

```
feat(whip): add simulcast support
fix(sdp): correct b=TIAS calculation for audio
perf(ice): buffer candidates before PATCH to reduce round-trips
docs: update README API reference for v0.3
```

Breaking changes must include `BREAKING CHANGE:` in the footer **or** use a `!`
after the type: `feat(core)!: rename WHIPError to PublishError`.

---

## Pull Request Guidelines

1. Keep PRs focused – one feature or fix per PR.
2. Update tests for every code change.
3. Run `npm test && npm run typecheck` locally before opening a PR.
4. Add a [changeset](#releasing) when your PR changes the public API or fixes a bug.
5. Reference the related issue: `Closes #42`.

---

## Releasing

This project uses [Changesets](https://github.com/changesets/changesets) for
versioning, following the same approach as Vite and Nuxt.

### Adding a changeset

After making your changes, run:

```bash
npx changeset
```

Select the bump type (`patch` / `minor` / `major`), write a brief description,
and commit the generated file in `.changeset/`.

### Publishing a release (maintainers only)

The CI pipeline runs `changeset version` on merge to `main` and opens a
"Version Packages" PR. Merging that PR triggers the publish workflow.

---

## Code Style

- **4-space indentation** (enforced by Prettier)
- **Guard clauses** over deeply nested conditionals
- **Object literals** instead of `switch` for dispatch maps
- **No comments** that merely restate what the code already says
- TypeScript `strict` mode is enabled – no `any` without explicit justification
