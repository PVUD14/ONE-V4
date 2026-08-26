package pro.ai8ht.one

import android.content.Context
import android.graphics.BitmapFactory
import androidx.compose.foundation.Image
import androidx.compose.foundation.background
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.shape.CircleShape
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.runtime.remember
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.clip
import androidx.compose.ui.graphics.asImageBitmap
import androidx.compose.ui.layout.ContentScale
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.unit.Dp
import androidx.compose.ui.unit.dp
import java.io.File

/**
 * The student's profile photo. Stored on the device for now (the platform's
 * avatar upload API is a pending server feature; when it ships, this same file
 * becomes the upload source). Falls back to an initials disc.
 */
object ProfilePhoto {
    fun file(context: Context): File = File(context.filesDir, "avatar.jpg")

    fun save(context: Context, uriBytes: ByteArray) {
        file(context).writeBytes(uriBytes)
    }
}

@Composable
fun AvatarView(context: Context, name: String?, size: Dp, version: Int) {
    val bitmap = remember(version) {
        val file = ProfilePhoto.file(context)
        if (file.exists()) runCatching { BitmapFactory.decodeFile(file.absolutePath)?.asImageBitmap() }.getOrNull() else null
    }
    if (bitmap != null) {
        Image(
            bitmap = bitmap,
            contentDescription = "Profile photo",
            contentScale = ContentScale.Crop,
            modifier = Modifier.size(size).clip(CircleShape),
        )
    } else {
        Box(
            Modifier.size(size).background(MaterialTheme.colorScheme.primaryContainer, CircleShape),
            contentAlignment = Alignment.Center,
        ) {
            val initials = (name ?: "S").split(" ").take(2)
                .mapNotNull { it.firstOrNull()?.uppercase() }.joinToString("")
            Text(initials, fontWeight = FontWeight.Bold, color = MaterialTheme.colorScheme.onPrimaryContainer)
        }
    }
}
