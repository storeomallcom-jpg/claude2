// ============================================================
// SALESBOT AI — app.js  (The Logic Engine)
// ============================================================
// Requires: config.js to be loaded first
// Requires: @supabase/supabase-js via CDN or npm
// ============================================================

const SalesBotApp = (() => {
  // ── Supabase Client ────────────────────────────────────────
  let _supabase = null;

  function initSupabase() {
    if (_supabase) return _supabase;
    if (typeof supabase === "undefined") {
      console.error("[SalesBot] Supabase SDK not loaded.");
      return null;
    }
    _supabase = supabase.createClient(
      SalesBotConfig.SUPABASE.URL,
      SalesBotConfig.SUPABASE.ANON_KEY
    );
    return _supabase;
  }

  function getSupabase() {
    return _supabase || initSupabase();
  }

  // ── Generate Session ID ───────────────────────────────────
  function generateSessionId() {
    return "sb_" + Date.now().toString(36) + "_" + Math.random().toString(36).slice(2, 9);
  }

  // ── Groq Chat Completion (with key rotation) ──────────────
  async function callGroq(messages, retries = 3) {
    const cfg = SalesBotConfig.GROQ;
    let lastError = null;

    for (let attempt = 0; attempt < retries; attempt++) {
      const apiKey = SalesBotConfig.getNextApiKey();
      const startTime = Date.now();

      try {
        const response = await fetch(cfg.BASE_URL, {
          method : "POST",
          headers: {
            "Content-Type" : "application/json",
            "Authorization": `Bearer ${apiKey}`,
          },
          body: JSON.stringify({
            model      : cfg.MODEL,
            temperature: cfg.TEMPERATURE,
            max_tokens : cfg.MAX_TOKENS,
            messages,
          }),
        });

        if (!response.ok) {
          const err = await response.json().catch(() => ({}));
          // Rate-limit or auth failure → mark key and retry
          if (response.status === 429 || response.status === 401) {
            SalesBotConfig.markKeyFailed(apiKey);
          }
          throw new Error(err.error?.message || `HTTP ${response.status}`);
        }

        const data    = await response.json();
        const content = data.choices?.[0]?.message?.content || "";
        const usage   = data.usage || {};

        // Log success to Supabase (non-blocking)
        _logApiCall({
          apiKeyPreview: apiKey.slice(0, 14),
          model        : cfg.MODEL,
          promptTokens : usage.prompt_tokens,
          completionTokens: usage.completion_tokens,
          totalTokens  : usage.total_tokens,
          latencyMs    : Date.now() - startTime,
          success      : true,
        });

        return { success: true, content, usage };

      } catch (error) {
        lastError = error;
        console.warn(`[SalesBot] Groq attempt ${attempt + 1} failed:`, error.message);
        SalesBotConfig.markKeyFailed(apiKey);

        _logApiCall({
          apiKeyPreview: apiKey.slice(0, 14),
          model        : cfg.MODEL,
          latencyMs    : Date.now() - startTime,
          success      : false,
          errorMessage : error.message,
        });

        // Brief pause before retry
        await new Promise(r => setTimeout(r, 500 * (attempt + 1)));
      }
    }

    return { success: false, content: null, error: lastError?.message || "All retries failed." };
  }

  // ── Non-blocking API Log ───────────────────────────────────
  async function _logApiCall(data) {
    try {
      const db = getSupabase();
      if (!db) return;
      await db.from("api_logs").insert({
        store_id          : data.storeId || null,
        session_id        : data.sessionId || null,
        api_key_preview   : data.apiKeyPreview,
        model             : data.model,
        prompt_tokens     : data.promptTokens,
        completion_tokens : data.completionTokens,
        total_tokens      : data.totalTokens,
        latency_ms        : data.latencyMs,
        success           : data.success,
        error_message     : data.errorMessage || null,
      });
    } catch (e) {
      console.warn("[SalesBot] Log write failed (non-critical):", e.message);
    }
  }

  // ── Parse Lead Capture from AI Response ───────────────────
  function extractLeadData(content) {
    const match = content.match(/\[\[LEAD:(.*?)\]\]/s);
    if (!match) return null;
    try {
      return JSON.parse(match[1]);
    } catch {
      return null;
    }
  }

  function cleanContent(content) {
    return content.replace(/\[\[LEAD:.*?\]\]/s, "").trim();
  }

  // ── Chat Session Manager ───────────────────────────────────
  async function createChatSession(storeId, visitorMeta = {}) {
    const db = getSupabase();
    const sessionId = generateSessionId();
    if (db) {
      await db.from("chat_sessions").insert({
        id              : sessionId,
        store_id        : storeId,
        visitor_language: visitorMeta.language || "en",
        visitor_country : visitorMeta.country  || null,
        is_active       : true,
      });
    }
    return sessionId;
  }

  async function updateChatSession(sessionId, messages) {
    const db = getSupabase();
    if (!db) return;
    await db.from("chat_sessions")
      .update({ messages, last_message_at: new Date().toISOString() })
      .eq("id", sessionId);
  }

  // ── Upsert Lead / Order ────────────────────────────────────
  async function upsertLead(storeId, sessionId, leadData, productId = null) {
    const db = getSupabase();
    if (!db) return null;

    const { data, error } = await db
      .from("leads_orders")
      .upsert({
        store_id      : storeId,
        product_id    : productId,
        session_id    : sessionId,
        customer_name : leadData.name,
        customer_email: leadData.contact?.includes("@") ? leadData.contact : null,
        customer_phone: !leadData.contact?.includes("@") ? leadData.contact : null,
        product_name  : leadData.product,
        product_price : parseFloat(leadData.price) || 0,
        status        : "interested",
        source        : "widget",
      }, { onConflict: "session_id" })
      .select()
      .single();

    if (error) console.error("[SalesBot] Upsert lead error:", error);
    return data;
  }

  async function confirmOrder(leadId, via = "dashboard") {
    const db = getSupabase();
    if (!db) return false;
    const { error } = await db
      .from("leads_orders")
      .update({
        status       : "confirmed",
        confirmed_via: via,
        confirmed_at : new Date().toISOString(),
      })
      .eq("id", leadId);
    return !error;
  }

  // ── Store CRUD ─────────────────────────────────────────────
  async function getStore(storeId) {
    const db = getSupabase();
    const { data } = await db.from("stores").select("*").eq("id", storeId).single();
    return data;
  }

  async function updateStore(storeId, updates) {
    const db = getSupabase();
    const { data, error } = await db
      .from("stores").update(updates).eq("id", storeId).select().single();
    if (error) throw error;
    return data;
  }

  // ── Product CRUD ───────────────────────────────────────────
  async function getProducts(storeId) {
    const db = getSupabase();
    const { data } = await db
      .from("products")
      .select("*")
      .eq("store_id", storeId)
      .eq("is_active", true)
      .order("name");
    return data || [];
  }

  async function upsertProduct(product) {
    const db = getSupabase();
    const { data, error } = await db
      .from("products").upsert(product).select().single();
    if (error) throw error;
    return data;
  }

  async function deleteProduct(productId) {
    const db = getSupabase();
    await db.from("products").update({ is_active: false }).eq("id", productId);
  }

  // ── Analytics ─────────────────────────────────────────────
  async function getStoreAnalytics(storeId) {
    const db = getSupabase();
    const { data } = await db
      .from("store_analytics")
      .select("*")
      .eq("store_id", storeId)
      .single();
    return data || {};
  }

  async function getLeads(storeId, limit = 50, offset = 0) {
    const db = getSupabase();
    const { data, count } = await db
      .from("leads_orders")
      .select("*", { count: "exact" })
      .eq("store_id", storeId)
      .order("created_at", { ascending: false })
      .range(offset, offset + limit - 1);
    return { leads: data || [], total: count || 0 };
  }

  async function getRevenueTimeSeries(storeId, days = 7) {
    const db = getSupabase();
    const since = new Date(Date.now() - days * 86400000).toISOString();
    const { data } = await db
      .from("leads_orders")
      .select("created_at, total_amount, status")
      .eq("store_id", storeId)
      .eq("status", "confirmed")
      .gte("created_at", since)
      .order("created_at");

    // Group by day
    const grouped = {};
    for (let i = 0; i < days; i++) {
      const d = new Date(Date.now() - (days - 1 - i) * 86400000);
      grouped[d.toLocaleDateString("en-CA")] = 0; // YYYY-MM-DD
    }
    (data || []).forEach(row => {
      const day = new Date(row.created_at).toLocaleDateString("en-CA");
      if (day in grouped) grouped[day] += parseFloat(row.total_amount || 0);
    });
    return Object.entries(grouped).map(([date, revenue]) => ({ date, revenue }));
  }

  // ── Admin Queries ──────────────────────────────────────────
  async function getPlatformOverview() {
    const db = getSupabase();
    const { data } = await db.from("admin_platform_overview").select("*").single();
    return data || {};
  }

  async function getAllStores(limit = 100) {
    const db = getSupabase();
    const { data } = await db
      .from("store_analytics")
      .select("*")
      .order("total_revenue", { ascending: false })
      .limit(limit);
    return data || [];
  }

  // ── Chat Completion (Full Pipeline) ───────────────────────
  async function chat({ storeId, sessionId, userMessage, conversationHistory, storeConfig, products }) {
    const systemPrompt = SalesBotConfig.buildSystemPrompt(storeConfig, products);
    const messages = [
      { role: "system", content: systemPrompt },
      ...conversationHistory.slice(-12),
      { role: "user",   content: userMessage },
    ];

    const result = await callGroq(messages);
    if (!result.success) {
      return {
        success: false,
        content: "I'm having a brief technical moment. Please try again in a second!",
        leadData: null,
      };
    }

    const leadData = extractLeadData(result.content);
    const cleanedContent = cleanContent(result.content);

    // Auto-save lead if captured
    if (leadData && storeId && sessionId) {
      await upsertLead(storeId, sessionId, leadData);
    }

    return { success: true, content: cleanedContent, leadData, usage: result.usage };
  }

  // ── Merchant AI Assistant ──────────────────────────────────
  async function merchantChat({ storeId, userMessage, conversationHistory }) {
    const db = getSupabase();
    const [store, analytics] = await Promise.all([
      getStore(storeId),
      getStoreAnalytics(storeId),
    ]);

    if (!store) return { success: false, content: "Store not found." };

    const systemPrompt = SalesBotConfig.buildMerchantPrompt(store, analytics);
    const messages = [
      { role: "system", content: systemPrompt },
      ...conversationHistory.slice(-8),
      { role: "user",   content: userMessage },
    ];

    const result = await callGroq(messages);
    return {
      success: result.success,
      content: result.content || "I couldn't process that. Please try again.",
    };
  }

  // ── WhatsApp Link Builder ──────────────────────────────────
  function buildWhatsAppLink(phone, customerName, productName, price, currency) {
    const sym = SalesBotConfig.PLATFORM.CURRENCY_SYMBOLS[currency] || currency;
    const msg = encodeURIComponent(
      `Hi! I'd like to confirm the order for ${customerName}:\n` +
      `📦 Product: ${productName}\n` +
      `💰 Price: ${sym}${price}\n` +
      `Please confirm this order. Thank you!`
    );
    const clean = phone.replace(/\D/g, "");
    return `https://wa.me/${clean}?text=${msg}`;
  }

  return {
    initSupabase,
    generateSessionId,
    createChatSession,
    updateChatSession,
    chat,
    merchantChat,
    upsertLead,
    confirmOrder,
    getStore,
    updateStore,
    getProducts,
    upsertProduct,
    deleteProduct,
    getStoreAnalytics,
    getLeads,
    getRevenueTimeSeries,
    getPlatformOverview,
    getAllStores,
    buildWhatsAppLink,
  };
})();
