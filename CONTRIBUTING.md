# Contributing to CreateOS Claude Plugins

Contributions are welcome! This repository is a monorepo of integrations and plugins for
[CreateOS](https://nodeops.network/createos). Each package in `packages/` is self-contained;
apps in `apps/` are standalone projects.

## What you can contribute

- Bug fixes and new features in existing packages or apps.
- New integrations or plugins (please open an issue first to discuss the fit).
- Documentation improvements.

## Submitting a pull request

1. Fork the repository and create a branch for your change.
2. Keep each PR scoped to one package or app.
3. Use [Conventional Commit](https://www.conventionalcommits.org/) style for your PR title
   (e.g. `feat(opencode): add X`, `fix(pi-extension): handle Y`, `fix(cos): correct Z`).
4. Run lint, build, and tests for the package you changed before opening the PR.
5. Open a pull request. A maintainer will review it and, once approved, merge it into `main`.

## Code style

- Follow the conventions already established in the package you are modifying.
- Use TypeScript where applicable.
- Keep changes focused and minimal.

## Reporting issues

Found a bug or have a feature request? Open an issue, but please check for duplicates first.

## License

By contributing, you agree that your contributions will be licensed under the same license as
the project (see [LICENSE](./LICENSE)).
