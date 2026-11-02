#include <Arduino.h>
#include <Adafruit_NeoPixel.h>
#include <NimBLEDevice.h>
#include <NimBLEHIDDevice.h>
#include <Preferences.h>
#include <atomic>
#include <cerrno>
#include <cctype>
#include "hid_mouse.h"
#include "relay_queue.h"
#include "relay_self_test.h"
#include "led_effects.h"

namespace {
constexpr uint8_t LED_PIN = 20, DEFAULT_LED_COUNT = 24, DEFAULT_BRIGHTNESS = 96;
// Estimated LED current budget. With the board's own ~100 mA this stays inside a 500 mA USB port.
constexpr uint32_t LED_BUDGET_MA = 350;
constexpr uint32_t HOST_TIMEOUT_MS = 5000;
constexpr char DEVICE_NAME[] = "Mouse Relay C3";
Adafruit_NeoPixel strip(DEFAULT_LED_COUNT, LED_PIN, NEO_GRB + NEO_KHZ800);
NimBLECharacteristic* mouseReport = nullptr;
std::atomic<bool> pcConnected{false}, pcSecure{false}, pcSubscribed{false};
std::atomic<bool> mouseConnected{false}, mouseSecure{false}, mouseReady{false}, pairRequested{false}, pairing{false};
std::atomic<bool> txDone{false}, resetTx{false}, savedMouse{false};
std::atomic<int> txCode{0}, stage{0}, errorCode{0};
std::atomic<uint16_t> pcHandle{BLE_HS_CONN_HANDLE_NONE};
std::atomic<uint32_t> pcIntervalUs{0}, mouseIntervalUs{0};
portMUX_TYPE relayMux = portMUX_INITIALIZER_UNLOCKED;
relay::Queue queue;
relay::RecoilOverlay recoil;
hidmouse::Descriptor descriptor;
struct Binding { NimBLERemoteCharacteristic* characteristic = nullptr; uint8_t id = 0; };
std::array<Binding, 16> bindings{};
size_t bindingCount = 0;
struct Stats {
  uint32_t received = 0, sent = 0, moves = 0, parseErrors = 0, txErrors = 0, corrections = 0;
  uint32_t left = 0, right = 0, middle = 0, side = 0, wheelUp = 0, wheelDown = 0;
  uint32_t mouseDisconnects = 0, pcDisconnects = 0, usbTimeouts = 0;
  uint32_t latencyLast = 0, latencyMax = 0;
  uint64_t latencyTotal = 0;
  uint8_t buttons = 0;
} stats;
bool selfTest = false, sessionOpen = false, hostWasLive = false, txPending = false;
uint32_t lastHeartbeat = 0, lastId = 0, lastStatus = 0, lastFrame = 0;
uint32_t txStarted = 0, txOrigin = 0, retryTxAt = 0;
uint32_t txCorrection = 0, lastInputAt = 0, lastInputGeneration = UINT32_MAX;
// Brightness and LED count are saved on the board, so they survive reboots and app restarts.
uint8_t brightness = DEFAULT_BRIGHTNESS, ledCount = DEFAULT_LED_COUNT;
Preferences ledSettings;
char input[128]; size_t inputSize = 0; bool overflow = false;
// Pull recording: physical Cobra movement relayed since the last motion frame.
// Only the host's TRACE command enables it, and it never changes what is forwarded.
std::atomic<bool> tracing{false};
int32_t traceX = 0, traceY = 0; bool traceFlush = false; // Guarded by relayMux.
uint32_t traceSeq = 0, lastMotionUs = 0;
// What the app says compensation is doing (0 standby, 1 armed, 2 paused). Display only:
// corrections are still gated by RFRAME. Cleared with the session so a stale "armed" never shows.
uint8_t indicator = 0;
leds::Effects effects;
leds::Rgb shown[leds::MAX_COUNT];
bool redraw = true;

// One upstream mouse: eight buttons, signed 16-bit X/Y, vertical and horizontal wheel.
uint8_t reportMap[] = {
  0x05,1, 0x09,2, 0xa1,1, 0x85,1, 0x09,1, 0xa1,0,
  0x05,9, 0x19,1, 0x29,8, 0x15,0, 0x25,1, 0x75,1, 0x95,8, 0x81,2,
  0x05,1, 0x09,0x30, 0x09,0x31, 0x16,1,0x80, 0x26,0xff,0x7f, 0x75,16, 0x95,2, 0x81,6,
  0x09,0x38, 0x15,0x81, 0x25,0x7f, 0x75,8, 0x95,1, 0x81,6,
  0x05,0x0c, 0x0a,0x38,2, 0x81,6, 0xc0,0xc0
};
bool pcReady() { return pcConnected && pcSecure && pcSubscribed; }
bool hostLive() { return sessionOpen && Serial && uint32_t(millis() - lastHeartbeat) < HOST_TIMEOUT_MS; }
bool correctionReady() { return selfTest && sessionOpen && uint32_t(millis() - lastHeartbeat) < 1500 && pcReady() && mouseReady; }
const char* errorText() {
  static const char* errors[] = {"", "cobra_not_found", "mouse_connect_failed", "mouse_security_failed", "hid_service_missing",
    "unsupported_mouse_descriptor", "mouse_subscribe_failed", "invalid_mouse_report", "queue_overflow", "pc_transmit_stalled", "multiple_cobra_devices", "self_test_failed"};
  const int code = errorCode.load(); return code >= 0 && code < 12 ? errors[code] : "relay_error";
}
bool sendLine(const char* line, size_t length) {
  // A closed/stalled serial reader must never block physical mouse forwarding.
  if (!Serial || Serial.availableForWrite() < int(length + 64)) return false;
  Serial.write(reinterpret_cast<const uint8_t*>(line), length); return true;
}
void reply(uint32_t id, const char* error = nullptr) {
  char line[180]; const int n = snprintf(line, sizeof(line), "{\"kind\":\"reply\",\"id\":%lu,\"ok\":%s,\"error\":\"%s\"}\n",
    static_cast<unsigned long>(id), error ? "false" : "true", error ? error : "");
  if (n > 0 && n < int(sizeof(line))) sendLine(line, n);
}
void correctionReply(uint32_t id, bool sent) {
  if (!id) return;
  char line[100]; const int n = snprintf(line, sizeof(line), "{\"kind\":\"reply\",\"id\":%lu,\"ok\":true,\"sent\":%s}\n", static_cast<unsigned long>(id), sent ? "true" : "false");
  sendLine(line, n);
}
void sendInput() {
  uint32_t generation; uint8_t buttons;
  portENTER_CRITICAL(&relayMux); generation = recoil.generation(); buttons = queue.buttons(); portEXIT_CRITICAL(&relayMux);
  const uint32_t now = millis();
  if (!sessionOpen || (generation == lastInputGeneration && uint32_t(now - lastInputAt) < 30)) return;
  char line[180]; const int n = snprintf(line, sizeof(line),
    "{\"kind\":\"input\",\"generation\":%u,\"stamp\":%u,\"buttons\":%u,\"connected\":%s}\n",
    generation, now, buttons, mouseReady && pcReady() ? "true" : "false");
  sendLine(line, n); lastInputGeneration = generation; lastInputAt = now;
}
void resetTrace() {
  portENTER_CRITICAL(&relayMux); traceX = 0; traceY = 0; traceFlush = false; portEXIT_CRITICAL(&relayMux);
  traceSeq = 0; lastMotionUs = micros();
}
void sendMotion() {
  if (!tracing) return;
  int32_t x, y; uint8_t buttons; bool flush;
  portENTER_CRITICAL(&relayMux); x = traceX; y = traceY; buttons = stats.buttons; flush = traceFlush; portEXIT_CRITICAL(&relayMux);
  const uint32_t now = micros();
  // Button changes go out at once so the host can find the start and end of a burst.
  if (!flush && ((!x && !y) || uint32_t(now - lastMotionUs) < 8000)) return;
  char line[120]; const int n = snprintf(line, sizeof(line), "{\"kind\":\"motion\",\"seq\":%u,\"stamp\":%u,\"dx\":%ld,\"dy\":%ld,\"buttons\":%u}\n",
    traceSeq, now, long(x), long(y), buttons);
  // Keep accumulating until the host can read, so no movement is lost.
  if (n <= 0 || n >= int(sizeof(line)) || !sendLine(line, n)) return;
  portENTER_CRITICAL(&relayMux); traceX -= x; traceY -= y; traceFlush = false; portEXIT_CRITICAL(&relayMux);
  traceSeq++; lastMotionUs = now;
}
void sendStatus() {
  Stats s; size_t depth; uint32_t dropped, cancelled; bool pending;
  portENTER_CRITICAL(&relayMux); s = stats; depth = queue.size(); dropped = queue.dropped; cancelled = recoil.cancelledCount; pending = recoil.pending(); portEXIT_CRITICAL(&relayMux);
  char line[1800];
  const int n = snprintf(line, sizeof(line),
    "{\"kind\":\"status\",\"board\":\"recoil-c3\",\"protocol\":4,\"firmware\":\"0.7.0\","
    "\"usb\":%s,\"ble\":%s,\"secure\":%s,\"subscribed\":%s,\"armed\":false,\"brightness\":%u,\"brightnessCap\":255,\"ledCount\":%u,\"ledBudgetMa\":%u,\"pin\":20,\"reports\":%u,\"uptime\":%u,"
    "\"relay\":{\"mode\":\"profiles\",\"selfTest\":%s,\"mouseConnected\":%s,\"mouseSecure\":%s,\"mouseReady\":%s,\"pairing\":%s,\"savedMouse\":%s,\"stage\":%d,\"error\":\"%s\","
    "\"received\":%u,\"moves\":%u,\"left\":%u,\"right\":%u,\"middle\":%u,\"side\":%u,\"wheelUp\":%u,\"wheelDown\":%u,\"buttons\":%u,\"queueDepth\":%u,\"dropped\":%u,\"parseErrors\":%u,\"txErrors\":%u,"
    "\"mouseDisconnects\":%u,\"pcDisconnects\":%u,\"usbTimeouts\":%u,\"latencySamples\":%u,\"latencyLastUs\":%u,\"latencyMaxUs\":%u,\"latencyMeanUs\":%u,\"pcIntervalUs\":%u,\"mouseIntervalUs\":%u,\"corrections\":%u,\"cancelled\":%u,\"correctionPending\":%s,\"tracing\":%s,\"indicator\":%u}}\n",
    hostLive() ? "true" : "false", pcConnected ? "true" : "false", pcSecure ? "true" : "false", pcSubscribed ? "true" : "false",
    brightness, ledCount, unsigned(LED_BUDGET_MA), s.sent, millis(), selfTest ? "true" : "false", mouseConnected ? "true" : "false", mouseSecure ? "true" : "false", mouseReady ? "true" : "false",
    pairing ? "true" : "false", savedMouse ? "true" : "false", stage.load(), errorText(), s.received, s.moves, s.left, s.right, s.middle, s.side, s.wheelUp, s.wheelDown,
    s.buttons, unsigned(depth), dropped, s.parseErrors, s.txErrors, s.mouseDisconnects, s.pcDisconnects, s.usbTimeouts, s.sent, s.latencyLast, s.latencyMax,
    s.sent ? uint32_t(s.latencyTotal / s.sent) : 0, pcIntervalUs.load(), mouseIntervalUs.load(), s.corrections, cancelled, pending ? "true" : "false", tracing ? "true" : "false", unsigned(indicator));
  if (n > 0 && n < int(sizeof(line))) sendLine(line, n);
  lastStatus = millis();
}
void resetQueue(bool sourceLost) {
  portENTER_CRITICAL(&relayMux);
  if (sourceLost) { queue.sourceLost(micros()); recoil.sourceLost(); stats.buttons = 0; } else { queue.reset(micros()); recoil.cancel(); }
  portEXIT_CRITICAL(&relayMux);
}
class ServerCallbacks : public NimBLEServerCallbacks {
  void onConnect(NimBLEServer* server, NimBLEConnInfo& info) override {
    if (pcConnected.exchange(true)) { server->disconnect(info.getConnHandle()); return; }
    pcHandle = info.getConnHandle(); pcSecure = false; pcSubscribed = false;
    pcIntervalUs = info.getConnInterval() * 1250; resetQueue(false); resetTx = true;
    server->updateConnParams(info.getConnHandle(), 6, 12, 0, 600);
  }
  void onDisconnect(NimBLEServer*, NimBLEConnInfo& info, int) override {
    if (pcHandle != info.getConnHandle()) return;
    pcConnected = false; pcSecure = false; pcSubscribed = false; pcHandle = BLE_HS_CONN_HANDLE_NONE; resetTx = true;
    resetQueue(false);
    portENTER_CRITICAL(&relayMux); stats.pcDisconnects++; portEXIT_CRITICAL(&relayMux);
    NimBLEDevice::startAdvertising();
  }
  void onAuthenticationComplete(NimBLEConnInfo& info) override {
    if (info.getConnHandle() != pcHandle) return;
    pcSecure = info.isEncrypted();
    if (!pcSecure) NimBLEDevice::getServer()->disconnect(info.getConnHandle());
  }
  void onConnParamsUpdate(NimBLEConnInfo& info) override { if (info.getConnHandle() == pcHandle) pcIntervalUs = info.getConnInterval() * 1250; }
} serverCallbacks;
class ReportCallbacks : public NimBLECharacteristicCallbacks {
  void onStatus(NimBLECharacteristic* characteristic, NimBLEConnInfo&, int code) override {
    // NimBLE-Arduino 2.5.2 leaves ConnInfo empty for NOTIFY_TX. This characteristic
    // has exactly one upstream subscriber; do not reject completion by that handle.
    if (characteristic == mouseReport && pcConnected) { txCode = code; txDone = true; }
  }
  void onSubscribe(NimBLECharacteristic*, NimBLEConnInfo& info, uint16_t value) override {
    if (info.getConnHandle() != pcHandle) return;
    pcSubscribed = (value & 1) != 0; resetQueue(false);
  }
} reportCallbacks;
class ClientCallbacks : public NimBLEClientCallbacks {
  void onConnect(NimBLEClient* client) override { mouseConnected = true; mouseIntervalUs = client->getConnInfo().getConnInterval() * 1250; }
  void onDisconnect(NimBLEClient*, int) override {
    mouseReady = false; mouseConnected = false; mouseSecure = false; stage = savedMouse ? 4 : 0;
    resetQueue(true);
    portENTER_CRITICAL(&relayMux); stats.mouseDisconnects++; portEXIT_CRITICAL(&relayMux);
  }
  void onAuthenticationComplete(NimBLEConnInfo& info) override { mouseSecure = info.isEncrypted(); }
} clientCallbacks;
void receiveMouse(NimBLERemoteCharacteristic* characteristic, uint8_t* data, size_t length, bool) {
  if (!mouseReady) return;
  const Binding* binding = nullptr;
  for (size_t i = 0; i < bindingCount; i++) if (bindings[i].characteristic == characteristic) { binding = &bindings[i]; break; }
  hidmouse::Report r;
  if (!binding || !descriptor.decode(binding->id, data, length, r)) {
    portENTER_CRITICAL(&relayMux); stats.parseErrors++; portEXIT_CRITICAL(&relayMux);
    errorCode = 7; resetQueue(true); return;
  }
  const uint32_t now = micros();
  portENTER_CRITICAL(&relayMux);
  stats.received++;
  const uint8_t next = (stats.buttons & ~r.buttonMask) | (r.buttons & r.buttonMask), pressed = next & ~stats.buttons;
  const bool buttonsChanged = next != stats.buttons;
  stats.buttons = next;
  recoil.input(next);
  stats.left += !!(pressed & 1); stats.right += !!(pressed & 2); stats.middle += !!(pressed & 4); stats.side += !!(pressed & 0xf8);
  stats.moves += !!(r.x || r.y);
  if (tracing) { traceX += r.x; traceY += r.y; traceFlush |= buttonsChanged; }
  if (r.wheel > 0) stats.wheelUp += r.wheel; else stats.wheelDown += -r.wheel;
  queue.push(r, now);
  if (!pcReady()) queue.reset(now);
  portEXIT_CRITICAL(&relayMux);
}
bool discoverMouse(NimBLEClient* client) {
  bindingCount = 0;
  if (!client->secureConnection() || !client->getConnInfo().isEncrypted()) { errorCode = 3; return false; }
  mouseSecure = true;
  auto* service = client->getService(NimBLEUUID(uint16_t(0x1812)));
  if (!service) { errorCode = 4; return false; }
  auto* map = service->getCharacteristic(NimBLEUUID(uint16_t(0x2a4b)));
  if (!map) { errorCode = 5; return false; }
  const auto bytes = map->readValue();
  if (bytes.size() > 2048 || !descriptor.parse(bytes.data(), bytes.size())) { errorCode = 5; return false; }
  auto* protocol = service->getCharacteristic(NimBLEUUID(uint16_t(0x2a4e)));
  const uint8_t reportMode = 1;
  if (protocol && (protocol->canWrite() || protocol->canWriteNoResponse()) && !protocol->writeValue(&reportMode, 1, protocol->canWrite())) { errorCode = 6; return false; }
  for (auto* characteristic : service->getCharacteristics(true)) {
    if (characteristic->getUUID() != NimBLEUUID(uint16_t(0x2a4d)) || !characteristic->canNotify()) continue;
    auto* reference = characteristic->getDescriptor(NimBLEUUID(uint16_t(0x2908)));
    if (!reference) continue;
    const auto value = reference->readValue();
    if (value.size() != 2 || value[1] != 1 || !descriptor.find(value[0])) continue;
    if (bindingCount == bindings.size()) { errorCode = 6; return false; }
    bindings[bindingCount++] = {characteristic, value[0]};
    if (!characteristic->subscribe(true, receiveMouse)) { errorCode = 6; return false; }
  }
  if (!bindingCount) { errorCode = 6; return false; }
  resetQueue(true); errorCode = 0; mouseReady = true; stage = 3;
  mouseIntervalUs = client->getConnInfo().getConnInterval() * 1250;
  return true;
}
bool cobraName(const std::string& inputName) {
  std::string name = inputName; for (char& c : name) c = std::tolower(static_cast<unsigned char>(c));
  return name == "cobra pro" || name == "razer cobra pro";
}
void mouseTask(void*) {
  Preferences preferences; preferences.begin("mouse-relay", false);
  std::string saved = preferences.getString("address", "").c_str();
  uint8_t savedType = preferences.getUChar("type", 0); savedMouse = !saved.empty();
  auto* client = NimBLEDevice::createClient();
  if (!client) { errorCode = 2; vTaskDelete(nullptr); return; }
  client->setClientCallbacks(&clientCallbacks, false); client->setConnectTimeout(5000); client->setConnectRetries(0);
  client->setConnectionParams(6, 12, 0, 600);
  auto* scan = NimBLEDevice::getScan(); scan->setActiveScan(true); scan->setInterval(100); scan->setWindow(30); scan->setMaxResults(32);
  uint32_t retryAt = 0, backoff = 1000;
  for (;;) {
    const bool requested = pairRequested.exchange(false);
    if (requested || (!mouseConnected && !saved.empty() && int32_t(millis() - retryAt) >= 0)) {
      NimBLEAddress address; bool found = false;
      if (requested) {
        pairing = true; stage = 1; errorCode = 0;
        if (client->isConnected()) { mouseReady = false; client->disconnect(); delay(200); }
        const uint32_t started = millis();
        while (uint32_t(millis() - started) < 60000 && !found) {
          const auto results = scan->getResults(4000, false);
          unsigned matches = 0;
          for (const auto* device : results) if (device->isConnectable() && cobraName(device->getName())) { address = device->getAddress(); matches++; }
          if (matches > 1) { errorCode = 10; break; }
          found = matches == 1; scan->clearResults();
        }
        if (!found && errorCode == 0) errorCode = 1;
        if (found) NimBLEDevice::deleteBond(address);
      } else { address = NimBLEAddress(saved, savedType); found = true; }
      if (found) {
        stage = 2;
        if (client->connect(address, true)) {
          if (discoverMouse(client)) {
            const auto identity = client->getConnInfo().getIdAddress();
            saved = identity.toString(); savedType = identity.getType();
            preferences.putString("address", saved.c_str()); preferences.putUChar("type", savedType);
            savedMouse = true; backoff = 1000;
          } else client->disconnect();
        } else errorCode = 2;
      }
      pairing = false;
      if (!mouseReady) { stage = saved.empty() ? 5 : 4; retryAt = millis() + backoff; backoff = std::min(uint32_t(15000), backoff * 2); }
    }
    delay(100);
  }
}
void pumpMouse() {
  uint32_t cancelled;
  portENTER_CRITICAL(&relayMux);
  if (!correctionReady()) recoil.cancel();
  cancelled = recoil.takeCancelled();
  portEXIT_CRITICAL(&relayMux);
  correctionReply(cancelled, false);
  if (resetTx.exchange(false)) { correctionReply(txCorrection, false); txCorrection = 0; txPending = false; txDone = false; }
  if (!pcReady()) return;
  if (txPending) {
    if (txDone.exchange(false)) {
      portENTER_CRITICAL(&relayMux);
      if (txCode == 0) {
        if (errorCode == 9) errorCode = 0;
        stats.sent++; stats.latencyLast = micros() - txOrigin;
        if (txCorrection) stats.corrections++;
        stats.latencyMax = std::max(stats.latencyMax, stats.latencyLast); stats.latencyTotal += stats.latencyLast;
      } else { stats.txErrors++; queue.reset(micros()); recoil.cancel(); }
      portEXIT_CRITICAL(&relayMux); txPending = false;
      if (txCorrection) { if (txCode == 0) correctionReply(txCorrection, true); else reply(txCorrection, "notify_failed"); txCorrection = 0; }
    } else if (uint32_t(millis() - txStarted) >= 2000) {
      reply(txCorrection, "notify_timeout"); txCorrection = 0;
      errorCode = 9; txPending = false; resetQueue(false); NimBLEDevice::getServer()->disconnect(pcHandle);
    }
    return;
  }
  if (int32_t(millis() - retryTxAt) < 0) return;
  relay::Frame frame; bool have;
  portENTER_CRITICAL(&relayMux);
  have = queue.pop(frame, micros());
  txCorrection = recoil.apply(frame, have, queue.buttons(), millis(), correctionReady());
  portEXIT_CRITICAL(&relayMux);
  if (!have) return;
  const uint16_t x = static_cast<int16_t>(frame.x), y = static_cast<int16_t>(frame.y);
  const uint8_t report[] = {frame.buttons, uint8_t(x), uint8_t(x >> 8), uint8_t(y), uint8_t(y >> 8), uint8_t(frame.wheel), uint8_t(frame.pan)};
  txDone = false; txPending = true; txStarted = millis(); txOrigin = frame.at;
  if (!mouseReport->notify(report, sizeof(report), pcHandle)) {
    if (txCorrection) { reply(txCorrection, "notify_failed"); txCorrection = 0; }
    txPending = false; retryTxAt = millis() + 30;
    portENTER_CRITICAL(&relayMux); stats.txErrors++; queue.reset(micros()); portEXIT_CRITICAL(&relayMux);
  }
}
bool number(const char* token, long minimum, long maximum, long& value) {
  if (!token || !*token) return false;
  char* end; errno = 0; value = strtol(token, &end, 10);
  return !errno && *end == '\0' && value >= minimum && value <= maximum;
}
bool unsignedNumber(const char* token, uint32_t& value) {
  if (!token || !*token || *token == '-') return false;
  char* end; errno = 0; const unsigned long long parsed = strtoull(token, &end, 10);
  if (errno || *end || parsed > UINT32_MAX) return false;
  value = parsed; return true;
}
void handleLine(char* line) {
  char* tokens[6]; size_t count = 0; char* next;
  for (char* token = strtok_r(line, " \r", &next); token; token = strtok_r(nullptr, " \r", &next)) {
    if (count == 6) { reply(0, "invalid_command"); return; } tokens[count++] = token;
  }
  long idValue; if (count < 2 || !number(tokens[1], 1, 2147483647, idValue)) { reply(0, "invalid_id"); return; }
  const uint32_t id = idValue; const char* command = tokens[0];
  if (!strcmp(command, "HELLO") && count == 3 && !strcmp(tokens[2], "RC4")) {
    portENTER_CRITICAL(&relayMux); recoil.cancel(); recoil.takeCancelled(); portEXIT_CRITICAL(&relayMux);
    txCorrection = 0; // No acknowledgement from an old session may match a new request.
    tracing = false; resetTrace(); indicator = 0;
    sessionOpen = true; lastHeartbeat = millis(); lastId = id; reply(id); sendStatus(); sendInput(); return;
  }
  if (!sessionOpen || id <= lastId) { reply(id, "session_or_sequence"); return; }
  lastId = id; const char* error = nullptr;
  if (!strcmp(command, "PING") && count == 2) lastHeartbeat = millis();
  else if (!strcmp(command, "STATUS") && count == 2) {}
  else if (!strcmp(command, "DISARM") && count == 2) { portENTER_CRITICAL(&relayMux); recoil.cancel(); portEXIT_CRITICAL(&relayMux); }
  else if (!strcmp(command, "RFRAME") && count == 6) {
    uint32_t generation, stamp; long x, y;
    if (!unsignedNumber(tokens[2], generation) || !unsignedNumber(tokens[3], stamp) ||
        !number(tokens[4], -127, 127, x) || !number(tokens[5], -127, 127, y)) error = "correction_range";
    else if (!correctionReady()) error = "relay_not_ready";
    else {
      portENTER_CRITICAL(&relayMux); error = recoil.offer(id, generation, stamp, x, y, millis()); portEXIT_CRITICAL(&relayMux);
      if (!error) return; // Reply only after transmit callback, expiry, or cancellation.
      if (!strcmp(error, "input_changed")) { correctionReply(id, false); return; }
    }
  }
  else if (!strcmp(command, "TRACE") && count == 3) {
    long value;
    if (!number(tokens[2], 0, 1, value)) error = "trace_value";
    else if (value && !mouseReady) error = "mouse_not_ready";
    else { resetTrace(); tracing = value == 1; } // Each recording session starts at sequence 0.
  }
  else if (!strcmp(command, "IND") && count == 3) {
    long value; if (!number(tokens[2], 0, 2, value)) error = "indicator_value"; else indicator = value;
  }
  else if (!strcmp(command, "LED") && count == 3) {
    long value;
    if (!number(tokens[2], 0, 255, value)) error = "brightness_range";
    else if (value != brightness) { brightness = value; ledSettings.putUChar("brightness", brightness); }
  }
  else if (!strcmp(command, "LEDS") && count == 3) {
    long value;
    if (!number(tokens[2], 1, leds::MAX_COUNT, value)) error = "led_count_range";
    else if (value != ledCount) {
      strip.clear(); strip.show(); // LEDs beyond a shorter strip would otherwise keep their last color.
      ledCount = value; strip.updateLength(ledCount); redraw = true;
      ledSettings.putUChar("count", ledCount);
    }
  }
  else if (!strcmp(command, "PAIR") && count == 2) {
    if (!selfTest) error = "self_test_failed";
    else if (pairing || pairRequested) error = "pairing_in_progress";
    else if (mouseReady) error = "mouse_already_connected";
    else pairRequested = true;
  } else if (!strcmp(command, "RESETSTATS") && count == 2) {
    portENTER_CRITICAL(&relayMux); const uint8_t buttons = stats.buttons; stats = {}; stats.buttons = buttons; queue.dropped = 0; recoil.cancelledCount = 0; portEXIT_CRITICAL(&relayMux);
  } else if (!strcmp(command, "ARM") || !strcmp(command, "MOVE") || !strcmp(command, "FRAME")) error = "passthrough_only";
  else error = "invalid_command";
  reply(id, error);
  if (strcmp(command, "RFRAME")) sendStatus();
}
leds::Mode ledMode() {
  if (!selfTest) return leds::Mode::Fault;
  if (pairing) return leds::Mode::PairingMouse;
  if (!pcReady()) return leds::Mode::WaitingWindows;
  if (!mouseReady) return leds::Mode::WaitingMouse;
  if (tracing) return leds::Mode::Recording;
  if (!hostLive()) return leds::Mode::NoApp;
  return indicator == 1 ? leds::Mode::Armed : indicator == 2 ? leds::Mode::Paused : leds::Mode::Standby;
}
void updateLeds() {
  // 25 fps. A strip update blocks this loop for ~0.7 ms, so unchanged frames are never resent.
  const uint32_t now = millis(); if (uint32_t(now - lastFrame) < 40) return; lastFrame = now;
  leds::Input in; in.mode = ledMode();
  portENTER_CRITICAL(&relayMux); in.firing = stats.buttons & 1; in.corrections = stats.corrections; portEXIT_CRITICAL(&relayMux);
  leds::Rgb frame[leds::MAX_COUNT], out[leds::MAX_COUNT];
  effects.render(in, now, frame, ledCount);
  leds::output(frame, out, ledCount, brightness, LED_BUDGET_MA);
  bool changed = redraw; redraw = false;
  for (uint8_t i = 0; i < ledCount; i++) {
    if (out[i] != shown[i] || changed) { shown[i] = out[i]; changed = true; strip.setPixelColor(i, out[i].r, out[i].g, out[i].b); }
  }
  if (changed) strip.show();
}
}
void setup() {
  ledSettings.begin("leds", false);
  brightness = ledSettings.getUChar("brightness", DEFAULT_BRIGHTNESS);
  ledCount = ledSettings.getUChar("count", DEFAULT_LED_COUNT);
  if (ledCount < 1 || ledCount > leds::MAX_COUNT) ledCount = DEFAULT_LED_COUNT;
  strip.updateLength(ledCount); strip.begin(); strip.clear(); strip.show();
  Serial.setTxBufferSize(4096); Serial.setTxTimeoutMs(0); Serial.begin(115200);
  selfTest = relaySelfTest(); if (!selfTest) errorCode = 11;
  NimBLEDevice::init(DEVICE_NAME);
  // The upstream HID report format changed. Reset only this board's old bonds once.
  Preferences migration; migration.begin("mouse-relay", false);
  if (migration.getUChar("schema", 0) != 3) { NimBLEDevice::deleteAllBonds(); migration.putUChar("schema", 3); }
  migration.end();
  NimBLEDevice::setSecurityAuth(true, false, true); NimBLEDevice::setSecurityIOCap(BLE_HS_IO_NO_INPUT_OUTPUT);
  auto* server = NimBLEDevice::createServer(); server->setCallbacks(&serverCallbacks);
  auto* hid = new NimBLEHIDDevice(server);
  hid->setManufacturer("Mouse Relay prototype"); hid->setPnp(0x02, 0x1209, 0x0001, 0x0300); hid->setHidInfo(0, 0x02);
  hid->setReportMap(reportMap, sizeof(reportMap)); mouseReport = hid->getInputReport(1); mouseReport->setCallbacks(&reportCallbacks);
  hid->setBatteryLevel(100); server->start();
  auto* advertising = NimBLEDevice::getAdvertising(); advertising->setAppearance(HID_MOUSE);
  advertising->addServiceUUID(hid->getHidService()->getUUID()); advertising->setName(DEVICE_NAME); advertising->enableScanResponse(true); advertising->start();
  if (selfTest) xTaskCreate(mouseTask, "cobra-host", 10240, nullptr, 1, nullptr);
}
void loop() {
  if (selfTest) pumpMouse();
  const bool live = hostLive();
  if (hostWasLive && !live) { portENTER_CRITICAL(&relayMux); stats.usbTimeouts++; portEXIT_CRITICAL(&relayMux); }
  hostWasLive = live;
  if (!live) { tracing = false; indicator = 0; } // Neither outlives the app session.
  for (unsigned budget = 0; budget < 256 && Serial.available(); budget++) {
    const char ch = Serial.read();
    if (ch == '\n') {
      if (overflow) reply(0, "line_too_long"); else { input[inputSize] = '\0'; handleLine(input); }
      inputSize = 0; overflow = false;
    } else if (!overflow) {
      if (inputSize < sizeof(input) - 1 && ch >= ' ' && ch <= '~') input[inputSize++] = ch;
      else if (ch != '\r') overflow = true;
    }
  }
  if (Serial && uint32_t(millis() - lastStatus) >= 1000) sendStatus();
  sendInput();
  sendMotion();
  updateLeds(); delay(1);
}
