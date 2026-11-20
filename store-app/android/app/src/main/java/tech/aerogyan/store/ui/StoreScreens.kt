package tech.aerogyan.store.ui

import android.graphics.Bitmap
import androidx.activity.compose.BackHandler
import androidx.appcompat.app.AppCompatDelegate
import androidx.compose.foundation.Image
import androidx.compose.foundation.background
import androidx.compose.foundation.clickable
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.PaddingValues
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.layout.width
import androidx.compose.foundation.lazy.LazyColumn
import androidx.compose.foundation.lazy.items
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.selection.selectable
import androidx.compose.foundation.selection.selectableGroup
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.foundation.text.KeyboardOptions
import androidx.compose.foundation.verticalScroll
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.automirrored.filled.ArrowBack
import androidx.compose.material.icons.filled.CheckCircle
import androidx.compose.material.icons.filled.Close
import androidx.compose.material.icons.filled.Info
import androidx.compose.material.icons.filled.Lock
import androidx.compose.material.icons.filled.Search
import androidx.compose.material.icons.filled.Settings
import androidx.compose.material.icons.filled.Warning
import androidx.compose.material3.AlertDialog
import androidx.compose.material3.Badge
import androidx.compose.material3.BadgedBox
import androidx.compose.material3.Button
import androidx.compose.material3.Card
import androidx.compose.material3.CardDefaults
import androidx.compose.material3.CircularProgressIndicator
import androidx.compose.material3.ExperimentalMaterial3Api
import androidx.compose.material3.HorizontalDivider
import androidx.compose.material3.Icon
import androidx.compose.material3.IconButton
import androidx.compose.material3.LinearProgressIndicator
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.OutlinedButton
import androidx.compose.material3.OutlinedTextField
import androidx.compose.material3.RadioButton
import androidx.compose.material3.Scaffold
import androidx.compose.material3.Switch
import androidx.compose.material3.Tab
import androidx.compose.material3.TabRow
import androidx.compose.material3.Text
import androidx.compose.material3.TextButton
import androidx.compose.material3.TopAppBar
import androidx.compose.material3.pulltorefresh.PullToRefreshBox
import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.collectAsState
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.saveable.rememberSaveable
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.clip
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.graphics.asImageBitmap
import androidx.compose.ui.platform.LocalConfiguration
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.res.pluralStringResource
import androidx.compose.ui.res.stringResource
import androidx.compose.ui.semantics.Role
import androidx.compose.ui.semantics.contentDescription
import androidx.compose.ui.semantics.heading
import androidx.compose.ui.semantics.semantics
import androidx.compose.ui.semantics.stateDescription
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.text.input.ImeAction
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.unit.Dp
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import androidx.core.os.LocaleListCompat
import tech.aerogyan.store.AppState
import tech.aerogyan.store.BuildConfig
import tech.aerogyan.store.Format
import tech.aerogyan.store.IconLoader
import tech.aerogyan.store.Installed
import tech.aerogyan.store.Pins
import tech.aerogyan.store.R
import tech.aerogyan.store.States
import tech.aerogyan.store.StoreApp
import tech.aerogyan.store.StoreViewModel
import tech.aerogyan.store.Task
import java.util.Locale

private sealed class Screen {
    object Main : Screen()
    data class Detail(val id: String) : Screen()
    object Settings : Screen()
}

private enum class Tab { FOR_YOU, ALL, UPDATES }

@Composable
private fun hindi(): Boolean = LocalConfiguration.current.locales[0]?.language == "hi"

@Composable
fun StoreRoot(
    vm: StoreViewModel,
    openTab: String?,
    onTabOpened: () -> Unit,
    onOnboarded: () -> Unit,
    openUnknownSources: () -> Unit,
) {
    val role by vm.role.collectAsState()
    if (role.isEmpty()) {
        Onboarding(vm, onDone = onOnboarded, openUnknownSources = openUnknownSources)
        return
    }
    var screen by remember { mutableStateOf<Screen>(Screen.Main) }
    var tab by rememberSaveable { mutableStateOf(Tab.FOR_YOU) }
    LaunchedEffect(openTab) {
        if (openTab == "updates") {
            tab = Tab.UPDATES
            screen = Screen.Main
            onTabOpened()
        }
    }
    val pending by vm.pending.collectAsState()
    pending?.let { p ->
        AllowInstallsDialog(appName = p.title(hindi()), onOpen = openUnknownSources, onDismiss = { vm.dismissPending() })
    }
    when (val s = screen) {
        is Screen.Main -> MainScreen(vm, tab, onTab = { tab = it }, onOpenApp = { screen = Screen.Detail(it.id) }, onSettings = { screen = Screen.Settings })
        is Screen.Detail -> {
            BackHandler { screen = Screen.Main }
            DetailScreen(vm, s.id, onBack = { screen = Screen.Main }, onOpenApp = { screen = Screen.Detail(it) })
        }
        is Screen.Settings -> {
            BackHandler { screen = Screen.Main }
            SettingsScreen(vm, onBack = { screen = Screen.Main }, openUnknownSources = openUnknownSources)
        }
    }
}

