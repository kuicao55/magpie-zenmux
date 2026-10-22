import { existsSync, readFileSync } from "node:fs"
import { dirname, join } from "node:path"
import { fileURLToPath } from "node:url"
import { SEED_MODELS } from "./models.mjs"

const __dirname = dirname(fileURLToPath(import.meta.url))
const pkg = JSON.parse(readFileSync(join(__dirname, "package.json"), "utf8"))

function loadOfflineIcon() {
  try {
    const svg = readFileSync(join(__dirname, "assets", "icon.svg"))
    return `data:image/svg+xml;base64,${svg.toString("base64")}`
  } catch {
    return pkg.magpie?.icon || "https://cdn.marmot-cloud.com/storage/tbox-router/2025/08/18/mplTJpZ/big-logo.svg"
  }
}

const ID = "zenmux"
const ORIGIN = "https://zenmux.ai"
const OPENAI_BASE = `${ORIGIN}/api/v1`
const ANTHROPIC_BASE = `${ORIGIN}/api/anthropic/v1`
const VERTEX_BASE = `${ORIGIN}/api/vertex-ai/v1`
const MGMT_BASE = `${ORIGIN}/api/v1/management`
const AVAILABLE_MODELS_URL = `${ORIGIN}/api/frontend/model/available/list`
const SUBSCRIPTION_PLANS_URL = `${ORIGIN}/api/subscription/public/get_all_plans`
const ICON = loadOfflineIcon()
const UA = `${pkg.name || "magpie-zenmux"}/${pkg.version || "0.1.0"}`
const TIMEOUT = 20_000
const HOUR = 3600
const DAY = 24 * HOUR
const MODALITIES = ["text", "image", "audio", "video", "pdf"]
const SIGN_IN_HEADER = "x-magpie-sign-in"
const FELL_BACK = Symbol.for("magpie.fellBack")

const text = (v) => (typeof v === "string" && v.trim() ? v.trim() : "")
const num = (v) => {
  const n = Number(v)
  return Number.isFinite(n) ? n : 0
}

// ---- Key classification & Management key resolution -------------------------

function keyOf(auth) {
  return text(auth?.key) || text(auth?.access)
}

function isSubscriptionKey(key) {
  return text(key).startsWith("sk-ss-v1-")
}

function isManagementKey(key) {
  return text(key).startsWith("sk-mg-v1-")
}

function isPaygKey(key) {
  return text(key).startsWith("sk-ai-v1-")
}

function modeOf(auth) {
  const k = keyOf(auth)
  if (isSubscriptionKey(k)) return "subscription"
  if (isPaygKey(k)) return "payg"
  const m = text(auth?.metadata?.mode).toLowerCase()
  if (m === "subscription" || m === "payg") return m
  if (isManagementKey(k)) return "management"
  return "payg"
}

function readSharedManagementKey(directory) {
  const dir = text(directory)
  if (!dir) return ""
  const authFile = join(dir, "plugin-auth.json")
  if (!existsSync(authFile)) return ""
  try {
    const all = JSON.parse(readFileSync(authFile, "utf8"))
    if (!all || typeof all !== "object") return ""
    for (const [k, v] of Object.entries(all)) {
      if (k !== ID && !k.startsWith(`${ID}#`)) continue
      const mk = text(v?.metadata?.managementKey) || text(v?.managementKey)
      if (isManagementKey(mk)) return mk
      const ak = keyOf(v)
      if (isManagementKey(ak)) return ak
    }
  } catch {}
  return ""
}

function managementKeyOf(auth, directory) {
  const own = text(auth?.metadata?.managementKey) || text(auth?.managementKey)
  if (isManagementKey(own)) return own
  const k = keyOf(auth)
  if (isManagementKey(k)) return k
  const shared = readSharedManagementKey(directory)
  if (isManagementKey(shared)) return shared
  const envKey = text(process.env.ZENMUX_MANAGEMENT_API_KEY)
  if (isManagementKey(envKey)) return envKey
  return ""
}

