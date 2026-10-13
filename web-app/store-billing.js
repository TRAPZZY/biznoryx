const escape = value => String(value ?? "").replace(/[&<>"']/g, char=>({"&":"&amp;","<":"&lt;",">":"&gt;",'"':"&quot;","'":"&#39;"})[char]);

export async function mountStoreBilling({container,api,subscription}) {
  const native = window.biznoryxNative;
  container.innerHTML = `<section class="account-settings"><h2>Subscription</h2><p id="store-status" role="status">Loading subscription...</p>
    <div id="store-packages"></div><div class="form-actions"><button type="button" class="secondary" id="store-restore">Restore purchases</button><button type="button" class="secondary" id="store-manage">Manage subscription</button></div>
    <p>Subscriptions renew automatically unless cancelled in your store account. Trial eligibility, price and renewal terms are confirmed by Apple or Google before payment.</p>
    <p><a href="/terms.html">Terms of service</a> | <a href="/privacy.html">Privacy policy</a></p></section>`;
  const status = container.querySelector("#store-status");
  const restore = container.querySelector("#store-restore");
  const manage = container.querySelector("#store-manage");
  const host = container.querySelector("#store-packages");
  let currentSubscription = subscription;
  if (native && subscription?.provider === "paystack" && (["active","non_renewing","past_due","pending_checkout"].includes(subscription.status) || subscription.trial?.providerProvisioned)) {
    status.textContent = "Your workspace has an existing website subscription. Store purchases are unavailable while that billing arrangement remains in place.";
    restore.hidden = true; manage.hidden = true;
    return;
  }
  restore.disabled = true;
  manage.onclick = async () => {
    try {
      if (native) await native.manageSubscriptions({provider:currentSubscription?.provider});
      else window.open("https://apps.apple.com/account/subscriptions","_blank","noopener");
    } catch (error) { status.textContent = error.message; }
  };
  try {
    const result = await api("billing/store/context");
    if (!container.isConnected) return;
    const update = subscription => {
      currentSubscription = subscription;
      status.textContent = ["active","non_renewing"].includes(subscription.status) && new Date(subscription.currentPeriodEnd) > new Date()
        ? `${subscription.status.replaceAll("_"," ")} until ${new Date(subscription.currentPeriodEnd).toLocaleDateString()}`
        : "No active store subscription.";
      if (["active","non_renewing"].includes(subscription.status) && new Date(subscription.currentPeriodEnd) > new Date()) host.replaceChildren();
    };
    update(result.subscription);
    if (!native) {
      restore.hidden = true;
      manage.onclick = () => window.open(result.subscription.provider === "play_store" ? "https://play.google.com/store/account/subscriptions" : "https://apps.apple.com/account/subscriptions","_blank","noopener");
      return;
    }
    restore.disabled = false;
    const run = async work => {
      for (const button of container.querySelectorAll("button")) button.disabled = true;
      try { update((await work()).subscription); }
      catch (error) { status.textContent = error.userCancelled ? "Purchase cancelled." : error.message; }
      finally { for (const button of container.querySelectorAll("button")) button.disabled = false; }
    };
    restore.onclick = () => run(()=>native.restore(result.customerId));
    if (["active","non_renewing"].includes(result.subscription.status) && new Date(result.subscription.currentPeriodEnd) > new Date()) return;
    const approvedProducts = Object.values(result.products).flat();
    const packages = (await native.offerings(result.customerId)).filter(item=>item.packageType === "MONTHLY" && item.product.subscriptionPeriod === "P1M" && approvedProducts.includes(item.product.identifier));
    if (!container.isConnected) return;
    if (!packages.length) { status.textContent = "No store subscription is available. Please try again later."; return; }
    host.innerHTML = packages.map((item,index)=>`<p>${escape(item.product.title)}: ${escape(item.product.priceString)} per month</p><button type="button" class="primary" data-store-package="${index}">Subscribe: ${escape(item.product.priceString)} per month</button>`).join("");
    for (const button of host.querySelectorAll("button")) button.onclick = () => run(()=>native.purchase(result.customerId,packages[Number(button.dataset.storePackage)]));
  } catch (error) { status.textContent = error.message; restore.disabled = true; }
}
