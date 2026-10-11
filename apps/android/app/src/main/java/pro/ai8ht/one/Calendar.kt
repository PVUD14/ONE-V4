package pro.ai8ht.one

import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.lazy.LazyColumn
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.filled.DateRange
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.unit.dp
import pro.ai8ht.one.ui.Tone
import java.time.Instant
import java.time.ZoneId
import java.time.format.DateTimeFormatter

/**
 * One calendar for whoever is signed in, on the phone.
 *
 * Nothing here is stored by this screen. Interviews, exam windows, assigned tasks and
 * roadmap deadlines are read back from the merged feed the server builds, which applies
 * each source's own visibility rule. An empty calendar says so rather than filling itself
 * with examples.
 */
@Composable
internal fun CalendarPage(onClose: () -> Unit) {
    val context = LocalContext.current
    var entries by remember { mutableStateOf<List<CalendarEntryDto>?>(null) }
    var failed by remember { mutableStateOf(false) }

    LaunchedEffect(Unit) {
        runCatching { Api.listCalendar(context) }
            .onSuccess { entries = it }
            // A failed load is not an empty calendar, and saying "nothing scheduled" here
            // would be a lie the student might act on.
            .onFailure { failed = true }
    }

    OverlayScaffold(title = "Calendar", onClose = onClose) {
        Column(Modifier.fillMaxSize().padding(horizontal = 18.dp)) {
            when {
                failed -> EmptyState(
                    Icons.Filled.DateRange, Tone.Amber, "Your calendar could not be loaded",
                    "Check your connection and try again.")
                entries == null -> LoadingSpinner()
                entries!!.isEmpty() -> EmptyState(
                    Icons.Filled.DateRange, Tone.Violet, "Nothing scheduled",
                    "Interviews, exam windows and anything your institution assigns you will appear here.")
                else -> {
                    val grouped = entries!!.groupBy { dayOf(it.startsAt) }
                    LazyColumn(Modifier.fillMaxSize()) {
                        grouped.forEach { (day, dayEntries) ->
                            item(key = "day-$day") {
                                Spacer(Modifier.height(16.dp))
                                Text(day, style = MaterialTheme.typography.titleSmall, fontWeight = FontWeight.SemiBold)
                            }
                            items(dayEntries.size, key = { index -> dayEntries[index].kind + "-" + dayEntries[index].id }) { index ->
                                val entry = dayEntries[index]
                                Spacer(Modifier.height(10.dp))
                                PilotCard {
                                    Column(Modifier.padding(16.dp)) {
                                        Row(Modifier.fillMaxWidth(), verticalAlignment = Alignment.Top) {
                                            Column(Modifier.weight(1f)) {
                                                Text(entry.title, style = MaterialTheme.typography.bodyMedium, fontWeight = FontWeight.SemiBold)
                                                Text(timeRange(entry), style = MaterialTheme.typography.bodySmall,
                                                    color = MaterialTheme.colorScheme.onSurfaceVariant)
                                            }
                                            StatusChip(kindLabel(entry.kind), chipFor(entry.kind))
                                        }
                                        entry.detail?.takeIf { it.isNotBlank() }?.let {
                                            Spacer(Modifier.height(6.dp))
                                            Text(it, style = MaterialTheme.typography.bodySmall,
                                                color = MaterialTheme.colorScheme.onSurfaceVariant)
                                        }
                                        entry.location?.takeIf { it.isNotBlank() }?.let {
                                            Spacer(Modifier.height(4.dp))
                                            Text(it, style = MaterialTheme.typography.bodySmall,
                                                color = MaterialTheme.colorScheme.onSurfaceVariant)
                                        }
                                    }
                                }
                            }
                        }
                        item { Spacer(Modifier.height(24.dp)) }
                    }
                }
            }
        }
    }
}

private val dayFormat = DateTimeFormatter.ofPattern("EEEE d MMMM")
private val timeFormat = DateTimeFormatter.ofPattern("HH:mm")

private fun dayOf(iso: String): String =
    runCatching { Instant.parse(iso).atZone(ZoneId.systemDefault()).format(dayFormat) }.getOrDefault("Scheduled")

/** A deadline is a moment: showing a range would invent a duration nobody recorded. */
private fun timeRange(entry: CalendarEntryDto): String {
    val start = runCatching { Instant.parse(entry.startsAt).atZone(ZoneId.systemDefault()).format(timeFormat) }
        .getOrDefault("")
    val end = entry.endsAt
        ?.takeIf { it != entry.startsAt }
        ?.let { runCatching { Instant.parse(it).atZone(ZoneId.systemDefault()).format(timeFormat) }.getOrNull() }
    return if (end == null) start else "$start – $end"
}

private fun kindLabel(kind: String): String = when (kind) {
    "INTERVIEW" -> "Interview"
    "EXAM" -> "Exam"
    "MEETING" -> "Meeting"
    "ROADMAP" -> "Next step"
    else -> "Task"
}

private fun chipFor(kind: String): ChipKind = when (kind) {
    "INTERVIEW" -> ChipKind.Accent
    "EXAM" -> ChipKind.Waiting
    "ROADMAP" -> ChipKind.Muted
    else -> ChipKind.Positive
}
