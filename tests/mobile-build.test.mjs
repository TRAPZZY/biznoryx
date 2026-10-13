import assert from "node:assert/strict";
import test from "node:test";
import {spawnSync} from "node:child_process";
import { readFile } from "node:fs/promises";
import { createHash } from "node:crypto";

test("Android launcher and splash use the complete approved artwork without image edits", async () => {
  const asset = await readFile("android/app/src/main/res/drawable-nodpi/biznoryx_brand.png");
  assert.equal(createHash("sha256").update(asset).digest("hex"), "832e2d1a656d60771d2681149c99697b208778845cae3c38e2256b36cdf7940d");
  const manifest = await readFile("android/app/src/main/AndroidManifest.xml", "utf8");
  assert.match(manifest,/android:icon="@drawable\/biznoryx_launcher"/);
  assert.match(manifest,/android:roundIcon="@drawable\/biznoryx_launcher"/);
  const theme = await readFile("android/app/src/main/res/values/styles.xml", "utf8");
  assert.match(theme,/@drawable\/biznoryx_splash/);
  assert.match(theme,/postSplashScreenTheme/);
});

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
