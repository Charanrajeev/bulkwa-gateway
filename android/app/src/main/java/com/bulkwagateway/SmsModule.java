// FILE: android/app/src/main/java/com/bulkwagateway/SmsModule.java
//
// This native module sends SMS using Android's SmsManager directly.
// No intent chooser dialog — sends silently in the background.

package com.bulkwagateway;

import android.app.Activity;
import android.app.PendingIntent;
import android.content.BroadcastReceiver;
import android.content.Context;
import android.content.Intent;
import android.content.IntentFilter;
import android.telephony.SmsManager;
import android.util.Log;

import com.facebook.react.bridge.Callback;
import com.facebook.react.bridge.ReactApplicationContext;
import com.facebook.react.bridge.ReactContextBaseJavaModule;
import com.facebook.react.bridge.ReactMethod;

import java.util.ArrayList;

public class SmsModule extends ReactContextBaseJavaModule {

    private static final String TAG = "BulkWASmsModule";
    private final ReactApplicationContext reactContext;

    SmsModule(ReactApplicationContext context) {
        super(context);
        this.reactContext = context;
    }

    @Override
    public String getName() {
        return "SmsModule";
    }

    @ReactMethod
    public void sendSms(String phoneNumber, String message, Callback callback) {
        try {
            SmsManager smsManager = SmsManager.getDefault();

            // Split long messages automatically
            ArrayList<String> parts = smsManager.divideMessage(message);

            String sentAction    = "SMS_SENT_" + System.currentTimeMillis();
            String deliveredAction = "SMS_DELIVERED_" + System.currentTimeMillis();

            // Create PendingIntents for sent & delivery receipts
            ArrayList<PendingIntent> sentIntents = new ArrayList<>();
            ArrayList<PendingIntent> deliveredIntents = new ArrayList<>();

            final int[] pendingCount = { parts.size() };
            final boolean[] hasFailed = { false };

            BroadcastReceiver sentReceiver = new BroadcastReceiver() {
                @Override
                public void onReceive(Context ctx, Intent intent) {
                    switch (getResultCode()) {
                        case Activity.RESULT_OK:
                            Log.d(TAG, "SMS part sent successfully to " + phoneNumber);
                            break;
                        case SmsManager.RESULT_ERROR_GENERIC_FAILURE:
                            hasFailed[0] = true;
                            Log.e(TAG, "SMS send failed: generic failure");
                            break;
                        case SmsManager.RESULT_ERROR_RADIO_OFF:
                            hasFailed[0] = true;
                            Log.e(TAG, "SMS send failed: radio off");
                            break;
                        case SmsManager.RESULT_ERROR_NULL_PDU:
                            hasFailed[0] = true;
                            Log.e(TAG, "SMS send failed: null PDU");
                            break;
                        case SmsManager.RESULT_ERROR_NO_SERVICE:
                            hasFailed[0] = true;
                            Log.e(TAG, "SMS send failed: no service");
                            break;
                    }

                    pendingCount[0]--;
                    if (pendingCount[0] <= 0) {
                        try {
                            reactContext.unregisterReceiver(this);
                        } catch (Exception e) { /* ignore */ }

                        if (hasFailed[0]) {
                            callback.invoke("SMS send failed");
                        } else {
                            callback.invoke((Object) null); // null = success
                        }
                    }
                }
            };

            reactContext.registerReceiver(sentReceiver, new IntentFilter(sentAction));

            for (int i = 0; i < parts.size(); i++) {
                PendingIntent sentPI = PendingIntent.getBroadcast(
                    reactContext, 0,
                    new Intent(sentAction),
                    PendingIntent.FLAG_IMMUTABLE
                );
                sentIntents.add(sentPI);
                deliveredIntents.add(null); // we don't need delivery confirmation
            }

            // Send (multipart handles both single and multi-part SMS)
            smsManager.sendMultipartTextMessage(
                phoneNumber,
                null,
                parts,
                sentIntents,
                deliveredIntents
            );

        } catch (Exception e) {
            Log.e(TAG, "sendSms exception: " + e.getMessage());
            callback.invoke("Exception: " + e.getMessage());
        }
    }
}
