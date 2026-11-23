package com.baccarancia.mpfy

import android.app.Application

class MPfyApp : Application() {
  override fun onCreate() {
    super.onCreate()
    // Order matters: the keeper and the network watcher exist before the worklet uses them.
    Keeper.init(this)
    Net.init(this)
    // Before the worklet: the core's first events go to them.
    IdentityFile.init(this)
    Uploads.init(this)
    Prefetch.init(this)
    Likes.init(this)
    Chats.init(this)
    Browse.init(this)
    // Only the verified APK of a pending update survives a start.
    Updates.init(this)
    // The phone's own music: its index checks MediaStore at start and feeds the core once it says hello.
    LocalMusic.init(this)
    // The client core must run whenever the process does (a Bluetooth "play" can start the
    // PlaybackService with no Activity), so the worklet belongs to the process, not the Activity.
    CoreHost.init(this)
    // DownloadManager binds its handler to the creating thread: create it on the main thread.
    Downloads.manager(this)
    Folders.init(this)
  }
}
