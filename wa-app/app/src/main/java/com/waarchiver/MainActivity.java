package com.waarchiver;

import android.app.Activity;
import android.content.ContentValues;
import android.content.Intent;
import android.content.SharedPreferences;
import android.net.Uri;
import android.os.Build;
import android.os.Bundle;
import android.os.Environment;
import android.os.Handler;
import android.os.Looper;
import android.os.PowerManager;
import android.provider.MediaStore;
import android.provider.Settings;
import android.text.TextUtils;
import android.webkit.JavascriptInterface;
import android.webkit.WebResourceError;
import android.webkit.WebResourceRequest;
import android.webkit.WebSettings;
import android.webkit.WebView;
import android.webkit.WebViewClient;
import android.widget.Toast;
import java.io.File;
import java.io.FileInputStream;
import java.io.FileOutputStream;
import java.io.InputStream;
import java.io.OutputStream;
import java.io.RandomAccessFile;
import java.security.SecureRandom;
import java.util.Arrays;
import java.util.UUID;

public class MainActivity extends Activity {
    WebView web;
    SharedPreferences sp;
    int tries = 0;
    final Handler h = new Handler(Looper.getMainLooper());

    @Override protected void onCreate(Bundle b) {
        super.onCreate(b);
        sp = getSharedPreferences("p", MODE_PRIVATE);
        if (!sp.contains("token")) {
            sp.edit().putInt("port", 20000 + new SecureRandom().nextInt(30000))
                    .putString("token", UUID.randomUUID().toString().replace("-", "")).apply();
        }
        getWindow().setStatusBarColor(0xFF008069);

        web = new WebView(this);
        setContentView(web);
        WebSettings ws = web.getSettings();
        ws.setJavaScriptEnabled(true);
        ws.setDomStorageEnabled(true);
        ws.setMediaPlaybackRequiresUserGesture(false);
        web.addJavascriptInterface(new Bridge(), "Android");
        web.setDownloadListener((url, ua, cd, mime, len) -> new Thread(() -> {
            try {
                java.net.HttpURLConnection c = (java.net.HttpURLConnection) new java.net.URL(url).openConnection();
                c.setRequestProperty("Cookie", "tk=" + sp.getString("token", "dev"));
                ContentValues cv = new ContentValues();
                cv.put(MediaStore.Downloads.DISPLAY_NAME, android.webkit.URLUtil.guessFileName(url, cd, mime));
                cv.put(MediaStore.Downloads.MIME_TYPE, mime == null ? "application/octet-stream" : mime);
                cv.put(MediaStore.Downloads.RELATIVE_PATH, Environment.DIRECTORY_DOWNLOADS);
                Uri du = getContentResolver().insert(MediaStore.Downloads.EXTERNAL_CONTENT_URI, cv);
                try (InputStream in = c.getInputStream(); OutputStream out = getContentResolver().openOutputStream(du)) {
                    byte[] buf = new byte[16384];
                    int n;
                    while ((n = in.read(buf)) > 0) out.write(buf, 0, n);
                }
                runOnUiThread(() -> Toast.makeText(this, "تم الحفظ في التنزيلات", Toast.LENGTH_SHORT).show());
            } catch (Exception ex) {
                runOnUiThread(() -> Toast.makeText(this, "فشل: " + ex, Toast.LENGTH_LONG).show());
            }
        }).start());
        web.setWebViewClient(new WebViewClient() {
            @Override public void onReceivedError(WebView v, WebResourceRequest r, WebResourceError e) {
                if (!r.isForMainFrame()) return;
                if (tries < 8) h.postDelayed(() -> load(), 1500);
                else showDiag();
            }
        });

        int fails = sp.getInt("fails", 0);
        sp.edit().putInt("fails", fails + 1).apply();
        if (fails >= 2 || new File(NodeService.dataDir(this), "crash.txt").exists()) {
            showDiag();
            return;
        }
        begin();
    }

