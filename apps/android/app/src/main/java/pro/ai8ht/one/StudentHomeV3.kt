package pro.ai8ht.one

import androidx.compose.foundation.clickable
import androidx.compose.foundation.horizontalScroll
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.width
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.verticalScroll
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.filled.Assignment
import androidx.compose.material.icons.filled.AutoAwesome
import androidx.compose.material.icons.filled.CheckCircle
import androidx.compose.material.icons.filled.Description
import androidx.compose.material.icons.filled.Insights
import androidx.compose.material.icons.filled.MenuBook
import androidx.compose.material.icons.filled.Notifications
import androidx.compose.material.icons.filled.Person
import androidx.compose.material.icons.filled.WorkOutline
import androidx.compose.material3.Icon
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.Text
import androidx.compose.material3.TextButton
import androidx.compose.runtime.Composable
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.unit.dp
import java.time.Instant
import pro.ai8ht.one.ui.Tone

/**
 * The pilot dashboard's composition on the student Home, stacked for a phone:
 * Career Readiness Score (NA/100 + real band), category rings (NA), Today's
 * Plan (rule-derived from live account state), Continue Learning (real),
 * Upcoming (real windows), streak + weekly progress (real activity engine),
 * Quick Actions, Recent Activity (real notifications), Badges (NA).
 */