/* ------------------------------------------------------------------ main list */

@OptIn(ExperimentalMaterial3Api::class)
@Composable
private fun MainScreen(vm: StoreViewModel, tab: Tab, onTab: (Tab) -> Unit, onOpenApp: (StoreApp) -> Unit, onSettings: () -> Unit) {
    val catalog by vm.catalog.collectAsState()
    val installed by vm.installed.collectAsState()
    val tasks by vm.tasks.collectAsState()
    val loading by vm.loading.collectAsState()
    val offline by vm.offline.collectAsState()
    val role by vm.role.collectAsState()
    var searching by rememberSaveable { mutableStateOf(false) }
    var query by rememberSaveable { mutableStateOf("") }
    val hi = hindi()
    val apps = catalog?.apps.orEmpty()
    val updates = States.updates(apps, installed, vm.deviceSdk)
    BackHandler(enabled = searching) { searching = false; query = "" }

    Scaffold(
        topBar = {
            TopAppBar(
                title = {
                    if (searching) {
                        OutlinedTextField(
                            value = query,
                            onValueChange = { query = it },
                            singleLine = true,
                            placeholder = { Text(stringResource(R.string.search_hint)) },
                            keyboardOptions = KeyboardOptions(imeAction = ImeAction.Search),
                            modifier = Modifier.fillMaxWidth(),
                        )
                    } else {
                        Text(stringResource(R.string.app_name), fontWeight = FontWeight.SemiBold)
                    }
                },
                actions = {
                    if (searching) {
                        IconButton(onClick = { searching = false; query = "" }) {
                            Icon(Icons.Filled.Close, contentDescription = stringResource(R.string.cd_close_search))
                        }
                    } else {
                        IconButton(onClick = { searching = true }) {
                            Icon(Icons.Filled.Search, contentDescription = stringResource(R.string.cd_search))
                        }
                    }
                    IconButton(onClick = onSettings) {
                        Icon(Icons.Filled.Settings, contentDescription = stringResource(R.string.settings))
                    }
                },
            )
        },
    ) { pad ->
        Column(Modifier.padding(pad).fillMaxSize()) {
            if (offline) Banner(Icons.Filled.Warning, stringResource(R.string.offline_banner))
            val self = catalog?.self
            if (self != null && updates.any { it.id == self.id } && tab != Tab.UPDATES) {
                Banner(Icons.Filled.Info, stringResource(R.string.self_update_banner), action = stringResource(R.string.btn_update)) { vm.install(self) }
            }
            if (!searching) {
                TabRow(selectedTabIndex = tab.ordinal) {
                    Tab(selected = tab == Tab.FOR_YOU, onClick = { onTab(Tab.FOR_YOU) }, text = { Text(stringResource(R.string.tab_for_you)) })
                    Tab(selected = tab == Tab.ALL, onClick = { onTab(Tab.ALL) }, text = { Text(stringResource(R.string.tab_all)) })
                    val updLabel = pluralStringResource(R.plurals.cd_updates_tab, updates.size, updates.size)
                    Tab(
                        selected = tab == Tab.UPDATES, onClick = { onTab(Tab.UPDATES) },
                        modifier = Modifier.semantics { contentDescription = updLabel },
                        text = {
                            if (updates.isNotEmpty()) {
                                BadgedBox(badge = { Badge { Text(updates.size.toString()) } }) { Text(stringResource(R.string.tab_updates)) }
                            } else {
                                Text(stringResource(R.string.tab_updates))
                            }
                        },
                    )
                }
            }
            PullToRefreshBox(isRefreshing = loading, onRefresh = { vm.refresh() }, modifier = Modifier.fillMaxSize()) {
                when {
                    catalog == null && loading -> Centered { CircularProgressIndicator() }
                    catalog == null -> Centered {
                        Column(horizontalAlignment = Alignment.CenterHorizontally) {
                            Text(stringResource(R.string.load_failed), textAlign = androidx.compose.ui.text.style.TextAlign.Center)
                            Spacer(Modifier.height(12.dp))
                            Button(onClick = { vm.refresh() }) { Text(stringResource(R.string.btn_retry)) }
                        }
                    }
                    else -> {
                        val list: List<StoreApp> = when {
                            searching -> apps.filter { it.kind != "store" && it.matches(query) }
                            tab == Tab.FOR_YOU -> States.forYou(apps, role)
                            tab == Tab.ALL -> apps.filter { it.kind != "store" }
                            else -> updates
                        }
                        val gOffice = stringResource(R.string.group_office)
                        val gApps = stringResource(R.string.group_apps)
                        LazyColumn(Modifier.fillMaxSize(), contentPadding = PaddingValues(bottom = 24.dp)) {
                            if (tab == Tab.UPDATES && !searching) {
                                item {
                                    if (updates.isEmpty()) {
                                        EmptyNote(Icons.Filled.CheckCircle, stringResource(R.string.all_up_to_date))
                                    } else {
                                        Row(Modifier.fillMaxWidth().padding(16.dp, 12.dp), verticalAlignment = Alignment.CenterVertically) {
                                            Text(pluralStringResource(R.plurals.n_updates, updates.size, updates.size), Modifier.weight(1f), style = MaterialTheme.typography.titleMedium)
                                            Button(onClick = { vm.updateAll(updates) }) { Text(stringResource(R.string.btn_update_all)) }
                                        }
                                    }
                                }
                            }
                            if (searching && list.isEmpty() && query.isNotBlank()) {
                                item { EmptyNote(Icons.Filled.Search, stringResource(R.string.no_results, query)) }
                            }
                            var lastGroup = ""
                            for (a in list) {
                                val group = if (tab == Tab.ALL && !searching) (if (a.kind == "office") gOffice else gApps) else ""
                                if (group.isNotEmpty() && group != lastGroup) {
                                    lastGroup = group
                                    item(key = "h-$group") { SectionHeader(group) }
                                }
                                item(key = a.id) {
                                    AppRow(vm, a, installed, tasks[a.id], hi, onClick = { onOpenApp(a) })
                                }
                            }
                        }
                    }
                }
            }
        }
    }
}


