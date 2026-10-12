import { Capacitor, CapacitorHttp } from "@capacitor/core";
import { App } from "@capacitor/app";
import { Browser } from "@capacitor/browser";
import { Filesystem, Directory } from "@capacitor/filesystem";
import { Share } from "@capacitor/share";
import { SecureStorage, KeychainAccess } from "@aparajita/capacitor-secure-storage";
import { Purchases } from "@revenuecat/purchases-capacitor";

const config = __BIZNORYX_MOBILE_CONFIG__;
let token;
let purchaseIdentity;
let purchaseConfigured = false;
let storageWrites = Promise.resolve();
let sessionGeneration = 0;

function draftKey(scope) {
  if (!token || !/^[\w-]+:[\w-]+$/.test(scope) || scope.includes("undefined")) throw new Error("Draft recovery is unavailable. Sign in again.");
  return `draft:${scope}`;
}
function updateStorage(work) {
  const next = storageWrites.catch(()=>{}).then(work);
  storageWrites = next;
  return next;
}

async function clearIdentity({clearDrafts=false}={}) {
  sessionGeneration++;
  token = null;
  purchaseIdentity = null;
  await updateStorage(()=>clearDrafts ? SecureStorage.clear() : SecureStorage.remove("session"));
}

async function request(path, body) {
  if (!/^[a-z][a-z0-9/?&=%_.+-]*$/i.test(path) || path.includes("..")) throw new Error("Invalid API request.");
  const sessionAtRequest = token;
  const generationAtRequest = sessionGeneration;
  const response = await CapacitorHttp.request({ url: config.apiOrigin + "/api/" + path,
    method: body === undefined ? "GET" : "POST", responseType: "json", connectTimeout: 15000, readTimeout: 30000,
    headers: { "Content-Type": "application/json", "X-Biznoryx-Client": "mobile-v1", ...(token ? {Authorization:`Bearer ${token}`} : {}) },
    ...(body === undefined ? {} : {data:body}) });
  if (generationAtRequest !== sessionGeneration) throw new Error("Your session changed while the request was running. Please try again.");
  let payload;
  try { payload = typeof response.data === "string" ? JSON.parse(response.data) : response.data; }
  catch { throw new Error("The server returned an unreadable response. Please retry."); }
  if (!payload || typeof payload !== "object" || Array.isArray(payload)) throw new Error("The server returned an unreadable response. Please retry.");
  if (response.status === 401 && token === sessionAtRequest && ["SESSION_INVALID","USER_DISABLED","MEMBERSHIP_DISABLED"].includes(payload?.error)) await clearIdentity();
  if (response.status < 200 || response.status >= 300) {
    const error = new Error(payload?.message || "Request failed. Please try again.");
    error.status = response.status; error.payload = payload; throw error;
  }
  if (Object.hasOwn(payload, "sessionToken")) {
    if (typeof payload.sessionToken !== "string" || !/^[A-Za-z0-9_-]{43}$/.test(payload.sessionToken)) throw new Error("The server returned an invalid session credential. Please sign in again.");
    const generationAtSave = ++sessionGeneration;
    token = payload.sessionToken;
    try { await updateStorage(()=>SecureStorage.set("session", payload.sessionToken)); }
    catch {
      if (sessionGeneration === generationAtSave) await clearIdentity();
      throw new Error("Your session could not be saved in protected storage. Please sign in again.");
    }
    delete payload.sessionToken;
    if (generationAtSave !== sessionGeneration) throw new Error("Your session changed while the request was running. Please try again.");
  }
  if (path === "session" && payload.authenticated === false && token === sessionAtRequest) await clearIdentity();
  if (path === "sign-out" || path === "account/deletion" && body) await clearIdentity({clearDrafts:true});
  return payload;
}