function validateManagementKey(value) {
  const s = text(value)
  if (!s) return undefined
  if (!isManagementKey(s)) {
    return "Management API key must start with sk-mg-v1- (create one at https://zenmux.ai/platform/management)"
  }
  return undefined
}

// ---- HTTP helpers -----------------------------------------------------------

async function readJSON(res) {
  const raw = await res.text().catch(() => "")
  try {
    return raw ? JSON.parse(raw) : null
  } catch {
    return { __text: raw }
  }
}

function said(body, fallback) {
  const raw = body?.error?.message ?? body?.message ?? body?.error ?? body?.__text
  const s = typeof raw === "string" ? raw.trim() : ""
  if (!s || s.startsWith("<")) return fallback
  return s.length > 300 ? s.slice(0, 300) + "…" : s
}

async function getJSON(url, { key, signal } = {}) {
  const headers = { accept: "application/json", "user-agent": UA }
  if (key) headers.authorization = `Bearer ${key}`
  const res = await fetch(url, {
    method: "GET",
    headers,
    signal: signal ?? AbortSignal.timeout(TIMEOUT),
  })
  return { status: res.status, ok: res.ok, body: await readJSON(res) }
}

// ---- Usage formatting (5h / 7d windows, resets, PAYG balance) ---------------

function compactFlows(v) {
  const n = Number(v)
  if (!Number.isFinite(n)) return "0"
  if (n === Math.trunc(n)) return String(Math.trunc(n))
  return String(Number(n.toFixed(2)))
}

function formatUsd(v) {
  const n = Number(v)
  if (!Number.isFinite(n)) return ""
  return `$${n.toFixed(2)}`
}

function roundPercent(ratio) {
  const n = Number(ratio)
  if (!Number.isFinite(n) || n <= 0) return 0
  return Math.round(Math.max(0, n * 100) * 100) / 100
}

function whenISO(v) {
  const s = text(v)
  if (!s) return undefined
  const t = Date.parse(s)
  return Number.isFinite(t) ? new Date(t).toISOString() : undefined
}

function planLabel(tier, status) {
  const t = text(tier).toLowerCase()
  const base = t ? `Builder ${t[0].toUpperCase()}${t.slice(1)}` : "Builder Plan"
  const st = text(status).toLowerCase()
  if (st && st !== "healthy") return `${base} (${st})`
  return base
}

function windowOf(name, span, q) {
  if (!q || typeof q !== "object") return null
  const usedFlows = Math.max(0, num(q.used_flows))
  const maxFlows = Math.max(0, num(q.max_flows))
  if (maxFlows <= 0 && q.usage_percentage === undefined) return null
  const used =
    q.usage_percentage !== undefined && q.usage_percentage !== null
      ? roundPercent(q.usage_percentage)
      : maxFlows > 0
        ? roundPercent(usedFlows / maxFlows)
        : 0
  const usedUsd = formatUsd(q.used_value_usd)
  const maxUsd = formatUsd(q.max_value_usd)
  const usdSuffix = usedUsd && maxUsd ? ` · ${usedUsd} / ${maxUsd}` : ""
  return {
    name,
    used,
    resetsAt: whenISO(q.resets_at),
    span,
    amount: usedFlows,
    limit: maxFlows,
    unit: "flows",
    display: `${compactFlows(usedFlows)} / ${compactFlows(maxFlows)} flows${usdSuffix}`,
  }
}

