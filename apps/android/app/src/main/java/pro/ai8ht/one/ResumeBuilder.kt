package pro.ai8ht.one

import android.content.Context
import android.content.Intent
import android.net.Uri
import androidx.activity.compose.rememberLauncherForActivityResult
import androidx.activity.result.contract.ActivityResultContracts
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
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.foundation.verticalScroll
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.filled.Description
import androidx.compose.material3.Button
import androidx.compose.material3.Checkbox
import androidx.compose.material3.FilterChip
import androidx.compose.material3.HorizontalDivider
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.OutlinedButton
import androidx.compose.material3.OutlinedTextField
import androidx.compose.material3.Text
import androidx.compose.material3.TextButton
import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableIntStateOf
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.rememberCoroutineScope
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.unit.dp
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.launch
import kotlinx.coroutines.withContext
import kotlinx.serialization.Serializable
import kotlinx.serialization.encodeToString
import kotlinx.serialization.json.Json
import kotlinx.serialization.json.JsonObject
import pro.ai8ht.one.ui.Tone

/**
 * The résumé generator on the phone (RESUME-GEN), matching the web Résumé Builder.
 *
 * The student ticks items from their own ONE record — each shown with the label the server gave it, "Verified
 * by <college>" only where a college verified it — writes their own summary and projects, picks one of three
 * templates, previews the sections the server resolved, saves a version, and saves the PDF through the system
 * file picker, from which it can be shared. It opens from Documents rather than a new menu item (navigation
 * is not added to). No readiness, band, score, stage or mastery is in these types or on these screens; the
 * Resume checks are passed-or-not, never a number. Design: docs/architecture/student-resumes-table-design.md.
 */

@Serializable data class ResumeTermSourceDto(val id: String, val label: String, val result: String, val verification: String, val verified: Boolean = false)
@Serializable data class ResumeQualificationSourceDto(
    val id: String, val title: String, val institution: String? = null, val period: String? = null,
    val verification: String, val verified: Boolean = false, val terms: List<ResumeTermSourceDto> = emptyList(),
)
@Serializable data class ResumeSkillSourceDto(val topicId: String, val name: String, val basis: String)
@Serializable data class ResumeCertificateSourceDto(val id: String, val title: String, val description: String? = null, val verification: String)
@Serializable data class ResumeTargetSourceDto(val id: String, val roleTitle: String)
@Serializable data class ResumeHeaderSourceDto(val fullName: String? = null, val email: String? = null, val headline: String? = null, val summary: String? = null, val portfolioUrl: String? = null)
@Serializable data class ResumeSourcesDto(
    val header: ResumeHeaderSourceDto = ResumeHeaderSourceDto(),
    val qualifications: List<ResumeQualificationSourceDto> = emptyList(),
    val skills: List<ResumeSkillSourceDto> = emptyList(),
    val certificates: List<ResumeCertificateSourceDto> = emptyList(),
    val careerTargets: List<ResumeTargetSourceDto> = emptyList(),
)
@Serializable data class ResumeTemplateDto(val key: String, val name: String, val description: String = "")
@Serializable private data class ResumeSourcesEnvelope(val sources: ResumeSourcesDto = ResumeSourcesDto(), val templates: List<ResumeTemplateDto> = emptyList())

@Serializable data class ResumeLinkDto(val label: String? = null, val url: String)
@Serializable data class ResumeProjectDto(val title: String, val description: String? = null, val url: String? = null)
@Serializable data class ResumeHeaderDraftDto(
    val fullName: String? = null, val headline: String? = null, val phone: String? = null, val location: String? = null,
    val showEmail: Boolean = true, val links: List<ResumeLinkDto> = emptyList(),
)
@Serializable data class ResumeDraftDto(
    val title: String = "My résumé",
    val template: String = "CLASSIC",
    val header: ResumeHeaderDraftDto = ResumeHeaderDraftDto(),
    val summary: String? = null,
    val qualificationIds: List<String> = emptyList(),
    val termIds: List<String> = emptyList(),
    val skillTopicIds: List<String> = emptyList(),
    val certificateIds: List<String> = emptyList(),
    val careerTargetIds: List<String> = emptyList(),
    val declaredSkills: List<String> = emptyList(),
    val projects: List<ResumeProjectDto> = emptyList(),
    val languages: List<String> = emptyList(),
)

