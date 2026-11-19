/**
 * In-process mock of the HubSpot and GoHighLevel endpoints this project uses, exposed as a `fetch` function.
 * Same URLs, payloads and status codes as the real APIs, plus fault injection for 429/5xx/validation errors.
 */
type Json = Record<string, any>;

export interface MockCrmState {
  contacts: Map<string, Json>;
  deals: Map<string, Json>;
  notes: Json[];
  requests: { method: string; path: string }[];
  faults: { status429?: number; status500?: number; rejectEmailContaining?: string };
}

export function createMockCrm() {
  const state: MockCrmState = { contacts: new Map(), deals: new Map(), notes: [], requests: [], faults: {} };
  let seq = 100;
  const id = (p: string) => `${p}${++seq}`;
  const json = (body: unknown, status = 200, headers: Record<string, string> = {}) =>
    new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json", ...headers } });
  const findContact = (email?: string | null, phone?: string | null) =>
    [...state.contacts.values()].find((c) => (email && c.email === email) || (phone && c.phone === phone));

  const fetchFn = (async (input: string | URL | Request, init?: RequestInit) => {
    const url = new URL(typeof input === "string" ? input : input instanceof URL ? input.href : input.url);
    const method = (init?.method ?? "GET").toUpperCase();
    const path = url.pathname;
    state.requests.push({ method, path });
    const body: Json = init?.body ? JSON.parse(String(init.body)) : {};
    const auth = new Headers(init?.headers).get("authorization") ?? "";
    if (!auth.startsWith("Bearer ")) return json({ status: "error", message: "Authentication credentials not found" }, 401);
    if (state.faults.status429 && state.faults.status429 > 0) {
      state.faults.status429--;
      return json({ status: "error", category: "RATE_LIMITS", message: "You have reached your secondly limit." }, 429, { "Retry-After": "1" });
    }
    if (state.faults.status500 && state.faults.status500 > 0) {
      state.faults.status500--;
      return json({ status: "error", message: "internal error" }, 502);
    }
    const reject = state.faults.rejectEmailContaining;
    const badEmail = (e?: string) => reject && e?.includes(reject);

    // ---------------------------------------------------------------- HubSpot
    if (url.hostname === "api.hubapi.com") {
      if (method === "POST" && path === "/crm/v3/objects/contacts/batch/upsert") {
        const inp = body.inputs[0];
        if (badEmail(inp.id)) return json({ status: "error", category: "VALIDATION_ERROR", message: `Property values were not valid: INVALID_EMAIL ${inp.id}` }, 400);
        const existing = findContact(inp.id, null);
        const c = existing ?? { id: id("hs_c_"), createdAt: new Date().toISOString() };
        Object.assign(c, { email: inp.id, ...Object.fromEntries(Object.entries(inp.properties).filter(([, v]) => v !== null && v !== undefined)) });
        state.contacts.set(c.id, c);
        return json({ status: "COMPLETE", results: [{ id: c.id, properties: c, new: !existing }] });
      }
      if (method === "POST" && path === "/crm/v3/objects/contacts/search") {
        const phone = body.filterGroups[0].filters[0].value;
        const c = findContact(null, phone);
        return json({ total: c ? 1 : 0, results: c ? [{ id: c.id, properties: c }] : [] });
      }
      if (method === "POST" && path === "/crm/v3/objects/contacts") {
        const c = { id: id("hs_c_"), ...body.properties };
        state.contacts.set(c.id, c);
        return json({ id: c.id, properties: c }, 201);
      }
      let m = path.match(/^\/crm\/v3\/objects\/contacts\/(\w+)$/);
      if (method === "PATCH" && m) {
        const c = state.contacts.get(m[1]);
        if (!c) return json({ status: "error", message: "resource not found" }, 404);
        Object.assign(c, Object.fromEntries(Object.entries(body.properties).filter(([, v]) => v !== null && v !== undefined)));
        return json({ id: c.id, properties: c });
      }
      if (method === "POST" && path === "/crm/v3/objects/deals") {
        const d = { id: id("hs_d_"), ...body.properties, contactId: body.associations?.[0]?.to?.id, history: [body.properties.dealstage] };
        state.deals.set(d.id, d);
        return json({ id: d.id, properties: d }, 201);
      }
      m = path.match(/^\/crm\/v3\/objects\/deals\/(\w+)$/);
      if (method === "PATCH" && m) {
        const d = state.deals.get(m[1]);
        if (!d) return json({ status: "error", message: "resource not found" }, 404);
        if (body.properties.dealstage !== d.dealstage) d.history.push(body.properties.dealstage);
        Object.assign(d, body.properties);
        return json({ id: d.id, properties: d });
      }
      if (method === "POST" && path === "/crm/v3/objects/notes") {
        state.notes.push({ contactId: body.associations[0].to.id, body: body.properties.hs_note_body });
        return json({ id: id("hs_n_") }, 201);
      }
    }

    // ---------------------------------------------------------------- GoHighLevel (LeadConnector v2)
    if (url.hostname === "services.leadconnectorhq.com") {
      if (new Headers(init?.headers).get("version") !== "2021-07-28") return json({ message: "Version header missing" }, 400);
      if (method === "POST" && path === "/contacts/upsert") {
        if (!body.locationId) return json({ message: "locationId is required" }, 422);
        if (badEmail(body.email)) return json({ message: "email must be an email" }, 422);
        const existing = findContact(body.email, body.phone);
        const c = existing ?? { id: id("ghl_c_"), tags: [] as string[] };
        const tags = [...new Set([...(c.tags ?? []), ...(body.tags ?? [])])];
        Object.assign(c, Object.fromEntries(Object.entries(body).filter(([, v]) => v !== undefined)), { tags });
        state.contacts.set(c.id, c);
        return json({ new: !existing, contact: c });
      }
      if (method === "POST" && path === "/opportunities/") {
        const d = { id: id("ghl_o_"), ...body, history: [body.pipelineStageId] };
        state.deals.set(d.id, d);
        return json({ opportunity: d }, 201);
      }
      let m = path.match(/^\/opportunities\/(\w+)$/);
      if (method === "PUT" && m) {
        const d = state.deals.get(m[1]);
        if (!d) return json({ message: "Opportunity not found" }, 404);
        if (body.pipelineStageId !== d.pipelineStageId) d.history.push(body.pipelineStageId);
        Object.assign(d, body);
        return json({ opportunity: d });
      }
      m = path.match(/^\/contacts\/(\w+)\/notes$/);
      if (method === "POST" && m) {
        state.notes.push({ contactId: m[1], body: body.body });
        return json({ note: { id: id("ghl_n_"), body: body.body } }, 201);
      }
    }
    return json({ message: `mock: no route for ${method} ${url.hostname}${path}` }, 404);
  }) as typeof fetch;

  return { fetch: fetchFn, state };
}
