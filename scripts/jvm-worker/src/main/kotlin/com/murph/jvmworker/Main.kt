package com.murph.jvmworker

import com.cncverse.stremiobridge.plugin.GlobalPluginManager
import com.cncverse.stremiobridge.plugin.PluginLoader
import com.cncverse.stremiobridge.repo.PluginInstaller
import com.cncverse.stremiobridge.repo.RepoManager
import com.cncverse.stremiobridge.repo.DEFAULT_REPO_URL
import com.cncverse.stremiobridge.server.StremioServer
import com.cncverse.stremiobridge.state.RepoState
import kotlinx.coroutines.awaitCancellation
import kotlinx.coroutines.runBlocking
import java.io.File

/**
 * Headless entry point for the upstream CloudStream runtime.
 *
 * The upstream project owns the DEX-to-JVM transformer and CloudStream API
 * compatibility layer. Murph deliberately keeps this launcher separate from
 * the Node process and proxies the Stremio protocol when it is available.
 */
fun main() = runBlocking<Unit> {
    val port = System.getenv("PORT")?.toIntOrNull() ?: 8787
    val cacheDir = File(System.getenv("MURPH_JVM_CACHE_DIR") ?: "./data/jvm").apply {
        mkdirs()
    }

    val repositories = System.getenv("MURPH_CLOUDSTREAM_REPOSITORIES")
        ?.split(",")
        ?.map(String::trim)
        ?.filter(String::isNotBlank)
        ?.ifEmpty { listOf(DEFAULT_REPO_URL) }
        ?: listOf(DEFAULT_REPO_URL)
    repositories.forEach { RepoManager.addRepo(it) }
    RepoManager.refreshAllRepos()

    val available = RepoState.availablePlugins.value
    available.forEach { availablePlugin ->
        runCatching {
            PluginInstaller.installPlugin(availablePlugin, cacheDir.absolutePath)
        }.onFailure {
            println("CloudStream plugin ${availablePlugin.plugin.internalName} was not installed: ${it.message}")
        }
    }

    val installed = PluginInstaller.loadInstalledPlugins(cacheDir.absolutePath)
    val files = PluginInstaller.getInstalledFiles(cacheDir.absolutePath)
    GlobalPluginManager.loader = PluginLoader()
    GlobalPluginManager.reloadAllPlugins(installed, files)

    StremioServer.start(port, cacheDir.absolutePath)
    println("Murph JVM runtime listening on $port with ${installed.size} installed plugins")
    awaitCancellation()
}