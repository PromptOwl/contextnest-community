# Central harness

A **harness** is where a nest's agents run. When you create a nest, the "Connect a harness" step offers three choices:

| | Local | Central lite | Central durable |
|---|---|---|---|
| Where the agent runs | Your computer | One small server | A server or a cluster |
| Who it serves | You | The team | The team |
| Keeps working when you close your laptop | No | Yes | Yes, and across restarts |
| Long jobs that wait for approvals | No | No | Yes |
| Model key lives in | Your agent | The gateway | The gateway |
| Status | Available | Deploy bundle not published yet | Deploy bundle not published yet |

## Local

Connect Claude Code, Cursor, opencode or any MCP client to the nest's MCP URL with an API key (or sign-in, where the client supports it). Use **Connect** in the nest, or the agent tiles on the welcome screen. Nothing runs on a server.

## Central lite

One small Linux server running Docker with two services:

- **A runner**: a coding agent in headless mode (Claude Code or opencode). It holds a nest key of its own, labelled with its @handle.
- **A model gateway** (LiteLLM). It holds the model provider's key; the runner calls models through it, so the runner never holds a vendor key, and every call is metered in one place.

When someone mentions the agent's @handle in a channel, the nest sends the runner one signed wake-up (an agent webhook). The runner reads the thread, does the work and replies in the thread with its own key. There is no workflow engine: a job that outlives one reply is not resumed after a restart.

You need: a small server with Docker and an outbound internet connection, a public HTTPS address for the wake-up (or a tunnel), and a model API key.

## Central durable

Central lite plus a **workflow engine** (Temporal). Each piece of work is a durable workflow: it survives restarts, waits for a person's approval in the thread for as long as it takes, and picks up where it left off. Use it when agents run multi-stage work, such as the Product factory recipe's eight stages, without anyone watching.

You need: a server with Docker, or a Kubernetes cluster; persistent storage for the workflow engine's database; a model API key.

## Security notes, whichever you choose

- Keep the runner's ports private. Reach the services through a tunnel or a private network, not a public port.
- Put the model key in the gateway only. Give the runner a nest key scoped to the nests it works in.
- Store secrets in your platform's secret store, not in files on the server.

## Status

The one-step deploy (a CloudFormation template for a single server, and a Helm chart for Kubernetes) is not published yet. Until it is, connect a local agent. This page will link the bundle when it ships.
