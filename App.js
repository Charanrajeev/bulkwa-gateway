// BulkWA SMS Gateway - React Native App
// Runs an HTTP server on the phone that accepts SMS send requests
// from the BulkWA Chrome extension over local WiFi.
//
// SETUP:
//   npm install
//   npx react-native run-android
//
// PERMISSIONS needed in AndroidManifest.xml (see android/ folder instructions):
//   SEND_SMS, INTERNET, ACCESS_NETWORK_STATE, ACCESS_WIFI_STATE

import React, { useState, useEffect, useRef, useCallback } from 'react';
import {
  View, Text, StyleSheet, ScrollView, TouchableOpacity,
  Switch, TextInput, PermissionsAndroid, Platform,
  NativeModules, Alert, StatusBar, Animated, Easing,
} from 'react-native';
import TcpSocket from 'react-native-tcp-socket';
import NetInfo from '@react-native-community/netinfo';

// ── SMS Sender (uses Android SmsManager via NativeModule) ──
// We call the native Android SmsManager directly.
// See android/app/src/main/java/com/bulkwagateway/SmsModule.java
const { SmsModule } = NativeModules;

function sendSmsNative(phoneNumber, message) {
  return new Promise((resolve, reject) => {
    if (!SmsModule) {
      reject(new Error('SmsModule not available — check native setup'));
      return;
    }
    SmsModule.sendSms(phoneNumber, message, (error) => {
      if (error) reject(new Error(error));
      else resolve(true);
    });
  });
}

// ── Simple HTTP Request Parser ──
function parseHttpRequest(data) {
  try {
    const text = data.toString();
    const lines = text.split('\r\n');
    const [method, path] = lines[0].split(' ');
    const headers = {};
    let bodyStart = -1;
    for (let i = 1; i < lines.length; i++) {
      if (lines[i] === '') { bodyStart = i + 1; break; }
      const [k, ...v] = lines[i].split(': ');
      headers[k.toLowerCase()] = v.join(': ');
    }
    const body = bodyStart > 0 ? lines.slice(bodyStart).join('\r\n') : '';
    let json = null;
    try { json = JSON.parse(body); } catch {}
    return { method, path, headers, body, json };
  } catch {
    return null;
  }
}

// ── HTTP Response Builder ──
function httpResponse(statusCode, statusText, body, extraHeaders = {}) {
  const bodyStr = typeof body === 'string' ? body : JSON.stringify(body);
  const headers = {
    'Content-Type': 'application/json',
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type, Authorization',
    'Content-Length': Buffer.byteLength(bodyStr),
    ...extraHeaders,
  };
  const headerStr = Object.entries(headers).map(([k, v]) => `${k}: ${v}`).join('\r\n');
  return `HTTP/1.1 ${statusCode} ${statusText}\r\n${headerStr}\r\n\r\n${bodyStr}`;
}

const PORT = 3000;

// ── Rate limiting state ──
const rateLimiter = { count: 0, windowStart: Date.now() };
function checkRateLimit(limitPerMinute) {
  const now = Date.now();
  if (now - rateLimiter.windowStart > 60000) {
    rateLimiter.count = 0;
    rateLimiter.windowStart = now;
  }
  rateLimiter.count++;
  return rateLimiter.count <= limitPerMinute;
}

