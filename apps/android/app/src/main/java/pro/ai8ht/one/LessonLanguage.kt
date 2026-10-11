package pro.ai8ht.one

/*
 * Lesson languages on the phone (ENG-16) — the same choice and the same notices as the web's
 * Learning page. A student picks the language lessons are shown in; a lesson with no published
 * version in it is shown in English and says so, and one whose English was revised after its
 * translation says that too. Telugu text uses the bundled Noto Sans Telugu. Completing a lesson
 * counts the same in any language: the server keeps every lesson's id whatever the words.
 */

import androidx.compose.foundation.horizontalScroll
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.width
import androidx.compose.foundation.rememberScrollState
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.filled.Translate
import androidx.compose.material3.FilterChip
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.rememberCoroutineScope
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.unit.dp
import kotlinx.coroutines.launch
import pro.ai8ht.one.ui.Tone
import pro.ai8ht.one.ui.lessonFontFamily

/** How a language is named to the student: its own script, then English. */
internal fun lessonLanguageLabel(option: LessonLanguageOptionDto): String =
    if (option.nativeName.isBlank() || option.nativeName == option.name) option.name.ifBlank { option.language }
    else "${option.nativeName} · ${option.name}"

/** The English name of the learner's chosen language. */
internal fun chosenLessonLanguageName(choice: LessonLanguageDto?): String =
    choice?.offered?.firstOrNull { it.language == choice.selected }?.name?.ifBlank { null } ?: "English"

/** The notice under a lesson that is not in the chosen language, or null. */
internal fun lessonLanguageNotice(lesson: LessonDto, choice: LessonLanguageDto?): String? = when (lesson.languageNotice) {
    "TRANSLATION_MISSING" -> "Not yet available in ${chosenLessonLanguageName(choice)}. Shown in English."
    "TRANSLATION_OUTDATED" -> "The English lesson was updated after this ${chosenLessonLanguageName(choice)} version was written. Choose English to read the latest."
    else -> null
}

@Composable
internal fun LessonLanguageCard(choice: LessonLanguageDto, onChanged: () -> Unit) {
    val context = LocalContext.current
    val scope = rememberCoroutineScope()
    var busy by remember { mutableStateOf(false) }
    var message by remember { mutableStateOf<String?>(null) }
    PilotCard {
        Column(Modifier.padding(14.dp)) {
            Row(verticalAlignment = Alignment.CenterVertically) {
                IconBubble(Icons.Filled.Translate, Tone.Accent, size = 36.dp)
                Spacer(Modifier.width(10.dp))
                Column(Modifier.weight(1f)) {
                    Text("Lesson language", style = MaterialTheme.typography.bodyMedium, fontWeight = FontWeight.SemiBold)
                    Text("A lesson with no published version in your language is shown in English, and says so.",
                        style = MaterialTheme.typography.bodySmall, color = MaterialTheme.colorScheme.onSurfaceVariant)
                }
            }
            Spacer(Modifier.height(8.dp))
            Row(Modifier.horizontalScroll(rememberScrollState()), horizontalArrangement = Arrangement.spacedBy(8.dp)) {
                choice.offered.forEach { option ->
                    FilterChip(
                        selected = option.language == choice.selected,
                        enabled = !busy,
                        onClick = {
                            if (option.language == choice.selected) return@FilterChip
                            busy = true
                            message = null
                            scope.launch {
                                runCatching { Api.setLessonLanguage(context, option.language) }
                                    .onSuccess { busy = false; onChanged() }
                                    .onFailure { busy = false; message = "The lesson language could not be changed. Your lessons are unchanged." }
                            }
                        },
                        label = { Text(lessonLanguageLabel(option), fontFamily = lessonFontFamily(option.language)) },
                    )
                }
            }
            message?.let {
                Spacer(Modifier.height(6.dp))
                Text(it, style = MaterialTheme.typography.bodySmall, color = MaterialTheme.colorScheme.error)
            }
        }
    }
}

/** A lesson's title, summary and language notice, in the font its language needs. */
@Composable
internal fun LessonWords(lesson: LessonDto, choice: LessonLanguageDto?, modifier: Modifier = Modifier) {
    val font = lessonFontFamily(lesson.language)
    Column(modifier) {
        Text(lesson.title, style = MaterialTheme.typography.bodyMedium, fontFamily = font)
        lesson.body.summary?.takeIf { it.isNotBlank() }?.let {
            Text(it, style = MaterialTheme.typography.bodySmall, fontFamily = font, color = MaterialTheme.colorScheme.onSurfaceVariant)
        }
        lessonLanguageNotice(lesson, choice)?.let {
            Spacer(Modifier.height(2.dp))
            StatusChip(it, ChipKind.Waiting)
        }
    }
}