@Composable
private fun SectionHeader(text: String) {
    Text(
        text, style = MaterialTheme.typography.titleSmall, color = MaterialTheme.colorScheme.primary,
        modifier = Modifier.padding(start = 16.dp, top = 16.dp, bottom = 4.dp).semantics { heading() },
    )
}

@Composable
private fun Centered(content: @Composable () -> Unit) {
    Box(Modifier.fillMaxSize().verticalScroll(rememberScrollState()).padding(32.dp), contentAlignment = Alignment.Center) { content() }
}

@Composable
private fun EmptyNote(icon: androidx.compose.ui.graphics.vector.ImageVector, text: String) {
    Column(Modifier.fillMaxWidth().padding(32.dp), horizontalAlignment = Alignment.CenterHorizontally) {
        Icon(icon, contentDescription = null, tint = MaterialTheme.colorScheme.primary, modifier = Modifier.size(40.dp))
        Spacer(Modifier.height(8.dp))
        Text(text, style = MaterialTheme.typography.bodyLarge, textAlign = androidx.compose.ui.text.style.TextAlign.Center)
    }
}

@Composable
private fun Banner(icon: androidx.compose.ui.graphics.vector.ImageVector, text: String, action: String? = null, onAction: () -> Unit = {}) {
    Row(
        Modifier.fillMaxWidth().background(MaterialTheme.colorScheme.secondaryContainer).padding(horizontal = 16.dp, vertical = 8.dp),
        verticalAlignment = Alignment.CenterVertically,
    ) {
        Icon(icon, contentDescription = null, tint = MaterialTheme.colorScheme.onSecondaryContainer)
        Spacer(Modifier.width(12.dp))
        Text(text, Modifier.weight(1f), color = MaterialTheme.colorScheme.onSecondaryContainer, style = MaterialTheme.typography.bodyMedium)
        if (action != null) TextButton(onClick = onAction) { Text(action) }
    }
}

/* ------------------------------------------------------------------ one row */

@Composable
private fun AppRow(vm: StoreViewModel, a: StoreApp, installed: Map<String, Installed>, task: Task?, hi: Boolean, onClick: () -> Unit) {
    val inst = a.android?.let { installed[it.packageName] }
    val state = States.state(a, inst, vm.deviceSdk)
    val openLabel = stringResource(R.string.cd_open_details, a.title(hi))
    Row(
        Modifier.fillMaxWidth().clickable(onClickLabel = openLabel, onClick = onClick).padding(horizontal = 16.dp, vertical = 10.dp),
        verticalAlignment = Alignment.CenterVertically,
    ) {
        AppIcon(a, 52.dp)
        Spacer(Modifier.width(14.dp))
        Column(Modifier.weight(1f)) {
            Text(a.title(hi), style = MaterialTheme.typography.titleMedium, maxLines = 1, overflow = TextOverflow.Ellipsis)
            Text(
                a.subtitle(hi), style = MaterialTheme.typography.bodySmall, color = MaterialTheme.colorScheme.onSurfaceVariant,
                maxLines = 2, overflow = TextOverflow.Ellipsis,
            )
            StatusLine(a, state, task, inst)
        }
        Spacer(Modifier.width(8.dp))
        ActionButton(vm, a, state, task)
    }
}

