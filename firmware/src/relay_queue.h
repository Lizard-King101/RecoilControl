#pragma once
#include <cstdint>
#include <cstddef>
#include <array>
#include <algorithm>
#include <cstdlib>
#include "hid_mouse.h"

namespace relay {
struct Frame { uint8_t buttons = 0; int32_t x = 0, y = 0, wheel = 0, pan = 0; uint32_t at = 0; };
// The caller owns the lock. Adjacent motion may merge; button transitions never do.
class Queue {
  std::array<Frame, 64> frames{};
  size_t head = 0, count = 0;
  uint8_t physical = 0, suppressed = 0;
  bool waitingForNeutral = true;
 public:
  uint32_t dropped = 0;
  size_t size() const { return count; }
  uint8_t buttons() const { return physical & ~suppressed; }
  void reset(uint32_t now) {
    head = 0; count = 1; frames[0] = {}; frames[0].at = now;
    suppressed = physical; // Reconnection cannot turn an already-held button into a new click.
  }
  void sourceLost(uint32_t now) { reset(now); physical = 0; suppressed = 0; waitingForNeutral = true; }
  void push(const hidmouse::Report& r, uint32_t now) {
    const uint8_t old = physical;
    physical = (physical & ~r.buttonMask) | (r.buttons & r.buttonMask);
    if (waitingForNeutral) { suppressed |= physical; if (r.buttonMask && !physical) waitingForNeutral = false; }
    suppressed &= physical;
    const uint8_t buttons = physical & ~suppressed;
    if (!r.x && !r.y && !r.wheel && !r.pan && old == physical) return;
    if (count) {
      Frame& tail = frames[(head + count - 1) % frames.size()];
      if (tail.buttons == buttons && uint32_t(now - tail.at) < 100000) {
        const auto add = [](int32_t a, int32_t b) { return int64_t(a) + b; };
        if (std::abs(add(tail.x, r.x)) <= 1000000 && std::abs(add(tail.y, r.y)) <= 1000000 &&
            std::abs(add(tail.wheel, r.wheel)) <= 1000000 && std::abs(add(tail.pan, r.pan)) <= 1000000) {
          tail.x += r.x; tail.y += r.y; tail.wheel += r.wheel; tail.pan += r.pan; return;
        }
      }
    }
    if (count == frames.size()) { dropped += count; reset(now); return; }
    frames[(head + count) % frames.size()] = {buttons, r.x, r.y, r.wheel, r.pan, now}; count++;
  }
  bool pop(Frame& out, uint32_t now) {
    if (!count) return false;
    if (uint32_t(now - frames[head].at) > 250000) { dropped += count; reset(now); }
    Frame& f = frames[head]; out = f;
    out.x = std::clamp<int32_t>(f.x, -32767, 32767); out.y = std::clamp<int32_t>(f.y, -32767, 32767);
    out.wheel = std::clamp<int32_t>(f.wheel, -127, 127); out.pan = std::clamp<int32_t>(f.pan, -127, 127);
    f.x -= out.x; f.y -= out.y; f.wheel -= out.wheel; f.pan -= out.pan;
    if (!f.x && !f.y && !f.wheel && !f.pan) { head = (head + 1) % frames.size(); count--; }
    return true;
  }
};
}