async function configurePurchases(identity) {
  if (!token || !identity) throw new Error("Sign in before managing subscriptions.");
  const key = config[Capacitor.getPlatform() === "ios" ? "applePublicKey" : "googlePublicKey"];
  if (!key) throw new Error("Store subscriptions are not configured yet.");
  if (!purchaseConfigured) {
    await Purchases.configure({apiKey:key,appUserID:identity});
    purchaseConfigured = true;
  } else if (purchaseIdentity !== identity) await Purchases.logIn({appUserID:identity});
  purchaseIdentity = identity;
}

window.biznoryxNative = {
  request,
  async saveDraftSnapshot(scope,draft) {
    const key = draftKey(scope);
    return updateStorage(()=>SecureStorage.set(key,draft));
  },
  async clearDraftSnapshot(scope) { const key=draftKey(scope); return updateStorage(()=>SecureStorage.remove(key)); },
  async loadDraftSnapshot(scope) { const key=draftKey(scope); await storageWrites.catch(()=>{}); return SecureStorage.get(key); },
  async offerings(identity) {
    await configurePurchases(identity);
    return (await Purchases.getOfferings()).current?.availablePackages ?? [];
  },
  async purchase(identity, aPackage) { await configurePurchases(identity); await Purchases.purchasePackage({aPackage}); return request("billing/store/sync", {}); },
  async restore(identity) { await configurePurchases(identity); await Purchases.restorePurchases(); return request("billing/store/sync", {}); },
  async manageSubscriptions({provider}={}) {
    const apple = provider === "app_store" || provider !== "play_store" && Capacitor.getPlatform() === "ios";
    await Browser.open({url:apple ? "https://apps.apple.com/account/subscriptions" : "https://play.google.com/store/account/subscriptions"});
  },
  async exportReport({path,filename}) {
    if (!token || !/^[a-zA-Z0-9._-]+$/.test(filename) || !path.startsWith("evidence-report?")) throw new Error("Invalid report export.");
    const result = await CapacitorHttp.get({url:config.apiOrigin + "/api/" + path,responseType:"arraybuffer",
      headers:{"X-Biznoryx-Client":"mobile-v1",Authorization:`Bearer ${token}`},readTimeout:60000});
    if (result.status !== 200) throw new Error("Report export failed. Please try again.");
    const file = await Filesystem.writeFile({path:filename,data:result.data,directory:Directory.Cache});
    try { await Share.share({title:"BIZNORYX evidence report",files:[file.uri]}); }
    finally { await Filesystem.deleteFile({path:filename,directory:Directory.Cache}); }
  },
};

try {
  if (!Capacitor.isNativePlatform()) throw new Error("Open this build in the installed BIZNORYX app.");
  await SecureStorage.setKeyPrefix("biznoryx.");
  await SecureStorage.setSynchronize(false);
  await SecureStorage.setDefaultKeychainAccess(KeychainAccess.whenUnlockedThisDeviceOnly);
  token = await SecureStorage.get("session");
  if (token && (typeof token !== "string" || !/^[A-Za-z0-9_-]{43}$/.test(token))) await clearIdentity();
  document.body.classList.add("native-app");
  await App.addListener("pause",()=>window.dispatchEvent(new Event("biznoryx:pause")));
  await App.addListener("backButton", () => {
    const dialog = document.querySelector("dialog[open]");
    if (dialog) dialog.close();
    else if (!["#/dashboard","#/sign-in",""].includes(location.hash)) history.back();
    else App.minimizeApp();
  });
  document.addEventListener("click", event => {
    const anchor = event.target.closest("a");
    if (!anchor || anchor.getAttribute("href")?.startsWith("#")) return;
    const url = new URL(anchor.getAttribute("href"), config.apiOrigin);
    if (url.protocol !== "https:" || url.origin !== config.apiOrigin) { event.preventDefault(); return; }
    event.preventDefault(); Browser.open({url:url.href});
  });
  await import("../web-app/app.js");
} catch (error) {
  document.querySelector("#app").textContent = error.message || "Unable to start BIZNORYX. Please reopen the app.";
}
