package com.waarchiver;

import android.content.BroadcastReceiver;
import android.content.Context;
import android.content.Intent;

public class BootReceiver extends BroadcastReceiver {
    @Override public void onReceive(Context c, Intent i) {
        try {
            c.startForegroundService(new Intent(c, NodeService.class));
        } catch (Throwable ignored) {}
    }
}