function formatSubscriptionUsage(detail) {
  const windows = []
  const w5 = windowOf("5 hours", 5 * HOUR, detail?.quota_5_hour)
  const w7 = windowOf("7 days", 7 * DAY, detail?.quota_7_day)
  if (w5) windows.push(w5)
  if (w7) windows.push(w7)

  const until = whenISO(detail?.plan?.expires_at)
  const remResets = detail?.quota_5_hour?.remaining_resets
  const resetsCount = Number.isFinite(Number(remResets)) ? Math.max(0, Math.trunc(Number(remResets))) : null

  const out = {
    plan: planLabel(detail?.plan?.tier, detail?.account_status),
    ...(until && { until }),
    windows,
    ...(resetsCount !== null && {
      resets: {
        count: resetsCount,
        ...(until && { until }),
        byWindow: true,
        fiveHour: resetsCount,
      },
    }),
    signIn: "kept",
  }

  const st = text(detail?.account_status).toLowerCase()
  const baseRate = num(detail?.base_usd_per_flow)
  const effRate = num(detail?.effective_usd_per_flow)
  if (["abusive", "suspended", "banned"].includes(st)) {
    out.error = `ZenMux account status is ${st}.`
  } else if (baseRate > 0 && effRate > baseRate * 1.001 && windows.length) {
    // A rate above the base is more value per flow, not a fault: say so on
    // the card, but leave `error` empty. Magpie skips an account whose usage
    // read carries an error when routing, so a warning here would keep the
    // account invisible to quota-aware routing.
    windows[0].display += ` · value $${effRate}/flow (×${(effRate / baseRate).toFixed(2)} base)`
  }
  return out
}

function formatPaygUsage(balanceData) {
  return {
    plan: "Pay As You Go",
    balance: formatUsd(balanceData?.total_credits ?? 0),
    windows: [],
    signIn: "kept",
  }
}

// ---- Model catalog & protocol routing ---------------------------------------

function normalizeModalities(list, fallback = ["text"]) {
  if (!Array.isArray(list) || !list.length) return fallback
  const out = []
  for (const raw of list) {
    const k = text(raw).toLowerCase()
    const mapped = k === "file" ? "pdf" : k
    if (MODALITIES.includes(mapped) && !out.includes(mapped)) out.push(mapped)
  }
  return out.length ? out : fallback
}

function modalityFlags(list) {
  const norm = normalizeModalities(list)
  return Object.fromEntries(MODALITIES.map((k) => [k, norm.includes(k)]))
}

function protocolOf(slug, suitableApi) {
  const id = text(slug)
  const raw = text(suitableApi)
  const apis = raw
    ? raw
        .split(",")
        .map((s) => s.trim().toLowerCase())
        .filter(Boolean)
    : []

  if (
    apis.length > 0 &&
    !apis.some((a) => ["chat.completions", "responses", "messages", "gemini"].includes(a))
  ) {
    return null
  }
  if (
    id.startsWith("anthropic/") ||
    (apis.includes("messages") && !apis.includes("chat.completions") && !apis.includes("responses"))
  ) {
    return { npm: "@ai-sdk/anthropic", url: ANTHROPIC_BASE }
  }
  if (
    (id.startsWith("openai/") && (apis.includes("responses") || apis.length === 0)) ||
    (apis.includes("responses") && !apis.includes("chat.completions"))
  ) {
    return { npm: "@ai-sdk/openai", url: OPENAI_BASE }
  }
  if (apis.length > 0 && apis.every((a) => a === "gemini")) {
    return { npm: "@ai-sdk/google", url: VERTEX_BASE }
  }
  return { npm: "@ai-sdk/openai-compatible", url: OPENAI_BASE }
}

function configModelOf(m) {
  const input = normalizeModalities(m.input, ["text"])
  const output = normalizeModalities(m.output, ["text"])
  const efforts = Array.isArray(m.efforts) ? m.efforts : []
  return {
    id: m.id,
    name: m.name || m.id,
    provider: { npm: m.npm, api: m.url },
    api: { id: m.id, npm: m.npm, url: m.url },
    limit: { context: m.context || 128_000, output: m.output || 32_000 },
    reasoning: !!m.reasoning,
    tool_call: true,
    attachment: input.some((x) => x !== "text"),
    modalities: { input, output },
    ...(m.cost && { cost: m.cost }),
    ...(efforts.length && {
      variants: Object.fromEntries(efforts.map((e) => [e, { reasoningEffort: e }])),
    }),
    ...(m.free && { free: true }),
  }
}

function seedModels() {
  return Object.fromEntries(SEED_MODELS.map((m) => [m.id, configModelOf(m)]))
}

