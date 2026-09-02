package com.ocplugin.app.commands

import org.junit.Assert.assertEquals
import org.junit.Assert.assertTrue
import org.junit.Test

class PasskeyAuthTest {
    @Test
    fun registrationRequiresDiscoverableCredential() {
        assertEquals("required", PASSKEY_RESIDENT_KEY)
        assertTrue(PASSKEY_REQUIRE_RESIDENT_KEY)
    }

    @Test
    fun credentialIdsAreValidatedAndDeduplicated() {
        assertEquals(
            listOf("AQID", "_wAB"),
            normalizeCredentialIds(
                arrayOf(
                    " AQID ",
                    "AQID",
                    "",
                    "not valid",
                    "_wAB",
                    "A".repeat(MAX_BASE64URL_CREDENTIAL_ID_LENGTH + 1),
                ),
            ),
        )
    }
}