@Serializable data class ResumeResultLineDto(val label: String, val result: String, val verification: String, val verified: Boolean = false)
@Serializable data class ResumeEducationDto(
    val title: String, val institution: String? = null, val period: String? = null, val status: String? = null,
    val verification: String, val verified: Boolean = false, val results: List<ResumeResultLineDto> = emptyList(),
)
@Serializable data class ResumeShownSkillDto(val name: String, val basis: String)
@Serializable data class ResumeSkillsDto(val shown: List<ResumeShownSkillDto> = emptyList(), val declared: List<String> = emptyList())
@Serializable data class ResumeCertificateDto(val title: String, val description: String? = null, val verification: String)
@Serializable data class ResumeContentHeaderDto(
    val fullName: String? = null, val headline: String? = null, val email: String? = null, val phone: String? = null,
    val location: String? = null, val links: List<ResumeLinkDto> = emptyList(),
)
@Serializable data class ResumeContentDto(
    val template: String = "CLASSIC",
    val header: ResumeContentHeaderDto = ResumeContentHeaderDto(),
    val summary: String? = null,
    val objective: List<String> = emptyList(),
    val education: List<ResumeEducationDto> = emptyList(),
    val skills: ResumeSkillsDto = ResumeSkillsDto(),
    val projects: List<ResumeProjectDto> = emptyList(),
    val certificates: List<ResumeCertificateDto> = emptyList(),
    val languages: List<String> = emptyList(),
    val legend: String = "",
    val generatedOn: String = "",
)
@Serializable data class ResumeCheckDto(val key: String, val passed: Boolean, val message: String)
@Serializable data class ResumePreviewDto(val content: ResumeContentDto, val checks: List<ResumeCheckDto> = emptyList())
@Serializable data class ResumeSummaryDto(
    val id: String, val title: String, val latestVersion: Int = 1, val template: String = "CLASSIC",
    val latestSavedAt: String? = null, val versionCount: Int = 1,
)
@Serializable private data class ResumeListEnvelope(val resumes: List<ResumeSummaryDto> = emptyList())
@Serializable data class ResumeLatestDto(val versionNumber: Int, val template: String = "CLASSIC", val selections: JsonObject? = null)
@Serializable data class ResumeDetailDto(val id: String, val title: String, val latest: ResumeLatestDto? = null)
@Serializable private data class ResumeDetailEnvelope(val resume: ResumeDetailDto)

private val resumeJson = Json { ignoreUnknownKeys = true; encodeDefaults = true; explicitNulls = true }

suspend fun Api.resumeSources(context: Context): Pair<ResumeSourcesDto, List<ResumeTemplateDto>> =
    resumeJson.decodeFromString<ResumeSourcesEnvelope>(request(context, "GET", "/api/v1/students/me/resume-sources")).let { it.sources to it.templates }

suspend fun Api.previewResume(context: Context, draft: ResumeDraftDto): ResumePreviewDto =
    resumeJson.decodeFromString(request(context, "POST", "/api/v1/students/me/resumes/preview", resumeJson.encodeToString(draft)))

suspend fun Api.listResumes(context: Context): List<ResumeSummaryDto> =
    resumeJson.decodeFromString<ResumeListEnvelope>(request(context, "GET", "/api/v1/students/me/resumes")).resumes

/** The latest version's choices, so an edit starts where the student left off. */
suspend fun Api.resumeDraft(context: Context, resumeId: String): ResumeDraftDto? =
    resumeJson.decodeFromString<ResumeDetailEnvelope>(request(context, "GET", "/api/v1/students/me/resumes/$resumeId")).resume.latest?.selections
        ?.let { resumeJson.decodeFromJsonElement(ResumeDraftDto.serializer(), it) }

