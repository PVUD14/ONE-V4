package pro.ai8ht.one

import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.lazy.LazyColumn
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.filled.MenuBook
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.setValue
import androidx.compose.ui.Modifier
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.unit.dp
import pro.ai8ht.one.ui.Tone

/**
 * Published learner content on the phone.
 *
 * The web app splits this across five pilot-exact pages -- Practice, Company Prep, Career
 * Tools, Scholarships, Resume Builder -- which exist there for visual parity with the
 * pilot. The phone has no such pages, so rather than inventing five of them this gathers
 * the same published content into one list grouped by area.
 *
 * Nothing is published today, so this screen says so. It is not filled with examples.
 */
private val AREAS = listOf(
    "PRACTICE" to "Practice",
    "COMPANY_PREP" to "Company prep",
    "CAREER_TOOL" to "Career tools",
    "SCHOLARSHIP" to "Scholarships",
    "RESUME_BUILDER" to "Resume",
)

@Composable
internal fun ResourcesPage(onClose: () -> Unit) {
    val context = LocalContext.current
    var grouped by remember { mutableStateOf<List<Pair<String, List<LearnerContentItemDto>>>?>(null) }
    var failed by remember { mutableStateOf(false) }

    LaunchedEffect(Unit) {
        runCatching {
            AREAS.map { (code, label) -> label to Api.listLearnerContent(context, code) }
                .filter { it.second.isNotEmpty() }
        }.onSuccess { grouped = it }
            // A failed load is not an empty library, and saying "nothing yet" would be a
            // lie the student might act on.
            .onFailure { failed = true }
    }

    OverlayScaffold(title = "Resources", onClose = onClose) {
        Column(Modifier.fillMaxSize().padding(horizontal = 18.dp)) {
            when {
                failed -> EmptyState(
                    Icons.Filled.MenuBook, Tone.Amber, "Resources could not be loaded",
                    "Check your connection and try again.")
                grouped == null -> LoadingSpinner()
                grouped!!.isEmpty() -> EmptyState(
                    Icons.Filled.MenuBook, Tone.Violet, "No resources published yet",
                    "Practice material, company preparation, career tools, scholarships and resume guidance appear here once they are published.")
                else -> LazyColumn(Modifier.fillMaxSize()) {
                    grouped!!.forEach { (label, items) ->
                        item(key = "head-$label") {
                            Spacer(Modifier.height(16.dp))
                            Text(label, style = MaterialTheme.typography.titleSmall, fontWeight = FontWeight.SemiBold)
                        }
                        items(items.size, key = { index -> items[index].id }) { index ->
                            val item = items[index]
                            Spacer(Modifier.height(10.dp))
                            PilotCard {
                                Column(Modifier.padding(16.dp)) {
                                    Text(item.title, style = MaterialTheme.typography.bodyMedium, fontWeight = FontWeight.SemiBold)
                                    item.summary?.takeIf { it.isNotBlank() }?.let {
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
