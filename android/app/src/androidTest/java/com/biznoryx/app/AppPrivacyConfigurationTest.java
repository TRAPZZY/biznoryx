package com.biznoryx.app;

import static org.junit.Assert.*;

import android.content.Context;
import android.content.pm.ApplicationInfo;
import android.security.NetworkSecurityPolicy;
import androidx.test.ext.junit.runners.AndroidJUnit4;
import androidx.test.platform.app.InstrumentationRegistry;
import org.junit.Test;
import org.junit.runner.RunWith;

@RunWith(AndroidJUnit4.class)
public class AppPrivacyConfigurationTest {

    @Test
    public void applicationUsesItsRegisteredIdentity() {
        Context appContext = InstrumentationRegistry.getInstrumentation().getTargetContext();

        assertEquals("com.biznoryx.app", appContext.getPackageName());
    }

    @Test
    public void automaticApplicationBackupIsDisabled() {
        Context appContext = InstrumentationRegistry.getInstrumentation().getTargetContext();
        assertEquals(0, appContext.getApplicationInfo().flags & ApplicationInfo.FLAG_ALLOW_BACKUP);
    }

    @Test
    public void cleartextNetworkTrafficIsDisabled() {
        assertFalse(NetworkSecurityPolicy.getInstance().isCleartextTrafficPermitted());
    }
}
