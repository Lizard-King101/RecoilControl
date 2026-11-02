#pragma once
#include <cmath>
#include <cstdint>

// Status ring effects. Pure: inputs and a millisecond clock in, one full-scale frame out.
// The caller applies brightness, then the power limit. The LED count is set at runtime
// (saved on the board) so housings with a different ring need no new firmware.
namespace leds {
constexpr uint8_t MAX_COUNT = 60;
struct Rgb { uint8_t r = 0, g = 0, b = 0; bool operator!=(const Rgb& o) const { return r != o.r || g != o.g || b != o.b; } };

// Setup steps first, in the order a new board goes through them.
enum class Mode : uint8_t { Fault, WaitingWindows, PairingMouse, WaitingMouse, NoApp, Standby, Armed, Paused, Recording };
struct Input { Mode mode; bool firing; uint32_t corrections; };

constexpr Rgb RED{255, 0, 24}, BLUE{0, 90, 255}, PURPLE{170, 0, 255}, AMBER{255, 120, 0},
  TEAL{0, 200, 120}, GREEN{0, 255, 70}, ORANGE{255, 64, 0}, WARM{255, 190, 120}, WHITE{255, 255, 255};

inline Rgb scale(Rgb c, uint8_t f) { return {uint8_t(c.r * f / 255), uint8_t(c.g * f / 255), uint8_t(c.b * f / 255)}; }
inline Rgb mix(Rgb a, Rgb b, uint8_t f) { // f = 0 gives a, 255 gives b.
  return {uint8_t(a.r + (b.r - a.r) * f / 255), uint8_t(a.g + (b.g - a.g) * f / 255), uint8_t(a.b + (b.b - a.b) * f / 255)};
}
inline Rgb brighter(Rgb a, Rgb b) { return {a.r > b.r ? a.r : b.r, a.g > b.g ? a.g : b.g, a.b > b.b ? a.b : b.b}; }
inline void fill(Rgb* out, uint8_t count, Rgb c) { for (uint8_t i = 0; i < count; i++) out[i] = c; }

// A slow inhale/exhale between `low` and full, eased so it lingers near the dim end.
inline uint8_t breathe(uint32_t now, uint32_t periodMs, uint8_t low) {
  const float x = 0.5f - 0.5f * std::cos(float(now % periodMs) * 6.2831853f / float(periodMs));
  return uint8_t(low + (255 - low) * x * x);
}

// A head moving around the ring once per periodMs, trailing a fading tail.
inline void comet(Rgb* out, uint8_t count, Rgb c, uint32_t now, uint32_t periodMs, uint8_t tail, uint8_t offset = 0) {
  const uint32_t step = (now % periodMs) * count / periodMs;
  for (uint8_t t = 0; t <= tail && t < count; t++) {
    const uint8_t level = uint8_t(255 - t * 255 / (tail + 1));
    const uint8_t index = uint8_t((step + count * 2 - t + offset) % count);
    out[index] = brighter(out[index], scale(c, uint8_t(level * level / 255)));
  }
}

class Effects {
 public:
  static constexpr uint32_t WIPE_MS = 420, KICK_MS = 140, CAPTURE_MS = 220;