suspend fun Api.saveResume(context: Context, resumeId: String?, draft: ResumeDraftDto): ResumeDetailDto =
    resumeJson.decodeFromString<ResumeDetailEnvelope>(request(context, "POST",
        if (resumeId == null) "/api/v1/students/me/resumes" else "/api/v1/students/me/resumes/$resumeId/versions",
        resumeJson.encodeToString(draft))).resume

suspend fun Api.deleteResume(context: Context, resumeId: String) {
    request(context, "DELETE", "/api/v1/students/me/resumes/$resumeId")
}

suspend fun Api.resumePdf(context: Context, resumeId: String, version: Int): ByteArray =
    requestBytes(context, "/api/v1/students/me/resumes/$resumeId/versions/$version/pdf")

/** A first draft from the record: education, shown skills and certificates ticked; results and objective not. */
internal fun defaultResumeDraft(sources: ResumeSourcesDto): ResumeDraftDto = ResumeDraftDto(
    header = ResumeHeaderDraftDto(
        fullName = sources.header.fullName, headline = sources.header.headline, showEmail = true,
        links = sources.header.portfolioUrl?.let { listOf(ResumeLinkDto("Portfolio", it)) } ?: emptyList(),
    ),
    summary = sources.header.summary,
    qualificationIds = sources.qualifications.map { it.id },
    skillTopicIds = sources.skills.map { it.topicId },
    certificateIds = sources.certificates.map { it.id },
)

private fun pdfName(title: String, version: Int): String {
    val base = title.replace(Regex("[^A-Za-z0-9 _-]"), "").trim().replace(Regex("\\s+"), "-").take(60).ifBlank { "resume" }
    return "$base-v$version.pdf"
}

private fun resumeError(error: Throwable, fallback: String): String {
    val api = error as? Api.ApiException
    return when {
        api?.status == 429 -> "You have reached a limit (20 résumés, 50 versions each, 30 saves or 60 PDFs an hour). Try again later."
        api?.status == 400 && api.code == "INVALID_PHONE" -> "Check the phone number."
        api?.status == 400 && api.code == "INVALID_URL" -> "Links must start with https://."
        api?.status == 400 && api.code == "PROJECT_TITLE_REQUIRED" -> "Each project needs a title."
        api?.status == 400 && api.code == "TITLE_REQUIRED" -> "Give the résumé a title."
        api?.status == 400 -> "Some text cannot go on a résumé. Check it and try again."
        else -> fallback
    }
}

private fun splitList(text: String): List<String> = text.split(',').map { it.trim() }.filter { it.isNotEmpty() }

/** The entry on the Documents screen. */
@Composable
internal fun ResumeBuilderEntryCard(onOpen: () -> Unit) {
    PilotCard {
        Row(Modifier.fillMaxWidth().padding(16.dp), verticalAlignment = Alignment.CenterVertically) {
            IconBubble(Icons.Filled.Description, Tone.Accent)
            Spacer(Modifier.width(12.dp))
            Column(Modifier.weight(1f)) {
                Text("Résumé builder", style = MaterialTheme.typography.titleSmall, fontWeight = FontWeight.Bold)
                Text("Generate a PDF résumé from your ONE record. Verified items name the college that verified them.",
                    style = MaterialTheme.typography.bodySmall, color = MaterialTheme.colorScheme.onSurfaceVariant)
            }
            Spacer(Modifier.width(8.dp))
            Button(onClick = onOpen, shape = RoundedCornerShape(10.dp)) { Text("Open") }
        }
    }
}

@Composable
private fun VerificationChip(label: String, verified: Boolean) {
    StatusChip(label, when {
        verified -> ChipKind.Positive
        label.contains("pending") -> ChipKind.Waiting
        else -> ChipKind.Muted
    })
}

