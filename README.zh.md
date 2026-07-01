<div align="center">

<picture>
  <source media="(prefers-color-scheme: dark)" srcset="resources/openfuse_logo_dark.png" />
  <img alt="Openfuse" src="resources/openfuse_logo_horizontal.png" width="340" />
</picture>

### 把 LLM engineering 跑在一个真正的可观测性数据库上

[![Release](https://img.shields.io/badge/release-1.0.0--alpha.3-f97316)](https://github.com/tma1-ai/openfuse/releases)
[![Docker Standalone](https://img.shields.io/docker/v/tma1ai/openfuse-standalone?label=docker%20standalone&sort=semver&color=2496ed)](https://hub.docker.com/r/tma1ai/openfuse-standalone)
[![Status](https://img.shields.io/badge/status-alpha-eab308)](docs/known-limitations.md)
[![License](https://img.shields.io/badge/license-MIT-3b82f6)](LICENSE)
[![Based on Langfuse](https://img.shields.io/badge/based%20on-Langfuse%20v3.184.1-0ea5e9)](https://github.com/langfuse/langfuse)

[快速开始](#5-分钟快速开始docker-compose) · [部署](docs/deployment.md) · [运维](docs/operations.md) · [架构](docs/architecture.md) · [已知限制](docs/known-limitations.md) · [English](README.md)

</div>

Openfuse 是 [Langfuse](https://github.com/langfuse/langfuse) 的一个 fork，把分析存储从 ClickHouse 换成了 [GreptimeDB](https://github.com/GreptimeTeam/greptimedb)。Langfuse 的产品、公共 API 和 SDK 都保持不变；GreptimeDB 成为 traces、observations、scores 以及 dashboard 背后分析数据的 source of truth。

## 为什么是 GreptimeDB

LLM trace 本质就是可观测性数据：带高基数上下文的、带时间戳的宽事件（wide events）。这正好是 [GreptimeDB](https://docs.greptime.com/user-guide/concepts/why-greptimedb) 的数据模型。GreptimeDB 是一个统一的可观测性数据库——metrics、logs、traces 一个引擎，SQL 和 PromQL/TQL 都能查，OTLP 原生，存算分离、底层基于对象存储。把 Langfuse 跑在它上面（而不是绑死在一个单用途的列存上），今天就能拿到两点好处：

- **从单机起步，随规模 scale。** 先用一个 `openfuse-standalone` 容器跑起来——这是 GreptimeDB standalone 的对应物。GreptimeDB 数据落在本地磁盘或对象存储上，同一套引擎能随数据增长从单节点扩到集群，缩容也不丢数据。对象存储是可选的：ingestion 不需要 S3 或 MinIO。
- **便宜的长周期保留。** object-storage-native 的分层存储，加上一条纯 SQL 的整库 TTL（`LANGFUSE_GREPTIME_TTL`），让数月乃至数年的保留成本可控——这是 ClickHouse 版 Langfuse 的一个痛点，而在 Langfuse 里可配置的数据保留是 Enterprise 功能。注意这里的 TTL 是 deployment 级、整库一刀切，不是 per-project。

它还打开了单用途存储给不了的方向。因为事件本来就存在一个真正的可观测性数据库里，GreptimeDB 有可能把 Openfuse 带到 Langfuse parity **之外**：PromQL 原生的 metrics、logs ↔ traces 关联、OTLP 原生 ingestion、用 Flow 做预聚合 rollup。这些都是**方向性的、尚未交付**——作为想法记录在 [issue #8](https://github.com/tma1-ai/openfuse/issues/8)，不是今天能用的功能。

## 截图

完整的 Langfuse UI，数据全部由 GreptimeDB 提供。

<table>
  <tr>
    <td width="50%"><img src="resources/screenshots/openfuse-dashboard-home.png" alt="Openfuse 首页 dashboard——traces、模型成本、scores、延迟分析" /><br/><sub>首页 dashboard——traces、模型成本、scores、延迟分析</sub></td>
    <td width="50%"><img src="resources/screenshots/openfuse-trace-detail.png" alt="带嵌套 observation 树的 trace 详情" /><br/><sub>Trace 详情——嵌套 observation 树</sub></td>
  </tr>
  <tr>
    <td width="50%"><img src="resources/screenshots/openfuse-traces-list.png" alt="带筛选的 traces 列表" /><br/><sub>Traces 列表</sub></td>
    <td width="50%"><img src="resources/screenshots/openfuse-session-detail.png" alt="Session 视图" /><br/><sub>Session 视图</sub></td>
  </tr>
</table>

## 今天可用的能力

- **现有 Langfuse SDK 原样可用。** 把任意 Langfuse SDK——或任意 OpenTelemetry tracer——指向 Openfuse，traces、observations、scores 零改代码就能写入。
- **完整的 tracing UI。** 浏览 trace 和嵌套 observation、sessions、users，搜索和筛选都跟 Langfuse 一致。
- **Dashboard 和 metrics。** 成本、token 用量、延迟百分位、score 分析，可按 metadata、tag、tool 筛选和拆分。覆盖到的 parity case 与上游 Langfuse 对齐；有意差异见 [parity report](docs/greptimedb-migration/parity/PARITY-REPORT.md)。
- **Datasets、experiments、评估。** 评估工作流端到端可用。
- **编辑、删除、导出。** UI 编辑、删除、数据导出都按预期工作，包括整个 project 删除。
- **单容器自托管。** standalone 镜像一把拉起整个栈，首次启动自动准备好存储——不需要手动迁移数据库。

## 5 分钟快速开始（Docker Compose）

需要 Docker 和 Docker Compose。最快的方式是单个 `openfuse-standalone` 容器——web + worker 跑在一个进程里——再接上 Postgres、Redis、GreptimeDB。两套 schema 在启动时自动迁移，对象存储默认关闭。

```bash
git clone https://github.com/tma1-ai/openfuse.git
cd openfuse
cp .env.quickstart.example .env
OPENFUSE_STANDALONE_IMAGE=tma1ai/openfuse-standalone:1.0.0-alpha.3 \
  docker compose -f docker-compose.standalone.yml up -d --pull always
```

打开 <http://localhost:3000>。quickstart 的 env 会自动创建一个 demo project，所以你可以直接用 `demo@example.com` / `langfuse-dev` 登录，或者把任意 Langfuse SDK 指向内置的 key（`pk-lf-1234567890` / `sk-lf-1234567890`）。这些是不安全的 dev 默认值——正式部署请从 `.env.prod.example` 出发、自己生成 secret，并为分析存储设置 GreptimeDB 密码（`GREPTIME_PASSWORD`）以开启强制鉴权。完整指南见[部署文档](docs/deployment.md)。

如果要从当前 checkout 本地构建 standalone 镜像，而不是拉发布镜像：

```bash
docker compose -f docker-compose.standalone.yml up -d
```

### 拆分 web + worker

要让 web 和 worker 独立扩缩，改用默认的 `docker-compose.yml`（`openfuse-web` 和 `openfuse-worker` 两个独立镜像）：

```bash
OPENFUSE_WEB_IMAGE=tma1ai/openfuse-web:1.0.0-alpha.3 \
OPENFUSE_WORKER_IMAGE=tma1ai/openfuse-worker:1.0.0-alpha.3 \
  docker compose up -d --pull always
```

## 项目状态

Openfuse 处于 **alpha**，正在向 beta 推进。ClickHouse → GreptimeDB 的迁移已经落地，读路径与上游 Langfuse 做了逐字节 parity 校验，Langfuse 的完整产品、API、SDK 面都能用。欢迎直接上手、拿真实负载跑、提 issue——这些反馈正是推动它走向 beta 的动力。

在依赖它之前，建议先扫一眼[已知限制](docs/known-limitations.md)：一份真正的约束清单，外加少数与上游有意的差异（这些差异里 fork 都是等价或更正确的一侧）。

## 已发布镜像

每打一个 `v*` tag，CI 会把发布镜像推到 Docker Hub：

- [`tma1ai/openfuse-web`](https://hub.docker.com/r/tma1ai/openfuse-web)
- [`tma1ai/openfuse-worker`](https://hub.docker.com/r/tma1ai/openfuse-worker)
- [`tma1ai/openfuse-standalone`](https://hub.docker.com/r/tma1ai/openfuse-standalone)——web + worker 一个容器，用于单机自托管

当前预览版是 `1.0.0-alpha.3`。要直接跑 standalone 发布镜像而不是本地 build，在 `.env` 里固定一个 tag：

```bash
OPENFUSE_STANDALONE_IMAGE=tma1ai/openfuse-standalone:1.0.0-alpha.3
```

然后启动：

```bash
docker compose -f docker-compose.standalone.yml up -d --pull always
```

standalone、split web/worker 镜像和 tag 策略的完整说明见[部署文档](docs/deployment.md#published-images-and-tags)。

## 架构

Postgres 存应用和配置数据（users、projects、prompts、dataset 定义、API key），与上游 Langfuse 一致。GreptimeDB 是分析事件存储：一个 append-only 的 `raw_events` 表作为 source of truth，加上合并后的 projection 表，以及给 metadata/tag/tool filter 用的带索引 EAV 旁表。Redis 跑 BullMQ 队列。默认栈不需要对象存储（S3/MinIO）：media 上传、OTel carrier、eval blob store 默认走本地文件系统。可选的 batch/blob export 仍然需要 S3-compatible bucket。

完整说明见[架构文档](docs/architecture.md)。

## 与 Langfuse 的兼容性

Openfuse `1.0.0-alpha.3` 基于上游 Langfuse `v3.184.1`。现有 Langfuse SDK 和公共 ingestion/REST API 保持不变。Dashboard 和 metrics 输出在覆盖到的查询面上与上游做了逐字节比对；少数有意的差异——都是 fork 等价或更正确的情形——列在 [parity ledger](docs/greptimedb-migration/parity/ledger.md)。Postgres 迁移就是上游 Langfuse 的、原样套用；GreptimeDB schema 是 fork 特有的，在容器启动时自动迁移（幂等、advisory lock 串行、fail-closed）。

Openfuse 是社区 fork，与 Langfuse 没有从属关系、也未获其背书。完整兼容性声明见[从 Langfuse 迁移](docs/migration-from-langfuse.md)。

## 文档

- [部署](docs/deployment.md)：用 Docker Compose 自托管、env、数据目录、自动迁移、standalone 与发布镜像。
- [运维](docs/operations.md)：监控、性能与 compaction、容量、备份与恢复、升级。
- [开发](docs/development.md)：本地搭建、GreptimeDB schema、定向测试。
- [架构](docs/architecture.md)：什么数据放在哪，以及为什么不再用 ClickHouse。
- [已知限制](docs/known-limitations.md)：部署前请先读。
- [从 Langfuse 迁移](docs/migration-from-langfuse.md)：兼容性与差异。
- [设计历史](docs/greptimedb-migration/)：迁移的工程记录（设计笔记、review、parity harness）。

## 贡献与安全

参与贡献见 [CONTRIBUTING.md](CONTRIBUTING.md)，报告漏洞见 [SECURITY.md](SECURITY.md)。

## 许可证

本 fork 沿用上游 Langfuse 的许可：核心是 MIT；`ee/` 走 Langfuse EE 许可。Openfuse 是 Langfuse 的社区 fork，保留上游版权与署名。见 [LICENSE](LICENSE)。
