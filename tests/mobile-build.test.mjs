import assert from "node:assert/strict";
import test from "node:test";
import {spawnSync} from "node:child_process";

for (const [name,invalid] of [
  ["cleartext API",{MOBILE_API_ORIGIN:"http://example.invalid"}],
  ["credential-bearing API",{MOBILE_API_ORIGIN:"https://user:password@example.invalid"}],
  ["server secret",{MOBILE_REVENUECAT_APPLE_KEY:"sk_test_should_not_be_bundled"}],
  ["swapped storefront keys",{MOBILE_REVENUECAT_APPLE_KEY:"goog_testpublic",MOBILE_REVENUECAT_GOOGLE_KEY:"appl_testpublic"}],
]) {
  test(`mobile packaging rejects ${name} before writing assets`,()=>{
    const result=spawnSync(process.execPath,["scripts/mobile-build.mjs"],{encoding:"utf8",env:{...process.env,
      MOBILE_API_ORIGIN:"https://biznoryx.com",MOBILE_REVENUECAT_APPLE_KEY:"",MOBILE_REVENUECAT_GOOGLE_KEY:"",...invalid}});
    assert.equal(result.status,1);
    assert.match(result.stderr,/HTTPS origin|matching RevenueCat public SDK key/);
    assert.ok(!result.stderr.includes("sk_test_should_not_be_bundled"));
  });
}