export default function App() {
  const [serverRunning, setServerRunning] = useState(false);
  const [localIP, setLocalIP] = useState('Loading…');
  const [logs, setLogs] = useState([]);
  const [stats, setStats] = useState({ sent: 0, failed: 0, total: 0 });
  const [apiKey, setApiKey] = useState('bulkwa-secret');
  const [rateLimit, setRateLimit] = useState('60');
  const [requireAuth, setRequireAuth] = useState(true);
  const [smsDelay, setSmsDelay] = useState('1000');
  const [queue, setQueue] = useState([]);
  const serverRef = useRef(null);
  const scrollRef = useRef(null);
  const pulseAnim = useRef(new Animated.Value(1)).current;

  // Pulse animation for active server indicator
  useEffect(() => {
    if (serverRunning) {
      Animated.loop(
        Animated.sequence([
          Animated.timing(pulseAnim, { toValue: 1.3, duration: 800, easing: Easing.inOut(Easing.ease), useNativeDriver: true }),
          Animated.timing(pulseAnim, { toValue: 1,   duration: 800, easing: Easing.inOut(Easing.ease), useNativeDriver: true }),
        ])
      ).start();
    } else {
      pulseAnim.setValue(1);
    }
  }, [serverRunning]);

  // Get local WiFi IP
  useEffect(() => {
    const unsubscribe = NetInfo.addEventListener(state => {
      if (state.type === 'wifi' && state.details?.ipAddress) {
        setLocalIP(state.details.ipAddress);
      } else {
        setLocalIP('Not on WiFi');
      }
    });
    return () => unsubscribe();
  }, []);

  const addLog = useCallback((msg, type = 'info') => {
    const time = new Date().toLocaleTimeString('en-IN');
    setLogs(prev => {
      const next = [...prev, { msg, type, time, id: Date.now() + Math.random() }];
      return next.slice(-200); // keep last 200 entries
    });
    setTimeout(() => scrollRef.current?.scrollToEnd({ animated: true }), 100);
  }, []);

  const requestSmsPermission = async () => {
    if (Platform.OS !== 'android') return true;
    try {
      const result = await PermissionsAndroid.request(
        PermissionsAndroid.PERMISSIONS.SEND_SMS,
        {
          title: 'SMS Permission',
          message: 'BulkWA Gateway needs permission to send SMS messages.',
          buttonPositive: 'Allow',
          buttonNegative: 'Deny',
        }
      );
      return result === PermissionsAndroid.RESULTS.GRANTED;
    } catch {
      return false;
    }
  };

  // ── Process a single SMS request ──
  const processSmsRequest = useCallback(async (req, socket) => {
    const { json } = req;

    if (!json || !json.phone || !json.message) {
      socket.write(httpResponse(400, 'Bad Request', { error: 'Missing phone or message' }));
      return;
    }

    const phone = String(json.phone).replace(/[^\d+]/g, '');
    const message = String(json.message);
    const delay = parseInt(smsDelay) || 1000;

    addLog(`📤 SMS → ${phone}`, 'send');

    // Respect delay between SMS sends
    await new Promise(r => setTimeout(r, delay));

    try {
      await sendSmsNative(phone, message);
      addLog(`✅ Sent → ${phone}`, 'ok');
      setStats(s => ({ ...s, sent: s.sent + 1, total: s.total + 1 }));
      socket.write(httpResponse(200, 'OK', { success: true, phone }));
    } catch (err) {
      addLog(`❌ Failed → ${phone}: ${err.message}`, 'err');
      setStats(s => ({ ...s, failed: s.failed + 1, total: s.total + 1 }));
      socket.write(httpResponse(500, 'Internal Error', { success: false, error: err.message, phone }));
    }
  }, [smsDelay, addLog]);

  // ── Handle incoming HTTP request ──
  const handleRequest = useCallback(async (req, socket) => {
    const { method, path } = req;

    // Handle CORS preflight
    if (method === 'OPTIONS') {
      socket.write(httpResponse(200, 'OK', '{}'));
      return;
    }

    // Auth check
    if (requireAuth) {
      const authHeader = req.headers['authorization'] || req.headers['x-api-key'] || '';
      const token = authHeader.replace('Bearer ', '');
      if (token !== apiKey) {
        addLog(`🔒 Auth failed from ${path}`, 'err');
        socket.write(httpResponse(401, 'Unauthorized', { error: 'Invalid API key' }));
        return;
      }
    }

    // Rate limit
    const limit = parseInt(rateLimit) || 60;
    if (!checkRateLimit(limit)) {
      socket.write(httpResponse(429, 'Too Many Requests', { error: 'Rate limit exceeded' }));
      return;
    }

    // Routes
    if (path === '/ping' || path === '/') {
      socket.write(httpResponse(200, 'OK', {
        status: 'online',
        server: 'BulkWA SMS Gateway',
        version: '1.0',
        stats,
      }));
      return;
    }

    if (path === '/send' && method === 'POST') {
      await processSmsRequest(req, socket);
      return;
    }

    if (path === '/send-batch' && method === 'POST') {
      const { json } = req;
      if (!json || !Array.isArray(json.messages)) {
        socket.write(httpResponse(400, 'Bad Request', { error: 'messages array required' }));
        return;
      }
      // Acknowledge immediately, process in background
      socket.write(httpResponse(202, 'Accepted', {
        accepted: json.messages.length,
        message: 'Batch queued',
      }));
      setQueue(prev => [...prev, ...json.messages]);
      addLog(`📦 Batch of ${json.messages.length} queued`, 'info');
      return;
    }

    if (path === '/stats' && method === 'GET') {
      socket.write(httpResponse(200, 'OK', stats));
      return;
    }

    if (path === '/reset-stats' && method === 'POST') {
      setStats({ sent: 0, failed: 0, total: 0 });
      socket.write(httpResponse(200, 'OK', { message: 'Stats reset' }));
      return;
    }

    socket.write(httpResponse(404, 'Not Found', { error: 'Unknown endpoint' }));
  }, [requireAuth, apiKey, rateLimit, stats, processSmsRequest, addLog]);

  // ── Process batch queue ──
  useEffect(() => {
    if (queue.length === 0 || !serverRunning) return;
    const [first, ...rest] = queue;
    setQueue(rest);
    const delay = parseInt(smsDelay) || 1000;

    const send = async () => {
      const phone = String(first.phone || '').replace(/[^\d+]/g, '');
      const message = String(first.message || '');
      if (!phone || !message) return;
      addLog(`📤 Batch SMS → ${phone}`, 'send');
      await new Promise(r => setTimeout(r, delay));
      try {
        await sendSmsNative(phone, message);
        addLog(`✅ Batch sent → ${phone}`, 'ok');
        setStats(s => ({ ...s, sent: s.sent + 1, total: s.total + 1 }));
      } catch (err) {
        addLog(`❌ Batch failed → ${phone}: ${err.message}`, 'err');
        setStats(s => ({ ...s, failed: s.failed + 1, total: s.total + 1 }));
      }
    };
    send();
  }, [queue, serverRunning, smsDelay, addLog]);

  // ── Start TCP server ──
  const startServer = useCallback(async () => {
    const hasPermission = await requestSmsPermission();
    if (!hasPermission) {
      Alert.alert('Permission Denied', 'SMS permission is required to send messages.');
      return;
    }

    if (serverRef.current) {
      serverRef.current.close();
      serverRef.current = null;
    }

    const server = TcpSocket.createServer((socket) => {
      let buffer = '';

      socket.on('data', async (data) => {
        buffer += data.toString();
        // Simple HTTP: check if we have full headers + body
        if (buffer.includes('\r\n\r\n')) {
          const req = parseHttpRequest(buffer);
          buffer = '';
          if (req) {
            try {
              await handleRequest(req, socket);
            } catch (err) {
              addLog(`⚠️ Handler error: ${err.message}`, 'err');
              try { socket.write(httpResponse(500, 'Error', { error: err.message })); } catch {}
            }
          }
        }
      });

      socket.on('error', () => {});
      socket.on('close', () => {});
    });

    server.on('error', (err) => {
      addLog(`🔴 Server error: ${err.message}`, 'err');
      setServerRunning(false);
    });

    server.listen({ port: PORT, host: '0.0.0.0' }, () => {
      setServerRunning(true);
      addLog(`🟢 Server started on port ${PORT}`, 'ok');
      addLog(`📡 Connect from extension: http://${localIP}:${PORT}`, 'info');
    });

    serverRef.current = server;
  }, [handleRequest, addLog, localIP]);

  const stopServer = useCallback(() => {
    if (serverRef.current) {
      serverRef.current.close();
      serverRef.current = null;
    }
    setServerRunning(false);
    addLog('🔴 Server stopped', 'err');
  }, [addLog]);

  const clearLogs = () => setLogs([]);

  return (
    <View style={styles.container}>
      <StatusBar barStyle="light-content" backgroundColor="#0d1117" />

      {/* Header */}
      <View style={styles.header}>
        <Text style={styles.headerTitle}>💬 BulkWA <Text style={styles.headerSub}>SMS Gateway</Text></Text>
        <Text style={styles.headerVersion}>v1.0</Text>
      </View>

      <ScrollView style={styles.scroll} showsVerticalScrollIndicator={false}>

        {/* Status Card */}
        <View style={styles.card}>
          <View style={styles.statusRow}>
            <View style={styles.statusLeft}>
              <Animated.View style={[styles.statusDot, serverRunning ? styles.dotGreen : styles.dotRed, { transform: [{ scale: serverRunning ? pulseAnim : 1 }] }]} />
              <Text style={styles.statusText}>{serverRunning ? 'Server Running' : 'Server Stopped'}</Text>
            </View>
            <TouchableOpacity
              style={[styles.serverBtn, serverRunning ? styles.btnStop : styles.btnStart]}
              onPress={serverRunning ? stopServer : startServer}
            >
              <Text style={styles.serverBtnText}>{serverRunning ? '⏹ Stop' : '▶ Start'}</Text>
            </TouchableOpacity>
          </View>

          {serverRunning && (
            <View style={styles.ipBox}>
              <Text style={styles.ipLabel}>Extension URL:</Text>
              <Text style={styles.ipValue}>http://{localIP}:{PORT}</Text>
              <Text style={styles.ipHint}>Paste this in the BulkWA extension → SMS tab</Text>
            </View>
          )}
        </View>

        {/* Stats */}
        <View style={styles.statsRow}>
          <View style={[styles.statBox, { borderColor: '#25d366' }]}>
            <Text style={[styles.statVal, { color: '#25d366' }]}>{stats.sent}</Text>
            <Text style={styles.statLbl}>Sent</Text>
          </View>
          <View style={[styles.statBox, { borderColor: '#ff4d4d' }]}>
            <Text style={[styles.statVal, { color: '#ff4d4d' }]}>{stats.failed}</Text>
            <Text style={styles.statLbl}>Failed</Text>
          </View>
          <View style={[styles.statBox, { borderColor: '#58a6ff' }]}>
            <Text style={[styles.statVal, { color: '#58a6ff' }]}>{stats.total}</Text>
            <Text style={styles.statLbl}>Total</Text>
          </View>
          {queue.length > 0 && (
            <View style={[styles.statBox, { borderColor: '#f0a500' }]}>
              <Text style={[styles.statVal, { color: '#f0a500' }]}>{queue.length}</Text>
              <Text style={styles.statLbl}>Queued</Text>
            </View>
          )}
        </View>

        {/* Config */}
        <View style={styles.card}>
          <Text style={styles.cardTitle}>⚙️ Configuration</Text>

          <View style={styles.configRow}>
            <Text style={styles.configLabel}>Require API Key Auth</Text>
            <Switch
              value={requireAuth}
              onValueChange={setRequireAuth}
              trackColor={{ false: '#2a3240', true: '#25d366' }}
              thumbColor="#fff"
            />
          </View>

          {requireAuth && (
            <View style={styles.inputGroup}>
              <Text style={styles.inputLabel}>API Key</Text>
              <TextInput
                style={styles.input}
                value={apiKey}
                onChangeText={setApiKey}
                placeholder="Your secret API key"
                placeholderTextColor="#7d8998"
                autoCapitalize="none"
              />
              <Text style={styles.inputHint}>Set the same key in BulkWA extension SMS settings</Text>
            </View>
          )}

          <View style={styles.configRowTwo}>
            <View style={styles.inputGroupHalf}>
              <Text style={styles.inputLabel}>Rate Limit (per min)</Text>
              <TextInput
                style={styles.input}
                value={rateLimit}
                onChangeText={setRateLimit}
                keyboardType="numeric"
                placeholderTextColor="#7d8998"
              />
            </View>
            <View style={styles.inputGroupHalf}>
              <Text style={styles.inputLabel}>Delay between SMS (ms)</Text>
              <TextInput
                style={styles.input}
                value={smsDelay}
                onChangeText={setSmsDelay}
                keyboardType="numeric"
                placeholderTextColor="#7d8998"
              />
            </View>
          </View>
        </View>

        {/* API Reference */}
        <View style={styles.card}>
          <Text style={styles.cardTitle}>📡 API Endpoints</Text>
          <View style={styles.endpoint}>
            <Text style={styles.endpointMethod}>GET</Text>
            <Text style={styles.endpointPath}>/ping</Text>
            <Text style={styles.endpointDesc}>Check if server is online</Text>
          </View>
          <View style={styles.endpoint}>
            <Text style={styles.endpointMethod}>POST</Text>
            <Text style={styles.endpointPath}>/send</Text>
            <Text style={styles.endpointDesc}>Send single SMS</Text>
          </View>
          <View style={styles.endpoint}>
            <Text style={styles.endpointMethod}>POST</Text>
            <Text style={styles.endpointPath}>/send-batch</Text>
            <Text style={styles.endpointDesc}>Queue multiple SMS</Text>
          </View>
          <View style={styles.endpoint}>
            <Text style={styles.endpointMethod}>GET</Text>
            <Text style={styles.endpointPath}>/stats</Text>
            <Text style={styles.endpointDesc}>Get send statistics</Text>
          </View>
          <Text style={styles.payloadLabel}>POST /send payload:</Text>
          <Text style={styles.payload}>{'{ "phone": "919876543210",\n  "message": "Hello!" }'}</Text>
          <Text style={styles.payloadLabel}>Header (if auth enabled):</Text>
          <Text style={styles.payload}>{'Authorization: Bearer YOUR_API_KEY'}</Text>
        </View>

        {/* Log */}
        <View style={styles.card}>
          <View style={styles.logHeader}>
            <Text style={styles.cardTitle}>📋 Activity Log</Text>
            <TouchableOpacity onPress={clearLogs}>
              <Text style={styles.clearBtn}>Clear</Text>
            </TouchableOpacity>
          </View>
          <ScrollView ref={scrollRef} style={styles.logBox} nestedScrollEnabled>
            {logs.length === 0 ? (
              <Text style={styles.logEmpty}>No activity yet…</Text>
            ) : (
              logs.map(entry => (
                <Text key={entry.id} style={[styles.logEntry, logTypeStyle(entry.type)]}>
                  [{entry.time}] {entry.msg}
                </Text>
              ))
            )}
          </ScrollView>
        </View>

        {/* Setup Instructions */}
        <View style={styles.card}>
          <Text style={styles.cardTitle}>🛠 Setup Instructions</Text>
          {[
            '1. Make sure phone & PC are on the same WiFi network',
            '2. Tap ▶ Start to launch the SMS server',
            '3. Copy the URL shown above (http://IP:3000)',
            '4. In BulkWA extension → SMS tab → paste the URL',
            '5. Enter your API key (same as above)',
            '6. Click "Test Connection" to verify',
            '7. Import contacts & send via SMS instead of WhatsApp',
          ].map((step, i) => (
            <Text key={i} style={styles.setupStep}>{step}</Text>
          ))}
        </View>

        <View style={{ height: 30 }} />
      </ScrollView>
    </View>
  );
}

