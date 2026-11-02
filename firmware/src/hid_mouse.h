#pragma once
#include <cstdint>
#include <cstddef>
#include <array>

namespace hidmouse {
struct Field { uint16_t bit = 0; uint8_t size = 0; bool signedValue = false; };
struct Layout {
  uint8_t id = 0; uint16_t bits = 0;
  Field x, y, wheel, pan;
  std::array<Field, 8> buttons{};
  bool mouse = false;
};
struct Report {
  uint8_t buttons = 0, buttonMask = 0;
  int32_t x = 0, y = 0, wheel = 0, pan = 0;
};
class Descriptor {
  std::array<Layout, 16> layouts{};
  size_t used = 0;
  Layout* get(uint8_t id) {
    for (size_t i = 0; i < used; i++) if (layouts[i].id == id) return &layouts[i];
    if (used == layouts.size()) return nullptr;
    layouts[used] = {}; layouts[used].id = id; return &layouts[used++];
  }
  static int32_t value(const uint8_t* data, Field f) {
    uint32_t raw = 0;
    for (unsigned i = 0; i < f.size; i++) raw |= uint32_t((data[(f.bit + i) / 8] >> ((f.bit + i) % 8)) & 1) << i;
    if (f.signedValue && f.size && f.size < 32 && (raw & (uint32_t(1) << (f.size - 1)))) raw |= ~((uint32_t(1) << f.size) - 1);
    return static_cast<int32_t>(raw);
  }
 public:
  const Layout* find(uint8_t id) const { for (size_t i = 0; i < used; i++) if (layouts[i].id == id && layouts[i].mouse) return &layouts[i]; return nullptr; }
  bool parse(const uint8_t* data, size_t length) {
    used = 0;
    struct Global { uint32_t page = 0, size = 0, count = 0; int32_t minimum = 0; uint8_t id = 0; } g;
    std::array<Global, 8> globals{}; size_t globalDepth = 0;
    std::array<bool, 16> collections{}; size_t depth = 0;
    std::array<uint32_t, 64> usages{}; size_t usageCount = 0;
    uint32_t usageMin = 0, usageMax = 0; bool hasRange = false, inMouse = false;
    for (size_t pos = 0; pos < length;) {
      const uint8_t prefix = data[pos++];
      if (prefix == 0xfe) return false; // Unsupported long items must never be guessed.
      const size_t bytes = (prefix & 3) == 3 ? 4 : prefix & 3;
      if (bytes > length - pos) return false;
      uint32_t u = 0; for (size_t i = 0; i < bytes; i++) u |= uint32_t(data[pos++]) << (8 * i);
      int32_t s = static_cast<int32_t>(u);
      if (bytes && bytes < 4 && (u & (uint32_t(1) << (bytes * 8 - 1)))) s = static_cast<int32_t>(u | (~uint32_t(0) << (bytes * 8)));
      const uint8_t type = (prefix >> 2) & 3, tag = prefix >> 4;
      if (type == 1) {
        switch (tag) {
          case 0: g.page = u; break;
          case 1: g.minimum = s; break;
          case 7: g.size = u; break;
          case 8: if (!u || u > 255) return false; g.id = u; break;
          case 9: g.count = u; break;
          case 10: if (globalDepth == globals.size()) return false; globals[globalDepth++] = g; break;
          case 11: if (!globalDepth) return false; g = globals[--globalDepth]; break;
        }
      } else if (type == 2) {
        if (tag == 0) { if (usageCount == usages.size()) return false; usages[usageCount++] = bytes == 4 ? u : (g.page << 16) | u; }
        else if (tag == 1) { usageMin = bytes == 4 ? u : (g.page << 16) | u; hasRange = true; }
        else if (tag == 2) usageMax = bytes == 4 ? u : (g.page << 16) | u;
      } else if (type == 0) {
        if (tag == 10) {
          if (depth == collections.size()) return false;
          collections[depth++] = inMouse;
          if (u == 1) inMouse = usageCount && usages[0] == 0x10002;
        } else if (tag == 12) {
          if (!depth) return false; inMouse = collections[--depth];
        } else if (tag == 8) {
          Layout* layout = get(g.id);
          if (!layout || g.size > 32 || g.count > 256 || g.count * g.size > 4096 || layout->bits + g.count * g.size > 4096) return false;
          if (inMouse && !(u & 1) && (u & 2)) {
            for (uint32_t i = 0; i < g.count; i++) {
              uint32_t usage = i < usageCount ? usages[i] : hasRange && usageMin + i <= usageMax ? usageMin + i : 0;
              Field field{static_cast<uint16_t>(layout->bits + i * g.size), static_cast<uint8_t>(g.size), g.minimum < 0};
              if (usage >= 0x90001 && usage <= 0x90008 && g.size == 1) { layout->buttons[usage - 0x90001] = field; layout->mouse = true; }
              else if (usage == 0x10030 || usage == 0x10031 || usage == 0x10038 || usage == 0xc0238) {
                if (!(u & 4) || !g.size) return false; // Relative axes only.
                Field* target = usage == 0x10030 ? &layout->x : usage == 0x10031 ? &layout->y : usage == 0x10038 ? &layout->wheel : &layout->pan;
                if (target->size) return false;
                *target = field; layout->mouse = true;
              }
            }
          }
          layout->bits += g.count * g.size;
        }
        usageCount = 0; hasRange = false; usageMin = usageMax = 0;
      }
    }
    if (depth || globalDepth) return false;
    bool x = false, y = false, buttons = false;
    for (size_t i = 0; i < used; i++) { x |= layouts[i].x.size != 0; y |= layouts[i].y.size != 0; buttons |= layouts[i].buttons[0].size != 0; }
    return x && y && buttons;
  }
  bool decode(uint8_t id, const uint8_t* data, size_t length, Report& report) const {
    const Layout* layout = find(id); if (!layout) return false;
    const size_t bytes = (layout->bits + 7) / 8;
    if (id && length == bytes + 1 && data[0] == id) { data++; length--; }
    if (length != bytes) return false;
    report = {};
    report.x = value(data, layout->x); report.y = value(data, layout->y);
    report.wheel = value(data, layout->wheel); report.pan = value(data, layout->pan);
    for (unsigned i = 0; i < 8; i++) if (layout->buttons[i].size) {
      report.buttonMask |= 1u << i;
      if (value(data, layout->buttons[i])) report.buttons |= 1u << i;
    }
    return true;
  }
};
}
