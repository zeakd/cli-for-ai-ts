# Releasing to npm

English · [Korean](ko/releasing.md) · [Development](development.md)

The `Release` workflow (`release.yml`) runs manually from `main`. Enter the exact
package version and select `next` or `latest`. Leave `publish` disabled to run
checks and verify the packed artifact without publishing.

Before publishing, verify the code and documentation, update the package version
(and lockfile if dependencies changed), and make this repository public. The workflow refuses a product publication from a
private repository and includes provenance. A prerelease must use `next`.

The npm trusted publisher must match `zeakd/cli-for-ai-ts`, workflow `release.yml`,
environment `npm`, with direct publishing enabled. Use GitHub-hosted runners;
no npm token secret is required. Saving this configuration does not prove an
OIDC publication works. That is verified only by a successful actual publication.

The workflow checks, builds and then packs once, installs the tarball into a temporary
consumer and runs it, checks all export files, and publishes that same tarball. `--ignore-scripts`
at pack/publish avoids rebuilding after the checks. npm versions are immutable; bump the version to release again.

See [npm trusted publishing](https://docs.npmjs.com/trusted-publishers/).


## Deployment permissions

Create the `npm` GitHub environment before enabling trusted publishing. Configure
selected deployment branches with one branch rule, `main` (not a tag pattern).
This server-side rule is required: a branch can edit its own workflow conditions.
Protect main according to the repository's review policy; environment protection
is not a substitute for controlling changes to main or environment settings.

Verification runs without the npm environment or OIDC permission. Only the publish
job receives them, after verification succeeds. It installs no project dependencies
and runs no project tests. It downloads the verified artifact and checks its SHA-512
against the verify job output before publishing. A check-only run never starts this job.
Regular CI also tests packaging. A non-main manual run fails its identity check.

Use `latest` for the default installation and `next` for a prerelease.
