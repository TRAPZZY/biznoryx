import { AuthError } from "../auth/core.mjs";

// Only fixed official Paystack paths are accepted, never caller-supplied URLs.
export class TrialPaystackProvider {
  constructor({ env = process.env, fetchImpl = fetch } = {}) {
    this.env = env;
    this.fetchImpl = fetchImpl;
  }

  async request(path, body, { dataRequired = true } = {}) {
    let response;
    let payload;
    try {
      response = await this.fetchImpl(`https://api.paystack.co${path}`, {
        method: body === undefined ? "GET" : "POST",
        headers: {
          Authorization: `Bearer ${this.env.PAYSTACK_SECRET_KEY}`,
          "Content-Type": "application/json",
          Accept: "application/json",
        },
        ...(body === undefined ? {} : { body: JSON.stringify(body) }),
        signal: AbortSignal.timeout(15_000),
      });
      payload = await response.json();
    } catch {
      throw new AuthError("Paystack operation requires reconciliation. Please retry.", "BILLING_PROVIDER_FAILED");
    }
    if (!response.ok || payload?.status !== true || (dataRequired && payload.data == null)) {
      throw new AuthError("Paystack operation could not be confirmed. Please retry.", "BILLING_PROVIDER_FAILED");
    }
    return payload.data ?? {};
  }

  initialize(body) { return this.request("/transaction/initialize", body); }
  verify(reference) { return this.request(`/transaction/verify/${encodeURIComponent(reference)}`); }
  plan(code) { return this.request(`/plan/${encodeURIComponent(code)}`); }
  createSubscription(body) { return this.request("/subscription", body); }
  subscription(code) { return this.request(`/subscription/${encodeURIComponent(code)}`); }
  disable(code, token) { return this.request("/subscription/disable", { code, token }, { dataRequired: false }); }
  createRefund(body) { return this.request("/refund", body); }
  refund(id) { return this.request(`/refund/${encodeURIComponent(id)}`); }
  updateLink(code) { return this.request(`/subscription/${encodeURIComponent(code)}/manage/link`); }

  async listSubscriptions(customerId) {
    return this.list(`/subscription?customer=${encodeURIComponent(customerId)}`);
  }
  async listRefunds(transactionId) {
    return this.list(`/refund?transaction=${encodeURIComponent(transactionId)}`);
  }
  async list(path) {
    const result = [];
    for (let page = 1; page <= 20; page += 1) {
      const rows = await this.request(`${path}&perPage=100&page=${page}`);
      if (!Array.isArray(rows)) throw new AuthError("Invalid provider list.", "BILLING_PROVIDER_FAILED");
      result.push(...rows);
      if (rows.length < 100) return result;
    }
    throw new AuthError("Provider reconciliation needs manual review.", "BILLING_RECONCILIATION_REQUIRED");
  }
}
