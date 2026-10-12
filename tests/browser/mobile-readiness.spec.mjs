import { test, expect } from "./helpers/review-fixtures.mjs";

async function signIn(page) {
  await page.goto("/#/sign-in");
  await page.getByLabel("Work email").fill("owner@biznoryx.local");
  await page.getByLabel("Password",{exact:true}).fill("ReviewPassphrase2026!");
  await page.getByRole("button",{name:"Sign in",exact:true}).click();
  await expect(page.locator("#workspace-sidebar")).toBeAttached();
}
test("account deletion phone UI supports transfer, errors and a private status receipt",async({page},info)=>{
  await page.setViewportSize({width:390,height:844});
  await page.route("**/api/account/deletion",route=>route.request().method()==="GET" ? route.fulfill({json:{organizations:[{id:"org-a",name:"Shared business",lastOwner:true,members:[{id:"member-a",name:"Replacement Owner"}]}]}}) :
    route.fulfill(route.request().postDataJSON().password === "wrong" ? {status:400,json:{message:"Your current password is incorrect."}} : {status:202,json:{receipt:"a".repeat(43),status:"queued"}}));
  await page.route("**/api/account/deletion/status",route=>route.fulfill({json:{status:"completed"}}));
  await signIn(page);await page.goto("/#/account");
  await page.locator("[data-transfer]").selectOption("member-a");
  await page.getByLabel("Current password").fill("wrong");
  await page.getByLabel("I understand this cannot be undone").check();
  await page.getByRole("button",{name:"Delete my account"}).click();
  await expect(page.locator("#account-delete-message")).toContainText("incorrect");
  await page.screenshot({path:info.outputPath("account-mobile.png"),fullPage:true});
  expect(await page.evaluate(()=>document.documentElement.scrollWidth <= innerWidth+1)).toBe(true);
  await page.getByLabel("Current password").fill("correct");
  await page.getByRole("button",{name:"Delete my account"}).click();
  await expect(page.locator("#deletion-status")).toHaveText("Account deletion completed.");
  await expect(page.getByLabel("Private deletion reference")).toHaveValue("a".repeat(43));
});
test("public privacy, terms and deletion resources are reachable",async({page})=>{
  for (const [path, heading] of [["/privacy.html","BIZNORYX Privacy Policy"],["/terms.html","BIZNORYX Terms of Use"],["/account-deletion.html","Account deletion requests"]]) {
    const response=await page.goto(path);expect(response.status()).toBe(200);
    await expect(page.getByRole("heading",{level:1})).toHaveText(heading);
    await expect(page.locator("body")).toContainText("BIZNORYX");
  }
});

test("the public privacy policy is readable without scripts or a login on desktop and phone",async({page},info)=>{
  for (const width of [1440,390]) {
    await page.setViewportSize({width,height:844});
    const response=await page.goto("/privacy.html");
    expect(response.status()).toBe(200);
    await expect(page.getByRole("heading",{name:"BIZNORYX Privacy Policy",exact:true})).toBeVisible();
    expect(await page.locator("script").count()).toBe(0);
    await expect(page.locator("#retention")).toContainText("not automatically deleted");
    await expect(page.locator("#retention")).toContainText("expiry periods have not been confirmed");
    await expect(page.locator("#deletion")).toContainText("support-assisted");
    const responseCss=await page.request.get("/privacy.css");
    expect(responseCss.status()).toBe(200);
    expect(await page.evaluate(()=>document.documentElement.scrollWidth <= innerWidth+1)).toBe(true);
    for (const link of await page.locator('.policy-contents a').evaluateAll(nodes=>nodes.map(node=>node.hash))) {
      await expect(page.locator(link)).toBeAttached();
    }
    await page.screenshot({path:info.outputPath(`privacy-${width}.png`),fullPage:true});
  }
});

