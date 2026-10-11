/*
 * ONE · Display labels for codes
 *
 * The API speaks in codes (PLACEMENT_ADMIN, TRANSFERRED, DEPARTMENT). People should never
 * read those. Every place that shows a role, status or kind runs it through here, with the
 * same mappings as the web app's labels.ts, so a code reads the same way on the phone as it
 * does in the browser.
 */
package pro.ai8ht.one

private val roleNames: Map<String, String> = mapOf(
    "STUDENT" to "Student",
    "GRADUATE" to "Graduate",
    "INSTITUTION_OWNER" to "Institution Owner",
    "INSTITUTION_ADMIN" to "Institution Admin",
    "INSTITUTION_ANALYST" to "Institution Analyst",
    "PLACEMENT_ADMIN" to "Placement Officer",
    "PLACEMENT_OFFICER" to "Placement Officer",
    "DEPARTMENT_HEAD" to "Department Head",
    "FACULTY_LECTURER" to "Lecturer",
    "CAREER_COUNSELOR" to "Career Counsellor",
    "EMPLOYER_OWNER" to "Employer Owner",
    "EMPLOYER_ADMIN" to "Employer Admin",
    "RECRUITER" to "Recruiter",
    "HIRING_MANAGER" to "Hiring Manager",
    "INTERVIEWER" to "Interviewer",
    "OPERATIONS_ADMIN" to "Operations Admin",
    "PLATFORM_SUPER_ADMIN" to "Platform Super Admin",
    "SECURITY_ADMIN" to "Security Admin",
    "SUPPORT_AGENT" to "Support Agent",
    "GROWTH_EXECUTIVE" to "Growth Executive",
    "GROWTH_MANAGER" to "Regional Manager",
    "GROWTH_ADMIN" to "Growth Admin",
)

/** Words that keep their capitals when a code is humanised. */
private val acronyms = setOf("AI", "API", "CGPA", "CSV", "GD", "HR", "ID", "MRO", "NA", "ONE", "PDF", "URL")

private const val LABEL_NA = "NA"
private val codeShape = Regex("^[A-Z0-9_]+$")

/** A role code as a job title: "PLACEMENT_ADMIN" → "Placement Officer". */
internal fun roleLabel(code: String?): String {
    if (code.isNullOrEmpty()) return LABEL_NA
    return roleNames[code] ?: titleCase(code)
}

/**
 * Any other code — a status, a kind, a stage — as plain words in sentence case:
 * "TRANSFERRED" → "Transferred", "UNDER_REVIEW" → "Under review", "CSV_IMPORT" → "CSV import".
 * Text that is not a code is returned as it is.
 */
internal fun codeLabel(code: String?): String {
    if (code.isNullOrEmpty()) return LABEL_NA
    if (!codeShape.matches(code)) return code
    val words = code.split('_').filter { it.isNotEmpty() }.map { if (it in acronyms) it else it.lowercase() }
    val first = words.firstOrNull() ?: return LABEL_NA
    return (listOf(first.replaceFirstChar { it.uppercase() }) + words.drop(1)).joinToString(" ")
}

/**
 * A hiring stage as plain words, as on the web (approved 2026-10-11): the API keeps REJECTED,
 * people read "Not selected".
 */
internal fun applicationStageLabel(code: String?): String =
    if (code == "REJECTED" || code == "NOT_SELECTED") "Not selected" else codeLabel(code)

private fun titleCase(code: String): String {
    if (!codeShape.matches(code)) return code
    return code.split('_').filter { it.isNotEmpty() }
        .joinToString(" ") { if (it in acronyms) it else it.first() + it.substring(1).lowercase() }
        .ifEmpty { LABEL_NA }
}
