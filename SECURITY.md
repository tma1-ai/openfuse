# Security Policy

Openfuse is a developer-preview fork of [Langfuse](https://github.com/langfuse/langfuse) that replaces ClickHouse with GreptimeDB. This policy covers the fork; it is independent of upstream Langfuse and the GreptimeDB project.

## Reporting a vulnerability

**Please do not open a public GitHub issue for security reports.**

Email **killme2008@gmail.com** with:

- a description of the issue and its impact,
- steps to reproduce (or a proof of concept),
- the affected version / commit and deployment shape (Compose, images, env).

You will get an acknowledgement within **5 business days**. We aim to confirm or dispute the report and propose a remediation plan within **15 business days**, prioritized by severity. Because this is an alpha, fixes land on the latest pre-release line rather than as backports.

## Supported versions

Only the **latest pre-release** is supported. There is no long-term support or backport line during the alpha. Run the most recent published `tma1ai/openfuse-{web,worker}` images (or `main`) to receive security fixes.

## Scope

In scope (issues introduced or controlled by this fork):

- the fork's application code and the GreptimeDB integration (write path, read path, deletion/replay, EAV filtering),
- the deployment templates in this repo (Docker Compose, env examples, schema bootstrap),
- the published `tma1ai/openfuse-web` / `tma1ai/openfuse-worker` images,
- public API behavior where it differs from upstream Langfuse because of the GreptimeDB backend.

Out of scope (report these to their respective projects):

- upstream Langfuse code, Langfuse Cloud, and the Langfuse SDK repositories: report to [Langfuse](https://github.com/langfuse/langfuse) (`security@langfuse.com`),
- the GreptimeDB server itself, unless the vulnerability is triggered specifically by how this fork uses it: report to [GreptimeDB](https://github.com/GreptimeTeam/greptimedb),
- vulnerabilities requiring a pre-compromised host, or social-engineering of a maintainer.

## Disclosure

We follow coordinated disclosure: please give us a reasonable window to ship a fix before any public write-up. We will credit reporters who want credit.
