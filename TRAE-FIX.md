# trae-meridian

A fork of [rynfar/meridian](https://github.com/rynfar/meridian) that fixes prompt-cache
reuse for the **Trae IDE** (ByteDance's VS Code fork, User-Agent `hertz`) and other
header-less Anthropic clients.

Everything from upstream Meridian works unchanged. This fork only adds a
session-classification fix described below.

## The problem

Trae connects to Meridian as a custom Anthropic-compatible provider but sends **no
session header** (`x-opencode-session`). Meridian therefore falls back to
content-based session fingerprinting, and two issues caused it to classify almost
every Trae request as a brand-new conversation (`lineage=new`):

1. **`isClientDrivenLoop` over-fired.** A header-less request whose last message is a
   `tool_result` was force-classified as an independent, non-resumable flow. Trae's
   subagents run tool loops, so every one of their turns was treated as new -> the
   full prompt was rewritten (cache-creation, billed 1.25x input) instead of read
   (cache-read, 0.1x) every turn.

2. **Fingerprint collisions between subagents.** The fingerprint hashed only the
   first user message + cwd. Trae launches subagents from an identical templated
   first message, so sibling subagents collided on the same fingerprint and evicted
   each other's cached session.

Measured impact: prompt-cache hit rate ~16% on real Trae sessions.

## The fix

Two small, targeted changes (see `src/proxy/server.ts`, `src/proxy/session/cache.ts`,
`src/proxy/session/fingerprint.ts`):

1. **Trust `verifyLineage` instead of the `isClientDrivenLoop` shortcut.** Run the
   normal fingerprint lookup and only fall back to `diverged` when `verifyLineage`
   did not recognize a clean continuation/compaction. Genuinely divergent concurrent
   loops still classify as `diverged` on their own, so the original pylon-style
   protection is preserved.

2. **Mix the first `tool_use` id into the fingerprint.** Tool-call ids are stable
   within a flow but unique per concurrent flow, so sibling subagents separate as
   soon as either makes its first tool call and each keeps its own cache. A base
   (no-tool-id) fingerprint fallback avoids a one-turn cache miss on the transition
   turn where the first tool call appears.

Measured after the fix: prompt-cache hit rate ~83% on the same workload, with
subagents holding `lineage=continuation` across long tool loops. Full upstream test
suite passes (`bun run test`).

## Build & run

Same as upstream:

```bash
bun install
bun run build      # produces dist/
```

Run it (this fork is served via a `systemctl --user` unit inside a tmux session named
`meridian`, mirroring the upstream local-service setup).

## License

MIT, same as upstream Meridian. This fork retains upstream's history and attribution.