async function installNativeContract(page) {
  await page.evaluate(async()=>{
    const fresh=await (await fetch("/api/session")).json();
    window.nativeSnapshots=[];
    window.biznoryxNative={
      async request(path,body){
        const response=await fetch(`/api/${path}`,{method:body===undefined?"GET":"POST",headers:{"Content-Type":"application/json","X-CSRF-Token":fresh.csrfToken},...(body===undefined?{}:{body:JSON.stringify(body)})});
        const payload=await response.json();if(!response.ok)throw new Error(payload.message);return payload;
      },
      async saveDraftSnapshot(scope,draft){window.nativeSnapshots.push({scope,draft});},
      async clearDraftSnapshot(){},async loadDraftSnapshot(){return null;},
    };
  });
}
test("native UI contract scopes draft recovery to the signed-in user and business",async({page},info)=>{
  await page.setViewportSize({width:390,height:844});await signIn(page);
  const session=await (await page.request.get("/api/session")).json();
  await installNativeContract(page);await page.goto("/#/data");
  await page.getByRole("tab",{name:"Enter data"}).click();
  await page.getByLabel("Row 1, product",{exact:true}).fill("Device record");
  await expect.poll(()=>page.evaluate(()=>window.nativeSnapshots.length)).toBeGreaterThan(0);
  const snapshot=await page.evaluate(()=>window.nativeSnapshots.at(-1));
  expect(snapshot.scope).toBe(`${session.shell.user.id}:${session.shell.activeOrganization.id}`);
  expect(snapshot.draft.rows[0]).toContain("Device record");
  await expect(page.locator(".entry-records")).toBeVisible();
  expect(await page.evaluate(()=>document.documentElement.scrollWidth <= innerWidth+1)).toBe(true);
  await page.screenshot({path:info.outputPath("native-record-view.png"),fullPage:true});
});
test("native billing UI contract filters unapproved products and supports purchase and restore",async({page},info)=>{
  await page.setViewportSize({width:390,height:844});await signIn(page);await installNativeContract(page);
  const subscription={provider:"app_store",status:"trialing",currentPeriodEnd:null};
  await page.route("**/api/billing/store/context",route=>route.fulfill({json:{customerId:"known-business",subscription,products:{app_store:["monthly"],play_store:[]}}}));
  await page.route("**/api/billing/store/sync",route=>route.fulfill({json:{subscription:{...subscription,status:"active",currentPeriodEnd:new Date(Date.now()+86400000).toISOString()}}}));
  await page.evaluate(()=>{
    window.nativeBillingCalls=[];
    Object.assign(window.biznoryxNative,{
      async offerings(){return [{packageType:"MONTHLY",product:{identifier:"monthly",subscriptionPeriod:"P1M",title:"Business Monthly",priceString:"$12.00"}},
        {packageType:"ANNUAL",product:{identifier:"annual",subscriptionPeriod:"P1Y",title:"Unapproved",priceString:"$99.00"}}];},
      async purchase(identity,item){window.nativeBillingCalls.push({operation:"purchase",identity,product:item.product.identifier});return this.request("billing/store/sync",{});},
      async restore(identity){window.nativeBillingCalls.push({operation:"restore",identity});return this.request("billing/store/sync",{});},
      async manageSubscriptions({provider}){window.nativeBillingCalls.push({operation:"manage",provider});},
    });
  });
  await page.goto("/#/billing");
  await expect(page.getByRole("button",{name:"Subscribe: $12.00 per month",exact:true})).toBeVisible();
  await expect(page.getByText("Unapproved",{exact:true})).toHaveCount(0);
  await page.screenshot({path:info.outputPath("native-billing-ui.png"),fullPage:true});
  await page.getByRole("button",{name:"Subscribe: $12.00 per month",exact:true}).click();
  await expect(page.locator("#store-status")).toContainText("active until");
  await expect(page.getByRole("button",{name:"Subscribe: $12.00 per month",exact:true})).toHaveCount(0);
  await page.getByRole("button",{name:"Restore purchases"}).click();
  await page.getByRole("button",{name:"Manage subscription"}).click();
  expect(await page.evaluate(()=>window.nativeBillingCalls)).toEqual([
    {operation:"purchase",identity:"known-business",product:"monthly"},{operation:"restore",identity:"known-business"},{operation:"manage",provider:"app_store"},
  ]);
});
