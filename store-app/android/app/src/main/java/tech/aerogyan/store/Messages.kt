package tech.aerogyan.store

import android.content.Context

/** Clear words (English / Hindi) for every reason the store refuses a file. */
object Messages {
    fun reason(context: Context, r: Reason): String = context.getString(
        when (r) {
            Reason.BAD_URL -> R.string.rej_bad_url
            Reason.NO_HASH -> R.string.rej_no_hash
            Reason.HASH_MISMATCH -> R.string.rej_hash
            Reason.NOT_APK -> R.string.rej_not_apk
            Reason.NOT_OURS -> R.string.rej_not_ours
            Reason.PACKAGE_MISMATCH -> R.string.rej_package
            Reason.WRONG_SIGNER -> R.string.rej_signer
            Reason.OLDER_THAN_LISTED -> R.string.rej_older_than_listed
            Reason.NOT_NEWER -> R.string.rej_not_newer
            Reason.NEEDS_NEWER_ANDROID -> R.string.rej_android
        }
    )
}