function servedModelFromAvailable(item, baseModel) {
  const id = text(item?.slug) || text(item?.id)
  if (!id || item?.deleted) return null
  const proto = protocolOf(id, item?.suitable_api)
  if (!proto) return null

  const context = num(item?.context_length) || baseModel?.limit?.context || 128_000
  const output = num(item?.max_completion_tokens) || baseModel?.limit?.output || 32_000
  const reasoning =
    item?.supports_reasoning !== undefined
      ? Number(item.supports_reasoning) > 0 || item.supports_reasoning === true
      : !!baseModel?.capabilities?.reasoning
  const toolcall =
    item?.supports_tool_parameters !== undefined
      ? Number(item.supports_tool_parameters) > 0 || item.supports_tool_parameters === true
      : baseModel?.capabilities?.toolcall ?? true

  const inList = normalizeModalities(item?.input_modalities, ["text"])
  const outList = normalizeModalities(item?.output_modalities, ["text"])

  const discountRaw = text(item?.pricing_discount)
  const discount = discountRaw !== "" && Number.isFinite(Number(discountRaw)) ? Number(discountRaw) : 1
  const factor = discount >= 0 && discount < 1 ? discount : 1

  const rawPrompt = num(item?.pricing_prompt)
  const rawCompletion = num(item?.pricing_completion)
  const rawCacheRead = num(item?.pricing_input_cache_read)
  const rawCacheWrite = num(item?.pricing_input_cache_write)

  const isFree =
    item?.isFree === true ||
    discount === 0 ||
    (item?.pricing_prompt !== undefined && rawPrompt === 0 && rawCompletion === 0)

  const cost = isFree
    ? { input: 0, output: 0, cache: { read: 0, write: 0 } }
    : rawPrompt > 0 || rawCompletion > 0
      ? {
          input: Number((rawPrompt * factor).toFixed(6)),
          output: Number((rawCompletion * factor).toFixed(6)),
          cache: {
            read: Number((rawCacheRead * factor).toFixed(6)),
            write: Number((rawCacheWrite * factor).toFixed(6)),
          },
        }
      : baseModel?.cost ?? { input: 0, output: 0, cache: { read: 0, write: 0 } }

  const existingVariants = baseModel?.variants && Object.keys(baseModel.variants).length ? baseModel.variants : null
  const defaultEfforts = reasoning
    ? id.startsWith("openai/gpt-5") || id.startsWith("openai/gpt-6")
      ? ["low", "medium", "high", "xhigh"]
      : ["low", "medium", "high"]
    : []
  const variants =
    existingVariants ??
    (defaultEfforts.length ? Object.fromEntries(defaultEfforts.map((e) => [e, { reasoningEffort: e }])) : {})

  return {
    ...(baseModel ?? {}),
    id,
    providerID: ID,
    name: text(item?.name) || text(item?.display_name) || baseModel?.name || id,
    api: { id, url: proto.url, npm: proto.npm },
    status: "active",
    headers: baseModel?.headers ?? {},
    options: baseModel?.options ?? {},
    cost,
    limit: { context, output },
    capabilities: {
      temperature: baseModel?.capabilities?.temperature ?? true,
      reasoning,
      attachment: inList.some((x) => x !== "text"),
      toolcall,
      input: modalityFlags(inList),
      output: modalityFlags(outList),
      interleaved: false,
    },
    release_date: text(item?.publish_time) || baseModel?.release_date || "",
    variants,
    ...(isFree ? { free: true } : { free: false }),
    ...(factor > 0 && factor < 1 ? { rate: factor, rateWas: 1 } : {}),
  }
}

