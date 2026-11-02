#!/usr/bin/env python3
"""Read only BTN_LEFT from one evdev mouse. Never grabs, writes, or forwards keys/motion."""
import fcntl
import glob
import json
import os
import select
import stat
import struct
import sys
import time

EVENT = struct.Struct('@llHHi')
BTN_LEFT = 0x110


def emit(value):
    print(json.dumps(value), flush=True)


def bitmap(path):
    # sysfs prints native unsigned-long words, highest first, without leading zeros.
    width = struct.calcsize('@L') * 2
    with open(path) as source:
        return int(''.join(word.zfill(width) for word in source.read().split()), 16)


def devices():
    result = []
    for device in sorted(glob.glob('/sys/class/input/event*/device')):
        try:
            if bitmap(device + '/capabilities/rel') & 3 != 3:
                continue
            if not bitmap(device + '/capabilities/key') & (1 << BTN_LEFT):
                continue
            path = '/dev/input/' + device.split('/')[-2]
            with open(device + '/name') as source:
                name = source.read().strip()
            result.append({'path': path, 'name': name, 'readable': os.access(path, os.R_OK)})
        except (OSError, ValueError):
            continue
    return result


def held(fd):
    keys = bytearray(96)
    # _IOR('E', 0x18, 96): EVIOCGKEY, a read-only query of current button state.
    fcntl.ioctl(fd, (2 << 30) | (len(keys) << 16) | (ord('E') << 8) | 0x18, keys)
    return bool(keys[BTN_LEFT // 8] & (1 << (BTN_LEFT % 8)))


def monitor(path):
    if path not in [device['path'] for device in devices()]:
        raise ValueError('Select an available mouse device.')
    fd = os.open(path, os.O_RDONLY | os.O_NONBLOCK | os.O_NOFOLLOW)
    try:
        if not stat.S_ISCHR(os.fstat(fd).st_mode):
            raise ValueError('Mouse input must be a character device.')
        pressed = held(fd)
        emit({'ready': True, 'pressed': pressed})
        while True:
            ready, _, _ = select.select([fd, sys.stdin], [], [], .1)
            if sys.stdin in ready and not os.read(sys.stdin.fileno(), 512):
                return
            if fd in ready:
                data = os.read(fd, EVENT.size * 64)
                if not data or len(data) % EVENT.size:
                    raise RuntimeError('Mouse disconnected or input stream interrupted.')
                for sec, usec, kind, code, value in EVENT.iter_unpack(data):
                    if kind == 0 and code == 3:
                        # Do not resume an assisted take after lost input events.
                        raise RuntimeError('Mouse input lost events. Reconnect and record another take.')
                    if kind == 1 and code == BTN_LEFT and value in (0, 1):
                        if abs(time.time() - (sec + usec / 1000000)) > .25:
                            raise RuntimeError('Mouse input delayed. Reconnect and record another take.')
                        pressed = bool(value)
                        emit({'pressed': pressed})
            emit({'pressed': pressed})
    finally:
        os.close(fd)


if __name__ == '__main__':
    try:
        if sys.argv[1:] == ['--list']:
            emit(devices())
        elif len(sys.argv) == 2:
            monitor(sys.argv[1])
        else:
            raise ValueError('Choose --list or a mouse event device.')
    except Exception as error:
        emit({'error': str(error)})
        sys.exit(1)
