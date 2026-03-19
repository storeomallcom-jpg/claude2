// ============================================================
// SALESBOT AI — config.js  (The Brain)
// ============================================================

const SalesBotConfig = (() => {

  // ── Groq API Key Pool ──────────────────────────────────────
  const GROQ_API_KEYS = [
    "gsk_YOUR_KEY_1_HERE",
    "gsk_YOUR_KEY_2_HERE",
    "gsk_YOUR_KEY_3_HERE",
  ];

  let _keyIndex = 0;
  const _keyCooldowns = {};
  const COOLDOWN_MS = 60_000;

  function getNextApiKey() {
    const now = Date.now();
    for (let i = 0; i < GROQ_API_KEYS.length; i++) {
      const idx = (_keyIndex + i) % GROQ_API_KEYS.length;
      const key  = GROQ_API_KEYS[idx];
      if (now >= (_keyCooldowns[key] || 0)) {
        _keyIndex = (idx + 1) % GROQ_API_KEYS.length;
        return key;
      }
    }
    console.warn("[SalesBot] All API keys in cooldown – returning least-stale key.");
    return GROQ_API_KEYS[_keyIndex % GROQ_API_KEYS.length];
  }

  function markKeyFailed(key) {
    _keyCooldowns[key] = Date.now() + COOLDOWN_MS;
    console.warn(`[SalesBot] Key failed: ${key.slice(0,14)}… – retry in ${COOLDOWN_MS/1000}s`);
  }

  function getKeyStatus() {
    const now = Date.now();
    return GROQ_API_KEYS.map((key, i) => ({
      index: i,
      preview: key.slice(0, 14) + "…",
      healthy: now >= (_keyCooldowns[key] || 0),
      cooldownRemaining: Math.max(0, Math.ceil(((_keyCooldowns[key]||0) - now) / 1000)),
    }));
  }

  // ── Groq Settings ──────────────────────────────────────────
  const GROQ = {
    BASE_URL   : "https://api.groq.com/openai/v1/chat/completions",
    MODEL      : "llama3-70b-8192",
    TEMPERATURE: 0.7,
    MAX_TOKENS : 1024,
  };

  // ── Supabase ───────────────────────────────────────────────
  const SUPABASE = {
    URL             : "https://YOUR_PROJECT_ID.supabase.co",
    ANON_KEY        : "YOUR_SUPABASE_ANON_KEY",
    SERVICE_ROLE_KEY: "YOUR_SUPABASE_SERVICE_ROLE_KEY",
  };

  // ── Platform Meta ──────────────────────────────────────────
  const PLATFORM = {
    NAME       : "SalesBot AI",
    VERSION    : "2.0.0",
    SUPPORT_EMAIL: "support@salesbot.ai",
    DEFAULT_CURRENCY: "USD",
    SUPPORTED_CURRENCIES: [
      "USD","EUR","GBP","SAR","AED","MAD","EGP",
      "NGN","KES","ZAR","INR","BRL","CAD","AUD","JPY",
    ],
    SUPPORTED_LOCALES: ["en","ar","fr","es","pt","hi","sw"],
    CURRENCY_SYMBOLS: {
      USD:"$", EUR:"€", GBP:"£", SAR:"﷼", AED:"د.إ",
      MAD:"د.م.", EGP:"ج.م", NGN:"₦", KES:"KSh",
      ZAR:"R", INR:"₹", BRL:"R$", CAD:"CA$", AUD:"A$", JPY:"¥",
    },
  };

  // ── AI Personalities ───────────────────────────────────────
  const AI_PERSONALITIES = {
    professional: {
      label: "Professional",
      icon : "briefcase",
      description: "Formal, precise, trust-building tone.",
      systemSuffix: "Maintain a formal and precise tone. Build trust through expertise and data. Be concise.",
    },
    friendly: {
      label: "Friendly",
      icon : "smile",
      description: "Warm, conversational, approachable.",
      systemSuffix: "Be warm and enthusiastic. Use light humour. Make the customer feel like they're chatting with a knowledgeable friend.",
    },
    aggressive: {
      label: "Aggressive Seller",
      icon : "zap",
      description: "Urgency-driven, persuasive, closer mentality.",
      systemSuffix: "Use proven sales techniques. Create urgency with scarcity and time-limited framing. Firmly handle every objection and always drive toward closing.",
    },
  };

  const DEFAULT_STORE = {
    name          : "My Store",
    industry      : "General",
    currency      : "USD",
    language      : "en",
    personality   : "professional",
    delivery_time : "3–5 business days",
    return_policy : "30-day returns on all items",
    discount_codes: [],
    whatsapp_number: "",
    custom_rules  : "",
  };

  // ── System Prompt Builder ──────────────────────────────────
  function buildSystemPrompt(store, products = []) {
    const p = AI_PERSONALITIES[store.personality] || AI_PERSONALITIES.professional;
    const sym = PLATFORM.CURRENCY_SYMBOLS[store.currency] || store.currency;
    const productList = products.length
      ? products.map(p =>
          `• ${p.name}: ${sym}${p.price} | Stock: ${p.stock} | ${p.description}`
        ).join("\n")
      : "No products yet — inform the customer that the catalogue is coming soon.";

    return `You are an elite AI Sales Agent for "${store.name}" — a ${store.industry} store.

MISSION: Convert every visitor into a paying customer. Capture Name + Email/Phone through natural conversation.

STORE RULES
───────────
Delivery   : ${store.delivery_time}
Returns    : ${store.return_policy}
Discounts  : ${store.discount_codes.length ? store.discount_codes.join(", ") : "None active"}
${store.custom_rules ? `Custom     : ${store.custom_rules}` : ""}

PRODUCT CATALOGUE
─────────────────
${productList}

SALES PROCESS (follow in order)
────────────────────────────────
1. Greet warmly – identify the customer's need.
2. Recommend the best-fit product with genuine enthusiasm.
3. Address objections: price, quality, delivery, trust.
4. When interest is shown → naturally ask: name, then email or WhatsApp number.
5. Confirm order details, thank them, and mention what happens next.

LANGUAGE: Mirror the customer's language automatically.
CURRENCY: Always quote prices in ${store.currency} (${sym}).

LEAD CAPTURE (internal – never show raw JSON to customer)
When you have captured name + contact, append EXACTLY this at the end of your message:
[[LEAD:{"name":"...","contact":"...","product":"...","price":0}]]

PERSONALITY DIRECTIVE
${p.systemSuffix}`;
  }

  // ── Merchant Assistant Prompt ──────────────────────────────
  function buildMerchantPrompt(store, analytics = {}) {
    const sym = PLATFORM.CURRENCY_SYMBOLS[store.currency] || store.currency;
    return `You are a world-class e-commerce growth consultant for "${store.name}".

LIVE ANALYTICS SNAPSHOT
Revenue (AI-generated) : ${sym}${analytics.revenue || 0}
Active Chats Today     : ${analytics.activeChats || 0}
Conversion Rate        : ${analytics.conversionRate || 0}%
Total Orders           : ${analytics.totalOrders || 0}
Top Product            : ${analytics.topProduct || "N/A"}
Avg Order Value        : ${sym}${analytics.avgOrderValue || 0}

Provide strategic, data-driven advice. Be specific to their numbers. Keep responses to 3–5 sentences unless a deep analysis is requested. Always end with ONE bold action the merchant should take TODAY.`;
  }

  return {
    getNextApiKey,
    markKeyFailed,
    getKeyStatus,
    GROQ,
    SUPABASE,
    PLATFORM,
    AI_PERSONALITIES,
    DEFAULT_STORE,
    buildSystemPrompt,
    buildMerchantPrompt,
  };
})();

if (typeof module !== "undefined" && module.exports) {
  module.exports = SalesBotConfig;
}