@Composable
private fun StatusLine(a: StoreApp, state: AppState, task: Task?, inst: Installed?) {
    val f = a.android
    val text: String
    var color = MaterialTheme.colorScheme.onSurfaceVariant
    when (task) {
        is Task.Downloading -> text = stringResource(R.string.state_downloading, Format.size(task.done), Format.size(task.total))
        is Task.Queued -> text = stringResource(if (task.waitingForWifi) R.string.state_wifi else R.string.state_queued)
        is Task.Verifying -> text = stringResource(R.string.state_verifying)
        is Task.Installing -> text = stringResource(R.string.state_installing)
        is Task.WaitingForUser -> text = stringResource(R.string.state_confirm)
        is Task.Failed -> { text = task.message; color = MaterialTheme.colorScheme.error }
        null -> text = when (state) {
            AppState.WEB_ONLY -> stringResource(if (a.needsComputer) R.string.needs_computer else R.string.web_only)
            AppState.COMING_SOON -> stringResource(R.string.coming_soon)
            AppState.INCOMPATIBLE -> stringResource(R.string.needs_android, Format.androidName(f?.minSdk ?: 0))
            AppState.UPDATE -> stringResource(R.string.meta_update, inst?.versionName ?: "?", f?.version.orEmpty(), Format.size(f?.size ?: 0))
            AppState.INSTALLED -> stringResource(R.string.meta_installed, inst?.versionName ?: f?.version.orEmpty())
            AppState.NOT_INSTALLED -> stringResource(R.string.meta_size, f?.version.orEmpty(), Format.size(f?.size ?: 0))
        }
    }
    Text(text, style = MaterialTheme.typography.labelMedium, color = color, maxLines = 2, overflow = TextOverflow.Ellipsis)
    if (task is Task.Downloading) {
        LinearProgressIndicator(progress = { task.fraction }, modifier = Modifier.fillMaxWidth().padding(top = 4.dp))
    } else if (task is Task.Verifying || task is Task.Installing || (task is Task.Queued && !task.waitingForWifi)) {
        LinearProgressIndicator(modifier = Modifier.fillMaxWidth().padding(top = 4.dp))
    }
}

@Composable
private fun ActionButton(vm: StoreViewModel, a: StoreApp, state: AppState, task: Task?, wide: Boolean = false) {
    val name = a.title(hindi())
    val mod = if (wide) Modifier.fillMaxWidth().height(48.dp) else Modifier
    if (task != null && task !is Task.Failed) {
        val cancellable = task is Task.Downloading || task is Task.Queued
        val busy = stringResource(R.string.cd_busy, name)
        Row(verticalAlignment = Alignment.CenterVertically, modifier = Modifier.semantics { stateDescription = busy }) {
            if (task is Task.Downloading) {
                CircularProgressIndicator(progress = { task.fraction }, modifier = Modifier.size(28.dp), strokeWidth = 3.dp)
            } else {
                CircularProgressIndicator(modifier = Modifier.size(28.dp), strokeWidth = 3.dp)
            }
            if (cancellable) {
                IconButton(onClick = { vm.cancel(a) }) {
                    Icon(Icons.Filled.Close, contentDescription = stringResource(R.string.cd_cancel, name))
                }
            }
        }
        return
    }
    when (state) {
        AppState.WEB_ONLY -> OutlinedButton(onClick = { vm.openWeb(a) }, modifier = mod) { Text(stringResource(R.string.btn_open_web)) }
        AppState.COMING_SOON -> TextButton(onClick = {}, enabled = false, modifier = mod) { Text(stringResource(R.string.btn_soon)) }
        AppState.INCOMPATIBLE -> TextButton(onClick = {}, enabled = false, modifier = mod) { Text(stringResource(R.string.btn_incompatible)) }
        AppState.NOT_INSTALLED -> Button(onClick = { vm.install(a) }, modifier = mod) {
            Text(stringResource(if (task is Task.Failed) R.string.btn_retry else R.string.btn_install))
        }
        AppState.UPDATE -> Button(onClick = { vm.install(a) }, modifier = mod) {
            Text(stringResource(if (task is Task.Failed) R.string.btn_retry else R.string.btn_update))
        }
        AppState.INSTALLED -> if (a.kind == "store") {
            TextButton(onClick = {}, enabled = false, modifier = mod) { Text(stringResource(R.string.btn_up_to_date)) }
        } else {
            OutlinedButton(onClick = { vm.open(a) }, modifier = mod) { Text(stringResource(R.string.btn_open)) }
        }
    }
}

