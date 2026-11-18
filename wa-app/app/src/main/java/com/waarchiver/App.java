package com.waarchiver;

import android.app.Application;
import java.io.File;
import java.io.FileOutputStream;

public class App extends Application {
    @Override public void onCreate() {
        super.onCreate();
        final Thread.UncaughtExceptionHandler prev = Thread.getDefaultUncaughtExceptionHandler();
        Thread.setDefaultUncaughtExceptionHandler((t, e) -> {
            try (FileOutputStream f = new FileOutputStream(new File(NodeService.dataDir(this), "crash.txt"))) {
                f.write(android.util.Log.getStackTraceString(e).getBytes());
            } catch (Throwable ignored) {}
            if (prev != null) prev.uncaughtException(t, e);
        });
    }
}
