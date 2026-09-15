# Develop the framework

English · [Korean](ko/development.md) · [README](../README.md)

To build an application using the package, start with [installation](getting-started.md).
For framework changes, clone the repository and use Node 24 or later and the pnpm
version declared in `package.json`.

```sh
git clone https://github.com/zeakd/cli-for-ai-ts.git
cd cli-for-ai-ts
pnpm install --frozen-lockfile
pnpm build
pnpm lint
pnpm typecheck
pnpm test
```

The examples import the built package through workspace dependencies. After building,
run `node examples/local-cli/src/cli.ts --help` and follow the
[notebook walkthrough](notebook-example.md). Tests cover declarations, execution,
real processes, both examples and installed package consumers.

Package maintainers can publish through the [release workflow](releasing.md).