@Composable
private fun AppIcon(a: StoreApp, size: Dp) {
    val ctx = LocalContext.current
    var bmp by remember(a.icon) { mutableStateOf<Bitmap?>(a.icon?.let { IconLoader.cached(it) }) }
    LaunchedEffect(a.icon) {
        val url = a.icon
        if (bmp == null && url != null) bmp = IconLoader.load(ctx, url)
    }
    val shape = RoundedCornerShape(size * 0.24f)
    val b = bmp
    if (b != null) {
        Image(b.asImageBitmap(), contentDescription = null, modifier = Modifier.size(size).clip(shape))
    } else {
        val c = remember(a.color) {
            try { Color(android.graphics.Color.parseColor(a.color ?: "#4F46E5")) } catch (_: Exception) { Color(0xFF4F46E5) }
        }
        Box(Modifier.size(size).clip(shape).background(c), contentAlignment = Alignment.Center) {
            Text(
                (a.short ?: a.name).removePrefix("AeroGyan ").take(1).uppercase(Locale.ROOT),
                color = Color.White, fontWeight = FontWeight.Bold, fontSize = (size.value * 0.42f).sp,
            )
        }
    }
}

/* ------------------------------------------------------------------ detail */

@OptIn(ExperimentalMaterial3Api::class)
@Composable
private fun DetailScreen(vm: StoreViewModel, id: String, onBack: () -> Unit, onOpenApp: (String) -> Unit) {
    val catalog by vm.catalog.collectAsState()
    val installed by vm.installed.collectAsState()
    val tasks by vm.tasks.collectAsState()
    val a = catalog?.byId(id)
    val hi = hindi()
    val locale = LocalConfiguration.current.locales[0] ?: Locale.getDefault()
    Scaffold(topBar = {
        TopAppBar(
            title = { Text(a?.title(hi) ?: "", maxLines = 1, overflow = TextOverflow.Ellipsis) },
            navigationIcon = {
                IconButton(onClick = onBack) { Icon(Icons.AutoMirrored.Filled.ArrowBack, contentDescription = stringResource(R.string.cd_back)) }
            },
        )
    }) { pad ->
        if (a == null) {
            Box(Modifier.padding(pad)) { EmptyNote(Icons.Filled.Info, stringResource(R.string.err_not_in_catalogue)) }
            return@Scaffold
        }
        val f = a.android
        val inst = f?.let { installed[it.packageName] }
        val state = States.state(a, inst, vm.deviceSdk)
        val task = tasks[a.id]
        LazyColumn(Modifier.padding(pad).fillMaxSize(), contentPadding = PaddingValues(16.dp)) {
            item {
                Row(verticalAlignment = Alignment.CenterVertically) {
                    AppIcon(a, 72.dp)
                    Spacer(Modifier.width(16.dp))
                    Column {
                        Text(a.title(hi), style = MaterialTheme.typography.headlineSmall, modifier = Modifier.semantics { heading() })
                        Text(stringResource(R.string.by_aerogyan), style = MaterialTheme.typography.bodyMedium, color = MaterialTheme.colorScheme.primary)
                        if (f != null && f.available) {
                            Text("${f.version} · ${Format.size(f.size)}", style = MaterialTheme.typography.bodySmall, color = MaterialTheme.colorScheme.onSurfaceVariant)
                        }
                    }
                }
                Spacer(Modifier.height(16.dp))
                ActionButton(vm, a, state, task, wide = true)
                Spacer(Modifier.height(6.dp))
                StatusLine(a, state, task, inst)
                Spacer(Modifier.height(16.dp))
                TrustCard(a)
            }
            item { Section(stringResource(R.string.about)) { Text(a.about(hi), style = MaterialTheme.typography.bodyLarge) } }
            if (a.features.isNotEmpty()) {
                item {
                    Section(stringResource(R.string.features)) {
                        a.features.forEach { Text("•  $it", style = MaterialTheme.typography.bodyMedium, modifier = Modifier.padding(vertical = 2.dp)) }
                    }
                }
            }
            if (a.includes.isNotEmpty()) {
                item {
                    Section(pluralStringResource(R.plurals.includes, a.includes.size, a.includes.size)) {
                        a.includes.mapNotNull { catalog?.byId(it) }.forEach { x ->
                            Row(
                                Modifier.fillMaxWidth().clickable { onOpenApp(x.id) }.padding(vertical = 6.dp),
                                verticalAlignment = Alignment.CenterVertically,
                            ) {
                                AppIcon(x, 32.dp)
                                Spacer(Modifier.width(12.dp))
                                Text(x.title(hi), style = MaterialTheme.typography.bodyMedium)
                            }
                        }
                    }
                }
            }
            if (f != null && f.available) {
                item {
                    Section(stringResource(R.string.whats_new)) {
                        Text(f.notes?.takeIf { it.isNotBlank() } ?: stringResource(R.string.no_notes), style = MaterialTheme.typography.bodyMedium)
                    }
                }
                item {
                    Section(stringResource(R.string.info)) {
                        InfoRow(stringResource(R.string.info_version), f.version + (f.versionCode?.let { " ($it)" } ?: ""))
                        if (inst != null) InfoRow(stringResource(R.string.info_installed), inst.versionName ?: inst.versionCode.toString())
                        InfoRow(stringResource(R.string.info_size), Format.size(f.size))
                        InfoRow(stringResource(R.string.info_updated), Format.date(f.updatedAt, locale))
                        InfoRow(stringResource(R.string.info_android), stringResource(R.string.info_android_value, Format.androidName(f.minSdk)))
                        InfoRow(stringResource(R.string.info_package), f.packageName)
                    }
                }
            }
            item {
                Spacer(Modifier.height(16.dp))
                if (inst != null && a.kind != "store") {
                    OutlinedButton(onClick = { vm.uninstall(a) }, modifier = Modifier.fillMaxWidth().height(48.dp)) {
                        Text(stringResource(R.string.btn_uninstall), color = MaterialTheme.colorScheme.error)
                    }
                    Spacer(Modifier.height(8.dp))
                }
                if (a.web != null && state != AppState.WEB_ONLY) {
                    TextButton(onClick = { vm.openWeb(a) }, modifier = Modifier.fillMaxWidth().height(48.dp)) { Text(stringResource(R.string.btn_website)) }
                }
            }
        }
    }
}

