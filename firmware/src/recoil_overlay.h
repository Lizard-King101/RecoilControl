#pragma once
#include "relay_queue.h"

namespace relay {
// One expiring correction, separate from the physical input queue. Caller owns lock.
class RecoilOverlay {
  uint32_t id = 0, cancelledId = 0, token = 0, stamp = 0;
  int32_t x = 0, y = 0;
  uint8_t physical = 0;
  bool blocked = true;
 public:
  uint32_t cancelledCount = 0;
  uint32_t generation() const { return token; }
  uint8_t buttons() const { return physical; }
  bool pending() const { return id != 0; }
  void cancel(bool requireRelease = true) {
    if (id) { cancelledId = id; id = 0; cancelledCount++; }
    if (requireRelease && (physical & 1)) blocked = true;
  }
  void input(uint8_t buttons) {
    if (physical != buttons) { token++; cancel(false); }
    physical = buttons;
    if (!(buttons & 1)) blocked = false;
  }
  void sourceLost() { cancel(); physical = 0; token++; blocked = true; }
  uint32_t takeCancelled() { const uint32_t value = cancelledId; cancelledId = 0; return value; }
  const char* offer(uint32_t request, uint32_t generation, uint32_t sourceStamp,
                    int32_t dx, int32_t dy, uint32_t now) {
    if (id || cancelledId) return "correction_busy";
    if (uint32_t(now - sourceStamp) > 100) return "stale_input";
    if (generation != token || !(physical & 1) || blocked) return "input_changed";
    if (dx < -127 || dx > 127 || dy < -127 || dy > 127) return "correction_range";
    id = request; stamp = sourceStamp; x = dx; y = dy; return nullptr;
  }
  uint32_t apply(Frame& frame, bool& havePhysical, uint8_t effectiveButtons, uint32_t now, bool available) {
    if (!id) return 0;
    if (!available || uint32_t(now - stamp) > 100 || !(effectiveButtons & 1) || blocked) { cancel(); return 0; }
    // Never overtake a queued physical button transition or alter its button mask.
    if (havePhysical && frame.buttons != effectiveButtons) return 0;
    if (!havePhysical) frame = {effectiveButtons, 0, 0, 0, 0, now * 1000};
    if (frame.x + x < -32767 || frame.x + x > 32767 || frame.y + y < -32767 || frame.y + y > 32767) return 0;
    frame.x += x; frame.y += y; havePhysical = true;
    const uint32_t result = id; id = 0; return result;
  }
};
}