    void begin() {
        try {
            if (Build.VERSION.SDK_INT >= 33)
                requestPermissions(new String[]{"android.permission.POST_NOTIFICATIONS"}, 1);
            startForegroundService(new Intent(this, NodeService.class));
            tries = 0;
            h.postDelayed(() -> load(), 1500);
            PowerManager pm = (PowerManager) getSystemService(POWER_SERVICE);
            if (!pm.isIgnoringBatteryOptimizations(getPackageName()) && !sp.getBoolean("batAsked", false)) {
                sp.edit().putBoolean("batAsked", true).apply();
                startActivity(new Intent(Settings.ACTION_REQUEST_IGNORE_BATTERY_OPTIMIZATIONS,
                        Uri.parse("package:" + getPackageName())));
            }
        } catch (Throwable t) {
            try (FileOutputStream f = new FileOutputStream(new File(NodeService.dataDir(this), "crash.txt"))) {
                f.write(android.util.Log.getStackTraceString(t).getBytes());
            } catch (Exception ignored) {}
            showDiag();
        }
    }

    void load() {
        tries++;
        web.loadUrl("http://127.0.0.1:" + sp.getInt("port", 38117) + "/?t=" + sp.getString("token", "dev"));
    }

    String tail(File f, int n) {
        try (RandomAccessFile r = new RandomAccessFile(f, "r")) {
            long len = r.length(), start = Math.max(0, len - n);
            byte[] buf = new byte[(int) (len - start)];
            r.seek(start);
            r.readFully(buf);
            return new String(buf, "UTF-8");
        } catch (Exception e) { return String.valueOf(e); }
    }

    void showDiag() {
        StringBuilder sb = new StringBuilder();
        sb.append("Android ").append(Build.VERSION.SDK_INT).append(" | ABI ")
                .append(Arrays.toString(Build.SUPPORTED_ABIS)).append("\n");
        for (String n : new String[]{"crash.txt", "node.log"}) {
            File f = new File(NodeService.dataDir(this), n);
            sb.append("\n== ").append(n).append(f.exists() ? "" : " (غير موجود)").append(" ==\n");
            if (f.exists()) sb.append(tail(f, 3500)).append("\n");
        }
        String html = "<html><body style='font-family:sans-serif;padding:12px'><h3>تعذّر تشغيل المحرك</h3>"
                + "<p>أرسل لقطة شاشة لهذه الصفحة.</p>"
                + "<p><a href='javascript:Android.retry()'>إعادة المحاولة</a></p>"
                + "<pre dir='ltr' style='white-space:pre-wrap;font-size:11px'>"
                + TextUtils.htmlEncode(sb.toString()) + "</pre></body></html>";
        web.loadDataWithBaseURL(null, html, "text/html", "utf-8", null);
    }

    @Override public void onBackPressed() {
        web.evaluateJavascript("window.goBack&&window.goBack()", v -> {
            if (!"true".equals(v)) moveTaskToBack(true);
        });
    }

    class Bridge {
        @JavascriptInterface public void exportMessages(String acc) { runOnUiThread(() -> export(acc)); }
        @JavascriptInterface public void ok() { sp.edit().putInt("fails", 0).apply(); }
        @JavascriptInterface public void retry() {
            runOnUiThread(() -> {
                new File(NodeService.dataDir(MainActivity.this), "crash.txt").delete();
                sp.edit().putInt("fails", 0).apply();
                if (NodeService.exited) android.os.Process.killProcess(android.os.Process.myPid());
                else begin();
            });
        }
    }

    void export(String acc) {
        try {
            if (!"wa".equals(acc) && !"biz".equals(acc)) return;
            File f = new File(new File(NodeService.dataDir(this), acc), "messages.jsonl");
            if (!f.exists()) { Toast.makeText(this, "لا توجد رسائل بعد", Toast.LENGTH_SHORT).show(); return; }
            ContentValues v = new ContentValues();
            v.put(MediaStore.Downloads.DISPLAY_NAME, "whatsapp-" + acc + "-" + System.currentTimeMillis() + ".jsonl");
            v.put(MediaStore.Downloads.MIME_TYPE, "application/octet-stream");
            v.put(MediaStore.Downloads.RELATIVE_PATH, Environment.DIRECTORY_DOWNLOADS);
            Uri u = getContentResolver().insert(MediaStore.Downloads.EXTERNAL_CONTENT_URI, v);
            try (InputStream in = new FileInputStream(f); OutputStream out = getContentResolver().openOutputStream(u)) {
                byte[] buf = new byte[16384];
                int r;
                while ((r = in.read(buf)) > 0) out.write(buf, 0, r);
            }
            Toast.makeText(this, "تم الحفظ في التنزيلات", Toast.LENGTH_LONG).show();
        } catch (Exception e) {
            Toast.makeText(this, "فشل: " + e, Toast.LENGTH_LONG).show();
        }
    }
}
