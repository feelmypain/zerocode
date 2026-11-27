# FAQ

## Is ZeroCode a harness?

No. A harness is what turns an LLM into an agent: it gives the model tools, a way to call them, runs them, and hands the results back. Claude Code is an interface (the TUI and desktop app) paired with a harness underneath (the Anthropic Agent SDK). Codex has a similar split with the Codex App Server. ZeroCode drives those harnesses rather than replacing them, and requires at least one installed provider harness to run threads.

Supported providers include Claude Code, Codex, Cursor, Grok Build, OpenCode, Google Antigravity, Kiro, Pi, Muse Code, fx, and ACP Registry agents. [Provider setup](./install.md#providers)

## Why use ZeroCode instead of Claude Code or the Codex app?

ZeroCode provides a unified control plane across multiple coding agents:

- Bring your own subscriptions: use Claude, Codex, and whatever other providers you already have installed.
- Remote-first workflows: run `zerocode up` on any machine and drive it from desktop, web, or mobile.
- Native mobile client for monitoring and approving work away from your desk.
- Open source under the MIT License.

Every provider shares the same workspace, diff review, and orchestration UI. [Install](./install.md)

## Can I use ZeroCode with my Claude Code subscription?

Yes.

## How much does ZeroCode cost?

ZeroCode is free and open source under the [MIT License](../../LICENSE). You bring your own provider subscriptions or API keys and pay your providers directly. You can self-host everything, connect over your LAN or Tailscale, or configure a ZeroCode Connect relay. [Install](./install.md)

## Can I fork or redistribute ZeroCode?

Yes. ZeroCode is distributed under the [MIT License](../../LICENSE). See [TRADEMARK.md](../../TRADEMARK.md) for branding details.

## Can I connect more than 3 machines with ZeroCode Connect?

On a relay configured with the default limit, each ZeroCode Connect account can link up to 3 machines (phones and browsers do not count). To connect more machines without raising the relay limit, use Tailscale or a self-hosted relay.

## Why is my Claude 5-hour limit draining so fast?

ZeroCode drives Claude through Anthropic's Agent SDK. Older releases saw higher 5-hour meter usage compared to running Claude Code directly; current versions of ZeroCode match Claude Code's usage rate. If you still see elevated drain, [update ZeroCode](./updating.md) on the machine that runs your agents.

## How do I use ZeroCode remotely?

Your agents run wherever the ZeroCode server runs: your desktop, a home server, or a VPS. Run `zerocode up` on that machine to configure remote access via ZeroCode Connect, LAN pairing, or Tailscale, and connect from desktop, mobile, or a self-hosted web client. [Remote access](./remote-access.md)

## How do I use ZeroCode on my phone?

Install or build the ZeroCode mobile app for iOS or Android, then connect it to your computer with ZeroCode Connect or a pairing link. Your phone acts as a remote control—your host computer runs the agents and needs to stay online. [Mobile setup](./install.md#mobile-app) · [Remote access](./remote-access.md)

## Why does ZeroCode Connect keep disconnecting?

ZeroCode Connect provides tunnel-based remote access without manual port forwarding. If a connection keeps dropping, open **Settings > Environments**, find the machine, and select **Details**—the first part marked as failed shows the cause. Tailscale or a direct LAN route can also be configured alongside ZeroCode Connect as a fallback. [ZeroCode Connect troubleshooting](./zerocode-connect-troubleshooting.md)

## Will I get banned for using my subscription?

ZeroCode runs each provider's official CLI, SDK, or ACP integration using your local authentication on your own machine.

## Can I add multiple accounts for one provider?

ZeroCode supports adding multiple provider instances for separate accounts (for example, work and personal): [Codex](./providers-codex.md#use-multiple-accounts) · [Claude](./providers-claude.md#separate-accounts-or-configurations). For managing a larger pool of accounts, use an external self-hosted proxy such as [CLIProxyAPI](https://github.com/router-for-me/CLIProxyAPI). After configuring a hub, ZeroCode can display its pooled limits under Usage. [Connect a hub](./usage.md#connect-a-cliproxyapi-hub)

## Can I use an API key or OpenRouter instead of a subscription?

Yes. Add another provider instance in Settings and configure its own keys and endpoint. Claude includes a full OpenRouter setup recipe, leaving your subscription instance untouched. [OpenRouter](./providers-claude.md#openrouter) · [Provider instances](./install.md#providers)

## Does ZeroCode support local models?

ZeroCode focuses on full coding-agent harnesses, though providers that support custom endpoints (such as OpenCode, Pi, or text generation models via OpenAI-compatible endpoints like Ollama or LM Studio) can be pointed at local models where supported.

## Does my code go to ZeroCode servers?

No. Your code and prompts go directly from your machine to your configured provider (Anthropic, OpenAI, etc.). With ZeroCode Connect, traffic rides a Cloudflare tunnel (`cloudflared` on your machine); the relay sets up the link and does not proxy your HTTP or WebSocket sessions. ZeroCode collects no product usage analytics, crash reports, agent feedback, or relay connection traces. [Diagnostics and telemetry](./telemetry.md)

## Worktrees are eating my disk. How do I clean them up?

Open **Settings → Worktrees → Cleanup** and turn on automatic worktree cleanup. You can also run cleanup immediately from there. [Storage cleanup](./project-settings.md#storage-cleanup)

## Is there voice input?

Yes. On iPhone and Android, dictation uses on-device speech by default, with the option to use a paired environment. On macOS 26 or later, desktop users can choose Apple Speech directly under **On this Mac** or choose an environment. Web and other desktop users can enable dictation by choosing an environment. The transcript goes into your draft for review. See [Voice input](./voice-input.md).

## Does it work on Windows, Mac, and Linux?

Yes, all three—desktop app, CLI, and server. One catch: there is no standalone `zerocode` binary for Intel Macs, so use the desktop app or build from source there. Windows users can also run agents inside WSL. [Install](./install.md)

## Why is my provider not showing up?

Usually the provider CLI is not installed or not on the `PATH` of the machine running the ZeroCode server (not your phone—the host computer). Sign in on that machine first (for example, `codex login` or `claude auth login`). If it is still missing, point **Binary path** at the executable in provider settings, especially when using version managers. [Provider setup](./install.md#providers)
