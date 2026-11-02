#!/usr/bin/env python3
"""Pointer-only, nonpersistent XDG portal session. JSON lines in/out; no buttons or keys."""
import json
import math
import sys
import threading
import uuid
import gi
from gi.repository import Gio, GLib

BUS = 'org.freedesktop.portal.Desktop'
PATH = '/org/freedesktop/portal/desktop'
IFACE = 'org.freedesktop.portal.RemoteDesktop'
connection = Gio.bus_get_sync(Gio.BusType.SESSION, None)
loop = GLib.MainLoop()
session = None

def emit(value):
    print(json.dumps(value), flush=True)

def call(method, args):
    return connection.call_sync(BUS, PATH, IFACE, method, args, None, Gio.DBusCallFlags.NONE, 2000, None)

def request(method, signature, prefix, options):
    token = 'rc_' + uuid.uuid4().hex
    options['handle_token'] = GLib.Variant('s', token)
    sender = connection.get_unique_name()[1:].replace('.', '_')
    path = PATH + '/request/' + sender + '/' + token
    result = []
    wait = GLib.MainLoop()
    def response(*args):
        result.append(args[5].unpack())
        wait.quit()
    sub = connection.signal_subscribe(BUS, 'org.freedesktop.portal.Request', 'Response', path, None, Gio.DBusSignalFlags.NONE, response)
    timer = GLib.timeout_add_seconds(90, lambda: (wait.quit(), False)[1])
    try:
        call(method, GLib.Variant(signature, (*prefix, options)))
        if not result:
            wait.run()
        if not result or result[0][0] != 0:
            raise RuntimeError('Desktop pointer permission was cancelled, denied, or timed out.')
        return result[0][1]
    finally:
        connection.signal_unsubscribe(sub)
        GLib.source_remove(timer)
        if not result:
            connection.call(BUS, path, 'org.freedesktop.portal.Request', 'Close', None, None, Gio.DBusCallFlags.NONE, 1000, None, None)

def close():
    if session:
        try:
            connection.call_sync(BUS, session, 'org.freedesktop.portal.Session', 'Close', None, None, Gio.DBusCallFlags.NONE, 1000, None)
        except GLib.Error:
            pass
    loop.quit()
    return False

def handle(line):
    request_id = None
    try:
        data = json.loads(line)
        request_id = data['id']
        x, y = data['x'], data['y']
        if not all(isinstance(v, (int, float)) and math.isfinite(v) and abs(v) <= 127 for v in (x, y)):
            raise ValueError('Pointer deltas must be finite and within 127 counts.')
        call('NotifyPointerMotion', GLib.Variant('(oa{sv}dd)', (session, {}, x, y)))
        emit({'id': request_id, 'ok': True})
    except Exception as error:
        emit({'id': request_id, 'ok': False, 'error': str(error)})
    return False

def read_input():
    for line in sys.stdin:
        if len(line) > 512:
            break
        GLib.idle_add(handle, line)
    GLib.idle_add(close)

if '--check' in sys.argv:
    version = connection.call_sync(BUS, PATH, 'org.freedesktop.DBus.Properties', 'Get', GLib.Variant('(ss)', (IFACE, 'version')), None, Gio.DBusCallFlags.NONE, 2000, None)
    emit({'available': True, 'version': version.unpack()[0], 'movementSent': False})
    sys.exit(0)

try:
    result = request('CreateSession', '(a{sv})', (), {'session_handle_token': GLib.Variant('s', 'rc_' + uuid.uuid4().hex)})
    session = result['session_handle']
    request('SelectDevices', '(oa{sv})', (session,), {'types': GLib.Variant('u', 2)})
    result = request('Start', '(osa{sv})', (session, ''), {})
    if not result.get('devices', 0) & 2:
        raise RuntimeError('The desktop did not grant pointer access.')
    connection.signal_subscribe(BUS, 'org.freedesktop.portal.Session', 'Closed', session, None, Gio.DBusSignalFlags.NONE, lambda *args: (emit({'closed': True}), loop.quit()))
    emit({'ready': True})
    threading.Thread(target=read_input, daemon=True).start()
    loop.run()
except Exception as error:
    emit({'error': str(error)})
    sys.exit(1)
finally:
    close()