@Composable
internal fun PilotHomeScreen(
    data: StudentData,
    activity: StudentActivityDto?,
    onOpen: (Screen) -> Unit,
    onInbox: () -> Unit,
    onChat: () -> Unit,
    onSection: (MoreDest) -> Unit,
) {
    val now = Instant.now()
    val lessons = data.learner?.catalog?.modules?.flatMap { it.lessons } ?: emptyList()
    val completed = data.learner?.progress?.count { it.state == "COMPLETED" } ?: 0
    val nextLesson = lessons.firstOrNull { lesson -> data.learner?.progress?.none { it.lessonVersionId == lesson.id && it.state == "COMPLETED" } ?: true }
    val lessonPercent = if (lessons.isEmpty()) 0 else (completed * 100) / lessons.size
    val band = data.learner?.readiness?.band
    val unread = data.notifications?.unreadCount ?: 0
    val openExams = data.assessments.filter { exam ->
        exam.openAttemptId != null || (exam.attemptsUsed < exam.attemptsAllowed &&
            runCatching { now.isAfter(Instant.parse(exam.startsAt)) && now.isBefore(Instant.parse(exam.endsAt)) }.getOrDefault(false))
    }
    val upcoming = data.assessments
        .filter { runCatching { now.isBefore(Instant.parse(it.endsAt)) }.getOrDefault(false) }
        .sortedBy { it.endsAt }
        .take(3)
    val recent = data.notifications?.notifications?.take(4) ?: emptyList()
    val modules = data.learner?.catalog?.modules ?: emptyList()

    Column(Modifier.fillMaxSize().verticalScroll(rememberScrollState()).padding(horizontal = 18.dp)) {
        Spacer(Modifier.height(12.dp))

        // Career Readiness Score - the pilot's lead card. NA until the scoring
        // engine exists; the advisory band is real.
        // A band, never a number.
        //
        // This card read "Career Readiness Score  NA/100" beside a ring labelled SCORE,
        // which is the pilot picture drawn before the domain was modelled. ADR-020
        // settled it the other way: readiness is a four-value advisory band, the
        // database refuses to store it as anything else, and a /100 presents a score
        // that merely happens to be missing. The band below is real data.
        PilotCard(glow = true) {
            Row(Modifier.padding(16.dp), verticalAlignment = Alignment.CenterVertically) {
                Column(Modifier.weight(1f)) {
                    Text("Career readiness", style = MaterialTheme.typography.labelMedium,
                        color = MaterialTheme.colorScheme.onSurfaceVariant)
                    Spacer(Modifier.height(6.dp))
                    Text(
                        band?.let { prettify(it) } ?: "Not enough evidence yet",
                        style = MaterialTheme.typography.headlineSmall,
                        fontWeight = FontWeight.Bold,
                    )
                    Spacer(Modifier.height(6.dp))
                    Text(
                        if (band == null) {
                            "Complete a lesson or an assessment and this starts to move."
                        } else {
                            "Advisory guidance for you and your college. Employers never see it."
                        },
                        style = MaterialTheme.typography.bodySmall,
                        color = MaterialTheme.colorScheme.onSurfaceVariant,
                    )
                    Spacer(Modifier.height(8.dp))
                    TextButton(onClick = { onSection(MoreDest.Career) }) { Text("What this means") }
                }
            }
        }

        // Per-topic mastery, from projections the server was already returning.
        val masteryByTopic = data.learner?.mastery.orEmpty()
        val topicNames = data.learner?.catalog?.topics.orEmpty().associate { it.id to it.name }
        if (masteryByTopic.isNotEmpty()) {
            SectionTitle("Where you stand")
            Row(Modifier.horizontalScroll(rememberScrollState()), horizontalArrangement = Arrangement.spacedBy(10.dp)) {
                masteryByTopic.forEach { entry ->
                    TopicBandCard(
                        label = topicNames[entry.topicId] ?: "Topic",
                        band = entry.band,
                        modifier = Modifier.width(132.dp),
                    )
                }
            }
        }

        // Today's Plan - rule-derived from live account state.
        SectionTitle("Today's Plan")
        PilotCard {
            Column(Modifier.padding(vertical = 6.dp)) {
                val plan = buildList {
                    openExams.take(2).forEach { exam ->
                        add(Triple(if (exam.openAttemptId != null) "Resume ${exam.title}" else "Attempt ${exam.title}",
                            "${exam.durationSeconds / 60} min", Screen.Assessments))
                    }
                    if (nextLesson != null) add(Triple("Complete lesson: ${nextLesson.title}", "—", Screen.Learning))
                    if (lessons.isNotEmpty() && completed == lessons.size) add(Triple("All lessons completed — review your readiness", "—", Screen.Home))
                }.take(4)
                if (plan.isEmpty()) {
                    Text("Nothing due right now.", Modifier.padding(14.dp),
                        style = MaterialTheme.typography.bodySmall, color = MaterialTheme.colorScheme.onSurfaceVariant)
                } else {
                    plan.forEach { (title, minutes, target) ->
                        Row(Modifier.fillMaxWidth().clickable {
                            if (target == Screen.Home) onSection(MoreDest.Career) else onOpen(target)
                        }.padding(horizontal = 14.dp, vertical = 9.dp), verticalAlignment = Alignment.CenterVertically) {
                            Icon(Icons.Filled.CheckCircle, null, tint = MaterialTheme.colorScheme.outline)
                            Spacer(Modifier.width(10.dp))
                            Text(title, Modifier.weight(1f), style = MaterialTheme.typography.bodyMedium, fontWeight = FontWeight.SemiBold)
                            Text(minutes, style = MaterialTheme.typography.labelSmall,
                                color = MaterialTheme.colorScheme.onSurfaceVariant)
                        }
                    }
                }
            }
        }

        // Continue Learning - real module progress.
        SectionTitle("Continue Learning")
        PilotCard(Modifier.clickable { onOpen(Screen.Learning) }) {
            Column(Modifier.padding(14.dp)) {
                Row(verticalAlignment = Alignment.CenterVertically) {
                    IconBubble(Icons.Filled.MenuBook, Tone.Violet)
                    Spacer(Modifier.width(12.dp))
                    Column(Modifier.weight(1f)) {
                        Text(modules.firstOrNull()?.title ?: "NA", style = MaterialTheme.typography.bodyMedium, fontWeight = FontWeight.SemiBold)
                        Text(nextLesson?.title ?: if (lessons.isNotEmpty()) "All lessons completed" else "No lessons assigned yet",
                            style = MaterialTheme.typography.bodySmall, color = MaterialTheme.colorScheme.onSurfaceVariant)
                    }
                    Text("$lessonPercent%", style = MaterialTheme.typography.titleSmall, fontWeight = FontWeight.Bold)
                }
            }
        }

        // Streak + weekly progress - the real activity engine.
        SectionTitle("Your week")
        PilotCard {
            Column(Modifier.padding(14.dp)) {
                Row(verticalAlignment = Alignment.CenterVertically) {
                    Text("🔥 ${activity?.currentStreakDays ?: 0} Day Streak", style = MaterialTheme.typography.bodyMedium, fontWeight = FontWeight.SemiBold)
                    Spacer(Modifier.weight(1f))
                    StatusChip("${activity?.activeDaysLast7 ?: 0}/7 days", ChipKind.Accent)
                }
                Spacer(Modifier.height(10.dp))
                StreakDots(
                    active = (activity?.last7 ?: List(7) { ActivityDayDto() }).map { it.count > 0 },
                    letters = (activity?.last7 ?: emptyList()).map { day ->
                        runCatching { java.time.LocalDate.parse(day.date).dayOfWeek.name.take(1) }.getOrDefault("·")
                    },
                )
                Spacer(Modifier.height(12.dp))
                WeekSpark(points = (activity?.last7 ?: emptyList()).map { it.count }.ifEmpty { List(7) { 0 } })
            }
        }

        // Upcoming - real exam windows, laptop-only.
        SectionTitle("Upcoming")
        if (upcoming.isEmpty()) {
            PilotCard { Text("NA — no scheduled windows.", Modifier.padding(14.dp),
                style = MaterialTheme.typography.bodySmall, color = MaterialTheme.colorScheme.onSurfaceVariant) }
        } else {
            upcoming.forEach { exam ->
                PilotCard(Modifier.fillMaxWidth().padding(bottom = 8.dp).clickable { onOpen(Screen.Assessments) }) {
                    Row(Modifier.padding(12.dp), verticalAlignment = Alignment.CenterVertically) {
                        IconBubble(Icons.Filled.Assignment, Tone.Accent)
                        Spacer(Modifier.width(12.dp))
                        Column(Modifier.weight(1f)) {
                            Text(exam.title, style = MaterialTheme.typography.bodyMedium, fontWeight = FontWeight.SemiBold)
                            Text("Closes ${formatWhen(exam.endsAt)} · ${exam.durationSeconds / 60} min · laptop only",
                                style = MaterialTheme.typography.bodySmall, color = MaterialTheme.colorScheme.onSurfaceVariant)
                        }
                    }
                }
            }
        }

        // Quick Actions - same purpose as the pilot's grid.
        SectionTitle("Quick Actions")
        Row(horizontalArrangement = Arrangement.spacedBy(10.dp)) {
            QuickTile(Icons.Filled.Assignment, Tone.Accent, "Exams", Modifier.weight(1f)) { onOpen(Screen.Assessments) }
            QuickTile(Icons.Filled.MenuBook, Tone.Green, "Learning", Modifier.weight(1f)) { onOpen(Screen.Learning) }
            QuickTile(Icons.Filled.WorkOutline, Tone.Violet, "Jobs", Modifier.weight(1f)) { onOpen(Screen.Jobs) }
            QuickTile(Icons.Filled.AutoAwesome, Tone.Amber, "Assistant", Modifier.weight(1f)) { onChat() }
        }
        Spacer(Modifier.height(10.dp))
        Row(horizontalArrangement = Arrangement.spacedBy(10.dp)) {
            QuickTile(Icons.Filled.Notifications, Tone.Amber, "Inbox", Modifier.weight(1f), badge = unread) { onInbox() }
            QuickTile(Icons.Filled.Person, Tone.Accent, "Profile", Modifier.weight(1f)) { onSection(MoreDest.Profile) }
            QuickTile(Icons.Filled.Description, Tone.Violet, "Documents", Modifier.weight(1f)) { onSection(MoreDest.Documents) }
            QuickTile(Icons.Filled.Insights, Tone.Green, "Readiness", Modifier.weight(1f)) { onSection(MoreDest.Career) }
        }

        // Recent Activity - real notifications.
        SectionTitle("Recent Activity", trailing = "View all", onTrailing = onInbox)
        PilotCard {
            Column(Modifier.padding(vertical = 4.dp)) {
                if (recent.isEmpty()) {
                    Text("NA — no activity recorded yet.", Modifier.padding(14.dp),
                        style = MaterialTheme.typography.bodySmall, color = MaterialTheme.colorScheme.onSurfaceVariant)
                } else {
                    recent.forEach { note ->
                        Row(Modifier.fillMaxWidth().padding(horizontal = 14.dp, vertical = 8.dp), verticalAlignment = Alignment.CenterVertically) {
                            IconBubble(Icons.Filled.Insights, Tone.Green)
                            Spacer(Modifier.width(10.dp))
                            Text(note.title, Modifier.weight(1f), style = MaterialTheme.typography.bodySmall, fontWeight = FontWeight.SemiBold)
                        }
                    }
                }
            }
        }

        // Badges - NA until a badge engine exists.
        SectionTitle("Badges Earned")
        PilotCard {
            Row(Modifier.padding(14.dp), horizontalArrangement = Arrangement.spacedBy(16.dp)) {
                repeat(4) {
                    Column(horizontalAlignment = Alignment.CenterHorizontally, modifier = Modifier.weight(1f)) {
                        IconBubble(Icons.Filled.AutoAwesome, Tone.Gray)
                        Spacer(Modifier.height(4.dp))
                        Text("NA", style = MaterialTheme.typography.labelSmall,
                            color = MaterialTheme.colorScheme.onSurfaceVariant)
                    }
                }
            }
        }

        Spacer(Modifier.height(90.dp))
    }
}
