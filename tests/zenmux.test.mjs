import assert from "node:assert/strict"
import test from "node:test"
import { ZenMuxAuthPlugin, _internal as I } from "../index.mjs"

test("key classification and subscription/payg usage mapping", () => {
  assert.equal(I.modeOf({ key: "sk-ss-v1-abc" }), "subscription")
  assert.equal(I.modeOf({ key: "sk-ai-v1-def" }), "payg")
  assert.equal(I.validateManagementKey(""), undefined)
  assert.equal(I.validateManagementKey("sk-mg-v1-123"), undefined)
  assert.match(I.validateManagementKey("sk-ss-v1-123"), /sk-mg-v1-/)

  const subUsage = I.formatSubscriptionUsage({
    plan: { tier: "starter", expires_at: "2026-10-27T10:01:45.000Z" },
    account_status: "healthy",
    base_usd_per_flow: 0.03283,
    effective_usd_per_flow: 0.03283,
    quota_5_hour: {
      usage_percentage: 0.0715,
      resets_at: "2026-10-17T14:40:12.000Z",
      remaining_resets: 4,
      used_flows: 3.58,
      max_flows: 50,
      used_value_usd: 0.12,
      max_value_usd: 1.64,
    },
    quota_7_day: {
      usage_percentage: 0.0463,
      resets_at: "2026-10-21T06:39:01.000Z",
      used_flows: 9.86,
      max_flows: 213,
      used_value_usd: 0.32,
      max_value_usd: 6.99,
    },
  })

  assert.deepEqual(subUsage, {
    plan: "Builder Starter",
    until: "2026-10-27T10:01:45.000Z",
    windows: [
      {
        name: "5 hours",
        used: 7.15,
        resetsAt: "2026-10-17T14:40:12.000Z",
        span: 18000,
        amount: 3.58,
        limit: 50,
        unit: "flows",
        display: "3.58 / 50 flows · $0.12 / $1.64",
      },
      {
        name: "7 days",
        used: 4.63,
        resetsAt: "2026-10-21T06:39:01.000Z",
        span: 604800,
        amount: 9.86,
        limit: 213,
        unit: "flows",
        display: "9.86 / 213 flows · $0.32 / $6.99",
      },
    ],
    resets: {
      count: 4,
      until: "2026-10-27T10:01:45.000Z",
      byWindow: true,
      fiveHour: 4,
    },
    signIn: "kept",
  })

  assert.deepEqual(I.formatPaygUsage({ total_credits: 1.772128 }), {
    plan: "Pay As You Go",
    balance: "$1.77",
    windows: [],
    signIn: "kept",
  })
})

test("a higher effective flow rate is a value note, not an error", () => {
  const u = I.formatSubscriptionUsage({
    plan: { tier: "pro", expires_at: "2026-11-06T05:35:47.000Z" },
    account_status: "healthy",
    base_usd_per_flow: 0.03283,
    effective_usd_per_flow: 0.0516,
    quota_5_hour: {
      usage_percentage: 0.13,
      resets_at: "2026-10-22T04:58:22.000Z",
      remaining_resets: 4,
      used_flows: 6.5,
      max_flows: 50,
      used_value_usd: 0.34,
      max_value_usd: 2.58,
    },
    quota_7_day: {
      usage_percentage: 0.07,
      resets_at: "2026-10-27T14:57:41.000Z",
      used_flows: 27,
      max_flows: 386,
      used_value_usd: 1.39,
      max_value_usd: 19.92,
    },
  })

  assert.equal(u.error, undefined)
  assert.match(u.windows[0].display, /value \$0\.0516\/flow \(×1\.57 base\)/)
})

test("an image-only model is served so magpie can draw with it", () => {
  const flare = I.servedModelFromV1({
    id: "openai/gpt-image-2.5-flare",
    display_name: "OpenAI: GPT-Image-2.5-Flare",
    input_modalities: ["text", "image"],
    output_modalities: ["image"],
    context_length: 10000,
    capabilities: { reasoning: false },
    pricings: { prompt: [{ value: 5, unit: "perMTokens", currency: "USD" }] },
  })
  assert.ok(flare)
  assert.equal(flare.id, "openai/gpt-image-2.5-flare")
  assert.equal(flare.capabilities.output.image, true)
  assert.equal(flare.capabilities.output.text, false)
  assert.equal(flare.api.url, "https://zenmux.ai/api/v1")

  const chat = I.servedModelFromV1({
    id: "openai/gpt-6",
    output_modalities: ["text"],
    input_modalities: ["text"],
  })
  assert.ok(chat)

  const speech = I.servedModelFromV1({
    id: "qwen/qwen-audio-3.0-tts-plus",
    output_modalities: ["speech"],
    input_modalities: ["text"],
  })
  assert.equal(speech, null)
})

test("protocol routing and 403 access_denied vs safety_check_failed", async () => {
  assert.deepEqual(I.protocolOf("anthropic/claude-sonnet-4.5", "chat.completions,messages,responses"), {
    npm: "@ai-sdk/anthropic",
    url: "https://zenmux.ai/api/anthropic/v1",
  })
  assert.deepEqual(I.protocolOf("openai/gpt-5.4", "responses,messages,chat.completions"), {
    npm: "@ai-sdk/openai",
    url: "https://zenmux.ai/api/v1",
  })

  const realFetch = globalThis.fetch
  try {
    let type = "access_denied"
    globalThis.fetch = async (url, init) =>
      new Response(JSON.stringify({ error: { code: "403", type, message: "denied" } }), {
        status: 403,
        headers: {
          "content-type": "application/json",
          "x-seen-url": String(url),
          "x-seen-key": init.headers.get("x-api-key") || "",
        },
      })

    const hooks = await ZenMuxAuthPlugin({})
    const loaded = await hooks.auth.loader(async () => ({ type: "api", key: "sk-ss-v1-test" }))

    const r1 = await loaded.fetch("https://zenmux.ai/api/v1/messages", { method: "POST", body: "{}" })
    assert.equal(r1.headers.get("x-seen-url"), "https://zenmux.ai/api/anthropic/v1/messages")
    assert.equal(r1.headers.get("x-seen-key"), "sk-ss-v1-test")
    assert.equal(r1.headers.get("x-magpie-sign-in"), "expired")

    type = "safety_check_failed"
    const r2 = await loaded.fetch("https://zenmux.ai/api/anthropic/v1/messages", { method: "POST", body: "{}" })
    assert.equal(r2.headers.get("x-magpie-sign-in"), "kept")
  } finally {
    globalThis.fetch = realFetch
  }
})
