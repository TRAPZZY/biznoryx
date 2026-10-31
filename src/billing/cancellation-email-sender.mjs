import { createHash } from "node:crypto";
import { EmailDeliveryError, ResendEmailSender } from "../email/resend-email-sender.mjs";

export class CancellationEmailSender extends ResendEmailSender {
  async sendCancellationConfirmation({ to, subscription }) {
    if (!this.apiKey || !this.from || typeof this.fetchImpl !== "function") {
      throw new EmailDeliveryError("Cancellation email is not configured.");
    }
    if (subscription.status !== "non_renewing") {
      throw new EmailDeliveryError("Cancellation has not been confirmed.");
    }
    const end = new Date(subscription.currentPeriodEnd ?? "");
    const access = Number.isFinite(end.getTime())
      ? `Your paid access remains available until ${end.toISOString().replace("T", " ").replace(".000Z", " UTC")}.`
      : "Your existing paid-through access has not been extended or shortened. Check Billing for your access end date.";
    const text = [
      "Your BIZNORYX subscription has been canceled.",
      "Automatic renewal is off. This subscription will not renew automatically.",
      access,
      "Canceling renewal does not delete your account or business records, and does not issue a refund.",
      "You can review your subscription in Billing: https://biznoryx.com/#/billing",
      "BIZNORYX Team",
    ].join("\n\n");
    const key = createHash("sha256").update(JSON.stringify([
      subscription.id, subscription.cancellationRequestedAt ?? subscription.updatedAt ?? subscription.activeAt, to,
    ])).digest("hex");
    let response;
    try {
      response = await this.fetchImpl("https://api.resend.com/emails", {
        method: "POST", signal: AbortSignal.timeout(15_000),
        headers: { Authorization: `Bearer ${this.apiKey}`, "Content-Type": "application/json",
          "Idempotency-Key": `billing-cancellation/${key}` },
        body: JSON.stringify({ from: this.from, to: [to], subject: "Your BIZNORYX subscription has been canceled",
          text, html: `<div style="font-family:Arial,sans-serif;max-width:560px;margin:auto;padding:24px;color:#142018"><h1 style="font-size:24px">Subscription canceled</h1>${text.split("\n\n").map(paragraph => `<p style="line-height:1.6">${paragraph}</p>`).join("")}</div>` }),
      });
    } catch {
      throw new EmailDeliveryError("Cancellation confirmation could not be sent.");
    }
    let payload;
    try { payload = await response.json(); } catch { payload = null; }
    if (!response.ok || !payload?.id) throw new EmailDeliveryError("Cancellation confirmation could not be sent.", response.status);
    return { provider: "resend", messageId: payload.id };
  }
}
