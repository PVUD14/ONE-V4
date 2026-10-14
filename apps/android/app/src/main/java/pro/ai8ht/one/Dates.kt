/*
 * ONE · Date display
 *
 * One way to show a date to a person, the same as the web app's dates.ts: "7 Oct 2026",
 * "7 Oct 2026, 17:18", "Sep 2026" and "17:18". Before this each screen picked its own
 * pattern, so one card read "2026-09-30", the next "30 Sep" and a third "30 September
 * 2026, 5:18 pm". Month names are fixed English abbreviations, as on the web, rather than
 * whatever the phone's locale prints. Display only: values sent to the API never pass
 * through here.
 */
package pro.ai8ht.one

import java.time.Instant
import java.time.LocalDate
import java.time.LocalDateTime
import java.time.OffsetDateTime
import java.time.ZoneId
import java.time.ZonedDateTime

private val MONTHS = listOf("Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec")
private const val DATE_NA = "NA"
private val calendarDay = Regex("^(\\d{4})-(\\d{2})(?:-(\\d{2}))?$")

/**
 * A server value as a moment in [zone], or null when it is missing or not a date.
 *
 * A bare "2026-09-25" or "2026-09" is a calendar day, not a moment, so it is never shifted
 * by a time zone. Anything else is read as an instant. `Instant.parse` only accepts the strict
 * ISO form, and some routes return a column as Postgres prints it — `2026-08-25
 * 13:13:05.569371+00`, a space for the `T` and a two-digit offset — so those shapes are
 * normalised here rather than in each caller. A value with no offset at all is read as local
 * time rather than inventing a zone.
 */
internal fun parseDisplayDate(value: String?, zone: ZoneId = ZoneId.systemDefault()): ZonedDateTime? {
    val text = value?.trim().orEmpty()
    if (text.isEmpty()) return null
    calendarDay.matchEntire(text)?.let { match ->
        val (year, month, day) = match.destructured
        return runCatching { LocalDate.of(year.toInt(), month.toInt(), day.ifEmpty { "1" }.toInt()).atStartOfDay(zone) }.getOrNull()
    }
    val normalised = text
        .replaceFirst(' ', 'T')
        // "+00" and "+0530" are valid Postgres output and invalid ISO offsets.
        .replace(Regex("([+-])(\\d{2})$"), "$1$2:00")
        .replace(Regex("([+-])(\\d{2})(\\d{2})$"), "$1$2:$3")
    return runCatching { Instant.parse(normalised).atZone(zone) }
        .recoverCatching { OffsetDateTime.parse(normalised).atZoneSameInstant(zone) }
        .recoverCatching { LocalDateTime.parse(normalised).atZone(zone) }
        .getOrNull()
}

private fun two(value: Int): String = value.toString().padStart(2, '0')

/** "7 Oct 2026" */
internal fun formatDate(value: String?, fallback: String = DATE_NA, zone: ZoneId = ZoneId.systemDefault()): String =
    parseDisplayDate(value, zone)?.let { "${it.dayOfMonth} ${MONTHS[it.monthValue - 1]} ${it.year}" } ?: fallback

/** "7 Oct 2026, 17:18" */
internal fun formatDateTime(value: String?, fallback: String = DATE_NA, zone: ZoneId = ZoneId.systemDefault()): String =
    parseDisplayDate(value, zone)?.let { "${it.dayOfMonth} ${MONTHS[it.monthValue - 1]} ${it.year}, ${two(it.hour)}:${two(it.minute)}" } ?: fallback

/** "Sep 2026" */
internal fun formatMonth(value: String?, fallback: String = DATE_NA, zone: ZoneId = ZoneId.systemDefault()): String =
    parseDisplayDate(value, zone)?.let { "${MONTHS[it.monthValue - 1]} ${it.year}" } ?: fallback

/** "17:18" */
internal fun formatTime(value: String?, fallback: String = DATE_NA, zone: ZoneId = ZoneId.systemDefault()): String =
    parseDisplayDate(value, zone)?.let { "${two(it.hour)}:${two(it.minute)}" } ?: fallback

/** A local calendar day ("7 Oct 2026"), for dates the app computes itself. */
internal fun formatDate(value: LocalDate): String = "${value.dayOfMonth} ${MONTHS[value.monthValue - 1]} ${value.year}"
