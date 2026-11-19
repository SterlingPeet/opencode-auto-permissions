import type { PermissionRequest, RuntimeContext } from "./types.ts"

// Bounds on what one server plugin instance caches, because a long-lived
// server sees every session and would otherwise grow without limit.
const MAX_SESSION_CACHE = 256
const MAX_MESSAGE_CACHE = 32
const MAX_PERMISSION_CACHE = 64
const MAX_MESSAGES_PER_SESSION = 200

export interface ServerSessionInfo {
  id: string
  parentID?: string
  location?: { directory?: string; workspaceID?: string }
}

export interface ServerRuntime {
  /** The RuntimeContext the review pipeline reads, without resumeAfterDenial. */
  context: RuntimeContext
  listeners: Map<string, Set<(event: unknown) => void>>
  getSession(sessionID: string): Promise<ServerSessionInfo | undefined>
  clear(): void
}

/**
 * Adapts the OpenCode 2 server plugin context to the RuntimeContext the review
 * pipeline reads, with bounded session, message and permission caches. The
 * server reviewer and the permission evaluate hook both use it.
 */
export function createServerRuntime(context: any): ServerRuntime {
  const listeners = new Map<string, Set<(event: unknown) => void>>()
  const sessions = new Map<string, ServerSessionInfo>()
  const messages = new Map<string, unknown[]>()
  const permissions = new Map<string, PermissionRequest[]>()

  const getSession = async (sessionID: string): Promise<ServerSessionInfo | undefined> => {
    const cached = sessions.get(sessionID)
    if (cached) return cached
    const fetched = unwrapServerData(await context.session.get({ sessionID }))
    if (!isRecord(fetched) || typeof fetched.id !== "string") return undefined
    const info = {
      id: fetched.id,
      ...(typeof fetched.parentID === "string" ? { parentID: fetched.parentID } : {}),
      ...(isRecord(fetched.location) ? { location: fetched.location } : {}),
    }
    setBounded(sessions, sessionID, info, MAX_SESSION_CACHE)
    return info
  }

  const root = async (sessionID: string): Promise<string> => {
    const seen = new Set<string>()
    let current = sessionID
    while (!seen.has(current)) {
      seen.add(current)
      const info = await getSession(current).catch(() => undefined)
      if (!info) return sessionID
      if (!info.parentID) return current
      current = info.parentID
    }
    return sessionID
  }

  const runtimeContext: RuntimeContext = {
    options: context.options,
    client: context,
    location: context.location,
    data: {
      on(type, handler) {
        const set = listeners.get(type) ?? new Set<(event: unknown) => void>()
        set.add(handler)
        listeners.set(type, set)
        return () => set.delete(handler)
      },
      session: {
        root,
        get: (sessionID) => sessions.get(sessionID),
        message: {
          list: (sessionID) => messages.get(sessionID) ?? [],
          get: (sessionID, messageID) =>
            (messages.get(sessionID) ?? []).find((message) => isRecord(message) && message.id === messageID),
          sync: async (sessionID) => {
            const list = unwrapServerData(await context.session.context({ sessionID }))
            const bounded = Array.isArray(list) ? list.slice(-MAX_MESSAGES_PER_SESSION) : []
            setBounded(messages, sessionID, bounded, MAX_MESSAGE_CACHE)
          },
        },
        permission: {
          list: (sessionID) => permissions.get(sessionID),
          sync: async (sessionID) => {
            const list = unwrapServerData(await context.permission.list({ sessionID }))
            setBounded(permissions, sessionID, Array.isArray(list) ? list : [], MAX_PERMISSION_CACHE)
          },
        },
      },
      location: { default: () => context.location ?? {} },
    },
  }

  return {
    context: runtimeContext,
    listeners,
    getSession,
    clear() {
      listeners.clear()
      sessions.clear()
      messages.clear()
      permissions.clear()
    },
  }
}

function setBounded<K, V>(map: Map<K, V>, key: K, value: V, limit: number): void {
  if (!map.has(key) && map.size >= limit) {
    const oldest = map.keys().next().value
    if (oldest !== undefined) map.delete(oldest)
  }
  map.set(key, value)
}

export function unwrapServerData(result: unknown): unknown {
  let value = result
  for (let depth = 0; depth < 3 && isRecord(value) && "data" in value; depth++) {
    value = value.data
  }
  return value
}

function isRecord(value: unknown): value is Record<string, any> {
  return typeof value === "object" && value !== null && !Array.isArray(value)
}