function logTypeStyle(type) {
  switch (type) {
    case 'ok':   return { color: '#25d366' };
    case 'err':  return { color: '#ff4d4d' };
    case 'send': return { color: '#58a6ff' };
    default:     return { color: '#7d8998' };
  }
}

const styles = StyleSheet.create({
  container: { flex: 1, backgroundColor: '#0d1117' },
  header: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', padding: 16, paddingTop: 20, borderBottomWidth: 1, borderBottomColor: '#21262d' },
  headerTitle: { fontSize: 20, fontWeight: '700', color: '#e6edf3' },
  headerSub: { color: '#25d366' },
  headerVersion: { fontSize: 12, color: '#7d8998', backgroundColor: '#21262d', paddingHorizontal: 8, paddingVertical: 3, borderRadius: 10 },
  scroll: { flex: 1, padding: 12 },
  card: { backgroundColor: '#161b22', borderRadius: 12, padding: 14, marginBottom: 12, borderWidth: 1, borderColor: '#21262d' },
  cardTitle: { fontSize: 13, fontWeight: '700', color: '#c9d1d9', marginBottom: 12 },
  statusRow: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between' },
  statusLeft: { flexDirection: 'row', alignItems: 'center', gap: 10 },
  statusDot: { width: 12, height: 12, borderRadius: 6 },
  dotGreen: { backgroundColor: '#25d366' },
  dotRed:   { backgroundColor: '#ff4d4d' },
  statusText: { fontSize: 14, fontWeight: '600', color: '#e6edf3' },
  serverBtn: { paddingHorizontal: 20, paddingVertical: 8, borderRadius: 8 },
  btnStart: { backgroundColor: '#25d366' },
  btnStop:  { backgroundColor: '#ff4d4d' },
  serverBtnText: { color: '#fff', fontWeight: '700', fontSize: 13 },
  ipBox: { marginTop: 12, backgroundColor: '#0d1117', borderRadius: 8, padding: 12 },
  ipLabel: { fontSize: 10, color: '#7d8998', marginBottom: 4 },
  ipValue: { fontSize: 16, fontWeight: '700', color: '#58a6ff', fontFamily: 'monospace' },
  ipHint: { fontSize: 10, color: '#7d8998', marginTop: 4 },
  statsRow: { flexDirection: 'row', gap: 8, marginBottom: 12 },
  statBox: { flex: 1, backgroundColor: '#161b22', borderRadius: 10, padding: 12, alignItems: 'center', borderWidth: 1 },
  statVal: { fontSize: 22, fontWeight: '700' },
  statLbl: { fontSize: 10, color: '#7d8998', marginTop: 2 },
  configRow: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', marginBottom: 10 },
  configLabel: { fontSize: 13, color: '#c9d1d9' },
  configRowTwo: { flexDirection: 'row', gap: 10 },
  inputGroup: { marginBottom: 12 },
  inputGroupHalf: { flex: 1 },
  inputLabel: { fontSize: 11, color: '#7d8998', marginBottom: 5 },
  input: { backgroundColor: '#0d1117', borderWidth: 1, borderColor: '#2a3240', borderRadius: 8, color: '#e6edf3', paddingHorizontal: 12, paddingVertical: 8, fontSize: 13, fontFamily: 'monospace' },
  inputHint: { fontSize: 10, color: '#7d8998', marginTop: 4 },
  endpoint: { flexDirection: 'row', alignItems: 'center', gap: 8, marginBottom: 8 },
  endpointMethod: { fontSize: 10, fontWeight: '700', color: '#25d366', backgroundColor: '#0d2818', paddingHorizontal: 6, paddingVertical: 2, borderRadius: 4, width: 40, textAlign: 'center' },
  endpointPath: { fontSize: 12, color: '#58a6ff', fontFamily: 'monospace', flex: 1 },
  endpointDesc: { fontSize: 11, color: '#7d8998' },
  payloadLabel: { fontSize: 11, color: '#7d8998', marginTop: 8, marginBottom: 4 },
  payload: { backgroundColor: '#0d1117', borderRadius: 6, padding: 10, fontSize: 11, color: '#e6edf3', fontFamily: 'monospace' },
  logHeader: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', marginBottom: 8 },
  clearBtn: { fontSize: 12, color: '#ff4d4d' },
  logBox: { height: 180, backgroundColor: '#0d1117', borderRadius: 8, padding: 8 },
  logEmpty: { color: '#7d8998', fontSize: 11, textAlign: 'center', marginTop: 20 },
  logEntry: { fontSize: 11, fontFamily: 'monospace', marginBottom: 3, lineHeight: 16 },
  setupStep: { fontSize: 12, color: '#c9d1d9', marginBottom: 6, lineHeight: 18 },
});
