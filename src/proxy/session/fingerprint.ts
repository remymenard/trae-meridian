/**
 * Conversation fingerprinting and client working directory extraction.
 *
 * NOTE: extractClientCwd is OpenCode-specific (parses <env> blocks).
 * When the adapter pattern is implemented, this will move to the
 * OpenCode adapter. getConversationFingerprint is agent-agnostic.
 */

import { createHash } from "crypto"

/**
 * Extract the client's working directory from the system prompt.
 * OpenCode embeds it inside an <env> block:
 *   <env>
 *     Working directory: /path/to/project
 *     ...
 *   </env>
 *
 * Returns the path if found, or undefined to fall back to server defaults.
 */
export function extractClientCwd(body: any): string | undefined {
  let systemText = ""
  if (typeof body.system === "string") {
    systemText = body.system
  } else if (Array.isArray(body.system)) {
    systemText = body.system
      .filter((b: any) => b.type === "text" && b.text)
      .map((b: any) => b.text)
      .join("\n")
  }
  if (!systemText) return undefined

  const match = systemText.match(/<env>\s*[\s\S]*?Working directory:\s*([^\n<]+)/i)
  return match?.[1]?.trim() || undefined
}

/**
 * Find the first tool_use id (or tool_result's tool_use_id) in the conversation.
 * Tool-call ids are generated per agent run and are stable within a flow but
 * unique across concurrent flows, so two subagents that share an identical
 * first user message (a templated subagent prompt) still diverge here as soon
 * as either one makes its first tool call. Returns undefined on the very first
 * turn (before any tool call), where the flows are genuinely indistinguishable.
 */
function firstToolCallId(messages: Array<{ role: string; content: any }>): string | undefined {
  for (const msg of messages) {
    if (!Array.isArray(msg?.content)) continue
    for (const b of msg.content as any[]) {
      if (b?.type === "tool_use" && b.id) return String(b.id)
      if (b?.type === "tool_result" && b.tool_use_id) return String(b.tool_use_id)
    }
  }
  return undefined
}

/**
 * Hash the first user message + working directory to fingerprint a conversation.
 * Used to find a cached session when no session header is present.
 * Includes workingDirectory (stable per project, unlike systemContext which
 * contains dynamic file trees/diagnostics that change every request).
 * This prevents cross-project collisions when different projects start
 * with the same first message.
 *
 * Also mixes in the first tool-call id (when present): headerless clients such
 * as Trae run several subagents whose first user message is an identical
 * templated prompt, so the (first message, cwd) pair alone collides and the
 * flows evict each other's cached session every turn. The first tool-call id is
 * stable within a flow but unique per concurrent flow, so once a subagent has
 * made a tool call its fingerprint separates from its siblings and each keeps
 * its own prompt cache. The very first turn (no tool call yet) still collides,
 * but that is a cold start with nothing cached to lose.
 */
export function getConversationFingerprint(messages: Array<{ role: string; content: any }>, workingDirectory?: string): string {
  const firstUser = messages?.find((m) => m.role === "user")
  if (!firstUser) return ""
  const text = typeof firstUser.content === "string"
    ? firstUser.content
    : Array.isArray(firstUser.content)
      ? firstUser.content.filter((b: any) => b.type === "text").map((b: any) => b.text).join("")
      : ""
  if (!text) return ""
  const toolId = messages ? firstToolCallId(messages) : undefined
  const base = workingDirectory ? `${workingDirectory}\n${text.slice(0, 2000)}` : text.slice(0, 2000)
  const seed = toolId ? `${base}\n tool:${toolId}` : base
  return createHash("sha256").update(seed).digest("hex").slice(0, 16)
}

/**
 * The "base" fingerprint - first user message + cwd only, WITHOUT the tool-call
 * id. This is what the primary fingerprint reduces to on turn 1 (before any tool
 * call). lookupSession falls back to this key so the turn where the first tool
 * call appears (primary key changes base -> base+toolId) still resumes the
 * session stored on turn 1, instead of missing the cache once per flow.
 * Returns "" when there is no tool id (base would equal the primary fingerprint).
 */
export function getBaseFingerprintIfDifferent(messages: Array<{ role: string; content: any }>, workingDirectory?: string): string {
  if (!messages || !firstToolCallId(messages)) return ""
  const firstUser = messages.find((m) => m.role === "user")
  if (!firstUser) return ""
  const text = typeof firstUser.content === "string"
    ? firstUser.content
    : Array.isArray(firstUser.content)
      ? firstUser.content.filter((b: any) => b.type === "text").map((b: any) => b.text).join("")
      : ""
  if (!text) return ""
  const base = workingDirectory ? `${workingDirectory}\n${text.slice(0, 2000)}` : text.slice(0, 2000)
  return createHash("sha256").update(base).digest("hex").slice(0, 16)
}
