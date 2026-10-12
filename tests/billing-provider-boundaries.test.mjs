import assert from "node:assert/strict";
import test from "node:test";
import { createProductionApp } from "../src/webapp/production-app.mjs";

for (const scenario of [
  {provider:"paystack",route:"checkout",status:"trialing",expected:200},
  {provider:"app_store",route:"checkout",status:"canceled",expected:400},
  {provider:"play_store",route:"renew",status:"non_renewing",expected:400},
]) {
  test(`${scenario.provider} ${scenario.route} respects the website billing boundary`, async () => {
    const previous = {secret:process.env.PAYSTACK_SECRET_KEY,plan:process.env.PAYSTACK_PLAN_CODE};
    process.env.PAYSTACK_SECRET_KEY = "sk_test_boundary";
    process.env.PAYSTACK_PLAN_CODE = "PLN_boundary";
    let providerCalls = 0;
    let savedCheckout;
    const subscription = {id:"subscription-1",organizationId:"org-1",provider:scenario.provider,status:scenario.status,
      planId:"monthly",planName:"Monthly",currency:"NGN",amountMinor:4_000_000,interval:"monthly"};
    const {server} = createProductionApp({
      identityRepository: {
        async authenticate({token,csrfToken,requireCsrf}) {
          assert.equal(token,"boundary-session"); assert.equal(csrfToken,"csrf-token"); assert.equal(requireCsrf,true);
          return {user:{id:"user-1",email:"owner@example.com"},session:{id:"session-1",activeOrganizationId:"org-1"}};
        },
        async activeMemberships() { return [{organizationId:"org-1",role:"owner"}]; },
      },
      emailVerificationRepository:{},
      billingRepository:{
        async ensureSubscription() { return subscription; },
        async createCheckoutSession(input) { savedCheckout=input; },
        async renewSubscription() { throw new Error("Store renewal must not reach website billing."); },
      },
      async paystackFetch(url,options) {
        providerCalls++;
        assert.equal(String(url),"https://api.paystack.co/transaction/initialize");
        assert.equal(options.method,"POST");
        const payload = JSON.parse(options.body);
        assert.equal(payload.email,"owner@example.com");
        assert.equal(payload.metadata.organization_id,"org-1");
        return Response.json({status:true,data:{reference:payload.reference,access_code:"access-code",authorization_url:"https://checkout.paystack.com/boundary"}});
      },
      production:false,
    });
    try {
      await new Promise(resolve=>server.listen(0,"127.0.0.1",resolve));
      const response = await fetch(`http://127.0.0.1:${server.address().port}/api/billing/${scenario.route}`,{
        method:"POST",headers:{cookie:"bnx_session=boundary-session","x-csrf-token":"csrf-token"},
      });
      const body = await response.json();
      assert.equal(response.status,scenario.expected,JSON.stringify(body));
      if (scenario.provider === "paystack") {
        assert.equal(providerCalls,1);
        assert.equal(savedCheckout.organizationId,"org-1");
        assert.equal(savedCheckout.reference,body.checkout.reference);
        assert.equal(body.checkout.authorizationUrl,"https://checkout.paystack.com/boundary");
      } else {
        assert.equal(providerCalls,0);
        assert.equal(savedCheckout,undefined);
        assert.equal(body.error,"VALIDATION_FAILED");
      }
    } finally {
      for (const [name,value] of [["PAYSTACK_SECRET_KEY",previous.secret],["PAYSTACK_PLAN_CODE",previous.plan]]) {
        if (value === undefined) delete process.env[name]; else process.env[name]=value;
      }
      server.closeAllConnections?.();
      await new Promise(resolve=>server.close(resolve));
    }
  });
}
