/*
 * Unit tests for the Android display helpers that mirror the web's labels.ts, dates.ts,
 * supportCode.tsx and naState.tsx. The expected strings are the web's, so a code, a date,
 * a support code or a missing figure reads the same on the phone as in the browser.
 */
package pro.ai8ht.one

import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test
import java.time.LocalDate
import java.time.ZoneId

class LabelsTest {
    @Test fun rolesReadAsJobTitles() {
        assertEquals("Placement Officer", roleLabel("PLACEMENT_ADMIN"))
        assertEquals("Lecturer", roleLabel("FACULTY_LECTURER"))
        assertEquals("Career Counsellor", roleLabel("CAREER_COUNSELOR"))
        assertEquals("Regional Manager", roleLabel("GROWTH_MANAGER"))
        assertEquals("Operations Admin", roleLabel("OPERATIONS_ADMIN"))
    }

    @Test fun unknownRolesAreTitleCasedAndMissingReadsNa() {
        assertEquals("Chief HR Partner", roleLabel("CHIEF_HR_PARTNER"))
        assertEquals("NA", roleLabel(null))
        assertEquals("NA", roleLabel(""))
        assertEquals("Already words", roleLabel("Already words"))
    }

    @Test fun codesReadInSentenceCaseKeepingAcronyms() {
        assertEquals("Transferred", codeLabel("TRANSFERRED"))
        assertEquals("Under review", codeLabel("UNDER_REVIEW"))
        assertEquals("Department", codeLabel("DEPARTMENT"))
        assertEquals("CSV import", codeLabel("CSV_IMPORT"))
        assertEquals("Upload PDF", codeLabel("UPLOAD_PDF"))
    }

    @Test fun nonCodesPassThroughAndMissingReadsNa() {
        assertEquals("Placed in May", codeLabel("Placed in May"))
        assertEquals("NA", codeLabel(null))
        assertEquals("NA", codeLabel(""))
        assertEquals("NA", codeLabel("NA"))
    }

    @Test fun prettifyIsCodeLabel() {
        assertEquals(codeLabel("NOT_ENOUGH_EVIDENCE"), prettify("NOT_ENOUGH_EVIDENCE"))
        assertEquals("Not enough evidence", prettify("NOT_ENOUGH_EVIDENCE"))
    }
}

class DatesTest {
    private val utc = ZoneId.of("UTC")
    private val ist = ZoneId.of("Asia/Kolkata")

    @Test fun formatsMatchTheWeb() {
        assertEquals("7 Oct 2026", formatDate("2026-10-07T17:18:00Z", zone = utc))
        assertEquals("7 Oct 2026, 17:18", formatDateTime("2026-10-07T17:18:00Z", zone = utc))
        assertEquals("Sep 2026", formatMonth("2026-09-30T10:00:00Z", zone = utc))
        assertEquals("09:05", formatTime("2026-10-07T09:05:00Z", zone = utc))
    }

    @Test fun readsTheMomentInTheGivenZone() {
        assertEquals("7 Oct 2026, 22:48", formatDateTime("2026-10-07T17:18:00Z", zone = ist))
        assertEquals("1 Jun 2026", formatDate("2026-05-31T20:00:00Z", zone = ist))
    }

    @Test fun bareDaysAndMonthsAreCalendarValuesNotShifted() {
        assertEquals("25 Sep 2026", formatDate("2026-09-25", zone = ZoneId.of("America/Los_Angeles")))
        assertEquals("25 Sep 2026", formatDate("2026-09-25", zone = ist))
        assertEquals("Apr 2026", formatMonth("2026-04", zone = ist))
    }

    @Test fun postgresShapedTimestampsAreRead() {
        assertEquals("25 Aug 2026, 13:13", formatDateTime("2026-08-25 13:13:05.569371+00", zone = utc))
        assertEquals("25 Aug 2026, 13:13", formatDateTime("2026-08-25 18:43:05+0530", zone = utc))
        assertEquals("25 Aug 2026, 13:13", formatDateTime("2026-08-25T13:13:05+00:00", zone = utc))
    }

    @Test fun missingOrUnreadableReadsNaOrTheFallback() {
        assertEquals("NA", formatDate(null))
        assertEquals("NA", formatDate(""))
        assertEquals("NA", formatDateTime("not a date"))
        assertEquals("—", formatMonth(null, fallback = "—"))
        assertNull(parseDisplayDate("2026-13-40"))
    }

    @Test fun localDatesFormatTheSameWay() {
        assertEquals("3 Jan 2027", formatDate(LocalDate.of(2027, 1, 3)))
    }

    @Test fun formatWhenIsTheWebDateTime() {
        val iso = "2026-10-07T17:18:00Z"
        assertEquals(formatDateTime(iso), formatWhen(iso))
        assertEquals("NA", formatWhen(""))
    }
}

class SupportCodeTest {
    @Test fun firstEightAlphanumericsLowercased() {
        assertEquals("3f2a9c1b", supportCode("3F2A9C1B-4D5E-4F60-8A7B-1C2D3E4F5A6B"))
        assertEquals("ab12cd34", supportCode("ab-12-cd-34-ef"))
    }

    @Test fun aUuidCodeIsTheStartOfTheLoggedId() {
        val id = "0d4e7a91-2b3c-4d5e-8f90-a1b2c3d4e5f6"
        assertTrue(id.startsWith(supportCode(id)))
    }

    @Test fun shortOrMissingReferences() {
        assertEquals("abc", supportCode("a-b-c"))
        assertEquals("", supportCode(null))
        assertEquals("", supportCode(""))
        assertEquals("", supportCode("----"))
    }

    @Test fun suffixForMessages() {
        assertEquals(" Support code: ab12cd34.", supportCodeSuffix("ab12cd34-0000"))
        assertEquals("", supportCodeSuffix(null))
    }
}

class NaStateTest {
    @Test fun recognisesEveryMissingKind() {
        assertEquals(MissingKind.Na, missingKind(null))
        assertEquals(MissingKind.Na, missingKind("NA"))
        assertEquals(MissingKind.Suppressed, missingKind("<5"))
        assertEquals(MissingKind.Suppressed, missingKind("< 5"))
        assertEquals(MissingKind.Withheld, missingKind("Withheld"))
        assertEquals(MissingKind.Few, missingKind("Too few answers"))
    }

    @Test fun realValuesAreNotMissing() {
        assertNull(missingKind("0"))
        assertNull(missingKind("12"))
        assertNull(missingKind("1,204+"))
        assertNull(missingKind("NA — no scheduled windows."))
        assertNull(missingKind("Verified"))
    }

    @Test fun allMissingNeedsAtLeastOneValue() {
        assertTrue(allMissingFigures(listOf("NA", "<5", "Withheld")))
        assertFalse(allMissingFigures(listOf("NA", "0")))
        assertFalse(allMissingFigures(emptyList()))
    }

    @Test fun aChartDrawsOnlyWhenEveryPointIsShown() {
        assertTrue(chartDrawable(listOf(0, 0, 3)))
        assertFalse(chartDrawable(listOf(1, null, 3)))
        assertFalse(chartDrawable(emptyList()))
        assertFalse(chartDrawable(null))
    }
}
