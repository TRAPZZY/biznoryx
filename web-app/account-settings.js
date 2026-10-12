const escape = value => String(value ?? "").replace(/[&<>"']/g, char => ({"&":"&amp;","<":"&lt;",">":"&gt;",'"':"&quot;","'":"&#39;"})[char]);

export async function mountAccountSettings({ container, api, onDeleted }) {
  container.innerHTML = '<p role="status">Loading account...</p>';
  const context = await api("account/deletion");
  if (!container.isConnected) return;
  container.innerHTML = `<section class="account-settings"><h2>Delete account</h2>
    <p>This removes your access immediately. Shared business records stay with remaining members. Workspaces you close and their uploaded files will be permanently deleted after processing and billing cleanup.</p>
    <p>Account deletion does not cancel an Apple or Google subscription. Cancel it in your store account to prevent further billing.</p>
    <form id="account-delete-form">
      ${context.organizations.filter(org => org.lastOwner).map(org => `<label>${escape(org.name)}: replacement owner
      <select data-transfer="${escape(org.id)}"><option value="">Close this workspace</option>${org.members.map(member => `<option value="${escape(member.id)}">${escape(member.name)}</option>`).join("")}</select></label>`).join("")}
      <label><input type="checkbox" name="closeWorkspaces"> Permanently delete workspaces without a replacement owner, including other members' records</label>
      <label>Current password<input name="password" type="password" autocomplete="current-password" required maxlength="1024"></label>
      <label><input type="checkbox" name="confirm" required> I understand this cannot be undone</label>
      <p role="alert" id="account-delete-message"></p>
      <button type="submit" class="secondary">Delete my account</button>
    </form></section>`;
  const form = container.querySelector("form");
  form.onsubmit = async event => {
    event.preventDefault();
    const button = form.querySelector("button"); button.disabled = true;
    const message = container.querySelector("#account-delete-message");
    const transfers = Object.fromEntries([...form.querySelectorAll("[data-transfer]")].filter(node=>node.value).map(node=>[node.dataset.transfer,node.value]));
    try {
      const result = await api("account/deletion", { password: form.elements.password.value, confirm: form.elements.confirm.checked,
        closeWorkspaces: form.elements.closeWorkspaces.checked, transfers });
      await onDeleted(result);
    } catch (error) { message.textContent = error.message; button.disabled = false; }
  };
}

export function mountDeletionStatus({ container, api, receipt = "" }) {
  container.innerHTML = `<section class="account-settings"><h1>Account deletion</h1><p>Your access is revoked when a request is accepted. Cleanup may take longer while a payment refund or processing finishes. Keep your private deletion reference to check progress.</p>
    <form><label>Private deletion reference<input name="receipt" autocomplete="off" required value="${escape(receipt)}" maxlength="43"></label><button class="secondary">Check status</button></form>
    <p role="status" id="deletion-status"></p><a href="#/sign-in">Sign in</a></section>`;
  const form = container.querySelector("form");
  const check = async () => {
    const output = container.querySelector("#deletion-status");
    const button = form.querySelector("button"); button.disabled = true;
    try {
      const result = await api("account/deletion/status", { receipt: form.elements.receipt.value });
      output.textContent = ({queued:"Deletion requested. Cleanup is pending.",purging:"Cleanup is in progress.",completed:"Account deletion completed.",attention:"Cleanup needs support assistance. Contact support with your private deletion reference."})[result.status] || "Status unavailable.";
    } catch (error) { output.textContent = error.message; }
    finally { button.disabled = false; }
  };
  form.onsubmit = event => { event.preventDefault(); check(); };
  if (receipt) check();
}