function servedModelFromV1(item, baseModel) {
  const id = text(item?.id)
  if (!id) return null
  const outModalities = Array.isArray(item?.output_modalities) ? item.output_modalities : ["text"]
  if (!outModalities.includes("text")) return null
  const proto = protocolOf(id, "")
  if (!proto) return null

  const promptPrice = num(item?.pricings?.prompt?.[0]?.value)
  const completionPrice = num(item?.pricings?.completion?.[0]?.value)
  const cacheReadPrice = num(item?.pricings?.input_cache_read?.[0]?.value)
  const cacheWritePrice =
    num(item?.pricings?.input_cache_write_5_min?.[0]?.value) ||
    num(item?.pricings?.input_cache_write?.[0]?.value)
  const hasPricing = Array.isArray(item?.pricings?.prompt) || Array.isArray(item?.pricings?.completion)
  const isFree = hasPricing && promptPrice === 0 && completionPrice === 0

  return servedModelFromAvailable(
    {
      slug: id,
      name: text(item?.display_name) || id,
      context_length: num(item?.context_length) || baseModel?.limit?.context || 128_000,
      max_completion_tokens: num(item?.max_tokens) || baseModel?.limit?.output || 32_000,
      supports_reasoning: item?.capabilities?.reasoning ? 1 : 0,
      supports_tool_parameters: 1,
      input_modalities: item?.input_modalities ?? ["text"],
      output_modalities: outModalities,
      pricing_prompt: String(promptPrice),
      pricing_completion: String(completionPrice),
      pricing_input_cache_read: String(cacheReadPrice),
      pricing_input_cache_write: String(cacheWritePrice),
      pricing_discount: isFree ? "0" : "1",
      isFree,
      publish_time: text(item?.publish_time),
      suitable_api: "",
    },
    baseModel,
  )
}

function extractPlanModelSet(plansData, tier) {
  const t = text(tier).toLowerCase()
  if (!t || !Array.isArray(plansData)) return null
  const plan = plansData.find((p) => text(p?.planKey).toLowerCase() === t)
  if (!plan) return null
  const set = new Set()
  for (const m of plan.models ?? []) {
    const s = text(m?.model_slug)
    if (s) set.add(s)
  }
  for (const m of plan.timeLimitedModels ?? []) {
    const s = text(m?.model_slug)
    if (s) set.add(s)
  }
  return set.size > 0 ? set : null
}

// ---- Request URL & header normalization -------------------------------------

function rewriteRequestUrl(rawUrl) {
  const u = new URL(String(rawUrl))
  if (u.pathname === "/api/v1/messages" || u.pathname === "/v1/messages") {
    u.pathname = "/api/anthropic/v1/messages"
    return { url: u.toString(), protocol: "anthropic" }
  }
  if (u.pathname.startsWith("/api/anthropic/")) {
    return { url: u.toString(), protocol: "anthropic" }
  }
  const vertexMatch = u.pathname.match(/\/models\/([^/]+)\/([^/:]+):(streamGenerateContent|generateContent)$/)
  if (vertexMatch) {
    const [, vendor, modelName, action] = vertexMatch
    u.pathname = `/api/vertex-ai/v1/publishers/${vendor}/models/${modelName}:${action}`
    return { url: u.toString(), protocol: "vertex" }
  }
  return { url: u.toString(), protocol: "openai" }
}

// ---- Plugin entry -----------------------------------------------------------

