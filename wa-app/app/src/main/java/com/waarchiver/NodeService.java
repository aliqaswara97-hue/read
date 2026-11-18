package com.waarchiver;

import android.app.Notification;
import android.app.NotificationChannel;
import android.app.NotificationManager;
import android.app.Service;
import android.content.Context;
import android.content.Intent;
import android.content.SharedPreferences;
import android.content.pm.ServiceInfo;
import android.os.Build;
import android.os.IBinder;
import android.os.PowerManager;
import java.io.File;
import java.io.FileOutputStream;
import java.io.InputStream;
import java.io.OutputStream;

public class NodeService extends Service {
    static volatile boolean started = false;
    static volatile boolean exited = false;
    PowerManager.WakeLock wl;

    static native int startNode(String[] args, String logPath);

    static File dataDir(Context c) {
        File d = c.getExternalFilesDir(null);
        return d != null ? d : c.getFilesDir();
    }

    @Override public IBinder onBind(Intent i) { return null; }

    @Override public int onStartCommand(Intent intent, int flags, int startId) {
        NotificationChannel ch = new NotificationChannel("wa", "WA Archiver", NotificationManager.IMPORTANCE_LOW);
        getSystemService(NotificationManager.class).createNotificationChannel(ch);
        Notification n = new Notification.Builder(this, "wa")
                .setContentTitle("حفظ رسائل واتساب يعمل")
                .setSmallIcon(android.R.drawable.stat_notify_sync)
                .setOngoing(true).build();
        if (Build.VERSION.SDK_INT >= 34)
            startForeground(1, n, ServiceInfo.FOREGROUND_SERVICE_TYPE_SPECIAL_USE);
        else
            startForeground(1, n);

        if (!started) {
            started = true;
            wl = ((PowerManager) getSystemService(POWER_SERVICE))
                    .newWakeLock(PowerManager.PARTIAL_WAKE_LOCK, "wa:node");
            wl.acquire();
            new Thread(null, this::run, "node", 8 * 1024 * 1024).start();
        }
        return START_STICKY;
    }

    private void note(File log, String s) {
        try (FileOutputStream f = new FileOutputStream(log, true)) { f.write((s + "\n").getBytes()); }
        catch (Throwable ignored) {}
    }

    private void run() {
        File data = dataDir(this);
        File log = new File(data, "node.log");
        try {
            SharedPreferences sp = getSharedPreferences("p", MODE_PRIVATE);
            String port = String.valueOf(sp.getInt("port", 38117));
            String token = sp.getString("token", "dev");
            File js = new File(getFilesDir(), "main.js");
            try (InputStream in = getAssets().open("main.js"); OutputStream out = new FileOutputStream(js)) {
                byte[] b = new byte[16384];
                int r;
                while ((r = in.read(b)) > 0) out.write(b, 0, r);
            }
            System.loadLibrary("node");
            System.loadLibrary("native-lib");
            int code = startNode(new String[]{"node", js.getAbsolutePath(), data.getAbsolutePath(), port, token,
                    java.util.TimeZone.getDefault().getID()},
                    log.getAbsolutePath());
            note(log, "NODE EXIT code=" + code);
        } catch (Throwable t) {
            note(log, "ERROR: " + android.util.Log.getStackTraceString(t));
        }
        // Node can't be restarted in-process: mark it and let the user reopen the app
        exited = true;
        try { if (wl != null && wl.isHeld()) wl.release(); } catch (Throwable ignored) {}
        stopForeground(true);
        stopSelf();
    }
}