@Composable
private fun TrustCard(a: StoreApp) {
    val f = a.android
    val signer = f?.let { Pins.signerName(it.packageName) }
    val (icon, text) = when {
        f == null -> Icons.Filled.Info to stringResource(if (a.needsComputer) R.string.trust_computer else R.string.trust_web)
        signer == null -> Icons.Filled.Warning to stringResource(R.string.trust_unknown)
        f.sha256 == null && f.available -> Icons.Filled.Warning to stringResource(R.string.trust_no_hash)
        else -> Icons.Filled.Lock to stringResource(R.string.trust_verified, signer)
    }
    Card(colors = CardDefaults.cardColors(containerColor = MaterialTheme.colorScheme.surfaceVariant), modifier = Modifier.fillMaxWidth()) {
        Row(Modifier.padding(14.dp), verticalAlignment = Alignment.CenterVertically) {
            Icon(icon, contentDescription = null, tint = MaterialTheme.colorScheme.primary)
            Spacer(Modifier.width(12.dp))
            Text(text, style = MaterialTheme.typography.bodyMedium)
        }
    }
}

@Composable
private fun Section(title: String, content: @Composable () -> Unit) {
    Column(Modifier.padding(top = 20.dp)) {
        Text(title, style = MaterialTheme.typography.titleMedium, modifier = Modifier.padding(bottom = 6.dp).semantics { heading() })
        content()
    }
}

@Composable
private fun InfoRow(label: String, value: String) {
    Row(Modifier.fillMaxWidth().padding(vertical = 4.dp).semantics(mergeDescendants = true) {}) {
        Text(label, Modifier.width(140.dp), style = MaterialTheme.typography.bodyMedium, color = MaterialTheme.colorScheme.onSurfaceVariant)
        Text(value, style = MaterialTheme.typography.bodyMedium)
    }
}

/* ------------------------------------------------------------------ settings */

