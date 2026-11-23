package com.baccarancia.mpfy

import android.Manifest
import android.content.Intent
import android.content.pm.PackageManager
import android.graphics.Color
import android.graphics.drawable.GradientDrawable
import android.os.Bundle
import android.util.Log
import android.util.Size
import android.util.TypedValue
import android.view.Gravity
import android.view.View
import android.widget.FrameLayout
import android.widget.ImageButton
import android.widget.TextView
import androidx.activity.ComponentActivity
import androidx.activity.result.contract.ActivityResultContracts
import androidx.camera.core.CameraSelector
import androidx.camera.core.ImageAnalysis
import androidx.camera.core.ImageProxy
import androidx.camera.core.Preview
import androidx.camera.core.resolutionselector.ResolutionSelector
import androidx.camera.core.resolutionselector.ResolutionStrategy
import androidx.camera.lifecycle.ProcessCameraProvider
import androidx.camera.view.PreviewView
import androidx.core.content.ContextCompat
import androidx.core.view.ViewCompat
import androidx.core.view.WindowInsetsCompat
import com.google.zxing.BinaryBitmap
import com.google.zxing.DecodeHintType
import com.google.zxing.PlanarYUVLuminanceSource
import com.google.zxing.ReaderException
import com.google.zxing.common.HybridBinarizer
import com.google.zxing.qrcode.QRCodeReader
import java.util.concurrent.ExecutorService
import java.util.concurrent.Executors

/**
 * The QR scanner, full screen: the back camera's picture (CameraX) and a decoder that runs on the
 * phone alone (ZXing core, offline). The camera permission is asked the first time. A code of
 * ours ([CodeLinks.scanned]) closes it with that text ([EXTRA_TEXT], RESULT_OK); any other QR code
 * says so under the frame and the scan goes on. [EXTRA_STATE] tells the rest: "cancel" (closed),
 * "denied" (no camera permission), "error" (no camera).
 */
class ScanActivity : ComponentActivity() {
  companion object {
    const val EXTRA_STATE = "state"
    const val EXTRA_TEXT = "text"
    private const val TAG = "ScanActivity"
    private const val FOREIGN_MS = 2500L
  }

  private lateinit var preview: PreviewView
  private lateinit var note: TextView
  private val analysis: ExecutorService = Executors.newSingleThreadExecutor()
  private val reader = QRCodeReader()
  private val hints = mapOf(DecodeHintType.TRY_HARDER to true)
  @Volatile private var done = false
  private var foreignShown = 0L
  private val hideNote = Runnable { note.visibility = View.INVISIBLE }

  private val askCamera = registerForActivityResult(ActivityResultContracts.RequestPermission()) { granted ->
    if (granted) start() else end("denied", null)
  }

  override fun onCreate(savedInstanceState: Bundle?) {
    super.onCreate(savedInstanceState)
    val dp = { v: Int -> TypedValue.applyDimension(TypedValue.COMPLEX_UNIT_DIP, v.toFloat(), resources.displayMetrics).toInt() }
    val root = FrameLayout(this).apply { setBackgroundColor(Color.BLACK) }
    preview = PreviewView(this).apply { scaleType = PreviewView.ScaleType.FILL_CENTER }
    root.addView(preview, FrameLayout.LayoutParams(FrameLayout.LayoutParams.MATCH_PARENT, FrameLayout.LayoutParams.MATCH_PARENT))
    // The frame to aim with: the whole picture is read, the frame only shows where.
    val frame = View(this).apply {
      background = GradientDrawable().apply {
        setStroke(dp(3), Color.WHITE)
        cornerRadius = dp(18).toFloat()
      }
    }
    root.addView(frame, FrameLayout.LayoutParams(dp(260), dp(260), Gravity.CENTER))
    val bars = FrameLayout(this)
    root.addView(bars, FrameLayout.LayoutParams(FrameLayout.LayoutParams.MATCH_PARENT, FrameLayout.LayoutParams.MATCH_PARENT))
    val title = TextView(this).apply {
      text = getString(R.string.scan_title)
      setTextColor(Color.WHITE)
      setTextSize(TypedValue.COMPLEX_UNIT_SP, 18f)
      gravity = Gravity.CENTER
      setShadowLayer(6f, 0f, 1f, Color.BLACK)
    }
    bars.addView(title, FrameLayout.LayoutParams(FrameLayout.LayoutParams.MATCH_PARENT, dp(56), Gravity.TOP).apply { leftMargin = dp(56); rightMargin = dp(56) })
    val close = ImageButton(this).apply {
      setImageResource(R.drawable.ic_close)
      setBackgroundColor(Color.TRANSPARENT)
      contentDescription = getString(R.string.scan_close)
      setOnClickListener { end("cancel", null) }
    }
    bars.addView(close, FrameLayout.LayoutParams(dp(56), dp(56), Gravity.TOP or Gravity.START))
    note = TextView(this).apply {
      text = getString(R.string.scan_foreign)
      setTextColor(Color.WHITE)
      setTextSize(TypedValue.COMPLEX_UNIT_SP, 16f)
      gravity = Gravity.CENTER
      setPadding(dp(16), dp(10), dp(16), dp(10))
      background = GradientDrawable().apply {
        setColor(0xCC000000.toInt())
        cornerRadius = dp(20).toFloat()
      }
      visibility = View.INVISIBLE
    }
    bars.addView(note, FrameLayout.LayoutParams(FrameLayout.LayoutParams.WRAP_CONTENT, FrameLayout.LayoutParams.WRAP_CONTENT, Gravity.BOTTOM or Gravity.CENTER_HORIZONTAL).apply { bottomMargin = dp(48) })
    ViewCompat.setOnApplyWindowInsetsListener(bars) { v, insets ->
      val b = insets.getInsets(WindowInsetsCompat.Type.systemBars() or WindowInsetsCompat.Type.displayCutout())
      v.setPadding(b.left, b.top, b.right, b.bottom)
      WindowInsetsCompat.CONSUMED
    }
    setContentView(root)

    if (ContextCompat.checkSelfPermission(this, Manifest.permission.CAMERA) == PackageManager.PERMISSION_GRANTED) start()
    else askCamera.launch(Manifest.permission.CAMERA)
  }