  void render(const Input& in, uint32_t now, Rgb* out, uint8_t count) {
    if (!started) corrections = in.corrections; // Old counts from before boot are not kicks.
    if (!started || in.mode != mode) { previous = started ? mode : in.mode; mode = in.mode; changedAt = now; started = true; }
    if (in.corrections != corrections) { corrections = in.corrections; kickAt = now; }
    if (wasFiring && !in.firing && mode == Mode::Recording) capturedAt = now;
    wasFiring = in.firing;
    const uint32_t since = now - changedAt;
    fill(out, count, {});
    switch (mode) {
      case Mode::Fault: // Red, blinking twice a second.
        if ((now / 250) % 2 == 0) fill(out, count, RED);
        break;
      case Mode::WaitingWindows: // Blue breathing: add "Mouse Relay C3" in Windows Bluetooth.
        fill(out, count, scale(BLUE, breathe(now, 2400, 18)));
        break;
      case Mode::PairingMouse: // Fast purple twin comets: actively scanning for the Cobra.
        comet(out, count, PURPLE, now, 900, 5); comet(out, count, PURPLE, now, 900, 5, count / 2);
        break;
      case Mode::WaitingMouse: // Amber breathing: Windows is ready, the Cobra is not.
        fill(out, count, scale(AMBER, breathe(now, 2400, 18)));
        break;
      case Mode::NoApp: // Both links up and relaying; the app is not connected. A slow, low teal breath.
        fill(out, count, scale(TEAL, uint8_t(breathe(now, 4000, 30) * 3 / 5)));
        break;
      case Mode::Standby:
        fill(out, count, scale(GREEN, 110));
        break;
      case Mode::Armed: { // Ember ring. Each correction sent kicks it toward warm white.
        fill(out, count, ORANGE);
        const uint32_t kick = now - kickAt;
        if (kickAt && kick < KICK_MS) fill(out, count, mix(ORANGE, WARM, uint8_t(255 - kick * 255 / KICK_MS)));
        break;
      }
      case Mode::Paused: // Every other LED, marching slowly: armed, but holding.
        for (uint8_t i = 0; i < count; i++) if ((i + now / 600) % 2 == 0) out[i] = AMBER;
        break;
      case Mode::Recording: // The whole ring: red breathing while ready, solid red with a hot sweep during a burst.
        if (in.firing) { fill(out, count, RED); comet(out, count, WARM, now, 600, 4); }
        else fill(out, count, scale(RED, breathe(now, 1600, 40)));
        if (capturedAt && now - capturedAt < CAPTURE_MS) fill(out, count, WHITE); // Take captured.
        break;
    }
    // Arriving at a ready state, or arming, sweeps the new state around the ring.
    const bool linked = (mode == Mode::Standby || mode == Mode::NoApp) && previous <= Mode::WaitingMouse;
    if ((linked || (mode == Mode::Armed && previous != Mode::Paused)) && since < WIPE_MS) {
      const uint32_t front = since * count / WIPE_MS;
      for (uint8_t i = 0; i < count; i++) {
        if (i > front) out[i] = {};
        else if (i + 2 > front) out[i] = linked ? GREEN : WARM;
      }
    }
  }

 private:
  Mode mode = Mode::Fault, previous = Mode::Fault;
  bool started = false, wasFiring = false;
  uint32_t changedAt = 0, kickAt = 0, capturedAt = 0, corrections = 0;
};

// Estimated draw: ~20 mA per channel at full (WS2812B, conservative) plus ~1 mA idle per LED.
// Datasheet figures, not a measurement. Keeps the strip inside a USB-safe budget.
constexpr uint32_t CHANNEL_MA = 20, IDLE_MA = 1;

// The only path to the strip: brightness (0–255), then a uniform dim of any frame whose
// estimate exceeds budgetMa. Sparse effects keep full brightness; a full white ring is held back.
inline void output(const Rgb* frame, Rgb* out, uint8_t count, uint8_t brightness, uint32_t budgetMa) {
  uint32_t sum = 0;
  for (uint8_t i = 0; i < count; i++) {
    out[i] = {uint8_t((frame[i].r * brightness + 127) / 255), uint8_t((frame[i].g * brightness + 127) / 255), uint8_t((frame[i].b * brightness + 127) / 255)};
    sum += out[i].r + out[i].g + out[i].b;
  }
  const uint32_t idle = IDLE_MA * count, available = budgetMa > idle ? budgetMa - idle : 0;
  const uint32_t limit = available * 255 / CHANNEL_MA; // Channel-sum that fits the budget.
  if (sum <= limit) return;
  for (uint8_t i = 0; i < count; i++)
    out[i] = {uint8_t(out[i].r * limit / sum), uint8_t(out[i].g * limit / sum), uint8_t(out[i].b * limit / sum)};
}
}  // namespace leds
