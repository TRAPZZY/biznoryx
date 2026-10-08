import { EmailDeliveryError, ResendEmailSender } from "../email/resend-email-sender.mjs";

export class TrialReminderEmailSender extends ResendEmailSender {
  async sendTrialReminder({ to, trialId, endsAt, monthlyAmountMinor, currency, billingUrl }) {
    if (!this.apiKey || !this.from || typeof this.fetchImpl !== "function") {
      throw new EmailDeliveryError("Trial reminder email is not configured.");
    }
    const response = await this.fetchImpl("https://api.resend.com/emails", {
      method: "POST", signal: AbortSignal.timeout(15_000),
      headers: { Authorization: `Bearer ${this.apiKey}`, "Content-Type": "application/json",
        "Idempotency-Key": `trial-reminder/${trialId}` },
      body: JSON.stringify({ from: this.from, to: [to], subject: "Your BIZNORYX trial is ending",
        text: `Your seven-day BIZNORYX trial ends at ${endsAt}. Your first monthly charge is ${monthlyAmountMinor / 100} ${currency}. Manage or cancel billing before then at ${billingUrl}.`,
      }),
    });
    let payload;
    try { payload = await response.json(); } catch { payload = null; }
    if (!response.ok || !payload?.id) throw new EmailDeliveryError("Trial reminder email could not be delivered.", response.status);
    return { provider: "resend", messageId: payload.id };
  }
}