  private fun start() {
    val future = ProcessCameraProvider.getInstance(this)
    future.addListener(
      {
        if (done || isDestroyed) return@addListener
        try {
          val provider = future.get()
          val shown = Preview.Builder().build().also { it.setSurfaceProvider(preview.surfaceProvider) }
          val frames = ImageAnalysis.Builder()
            .setResolutionSelector(
              ResolutionSelector.Builder()
                .setResolutionStrategy(ResolutionStrategy(Size(1280, 720), ResolutionStrategy.FALLBACK_RULE_CLOSEST_HIGHER_THEN_LOWER))
                .build(),
            )
            .setBackpressureStrategy(ImageAnalysis.STRATEGY_KEEP_ONLY_LATEST)
            .build()
          frames.setAnalyzer(analysis) { image -> read(image) }
          provider.unbindAll()
          provider.bindToLifecycle(this, CameraSelector.DEFAULT_BACK_CAMERA, shown, frames)
        } catch (e: Exception) {
          Log.w(TAG, "camera", e)
          end("error", null)
        }
      },
      ContextCompat.getMainExecutor(this),
    )
  }

  /** One frame: its luminance (the Y plane) through the QR reader. */
  private fun read(image: ImageProxy) {
    try {
      if (done) return
      val plane = image.planes[0]
      val buf = plane.buffer
      val bytes = ByteArray(buf.remaining())
      buf.get(bytes)
      val stride = plane.rowStride
      val height = image.height
      if (bytes.size < stride * (height - 1) + image.width) return
      // The last row may stop at the picture's width: the source reads rows, never past it.
      val data = if (bytes.size >= stride * height) bytes else bytes.copyOf(stride * height)
      val source = PlanarYUVLuminanceSource(data, stride, height, 0, 0, image.width, height, false)
      val text = try {
        reader.decode(BinaryBitmap(HybridBinarizer(source)), hints).text
      } catch (e: ReaderException) {
        null
      } finally {
        reader.reset()
      }
      if (text == null) return
      val ours = CodeLinks.scanned(text)
      runOnUiThread { if (ours != null) end("ok", ours) else foreign() }
    } finally {
      image.close()
    }
  }

  /** Another QR code in view: said under the frame for a moment, once per [FOREIGN_MS]. */
  private fun foreign() {
    if (done) return
    val now = System.currentTimeMillis()
    if (now - foreignShown < FOREIGN_MS) return
    foreignShown = now
    note.visibility = View.VISIBLE
    note.removeCallbacks(hideNote)
    note.postDelayed(hideNote, FOREIGN_MS)
  }

  private fun end(state: String, text: String?) {
    if (done) return
    done = true
    val data = Intent().putExtra(EXTRA_STATE, state)
    if (text != null) data.putExtra(EXTRA_TEXT, text)
    setResult(if (state == "ok") RESULT_OK else RESULT_CANCELED, data)
    finish()
  }

  override fun onDestroy() {
    note.removeCallbacks(hideNote)
    analysis.shutdown()
    super.onDestroy()
  }
}
