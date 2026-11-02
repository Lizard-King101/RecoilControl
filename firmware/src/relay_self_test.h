#pragma once
#include "hid_mouse.h"
#include "relay_queue.h"
#include "recoil_overlay.h"

// Runs on the actual target at startup. A failure prevents Bluetooth passthrough.
inline bool relaySelfTest() {
  const uint8_t descriptor[] = {
    0x05,1, 0x09,2, 0xa1,1, 0x85,1, 0x09,1, 0xa1,0,
    0x05,9, 0x19,1, 0x29,8, 0x15,0, 0x25,1, 0x75,1, 0x95,8, 0x81,2,
    0x05,1, 0x09,0x30, 0x09,0x31, 0x16,1,0x80, 0x26,0xff,0x7f, 0x75,16, 0x95,2, 0x81,6,
    0x09,0x38, 0x15,0x81, 0x25,0x7f, 0x75,8, 0x95,1, 0x81,6,
    0x05,0x0c, 0x0a,0x38,2, 0x81,6, 0xc0,0xc0
  };
  hidmouse::Descriptor parser; hidmouse::Report r;
  if (!parser.parse(descriptor, sizeof(descriptor))) return false;
  const uint8_t input[] = {5, 0xd4,0xfe, 0xc8,0, 0xff,2};
  if (!parser.decode(1, input, sizeof(input), r) || r.buttons != 5 || r.buttonMask != 255 || r.x != -300 || r.y != 200 || r.wheel != -1 || r.pan != 2) return false;
  if (parser.decode(1, input, sizeof(input) - 1, r) || parser.decode(9, input, sizeof(input), r)) return false;
  if (parser.parse(descriptor, sizeof(descriptor) - 1)) return false;
  const uint8_t simple[] = {0x05,1,0x09,2,0xa1,1,0x05,9,0x19,1,0x29,3,0x15,0,0x25,1,0x75,1,0x95,3,0x81,2,
    0x75,5,0x95,1,0x81,1,0x05,1,0x09,0x30,0x09,0x31,0x15,0x81,0x25,0x7f,0x75,8,0x95,2,0x81,6,0xc0};
  const uint8_t simpleReport[] = {2,0x80,127};
  if (!parser.parse(simple, sizeof(simple)) || !parser.decode(0, simpleReport, sizeof(simpleReport), r) || r.x != -128 || r.y != 127 || r.buttons != 2) return false;
  relay::Queue queue; relay::Frame f;
  r = {}; r.buttonMask = 255; queue.push(r, 0); // Establish neutral.
  r.buttons = 1; r.x = 10; queue.push(r, 10);
  r.x = -3; queue.push(r, 20);
  r.buttons = 0; r.x = 0; queue.push(r, 30);
  if (!queue.pop(f, 40) || f.buttons != 1 || f.x != 7) return false;
  if (!queue.pop(f, 40) || f.buttons != 0 || queue.pop(f, 40)) return false;
  r.buttons = 1; queue.push(r, 50); queue.reset(60); queue.push(r, 70);
  if (!queue.pop(f, 80) || f.buttons || queue.pop(f, 80)) return false;
  r.buttons = 0; queue.push(r, 90); while (queue.pop(f, 90)) {}
  r.x = 40000; queue.push(r, 100);
  if (!queue.pop(f, 100) || f.x != 32767 || !queue.pop(f, 100) || f.x != 7233) return false;
  queue.push(r, 100); if (!queue.pop(f, 300101) || f.x || f.buttons || !queue.dropped) return false;
  relay::RecoilOverlay overlay;
  overlay.input(0); overlay.input(1);
  if (overlay.offer(1, overlay.generation(), 100, 3, -4, 101)) return false;
  f = {1, 10, 20, 1, -1, 100000}; bool have = true;
  if (overlay.apply(f, have, 1, 102, true) != 1 || f.x != 13 || f.y != 16 || f.buttons != 1 || f.wheel != 1 || f.pan != -1) return false;
  if (overlay.offer(2, overlay.generation(), 110, 3, 4, 111)) return false;
  overlay.cancel(); f = {1, 10, 20, 1, 0, 100000};
  if (overlay.takeCancelled() != 2 || overlay.apply(f, have, 1, 112, true) || f.x != 10 || f.y != 20 || f.buttons != 1) return false;
  if (!overlay.offer(3, overlay.generation(), 112, 1, 1, 113)) return false; // Held after disarm.
  overlay.input(0); overlay.input(1);
  if (overlay.offer(4, overlay.generation(), 120, 3, 4, 121)) return false;
  if (overlay.apply(f, have, 1, 221, true) || overlay.takeCancelled() != 4 || f.x != 10) return false; // Expired, physical untouched.
  overlay.input(0); overlay.input(1);
  if (overlay.offer(5, overlay.generation(), 230, 3, 4, 231)) return false;
  overlay.input(0);
  if (overlay.takeCancelled() != 5 || overlay.apply(f, have, 0, 232, true)) return false;
  overlay.input(1);
  if (overlay.offer(6, overlay.generation(), 240, 3, 4, 241)) return false;
  if (overlay.apply(f, have, 1, 242, false) || f.x != 10 || overlay.takeCancelled() != 6) return false; // USB/link loss.
  return true;
}
