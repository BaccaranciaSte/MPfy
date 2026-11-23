package com.baccarancia.mpfy

import android.content.Context
import android.net.ConnectivityManager
import android.net.Network
import android.net.NetworkCapabilities
import android.os.Handler
import android.os.Looper
import android.util.Log
import java.util.concurrent.CopyOnWriteArrayList
import org.json.JSONObject

/**
 * The default network as the UI wants it (getNetwork): type wifi | cellular | ethernet |
 * none, and whether it is metered. Callbacks run on the main thread.
 */
object Net {
  data class State(val type: String, val metered: Boolean)

  /** [switched] is true when the default network itself changed (the links must re-check). */
  fun interface Listener {
    fun onNetwork(state: State, switched: Boolean)
  }

  private const val TAG = "MPfyNet"
  private val listeners = CopyOnWriteArrayList<Listener>()
  private var cm: ConnectivityManager? = null
  private var current: Network? = null

  @Volatile
  var state: State = State("none", false)
    private set

  fun init(context: Context) {
    if (cm != null) return
    val c = context.applicationContext.getSystemService(ConnectivityManager::class.java)
    cm = c
    val active = c.activeNetwork
    current = active
    state = stateOf(active?.let { c.getNetworkCapabilities(it) })
    Log.i(TAG, "network ${state.type}${if (state.metered) " metered" else ""}")
    c.registerDefaultNetworkCallback(
      object : ConnectivityManager.NetworkCallback() {
        override fun onAvailable(network: Network) {
          val switched = network != current
          current = network
          update(stateOf(c.getNetworkCapabilities(network)), switched)
        }

        override fun onCapabilitiesChanged(network: Network, caps: NetworkCapabilities) {
          if (network != current) {
            current = network
            update(stateOf(caps), true)
          } else {
            update(stateOf(caps), false)
          }
        }

        override fun onLost(network: Network) {
          if (network != current) return
          current = null
          update(State("none", false), true)
        }
      },
      Handler(Looper.getMainLooper()),
    )
  }

  fun addListener(l: Listener) {
    listeners.add(l)
  }

  fun removeListener(l: Listener) {
    listeners.remove(l)
  }

  fun json(s: State = state): String = JSONObject().put("type", s.type).put("metered", s.metered).toString()

  private fun update(next: State, switched: Boolean) {
    val changed = next != state
    if (!changed && !switched) return
    state = next
    Log.i(TAG, "network ${next.type}${if (next.metered) " metered" else ""}${if (switched) " (switched)" else ""}")
    for (l in listeners) {
      try {
        l.onNetwork(next, switched)
      } catch (e: Exception) {
        Log.w(TAG, "listener", e)
      }
    }
  }

  private fun stateOf(caps: NetworkCapabilities?): State {
    if (caps == null || !caps.hasCapability(NetworkCapabilities.NET_CAPABILITY_INTERNET)) return State("none", false)
    val metered = !caps.hasCapability(NetworkCapabilities.NET_CAPABILITY_NOT_METERED)
    val type = when {
      caps.hasTransport(NetworkCapabilities.TRANSPORT_WIFI) -> "wifi"
      caps.hasTransport(NetworkCapabilities.TRANSPORT_CELLULAR) -> "cellular"
      caps.hasTransport(NetworkCapabilities.TRANSPORT_ETHERNET) -> "ethernet"
      // A VPN alone, Bluetooth or USB tethering: what matters for the quality is the cost.
      metered -> "cellular"
      else -> "wifi"
    }
    return State(type, metered)
  }
}