@Composable
internal fun ResumeBuilderPage(onClose: () -> Unit) {
    val context = LocalContext.current
    val scope = rememberCoroutineScope()
    var sources by remember { mutableStateOf<Pair<ResumeSourcesDto, List<ResumeTemplateDto>>?>(null) }
    var resumes by remember { mutableStateOf<List<ResumeSummaryDto>?>(null) }
    var failed by remember { mutableStateOf(false) }
    var reload by remember { mutableIntStateOf(0) }
    var notice by remember { mutableStateOf<String?>(null) }
    var editing by remember { mutableStateOf<Pair<String?, ResumeDraftDto>?>(null) }
    var pendingPdf by remember { mutableStateOf<ResumeSummaryDto?>(null) }
    var savedUri by remember { mutableStateOf<Uri?>(null) }

    LaunchedEffect(Unit) {
        runCatching { Api.resumeSources(context) }.onSuccess { sources = it }.onFailure { failed = true }
    }
    LaunchedEffect(reload) { resumes = runCatching { Api.listResumes(context) }.getOrNull() }

    val savePdf = rememberLauncherForActivityResult(ActivityResultContracts.CreateDocument("application/pdf")) { uri ->
        val target = pendingPdf
        pendingPdf = null
        if (uri == null || target == null) return@rememberLauncherForActivityResult
        notice = "Preparing the PDF…"
        scope.launch {
            runCatching {
                val bytes = Api.resumePdf(context, target.id, target.latestVersion)
                withContext(Dispatchers.IO) { context.contentResolver.openOutputStream(uri)?.use { it.write(bytes) } ?: error("no stream") }
            }.onSuccess { savedUri = uri; notice = "PDF saved." }
                .onFailure { notice = resumeError(it, "The PDF could not be saved. Try again.") }
        }
    }

    val draft = editing
    val loaded = sources
    if (draft != null && loaded != null) {
        ResumeEditor(
            sources = loaded.first, templates = loaded.second, resumeId = draft.first, initial = draft.second,
            onSaved = { editing = null; notice = "Résumé saved. Save the PDF below."; reload += 1 },
            onCancel = { editing = null },
        )
        return
    }

    OverlayScaffold("Résumé builder", onClose) {
        when {
            failed -> EmptyState(Icons.Filled.Description, Tone.Amber, "Your record could not be loaded",
                "A résumé cannot be generated just now. Check your connection and try again.")
            loaded == null -> LoadingSpinner()
            else -> Column(Modifier.fillMaxSize().verticalScroll(rememberScrollState()).padding(18.dp)) {
                run {
                    Button(onClick = { notice = null; editing = null to defaultResumeDraft(loaded.first) },
                        shape = RoundedCornerShape(10.dp), modifier = Modifier.fillMaxWidth()) { Text("New résumé from my record") }
                    notice?.let { Spacer(Modifier.height(8.dp)); Text(it, style = MaterialTheme.typography.bodySmall, fontWeight = FontWeight.SemiBold) }
                    savedUri?.let { uri ->
                        TextButton(onClick = {
                            val share = Intent(Intent.ACTION_SEND).setType("application/pdf").putExtra(Intent.EXTRA_STREAM, uri)
                                .addFlags(Intent.FLAG_GRANT_READ_URI_PERMISSION)
                            runCatching { context.startActivity(Intent.createChooser(share, "Share résumé")) }
                        }) { Text("Share the saved PDF") }
                    }
                    SectionTitle("My résumés", trailing = resumes?.size?.toString())
                    val list = resumes
                    when {
                        list == null -> Text("Loading…", style = MaterialTheme.typography.bodySmall)
                        list.isEmpty() -> Text("No generated résumés yet. Start one from your record above.",
                            style = MaterialTheme.typography.bodySmall, color = MaterialTheme.colorScheme.onSurfaceVariant)
                        else -> PilotCard {
                            Column(Modifier.padding(vertical = 4.dp)) {
                                list.forEachIndexed { index, resume ->
                                    Column(Modifier.fillMaxWidth().padding(horizontal = 16.dp, vertical = 12.dp)) {
                                        Text(resume.title, style = MaterialTheme.typography.bodyMedium, fontWeight = FontWeight.SemiBold)
                                        Text("${loaded.second.firstOrNull { it.key == resume.template }?.name ?: prettify(resume.template)} · version ${resume.latestVersion}" +
                                            (resume.latestSavedAt?.let { " · saved ${formatWhen(it)}" } ?: ""),
                                            style = MaterialTheme.typography.bodySmall, color = MaterialTheme.colorScheme.onSurfaceVariant)
                                        Row(Modifier.horizontalScroll(rememberScrollState()), horizontalArrangement = Arrangement.spacedBy(6.dp)) {
                                            TextButton(onClick = { pendingPdf = resume; savePdf.launch(pdfName(resume.title, resume.latestVersion)) }) { Text("Save PDF") }
                                            TextButton(onClick = {
                                                scope.launch {
                                                    runCatching { Api.resumeDraft(context, resume.id) }
                                                        .onSuccess { found -> if (found != null) editing = resume.id to found }
                                                        .onFailure { notice = resumeError(it, "That résumé could not be opened.") }
                                                }
                                            }) { Text("Edit") }
                                            TextButton(onClick = {
                                                scope.launch {
                                                    runCatching { Api.deleteResume(context, resume.id) }
                                                        .onSuccess { notice = "Résumé deleted."; reload += 1 }
                                                        .onFailure { notice = resumeError(it, "The résumé could not be deleted.") }
                                                }
                                            }) { Text("Delete") }
                                        }
                                    }
                                    if (index != list.lastIndex) HorizontalDivider(color = MaterialTheme.colorScheme.outline)
                                }
                            }
                        }
                    }
                    Spacer(Modifier.height(10.dp))
                    Text("ONE does not score résumés. Items verified by a college say so; everything else is marked self-declared.",
                        style = MaterialTheme.typography.labelSmall, color = MaterialTheme.colorScheme.onSurfaceVariant)
                    Spacer(Modifier.height(24.dp))
                }
            }
        }
    }
}