@OptIn(ExperimentalMaterial3Api::class)
@Composable
private fun SettingsScreen(vm: StoreViewModel, onBack: () -> Unit, openUnknownSources: () -> Unit) {
    val role by vm.role.collectAsState()
    val canInstall by vm.canInstall.collectAsState()
    var wifi by remember { mutableStateOf(vm.prefs.wifiOnlyBig) }
    var auto by remember { mutableStateOf(vm.prefs.autoUpdate) }
    var notify by remember { mutableStateOf(vm.prefs.notifyUpdates) }
    val lang = AppCompatDelegate.getApplicationLocales().toLanguageTags().substringBefore('-')
    Scaffold(topBar = {
        TopAppBar(
            title = { Text(stringResource(R.string.settings)) },
            navigationIcon = { IconButton(onClick = onBack) { Icon(Icons.AutoMirrored.Filled.ArrowBack, contentDescription = stringResource(R.string.cd_back)) } },
        )
    }) { pad ->
        Column(Modifier.padding(pad).fillMaxSize().verticalScroll(rememberScrollState()).padding(vertical = 8.dp)) {
            SectionHeader(stringResource(R.string.set_role))
            RoleChoices(role) { vm.setRole(it) }
            HorizontalDivider(Modifier.padding(vertical = 8.dp))
            SectionHeader(stringResource(R.string.set_language))
            Column(Modifier.selectableGroup()) {
                RadioRow(stringResource(R.string.lang_system), lang.isEmpty()) { AppCompatDelegate.setApplicationLocales(LocaleListCompat.getEmptyLocaleList()) }
                RadioRow("English", lang == "en") { AppCompatDelegate.setApplicationLocales(LocaleListCompat.forLanguageTags("en")) }
                RadioRow("हिन्दी", lang == "hi") { AppCompatDelegate.setApplicationLocales(LocaleListCompat.forLanguageTags("hi")) }
            }
            HorizontalDivider(Modifier.padding(vertical = 8.dp))
            SectionHeader(stringResource(R.string.set_downloads))
            SwitchRow(stringResource(R.string.set_wifi_big), stringResource(R.string.set_wifi_big_desc), wifi) { wifi = it; vm.prefs.wifiOnlyBig = it }
            SwitchRow(stringResource(R.string.set_auto), stringResource(R.string.set_auto_desc), auto) { auto = it; vm.prefs.autoUpdate = it }
            SwitchRow(stringResource(R.string.set_notify), stringResource(R.string.set_notify_desc), notify) { notify = it; vm.prefs.notifyUpdates = it }
            HorizontalDivider(Modifier.padding(vertical = 8.dp))
            SectionHeader(stringResource(R.string.set_permission))
            Row(Modifier.fillMaxWidth().padding(horizontal = 16.dp, vertical = 8.dp), verticalAlignment = Alignment.CenterVertically) {
                Text(
                    stringResource(if (canInstall) R.string.perm_allowed else R.string.perm_not_allowed),
                    Modifier.weight(1f), style = MaterialTheme.typography.bodyMedium,
                )
                if (!canInstall) TextButton(onClick = openUnknownSources) { Text(stringResource(R.string.btn_open_settings)) }
            }
            HorizontalDivider(Modifier.padding(vertical = 8.dp))
            SectionHeader(stringResource(R.string.set_about))
            Text(
                stringResource(R.string.about_store, BuildConfig.VERSION_NAME),
                Modifier.padding(horizontal = 16.dp, vertical = 4.dp), style = MaterialTheme.typography.bodyMedium,
            )
        }
    }
}

@Composable
private fun RadioRow(label: String, selected: Boolean, onClick: () -> Unit) {
    Row(
        Modifier.fillMaxWidth().height(52.dp).selectable(selected = selected, onClick = onClick, role = Role.RadioButton).padding(horizontal = 16.dp),
        verticalAlignment = Alignment.CenterVertically,
    ) {
        RadioButton(selected = selected, onClick = null)
        Spacer(Modifier.width(12.dp))
        Text(label, style = MaterialTheme.typography.bodyLarge)
    }
}

@Composable
private fun SwitchRow(title: String, desc: String, checked: Boolean, onChange: (Boolean) -> Unit) {
    Row(
        Modifier.fillMaxWidth().clickable(role = Role.Switch) { onChange(!checked) }.padding(horizontal = 16.dp, vertical = 10.dp),
        verticalAlignment = Alignment.CenterVertically,
    ) {
        Column(Modifier.weight(1f)) {
            Text(title, style = MaterialTheme.typography.bodyLarge)
            Text(desc, style = MaterialTheme.typography.bodySmall, color = MaterialTheme.colorScheme.onSurfaceVariant)
        }
        Switch(checked = checked, onCheckedChange = null)
    }
}

@Composable
private fun RoleChoices(role: String, onPick: (String) -> Unit) {
    Column(Modifier.selectableGroup()) {
        RadioRow(stringResource(R.string.role_student), role == "student") { onPick("student") }
        RadioRow(stringResource(R.string.role_professor), role == "professor") { onPick("professor") }
        RadioRow(stringResource(R.string.role_everyone), role == "everyone") { onPick("everyone") }
    }
}

/* ------------------------------------------------------------------ first run */

