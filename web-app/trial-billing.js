const escape = (value) => String(value ?? "").replace(/[&<>"']/g, (char) => ({
  "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;",
})[char]);
const icon = (name) => `<i data-lucide="${name}" aria-hidden="true"></i>`;
const dateLabel = (value) => value ? new Date(value).toLocaleString(undefined, {
  year: "numeric", month: "short", day: "numeric", hour: "numeric", minute: "2-digit",
}) : "After card verification";

export function mountTrialBilling({ container, api, subscription, onChanged }) {
  if (!container || subscription?.status === "active") return;
  const host = document.createElement("section");
  host.className = "trial-billing";
  host.setAttribute("aria-label", "Seven-day trial");
  host.innerHTML = '<p role="status">Checking trial availability...</p>';
  container.prepend(host);
  const current = () => host.isConnected;
  const icons = () => window.lucide?.createIcons({ root: host });
  const paidCheckout = container.querySelector("#open-billing-checkout");
  let trial;

  function render() {
    const started = Boolean(trial.startedAt);
    const expires = new Date(trial.endsAt || trial.trialEndsAt).getTime();
    const access = started && Number.isFinite(expires) && expires > Date.now() && !["past_due", "active"].includes(trial.status);
    const canceled = Boolean(trial.canceledAt || trial.cancellationRequestedAt);
    const remaining = Math.max(0, Math.min(7, Math.ceil((expires - Date.now()) / 86_400_000)));
    if (paidCheckout) paidCheckout.hidden = !trial.convertedAt && !canceled && (access || trial.providerProvisioned || (trial.recoveryRequired && trial.canCancel));
    const amount = new Intl.NumberFormat(undefined, { style: "currency", currency: trial.currency || subscription?.currency || "NGN" }).format(Number(trial.verificationAmountMinor || 0) / 100);
    const price = subscription?.priceLabel || "the displayed monthly subscription price";
    if (started) {
      host.innerHTML = `<h3>${access ? canceled ? "Trial cancellation confirmed" : `${remaining} ${remaining === 1 ? "day" : "days"} left in your trial` : "Your trial has ended"}</h3>
        ${access ? `<progress class="trial-progress" value="${remaining}" max="7" aria-label="Trial days remaining"></progress>` : ""}
        <dl class="trial-dates"><div><dt>Access until</dt><dd>${escape(dateLabel(trial.endsAt || trial.trialEndsAt))}</dd></div>
        <div><dt>${canceled ? "Automatic billing" : "First subscription payment"}</dt><dd>${canceled ? "Canceled" : escape(dateLabel(trial.firstBillingDate || trial.endsAt))}</dd></div></dl>
        <p>${canceled ? "Your trial access continues until its end date. The scheduled subscription payment has been canceled." : access ? `Your subscription will renew at ${escape(price)} after the trial. Cancel before the first payment to stop automatic billing.` : trial.paymentUpdateAvailable ? "Your subscription payment needs attention. Update your card through Paystack. Your business records are retained." : "Your business records are retained. Cancel scheduled trial billing before starting a separate subscription."}</p>
        ${trial.refundStatus ? `<p class="muted">Card verification refund: ${escape(String(trial.refundStatus).replaceAll("_", " "))}.</p>` : ""}
        ${trial.cancellationStatus === "requested" ? '<p role="status">Cancellation is being confirmed with Paystack. It is not yet complete.</p>' : ""}
        ${trial.paymentUpdateAvailable ? `<button type="button" class="secondary" id="update-trial-card">${icon("credit-card")} Update payment card</button>` : ""}
        ${trial.canCancel && !canceled ? `<button type="button" class="secondary" id="cancel-trial">${icon("calendar-x")} Cancel trial billing</button>` : ""}
        <p id="trial-message" class="form-message" role="status" aria-live="polite"></p>`;
    } else if (trial.eligible || trial.canStartCheckout || trial.canVerify || trial.recoveryRequired) {
      host.innerHTML = `<h3>${trial.recoveryRequired ? "Card setup needs attention" : "Start your seven-day trial"}</h3>
        <p>Seven days of access with a card on file. Your subscription starts at ${escape(price)} after the trial.</p>
        <p class="muted">${trial.configured ? `${escape(amount)} is charged to verify your card. We request a refund after verification; your bank determines when it reaches your account.` : "Card verification is currently unavailable. Please try again later."}</p>
        ${trial.eligible || trial.canStartCheckout ? `<label class="trial-consent"><input type="checkbox" id="trial-consent" ${trial.configured ? "" : "disabled"}><span>I agree to the card verification charge and automatic subscription billing after seven days. I can cancel before the first subscription payment.</span></label>
        <button type="button" class="primary" id="start-trial" disabled>${icon("credit-card")} ${trial.checkoutReference ? "Continue card setup" : "Start seven-day trial"}</button>` : ""}
        ${trial.recoveryRequired ? '<p role="status">Card setup needs confirmation. Your trial begins only after the scheduled subscription is confirmed. Do not make another verification payment.</p>' : ""}
        ${trial.checkoutReference && trial.canVerify ? `<button type="button" class="text-button" id="verify-trial">Check card verification</button>` : ""}
        ${trial.canCancel ? `<button type="button" class="secondary" id="cancel-trial">Cancel trial billing</button>` : ""}
        <p id="trial-message" class="form-message" role="status" aria-live="polite"></p>`;
    } else {
      host.remove();
      return;
    }
    icons();
    const consent = host.querySelector("#trial-consent");
    const start = host.querySelector("#start-trial");
    if (consent) consent.onchange = () => { start.disabled = !consent.checked || !trial.configured; };
    if (start) start.onclick = () => act(start, async () => {
      if (!consent?.checked) throw new Error("Accept the verification charge and recurring billing terms before checkout.");
      const result = await api("billing/trial/checkout", { consent: true });
      const checkout = result.checkout;
      if (!checkout?.authorizationUrl || !checkout.reference) throw new Error("Card checkout could not be prepared. Please try again.");
      const url = new URL(checkout.authorizationUrl);
      if (url.protocol !== "https:" || url.hostname !== "checkout.paystack.com") throw new Error("The card checkout address could not be verified.");
      location.assign(url.href);
    }, "Preparing secure card checkout...");
    const verify = host.querySelector("#verify-trial");
    if (verify) verify.onclick = () => act(verify, async () => {
      await api("billing/trial/verify", { reference: trial.checkoutReference });
      await onChanged();
    }, "Checking card verification...");
    const cancel = host.querySelector("#cancel-trial");
    const update = host.querySelector("#update-trial-card");
    if (update) update.onclick = () => act(update, async () => {
      const result = await api("billing/trial/payment-update", {});
      const url = new URL(result.authorizationUrl);
      if (url.protocol !== "https:" || !["paystack.com", "checkout.paystack.com"].includes(url.hostname) || url.username || url.password) {
        throw new Error("The payment update address could not be verified.");
      }
      location.assign(url.href);
    }, "Preparing secure payment update...");
    if (cancel) cancel.onclick = () => {
      const dialog = document.createElement("dialog");
      dialog.className = "entry-review-dialog";
      dialog.innerHTML = `<h2>Cancel trial billing?</h2><p>${started && access ? `Your access continues until ${escape(dateLabel(trial.endsAt || trial.trialEndsAt))}. ` : ""}Your scheduled subscription payment will be canceled after confirmation from Paystack.</p><p role="status" class="form-message" id="trial-cancel-message"></p><div class="form-actions"><button type="button" class="secondary" data-keep-trial>Keep trial</button><button type="button" class="primary" data-confirm-trial-cancel>Cancel trial billing</button></div>`;
      host.append(dialog); dialog.showModal();
      dialog.addEventListener("close", () => dialog.remove());
      dialog.querySelector("[data-keep-trial]").onclick = () => dialog.close();
      const confirm = dialog.querySelector("[data-confirm-trial-cancel]");
      confirm.onclick = async () => {
        confirm.disabled = true;
        const output = dialog.querySelector("#trial-cancel-message");
        output.textContent = "Canceling scheduled billing...";
        try { await api("billing/trial/cancel", {}); dialog.close(); await onChanged(); }
        catch (error) { output.textContent = error.message; output.classList.add("error-text"); }
        finally { confirm.disabled = false; }
      };
    };
  }

  async function act(button, action, message) {
    const output = host.querySelector("#trial-message");
    button.disabled = true; output.textContent = message; output.classList.remove("error-text");
    try { await action(); }
    catch (error) { if (current()) { output.textContent = error.message; output.classList.add("error-text"); } }
    finally {
      if (current()) button.disabled = button.id === "start-trial" && !host.querySelector("#trial-consent")?.checked;
    }
  }
  const load = () => api("billing/trial").then((result) => {
    if (!current()) return;
    trial = result.trial;
    if (!trial) throw new Error("Trial status is unavailable.");
    render();
    const returned = new URL(location.href);
    if (returned.searchParams.get("trial_setup") === "attention") {
      const output = host.querySelector("#trial-message");
      if (output) {
        output.textContent = "Card setup could not be confirmed. Check verification again or contact support before making another payment.";
        output.classList.add("error-text");
      }
      returned.searchParams.delete("trial_setup");
      history.replaceState(history.state, "", returned.href);
    }
  }).catch((error) => {
    if (!current()) return;
    host.innerHTML = `<p role="alert" class="error-text">${escape(error.message)}</p><button type="button" class="text-button" id="retry-trial">Retry trial status</button>`;
    host.querySelector("#retry-trial").onclick = load;
  });
  load();
}