@Composable
private fun ResumeEditor(
    sources: ResumeSourcesDto,
    templates: List<ResumeTemplateDto>,
    resumeId: String?,
    initial: ResumeDraftDto,
    onSaved: () -> Unit,
    onCancel: () -> Unit,
) {
    val context = LocalContext.current
    val scope = rememberCoroutineScope()
    var draft by remember { mutableStateOf(initial) }
    var skillsText by remember { mutableStateOf(initial.declaredSkills.joinToString(", ")) }
    var languagesText by remember { mutableStateOf(initial.languages.joinToString(", ")) }
    var linkText by remember { mutableStateOf(initial.header.links.firstOrNull()?.url ?: "") }
    var preview by remember { mutableStateOf<ResumePreviewDto?>(null) }
    var notice by remember { mutableStateOf<String?>(null) }
    var busy by remember { mutableStateOf(false) }

    fun effective(): ResumeDraftDto = draft.copy(
        declaredSkills = splitList(skillsText), languages = splitList(languagesText),
        header = draft.header.copy(links = linkText.trim().takeIf { it.isNotEmpty() }?.let { url ->
            listOf(ResumeLinkDto(initial.header.links.firstOrNull()?.label ?: "Link", url)) + draft.header.links.drop(1)
        } ?: draft.header.links.drop(1)),
    )
    fun toggle(list: List<String>, id: String): List<String> = if (id in list) list - id else list + id
    fun blankToNull(text: String): String? = text.takeIf { it.isNotBlank() }

    OverlayScaffold(if (resumeId == null) "New résumé" else "New version", onCancel) {
        Column(Modifier.fillMaxSize().verticalScroll(rememberScrollState()).padding(18.dp)) {
            OutlinedTextField(draft.title, { draft = draft.copy(title = it.take(120)) }, label = { Text("Title (only you see it)") }, modifier = Modifier.fillMaxWidth(), singleLine = true)
            Spacer(Modifier.height(8.dp))
            Text("Template", style = MaterialTheme.typography.labelLarge, fontWeight = FontWeight.SemiBold)
            Row(Modifier.horizontalScroll(rememberScrollState()), horizontalArrangement = Arrangement.spacedBy(8.dp)) {
                templates.forEach { template ->
                    FilterChip(selected = draft.template == template.key, onClick = { draft = draft.copy(template = template.key) }, label = { Text(template.name) })
                }
            }
            templates.firstOrNull { it.key == draft.template }?.let {
                Text(it.description, style = MaterialTheme.typography.bodySmall, color = MaterialTheme.colorScheme.onSurfaceVariant)
            }

            SectionTitle("Header")
            OutlinedTextField(draft.header.fullName ?: "", { draft = draft.copy(header = draft.header.copy(fullName = blankToNull(it.take(160)))) }, label = { Text("Name") }, modifier = Modifier.fillMaxWidth(), singleLine = true)
            OutlinedTextField(draft.header.headline ?: "", { draft = draft.copy(header = draft.header.copy(headline = blankToNull(it.take(160)))) }, label = { Text("Headline") }, modifier = Modifier.fillMaxWidth(), singleLine = true)
            OutlinedTextField(draft.header.phone ?: "", { draft = draft.copy(header = draft.header.copy(phone = blankToNull(it.take(20)))) }, label = { Text("Phone (optional)") }, modifier = Modifier.fillMaxWidth(), singleLine = true)
            OutlinedTextField(draft.header.location ?: "", { draft = draft.copy(header = draft.header.copy(location = blankToNull(it.take(80)))) }, label = { Text("City (optional)") }, modifier = Modifier.fillMaxWidth(), singleLine = true)
            OutlinedTextField(linkText, { linkText = it.take(256) }, label = { Text("https:// link (optional)") }, modifier = Modifier.fillMaxWidth(), singleLine = true)
            CheckRow(draft.header.showEmail, "Show my email" + (sources.header.email?.let { " ($it)" } ?: "")) {
                draft = draft.copy(header = draft.header.copy(showEmail = !draft.header.showEmail))
            }

            SectionTitle("Summary")
            OutlinedTextField(draft.summary ?: "", { draft = draft.copy(summary = blankToNull(it.take(1200))) }, label = { Text("A few lines about you") }, modifier = Modifier.fillMaxWidth(), minLines = 3)

            SectionTitle("Education")
            if (sources.qualifications.isEmpty()) Text("No academic records yet — NA. Add them under Academic record; your college can verify them.", style = MaterialTheme.typography.bodySmall)
            sources.qualifications.forEach { q ->
                CheckRow(q.id in draft.qualificationIds, q.title, listOfNotNull(q.institution, q.period).joinToString(" · "), chip = { VerificationChip(q.verification, q.verified) }) {
                    draft = draft.copy(qualificationIds = toggle(draft.qualificationIds, q.id))
                }
                if (q.id in draft.qualificationIds) q.terms.forEach { t ->
                    Row(Modifier.padding(start = 24.dp)) {
                        CheckRow(t.id in draft.termIds, "${t.label} — ${t.result}", chip = { VerificationChip(t.verification, t.verified) }) {
                            draft = draft.copy(termIds = toggle(draft.termIds, t.id))
                        }
                    }
                }
            }

            SectionTitle("Skills")
            if (sources.skills.isEmpty()) Text("No skills shown in graded work yet — NA.", style = MaterialTheme.typography.bodySmall)
            sources.skills.forEach { s ->
                CheckRow(s.topicId in draft.skillTopicIds, s.name, s.basis) { draft = draft.copy(skillTopicIds = toggle(draft.skillTopicIds, s.topicId)) }
            }
            OutlinedTextField(skillsText, { skillsText = it }, label = { Text("Self-declared skills (comma-separated)") }, modifier = Modifier.fillMaxWidth())

            SectionTitle("Projects", trailing = "Self-declared")
            draft.projects.forEachIndexed { index, project ->
                OutlinedTextField(project.title, { value -> draft = draft.copy(projects = draft.projects.mapIndexed { at, item -> if (at == index) item.copy(title = value.take(120)) else item }) },
                    label = { Text("Project title") }, modifier = Modifier.fillMaxWidth(), singleLine = true)
                OutlinedTextField(project.description ?: "", { value -> draft = draft.copy(projects = draft.projects.mapIndexed { at, item -> if (at == index) item.copy(description = blankToNull(value.take(800))) else item }) },
                    label = { Text("What you did") }, modifier = Modifier.fillMaxWidth(), minLines = 2)
                OutlinedTextField(project.url ?: "", { value -> draft = draft.copy(projects = draft.projects.mapIndexed { at, item -> if (at == index) item.copy(url = blankToNull(value.take(256))) else item }) },
                    label = { Text("https:// link (optional)") }, modifier = Modifier.fillMaxWidth(), singleLine = true)
                TextButton(onClick = { draft = draft.copy(projects = draft.projects.filterIndexed { at, _ -> at != index }) }) { Text("Remove project") }
            }
            if (draft.projects.size < 10) OutlinedButton(onClick = { draft = draft.copy(projects = draft.projects + ResumeProjectDto("")) }, shape = RoundedCornerShape(10.dp)) { Text("Add a project") }

            SectionTitle("Certificates, objective, languages")
            sources.certificates.forEach { c ->
                CheckRow(c.id in draft.certificateIds, c.title, chip = { VerificationChip(c.verification, false) }) { draft = draft.copy(certificateIds = toggle(draft.certificateIds, c.id)) }
            }
            sources.careerTargets.forEach { t ->
                CheckRow(t.id in draft.careerTargetIds, "Career objective: ${t.roleTitle}") { draft = draft.copy(careerTargetIds = toggle(draft.careerTargetIds, t.id)) }
            }
            OutlinedTextField(languagesText, { languagesText = it }, label = { Text("Languages you speak (comma-separated)") }, modifier = Modifier.fillMaxWidth())

            Spacer(Modifier.height(14.dp))
            notice?.let { Text(it, style = MaterialTheme.typography.bodySmall, fontWeight = FontWeight.SemiBold); Spacer(Modifier.height(6.dp)) }
            Row(horizontalArrangement = Arrangement.spacedBy(8.dp)) {
                OutlinedButton(onClick = {
                    busy = true; notice = null
                    scope.launch {
                        runCatching { Api.previewResume(context, effective()) }.onSuccess { preview = it }
                            .onFailure { notice = resumeError(it, "The preview could not be prepared.") }
                        busy = false
                    }
                }, enabled = !busy, shape = RoundedCornerShape(10.dp)) { Text("Preview") }
                Button(onClick = {
                    busy = true; notice = null
                    scope.launch {
                        runCatching { Api.saveResume(context, resumeId, effective()) }.onSuccess { onSaved() }
                            .onFailure { notice = resumeError(it, "The résumé could not be saved. Try again.") }
                        busy = false
                    }
                }, enabled = !busy, shape = RoundedCornerShape(10.dp)) { Text(if (resumeId == null) "Save résumé" else "Save new version") }
            }
            preview?.let { ResumePreviewSections(it) }
            Spacer(Modifier.height(32.dp))
        }
    }
}