export const ZenMuxAuthPlugin = async (input = {}) => {
  const directory = input?.directory || ""
  const subDetailCache = new Map() // mgmtKey -> { at, data }
  let plansCache = { at: 0, data: null }

  async function fetchSubscriptionDetail(mgmtKey, { signal, useCache = false } = {}) {
    if (useCache) {
      const hit = subDetailCache.get(mgmtKey)
      if (hit && Date.now() - hit.at < 30_000) return { ok: true, status: 200, data: hit.data }
    }
    const r = await getJSON(`${MGMT_BASE}/subscription/detail`, { key: mgmtKey, signal })
    if (r.ok && r.body?.data) {
      subDetailCache.set(mgmtKey, { at: Date.now(), data: r.body.data })
      return { ok: true, status: r.status, data: r.body.data }
    }
    return { ok: false, status: r.status, error: said(r.body, `HTTP ${r.status}`) }
  }

  async function fetchPaygBalance(mgmtKey, { signal } = {}) {
    const r = await getJSON(`${MGMT_BASE}/payg/balance`, { key: mgmtKey, signal })
    if (r.ok && r.body?.data) {
      return { ok: true, status: r.status, data: r.body.data }
    }
    return { ok: false, status: r.status, error: said(r.body, `HTTP ${r.status}`) }
  }

  async function fetchPlanModelSet(tier, { signal } = {}) {
    if (!plansCache.data || Date.now() - plansCache.at >= 5 * 60_000) {
      const r = await getJSON(SUBSCRIPTION_PLANS_URL, { signal }).catch(() => null)
      if (r?.ok && Array.isArray(r.body?.data)) {
        plansCache = { at: Date.now(), data: r.body.data }
      }
    }
    return extractPlanModelSet(plansCache.data, tier)
  }

  const managementKeyPrompt = {
    type: "password",
    key: "managementKey",
    message: "ZenMux Management API key (sk-mg-v1-…, for 5h/7d quota & PAYG balance; optional if already saved)",
    placeholder: "sk-mg-v1-… (from zenmux.ai/platform/management)",
    validate: validateManagementKey,
  }

  return {
    config: async (cfg) => {
      cfg.provider ??= {}
      const was = cfg.provider[ID] ?? {}
      cfg.provider[ID] = {
        name: "ZenMux",
        npm: "@ai-sdk/openai-compatible",
        api: OPENAI_BASE,
        searches: true,
        ...was,
        models: { ...seedModels(), ...(was.models ?? {}) },
      }
    },

    auth: {
      provider: ID,
      icon: ICON,
      methods: [
        {
          type: "api",
          label: "ZenMux Subscription API key (sk-ss-v1-…)",
          placeholder: "sk-ss-v1-…",
          prompts: [managementKeyPrompt],
        },
        {
          type: "api",
          label: "ZenMux Pay-As-You-Go API key (sk-ai-v1-…)",
          placeholder: "sk-ai-v1-…",
          prompts: [managementKeyPrompt],
        },
      ],

      loader: async (getAuth) => {
        const auth = await getAuth().catch(() => null)
        const key = keyOf(auth)
        if (!key) return {}
        return {
          apiKey: key,
          async fetch(reqInput, init) {
            const latest = await getAuth().catch(() => auth)
            const activeKey = keyOf(latest) || key
            if (!activeKey) {
              throw Object.assign(new Error("ZenMux: not signed in"), { signIn: "expired" })
            }
            if (isManagementKey(activeKey)) {
              throw new Error(
                "ZenMux: sk-mg-v1-… is a Management API key and cannot call models. Sign in with a Subscription key (sk-ss-v1-…) or Pay-As-You-Go key (sk-ai-v1-…).",
              )
            }

            const rawUrl = typeof reqInput === "string" || reqInput instanceof URL ? String(reqInput) : reqInput.url
            const { url, protocol } = rewriteRequestUrl(rawUrl)
            const headers = new Headers(init?.headers)

            if (protocol === "anthropic") {
              headers.delete("authorization")
              headers.set("x-api-key", activeKey)
              if (!headers.has("anthropic-version")) {
                headers.set("anthropic-version", "2023-06-01")
              }
            } else {
              headers.delete("x-api-key")
              headers.delete("x-goog-api-key")
              headers.set("authorization", `Bearer ${activeKey}`)
            }

            const res = await fetch(url, { ...init, headers })
            if (res.status === 403) {
              const cloned = res.clone()
              const errBody = await readJSON(cloned)
              const errType = text(errBody?.error?.type)
              const rh = new Headers(res.headers)
              rh.set(SIGN_IN_HEADER, errType === "access_denied" ? "expired" : "kept")
              return new Response(res.body, {
                status: res.status,
                statusText: res.statusText,
                headers: rh,
              })
            }
            return res
          },
        }
      },

      usage: async (getAuth) => {
        const auth = await getAuth().catch(() => null)
        const key = keyOf(auth)
        if (!key) return { windows: [], error: "Not signed in", signIn: "kept" }

        const mode = modeOf(auth)
        const mgmtKey = managementKeyOf(auth, directory)
        if (!mgmtKey) {
          return {
            plan: mode === "subscription" ? "Builder Plan" : "Pay As You Go",
            windows: [],
            error:
              "Management API key (sk-mg-v1-…) not set. Sign in again and provide your Management API key to read 5h/7d Flow windows or PAYG balance.",
            signIn: "kept",
          }
        }

        const signal = AbortSignal.timeout(TIMEOUT)
        try {
          if (mode === "subscription") {
            const subRes = await fetchSubscriptionDetail(mgmtKey, { signal })
            if (!subRes.ok) {
              return {
                plan: "Builder Plan",
                windows: [],
                error: `ZenMux subscription detail: ${subRes.error}`,
                signIn: "kept",
              }
            }
            return formatSubscriptionUsage(subRes.data)
          }

          const balRes = await fetchPaygBalance(mgmtKey, { signal })
          if (!balRes.ok) {
            return {
              plan: "Pay As You Go",
              windows: [],
              error: `ZenMux PAYG balance: ${balRes.error}`,
              signIn: "kept",
            }
          }
          const out = formatPaygUsage(balRes.data)
          if (mode === "management") {
            out.error =
              "Signed in with a Management API key (sk-mg-v1-…). Add a Subscription (sk-ss-v1-…) or PAYG (sk-ai-v1-…) key to call models."
          }
          return out
        } catch (e) {
          return {
            plan: mode === "subscription" ? "Builder Plan" : "Pay As You Go",
            windows: [],
            error: `ZenMux usage: ${e?.message ?? e}`,
            signIn: "kept",
          }
        }
      },
    },

    provider: {
      id: ID,
      async models(provider, { auth } = {}) {
        const baseModels = provider?.models ?? {}
        const signal = AbortSignal.timeout(TIMEOUT)

        const [availRes, v1Res] = await Promise.allSettled([
          getJSON(AVAILABLE_MODELS_URL, { signal }),
          getJSON(`${OPENAI_BASE}/models`, { key: keyOf(auth), signal }),
        ])

        const discovered = {}
        if (availRes.status === "fulfilled" && availRes.value.ok && Array.isArray(availRes.value.body?.data)) {
          for (const item of availRes.value.body.data) {
            const m = servedModelFromAvailable(item, baseModels[item?.slug])
            if (m) discovered[m.id] = m
          }
        }
        if (v1Res.status === "fulfilled" && v1Res.value.ok && Array.isArray(v1Res.value.body?.data)) {
          for (const item of v1Res.value.body.data) {
            if (discovered[item?.id]) continue
            const m = servedModelFromV1(item, baseModels[item?.id])
            if (m) discovered[m.id] = m
          }
        }

        if (!Object.keys(discovered).length) {
          const fallback = { ...baseModels }
          fallback[FELL_BACK] = true
          return fallback
        }

        if (auth && modeOf(auth) === "subscription") {
          const mgmtKey = managementKeyOf(auth, directory)
          if (mgmtKey) {
            const subRes = await fetchSubscriptionDetail(mgmtKey, { signal, useCache: true }).catch(() => null)
            const tier = text(subRes?.data?.plan?.tier)
            if (tier && tier !== "free") {
              const allowed = await fetchPlanModelSet(tier, { signal }).catch(() => null)
              if (allowed && allowed.size > 0) {
                const filtered = Object.fromEntries(
                  Object.entries(discovered).filter(([id, m]) => allowed.has(id) || m.free),
                )
                if (Object.keys(filtered).length > 0) return filtered
              }
            }
          }
        }

        return discovered
      },
    },
  }
}

export const _internal = {
  compactFlows,
  configModelOf,
  extractPlanModelSet,
  formatPaygUsage,
  formatSubscriptionUsage,
  formatUsd,
  isManagementKey,
  isPaygKey,
  isSubscriptionKey,
  keyOf,
  managementKeyOf,
  modeOf,
  normalizeModalities,
  planLabel,
  protocolOf,
  rewriteRequestUrl,
  roundPercent,
  seedModels,
  servedModelFromAvailable,
  servedModelFromV1,
  validateManagementKey,
  windowOf,
}