@Composable
private fun Onboarding(vm: StoreViewModel, onDone: () -> Unit, openUnknownSources: () -> Unit) {
    var pick by rememberSaveable { mutableStateOf("") }
    Scaffold { pad ->
        Column(Modifier.padding(pad).fillMaxSize().verticalScroll(rememberScrollState()).padding(24.dp)) {
            Image(
                painter = androidx.compose.ui.res.painterResource(R.drawable.ic_launcher_foreground),
                contentDescription = null,
                modifier = Modifier.size(96.dp).clip(RoundedCornerShape(24.dp)).background(Color(0xFF4F46E5)),
            )
            Spacer(Modifier.height(16.dp))
            Text(stringResource(R.string.welcome_title), style = MaterialTheme.typography.headlineMedium, modifier = Modifier.semantics { heading() })
            Spacer(Modifier.height(8.dp))
            Text(stringResource(R.string.welcome_text), style = MaterialTheme.typography.bodyLarge)
            Spacer(Modifier.height(24.dp))
            Text(stringResource(R.string.who_are_you), style = MaterialTheme.typography.titleMedium, modifier = Modifier.semantics { heading() })
            Spacer(Modifier.height(8.dp))
            Column(Modifier.selectableGroup(), verticalArrangement = Arrangement.spacedBy(8.dp)) {
                for ((key, label, desc) in listOf(
                    Triple("student", R.string.role_student, R.string.role_student_desc),
                    Triple("professor", R.string.role_professor, R.string.role_professor_desc),
                    Triple("everyone", R.string.role_everyone, R.string.role_everyone_desc),
                )) {
                    val sel = pick == key
                    Card(
                        colors = CardDefaults.cardColors(
                            containerColor = if (sel) MaterialTheme.colorScheme.primaryContainer else MaterialTheme.colorScheme.surfaceVariant,
                        ),
                        modifier = Modifier.fillMaxWidth().selectable(selected = sel, onClick = { pick = key }, role = Role.RadioButton),
                    ) {
                        Row(Modifier.padding(16.dp), verticalAlignment = Alignment.CenterVertically) {
                            RadioButton(selected = sel, onClick = null)
                            Spacer(Modifier.width(12.dp))
                            Column {
                                Text(stringResource(label), style = MaterialTheme.typography.titleMedium)
                                Text(stringResource(desc), style = MaterialTheme.typography.bodySmall)
                            }
                        }
                    }
                }
            }
            Spacer(Modifier.height(20.dp))
            AllowInstallsCard(vm, openUnknownSources)
            Spacer(Modifier.height(24.dp))
            Button(
                onClick = { vm.setRole(pick); onDone() },
                enabled = pick.isNotEmpty(),
                modifier = Modifier.fillMaxWidth().height(52.dp),
            ) { Text(stringResource(R.string.btn_continue)) }
        }
    }
}

/** "Allow from this source" — what it is, and a button to the right settings page. */
@Composable
private fun AllowInstallsCard(vm: StoreViewModel, openUnknownSources: () -> Unit) {
    val can by vm.canInstall.collectAsState()
    Card(modifier = Modifier.fillMaxWidth()) {
        Column(Modifier.padding(16.dp)) {
            Row(verticalAlignment = Alignment.CenterVertically) {
                Icon(if (can) Icons.Filled.CheckCircle else Icons.Filled.Lock, contentDescription = null, tint = MaterialTheme.colorScheme.primary)
                Spacer(Modifier.width(10.dp))
                Text(stringResource(if (can) R.string.perm_allowed else R.string.allow_title), style = MaterialTheme.typography.titleSmall)
            }
            if (!can) {
                Spacer(Modifier.height(8.dp))
                Text(stringResource(R.string.allow_steps), style = MaterialTheme.typography.bodyMedium)
                Spacer(Modifier.height(8.dp))
                OutlinedButton(onClick = openUnknownSources) { Text(stringResource(R.string.btn_open_settings)) }
            }
        }
    }
}

@Composable
private fun AllowInstallsDialog(appName: String, onOpen: () -> Unit, onDismiss: () -> Unit) {
    AlertDialog(
        onDismissRequest = onDismiss,
        icon = { Icon(Icons.Filled.Lock, contentDescription = null) },
        title = { Text(stringResource(R.string.allow_title)) },
        text = { Text(stringResource(R.string.allow_dialog, appName) + "\n\n" + stringResource(R.string.allow_steps)) },
        confirmButton = { Button(onClick = onOpen) { Text(stringResource(R.string.btn_open_settings)) } },
        dismissButton = { TextButton(onClick = onDismiss) { Text(stringResource(R.string.btn_later)) } },
    )
}