@Composable
private fun CheckRow(checked: Boolean, title: String, detail: String? = null, chip: (@Composable () -> Unit)? = null, onToggle: () -> Unit) {
    Row(Modifier.fillMaxWidth().padding(vertical = 2.dp), verticalAlignment = Alignment.CenterVertically) {
        Checkbox(checked = checked, onCheckedChange = { onToggle() })
        Column(Modifier.weight(1f)) {
            Text(title, style = MaterialTheme.typography.bodyMedium)
            if (!detail.isNullOrBlank()) Text(detail, style = MaterialTheme.typography.bodySmall, color = MaterialTheme.colorScheme.onSurfaceVariant)
        }
        chip?.let { Spacer(Modifier.width(6.dp)); it() }
    }
}

/** The sections exactly as the server resolved them, with each label, then the checks. */
@Composable
private fun ResumePreviewSections(preview: ResumePreviewDto) {
    val content = preview.content
    SectionTitle("Preview")
    PilotCard {
        Column(Modifier.fillMaxWidth().padding(16.dp)) {
            Text(content.header.fullName ?: "NA", style = MaterialTheme.typography.titleLarge, fontWeight = FontWeight.Bold)
            content.header.headline?.let { Text(it, style = MaterialTheme.typography.bodyMedium) }
            val contact = listOfNotNull(content.header.email, content.header.phone, content.header.location) + content.header.links.map { it.url }
            if (contact.isNotEmpty()) Text(contact.joinToString("  ·  "), style = MaterialTheme.typography.bodySmall, color = MaterialTheme.colorScheme.onSurfaceVariant)
            content.summary?.let { PreviewHeading("Summary"); Text(it, style = MaterialTheme.typography.bodySmall) }
            if (content.objective.isNotEmpty()) { PreviewHeading("Career objective"); Text(content.objective.joinToString("  ·  "), style = MaterialTheme.typography.bodySmall) }
            if (content.education.isNotEmpty()) {
                PreviewHeading("Education")
                content.education.forEach { entry ->
                    Text(entry.title + (entry.period?.let { "  ($it)" } ?: ""), style = MaterialTheme.typography.bodyMedium, fontWeight = FontWeight.SemiBold)
                    entry.institution?.let { Text(it, style = MaterialTheme.typography.bodySmall) }
                    Row(horizontalArrangement = Arrangement.spacedBy(6.dp), verticalAlignment = Alignment.CenterVertically) {
                        entry.status?.let { Text(it, style = MaterialTheme.typography.labelSmall) }
                        VerificationChip(entry.verification, entry.verified)
                    }
                    entry.results.forEach { line ->
                        Text("${line.label} — ${line.result}  ·  ${line.verification}", style = MaterialTheme.typography.labelSmall,
                            color = if (line.verified) MaterialTheme.colorScheme.primary else MaterialTheme.colorScheme.onSurfaceVariant)
                    }
                    Spacer(Modifier.height(6.dp))
                }
            }
            if (content.skills.shown.isNotEmpty() || content.skills.declared.isNotEmpty()) {
                PreviewHeading("Skills")
                content.skills.shown.forEach { Text("${it.name} — ${it.basis}", style = MaterialTheme.typography.bodySmall) }
                if (content.skills.declared.isNotEmpty()) Text("Self-declared skills: " + content.skills.declared.joinToString(", "), style = MaterialTheme.typography.bodySmall)
            }
            if (content.projects.isNotEmpty()) {
                PreviewHeading("Projects (self-declared)")
                content.projects.forEach { project ->
                    Text(project.title, style = MaterialTheme.typography.bodyMedium, fontWeight = FontWeight.SemiBold)
                    project.description?.let { Text(it, style = MaterialTheme.typography.bodySmall) }
                }
            }
            if (content.certificates.isNotEmpty()) {
                PreviewHeading("Certificates (self-declared)")
                content.certificates.forEach { Text(it.title, style = MaterialTheme.typography.bodySmall) }
            }
            if (content.languages.isNotEmpty()) { PreviewHeading("Languages (self-declared)"); Text(content.languages.joinToString(", "), style = MaterialTheme.typography.bodySmall) }
            Spacer(Modifier.height(8.dp))
            Text(content.legend, style = MaterialTheme.typography.labelSmall, color = MaterialTheme.colorScheme.onSurfaceVariant)
        }
    }
    SectionTitle("Resume checks", trailing = "Checklist")
    PilotCard {
        Column(Modifier.fillMaxWidth().padding(16.dp)) {
            preview.checks.forEach { check ->
                Row(Modifier.padding(vertical = 3.dp), verticalAlignment = Alignment.CenterVertically) {
                    StatusChip(if (check.passed) "Done" else "Not yet", if (check.passed) ChipKind.Positive else ChipKind.Waiting)
                    Spacer(Modifier.width(8.dp))
                    Text(check.message, style = MaterialTheme.typography.bodySmall)
                }
            }
        }
    }
}

@Composable
private fun PreviewHeading(text: String) {
    Spacer(Modifier.height(10.dp))
    Text(text, style = MaterialTheme.typography.labelLarge, fontWeight = FontWeight.Bold, color = MaterialTheme.colorScheme.primary)
    Spacer(Modifier.height(2.dp))
}
